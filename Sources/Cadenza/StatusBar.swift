import AppKit
import WebKit

/// Menu-bar mini player. The menu-bar icon is the current album cover; clicking it opens a
/// small player (cover, title, artist, previous / play / next, like, volume) drawn in the current
/// theme's style, or as a 2000s USB-stick MP3 player in MP3 mode.
/// Right-click for "Show Cadenza" and "Quit". MP3 mode is switched in the ⌘K palette.
final class StatusBar: NSObject {
    var onAction: ((String, Any?) -> Void)?          // "toggle" | "next" | "previous" | "like" | "volume" | "show"

    private var item: NSStatusItem?
    private let mini = MiniPlayerController()
    /// The mini player is a non-activating panel (not a popover): it opens over full-screen apps on their own
    /// Space, and clicking it doesn't switch you back to Cadenza's window.
    private lazy var panel: NSPanel = {
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 324, height: 500),
                        styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: true)
        p.isFloatingPanel = true
        p.level = .popUpMenu
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        p.hidesOnDeactivate = false
        p.becomesKeyOnlyIfNeeded = true
        // The page draws the player's shape and shadow itself, so the panel is fully transparent.
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.contentViewController = mini
        p.setContentSize(mini.preferredSize)
        return p
    }()
    private var outsideMonitor: Any?
    private var keyMonitor: Any?
    private var artURL: String?
    private var info: [String: Any] = [:]

    func setEnabled(_ on: Bool) {
        if on, item == nil {
            let it = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
            it.button?.target = self
            it.button?.action = #selector(clicked(_:))
            it.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
            it.button?.imageScaling = .scaleProportionallyDown
            item = it
            setIcon(nil)
            mini.onAction = { [weak self] a, v in
                if a == "show" { self?.showApp() } else { self?.onAction?(a, v) }
            }
            mini.onResize = { [weak self] size in self?.resize(to: size) }
            if let url = artURL { artURL = nil; var i = info; i["art"] = url; update(i) }
        } else if !on, let it = item {
            closePanel()
            NSStatusBar.system.removeStatusItem(it)
            item = nil
        }
    }

    /// Same info dictionary the UI sends for Control Center (title, artist, album, art, playing, liked, volume, theme).
    func update(_ info: [String: Any]) {
        self.info = info
        mini.apply(info)
        let art = info["art"] as? String
        if art != artURL {
            artURL = art
            guard let art, !art.isEmpty else { setIcon(nil); mini.setArt(nil); return }
            CoverArt.image(art) { [weak self] image in
                guard let self, self.artURL == art else { return }
                self.setIcon(image)
                self.mini.setArt(image)
            }
        }
    }

    private func setIcon(_ image: NSImage?) {
        guard let button = item?.button else { return }
        if let image {
            button.image = StatusBar.rounded(image, size: 19, radius: 4.5)
        } else {
            let note = NSImage(systemSymbolName: "music.note", accessibilityDescription: "Cadenza")
            note?.isTemplate = true
            button.image = note
        }
    }

    static func rounded(_ image: NSImage, size: CGFloat, radius: CGFloat) -> NSImage {
        let out = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).addClip()
            let s = min(image.size.width, image.size.height)
            let src = NSRect(x: (image.size.width - s) / 2, y: (image.size.height - s) / 2, width: s, height: s)
            image.draw(in: rect, from: src, operation: .sourceOver, fraction: 1)
            return true
        }
        out.isTemplate = false
        return out
    }

    @objc private func clicked(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp {
            let menu = NSMenu()
            menu.addItem(withTitle: "Show Cadenza", action: #selector(showApp), keyEquivalent: "").target = self
            menu.addItem(.separator())
            menu.addItem(withTitle: "Quit Cadenza", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
            item?.menu = menu
            sender.performClick(nil)
            item?.menu = nil
            return
        }
        if panel.isVisible { closePanel() } else { openPanel(below: sender) }
    }

    private func openPanel(below button: NSStatusBarButton) {
        place(below: button)
        panel.orderFrontRegardless()                 // shows without activating Cadenza (no Space switch)
        mini.setVisible(true)
        // close when clicking anywhere else, or on Esc
        outsideMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in self?.closePanel() }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            if e.keyCode == 53 { self?.closePanel(); return nil }
            return e
        }
    }

    /// Centres the panel under the menu-bar icon, with its top just under the menu bar.
    private func place(below button: NSStatusBarButton) {
        guard let bw = button.window else { return }
        let r = bw.convertToScreen(button.convert(button.bounds, to: nil))
        let size = panel.frame.size
        let screen = bw.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? .zero
        var x = r.midX - size.width / 2
        x = max(screen.minX + 2, min(x, screen.maxX - size.width - 2))
        panel.setFrameOrigin(NSPoint(x: x, y: r.minY - 2 - size.height))
    }

    /// The page asks for a new size when the look changes (each theme and MP3 mode have their own).
    private func resize(to size: NSSize) {
        guard size != panel.frame.size else { return }
        panel.setContentSize(size)
        if panel.isVisible, let button = item?.button { place(below: button) }
    }

    /// MP3 mode was switched (⌘K palette): redraw in the new look.
    func refreshStyle() { mini.redraw() }

    private func closePanel() {
        if panel.isVisible { mini.setVisible(false) }
        panel.orderOut(nil)
        if let m = outsideMonitor { NSEvent.removeMonitor(m); outsideMonitor = nil }
        if let m = keyMonitor { NSEvent.removeMonitor(m); keyMonitor = nil }
    }

    @objc private func showApp() { closePanel(); onAction?("show", nil) }
}

