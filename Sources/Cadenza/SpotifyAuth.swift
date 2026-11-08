import AppKit
import CryptoKit
import Foundation
import Network

/// Spotify login using Authorization Code + PKCE (no client secret needed).
/// The browser redirects to http://127.0.0.1:8888, where a tiny one-shot server catches the code.
final class SpotifyAuth {
    static let redirectURI = "http://127.0.0.1:8888"
    static let scopes = [
        "user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing",
        "playlist-read-private", "playlist-read-collaborative",
        "playlist-modify-private", "playlist-modify-public",
        "user-library-read", "user-library-modify", "user-follow-modify",
        "user-top-read", "user-read-recently-played", "user-read-private", "ugc-image-upload",
    ].joined(separator: " ")

    private var accessToken: String?
    private var expiry = Date.distantPast
    private var refreshing = false
    private var waiters: [(String?) -> Void] = []
    private var listener: NWListener?
    private var pending: (verifier: String, state: String, done: (Bool, String?) -> Void)?

    // The refresh token lives in a private file (0600) in Application Support.
    private var tokenFile: URL { Settings.supportDir.appendingPathComponent("spotify-token") }
    private var scopeFile: URL { Settings.supportDir.appendingPathComponent("spotify-scopes") }

    /// Permissions this version needs that the current login didn't grant (an older login).
    var missingScopes: [String] {
        guard let granted = try? String(contentsOf: scopeFile, encoding: .utf8) else { return [] }
        let have = Set(granted.split(separator: " ").map(String.init))
        return Self.scopes.split(separator: " ").map(String.init).filter { !have.contains($0) }
    }

    private var refreshToken: String? {
        get {
            let s = (try? String(contentsOf: tokenFile, encoding: .utf8))?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return s.isEmpty ? nil : s
        }
        set {
            if let v = newValue, !v.isEmpty {
                if !Settings.writePrivately(Data(v.utf8), to: tokenFile) { NSLog("Cadenza: couldn't save the Spotify login") }
            } else {
                try? FileManager.default.removeItem(at: tokenFile)
            }
        }
    }

    var isLoggedIn: Bool { refreshToken != nil && !Settings.shared.clientId.isEmpty }

    /// Calls back on the main queue with a valid access token, or nil if not logged in.
    func token(_ done: @escaping (String?) -> Void) {
        if let t = accessToken, Date() < expiry { return done(t) }
        waiters.append(done)
        if refreshing { return }
        guard let rt = refreshToken, !Settings.shared.clientId.isEmpty else { return flush(nil) }
        refreshing = true
        tokenRequest([
            "grant_type": "refresh_token",
            "refresh_token": rt,
            "client_id": Settings.shared.clientId,
        ]) { [weak self] ok in
            guard let self else { return }
            self.refreshing = false
            self.flush(ok ? self.accessToken : nil)
        }
    }

    func invalidate() { accessToken = nil }

    func logout() {
        refreshToken = nil
        accessToken = nil
        try? FileManager.default.removeItem(at: scopeFile)
    }

    private func flush(_ token: String?) {
        let w = waiters
        waiters = []
        w.forEach { $0(token) }
    }

