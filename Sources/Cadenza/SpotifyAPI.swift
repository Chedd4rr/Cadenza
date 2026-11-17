import Foundation

/// Thin Spotify Web API client. All callbacks arrive on the main queue.
final class SpotifyAPI {
    /// Upload a raw body (used for playlist cover images: base64 JPEG with Content-Type image/jpeg).
    func upload(_ method: String, _ path: String, body: Data, contentType: String, done: @escaping (Int) -> Void) {
        auth.token { token in
            guard let token, let url = URL(string: "https://api.spotify.com/v1" + path), url.host == "api.spotify.com" else { return done(401) }
            var req = URLRequest(url: url)
            req.httpMethod = method
            req.timeoutInterval = 30
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.setValue(contentType, forHTTPHeaderField: "Content-Type")
            req.httpBody = body
            URLSession.shared.dataTask(with: req) { _, resp, _ in
                let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
                DispatchQueue.main.async { done(status) }
            }.resume()
        }
    }

    let auth: SpotifyAuth
    init(auth: SpotifyAuth) { self.auth = auth }

    // MARK: - Rate-limit guard and activity log
    // Spotify blocks an app that sends too many requests (HTTP 429 with a Retry-After wait).
    // While blocked, requests are answered here instead of being sent, because hitting Spotify
    // during a block can make it longer. Bursts are smoothed to at most 40 requests per 30 s.
    private var recent: [Date] = []
    private(set) var blockedUntil = Date.distantPast            // latest block on any endpoint (for the activity line)
    private var blocks: [String: Date] = [:]                     // per endpoint: "GET /me/player" → until
    private var lastRetryAfter: Double = 0
    private var logLines: [String] = []
    private var total = 0
    private let started = Date()
    private var logFile: URL { Settings.supportDir.appendingPathComponent("spotify-requests.log") }
    private static let stamp: DateFormatter = { let f = DateFormatter(); f.dateFormat = "HH:mm:ss"; return f }()

    private func note(_ line: String) {
        logLines.append(Self.stamp.string(from: Date()) + "  " + line)
        if logLines.count > 300 { logLines.removeFirst(logLines.count - 300) }
    }

    /// A new login or Client ID starts fresh: forget any wait Spotify gave the previous one.
    func resetBlock() {
        if blockedUntil > Date() { note("(new login: cleared the previous wait)") }
        blockedUntil = .distantPast
        blocks = [:]
        lastRetryAfter = 0
        recent = []
    }

    /// For System → Spotify activity.
    func activity() -> [String: Any] {
        let now = Date()
        let lastMinute = recent.filter { now.timeIntervalSince($0) < 60 }.count
        return ["lastMinute": lastMinute, "total": total, "uptime": Int(now.timeIntervalSince(started)),
                "blockedFor": max(0, Int(blockedUntil.timeIntervalSince(now).rounded(.up))),
                "lastRetryAfter": Int(lastRetryAfter), "log": Array(logLines.suffix(60)), "logFile": logFile.path]
    }