/// Controls that respond to the very first click, even while Cadenza isn't the active app.
final class FirstClickButton: NSButton { override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true } }

/// A web view that takes the very first click too, so the mini player's buttons work while Cadenza
/// is in the background.
final class FirstClickWebView: WKWebView { override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true } }

/// Passes script messages on without keeping the receiver alive (WebKit holds its handlers strongly).
final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(c, didReceive: message)
    }
}

/// The mini player's content: a small web page (Resources/web/mini) that draws the player in the
/// current theme's style, or as an MP3 stick. The page can only ask for the mini player's own
/// actions (play/pause, skip, like, volume, open Cadenza) and its size; it has no access to anything else.
final class MiniPlayerController: NSViewController, WKScriptMessageHandler, WKNavigationDelegate {
    var onAction: ((String, Any?) -> Void)?
    var onResize: ((NSSize) -> Void)?
    /// Size of the last look the page drew (a guess until the page has loaded).
    private(set) var preferredSize = NSSize(width: 324, height: 500)

    private var web: FirstClickWebView!
    private var webRoot: URL?
    private var ready = false
    private var info: [String: Any] = [:]
    private var infoAt = Date()          // when `info` arrived: its position was true at that moment
    private var artData = ""

    override func loadView() {
        let content = WKUserContentController()
        content.add(WeakScriptHandler(self), name: "mini")
        let config = WKWebViewConfiguration()
        config.userContentController = content
        let w = FirstClickWebView(frame: NSRect(origin: .zero, size: preferredSize), configuration: config)
        w.setValue(false, forKey: "drawsBackground")
        w.allowsMagnification = false
        w.navigationDelegate = self
        web = w
        view = w
        if let dir = WebFiles.directory() {
            webRoot = dir.resolvingSymlinksInPath()
            w.loadFileURL(dir.appendingPathComponent("mini/mini.html"), allowingReadAccessTo: dir)
        }
    }

    /// Same info dictionary the UI sends for Control Center (title, artist, album, playing, liked, volume, theme…).
    func apply(_ info: [String: Any]) {
        _ = view
        self.info = info
        infoAt = Date()
        push()
    }

    /// Draw again with what we have (MP3 mode switched on or off).
    func redraw() {
        _ = view
        push()
    }

    func setArt(_ image: NSImage?) {
        _ = view
        artData = image.flatMap(MiniPlayerController.dataURL) ?? ""
        push()
    }

    /// Lets the page pause its animations while the panel is closed.
    func setVisible(_ on: Bool) {
        guard ready else { return }
        web.evaluateJavaScript("window.mini && mini.setVisible(\(on))", completionHandler: nil)
        if on { push() }
    }

    private func push() {
        guard ready else { return }
        var payload: [String: Any] = [:]
        for key in ["title", "artist", "album", "playing", "liked", "volume", "duration", "position", "theme"] {
            if let v = info[key], !(v is NSNull) { payload[key] = v }
        }
        // The page may get this again much later (the cover arriving, the panel opening, a look change),
        // so move the position on by the time that has passed while playing.
        if let pos = (info["position"] as? NSNumber)?.doubleValue {
            var now = pos + ((info["playing"] as? Bool) == true ? Date().timeIntervalSince(infoAt) * 1000 : 0)
            if let dur = (info["duration"] as? NSNumber)?.doubleValue, dur > 0 { now = min(now, dur) }
            payload["position"] = now
        }
        payload["art"] = artData
        payload["style"] = Settings.shared.miniStyle
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.mini && mini.apply(\(json))", completionHandler: nil)
    }

    /// The cover as a JPEG data URL, so the page never has to load anything from the internet.
    private static func dataURL(_ image: NSImage) -> String? {
        let side = 480
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0, bitsPerPixel: 0),
              let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        ctx.imageInterpolation = .high
        let s = min(image.size.width, image.size.height)
        let src = NSRect(x: (image.size.width - s) / 2, y: (image.size.height - s) / 2, width: s, height: s)
        image.draw(in: NSRect(x: 0, y: 0, width: side, height: side), from: src, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else { return nil }
        return "data:image/jpeg;base64," + jpeg.base64EncodedString()
    }

    // MARK: - Page → native

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "file",
              let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        switch cmd {
        case "toggle", "next", "previous", "like", "show":
            onAction?(cmd, nil)
        case "volume":
            if let v = body["value"] as? NSNumber { onAction?("volume", max(0, min(100, v.intValue))) }
        case "size":
            guard let s = body["value"] as? [String: Any],
                  let w = (s["w"] as? NSNumber)?.doubleValue, let h = (s["h"] as? NSNumber)?.doubleValue else { return }
            let size = NSSize(width: max(160, min(w, 520)), height: max(160, min(h, 760)))
            preferredSize = size
            onResize?(size)
        default:
            break
        }
    }

    // MARK: - Loading

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        ready = true
        push()
    }

    // Like the main window: only Cadenza's own files, nothing from the web.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, url.isFileURL, let root = webRoot {
            let path = url.resolvingSymlinksInPath().path
            if path.hasPrefix(root.path + "/") { return decisionHandler(.allow) }
        }
        decisionHandler(.cancel)
    }
}