    private func tokenRequest(_ form: [String: String], done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: URL(string: "https://accounts.spotify.com/api/token")!)
        req.httpMethod = "POST"
        req.timeoutInterval = 15
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.httpBody = form.map { "\($0.key)=\(Self.formEncode($0.value))" }
            .joined(separator: "&").data(using: .utf8)
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
            DispatchQueue.main.async {
                guard status == 200, let at = json?["access_token"] as? String else {
                    NSLog("Cadenza: token request failed (\(status)): \(json ?? [:])")
                    // A rejected refresh token means the login is gone: forget it.
                    if form["grant_type"] == "refresh_token", status == 400 || status == 401 {
                        self.refreshToken = nil
                    }
                    return done(false)
                }
                self.accessToken = at
                let ttl = (json?["expires_in"] as? Double) ?? 3600
                self.expiry = Date().addingTimeInterval(ttl - 60)
                if let rt = json?["refresh_token"] as? String { self.refreshToken = rt }
                if let sc = json?["scope"] as? String { try? sc.write(to: self.scopeFile, atomically: true, encoding: .utf8) }
                done(true)
            }
        }.resume()
    }

    // MARK: - Interactive login

    func login(_ done: @escaping (Bool, String?) -> Void) {
        let clientId = Settings.shared.clientId
        guard !clientId.isEmpty else { return done(false, "Enter your Client ID first.") }
        stopListener()
        if let p = pending { pending = nil; p.done(false, "Login restarted.") }

        let verifier = Self.random(64)
        let challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        let state = Self.random(16)

        do {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            params.requiredInterfaceType = .loopback
            let l = try NWListener(using: params, on: 8888)
            l.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
            l.stateUpdateHandler = { [weak self] st in
                if case .failed(let err) = st {
                    DispatchQueue.main.async {
                        self?.stopListener()
                        self?.finish(false, "Couldn't listen on port 8888 (\(err)). Close anything else using it and try again.")
                    }
                }
            }
            l.start(queue: .main)
            listener = l
        } catch {
            return done(false, "Couldn't listen on port 8888: \(error.localizedDescription)")
        }

        pending = (verifier, state, done)
        var c = URLComponents(string: "https://accounts.spotify.com/authorize")!
        c.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "scope", value: Self.scopes),
            URLQueryItem(name: "redirect_uri", value: Self.redirectURI),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "code_challenge", value: challenge),
        ]
        if let url = c.url { NSWorkspace.shared.open(url) }
    }

    private func handle(_ conn: NWConnection) {
        conn.start(queue: .main)
        conn.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, _, _ in
            guard let self else { conn.cancel(); return }
            let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let firstLine = text.components(separatedBy: "\r\n").first ?? ""
            let parts = firstLine.split(separator: " ")
            let target = parts.count > 1 ? String(parts[1]) : "/"
            let comps = URLComponents(string: "http://127.0.0.1" + target)
            func query(_ name: String) -> String? { comps?.queryItems?.first(where: { $0.name == name })?.value }

            let isCallback = query("code") != nil || query("error") != nil
            let stateOK = query("state") != nil && query("state") == self.pending?.state
            let ok = isCallback && stateOK && query("code") != nil

            let title = ok ? "Logged in" : (isCallback ? "Login failed" : "Cadenza")
            let html = """
            <!doctype html><meta charset="utf-8"><title>Cadenza</title>
            <body style="margin:0;height:100vh;display:grid;place-items:center;background:#030c2e;color:#f4fdff;font:600 22px -apple-system,sans-serif">
            <div style="transform:skewX(-12deg);background:#f4fdff;color:#06185a;padding:28px 44px;box-shadow:12px 12px 0 #3fe0ff">
            <div style="font-size:40px;font-weight:900;font-style:italic">\(title.uppercased())</div>
            <div>You can close this tab and go back to Cadenza.</div></div></body>
            """
            let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(html.utf8.count)\r\nConnection: close\r\n\r\n" + html
            conn.send(content: response.data(using: .utf8), completion: .contentProcessed { _ in conn.cancel() })

            guard isCallback, let p = self.pending else { return }   // e.g. a favicon request
            self.stopListener()
            if ok, let code = query("code") {
                self.tokenRequest([
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": Self.redirectURI,
                    "client_id": Settings.shared.clientId,
                    "code_verifier": p.verifier,
                ]) { success in
                    self.finish(success, success ? nil :
                        "Spotify rejected the login. Check the Client ID, and that \(Self.redirectURI) is listed under Redirect URIs in your Spotify app.")
                }
            } else {
                self.finish(false, query("error").map { "Spotify said: \($0)" } ?? "Login was cancelled.")
            }
        }
    }

    private func finish(_ ok: Bool, _ message: String?) {
        guard let p = pending else { return }
        pending = nil
        p.done(ok, message)
    }

    private func stopListener() {
        listener?.cancel()
        listener = nil
    }

    // MARK: - Helpers

    private static func random(_ n: Int) -> String {
        let chars = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
        return String((0..<n).map { _ in chars.randomElement()! })
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func formEncode(_ s: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }
}
