import AppKit
import UniformTypeIdentifiers

/// Synced lyrics from LRCLIB (lrclib.net, free and open). Spotify doesn't share lyrics with apps.
enum Lyrics {
    static func fetch(track: String, artist: String, album: String, seconds: Int,
                      done: @escaping ([String: Any]?) -> Void) {
        var c = URLComponents(string: "https://lrclib.net/api/get")!
        c.queryItems = [
            URLQueryItem(name: "track_name", value: track),
            URLQueryItem(name: "artist_name", value: artist),
            URLQueryItem(name: "album_name", value: album),
            URLQueryItem(name: "duration", value: String(seconds)),
        ]
        get(c.url) { obj in
            let exact = obj as? [String: Any]
            // An exact match with timed lyrics is the best answer. An exact match with only plain text
            // isn't: another upload of the same song often has the timings, so look for one first.
            if let exact, isSynced(exact) { return done(result(exact)) }
            var s = URLComponents(string: "https://lrclib.net/api/search")!
            s.queryItems = [URLQueryItem(name: "track_name", value: track), URLQueryItem(name: "artist_name", value: artist)]
            get(s.url) { list in
                let hits = (list as? [[String: Any]]) ?? []
                if let best = pickSynced(hits, seconds: seconds) { return done(result(best)) }
                // Last try: a free-text search ("artist title") catches differently spelt titles.
                var q = URLComponents(string: "https://lrclib.net/api/search")!
                q.queryItems = [URLQueryItem(name: "q", value: artist + " " + track)]
                get(q.url) { list2 in
                    let more = ((list2 as? [[String: Any]]) ?? []).filter { sameArtist($0, artist) }
                    if let best = pickSynced(more, seconds: seconds) { return done(result(best)) }
                    if let exact, hasLyrics(exact) { return done(result(exact)) }
                    done((hits + more).first(where: hasLyrics).map(result))
                }
            }
        }
    }

    private static func isSynced(_ o: [String: Any]) -> Bool { (o["syncedLyrics"] as? String)?.isEmpty == false }
    /// The timed upload whose length is closest to the song's (within 8 s, so a radio edit or live
    /// version doesn't drift out of sync).
    private static func pickSynced(_ hits: [[String: Any]], seconds: Int) -> [String: Any]? {
        let timed = hits.filter(isSynced)
        let off = { (o: [String: Any]) -> Double in abs(((o["duration"] as? Double) ?? Double(seconds)) - Double(seconds)) }
        return timed.filter { off($0) <= 8 }.min { off($0) < off($1) }
    }
    private static func sameArtist(_ o: [String: Any], _ artist: String) -> Bool {
        let a = ((o["artistName"] as? String) ?? "").lowercased(), b = artist.lowercased()
        return !b.isEmpty && (a.contains(b) || b.contains(a))
    }

    private static func hasLyrics(_ o: [String: Any]) -> Bool {
        ((o["syncedLyrics"] as? String)?.isEmpty == false) || ((o["plainLyrics"] as? String)?.isEmpty == false)
    }
    private static func result(_ o: [String: Any]) -> [String: Any] {
        ["synced": (o["syncedLyrics"] as? String) ?? "", "plain": (o["plainLyrics"] as? String) ?? "",
         "instrumental": (o["instrumental"] as? Bool) ?? false]
    }
    private static func get(_ url: URL?, done: @escaping (Any?) -> Void) {
        guard let url else { return done(nil) }
        var req = URLRequest(url: url)
        req.timeoutInterval = 12
        req.setValue(AppInfo.userAgent, forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            let ok = ((resp as? HTTPURLResponse)?.statusCode ?? 0) == 200
            let obj = ok ? data.flatMap { try? JSONSerialization.jsonObject(with: $0) } : nil
            DispatchQueue.main.async { done(obj) }
        }.resume()
    }
}

/// Lets you pick an image, crops it square, and returns it as a base64 JPEG under Spotify's 256 KB limit.
enum CoverPicker {
    static func pickJPEGBase64() -> String? {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = false
        panel.message = "Choose a cover image for this playlist"
        guard panel.runModal() == .OK, let url = panel.url, let image = NSImage(contentsOf: url),
              let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        let side = min(cg.width, cg.height)
        let crop = CGRect(x: (cg.width - side) / 2, y: (cg.height - side) / 2, width: side, height: side)
        guard let square = cg.cropping(to: crop) else { return nil }
        let target = 640
        guard let ctx = CGContext(data: nil, width: target, height: target, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(square, in: CGRect(x: 0, y: 0, width: target, height: target))
        guard let resized = ctx.makeImage() else { return nil }
        let rep = NSBitmapImageRep(cgImage: resized)
        var quality = 0.9
        while quality > 0.2 {
            if let data = rep.representation(using: .jpeg, properties: [.compressionFactor: quality]) {
                let b64 = data.base64EncodedString()
                if b64.utf8.count < 250_000 { return b64 }
            }
            quality -= 0.1
        }
        return nil
    }
}

/// Finding a song from a line of its lyrics, with Genius's search (Genius searches lyrics as well as titles).
/// Needs a free Genius API access token: genius.com/api-clients → New API Client → Generate Access Token.
enum Genius {
    /// [{title, artist}] for the best matches, or an error message.
    static func search(_ query: String, done: @escaping ([[String: String]]?, String?) -> Void) {
        let token = Settings.shared.geniusToken
        guard !token.isEmpty else { return done(nil, "no-token") }
        var c = URLComponents(string: "https://api.genius.com/search")!
        c.queryItems = [URLQueryItem(name: "q", value: query)]
        guard let url = c.url else { return done(nil, "Bad search") }
        var req = URLRequest(url: url)
        req.timeoutInterval = 12
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(AppInfo.userAgent, forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            var hits: [[String: String]] = []
            if status == 200, let data,
               let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let response = obj["response"] as? [String: Any],
               let list = response["hits"] as? [[String: Any]] {
                for h in list where (h["type"] as? String) == "song" {
                    guard let r = h["result"] as? [String: Any], let title = r["title"] as? String else { continue }
                    let artist = ((r["primary_artist"] as? [String: Any])?["name"] as? String) ?? (r["artist_names"] as? String) ?? ""
                    hits.append(["title": title, "artist": artist])
                }
            }
            DispatchQueue.main.async {
                if status == 401 { done(nil, "bad-token") }
                else if status != 200 { done(nil, status == 0 ? "Couldn't reach Genius" : "Genius said \(status)") }
                else { done(hits, nil) }
            }
        }.resume()
    }
}
