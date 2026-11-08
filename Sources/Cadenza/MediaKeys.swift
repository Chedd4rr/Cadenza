import AppKit
import ApplicationServices
import MediaPlayer

/// Media keys (F7/F8/F9, Touch Bar), Control Center "Now Playing", and AirPods controls.
///
/// Two paths:
///  * MPRemoteCommandCenter + MPNowPlayingInfoCenter: shows the track in Control Center
///    and receives commands macOS routes to us.
///  * A keyboard event tap (needs Accessibility permission) that catches the media keys
///    directly, so they always reach this app and never launch Apple Music.
final class MediaKeys {
    let api: SpotifyAPI
    var onAction: (() -> Void)?
    var isLoggedIn: () -> Bool = { false }
    /// Instant local response (pause/resume/skip the sound right away) when Cadenza's engine is playing.
    var local: ((String) -> Void)?
    /// What Cadenza's own audio engine knows: nil when it isn't the device playing.
    var localPlaying: () -> Bool? = { nil }

    fileprivate static weak var shared: MediaKeys?
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var retryTimer: Timer?
    private var artworkURL: String?
    private var artwork: MPMediaItemArtwork?
    private var lastInfo: [String: Any] = [:]

    init(api: SpotifyAPI) {
        self.api = api
        MediaKeys.shared = self
    }

    // MARK: - Actions

    func playPause() {
        // If this Mac is playing, we already know the state: no need to ask Spotify first (saves a round trip).
        if let playing = localPlaying() {
            local?(playing ? "pause" : "play")
            return send("PUT", playing ? "/me/player/pause" : "/me/player/play")
        }
        api.request("GET", "/me/player") { [weak self] _, json in
            let playing = ((json as? [String: Any])?["is_playing"] as? Bool) ?? false
            self?.send("PUT", playing ? "/me/player/pause" : "/me/player/play")
        }
    }
    func next() { local?("skip"); send("POST", "/me/player/next") }
    func previous() { local?("skip"); send("POST", "/me/player/previous") }

    private func send(_ method: String, _ path: String) {
        api.request(method, path) { [weak self] _, _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self?.onAction?() }
        }
    }

    // MARK: - Now Playing / remote commands

    func setupRemoteCommands() {
        let c = MPRemoteCommandCenter.shared()
        c.togglePlayPauseCommand.addTarget { [weak self] _ in self?.playPause(); return .success }
        c.playCommand.addTarget { [weak self] _ in self?.local?("play"); self?.send("PUT", "/me/player/play"); return .success }
        c.pauseCommand.addTarget { [weak self] _ in self?.local?("pause"); self?.send("PUT", "/me/player/pause"); return .success }
        c.nextTrackCommand.addTarget { [weak self] _ in self?.next(); return .success }
        c.previousTrackCommand.addTarget { [weak self] _ in self?.previous(); return .success }
        c.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.send("PUT", "/me/player/seek?position_ms=\(Int(e.positionTime * 1000))")
            return .success
        }
    }

    /// Called by the UI whenever the track or play state changes.
    func updateNowPlaying(_ info: [String: Any]) {
        let center = MPNowPlayingInfoCenter.default()
        guard let title = info["title"] as? String, !title.isEmpty else {
            center.nowPlayingInfo = nil
            center.playbackState = .stopped
            return
        }
        let playing = (info["playing"] as? Bool) ?? false
        var np: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: (info["artist"] as? String) ?? "",
            MPMediaItemPropertyAlbumTitle: (info["album"] as? String) ?? "",
            MPMediaItemPropertyPlaybackDuration: ((info["duration"] as? Double) ?? 0) / 1000,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: ((info["position"] as? Double) ?? 0) / 1000,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
        ]
        let art = info["art"] as? String
        if let artwork, art == artworkURL { np[MPMediaItemPropertyArtwork] = artwork }
        center.nowPlayingInfo = np
        center.playbackState = playing ? .playing : .paused
        lastInfo = np

        if let art, art != artworkURL, !art.isEmpty {
            artworkURL = art
            artwork = nil
            CoverArt.image(art) { [weak self] image in
                guard let self, let image, self.artworkURL == art else { return }
                let item = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                self.artwork = item
                var current = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? self.lastInfo
                current[MPMediaItemPropertyArtwork] = item
                MPNowPlayingInfoCenter.default().nowPlayingInfo = current
            }
        }
    }

    // MARK: - Event tap

    var accessibilityTrusted: Bool { AXIsProcessTrusted() }

    func enableTap() {
        guard tap == nil else { return }
        if !AXIsProcessTrusted() {
            let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
            // Keep checking until the user flips the switch in System Settings.
            retryTimer?.invalidate()
            retryTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] t in
                if AXIsProcessTrusted() { t.invalidate(); self?.retryTimer = nil; self?.enableTap() }
            }
            return
        }
        let mask = CGEventMask(1 << 14)   // NX_SYSDEFINED: media keys arrive as system-defined events
        guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                        options: .defaultTap, eventsOfInterest: mask,
                                        callback: mediaKeyTapCallback, userInfo: nil) else {
            NSLog("Cadenza: couldn't create media key tap")
            return
        }
        tap = t
        let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, t, 0)
        source = src
        CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
        CGEvent.tapEnable(tap: t, enable: true)
    }

    func disableTap() {
        retryTimer?.invalidate()
        retryTimer = nil
        if let t = tap { CGEvent.tapEnable(tap: t, enable: false) }
        if let s = source { CFRunLoopRemoveSource(CFRunLoopGetMain(), s, .commonModes) }
        tap = nil
        source = nil
    }

    fileprivate func reenableTap() {
        if let t = tap { CGEvent.tapEnable(tap: t, enable: true) }
    }

    /// Returns true when the key was ours (and should be swallowed).
    fileprivate func handleKey(code: Int, down: Bool, isRepeat: Bool) -> Bool {
        let play = 16, next = 17, previous = 18, fast = 19, rewind = 20
        guard [play, next, previous, fast, rewind].contains(code), isLoggedIn() else { return false }
        if down && !isRepeat {
            switch code {
            case play: playPause()
            case next, fast: self.next()
            default: self.previous()
            }
        }
        return true
    }
}

private func mediaKeyTapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent,
                                 refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        MediaKeys.shared?.reenableTap()
        return Unmanaged.passUnretained(event)
    }
    guard type.rawValue == 14, let ns = NSEvent(cgEvent: event), ns.subtype.rawValue == 8 else {
        return Unmanaged.passUnretained(event)
    }
    let data1 = ns.data1
    let code = (data1 & 0xFFFF0000) >> 16
    let flags = data1 & 0x0000FFFF
    let down = ((flags & 0xFF00) >> 8) == 0xA
    let isRepeat = (flags & 0x1) == 1
    if MediaKeys.shared?.handleKey(code: code, down: down, isRepeat: isRepeat) == true { return nil }
    return Unmanaged.passUnretained(event)
}
