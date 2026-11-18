import AppKit
import ApplicationServices
import Carbon
import WebKit

/// The web UI's folder: inside the app bundle, or the source folder when run with `swift run`.
enum WebFiles {
    static func directory() -> URL? {
        let fm = FileManager.default
        if let res = Bundle.main.resourceURL?.appendingPathComponent("web"),
           fm.fileExists(atPath: res.appendingPathComponent("index.html").path) { return res }
        let dev = URL(fileURLWithPath: fm.currentDirectoryPath).appendingPathComponent("Resources/web")
        return fm.fileExists(atPath: dev.appendingPathComponent("index.html").path) ? dev : nil
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    private(set) var bridge: Bridge!

    let auth = SpotifyAuth()
    lazy var api = SpotifyAPI(auth: auth)
    let audio = AudioOutputs()
    lazy var librespot = Librespot(api: api)
    lazy var media = MediaKeys(api: api)
    let statusBar = StatusBar()
    let notifier = Notifier()
    let store = Store()
    let eq = AudioPipe()
    let discord = DiscordPresence()
    let lastfm = LastFM()
    let updater = Updater()
    let history = History()
    let spotifyHistory = SpotifyHistory()
    let lastfmPlays = LastfmPlays()
    let taste = TasteFile()
    let floating = FloatingPlayer()
    let translationModels = TranslationModels()
    private var hotKey: HotKey?
    /// cadenza:// links that arrived before the page was ready (e.g. the link is what opened Cadenza).
    private var pendingURLs: [URL] = []
    private var pageReady = false
    /// The window is closed, minimised or hidden: the page rests (see setAsleep).
    private var asleep = false
    /// The folder the web UI loads from. The web view may only show pages inside it.
    private var webRoot: URL?

    // MARK: - Launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Writing to a pipe or socket whose other end just closed (librespot quitting, Discord closing)
        // would otherwise kill Cadenza on the spot. Ignore that signal; the write just fails instead.
        signal(SIGPIPE, SIG_IGN)
        // Closing the lid pauses the music (like taking headphones off), so it doesn't come back on by
        // itself when the Mac wakes. The sound engine also stops cleanly and reconnects after waking.
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, self.librespot.activeHere, self.librespot.playingHere else { return }
            self.eq.localPause()
            self.api.request("PUT", "/me/player/pause") { _, _ in }
        }
        // Only one Cadenza at a time. An older copy left running in the background (closing the window
        // doesn't quit it) would keep talking to Spotify with the same login and use up the rate limit.
        let me = NSRunningApplication.current
        for other in NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "io.github.chedd4rr.cadenza")
        where other.processIdentifier != me.processIdentifier {
            if !other.terminate() { other.forceTerminate() }
        }
        buildMenu()
        buildWindow()

        audio.onListChange = { [weak self] in self?.bridge.emit("outputs") }
        audio.onDefaultChange = { [weak self] in
            self?.bridge.emit("outputs")
            self?.followOutputEQ(announce: true)
            self?.eq.outputMoved(force: true)              // a real switch: Cadenza's sound engine moves to it
            self?.librespot.outputChanged()
        }
        audio.startListening()

        librespot.onStatus = { [weak self] status in self?.bridge.emit("librespot", status) }
        librespot.onPlayer = { [weak self] player in self?.bridge.emit("player", player) }
        librespot.onResume = { [weak self] snapshot in self?.bridge.emit("engine.resume", snapshot) }
        librespot.onRetry = { [weak self] song in self?.bridge.emit("engine.resume", song) }
        librespot.onSongRefused = { [weak self] uri in self?.bridge.emit("engine.refused", ["uri": uri]) }
        librespot.onQueueEnd = { [weak self] in self?.bridge.emit("engine.end", [:]) }
        librespot.audio = eq
        librespot.history = history
        librespot.onTrackChange = { [weak self] in self?.eq.trackChanged() }
        // Music resumed from elsewhere (phone, Spotify app, Control Center): make sure Cadenza's sound is on.
        librespot.onPlaying = { [weak self] playing in if playing { self?.eq.localResume() } }
        followOutputEQ(announce: false)
        media.local = { [weak self] action in self?.audioLocal(action) }
        media.localPlaying = { [weak self] in
            guard let self, self.librespot.activeHere else { return nil }
            return self.librespot.playingHere
        }
        eq.onLevels = { [weak self] levels in self?.bridge.emit("eq.levels", levels) }
        eq.onLog = { [weak self] line in self?.librespot.note(line) }
        if Settings.shared.manageLibrespot { librespot.start() }

        media.isLoggedIn = { [weak self] in self?.auth.isLoggedIn ?? false }
        media.onAction = { [weak self] in self?.bridge.emit("refresh") }
        media.setupRemoteCommands()
        if Settings.shared.mediaKeys { media.enableTap() }

        applyHotKey()

        // Menu-bar and floating mini players: playback goes straight to Spotify; like/volume go through the UI.
        statusBar.onAction = { [weak self] action, value in self?.miniAction(action, value) }
        floating.onAction = { [weak self] action, value in self?.miniAction(action, value) }
        statusBar.setEnabled(Settings.shared.menuBar)
        floating.restore()
        notifier.enabled = Settings.shared.notifications
        notifier.onClick = { [weak self] in self?.showWindow() }
        notifier.start()

        discord.enabled = Settings.shared.discord
        lastfm.onChange = { [weak self] in guard let self else { return }; self.bridge.emit("lastfm", self.lastfm.status()) }
        updater.onChange = { [weak self] in guard let self else { return }; self.bridge.emit("update", self.updater.status()) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in self?.updater.checkOnLaunch() }

        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationWillTerminate(_ notification: Notification) {
        history.finish()                                   // log the song that was playing
        // Exactly where the song was, so the next Play starts there. (The page saves its own note only
        // every so often, and can't save anything once Cadenza is quitting.)
        if let spot = librespot.positionSnapshot() { store.set("enginePosition", spot) }
        store.flush()                                      // anything changed in the last second
        eq.shutdown()                                      // sound engine first, so nothing touches it mid-teardown
        librespot.stop()
        media.disableTap()
        hotKey = nil
    }

    private func miniAction(_ action: String, _ value: Any?) {
        switch action {
        case "toggle": media.playPause()
        case "next": media.next()
        case "previous": media.previous()
        case "show": showWindow()
        case "like": bridge.emit("like")
        case "volume": bridge.emit("volume", ["value": value ?? 0])
        default: break
        }
    }

    // MARK: - cadenza:// links (for the Shortcuts app, Raycast, Alfred, Terminal's `open`…)

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme?.lowercased() == "cadenza" {
            if pageReady { handle(url) } else { pendingURLs.append(url) }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !pageReady else { return }
        // Give the page a moment to log in and load before running links that opened Cadenza.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            guard let self else { return }
            self.pageReady = true
            let waiting = self.pendingURLs
            self.pendingURLs = []
            waiting.forEach { self.handle($0) }
        }
    }

    private func handle(_ url: URL) {
        let action = (url.host ?? url.path.replacingOccurrences(of: "/", with: "")).lowercased()
        var query: [String: String] = [:]
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.forEach { query[$0.name.lowercased()] = $0.value ?? "" }
        switch action {
        case "mini": floating.toggle()                      // works even with the window closed
        case "show": showWindow()
        case "hide": NSApp.hide(nil)
        default: bridge.emit("url", ["action": action, "query": query])
        }
    }

    // MARK: - Resting while the window is away

    /// Closing the window doesn't quit Cadenza (the music, menu bar and media keys keep going), but
    /// nothing on the page needs to move. Hiding the web view stops WebKit drawing it, and the page
    /// stops its animations, visualizer and clock and checks Spotify less often.
    private func setAsleep(_ on: Bool) {
        guard on != asleep, webView != nil else { return }
        asleep = on
        webView.isHidden = on
        bridge.emit(on ? "sleep" : "wake")
    }

    func windowWillClose(_ notification: Notification) { setAsleep(true) }
    func windowDidMiniaturize(_ notification: Notification) { setAsleep(true) }
    func windowDidDeminiaturize(_ notification: Notification) { setAsleep(false) }
    func windowDidBecomeKey(_ notification: Notification) { setAsleep(false) }
    func applicationDidHide(_ notification: Notification) { setAsleep(true) }
    func applicationDidUnhide(_ notification: Notification) { if window.isVisible && !window.isMiniaturized { setAsleep(false) } }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    // MARK: - Window

    private func buildWindow() {
        let config = WKWebViewConfiguration()
        let content = WKUserContentController()
        config.userContentController = content
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")   // right-click → Inspect Element

        // The translator, language detector and translation models reach the page through this (see TranslationModels.swift).
        config.setURLSchemeHandler(FilesScheme(webRoot: WebFiles.directory(), models: translationModels.dir), forURLScheme: FilesScheme.scheme)
        webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        webView.navigationDelegate = self
        webView.allowsMagnification = false
        bridge = Bridge(app: self)
        content.addScriptMessageHandler(bridge, contentWorld: .page, name: "native")

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Cadenza"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(srgbRed: 0.012, green: 0.047, blue: 0.18, alpha: 1)
        window.minSize = NSSize(width: 1100, height: 700)
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("CadenzaMain")
        window.collectionBehavior.insert(.fullScreenPrimary)

        if let dir = WebFiles.directory() {
            webRoot = dir.resolvingSymlinksInPath()
            webView.loadFileURL(dir.appendingPathComponent("index.html"), allowingReadAccessTo: dir)
        } else {
            webView.loadHTMLString("<body style='background:#030c2e;color:white;font:20px sans-serif;padding:40px'>Couldn't find the web UI folder (Resources/web).</body>", baseURL: nil)
        }
        window.makeKeyAndOrderFront(nil)
    }

    func showWindow() {
        setAsleep(false)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        bridge.emit("opened")
    }

    func toggleWindow() {
        if NSApp.isActive && window.isKeyWindow && window.isVisible {
            NSApp.hide(nil)
        } else {
            showWindow()
        }
    }

    // The web view only ever shows Cadenza's own files. A web link you click opens in your browser;
    // any other attempt to load a page (a script changing location, a form, a frame) is blocked, since
    // whatever page is showing can talk to the native side.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        if url.isFileURL, let root = webRoot {
            let path = url.resolvingSymlinksInPath().path
            if path == root.path || path.hasPrefix(root.path + "/") { return decisionHandler(.allow) }
        }
        if url.absoluteString == "about:blank" { return decisionHandler(.allow) }     // the "web UI missing" page
        if url.scheme == "http" || url.scheme == "https", navigationAction.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    /// Each output device keeps its own EQ: load the one for whatever the Mac is playing through now.
    func followOutputEQ(announce: Bool) {
        guard let out = audio.list().first(where: { $0.isDefault }) else { return }
        if eq.useDevice(uid: out.uid, name: out.name) && announce {
            var s = eq.state()
            s["engine"] = librespot.usesEQEngine
            bridge.emit("eq.changed", s)
        }
    }

    /// Instant response for pause / play / skip when this Mac's engine is the one playing.
    func audioLocal(_ action: String) {
        guard librespot.activeHere else { return }
        switch action {
        case "pause": eq.localPause(); librespot.verifyPause()
        case "play": eq.localResume()
        case "toggle":
            if librespot.playingHere && !eq.holding { eq.localPause(); librespot.verifyPause() } else { eq.localResume() }
        case "skip": eq.beginSkip()
        case "sleepfade": eq.sleepFade()                          // the sleep timer: 10 s fade, then the page pauses
        default: break
        }
    }

    /// Everything useful for tracking down a problem, as plain text (System → Copy diagnostics).
    func diagnostics() -> String {
        let info = Bundle.main.infoDictionary ?? [:]
        var lines: [String] = []
        lines.append("Cadenza \(info["CFBundleShortVersionString"] as? String ?? "?") (\(info["CFBundleVersion"] as? String ?? "?"))")
        lines.append("macOS \(ProcessInfo.processInfo.operatingSystemVersionString)")
        var size = 0
        sysctlbyname("hw.model", nil, &size, nil, 0)
        if size > 0 {
            var model = [CChar](repeating: 0, count: size)
            sysctlbyname("hw.model", &model, &size, nil, 0)
            lines.append("Mac: \(String(cString: model))")
        }
        lines.append("Time: \(Date())")
        lines.append("")
        let sound = eq.state()
        lines.append("Sound engine: running \(sound["running"] ?? "?"), device \(sound["device"] ?? "?"), EQ \(sound["enabled"] ?? "?") (\(sound["preset"] ?? "?"))")
        lines.append("Outputs: " + audio.list().map { $0.name + ($0.isDefault ? " (current)" : "") }.joined(separator: ", "))
        var settings = Settings.shared.all()
        for secret in ["clientId", "lastfmKey", "lastfmSecret", "geniusToken", "discordAppId"] {
            if let v = settings[secret] as? String, !v.isEmpty { settings[secret] = "(set)" }
        }
        lines.append("Settings: " + settings.keys.sorted().map { "\($0)=\(settings[$0] ?? "")" }.joined(separator: ", "))
        let act = api.activity()
        lines.append("Spotify requests: \(act["lastMinute"] ?? 0) in the last minute, \(act["total"] ?? 0) total, blocked for \(act["blockedFor"] ?? 0) s")
        lines.append("")
        lines.append(contentsOf: librespot.diagnostics())
        lines.append("")
        lines.append("== recent Spotify requests ==")
        lines.append(contentsOf: ((act["log"] as? [String]) ?? []).suffix(30))
        // People paste this into public bug reports: leave out the Spotify username and the home folder
        // (which usually has your name in it).
        var text = lines.joined(separator: "\n")
        text = text.replacingOccurrences(of: NSHomeDirectory(), with: "~")
        text = text.replacingOccurrences(of: "Authenticated as ['\"][^'\"]*['\"]", with: "Authenticated as '(hidden)'", options: .regularExpression)
        text = text.replacingOccurrences(of: "([?&]q=)[^&\\s]*", with: "$1(hidden)", options: .regularExpression)   // what you searched for
        // Your name, wherever it turns up (headphones and speakers are often called "Alex's AirPods").
        let names = [NSFullUserName(), NSFullUserName().split(separator: " ").first.map(String.init) ?? "", NSUserName()]
        for name in names.reduce(into: [String](), { if !$0.contains($1) { $0.append($1) } }) where name.count >= 3 {
            // Whole words only (a first name like "Will" mustn't eat "will" in a log line), full name first.
            text = text.replacingOccurrences(of: "\\b" + NSRegularExpression.escapedPattern(for: name) + "\\b", with: "(you)", options: [.regularExpression])
        }
        return text
    }

    // MARK: - Settings

    func applySetting(_ key: String) {
        switch key {
        case "manageLibrespot":
            if Settings.shared.manageLibrespot { librespot.start() } else { librespot.stop() }
        case "librespotPath", "deviceName", "bitrate":
            if Settings.shared.manageLibrespot { librespot.restart() }
        case "mediaKeys":
            if Settings.shared.mediaKeys { media.enableTap() } else { media.disableTap() }
        case "globalHotkey":
            applyHotKey()
        case "menuBar":
            statusBar.setEnabled(Settings.shared.menuBar)
        case "miniStyle":
            statusBar.refreshStyle()
        case "normalize", "autoplay":
            if Settings.shared.manageLibrespot { librespot.restart() }
        case "discord", "discordAppId":
            discord.enabled = false
            discord.enabled = Settings.shared.discord
            bridge.emit("refresh")
        case "notifications":
            notifier.enabled = Settings.shared.notifications
            if notifier.enabled { notifier.requestPermission() }
        default:
            break
        }
    }

    private func applyHotKey() {
        hotKey?.unregister()
        hotKey = nil
        if Settings.shared.globalHotkey {
            // Option + Command + P
            hotKey = HotKey(keyCode: kVK_ANSI_P, modifiers: cmdKey | optionKey) { [weak self] in self?.toggleWindow() }
        }
    }

    @objc private func menuCommand(_ sender: NSMenuItem) {
        guard let cmd = sender.representedObject as? String else { return }
        if cmd == "mini" { return floating.toggle() }
        if !window.isVisible { showWindow() }
        bridge.emit("command", ["cmd": cmd])
    }

    // MARK: - Menu bar

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Cadenza", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Cadenza", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Cadenza", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        // Needed so ⌘C / ⌘V / ⌘A work in the search box.
        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        // Controls: the main commands, with their shortcuts (they run in the page, like pressing the keys).
        let controlsItem = NSMenuItem()
        main.addItem(controlsItem)
        let controls = NSMenu(title: "Controls")
        let entries: [(String, String, String, NSEvent.ModifierFlags)] = [
            ("Play / Pause", "toggle", " ", []),
            ("Next Song    (⌘→)", "next", "", []),
            ("Previous Song    (⌘←)", "previous", "", []),
            ("Shuffle", "shuffle", "s", [.command]),
            ("Repeat", "repeat", "r", [.command]),
            ("Like Song    (L)", "like", "", []),
            ("-", "", "", []),
            ("Stage Mode", "stage", "f", [.command, .shift]),
            ("Floating Mini Player", "mini", "m", [.command, .shift]),
            ("Command Palette…", "palette", "k", [.command]),
            ("Search", "search", "f", [.command]),
            ("Switch Theme", "theme", "t", [.command]),
            ("-", "", "", []),
            ("Home", "go:home", "", []),
            ("Library", "go:library", "", []),
            ("Queue", "go:queue", "", []),
            ("History", "go:history", "", []),
            ("Listening Stats", "go:stats", "", []),
            ("Friends", "go:friends", "", []),
            ("EQ", "go:eq", "", []),
            ("DJ", "go:dj", "", []),
            ("System", "go:system", ",", [.command]),
            ("Keyboard Shortcuts", "go:commands", "/", [.command]),
            ("-", "", "", []),
            ("Check for Updates…", "update", "", []),
        ]
        for (title, cmd, key, mods) in entries {
            if title == "-" { controls.addItem(.separator()); continue }
            // Space, L and ⌘←/→ can't be menu shortcuts without stealing them from text fields; their titles list them instead.
            let item = NSMenuItem(title: cmd == "toggle" ? "Play / Pause    (Space)" : title, action: #selector(menuCommand(_:)), keyEquivalent: key == " " ? "" : key)
            item.keyEquivalentModifierMask = mods
            item.representedObject = cmd
            item.target = self
            controls.addItem(item)
        }
        controlsItem.submenu = controls

        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let fs = win.addItem(withTitle: "Toggle Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        windowItem.submenu = win

        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }
}
