import AppKit
import Foundation
import Security

/// Updates from GitHub releases. Set the repository ("owner/name") in System → Updates.
/// A release needs a .zip asset holding Cadenza.app (made with `./release.sh`, which uses ditto so
/// the app's signature survives). Cadenza downloads it, swaps the app in place and reopens.
/// An update is only installed if it's signed with the same certificate as the copy that's running,
/// so a copy you built yourself never gets swapped for someone else's build.
final class Updater {
    private let d = UserDefaults.standard
    var repo: String {
        var r = (d.string(forKey: "updateRepo") ?? "").trimmingCharacters(in: .whitespaces)
        if r.hasPrefix("https://github.com/") { r = String(r.dropFirst("https://github.com/".count)) }
        if r.hasSuffix(".git") { r = String(r.dropLast(4)) }
        return r.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
    var current: String { AppInfo.version }

    /// "owner/name", using only the characters GitHub allows in user and repository names.
    static func isValidRepo(_ r: String) -> Bool {
        r.range(of: "^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", options: .regularExpression) != nil
    }
    private(set) var found: [String: Any]?           // the newer release, if there is one
    private(set) var state = "idle"                  // idle, checking, latest, available, downloading, installing, error
    private(set) var message = ""
    var onChange: (() -> Void)?

    func status() -> [String: Any] {
        var s: [String: Any] = ["repo": repo, "current": current, "state": state, "message": message,
                                "auto": d.object(forKey: "autoUpdate") as? Bool ?? true]
        if let found { s["found"] = found }
        return s
    }

    private func set(_ st: String, _ msg: String = "") {
        state = st; message = msg
        onChange?()
    }

    /// Launch check: at most every 6 hours, only when a repository is set.
    func checkOnLaunch() {
        guard !repo.isEmpty, d.object(forKey: "autoUpdate") as? Bool ?? true else { return }
        let last = d.double(forKey: "updateCheckedAt")
        guard Date().timeIntervalSince1970 - last > 6 * 3600 else { return }
        check { _ in }
    }

    func check(done: @escaping ([String: Any]) -> Void) {
        guard Updater.isValidRepo(repo), let url = URL(string: "https://api.github.com/repos/\(repo)/releases/latest") else {
            set("error", "Set the GitHub repository first (owner/name)")
            return done(status())
        }
        set("checking")
        var req = URLRequest(url: url)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue(AppInfo.userAgent, forHTTPHeaderField: "User-Agent")
        req.timeoutInterval = 20
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let json = data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.d.set(Date().timeIntervalSince1970, forKey: "updateCheckedAt")
                guard code == 200, let json, let tag = json["tag_name"] as? String else {
                    self.set("error", code == 404 ? "No releases found for \(self.repo)" : code == 0 ? "Couldn't reach GitHub" : "GitHub said \(code)")
                    return done(self.status())
                }
                let version = Updater.clean(tag)
                guard Updater.isNewer(version, than: self.current) else {
                    self.found = nil
                    self.set("latest", "You have the latest version (\(self.current))")
                    return done(self.status())
                }
                let assets = (json["assets"] as? [[String: Any]]) ?? []
                let zips = assets.filter { (($0["name"] as? String) ?? "").lowercased().hasSuffix(".zip") }
                let asset = zips.first { (($0["name"] as? String) ?? "").lowercased().contains("cadenza") } ?? zips.first
                self.found = ["version": version, "notes": String(((json["body"] as? String) ?? "").prefix(1200)),
                              "page": (json["html_url"] as? String) ?? "", "asset": (asset?["browser_download_url"] as? String) ?? ""]
                self.set("available", "Version \(version) is ready")
                done(self.status())
            }
        }.resume()
    }

    static func clean(_ tag: String) -> String {
        var t = tag.trimmingCharacters(in: .whitespaces)
        if t.lowercased().hasPrefix("v") { t.removeFirst() }
        return t
    }

    /// 1.10 > 1.9 > 1.2.3 > 1.2 (numbers compared part by part).
    static func isNewer(_ a: String, than b: String) -> Bool {
        let pa = a.split(whereSeparator: { !$0.isNumber }).map { Int($0) ?? 0 }
        let pb = b.split(whereSeparator: { !$0.isNumber }).map { Int($0) ?? 0 }
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : 0, y = i < pb.count ? pb[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    // MARK: - Install

    func install(done: @escaping (Bool, String?) -> Void) {
        guard let found, let s = found["asset"] as? String, let url = URL(string: s), !s.isEmpty else {
            if let page = found?["page"] as? String, let u = URL(string: page) { NSWorkspace.shared.open(u) }
            return done(false, "This release has no .zip of Cadenza.app; opened the release page instead")
        }
        let target = Bundle.main.bundleURL
        guard target.pathExtension == "app" else { return done(false, "Cadenza isn't running from an app bundle (built with swift run?)") }
        guard FileManager.default.isWritableFile(atPath: target.deletingLastPathComponent().path) else {
            return done(false, "Can't write to \(target.deletingLastPathComponent().path)")
        }
        set("downloading", "Downloading \(found["version"] as? String ?? "")…")
        URLSession.shared.downloadTask(with: url) { file, resp, err in
            // The downloaded file is deleted when this returns, so move it first.
            var zip: URL?
            if let file, ((resp as? HTTPURLResponse)?.statusCode ?? 0) == 200 {
                let dest = FileManager.default.temporaryDirectory.appendingPathComponent("cadenza-update-\(UUID().uuidString).zip")
                if (try? FileManager.default.moveItem(at: file, to: dest)) != nil { zip = dest }
            }
            let zipFile = zip
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                guard let zip = zipFile else {
                    self.set("error", "Download failed" + (err.map { ": \($0.localizedDescription)" } ?? ""))
                    return done(false, self.message)
                }
                self.unpackAndSwap(zip, into: target, done: done)
            }
        }.resume()
    }

    private func unpackAndSwap(_ zip: URL, into target: URL, done: @escaping (Bool, String?) -> Void) {
        set("installing", "Installing…")
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("cadenza-update-\(UUID().uuidString)")
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let ditto = Process()
        ditto.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        ditto.arguments = ["-x", "-k", zip.path, dir.path]
        var unzipped = false
        do { try ditto.run(); ditto.waitUntilExit(); unzipped = ditto.terminationStatus == 0 } catch { }
        guard unzipped else { set("error", "Couldn't unzip the update"); return done(false, message) }

        // Find the .app inside (top level or one folder down).
        var app: URL?
        let top = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        app = top.first { $0.pathExtension == "app" }
        if app == nil {
            for sub in top { if let inner = (try? fm.contentsOfDirectory(at: sub, includingPropertiesForKeys: nil))?.first(where: { $0.pathExtension == "app" }) { app = inner; break } }
        }
        guard let app, let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")),
              (info["CFBundleIdentifier"] as? String) == Bundle.main.bundleIdentifier else {
            set("error", "The download doesn't contain Cadenza.app")
            return done(false, message)
        }
        // Only swap in an app signed the same way as this one. If you built Cadenza yourself, your copy is
        // signed with your own certificate and release builds aren't, so you get the release page instead.
        guard Updater.signedLikeThisApp(app) else {
            try? fm.removeItem(at: dir); try? fm.removeItem(at: zip)
            if let page = found?["page"] as? String, let u = URL(string: page) { NSWorkspace.shared.open(u) }
            set("error", "This update is signed differently from your copy of Cadenza, so it wasn't installed. Opened the release page instead.")
            return done(false, message)
        }

        // A small script waits for Cadenza to quit, swaps the app (keeping the old one if anything fails) and reopens it.
        let q = { (s: String) in "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let t = target.path, old = target.path + ".old"
        let script = """
        #!/bin/sh
        while kill -0 \(ProcessInfo.processInfo.processIdentifier) 2>/dev/null; do sleep 0.2; done
        rm -rf \(q(old))
        if mv \(q(t)) \(q(old)); then
          if mv \(q(app.path)) \(q(t)); then rm -rf \(q(old)); else mv \(q(old)) \(q(t)); fi
        fi
        xattr -dr com.apple.quarantine \(q(t)) 2>/dev/null
        open \(q(t))
        rm -rf \(q(dir.path)) \(q(zip.path))
        """
        let file = dir.appendingPathComponent("swap.sh")
        do { try script.write(to: file, atomically: true, encoding: .utf8) } catch { set("error", "Couldn't prepare the update"); return done(false, message) }
        let sh = Process()
        sh.executableURL = URL(fileURLWithPath: "/bin/sh")
        sh.arguments = [file.path]
        do { try sh.run() } catch { set("error", "Couldn't start the update"); return done(false, message) }
        done(true, nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { NSApp.terminate(nil) }
    }

    /// True if the app at `url` is validly signed and meets this running app's designated requirement:
    /// same bundle ID and same signing certificate. An ad-hoc signed copy only matches itself, so it
    /// never installs updates (you rebuild instead).
    static func signedLikeThisApp(_ url: URL) -> Bool {
        var me: SecCode?
        guard SecCodeCopySelf([], &me) == errSecSuccess, let me else { return false }
        var mine: SecStaticCode?
        guard SecCodeCopyStaticCode(me, [], &mine) == errSecSuccess, let mine else { return false }
        var requirement: SecRequirement?
        guard SecCodeCopyDesignatedRequirement(mine, [], &requirement) == errSecSuccess, let requirement else { return false }
        var other: SecStaticCode?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &other) == errSecSuccess, let other else { return false }
        let flags = SecCSFlags(rawValue: UInt32(kSecCSCheckAllArchitectures) | UInt32(kSecCSCheckNestedCode) | UInt32(kSecCSStrictValidate))
        return SecStaticCodeCheckValidity(other, flags, requirement) == errSecSuccess
    }
}
