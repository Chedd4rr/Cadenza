import Foundation
import ServiceManagement

/// The app's version and the User-Agent Cadenza sends to web services, both read from Info.plist.
enum AppInfo {
    static let version = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0"
    static let userAgent = "Cadenza/\(version) (https://github.com/Chedd4rr/Cadenza)"
    /// Where updates come from unless you pick another repository.
    static let defaultRepo = "Chedd4rr/Cadenza"
}

/// User preferences, stored in UserDefaults (io.github.chedd4rr.cadenza).
final class Settings {
    static let shared = Settings()
    private let d = UserDefaults.standard

    /// Keys the web UI is allowed to read and change.
    static let keys = ["theme", "djVoice", "notifications", "menuBar", "miniStyle", "aiTags", "clientId", "manageLibrespot", "librespotPath", "deviceName", "bitrate",
                       "mediaKeys", "globalHotkey", "reduceMotion", "openAtLogin",
                       "sfx", "sfxVolume", "normalize", "eqPerDevice", "autoplay", "trueShuffle", "crossfade", "geniusToken",
                       "discord", "discordAppId", "lastfm", "lastfmKey", "lastfmSecret", "updateRepo", "autoUpdate"]

    init() {
        d.register(defaults: [
            "theme": "tide",
            "djVoice": true,
            "notifications": true,
            "menuBar": true,
            "miniStyle": "theme",
            "aiTags": true,
            "clientId": "",
            "manageLibrespot": true,
            "librespotPath": "",
            "deviceName": "Cadenza",
            "bitrate": 320,
            "mediaKeys": true,
            "globalHotkey": true,
            "reduceMotion": false,
            "volume": 70,
            "sfx": true,
            "sfxVolume": 55,
            "normalize": true,
            "eqPerDevice": true,
            "autoplay": true,
            "trueShuffle": true,
            "crossfade": 6,
            "discord": false,
            "discordAppId": "",
            "lastfm": false,
            "lastfmKey": "",
            "updateRepo": AppInfo.defaultRepo,
            "autoUpdate": true,
        ])
        // Older builds kept these in the preferences file, which any app can read. Move them to the
        // private secrets file, and only forget the old copy once it's saved there.
        for key in Settings.secretKeys {
            if let old = d.string(forKey: key), !old.isEmpty, Secrets.set(key, old) { d.removeObject(forKey: key) }
        }
    }

    /// Settings that are passwords or tokens. They live in a private file, never in UserDefaults.
    static let secretKeys = ["geniusToken", "lastfmSecret", "lastfmSession"]

    var clientId: String {
        get { d.string(forKey: "clientId") ?? "" }
        set { d.set(newValue, forKey: "clientId") }
    }
    var manageLibrespot: Bool { d.bool(forKey: "manageLibrespot") }
    var librespotPath: String { d.string(forKey: "librespotPath") ?? "" }
    var deviceName: String {
        let n = (d.string(forKey: "deviceName") ?? "").trimmingCharacters(in: .whitespaces)
        return n.isEmpty ? "Cadenza" : n
    }
    var bitrate: Int { [96, 160, 320].contains(d.integer(forKey: "bitrate")) ? d.integer(forKey: "bitrate") : 320 }
    var mediaKeys: Bool { d.bool(forKey: "mediaKeys") }
    var normalize: Bool { d.bool(forKey: "normalize") }
    /// Keep playing similar songs when the music runs out.
    var autoplay: Bool { d.bool(forKey: "autoplay") }
    /// Fade each song's last seconds out and the next one in.
    /// Genius API token, for finding a song from a line of its lyrics.
    var geniusToken: String { Secrets.get("geniusToken").trimmingCharacters(in: .whitespacesAndNewlines) }
    /// Last.fm shared secret and login session (private file).
    var lastfmSecret: String { Secrets.get("lastfmSecret").trimmingCharacters(in: .whitespaces) }
    var lastfmSession: String {
        get { Secrets.get("lastfmSession") }
        set { Secrets.set("lastfmSession", newValue) }
    }
    var globalHotkey: Bool { d.bool(forKey: "globalHotkey") }
    var menuBar: Bool { d.bool(forKey: "menuBar") }
    /// How the menu-bar mini player looks: "theme" (matches the current theme) or "mp3" (a USB-stick MP3 player).
    var miniStyle: String { d.string(forKey: "miniStyle") == "mp3" ? "mp3" : "theme" }
    var notifications: Bool { d.bool(forKey: "notifications") }
    var aiTags: Bool { d.bool(forKey: "aiTags") }
    var discord: Bool { d.bool(forKey: "discord") }
    var volume: Int {
        get { d.integer(forKey: "volume") }
        set { d.set(max(0, min(100, newValue)), forKey: "volume") }
    }

