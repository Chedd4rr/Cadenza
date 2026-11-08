import Foundation

/// Cadenza's own listening history, for the Stats page. Spotify only lets apps see your last 50 plays,
/// so Cadenza keeps its own log of what it played (on this Mac, through its sound engine).
///
/// A song counts as a play once you've listened to it for 30 seconds, or for half of it if it's shorter.
/// One line of JSON per play, in ~/Library/Application Support/Cadenza/history.jsonl.
final class History {
    private let file = Settings.supportDir.appendingPathComponent("history.jsonl")

    // The song being listened to right now, and how long it has actually been heard.
    private var uri = ""
    private var meta: [String: Any] = [:]
    private var startedAt = Date()
    private var heard: TimeInterval = 0
    private var playingSince: Date?

    /// Called with librespot's player state every time it changes.
    func observe(_ p: [String: Any]) {
        let now = Date()
        let newURI = (p["uri"] as? String) ?? ""
        let playing = (p["is_playing"] as? Bool) == true && (p["active"] as? Bool) != false
        // Count the time since the last report towards the song that was playing until now.
        if let since = playingSince { heard += now.timeIntervalSince(since) }
        playingSince = nil
        if newURI != uri {
            finish()
            uri = newURI
            meta = [:]
            heard = 0
            startedAt = now
        }
        // Keep the song's details (they can arrive a moment after the song itself).
        for key in ["name", "artists", "album", "image", "duration_ms"] where p[key] != nil { meta[key] = p[key] }
        playingSince = playing ? now : nil
    }

    /// The current song is over (another one started, or Cadenza is quitting): log it if it counts.
    func finish() {
        // (Called on its own when Cadenza quits: count the time since the last report.)
        if let since = playingSince { heard += Date().timeIntervalSince(since); playingSince = Date() }
        defer { heard = 0 }
        guard uri.hasPrefix("spotify:track:"), let name = meta["name"] as? String, !name.isEmpty else { return }
        let duration = Double((meta["duration_ms"] as? Int) ?? 0) / 1000
        guard heard >= 30 || (duration > 0 && heard >= duration / 2) else { return }
        let entry: [String: Any] = [
            "uri": uri, "name": name,
            "artists": (meta["artists"] as? String) ?? "",
            "album": (meta["album"] as? String) ?? "",
            "image": (meta["image"] as? String) ?? "",
            "ms": Int(heard * 1000),
            "at": Int(startedAt.timeIntervalSince1970 * 1000),
            "dur": Int(duration * 1000),
        ]
        append(entry)
    }

    private func append(_ entry: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: entry) else { return }
        var line = data
        line.append(0x0A)
        if let h = try? FileHandle(forWritingTo: file) {
            defer { try? h.close() }
            _ = try? h.seekToEnd()
            try? h.write(contentsOf: line)
        } else {
            try? line.write(to: file, options: .atomic)
        }
    }

    /// Every play since `since` (ms since 1970; 0 = all of them), oldest first.
    func entries(since: Double) -> [[String: Any]] {
        guard let data = try? Data(contentsOf: file), let text = String(data: data, encoding: .utf8) else { return [] }
        var out: [[String: Any]] = []
        for line in text.split(separator: "\n") {
            guard let d = line.data(using: .utf8),
                  let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { continue }
            if since > 0, let at = obj["at"] as? Double, at < since { continue }
            out.append(obj)
        }
        return out
    }
}