    /// `path` is relative to https://api.spotify.com/v1 (e.g. "/me/player") or a full URL.
    func request(_ method: String, _ path: String, body: Any? = nil, retries: Int = 1,
                 done: @escaping (Int, Any?) -> Void) {
        auth.token { [weak self] token in
            guard let self else { return }
            guard let token else {
                // Still signed in but couldn't refresh (no network yet, e.g. right after the Mac starts):
                // report a network error, not "logged out", so the app doesn't ask you to log in again.
                if self.auth.isLoggedIn { return done(0, ["error": ["status": 0, "message": "Couldn't reach Spotify"]]) }
                return done(401, ["error": ["status": 401, "message": "Not logged in"]])
            }
            let urlString = path.hasPrefix("http") ? path : "https://api.spotify.com/v1" + path
            // Full URLs (Spotify's "next page" links) must point at Spotify's API. The login token is
            // attached to every request, so it must never be sent anywhere else.
            guard let url = URL(string: urlString), url.scheme == "https", url.host?.lowercased() == "api.spotify.com" else {
                return done(400, ["error": ["status": 400, "message": "Bad URL"]])
            }

            let now = Date()
            // Spotify's waits are per endpoint: a block on "what's playing" shouldn't stop search or your library.
            let endpoint = method + " " + (path.replacingOccurrences(of: "https://api.spotify.com/v1", with: "")
                .split(separator: "?").first.map(String.init) ?? path)
            if let until = self.blocks[endpoint], now < until {
                return done(429, ["error": ["status": 429, "message": "Too many requests"], "retryAfter": until.timeIntervalSince(now)])
            }
            self.recent = self.recent.filter { now.timeIntervalSince($0) < 60 }
            // Things you just pressed (play, pause, skip, seek, volume…) go straight out. Only background
            // traffic waits, so the controls never lag behind a burst of other requests.
            let pressed = method != "GET" && endpoint.hasPrefix(method + " /me/player") && !endpoint.hasSuffix("/queue")
            if !pressed, self.recent.filter({ now.timeIntervalSince($0) < 30 }).count >= 40 {
                self.note("(held back a moment: \(method) \(path))")
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    self.request(method, path, body: body, retries: retries, done: done)
                }
                return
            }
            self.recent.append(now)
            self.total += 1

            var req = URLRequest(url: url)
            req.httpMethod = method
            req.timeoutInterval = 15
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            if method != "GET" {
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                if let body, !(body is NSNull), JSONSerialization.isValidJSONObject(body) {
                    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
                } else {
                    req.httpBody = Data()
                }
            }

            URLSession.shared.dataTask(with: req) { data, resp, _ in
                let http = resp as? HTTPURLResponse
                let status = http?.statusCode ?? 0
                var json: Any?
                if let data, !data.isEmpty {
                    json = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
                }
                let retryAfter = Double(http?.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 1
                DispatchQueue.main.async {
                    let short = path.replacingOccurrences(of: "https://api.spotify.com/v1", with: "")
                    // For a refusal, add Spotify's own reason ("Player command failed: Restriction violated",
                    // "PREMIUM_REQUIRED" and so on): the status alone doesn't say why.
                    var why = ""
                    if status >= 400, status != 429, let err = (json as? [String: Any])?["error"] as? [String: Any] {
                        let parts = [err["message"] as? String, err["reason"] as? String].compactMap { $0 }.filter { !$0.isEmpty }
                        if !parts.isEmpty { why = "  (" + String(parts.joined(separator: " · ").prefix(120)) + ")" }
                    }
                    self.note("\(method) \(short.prefix(90)) → \(status)" + (status == 429 ? "  (Spotify says wait \(Int(retryAfter)) s)" : why))
                    if status == 429 {
                        self.lastRetryAfter = retryAfter
                        if retryAfter > 5 {
                            let until = Date().addingTimeInterval(retryAfter)
                            self.blocks[endpoint] = until
                            self.blockedUntil = max(self.blockedUntil, until)
                        }
                        try? self.logLines.joined(separator: "\n").write(to: self.logFile, atomically: true, encoding: .utf8)
                    }
                    if status == 401 && retries > 0 {
                        self.auth.invalidate()
                        return self.request(method, path, body: body, retries: retries - 1, done: done)
                    }
                    if status == 429 {
                        // Short waits are retried automatically; longer ones go back to the UI, which pauses
                        // its background checks until Spotify's cool-down (Retry-After) is over.
                        if retries > 0 && retryAfter <= 5 {
                            DispatchQueue.main.asyncAfter(deadline: .now() + max(retryAfter, 0.5)) {
                                self.request(method, path, body: body, retries: retries - 1, done: done)
                            }
                            return
                        }
                        return done(429, ["error": ["status": 429, "message": "Too many requests"], "retryAfter": retryAfter])
                    }
                    done(status, json)
                }
            }.resume()
        }
    }
}
