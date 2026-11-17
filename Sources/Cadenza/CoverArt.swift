import AppKit

/// Album covers for the menu-bar player, the floating player, Control Center and notifications.
/// All four want the same picture when the song changes, so it's downloaded once and shared, and the
/// last few covers are kept for when you skip back. Call from the main thread; answers arrive there too.
enum CoverArt {
    private static var cache: [String: Data] = [:]
    private static var recent: [String] = []
    private static var waiting: [String: [(Data?) -> Void]] = [:]

    static func data(_ url: String, _ done: @escaping (Data?) -> Void) {
        if let d = cache[url] { return done(d) }
        if waiting[url] != nil { waiting[url]?.append(done); return }      // already on its way
        // Web covers only (Spotify's are https). A file:// "cover" would have Cadenza read files off your Mac.
        guard let u = URL(string: url), u.scheme?.lowercased() == "https" else { return done(nil) }
        waiting[url] = [done]
        URLSession.shared.dataTask(with: u) { data, response, _ in
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            let ok = code >= 200 && code < 300 && (data?.count ?? 0) < 8_000_000      // a cover is a few hundred KB at most
            DispatchQueue.main.async {
                let d = ok ? data : nil
                if let d {
                    cache[url] = d
                    recent.append(url)
                    if recent.count > 4 { cache.removeValue(forKey: recent.removeFirst()) }
                }
                (waiting.removeValue(forKey: url) ?? []).forEach { $0(d) }
            }
        }.resume()
    }

    static func image(_ url: String, _ done: @escaping (NSImage?) -> Void) {
        data(url) { done($0.flatMap { NSImage(data: $0) }) }
    }

    /// The cover as a data: URL, for a theme that reads its colours (the page can't read the pixels of
    /// a picture from another site). Only JPEG and PNG, which is what Spotify serves.
    static func dataURL(_ url: String, _ done: @escaping (String?) -> Void) {
        // Only Spotify's and Last.fm's picture servers: this hands the page raw bytes from the web, so it
        // mustn't become a way for the page to read anything else.
        let host = URL(string: url)?.host?.lowercased() ?? ""
        let allowed = ["scdn.co", "spotifycdn.com", "spotify.com", "fastly.net", "last.fm", "lst.fm"]
        guard allowed.contains(where: { host == $0 || host.hasSuffix("." + $0) }) else { return done(nil) }
        data(url) { d in
            guard let d, d.count > 8 else { return done(nil) }
            let mime: String
            if d.starts(with: [0xFF, 0xD8, 0xFF]) { mime = "image/jpeg" }
            else if d.starts(with: [0x89, 0x50, 0x4E, 0x47]) { mime = "image/png" }
            else { return done(nil) }
            done("data:\(mime);base64," + d.base64EncodedString())
        }
    }
}
