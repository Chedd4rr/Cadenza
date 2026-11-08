import AppKit

/// The current theme's colours for the small native players (menu bar and floating).
enum MiniTheme {
    static func colors(_ theme: String) -> (bg: NSColor, accent: NSColor, text: NSColor) {
        switch theme {
        case "heist":
            return (NSColor(srgbRed: 0.043, green: 0.043, blue: 0.043, alpha: 1), NSColor(srgbRed: 0.898, green: 0, blue: 0.11, alpha: 1), .white)
        case "neon":
            return (NSColor(srgbRed: 0.02, green: 0.024, blue: 0.031, alpha: 1), NSColor(srgbRed: 0.988, green: 0.933, blue: 0.039, alpha: 1),
                    NSColor(srgbRed: 0.369, green: 0.965, blue: 1, alpha: 1))
        case "min":
            return (NSColor(srgbRed: 0.98, green: 0.98, blue: 0.973, alpha: 1), NSColor(srgbRed: 0.227, green: 0.361, blue: 1, alpha: 1),
                    NSColor(srgbRed: 0.086, green: 0.09, blue: 0.102, alpha: 1))
        case "rogue":
            return (.black, NSColor(srgbRed: 0.824, green: 1, blue: 0.122, alpha: 1), NSColor(srgbRed: 0.902, green: 0.91, blue: 0.875, alpha: 1))
        default:
            return (NSColor(srgbRed: 0.03, green: 0.09, blue: 0.3, alpha: 1), NSColor(srgbRed: 0.247, green: 0.878, blue: 1, alpha: 1),
                    NSColor(srgbRed: 0.957, green: 0.992, blue: 1, alpha: 1))
        }
    }
}

/// A small always-on-top player you can drag anywhere: cover, song, controls and a progress line.
/// Stays above other apps (and full-screen ones), on every Space. Toggle it from ⌘K, the Controls menu
/// or cadenza://mini. It remembers where you left it, and whether it was open.
final class FloatingPlayer: NSObject, NSWindowDelegate {
    var onAction: ((String, Any?) -> Void)?

    private var panel: NSPanel?
    private let art = NSImageView()
    private let titleLabel = NSTextField(labelWithString: "Nothing playing")
    private let artistLabel = NSTextField(labelWithString: "")
    private let prevButton = FirstClickButton()
    private let playButton = FirstClickButton()
    private let nextButton = FirstClickButton()
    private let closeButton = FirstClickButton()
    private let track = NSView()
    private let fill = NSView()
    private var fillWidth: NSLayoutConstraint?
    private var timer: Timer?
    private var artURL: String?
    private var lastInfo: [String: Any] = [:]
    private var lastInfoAt = Date()

    // What's playing, so the progress line can run on its own between updates.
    private var playing = false
    private var position: Double = 0          // ms, as of `stamp`
    private var duration: Double = 0
    private var stamp = Date()

    var isOpen: Bool { panel?.isVisible ?? false }

    func toggle() { isOpen ? close() : open() }

    func open() {
        let p = panel ?? build()
        panel = p
        p.orderFrontRegardless()
        UserDefaults.standard.set(true, forKey: "floatingPlayer")
        artURL = nil
        update(lastInfo, at: lastInfoAt)
        startTimer()
    }

    func close() {
        panel?.orderOut(nil)
        UserDefaults.standard.set(false, forKey: "floatingPlayer")
        timer?.invalidate(); timer = nil
    }

    /// Reopens it at launch if it was open when Cadenza quit.
    func restore() { if UserDefaults.standard.bool(forKey: "floatingPlayer") { open() } }

    /// Same info the page sends for Control Center (title, artist, art, playing, duration, position, theme).
    /// `time` is when the info was true (now, unless it's replaying an older update).
    func update(_ info: [String: Any], at time: Date = Date()) {
        lastInfo = info
        lastInfoAt = time
        playing = (info["playing"] as? Bool) ?? false
        position = (info["position"] as? Double) ?? 0
        duration = (info["duration"] as? Double) ?? 0
        stamp = time
        guard let panel else { return }
        let c = MiniTheme.colors((info["theme"] as? String) ?? "tide")
        panel.contentView?.layer?.backgroundColor = c.bg.cgColor
        panel.contentView?.layer?.borderColor = c.accent.withAlphaComponent(0.55).cgColor
        titleLabel.textColor = c.text
        artistLabel.textColor = c.accent
        [prevButton, playButton, nextButton].forEach { $0.contentTintColor = c.text }
        closeButton.contentTintColor = c.text.withAlphaComponent(0.5)
        track.layer?.backgroundColor = c.text.withAlphaComponent(0.15).cgColor
        fill.layer?.backgroundColor = c.accent.cgColor
        titleLabel.stringValue = (info["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Nothing playing"
        artistLabel.stringValue = (info["artist"] as? String) ?? ""
        playButton.image = FloatingPlayer.symbol(playing ? "pause.fill" : "play.fill", 20)
        let url = info["art"] as? String
        if url != artURL {
            artURL = url
            art.image = nil
            if let url, !url.isEmpty {
                CoverArt.image(url) { [weak self] image in if self?.artURL == url { self?.art.image = image } }
            }
        }
        tick()
    }

    // MARK: - Building it

    private static func symbol(_ name: String, _ size: CGFloat) -> NSImage? {
        NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: size, weight: .bold))
    }