    var openAtLogin: Bool {
        SMAppService.mainApp.status == .enabled
    }

    func all() -> [String: Any] {
        [
            "theme": d.string(forKey: "theme") ?? "tide",
            "djVoice": d.bool(forKey: "djVoice"),
            "notifications": d.bool(forKey: "notifications"),
            "menuBar": d.bool(forKey: "menuBar"),
            "miniStyle": miniStyle,
            "aiTags": d.bool(forKey: "aiTags"),
            "clientId": clientId,
            "manageLibrespot": manageLibrespot,
            "librespotPath": librespotPath,
            "deviceName": deviceName,
            "bitrate": bitrate,
            "mediaKeys": mediaKeys,
            "globalHotkey": globalHotkey,
            "reduceMotion": d.bool(forKey: "reduceMotion"),
            "openAtLogin": openAtLogin,
            "sfx": d.bool(forKey: "sfx"),
            "sfxVolume": d.integer(forKey: "sfxVolume"),
            "normalize": normalize,
            "eqPerDevice": d.bool(forKey: "eqPerDevice"),
            "autoplay": autoplay,
            "trueShuffle": d.bool(forKey: "trueShuffle"),
            "crossfade": d.integer(forKey: "crossfade"),
            "geniusToken": geniusToken.isEmpty ? "" : "set",                                   // never sent back to the page
            "discord": d.bool(forKey: "discord"),
            "discordAppId": d.string(forKey: "discordAppId") ?? "",
            "lastfm": d.bool(forKey: "lastfm"),
            "lastfmKey": d.string(forKey: "lastfmKey") ?? "",
            "lastfmSecret": Secrets.get("lastfmSecret").isEmpty ? "" : "set",                // never sent back to the page
            "updateRepo": d.string(forKey: "updateRepo") ?? "",
            "autoUpdate": d.bool(forKey: "autoUpdate"),
        ]
    }

    /// Returns false for unknown keys.
    @discardableResult
    func set(_ key: String, _ value: Any) -> Bool {
        guard Settings.keys.contains(key) else { return false }
        if key == "openAtLogin" {
            let on = (value as? Bool) ?? false
            do {
                if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            } catch {
                NSLog("Cadenza: open at login failed: \(error)")
            }
            return true
        }
        if Settings.secretKeys.contains(key) {
            Secrets.set(key, ((value as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
            return true
        }
        if let s = value as? String {
            d.set(s.trimmingCharacters(in: .whitespacesAndNewlines), forKey: key)
        } else {
            d.set(value, forKey: key)
        }
        return true
    }

    static let supportDir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let url = base.appendingPathComponent("Cadenza", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    /// Writes a file that only you can read (0600) from the moment it exists, then moves it into place.
    /// Writing first and tightening the permissions afterwards would leave it readable for a moment.
    @discardableResult
    static func writePrivately(_ data: Data, to url: URL) -> Bool {
        let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent)-\(UUID().uuidString)")
        let fd = Darwin.open(tmp.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else { return false }
        let written = data.withUnsafeBytes { raw -> Bool in
            guard let base = raw.baseAddress else { return data.isEmpty }
            return Darwin.write(fd, base, raw.count) == raw.count
        }
        Darwin.close(fd)
        guard written, Darwin.rename(tmp.path, url.path) == 0 else {
            Darwin.unlink(tmp.path)
            return false
        }
        return true
    }
}

/// Passwords and tokens (Last.fm secret and session, Genius token), kept in a private file in
/// Application Support (~/Library/Application Support/Cadenza/secrets.json) that only your user account
/// can read (0600), like the Spotify login next to it. Not in the Keychain, so macOS never asks about it.
enum Secrets {
    private static var file: URL { Settings.supportDir.appendingPathComponent("secrets.json") }
    private static var values: [String: String] = {
        guard let data = try? Data(contentsOf: file),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: String] else { return [:] }
        return obj
    }()

    static func get(_ key: String) -> String { values[key] ?? "" }

    /// Saves the value, or deletes it when empty. Returns false if the file couldn't be written.
    @discardableResult
    static func set(_ key: String, _ value: String) -> Bool {
        if value.isEmpty { values.removeValue(forKey: key) } else { values[key] = value }
        guard let data = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]) else { return false }
        let ok = Settings.writePrivately(data, to: file)
        if !ok { NSLog("Cadenza: couldn't save \(key)") }
        return ok
    }
}
