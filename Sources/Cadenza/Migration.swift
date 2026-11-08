import Foundation

/// This app used to be called Chord. The first time Cadenza opens, it brings over Chord's settings and
/// its folder in Application Support (Spotify login, audio engine login, history, Up Next, tokens),
/// so nothing has to be set up again. Runs before anything else reads a setting or a file.
enum Migration {
    static let oldBundleID = "io.github.chedd4rr.chord"

    static func run() {
        let d = UserDefaults.standard
        guard !d.bool(forKey: "migratedFromChord") else { return }
        defer { d.set(true, forKey: "migratedFromChord") }

        if let mine = Bundle.main.bundleIdentifier, mine != oldBundleID, let old = d.persistentDomain(forName: oldBundleID) {
            var merged = d.persistentDomain(forName: mine) ?? [:]
            for (k, v) in old where merged[k] == nil { merged[k] = v }
            // The old default device name and update source follow the new name.
            if (merged["deviceName"] as? String) == "Chord" { merged["deviceName"] = "Cadenza" }
            if (merged["updateRepo"] as? String) == "Chedd4rr/Chord" { merged["updateRepo"] = "Chedd4rr/Cadenza" }
            d.setPersistentDomain(merged, forName: mine)
        }

        let fm = FileManager.default
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let oldDir = base.appendingPathComponent("Chord", isDirectory: true)
        let newDir = base.appendingPathComponent("Cadenza", isDirectory: true)
        if fm.fileExists(atPath: oldDir.path), !fm.fileExists(atPath: newDir.path) {
            do { try fm.moveItem(at: oldDir, to: newDir) } catch { NSLog("Cadenza: couldn't move Chord's data: \(error)") }
        }
    }
}