    private func build() -> NSPanel {
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 92),
                        styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: true)
        p.isFloatingPanel = true
        p.level = .floating
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        p.hidesOnDeactivate = false
        p.becomesKeyOnlyIfNeeded = true
        p.isMovableByWindowBackground = true            // drag it anywhere
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.delegate = self

        let root = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 92))
        root.wantsLayer = true
        root.layer?.cornerRadius = 12
        root.layer?.masksToBounds = true
        root.layer?.borderWidth = 1
        p.contentView = root

        art.imageScaling = .scaleProportionallyUpOrDown
        art.wantsLayer = true
        art.layer?.cornerRadius = 6
        art.layer?.masksToBounds = true
        art.layer?.backgroundColor = NSColor(white: 1, alpha: 0.08).cgColor

        for l in [titleLabel, artistLabel] {
            l.lineBreakMode = .byTruncatingTail
            l.maximumNumberOfLines = 1
            l.cell?.truncatesLastVisibleLine = true
        }
        titleLabel.font = NSFont.systemFont(ofSize: 13.5, weight: .heavy)
        artistLabel.font = NSFont.systemFont(ofSize: 11.5, weight: .semibold)

        func setup(_ b: NSButton, _ name: String, _ size: CGFloat, _ action: Selector) {
            b.bezelStyle = .regularSquare
            b.isBordered = false
            b.image = FloatingPlayer.symbol(name, size)
            b.target = self
            b.action = action
        }
        setup(prevButton, "backward.fill", 13, #selector(prev))
        setup(playButton, "play.fill", 20, #selector(togglePlay))
        setup(nextButton, "forward.fill", 13, #selector(next))
        setup(closeButton, "xmark", 9, #selector(closeClicked))

        track.wantsLayer = true
        fill.wantsLayer = true
        track.layer?.cornerRadius = 1.5
        fill.layer?.cornerRadius = 1.5

        let controls = NSStackView(views: [prevButton, playButton, nextButton])
        controls.spacing = 14
        [art, titleLabel, artistLabel, controls, closeButton, track].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview($0)
        }
        fill.translatesAutoresizingMaskIntoConstraints = false
        track.addSubview(fill)
        let fw = fill.widthAnchor.constraint(equalToConstant: 0)
        fillWidth = fw
        NSLayoutConstraint.activate([
            art.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            art.centerYAnchor.constraint(equalTo: root.centerYAnchor, constant: -2),
            art.widthAnchor.constraint(equalToConstant: 64),
            art.heightAnchor.constraint(equalToConstant: 64),
            titleLabel.leadingAnchor.constraint(equalTo: art.trailingAnchor, constant: 12),
            titleLabel.topAnchor.constraint(equalTo: root.topAnchor, constant: 16),
            titleLabel.trailingAnchor.constraint(equalTo: closeButton.leadingAnchor, constant: -6),
            artistLabel.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            artistLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 2),
            artistLabel.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -14),
            controls.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor, constant: -4),
            controls.topAnchor.constraint(equalTo: artistLabel.bottomAnchor, constant: 4),
            closeButton.topAnchor.constraint(equalTo: root.topAnchor, constant: 8),
            closeButton.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -8),
            closeButton.widthAnchor.constraint(equalToConstant: 16),
            closeButton.heightAnchor.constraint(equalToConstant: 16),
            track.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            track.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),
            track.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -7),
            track.heightAnchor.constraint(equalToConstant: 3),
            fill.leadingAnchor.constraint(equalTo: track.leadingAnchor),
            fill.topAnchor.constraint(equalTo: track.topAnchor),
            fill.bottomAnchor.constraint(equalTo: track.bottomAnchor),
            fw,
        ])

        // Double-click the cover to bring Cadenza's window back.
        let dbl = NSClickGestureRecognizer(target: self, action: #selector(showApp))
        dbl.numberOfClicksRequired = 2
        art.addGestureRecognizer(dbl)

        // First time: top-right corner of the screen. After that, wherever you left it.
        if !p.setFrameUsingName("CadenzaFloatingPlayer"), let screen = NSScreen.main?.visibleFrame {
            p.setFrameOrigin(NSPoint(x: screen.maxX - 360 - 20, y: screen.maxY - 92 - 20))
        }
        p.setFrameAutosaveName("CadenzaFloatingPlayer")
        return p
    }

    // MARK: - Progress line

    private func startTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.tick() }
        tick()
    }

    private func tick() {
        guard let fillWidth, isOpen else { return }
        let now = position + (playing ? Date().timeIntervalSince(stamp) * 1000 : 0)
        let fraction = duration > 0 ? max(0, min(1, now / duration)) : 0
        fillWidth.constant = CGFloat(fraction) * track.bounds.width
    }

    func windowDidMove(_ notification: Notification) { panel?.saveFrame(usingName: "CadenzaFloatingPlayer") }

    @objc private func prev() { onAction?("previous", nil) }
    @objc private func next() { onAction?("next", nil) }
    @objc private func togglePlay() { onAction?("toggle", nil) }
    @objc private func showApp() { onAction?("show", nil) }
    @objc private func closeClicked() { close() }
}
