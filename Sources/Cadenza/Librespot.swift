import AppKit
import Foundation
import Network

/// Runs librespot (the Spotify Connect audio engine) as a child process.
/// When the Mac's audio output changes, librespot is restarted on the new output
/// and playback is handed back to it at the same position.
final class Librespot {
    let api: SpotifyAPI
    var onStatus: (([String: Any]) -> Void)?
    /// Cadenza's EQ engine. When it's on, librespot sends its audio to Cadenza instead of the speakers.
    var audio: AudioPipe?
    var usesEQEngine: Bool { audio != nil && UserDefaults.standard.object(forKey: "eqEngine") as? Bool ?? true }
    private var piping = false
    /// What librespot itself is playing (from its --onevent hook), so Cadenza doesn't have to ask Spotify.
    var onPlayer: (([String: Any]) -> Void)?
    /// librespot started a different song (used to finish an instant skip cleanly).
    var onTrackChange: (() -> Void)?
    /// librespot started or stopped playing (e.g. from your phone), so Cadenza's engine can follow.
    var onPlaying: ((Bool) -> Void)?
    /// After a dropped Spotify connection: librespot has been restarted, and the page should pick the
    /// music back up ({uri, position_ms, duration_ms}). The page knows the playlist, DJ set or radio.
    var onResume: (([String: Any]) -> Void)?
    /// A song failed only because Spotify didn't send its key in time: play it again ({uri, position_ms: 0}).
    var onRetry: (([String: Any]) -> Void)?
    /// Cadenza's own listening log (Stats page). Fed with every change in what's playing.
    var history: History?
    /// True when this Mac (Cadenza's librespot) is the device Spotify is playing on.
    var activeHere: Bool { process != nil && piping && ((player["active"] as? Bool) ?? false) }
    var playingHere: Bool { (player["is_playing"] as? Bool) ?? false }
    private var eventsSource: DispatchSourceFileSystemObject?
    private var player: [String: Any] = [:]
    /// When `player["progress_ms"]` was last true. Other events (volume, loading…) mustn't restamp it,
    /// or the position Cadenza shows jumps back to where the last play/seek event left it.
    private var posAt: Double = 0
    private var eventsTimer: Timer?
    private var eventsOffset: UInt64 = 0
    private var eventsFile: URL { Settings.supportDir.appendingPathComponent("librespot-events.txt") }
    /// librespot runs its --onevent program by splitting the option on spaces (so it can take
    /// arguments), which breaks on "~/Library/Application Support/…". The script therefore lives in
    /// the per-user temporary folder (no spaces), and is rewritten every time librespot starts.
    private var hookFile: URL {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("cadenza-librespot-event.sh")
        if !tmp.path.contains(where: { $0.isWhitespace }) { return tmp }
        return URL(fileURLWithPath: "/tmp/cadenza-\(getuid())-librespot-event.sh")
    }

    private var process: Process?
    private var openedAuthURL = false
    private var pendingSwitch: DispatchWorkItem?
    private(set) var state = "stopped"   // stopped | starting | login | running | missing | error
    private var logLines: [String] = []

