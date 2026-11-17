import AppKit
import UniformTypeIdentifiers

/// Your Spotify listening history from the files Spotify sends when you ask for your data
/// (spotify.com/account/privacy). Cadenza reads them on your Mac and folds them into Stats.
///
/// It reads both kinds of download:
/// - "Extended streaming history": Streaming_History_Audio_*.json, every play since the account began,
///   with fields like ts, ms_played, master_metadata_track_name and spotify_track_uri.
/// - "Account data": StreamingHistory_music_*.json, the last year, with endTime, trackName, artistName
///   and msPlayed (no song links).
/// You can pick the .json files, the folder they're in, or the .zip Spotify sends.
///
/// Only what Stats needs is kept: when each song was played, for how long, and the song's name, artist,
/// album and link. The rest of each line (IP address, country, device and so on) is never saved.
/// A play counts (in Stats) once you heard 30 seconds of it, the same rule Spotify uses. Shorter plays
/// are kept too: your taste profile learns from what you skipped as well as what you finished. Each play
/// also keeps a few yes/no facts from Spotify's files, as bits:
///   1 = you skipped it (Spotify's "skipped", or it ended because you pressed next),
///   2 = it played to the end,
///   4 = you picked it yourself (clicked it, rather than it coming up next),
///   8 = it ended because you started something else (another song, or another device),
///  16 = it ended for a reason that says nothing about the song (you pressed back, the app quit or
///       logged out, or the song failed to load).
/// The shorter "account data" files say none of this, so there a play under 30 seconds counts as a skip.
///
/// No play is counted twice. Each one is keyed by the minute it ended plus the song's name and artist,
/// so importing the same files again, both kinds of download, or two downloads that overlap, only adds
/// plays that aren't there yet.
///
/// Saved in ~/Library/Application Support/Cadenza/spotify-history.json (readable only by you) as two lists:
/// songs [[link, name, artist, album]] and plays [[end time in seconds, song number, ms played, flags]].
final class SpotifyHistory {
    private let file = Settings.supportDir.appendingPathComponent("spotify-history.json")
    private let queue = DispatchQueue(label: "cadenza.spotify-history", qos: .userInitiated)

    private var tracks: [[String]] = []
    private var trackIndex: [String: Int] = [:]
    private var plays: [[Int]] = []
    private var seen = Set<String>()
    private var loaded = false

    private static let minimumMs = 30_000
    private var flagFixes: [String: Int] = [:]          // plays already here, with the flags this import found for them
    private static let maxFileBytes = 300 * 1024 * 1024     // one history file is ~10-20 MB

    // MARK: - Picking files

