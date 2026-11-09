import AppKit
import ApplicationServices
import WebKit

/// Message bridge between the web UI and native code.
/// JS:  await window.webkit.messageHandlers.native.postMessage({cmd, args})
/// Native → JS events: app.onNative(event, data)
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    unowned let app: AppDelegate

    init(app: AppDelegate) { self.app = app }

    func emit(_ event: String, _ data: Any? = nil) {
        var payload = "null"
        if let data, JSONSerialization.isValidJSONObject(data),
           let d = try? JSONSerialization.data(withJSONObject: data),
           let s = String(data: d, encoding: .utf8) {
            payload = s
        }
        let safeEvent = event.filter { $0.isLetter || $0.isNumber || $0 == "." || $0 == "_" }
        app.webView?.evaluateJavaScript("window.app && app.onNative('\(safeEvent)', \(payload))", completionHandler: nil)
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        // Only Cadenza's own page may talk to the native side: the main frame, loaded from the app's files.
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "file" else {
            return replyHandler(nil, "Not allowed")
        }
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else {
            return replyHandler(nil, "Bad message")
        }
        let args = (body["args"] as? [String: Any]) ?? [:]
        let reply: (Any?) -> Void = { value in
            DispatchQueue.main.async { replyHandler(value ?? NSNull(), nil) }
        }

        switch cmd {
        case "api":
            let method = (args["method"] as? String) ?? "GET"
            let path = (args["path"] as? String) ?? "/"
            app.api.request(method, path, body: args["body"]) { status, json in
                reply(["status": status, "body": json ?? NSNull()])
            }

        case "auth.status":
            // Refresh first, so we know which permissions the current login has.
            app.auth.token { [weak self] _ in
                guard let self else { return }
                reply(["loggedIn": self.app.auth.isLoggedIn,
                       "clientId": Settings.shared.clientId,
                       "redirectURI": SpotifyAuth.redirectURI,
                       "missingScopes": self.app.auth.missingScopes])
            }
        case "auth.setClientId":
            let newId = ((args["clientId"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if newId != Settings.shared.clientId { app.auth.logout(); app.api.resetBlock() }   // old login belongs to the old Client ID
            Settings.shared.clientId = newId
            reply(true)
        case "auth.login":
            app.auth.login { ok, message in
                reply(["ok": ok, "message": (message as Any?) ?? NSNull()])
                if ok { NSApp.activate(ignoringOtherApps: true); self.app.window.makeKeyAndOrderFront(nil) }
            }
        case "auth.logout":
            app.auth.logout()
            app.api.resetBlock()
            reply(true)

        case "outputs.list":
            reply(app.audio.list().map { $0.dict })
        case "outputs.set":
            reply(app.audio.setDefault(uid: (args["uid"] as? String) ?? ""))

        case "librespot.status":
            reply(app.librespot.status())
        case "librespot.restart":
            app.librespot.restart()
            reply(true)
        case "engine.ensure":
            // The page couldn't find Cadenza among Spotify's speakers: get librespot listed again.
            app.librespot.checkDevice("the page couldn't find it") { ok in reply(["ok": ok]) }
        case "librespot.transferHere":
            app.librespot.transferHere(play: (args["play"] as? Bool) ?? true, attempts: 6)
            reply(true)

        case "settings.get":
            var s = Settings.shared.all()
            s["mediaKeysTrusted"] = AXIsProcessTrusted()
            reply(s)
        case "settings.set":
            guard let key = args["key"] as? String, let value = args["value"] else { return reply(false) }
            confirmSetting(key, value) { [weak self] ok in
                guard let self else { return }
                if ok {
                    if key == "clientId", let v = value as? String,
                       v.trimmingCharacters(in: .whitespacesAndNewlines) != Settings.shared.clientId {
                        self.app.auth.logout()                             // old login belongs to the old Client ID
                        self.app.api.resetBlock()
                    }
                    Settings.shared.set(key, value)
                    self.app.applySetting(key)
                }
                var s = Settings.shared.all()
                s["mediaKeysTrusted"] = AXIsProcessTrusted()
                reply(s)
            }

        case "speak":
            app.speech.speak((args["text"] as? String) ?? "") { reply(true) }
        case "speak.voices":
            reply(["voices": Speech.list(), "current": UserDefaults.standard.string(forKey: "djVoiceId") ?? ""])
        case "speak.setVoice":
            UserDefaults.standard.set((args["id"] as? String) ?? "", forKey: "djVoiceId")
            reply(true)
        case "speak.stop":
            app.speech.stop()
            reply(true)

        case "nowplaying":
            app.media.updateNowPlaying(args)
            app.statusBar.update(args)
            app.floating.update(args)
            app.notifier.update(args)
            app.discord.update(args)
            reply(true)

        case "discord.status":
            reply(["enabled": app.discord.enabled, "status": app.discord.status, "hasId": !app.discord.appId.isEmpty])

        case "lastfm.status":
            reply(app.lastfm.status())
        case "lastfm.login":
            app.lastfm.login { ok, message in
                reply(["ok": ok, "message": (message as Any?) ?? NSNull()])
                if ok { NSApp.activate(ignoringOtherApps: true); self.app.window.makeKeyAndOrderFront(nil) }
            }
        case "lastfm.get":
            // Read-only: Stats, play counts, the DJ and Friends. Values are passed on as strings.
            let method = (args["method"] as? String) ?? ""
            var params: [String: String] = [:]
            for (k, v) in (args["params"] as? [String: Any]) ?? [:] {
                if let s = v as? String { params[k] = s } else if let n = v as? NSNumber { params[k] = n.stringValue }
            }
            app.lastfm.read(method, params) { status, json in reply(["status": status, "body": json ?? NSNull()]) }
        case "lastfm.logout":
            app.lastfm.logout()
            app.lastfmPlays.clear()
            reply(true)

        case "update.status":
            reply(app.updater.status())
        case "update.check":
            app.updater.check { reply($0) }
        case "update.install":
            app.updater.install { ok, message in reply(["ok": ok, "message": (message as Any?) ?? NSNull()]) }

        case "clipboard":
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString((args["text"] as? String) ?? "", forType: .string)
            reply(true)

        case "store.get":
            reply(app.store.get((args["key"] as? String) ?? ""))
        case "store.set":
            app.store.set((args["key"] as? String) ?? "", args["value"])
            reply(true)

        case "api.activity":
            reply(app.api.activity())

        case "history.get":
            // Reading a year of plays is quick, but keep it off the main thread anyway.
            let since = (args["since"] as? Double) ?? 0
            let history = app.history
            DispatchQueue.global(qos: .userInitiated).async { reply(history.entries(since: since)) }

        case "spotifyHistory.import":
            // You pick the files in a macOS dialog, so the page never chooses what gets read.
            app.spotifyHistory.pickAndImport(window: app.window) { result in reply(result) }
        case "lastfmPlays.get":
            app.lastfmPlays.get { reply($0) }
        case "lastfmPlays.set":
            app.lastfmPlays.set(args["value"]) { reply($0) }
        case "spotifyHistory.get":
            app.spotifyHistory.snapshot { reply($0) }
        case "spotifyHistory.clear":
            ask("Remove your imported Spotify history?",
                "Stats goes back to Last.fm or Cadenza's own history. Your Spotify account and the files you imported aren't touched, and you can import them again any time.",
                ok: "Remove") { [weak self] yes in
                guard yes, let self else { return reply(false) }
                self.app.spotifyHistory.clear { reply(true) }
            }

        case "diagnostics":
            let text = app.diagnostics()
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            reply(text)

        case "translate":
            app.translator.translate((args["lines"] as? [String]) ?? [], in: app.window) { lines, error in
                reply(["lines": (lines as Any?) ?? NSNull(), "error": (error as Any?) ?? NSNull(), "target": LyricsTranslator.targetCode])
            }

        case "genius.search":
            Genius.search((args["q"] as? String) ?? "") { hits, error in
                reply(["hits": (hits as Any?) ?? NSNull(), "error": (error as Any?) ?? NSNull()])
            }

        case "mini.toggle":
            app.floating.toggle()
            reply(app.floating.isOpen)

        case "ai.status":
            reply(app.tagAI.status())
        case "ai.tags":
            app.tagAI.tags(prompt: (args["prompt"] as? String) ?? "") { tags, error in
                reply(["tags": (tags as Any?) ?? NSNull(), "error": (error as Any?) ?? NSNull()])
            }

        case "eq.get":
            var s = app.eq.state()
            s["engine"] = app.librespot.usesEQEngine
            reply(s)
        case "eq.set":
            app.eq.update(args)
            var s = app.eq.state()
            s["engine"] = app.librespot.usesEQEngine
            reply(s)
        case "eq.engine":
            UserDefaults.standard.set((args["on"] as? Bool) ?? true, forKey: "eqEngine")
            if Settings.shared.manageLibrespot { app.librespot.restart() }
            reply(true)
        case "audio.local":
            app.audioLocal((args["action"] as? String) ?? "")
            reply(true)
        case "eq.meter":
            app.eq.setMeter((args["on"] as? Bool) ?? false)
            reply(true)

        case "lyrics":
            Lyrics.fetch(track: (args["track"] as? String) ?? "", artist: (args["artist"] as? String) ?? "",
                         album: (args["album"] as? String) ?? "", seconds: (args["seconds"] as? Int) ?? 0) { result in
                reply(result)
            }

        case "cover.upload":
            guard let id = args["playlistId"] as? String, let b64 = CoverPicker.pickJPEGBase64() else { return reply(["status": 0]) }
            app.api.upload("PUT", "/playlists/\(id)/images", body: Data(b64.utf8), contentType: "image/jpeg") { status in
                reply(["status": status])
            }

        case "window.fullscreen":
            // {on: true/false} sets it; no argument flips it. Replies whether it was full screen before.
            let was = app.window.styleMask.contains(.fullScreen)
            if let on = args["on"] as? Bool { if on != was { app.window.toggleFullScreen(nil) } } else { app.window.toggleFullScreen(nil) }
            reply(was)
        case "openURL":
            // Only Spotify links and web pages. Anything else (file:// paths, other apps' URL schemes)
            // could open programs on the Mac.
            if let s = args["url"] as? String, let url = URL(string: s),
               ["spotify", "https"].contains(url.scheme?.lowercased() ?? "") {
                NSWorkspace.shared.open(url)
            }
            reply(true)

        default:
            replyHandler(nil, "Unknown command: \(cmd)")
        }
    }

    // MARK: - Settings that need your OK

    /// Two settings decide what code Cadenza runs: the librespot program it starts, and the GitHub
    /// repository it installs updates from. The page can't change them on its own. A native dialog
    /// asks you first, so even a bug in the web UI can't point them somewhere else without you knowing.
    private func confirmSetting(_ key: String, _ value: Any, done: @escaping (Bool) -> Void) {
        let new = ((value as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        switch key {
        case "librespotPath":
            if new.isEmpty || new == Settings.shared.librespotPath { return done(true) }   // back to automatic
            let path = (new as NSString).expandingTildeInPath
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir), !isDir.boolValue,
                  FileManager.default.isExecutableFile(atPath: path) else {
                return ask("That isn't a program", "Cadenza couldn't find a program at \(path). Point it at the librespot file itself, for example /opt/homebrew/bin/librespot.",
                           ok: nil, done: { _ in done(false) })
            }
            ask("Use this program as the audio engine?",
                "Cadenza will start \(path) every time it opens and send it your music. Only choose a librespot you installed yourself.",
                ok: "Use It", done: done)
        case "updateRepo":
            var repo = new
            if repo.hasPrefix("https://github.com/") { repo = String(repo.dropFirst("https://github.com/".count)) }
            if repo.hasSuffix(".git") { repo = String(repo.dropLast(4)) }
            repo = repo.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let current = UserDefaults.standard.string(forKey: "updateRepo") ?? ""
            if repo.isEmpty || repo == current || repo == AppInfo.defaultRepo { return done(true) }
            guard Updater.isValidRepo(repo) else {
                return ask("That isn't a GitHub repository", "Write it as owner/name, for example \(AppInfo.defaultRepo).",
                           ok: nil, done: { _ in done(false) })
            }
            ask("Get updates from \(repo)?",
                "Cadenza will offer to install new versions published at github.com/\(repo). Only pick a repository you trust. Updates are still only installed if they're signed like your copy of Cadenza.",
                ok: "Use It", done: done)
        default:
            done(true)
        }
    }

    /// A sheet on the main window. With `ok` nil it's just a notice with an OK button (answers false).
    private func ask(_ title: String, _ text: String, ok: String?, done: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        if let ok {
            alert.alertStyle = .warning
            alert.addButton(withTitle: ok)
            alert.addButton(withTitle: "Cancel")
        } else {
            alert.addButton(withTitle: "OK")
        }
        let answer: (NSApplication.ModalResponse) -> Void = { r in done(ok != nil && r == .alertFirstButtonReturn) }
        if let window = app.window, window.isVisible {
            alert.beginSheetModal(for: window, completionHandler: answer)
        } else {
            answer(alert.runModal())
        }
    }
}
