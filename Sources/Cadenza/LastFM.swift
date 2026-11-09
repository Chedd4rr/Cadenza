import AppKit
import CryptoKit
import Foundation

/// Last.fm, for reading your listening history: Stats, play counts, the DJ, Friends and autoplay's
/// "similar songs". Cadenza doesn't scrobble itself: link Spotify to Last.fm (Last.fm settings →
/// Applications → Spotify scrobbling) and Spotify scrobbles everything, including what Cadenza plays.
/// You add your own API key and shared secret (free: last.fm/api/account/create), then log in once in the
/// browser so Cadenza knows your username.
final class LastFM {
    private let d = UserDefaults.standard
    private let endpoint = URL(string: "https://ws.audioscrobbler.com/2.0/")!

    var apiKey: String { (d.string(forKey: "lastfmKey") ?? "").trimmingCharacters(in: .whitespaces) }
    var secret: String { Settings.shared.lastfmSecret }
    var sessionKey: String { Settings.shared.lastfmSession }
    var user: String { d.string(forKey: "lastfmUser") ?? "" }
    var onChange: (() -> Void)?
    private(set) var lastError = ""
    private var loginToken = ""

    func status() -> [String: Any] {
        ["user": user, "hasKeys": !apiKey.isEmpty && !secret.isEmpty, "loggedIn": !sessionKey.isEmpty, "error": lastError]
    }

    // MARK: - Login (browser)

    func login(done: @escaping (Bool, String?) -> Void) {
        guard !apiKey.isEmpty, !secret.isEmpty else { return done(false, "Add your Last.fm API key and secret first") }
        call("auth.getToken", [:]) { [weak self] json in
            guard let self else { return }
            guard let token = json?["token"] as? String else { return done(false, self.lastError.isEmpty ? "Couldn't reach Last.fm" : self.lastError) }
            self.loginToken = token
            if let url = URL(string: "https://www.last.fm/api/auth/?api_key=\(self.apiKey)&token=\(token)") { NSWorkspace.shared.open(url) }
            self.waitForSession(token, attempt: 0, done: done)
        }
    }

    /// After you press "Yes, allow access" in the browser, the token turns into a session.
    private func waitForSession(_ token: String, attempt: Int, done: @escaping (Bool, String?) -> Void) {
        guard token == loginToken else { return done(false, "Cancelled") }
        guard attempt < 60 else { return done(false, "Timed out waiting for the browser") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self else { return }
            self.call("auth.getSession", ["token": token], quiet: true) { json in
                if let s = json?["session"] as? [String: Any], let sk = s["key"] as? String {
                    Settings.shared.lastfmSession = sk
                    self.d.set((s["name"] as? String) ?? "", forKey: "lastfmUser")
                    self.lastError = ""
                    self.onChange?()
                    done(true, self.user)
                } else {
                    self.waitForSession(token, attempt: attempt + 1, done: done)
                }
            }
        }
    }

    func logout() {
        loginToken = ""
        Settings.shared.lastfmSession = ""
        d.removeObject(forKey: "lastfmUser")
        onChange?()
    }

    // MARK: - Reading your listening data (Stats, play counts, the DJ, Friends)

    /// Read-only methods the page may ask for. They need only the API key, never the secret or your session.
    static let readMethods: Set<String> = [
        "user.getInfo", "user.getTopArtists", "user.getTopTracks", "user.getTopAlbums", "user.getRecentTracks",
        "user.getFriends", "user.getWeeklyTrackChart", "track.getInfo", "artist.getInfo",
        "track.getSimilar", "artist.getSimilar",                                  // song radio and autoplay
    ]
    private var readQueue: [() -> Void] = []
    private var reading = false
    private var lastRead = Date.distantPast

    /// A read-only Last.fm call. `user` (or `username` for track/artist info) defaults to you.
    /// Calls go out one at a time, at most about four a second, which is what Last.fm asks of apps.
    func read(_ method: String, _ params: [String: String], done: @escaping (Int, Any?) -> Void) {
        guard LastFM.readMethods.contains(method) else { return done(400, ["message": "Not allowed"]) }
        guard !apiKey.isEmpty else { return done(0, ["message": "no-key"]) }
        var p = params
        p["method"] = method
        p["api_key"] = apiKey
        p["format"] = "json"
        if method.hasPrefix("user."), (p["user"] ?? "").isEmpty { p["user"] = user }
        if method == "track.getInfo" || method == "artist.getInfo", (p["username"] ?? "").isEmpty, !user.isEmpty { p["username"] = user }
        if method.hasPrefix("user."), (p["user"] ?? "").isEmpty { return done(0, ["message": "no-user"]) }
        var c = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
        c.queryItems = p.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        guard let url = c.url else { return done(400, nil) }
        readQueue.append { [weak self] in
            var req = URLRequest(url: url)
            req.setValue(AppInfo.userAgent, forHTTPHeaderField: "User-Agent")
            req.timeoutInterval = 15
            URLSession.shared.dataTask(with: req) { data, resp, _ in
                let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
                let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) }
                DispatchQueue.main.async {
                    done(status, json)
                    self?.reading = false
                    self?.nextRead()
                }
            }.resume()
        }
        nextRead()
    }

    private func nextRead() {
        guard !reading, !readQueue.isEmpty else { return }
        let wait = max(0, 0.25 - Date().timeIntervalSince(lastRead))
        reading = true
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
            guard let self else { return }
            self.lastRead = Date()
            self.readQueue.removeFirst()()
        }
    }

    // MARK: - API

    private static func md5(_ s: String) -> String {
        Insecure.MD5.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static let formSafe: CharacterSet = {
        var c = CharacterSet.alphanumerics
        c.insert(charactersIn: "-._~")
        return c
    }()

    /// Signed POST: api_sig is the MD5 of every parameter name+value in order, followed by the secret.
    private func call(_ method: String, _ params: [String: String], quiet: Bool = false, done: @escaping ([String: Any]?) -> Void) {
        var p = params
        p["method"] = method
        p["api_key"] = apiKey
        let sig = p.keys.sorted().map { $0 + (p[$0] ?? "") }.joined() + secret
        p["api_sig"] = LastFM.md5(sig)
        p["format"] = "json"
        let body = p.map { k, v in k + "=" + (v.addingPercentEncoding(withAllowedCharacters: LastFM.formSafe) ?? "") }.joined(separator: "&")
        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.setValue(AppInfo.userAgent, forHTTPHeaderField: "User-Agent")
        req.httpBody = Data(body.utf8)
        req.timeoutInterval = 15
        URLSession.shared.dataTask(with: req) { data, _, _ in
            let json = data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if let code = json?["error"] as? Int {
                    if !quiet { self.lastError = (json?["message"] as? String) ?? "Last.fm error \(code)" }
                    if code == 9 { self.logout() }                     // session no longer valid: log in again
                    return done(nil)
                }
                if json == nil && !quiet { self.lastError = "Couldn't reach Last.fm" }
                done(json)
            }
        }.resume()
    }
}