    /// Ask which files to import (on the main thread), then read them in the background.
    func pickAndImport(window: NSWindow?, done: @escaping ([String: Any]?) -> Void) {
        let panel = NSOpenPanel()
        panel.title = "Import your Spotify listening history"
        panel.message = "Choose the .zip Spotify sent you, the folder inside it, or the Streaming_History .json files."
        panel.prompt = "Import"
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.allowedContentTypes = [.json, .zip]
        let handle: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard let self, response == .OK, !panel.urls.isEmpty else { return done(nil) }
            let urls = panel.urls
            self.queue.async {
                let result = self.importFiles(urls)
                DispatchQueue.main.async { done(result) }
            }
        }
        if let window, window.isVisible { panel.beginSheetModal(for: window, completionHandler: handle) }
        else { handle(panel.runModal()) }
    }

    // MARK: - Reading the files

    private func importFiles(_ urls: [URL]) -> [String: Any] {
        load()
        var temps: [URL] = []
        defer { temps.forEach { try? FileManager.default.removeItem(at: $0) } }

        // Every .json file picked, inside a picked folder, or inside a picked .zip.
        var jsonFiles: [URL] = []
        for url in urls {
            let ext = url.pathExtension.lowercased()
            if ext == "zip" {
                if let dir = unzip(url) { temps.append(dir); jsonFiles += jsonFilesIn(dir) }
            } else if (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
                jsonFiles += jsonFilesIn(url)
            } else if ext == "json" {
                jsonFiles.append(url)
            }
        }

        var used = 0, read = 0, added = 0, duplicates = 0, short = 0, skips = 0
        let before = plays.count
        flagFixes = [:]
        for url in jsonFiles {
            guard let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize), size <= Self.maxFileBytes,
                  let data = try? Data(contentsOf: url),
                  let rows = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]],
                  let first = rows.first, Self.isHistory(first) else { continue }   // some other file in the download
            used += 1
            for row in rows {
                read += 1
                switch add(row) {
                case .added: added += 1
                case .addedSkip: skips += 1
                case .duplicate: duplicates += 1
                case .skipped: short += 1
                }
            }
        }
        // Plays that were already here from an older import (without flags, or with fewer of them):
        // bring their flags up to date.
        var fixed = 0
        if !flagFixes.isEmpty {
            for i in plays.indices {
                let t = tracks[plays[i][1]]
                guard let f = flagFixes["\(plays[i][0] / 60)|" + (t[1] + "\u{1}" + t[2]).lowercased()] else { continue }
                if plays[i].count == 3 { plays[i].append(f); fixed += 1 }
                else if plays[i][3] != f { plays[i][3] = f; fixed += 1 }
            }
        }
        if plays.count != before || fixed > 0 {
            plays.sort { $0[0] < $1[0] }
            save()
        }
        return [
            "files": used, "read": read, "added": added, "skips": skips, "duplicates": duplicates, "skipped": short, "updated": fixed,
            "total": plays.count, "first": (plays.first?[0] ?? 0) * 1000, "last": (plays.last?[0] ?? 0) * 1000,
        ]
    }

    private static func isHistory(_ row: [String: Any]) -> Bool {
        (row["ts"] != nil && row["ms_played"] != nil) || (row["endTime"] != nil && row["msPlayed"] != nil)
    }

    private enum Outcome { case added, addedSkip, duplicate, skipped }

    private static let isoParser: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private static let minuteParser: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return f
    }()

    private func add(_ row: [String: Any]) -> Outcome {
        let name: String, artist: String, album: String, uri: String, ms: Int, end: Date?
        var flags = 0
        if let ts = row["ts"] as? String {
            // Extended history. Podcasts and audiobooks have no song name: Stats is about music.
            name = (row["master_metadata_track_name"] as? String) ?? ""
            artist = (row["master_metadata_album_artist_name"] as? String) ?? ""
            album = (row["master_metadata_album_album_name"] as? String) ?? ""
            let link = (row["spotify_track_uri"] as? String) ?? ""
            uri = link.hasPrefix("spotify:track:") ? link : ""
            ms = Self.int(row["ms_played"])
            end = Self.isoParser.date(from: ts)
            let endReason = (row["reason_end"] as? String) ?? "", startReason = (row["reason_start"] as? String) ?? ""
            if (row["skipped"] as? Bool) == true || endReason == "fwdbtn" { flags |= 1 }
            if endReason == "trackdone" { flags |= 2 }
            if startReason == "clickrow" { flags |= 4 }
            if endReason == "endplay" || endReason == "remote" { flags |= 8 }
            if ["backbtn", "trackerror", "logout", "unexpected-exit", "unexpected-exit-while-paused", "unknown"].contains(endReason) { flags |= 16 }
        } else {
            name = (row["trackName"] as? String) ?? ""
            artist = (row["artistName"] as? String) ?? ""
            album = ""
            uri = ""
            ms = Self.int(row["msPlayed"])
            end = (row["endTime"] as? String).flatMap { Self.minuteParser.date(from: $0) }
            if ms < Self.minimumMs { flags |= 1 }                        // no reasons in these files: short means skipped
        }
        // Under a second counts only when you pressed next (skipping straight past a song you know):
        // otherwise it's a flicker, not a choice either way.
        guard !name.isEmpty, !artist.isEmpty, ms > 0, ms >= 1000 || flags & 1 != 0, let end else { return .skipped }

        let id = (name + "\u{1}" + artist).lowercased()
        let endSec = Int(end.timeIntervalSince1970)
        let key = "\(endSec / 60)|\(id)"
        guard !seen.contains(key) else { flagFixes[key] = flags; return .duplicate }
        seen.insert(key)

        let index: Int
        if let i = trackIndex[id] {
            index = i
            // A song first seen in the "account data" files has no link or album yet: fill them in.
            if tracks[i][0].isEmpty, !uri.isEmpty { tracks[i][0] = uri }
            if tracks[i][3].isEmpty, !album.isEmpty { tracks[i][3] = album }
        } else {
            index = tracks.count
            tracks.append([uri, name, artist, album])
            trackIndex[id] = index
        }
        plays.append([endSec, index, ms, flags])
        return ms >= Self.minimumMs ? .added : .addedSkip
    }

    private static func int(_ v: Any?) -> Int {
        if let n = v as? Int { return n }
        if let n = v as? Double { return Int(n) }
        if let s = v as? String { return Int(s) ?? 0 }
        return 0
    }

    /// Every .json file under `dir`, not following links out of it.
    private func jsonFilesIn(_ dir: URL) -> [URL] {
        let root = dir.resolvingSymlinksInPath().path
        guard let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey],
                                                     options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return [] }
        var out: [URL] = []
        for case let url as URL in e where url.pathExtension.lowercased() == "json" {
            let v = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard v?.isRegularFile == true, v?.isSymbolicLink != true,
                  url.resolvingSymlinksInPath().path.hasPrefix(root + "/") else { continue }
            out.append(url)
        }
        return out.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    /// Unpack a .zip into a private temporary folder (removed after the import). The zip's list of files is
    /// checked first: anything that would land outside that folder ("../", absolute paths), or a zip that
    /// would unpack to more than 2 GB, is refused.
    private func unzip(_ zip: URL) -> URL? {
        guard zipLooksSafe(zip) else { return nil }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cadenza-history-\(UUID().uuidString)", isDirectory: true)
        guard (try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                        attributes: [.posixPermissions: 0o700])) != nil else { return nil }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        p.arguments = ["-x", "-k", zip.path, dir.path]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { try? FileManager.default.removeItem(at: dir); return nil }
        p.waitUntilExit()
        if p.terminationStatus == 0 { return dir }
        try? FileManager.default.removeItem(at: dir)
        return nil
    }

    private func zipLooksSafe(_ zip: URL) -> Bool {
        let run = { (args: [String]) -> String? in
            let p = Process(), pipe = Pipe()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/zipinfo")
            p.arguments = args + [zip.path]
            p.standardOutput = pipe
            p.standardError = FileHandle.nullDevice
            guard (try? p.run()) != nil else { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            return p.terminationStatus == 0 ? String(data: data, encoding: .utf8) : nil
        }
        guard let names = run(["-1"]) else { return false }
        let list = names.split(separator: "\n").map(String.init)
        guard list.count <= 5000, !list.contains(where: { $0.hasPrefix("/") || $0.split(separator: "/").contains("..") }) else { return false }
        // The totals line: "N files, X bytes uncompressed, Y bytes compressed: Z%"
        if let totals = run(["-t"]), let r = totals.range(of: #"([0-9]+) bytes uncompressed"#, options: .regularExpression),
           let bytes = Int(totals[r].split(separator: " ")[0]), bytes > 2_000_000_000 { return false }
        return true
    }

    // MARK: - Saved copy

    private func load() {
        guard !loaded else { return }
        loaded = true
        guard let data = try? Data(contentsOf: file),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        // (Padded to four fields rather than dropped, so the song numbers in plays stay right.)
        tracks = ((obj["tracks"] as? [[Any]]) ?? []).map { row in
            let fields = row.prefix(4).map { ($0 as? String) ?? "" }
            return fields + Array(repeating: "", count: 4 - fields.count)
        }
        plays = ((obj["plays"] as? [[Any]]) ?? []).compactMap { p in
            let n = p.map { Self.int($0) }
            return (n.count == 3 || n.count == 4) && n[1] >= 0 && n[1] < tracks.count ? n : nil
        }
        for (i, t) in tracks.enumerated() { trackIndex[(t[1] + "\u{1}" + t[2]).lowercased()] = i }
        for p in plays { seen.insert("\(p[0] / 60)|" + (tracks[p[1]][1] + "\u{1}" + tracks[p[1]][2]).lowercased()) }
    }

    private func save() {
        let obj: [String: Any] = ["version": 1, "tracks": tracks, "plays": plays]
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        _ = Settings.writePrivately(data, to: file)
    }

    // MARK: - For the page

    /// Everything imported, in the saved shape, for the Stats page. Empty lists if nothing was imported.
    func snapshot(done: @escaping ([String: Any]) -> Void) {
        queue.async {
            self.load()
            let out: [String: Any] = ["tracks": self.tracks, "plays": self.plays]
            DispatchQueue.main.async { done(out) }
        }
    }

    /// Forget the imported history (Cadenza's own history and Last.fm are untouched).
    func clear(done: @escaping () -> Void) {
        queue.async {
            self.tracks = []; self.trackIndex = [:]; self.plays = []; self.seen = []; self.loaded = true
            try? FileManager.default.removeItem(at: self.file)
            DispatchQueue.main.async { done() }
        }
    }
}

/// Last.fm scrobbles made after your imported Spotify history ends, saved so Stats only has to ask
/// Last.fm for the new ones each time. The page fetches them (through the read-only Last.fm calls) and
/// hands them over here. Saved in ~/Library/Application Support/Cadenza/lastfm-plays.json (readable only by you)
/// as {user, upTo, plays: [[unix time, song, artist, album]]}.
final class LastfmPlays {
    private let file = Settings.supportDir.appendingPathComponent("lastfm-plays.json")
    private let queue = DispatchQueue(label: "cadenza.lastfm-plays", qos: .utility)
    private static let maxBytes = 64 * 1024 * 1024

    func get(done: @escaping (Any?) -> Void) {
        queue.async {
            let obj = (try? Data(contentsOf: self.file)).flatMap { try? JSONSerialization.jsonObject(with: $0) }
            DispatchQueue.main.async { done(obj) }
        }
    }

    /// Only the expected shape is saved, and nothing huge.
    func set(_ value: Any?, done: @escaping (Bool) -> Void) {
        guard let v = value as? [String: Any], v["user"] is String, v["upTo"] is NSNumber, v["plays"] is [[Any]],
              JSONSerialization.isValidJSONObject(v), let data = try? JSONSerialization.data(withJSONObject: v),
              data.count <= Self.maxBytes else { return done(false) }
        queue.async {
            let ok = Settings.writePrivately(data, to: self.file)
            DispatchQueue.main.async { done(ok) }
        }
    }

    func clear() { queue.async { try? FileManager.default.removeItem(at: self.file) } }
}

/// Your taste profile: what autoplay has learned about you (artists, songs and styles you like or skip,
/// what you play at different times of day, and how much each of those matters to you). The web side
/// works it all out; this only keeps the file, private to your account, and refuses anything odd.
final class TasteFile {
    private let file = Settings.supportDir.appendingPathComponent("taste.json")
    private let queue = DispatchQueue(label: "cadenza.taste", qos: .utility)
    private static let maxBytes = 8 * 1024 * 1024

    func get(done: @escaping (Any?) -> Void) {
        queue.async {
            let obj = (try? Data(contentsOf: self.file)).flatMap { try? JSONSerialization.jsonObject(with: $0) }
            DispatchQueue.main.async { done(obj as? [String: Any]) }
        }
    }

    func set(_ value: Any?, done: @escaping (Bool) -> Void) {
        guard let v = value as? [String: Any], v["v"] is NSNumber,
              JSONSerialization.isValidJSONObject(v), let data = try? JSONSerialization.data(withJSONObject: v),
              data.count <= Self.maxBytes else { return done(false) }
        queue.async {
            let ok = Settings.writePrivately(data, to: self.file)
            DispatchQueue.main.async { done(ok) }
        }
    }

    func clear() { queue.async { try? FileManager.default.removeItem(at: self.file) } }
}