    init(api: SpotifyAPI) {
        self.api = api
        // After the Mac wakes, or the network comes back, librespot's link to Spotify is often dead even
        // though librespot is still running, and Spotify stops listing Cadenza as a speaker. Check, and
        // restart librespot if it's missing.
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.scheduleDeviceCheck(after: 8, reason: "the Mac woke up")
        }
        network.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                guard let self else { return }
                let up = path.status == .satisfied
                if up && self.networkWasDown { self.scheduleDeviceCheck(after: 5, reason: "the network came back") }
                self.networkWasDown = !up
            }
        }
        network.start(queue: DispatchQueue(label: "cadenza.network"))
    }
    private let network = NWPathMonitor()
    private var networkWasDown = false

    var cacheDir: URL { Settings.supportDir.appendingPathComponent("librespot", isDirectory: true) }
    var hasCredentials: Bool {
        FileManager.default.fileExists(atPath: cacheDir.appendingPathComponent("credentials.json").path)
    }

    func resolvePath() -> String? {
        let custom = (Settings.shared.librespotPath as NSString).expandingTildeInPath
        // Your own pick first, then the copy inside Cadenza.app, then the usual install places.
        let bundled = Bundle.main.url(forAuxiliaryExecutable: "librespot")?.path
        let candidates = (custom.isEmpty ? [] : [custom]) + (bundled.map { [$0] } ?? []) + [
            "/opt/homebrew/bin/librespot",
            "/usr/local/bin/librespot",
            NSHomeDirectory() + "/.cargo/bin/librespot",
        ]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    func status() -> [String: Any] {
        [
            "state": state,
            "path": resolvePath() ?? "",
            "managed": Settings.shared.manageLibrespot,
            "deviceName": Settings.shared.deviceName,
            "hasCredentials": hasCredentials,
            "log": Array(logLines.suffix(40)),
            "recovering": recovering ?? "",
        ]
    }

    // MARK: - Process control

    func start() {
        guard process == nil else { return }
        guard let path = resolvePath() else {
            appendLog("librespot not found. This copy of Cadenza was built without it inside; install it with: brew install librespot")
            return setState("missing")
        }
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        importSpotifyQtCredentials()
        killStrays()

        var args = [
            "--name", Settings.shared.deviceName,
            "--cache", cacheDir.path,
            "--bitrate", String(Settings.shared.bitrate),
            "--initial-volume", String(Settings.shared.volume),
            // Spotify's default volume curve spans 60 dB, which makes everything below 100% very quiet.
            "--volume-ctrl", "log", "--volume-range", "30",
        ]
        // Even loudness from song to song (Spotify's own loudness info), with a little make-up gain.
        if Settings.shared.normalize { args += ["--enable-volume-normalisation", "--normalisation-pregain", "3"] }
        // Spotify's own autoplay (a station of similar songs when an album or playlist ends), if this
        // librespot is new enough to have the switch. Cadenza's song radio covers the rest.
        if supports("--autoplay", path) { args += ["--autoplay", Settings.shared.autoplay ? "on" : "off"] }
        piping = usesEQEngine
        if piping { args += ["--backend", "pipe"] }
        if !hasCredentials { args.append("--enable-oauth") }
        if prepareEventHook() { args += ["--onevent", hookFile.path] }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        let pipe = Pipe()
        if piping, let audio {
            let sound = Pipe()                 // audio on stdout → Cadenza's EQ engine; messages on stderr
            p.standardOutput = sound
            audio.attach(sound.fileHandleForReading)
        } else {
            p.standardOutput = pipe
        }
        p.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.consume(text) }
        }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                pipe.fileHandleForReading.readabilityHandler = nil
                guard let self, self.process === proc else { return }
                self.process = nil
                let crashed = proc.terminationReason == .uncaughtSignal || proc.terminationStatus != 0
                self.appendLog("librespot exited (\(proc.terminationStatus)\(proc.terminationReason == .uncaughtSignal ? ", signal" : ""))")
                // Cadenza didn't ask it to stop (stop/restart clear `process` first), so it fell over.
                if self.recoverFromCrash() { return }
                self.setState(crashed ? "error" : "stopped")
            }
        }
        do {
            try p.run()
            process = p
            openedAuthURL = false
            appendLog("Started: \(path) \(args.joined(separator: " "))")
            setState(hasCredentials ? "starting" : "login")
        } catch {
            appendLog("Couldn't start librespot: \(error.localizedDescription)")
            setState("error")
        }
    }

    // MARK: - Options this librespot understands

    private var helpText: [String: String] = [:]
    /// Older librespot versions quit on an option they don't know, so check its --help first (once).
    private func supports(_ option: String, _ path: String) -> Bool {
        if helpText[path] == nil {
            let p = Process(), out = Pipe()
            p.executableURL = URL(fileURLWithPath: path)
            p.arguments = ["--help"]
            p.standardOutput = out; p.standardError = out
            var text = ""
            if (try? p.run()) != nil {
                let data = out.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
                text = String(data: data, encoding: .utf8) ?? ""
            }
            helpText[path] = text
        }
        return helpText[path]?.contains(option) ?? false
    }

    // MARK: - Crash recovery

    /// When librespot fell over recently, for spacing out restarts.
    private var crashTimes: [Date] = []
    /// Set while a crash restart is under way, so the page can say what happened.
    private var recovering: String?

    /// librespot quit without being asked to: start it again, and carry on playing if it was.
    /// It quits on its own when it can't reach Spotify (just after waking, on a flaky network), so Cadenza
    /// keeps trying, waiting longer each time (1 s, 3 s, 10 s, 30 s, then once a minute). It only gives
    /// up when librespot's log says the login itself is bad, since restarting won't fix that.
    private func recoverFromCrash() -> Bool {
        guard Settings.shared.manageLibrespot, hasCredentials, resolvePath() != nil else { return false }
        let recent = logLines.suffix(30).joined(separator: "\n")
        if recent.range(of: "bad ?credentials|authentication ?failed|premium account", options: [.regularExpression, .caseInsensitive]) != nil {
            appendLog("librespot can't log in to Spotify. Leaving it stopped: log in again in System → Engine settings.")
            recovering = "gave-up"
            return false
        }
        crashTimes = crashTimes.filter { Date().timeIntervalSince($0) < 600 } + [Date()]
        let delay = [1.0, 3, 10, 30, 60][min(crashTimes.count - 1, 4)]
        let wasPlaying = playingHere && ((player["active"] as? Bool) ?? false)
        player["is_playing"] = false
        emitPlayer()                                                   // so the page doesn't keep showing it as playing
        appendLog("librespot stopped unexpectedly. Restarting it in \(Int(delay)) s\(wasPlaying ? " and picking the music back up" : "")…")
        recovering = "restarting"
        setState("starting")
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.process == nil else { return }
            self.start()
            self.whenRunning(timeout: 15) { running in
                if !running && self.process == nil { return }      // fell over again: the next attempt is already scheduled
                self.recovering = running ? "recovered" : "restarting"
                self.setState(self.state)
                self.recovering = nil
                if running && wasPlaying { self.transferHere(play: true, attempts: 10) }
            }
        }
        return true
    }

    // MARK: - Making sure Spotify can see Cadenza as a speaker

    private var lastDeviceFix = Date.distantPast
    private var deviceCheckWork: DispatchWorkItem?

    func scheduleDeviceCheck(after seconds: Double, reason: String) {
        deviceCheckWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.checkDevice(reason) }
        deviceCheckWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    /// Ask Spotify whether it lists Cadenza as a speaker. If librespot is running but missing from the list,
    /// restart it so it registers again (at most once every 45 s). If librespot isn't running at all, start
    /// it. `done(true)` means Cadenza is (or should now be) listed.
    func checkDevice(_ reason: String, done: ((Bool) -> Void)? = nil) {
        guard Settings.shared.manageLibrespot, hasCredentials, resolvePath() != nil else { done?(false); return }
        guard process != nil else {
            appendLog("librespot isn't running (\(reason)): starting it.")
            start()
            return whenRunning(timeout: 15) { done?($0) }
        }
        guard state == "running" else { return whenRunning(timeout: 15) { done?($0) } }
        api.request("GET", "/me/player/devices") { [weak self] status, json in
            guard let self else { return }
            guard status == 200 else { done?(false); return }           // can't tell right now (offline, rate limited)
            let devices = ((json as? [String: Any])?["devices"] as? [[String: Any]]) ?? []
            if devices.contains(where: { ($0["name"] as? String) == Settings.shared.deviceName }) { done?(true); return }
            guard Date().timeIntervalSince(self.lastDeviceFix) > 45 else { done?(false); return }
            self.lastDeviceFix = Date()
            self.appendLog("Spotify doesn't list \(Settings.shared.deviceName) as a speaker (\(reason)): restarting librespot so it shows up again.")
            self.restart { self.whenRunning(timeout: 15) { done?($0) } }
        }
    }

    // MARK: - Sound watchdog

    private var lastRescue = Date.distantPast

    /// A few seconds after playback starts here, check the sound is really coming through.
    /// If librespot says it's playing but no audio has reached Cadenza's engine, restart it (at most once a minute).
    private func checkSound() {
        guard piping, let audio else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { audio.ensureAudible() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self, self.process != nil, self.playingHere, audio.secondsSinceAudio > 4, !self.refusedRecently,
                  Date().timeIntervalSince(self.lastRescue) > 60 else { return }
            self.lastRescue = Date()
            self.appendLog("Playing, but no sound is reaching Cadenza: restarting the audio engine.")
            self.restartAndResume()
        }
    }

    /// Restart librespot and hand the music back to it, playing, at the same spot.
    private func restartAndResume() {
        // Note the song and spot first: handing playback over the old way made Spotify replay its own
        // saved state (often a lone song with no playlist), which is how the queue used to get lost.
        let spot = positionSnapshot()
        lastDeviceFix = Date()
        restart { [weak self] in
            self?.whenRunning(timeout: 12) { running in
                guard let self, running else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                    if let spot, let onResume = self.onResume { onResume(spot) } else { self.transferHere(play: true, attempts: 10) }
                }
            }
        }
    }

    /// Every 2 s while music plays here: if librespot says it's playing but no sound has reached
    /// Cadenza for 3 s, the sound engine has stalled (an output change or a hiccup can leave it stopped,
    /// and then librespot itself stalls behind it, which sounds like the music just stopping).
    /// First wake the engine; if that doesn't bring sound back within a few seconds, restart
    /// librespot and pick the song back up.
    private var stallSince: Date?
    private var stallStep = 0
    private func watchSound() {
        guard piping, let audio, process != nil, playingHere, (player["active"] as? Bool) ?? false,
              audio.secondsSinceAudio > 3 else { stallSince = nil; stallStep = 0; return }
        // No sound because Spotify won't unlock the songs, not because of the sound engine: restarting
        // the engine can't help, and its requests would make Spotify's refusal last longer.
        if refusedRecently { stallSince = nil; stallStep = 0; return }
        // You just paused. Cadenza stops the sound itself before Spotify confirms, so silence is expected.
        // verifyPause() deals with a pause Spotify never carried out. Waking the engine here is what used
        // to make the music un-pause itself.
        if let at = audio.locallyPausedAt, Date().timeIntervalSince(at) < 12 { stallSince = nil; stallStep = 0; return }
        guard let since = stallSince else {
            stallSince = Date(); stallStep = 1
            appendLog("Playing, but no sound for 3 s: waking the sound engine.")
            audio.ensureAudible()
            return
        }
        let waited = Date().timeIntervalSince(since)
        if stallStep == 1, waited > 3 {
            // Still nothing: the engine is probably attached to an output that's gone (AirPods).
            stallStep = 2
            appendLog("Still no sound: re-attaching the sound engine to the current output.")
            audio.reattach()
        } else if stallStep == 2, waited > 9, Date().timeIntervalSince(lastRescue) > 60 {
            lastRescue = Date(); stallSince = nil; stallStep = 0
            // Only if Spotify agrees it's playing here: if librespot's "paused" report was missed, a
            // restart-and-play would un-pause the music on its own.
            api.request("GET", "/me/player") { [weak self] status, json in
                guard let self else { return }
                let p = json as? [String: Any], dev = p?["device"] as? [String: Any]
                guard status == 200, (p?["is_playing"] as? Bool) == true,
                      (dev?["name"] as? String) == Settings.shared.deviceName else {
                    self.appendLog("No sound, but Spotify says it isn't playing here: leaving it paused.")
                    self.player["is_playing"] = false; self.emitPlayer()
                    return
                }
                self.appendLog("Still no sound: restarting the audio engine and picking the song back up.")
                self.restartAndResume()
            }
        }
    }

    /// librespot copies left behind by a crashed or force-quit Cadenza (they'd hold on to the device name
    /// and swallow the music). Ours are recognised by their cache folder in Application Support.
    private func killStrays() {
        let kill = Process()
        kill.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        // Match Cadenza's own cache folder exactly, so another app's librespot is left alone.
        let escaped = cacheDir.path.map { ".[]()*+?{}|^$\\".contains($0) ? "\\\($0)" : String($0) }.joined()
        kill.arguments = ["-f", "librespot.*--cache " + escaped]
        try? kill.run()
        kill.waitUntilExit()
    }

    // MARK: - Player events (librespot --onevent)

    /// Writes a tiny script librespot runs on every player event; it appends one line per event to a file Cadenza reads.
    private func prepareEventHook() -> Bool {
        // Single-quoted for the shell, so a home folder like /Users/o'brien doesn't break the script.
        let target = "'" + eventsFile.path.replacingOccurrences(of: "'", with: "'\\''") + "'"
        let script = """
        #!/bin/sh
        # Written by Cadenza: passes librespot's player events to the app.
        a=$(printf '%s' "$ARTISTS" | tr '\\n\\t' '||')
        c=$(printf '%s' "$COVERS" | tr '\\n\\t' '||')
        n=$(printf '%s' "$NAME" | tr '\\n\\t' '  ')
        al=$(printf '%s' "$ALBUM" | tr '\\n\\t' '  ')
        printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$PLAYER_EVENT" "$URI" "$TRACK_ID" "$n" "$a" "$al" "$c" "$DURATION_MS" "$POSITION_MS" "$VOLUME" "$SHUFFLE$REPEAT" "$(date +%H:%M:%S)" >> \(target)
        """
        do {
            try script.write(to: hookFile, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: hookFile.path)
            try? FileManager.default.removeItem(at: eventsFile)
            FileManager.default.createFile(atPath: eventsFile.path, contents: nil)
            eventsOffset = 0
            // React the instant librespot writes an event (plus a slow safety timer).
            eventsSource?.cancel()
            let fd = open(eventsFile.path, O_EVTONLY)
            if fd >= 0 {
                let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .extend], queue: .main)
                src.setEventHandler { [weak self] in self?.readEvents() }
                src.setCancelHandler { close(fd) }
                src.resume()
                eventsSource = src
            }
            eventsTimer?.invalidate()
            eventsTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.readEvents(); self?.followTheSound(); self?.watchSound() }
            return true
        } catch {
            appendLog("Couldn't set up player events: \(error.localizedDescription)")
            return false
        }
    }

    private func readEvents() {
        guard let h = try? FileHandle(forReadingFrom: eventsFile) else { return }
        defer { try? h.close() }
        let size = (try? h.seekToEnd()) ?? 0
        if size < eventsOffset { eventsOffset = 0 }
        guard size > eventsOffset else { return }
        try? h.seek(toOffset: eventsOffset)
        let data = h.readDataToEndOfFile()
        eventsOffset += UInt64(data.count)
        guard let text = String(data: data, encoding: .utf8) else { return }
        var changed = false
        for line in text.split(separator: "\n") {
            let f = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            guard f.count >= 11 else { continue }
            let event = f[0], uri = f[1], trackId = f[2]
            let ms = { (s: String) -> Int? in Int(s.trimmingCharacters(in: .whitespaces)) }
            switch event {
            case "track_changed":
                if let failed = pendingRetry {
                    pendingRetry = nil
                    let now = uri.isEmpty ? "spotify:track:" + trackId : uri
                    if now != failed { retryNow(failed) }            // librespot skipped it: go back for it
                }
                let covers = f[6].split(separator: "|").map(String.init)
                // Spotify's 640px album art has this marker in its URL; otherwise take the first cover.
                let art = covers.first(where: { $0.contains("ab67616d0000b273") }) ?? covers.first ?? ""
                player["uri"] = uri.isEmpty ? "spotify:track:" + trackId : uri
                player["name"] = f[3]
                player["artists"] = f[4].split(separator: "|").map(String.init).joined(separator: ", ")
                player["album"] = f[5]
                player["image"] = art
                if let d = ms(f[7]) { player["duration_ms"] = d }
                player["progress_ms"] = 0; posAt = Date().timeIntervalSince1970 * 1000
                // A new song starts at full volume (in case the sleep fade was cut short).
                if let audio, audio.transitionVolume < 0.999, !audio.sleepFading { audio.rampTransition(to: 1, over: 1.6) }
                changed = true
                onTrackChange?()
                audio?.songPosition(nil, duration: ms(f[7]), newSong: true)      // where the crossfade will start
                if (player["is_playing"] as? Bool) == true { releaseIfHeld() }
            case "playing", "paused", "seeked", "position_correction":
                // Bring the old position up to date first, in case this event carries none.
                if let p = player["progress_ms"] as? Int, (player["is_playing"] as? Bool) == true, posAt > 0 {
                    player["progress_ms"] = p + Int(Date().timeIntervalSince1970 * 1000 - posAt)
                }
                posAt = Date().timeIntervalSince1970 * 1000
                player["is_playing"] = event == "playing" ? true : event == "paused" ? false : (player["is_playing"] ?? true)
                if event == "playing" { onPlaying?(true); checkSound() } else if event == "paused" { onPlaying?(false); lastStopAt = Date() }
                if event == "seeked" { audio?.seeked() }                 // the new spot is heard at once
                // Spotify says it's playing but Cadenza's player is still holding the sound (a "playing"
                // report that never came, or came out of order): let it go, or librespot stalls behind it.
                if event != "paused", (player["is_playing"] as? Bool) == true { releaseIfHeld() }
                if let p = ms(f[8]) { player["progress_ms"] = p }
                if !uri.isEmpty { player["uri"] = uri }
                player["active"] = true
                if let p = ms(f[8]) { audio?.songPosition(Double(p), duration: player["duration_ms"] as? Int, newSong: false) }
                changed = true
            case "unavailable":
                // A song librespot couldn't load. Usually it's the *next* song failing to preload while the
                // current one keeps playing, and librespot skips it by itself either way. Treating this as
                // a stop made Cadenza show the song as stopped while it carried on to the end.
                appendLog("librespot couldn't load a song (\(trackId)); it skips it by itself.")
                retryLater(uri.isEmpty ? "spotify:track:" + trackId : uri)
            case "session_disconnected":
                // librespot's Spotify session dropped, or another device took over. The music may still be
                // coming through Cadenza, so the play state is left to librespot's own "paused"/"stopped".
                let wasActive = (player["active"] as? Bool) ?? false
                player["active"] = false
                changed = true
                sessionDropped("librespot reported the session dropped", wasActive: wasActive)
            case "stopped":
                if let p = player["progress_ms"] as? Int, (player["is_playing"] as? Bool) == true, posAt > 0 {
                    player["progress_ms"] = p + Int(Date().timeIntervalSince1970 * 1000 - posAt)
                }
                posAt = Date().timeIntervalSince1970 * 1000
                player["active"] = false
                player["is_playing"] = false
                lastStopAt = Date()
                changed = true
            case "session_connected", "started", "loading":
                if event == "session_connected" { deviceCheckWork?.cancel() }   // it reconnected by itself
                player["active"] = true
                changed = true
            case "volume_changed":
                if let v = ms(f[9]) { player["volume"] = Int((Double(v) / 65535 * 100).rounded()) }
                changed = true
            default:
                break
            }
        }
        if changed { emitPlayer() }
    }

    /// Tell the page what's playing, with the position as of right now (it keeps running while playing).
    private func emitPlayer() {
        let now = Date().timeIntervalSince1970 * 1000
        player["device"] = Settings.shared.deviceName
        var out = player
        if let p = player["progress_ms"] as? Int, (player["is_playing"] as? Bool) == true, posAt > 0 {
            let d = (player["duration_ms"] as? Int) ?? Int.max
            out["progress_ms"] = min(d, p + Int(now - posAt))
        }
        out["at"] = now
        onPlayer?(out)
        history?.observe(player)
        scheduleTransition()
    }

    // MARK: - Volume after a sleep fade

    /// The crossfade itself lives in AudioPipe. This only puts the volume back up if an interrupted
    /// sleep-timer fade left it down.
    private func scheduleTransition() {
        guard let audio, !audio.sleepFading, audio.transitionVolume < 0.999 else { return }
        audio.resetTransition()
    }

    // MARK: - Keeping Cadenza's pause and Spotify's in step

    /// Spotify is playing here, but Cadenza's player is holding the sound. librespot can only write as fast
    /// as Cadenza takes the sound, so it would sit stuck and the music would "hang". Unless you paused in
    /// the last few seconds (Spotify's "paused" just hasn't arrived yet), play.
    private func releaseIfHeld() {
        guard piping, let audio, audio.holding else { return }
        if let at = audio.locallyPausedAt, Date().timeIntervalSince(at) < 4 { return }
        appendLog("Spotify is playing but Cadenza's player was still paused: letting the sound through.")
        audio.localResume()
    }

    /// You paused in Cadenza: the sound stopped at once and Spotify was asked to pause. A few seconds later,
    /// check Spotify really did. If it didn't, ask once more; if it still plays, follow Spotify, so
    /// librespot isn't left stuck behind a paused player, which sounds like the music hanging.
    func verifyPause(attempt: Int = 0) {
        guard piping, let audio else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + (attempt == 0 ? 4 : 3)) { [weak self] in
            guard let self, audio.holding, self.playingHere, let at = audio.locallyPausedAt,
                  Date().timeIntervalSince(at) > 3 else { return }        // paused properly, or playing again
            self.api.request("GET", "/me/player") { [weak self] status, json in
                guard let self, audio.holding else { return }
                let p = json as? [String: Any], dev = p?["device"] as? [String: Any]
                let stillPlaying = status == 200 && (p?["is_playing"] as? Bool) == true && (dev?["name"] as? String) == Settings.shared.deviceName
                guard stillPlaying else {
                    // Spotify did pause; its report to librespot just never arrived.
                    if status == 200 || status == 204 { self.player["is_playing"] = false; self.emitPlayer() }
                    return
                }
                if attempt == 0 {
                    self.appendLog("Spotify didn't pause: asking again.")
                    self.api.request("PUT", "/me/player/pause") { _, _ in }
                    self.verifyPause(attempt: 1)
                } else {
                    self.appendLog("Spotify kept playing after being asked to pause: playing here too so nothing gets stuck.")
                    audio.localResume()
                }
            }
        }
    }

    // MARK: - Diagnostics

    /// librespot's version line, the engine log and the latest player events, for "Copy diagnostics".
    func diagnostics() -> [String] {
        var out: [String] = []
        if let path = resolvePath() {
            let p = Process(), pipe = Pipe()
            p.executableURL = URL(fileURLWithPath: path); p.arguments = ["--version"]
            p.standardOutput = pipe; p.standardError = pipe
            if (try? p.run()) != nil {
                let d = pipe.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
                out.append("librespot: " + (String(data: d, encoding: .utf8) ?? "?").trimmingCharacters(in: .whitespacesAndNewlines))
                let source = path == Bundle.main.url(forAuxiliaryExecutable: "librespot")?.path ? "built into Cadenza"
                    : path == (Settings.shared.librespotPath as NSString).expandingTildeInPath ? "your Librespot path setting" : "installed separately"
                out.append("librespot source: " + source)
            }
        } else { out.append("librespot: not found") }
        out.append("engine state: \(state), playing here: \(playingHere), active: \(activeHere), through Cadenza's sound engine: \(piping)")
        out.append("")
        out.append("== engine log ==")
        out.append(contentsOf: logLines.suffix(80))
        out.append("")
        out.append("== latest librespot events (event · position · time) ==")
        if let text = try? String(contentsOf: eventsFile, encoding: .utf8) {
            for line in text.split(separator: "\n").suffix(50) {
                let f = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
                if f.count >= 11 { out.append([f[0], f.count > 8 ? f[8] : "", f.count > 11 ? f[11] : ""].joined(separator: " · ")) }
            }
        }
        return out
    }

    /// When librespot last said it paused or stopped.
    private var lastStopAt = Date.distantPast
    private var flowingTicks = 0

    /// The sound itself is the best evidence: librespot only sends audio while it's playing. If sound has
    /// kept arriving for a few seconds but librespot's last report said paused/stopped (a report can be
    /// missed or come out of order around a song change), show it as playing instead of leaving Cadenza
    /// thinking the song stopped early.
    private func followTheSound() {
        guard piping, let audio, process != nil else { flowingTicks = 0; return }
        flowingTicks = audio.secondsSinceAudio < 0.3 ? flowingTicks + 1 : 0
        guard flowingTicks >= 2, !playingHere, Date().timeIntervalSince(lastStopAt) > 4 else { return }
        if let p = player["progress_ms"] as? Int, posAt > 0, (player["active"] as? Bool) == true {
            player["progress_ms"] = p                                  // carry on from where it was
        }
        posAt = Date().timeIntervalSince1970 * 1000
        player["is_playing"] = true
        player["active"] = true
        appendLog("Sound is playing although librespot reported a stop: showing it as playing.")
        emitPlayer()
    }

    func stop() {
        let old = process
        process = nil
        old?.terminate()
        setState("stopped")
    }

    func restart(then: (() -> Void)? = nil) {
        let old = process
        process = nil
        old?.terminate()
        setState("starting")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            self?.start()
            then?()
        }
    }

    /// If spotify-qt (another librespot-based player) is signed in, offer to reuse its librespot login so
    /// you don't have to sign in to the audio engine again. Cadenza asks once and remembers the answer.
    private func importSpotifyQtCredentials() {
        guard !hasCredentials else { return }
        let src = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Caches/kraxarn/spotify-qt/librespot/credentials.json")
        let asked = "spotifyQtImportAsked"
        guard FileManager.default.fileExists(atPath: src.path), !UserDefaults.standard.bool(forKey: asked) else { return }
        UserDefaults.standard.set(true, forKey: asked)
        let alert = NSAlert()
        alert.messageText = "Use your spotify-qt login?"
        alert.informativeText = "spotify-qt is signed in to Spotify on this Mac. Cadenza can copy its audio engine login so you don't have to sign in again in the browser."
        alert.addButton(withTitle: "Copy Login")
        alert.addButton(withTitle: "No Thanks")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        do {
            try FileManager.default.copyItem(at: src, to: cacheDir.appendingPathComponent("credentials.json"))
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: cacheDir.appendingPathComponent("credentials.json").path)
            appendLog("Copied the librespot login from spotify-qt.")
        } catch {
            appendLog("Couldn't copy the spotify-qt login: \(error.localizedDescription)")
        }
    }

    private func consume(_ text: String) {
        for line in text.split(whereSeparator: \.isNewline) { appendLog(String(line)) }
        // First run: librespot prints a Spotify sign-in link. Open it for the user.
        if !openedAuthURL, let r = text.range(of: "https://accounts\\.spotify\\.com/authorize[^\\s\"'<>]*", options: .regularExpression),
           let url = URL(string: String(text[r])) {
            openedAuthURL = true
            NSWorkspace.shared.open(url)
            setState("login")
        }
        if state != "running", text.contains("Authenticated as") || text.contains("Connected to AP") {
            setState("running")
        }
        // librespot saves your login readable by every account on the Mac (and warns about it). Keep it
        // to you, every time it signs in, since it rewrites the file then.
        if text.contains("Authenticated as") || text.contains("credential file") {
            let creds = cacheDir.appendingPathComponent("credentials.json").path
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: creds)
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: cacheDir.path)
        }
        // Skipping went past the last song and librespot had nothing left. Spotify then shows the first
        // song of the list, paused, which looks just like you pausing it. Tell the page so autoplay carries on.
        if text.contains("no more tracks left in queue") { onQueueEnd?() }
        // Spotify closed librespot's connection. librespot only notices about 30 s later, comes back
        // without your playlist, and loses the song it was getting ready. Don't wait for it.
        // Two different key problems. A timeout is a hiccup: worth trying the song again. "audio key error"
        // means Spotify refused to unlock that one song. librespot gives up on it and plays the next one,
        // and the songs after it usually play fine, so there's nothing to restart or wait out.
        if text.contains("audio key response timeout") { lastKeyFailure = Date() }
        // Which song librespot is loading, so a refusal can be pinned on it.
        if let r = text.range(of: "with Spotify URI <spotify:track:[A-Za-z0-9]+>", options: .regularExpression) {
            loadingUri = String(text[r]).replacingOccurrences(of: "with Spotify URI <", with: "").replacingOccurrences(of: ">", with: "")
        }
        // Count a refusal only once librespot has given up on the key ("Unable to load key"). The bundled
        // librespot retries, and logs "error audio key 0 2" for each try even when a later one works.
        if text.contains("Unable to load key") { keyRefused(for: loadingUri) }
        if text.contains("Connection to server closed") || text.contains("Spirc shut down unexpectedly") {
            sessionDropped("Spotify closed the connection", wasActive: (player["active"] as? Bool) ?? false)
        }
    }

    /// Where the engine is right now ({uri, position_ms, duration_ms, at}), for picking up there next time.
    /// nil when nothing is playing (or paused) through this Mac's engine.
    func positionSnapshot() -> [String: Any]? {
        guard process != nil, let uri = player["uri"] as? String, !uri.isEmpty, (player["active"] as? Bool) ?? false else { return nil }
        let now = Date().timeIntervalSince1970 * 1000
        var position = (player["progress_ms"] as? Int) ?? 0
        if playingHere, posAt > 0 { position += Int(now - posAt) }
        let duration = (player["duration_ms"] as? Int) ?? 0
        if duration > 0 { position = min(position, duration) }
        return ["uri": uri, "position_ms": position, "duration_ms": duration, "at": Int(now)]
    }

    // MARK: - A song that failed to load

    private var lastKeyFailure = Date.distantPast

    private var loadingUri = ""
    private var refusals: [String: Date] = [:]          // songs Spotify refused to unlock, and when
    private var lastSongRefusal = Date.distantPast
    /// A song Spotify won't unlock right now: autoplay leaves it out for a while.
    var onSongRefused: ((String) -> Void)?
    /// librespot ran out of songs to play next.
    var onQueueEnd: (() -> Void)?
    /// librespot is busy skipping refused songs: silence is expected, don't restart anything.
    var refusedRecently: Bool { Date().timeIntervalSince(lastSongRefusal) < 15 }

    /// Spotify sometimes refuses to unlock a song for librespot ("error audio key 0 2"). It's a known
    /// librespot problem, and it's per song and temporary: librespot skips that song, the next one
    /// usually plays, and the same song often works again later. So Cadenza logs it and carries on, with no
    /// warning and no backing off. Holding back autoplay after refusals only made things worse.
    private func keyRefused(for uri: String) {
        lastSongRefusal = Date()
        refusals = refusals.filter { Date().timeIntervalSince($0.value) < 600 }
        guard !uri.isEmpty, refusals[uri] == nil else { return }
        refusals[uri] = Date()
        appendLog("Spotify won't unlock \(uri) right now; librespot skips it and the next song plays.")
        onSongRefused?(uri)
    }
    private var retried: [String: Date] = [:]
    private var pendingRetry: String?

    /// librespot skips a song it can't load. If that's only because Spotify was slow to send the song's
    /// decryption key (a hiccup, often just before a dropped connection), try it once more. A song that's
    /// really unavailable fails again and is skipped for good.
    private func retryLater(_ uri: String) {
        guard refusals[uri] == nil, Date().timeIntervalSince(lastKeyFailure) < 20, Date().timeIntervalSince(lastDrop) > 45,
              (player["active"] as? Bool) ?? false else { return }
        if let at = retried[uri], Date().timeIntervalSince(at) < 600 { return }
        retried = retried.filter { Date().timeIntervalSince($0.value) < 600 }
        retried[uri] = Date()
        if (player["uri"] as? String) == uri {
            retryNow(uri)
        } else {
            // Usually it's the next song, failing while it got ready. Let this one finish, then go back for it.
            pendingRetry = uri
            appendLog("Spotify was slow to send that song's key: Cadenza will try it again after this song.")
        }
    }

    private func retryNow(_ uri: String) {
        appendLog("Trying the song that didn't load once more (\(uri)).")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.onRetry?(["uri": uri, "position_ms": 0, "retry": true])
        }
    }

    // MARK: - A dropped Spotify connection

    private var lastDrop = Date.distantPast

    /// Restart librespot straight away and hand the page what was playing and where, so it can start the
    /// same playlist (or DJ set, radio, true shuffle) at the same song and second. A couple of seconds'
    /// gap instead of silence and a lost queue. Not playing here: librespot reconnects by itself, and the
    /// usual check makes sure Spotify still lists Cadenza.
    private func sessionDropped(_ reason: String, wasActive: Bool) {
        guard Settings.shared.manageLibrespot, process != nil else { return }
        guard wasActive, playingHere else {
            scheduleDeviceCheck(after: 20, reason: reason)
            return
        }
        guard Date().timeIntervalSince(lastDrop) > 45 else { return }   // one recovery at a time
        lastDrop = Date()
        lastDeviceFix = Date()            // this restart is the fix: don't let the speaker check restart it again
        deviceCheckWork?.cancel()
        let now = Date().timeIntervalSince1970 * 1000
        var position = (player["progress_ms"] as? Int) ?? 0
        if posAt > 0 { position += Int(now - posAt) }
        let duration = (player["duration_ms"] as? Int) ?? 0
        if duration > 0 { position = min(position, duration) }
        let snapshot: [String: Any] = ["uri": (player["uri"] as? String) ?? "", "position_ms": position, "duration_ms": duration]
        appendLog("Spotify closed the engine's connection (\(reason)): restarting it now and picking up where you were.")
        player["is_playing"] = false                                   // the new librespot says "playing" once it really is
        emitPlayer()
        restart { [weak self] in
            self?.whenRunning(timeout: 15) { running in
                guard let self, running else { return }
                // A moment for Spotify to list the new librespot as a speaker.
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                    if let onResume = self.onResume { onResume(snapshot) } else { self.transferHere(play: true, attempts: 10) }
                    // If nothing is playing a little later (the page wasn't able to), fall back to a plain hand-over.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
                        if !self.playingHere { self.appendLog("Still nothing playing after the restart: handing the music back to Cadenza."); self.transferHere(play: true, attempts: 10) }
                    }
                }
            }
        }
    }

    /// Lets other parts of Cadenza (the sound engine) write to the engine log.
    func note(_ line: String) { appendLog(line) }

    private func appendLog(_ line: String) {
        logLines.append(line)
        if logLines.count > 200 { logLines.removeFirst(logLines.count - 200) }
    }

    private func setState(_ s: String) {
        state = s
        onStatus?(status())
        if recovering == "gave-up" { recovering = nil }   // say it once
    }

    // MARK: - Follow the Mac's audio output

    /// Called when macOS switches output (from our Output menu, Control Center, or AirPods connecting).
    private var lastFollow = Date.distantPast
    func outputChanged() {
        guard Settings.shared.manageLibrespot, process != nil else { return }
        if piping { return }                   // the EQ engine follows the new output by itself
        // Guard against a restart loop (librespot reopening the device can itself look like an output change).
        if Date().timeIntervalSince(lastFollow) < 8 { return }
        lastFollow = Date()
        pendingSwitch?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.followOutput() }
        pendingSwitch = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: work)
    }

    private func followOutput() {
        api.request("GET", "/me/player") { [weak self] status, json in
            guard let self else { return }
            let player = json as? [String: Any]
            let device = player?["device"] as? [String: Any]
            // If Spotify can't be asked right now (blocked/offline), use what librespot itself reported.
            let known = status == 200 || status == 204
            let ours = known ? (device?["name"] as? String) == Settings.shared.deviceName : ((self.player["active"] as? Bool) ?? false)
            // Music is playing somewhere else (phone, another computer): nothing to move.
            if !ours && (status == 200 || !known) { return }
            let wasPlaying = known ? ((player?["is_playing"] as? Bool) ?? false) : ((self.player["is_playing"] as? Bool) ?? false)
            if let v = device?["volume_percent"] as? Int { Settings.shared.volume = v }
            self.appendLog("Audio output changed, restarting librespot on the new output…")
            self.restart {
                guard ours else { return }
                self.whenRunning(timeout: 12) { running in
                    guard running else { return }
                    self.transferHere(play: wasPlaying, attempts: 10)
                }
            }
        }
    }

    private func whenRunning(timeout: Double, _ done: @escaping (Bool) -> Void) {
        if state == "running" { return done(true) }
        if timeout <= 0 { return done(false) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.whenRunning(timeout: timeout - 0.25, done)
        }
    }

    /// Moves Spotify playback to this librespot instance (keeps position).
    func transferHere(play: Bool, attempts: Int) {
        api.request("GET", "/me/player/devices") { [weak self] _, json in
            guard let self else { return }
            let devices = ((json as? [String: Any])?["devices"] as? [[String: Any]]) ?? []
            guard let id = devices.first(where: { ($0["name"] as? String) == Settings.shared.deviceName })?["id"] as? String else {
                if attempts > 0 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.transferHere(play: play, attempts: attempts - 1) }
                }
                return
            }
            self.api.request("PUT", "/me/player", body: ["device_ids": [id], "play": play]) { status, _ in
                if status >= 300 && attempts > 0 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { self.transferHere(play: play, attempts: attempts - 1) }
                }
            }
        }
    }
}
