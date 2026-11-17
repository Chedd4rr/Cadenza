import Accelerate
import AppKit
import AudioToolbox
import AVFoundation
import CoreAudio
import Foundation
import ObjCSafe

/// Cadenza's own sound engine: librespot hands its decoded audio to Cadenza (its "pipe" backend),
/// and Cadenza plays it through a 10-band equalizer, a preamp and a peak limiter (so boosting
/// never clips). The output follows the Mac's current sound output on its own.
final class AudioPipe {
    static let freqs: [Float] = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

    private let engine = AVAudioEngine()
    /// Two music players, so the end of one song can overlap the start of the next (the crossfade).
    /// `cur` is the one playing the current song; the reader swaps them at each crossfade (under `lock`).
    private let players = [AVAudioPlayerNode(), AVAudioPlayerNode()]
    private var cur = 0
    private var player: AVAudioPlayerNode { players[cur] }
    private var other: AVAudioPlayerNode { players[1 - cur] }
    /// Both players meet here before the EQ (each player's own volume is the crossfade).
    private let inMix = AVAudioMixerNode()
    private let eq = AVAudioUnitEQ(numberOfBands: 10)
    private let limiter = AVAudioUnitEffect(audioComponentDescription: AudioComponentDescription(
        componentType: kAudioUnitType_Effect, componentSubType: kAudioUnitSubType_PeakLimiter,
        componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0))
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44100, channels: 2, interleaved: false)!
    /// A volume stage just for soft fades on pause/play (separate from skip muting).
    private let fader = AVAudioMixerNode()
    /// A second volume stage just for smooth transitions between songs (and the sleep timer's fade),
    /// so it never fights with the pause/play fades on `fader`.
    private let xfade = AVAudioMixerNode()
    private var xfadeTimer: Timer?
    private var fadeTimer: Timer?
    private var deviceUID = ""
    private(set) var deviceName = ""

    private var lastAudio = Date()
    private var handle: FileHandle?
    private var discardBytes = 0          // old-track audio still in the pipe after a skip
    private var skipTimer: Timer?
    private var idleTimer: Timer?
    private var generation = 0
    private var meterOn = false
    /// The audio thread queues sound while the main thread can stop, restart or re-route the engine.
    /// AVAudioEngine isn't safe to use from two threads at once (doing both at the same moment can freeze
    /// the audio for good), so both sides take this lock around touching the player and engine.
    private let lock = NSLock()

    /// The Mac is asleep (or only just woke up): its sound outputs are going away or not back yet, and the
    /// engine refuses to start on them. Nothing is re-attached or started until it's properly awake.
    private var asleep = false
    private var sleepObservers: [NSObjectProtocol] = []

    /// Runs something the audio engine might refuse. Apple's engine reports a refusal by throwing an
    /// Objective-C exception, which Swift can't catch and which would crash Cadenza (it happens mostly just
    /// after the Mac wakes). Here the exception is caught and logged. Returns false if it was refused.
    @discardableResult
    private func safely(_ what: String, _ body: () -> Void) -> Bool {
        guard let reason = CadenzaCatch(body) else { return true }
        let line = "Sound engine refused to \(what): \(reason)", log = onLog
        if Thread.isMainThread { log?(line) } else { DispatchQueue.main.async { log?(line) } }   // (can be the audio thread)
        return false
    }

    /// Starts the music player node, only if the engine is really running (callers hold `lock`).
    @discardableResult
    private func playPlayer(_ node: AVAudioPlayerNode? = nil) -> Bool {
        guard engine.isRunning, !asleep, !shutDown else { return false }
        let p = node ?? player
        return safely("start playing") { p.play() }
    }

    // MARK: - Crossfade (state shared with the audio thread: only touched under `lock`)

    /// Every audio frame read from librespot so far, kept or dropped: a position in the stream.
    private var streamFrames: Int64 = 0
    /// Where the current song began in the stream, and how long it is (frames). -1 / 0 = not known yet.
    private var trackStart: Int64 = -1
    private var trackLength: Int64 = 0
    private var lastPlanLine = ""
    /// Crossfade length in frames (0 = off), from Settings → Crossfade.
    private var xfFrames: Int64 = 6 * 44100
    /// True while the reader is sending the old song's last seconds ahead of time (to the current player,
    /// without waiting), so the next song can start on the other player while they still play.
    private var inTail = false
    /// Where in the stream the song that's fading out ends.
    private var xfBoundary: Int64 = -1
    /// The last place in the stream where one song ended and the next began, and when that was.
    private var lastBoundary: Int64 = -1
    private var lastBoundaryAt = Date.distantPast
    private var xfTimer: Timer?
    private var tailStartedAt = Date.distantPast
    /// Bumped whenever a crossfade is called off, so a fade that was about to start knows not to.
    private var xfGen = 0
    /// The next song's length, if librespot reported it while the old song's tail was still being read.
    private var nextLength: Int64 = 0

    /// A line for the engine log (System → Copy diagnostics), from any thread.
    private func xlog(_ line: String) {
        let log = onLog
        if Thread.isMainThread { log?("Crossfade: " + line) } else { DispatchQueue.main.async { log?("Crossfade: " + line) } }
    }
    private static func secs(_ frames: Int64) -> String { String(format: "%.1f s", Double(frames) / 44100) }

    static func crossfadeSetting() -> Int { max(0, min(12, (UserDefaults.standard.object(forKey: "crossfade") as? Int) ?? 6)) }

    /// How much to read next, and whether it's part of an old song's tail (read at once, no waiting).
    /// Reads never run past the start of a crossfade or the end of a song, so a song's end always falls
    /// exactly between two buffers. (Called by the audio thread, under `lock`.)
    private func plan() -> (frames: Int, tail: Bool) {
        let xf = xfFrames
        if inTail {                                                  // up to the old song's end, then the next song
            let left = xfBoundary - streamFrames
            return (left > 0 ? Int(min(1024, left)) : 1024, true)
        }
        guard trackStart >= 0, trackLength > 0 else { return (1024, false) }
        let end = trackStart + trackLength
        if streamFrames >= end {
            // This song ended without a crossfade (off, or too short): the next one starts here.
            xlog(xf == 0 ? "off: next song follows straight on." : "song too short to blend (under \(AudioPipe.secs(xf * 3))): next song follows straight on.")
            lastBoundary = end; lastBoundaryAt = Date()
            trackStart = end; trackLength = 0
            return (1024, false)
        }
        if xf > 0 && trackLength > xf * 3 {
            let windowStart = end - xf
            if streamFrames >= windowStart {
                inTail = true; xfBoundary = end; tailStartedAt = Date(); nextLength = 0
                xlog("reading the last \(AudioPipe.secs(end - streamFrames)) of the song ahead, for the blend.")
                return (Int(min(1024, end - streamFrames)), true)
            }
            return (Int(min(1024, windowStart - streamFrames)), false)
        }
        return (Int(min(1024, end - streamFrames)), false)
    }

    /// librespot said where it is in the song (`ms`), how long the song is, or that a new song began.
    /// From that, Cadenza works out where in the stream the song will end, so it knows when to start the
    /// crossfade. (Called on the main thread.)
    func songPosition(_ ms: Double?, duration: Int?, newSong: Bool) {
        var waiting: Int32 = 0
        let got = handle.map { ioctl($0.fileDescriptor, 0x4004667F /* FIONREAD */, &waiting) == 0 } ?? false
        let secs = AudioPipe.crossfadeSetting()
        lock.lock(); defer { lock.unlock() }
        xfFrames = Int64(max(0, min(12, secs))) * 44100
        // How much librespot has written so far (read by Cadenza, plus what's still in the pipe).
        let written = streamFrames + Int64(got ? Int(waiting) / 4 : 0)
        let length = duration.map { Int64(Double($0) * 44.1) } ?? 0
        if newSong {
            if inTail {
                // Reported while the old song's tail is still being read. The reader picks this up when it
                // switches players, so the new song still knows its length (and gets its own crossfade).
                nextLength = length
                return
            }
            if lastBoundary >= 0 && Date().timeIntervalSince(lastBoundaryAt) < 20 { trackStart = lastBoundary }   // it began where the last song ended
            else { trackStart = written }                                           // it starts now (a skip, a fresh start)
            trackLength = length
            reportPlan(written)
            return
        }
        if inTail { return }                                         // (the new song's own report sets things up)
        if length > 0 { trackLength = length }
        guard let ms else { return }
        // Right after a crossfade the reader has just raced ahead, so a position from then would be off;
        // the start found from the song boundary is more exact.
        if trackStart == lastBoundary && Date().timeIntervalSince(lastBoundaryAt) < 15 { return }
        trackStart = written - Int64(ms * 44.1)
        reportPlan(written)
    }

    /// Engine-log line: when this song's blend will start (holding `lock`).
    private func reportPlan(_ written: Int64) {
        guard trackStart >= 0 else { return }
        if trackLength <= 0 { return xlog("song length not known yet: no blend planned.") }
        if xfFrames == 0 { return xlog("off.") }
        if trackLength <= xfFrames * 3 { return xlog("song too short to blend.") }
        let left = trackStart + trackLength - written
        let line = "this song ends in \(AudioPipe.secs(left)); the \(AudioPipe.secs(xfFrames)) blend starts \(AudioPipe.secs(max(0, left - xfFrames))) from now."
        // The same plan, worked out again a moment later (a "playing" report right after the song loaded): say it once.
        if line == lastPlanLine { return }
        lastPlanLine = line
        xlog(line)
    }

    /// The next song has started on the other player: fade the old one out and the new one in.
    /// Equal-power curves, so the overall loudness stays even through the blend. (Main thread.)
    private func startCrossfade(from old: AVAudioPlayerNode, to new: AVAudioPlayerNode, seconds: Double, gen: Int) {
        lock.lock(); let current = gen == xfGen; lock.unlock()
        guard current else { new.volume = 1; return }                  // called off (a skip or seek) in the meantime
        xfTimer?.invalidate()
        let begin = Date()
        xfTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] t in
            guard let self else { return t.invalidate() }
            let x = min(1, Date().timeIntervalSince(begin) / max(0.3, seconds))
            old.volume = Float(cos(x * Double.pi / 2))
            new.volume = Float(sin(x * Double.pi / 2))
            if x >= 1 {
                t.invalidate()
                self.lock.lock(); old.stop(); old.volume = 1; self.lock.unlock()   // the old song's last moments, now silent
            }
        }
    }

    /// Stop any crossfade halfway (a skip, a seek, a new output): only the current song carries on.
    /// (Main thread, holding `lock`.)
    private func abortCrossfade() {
        xfTimer?.invalidate(); xfTimer = nil
        xfGen += 1
        inTail = false; xfBoundary = -1
        other.stop()
        player.volume = 1; other.volume = 1
    }
    private var lastMeter = Date.distantPast
    private let d = UserDefaults.standard

    /// Live levels while a screen wants them, ~30 times a second:
    /// "spec" = 48 log-spaced bands (35 Hz to 16 kHz) for the visualizer, "eq" = the 10 EQ bands for the EQ meters.
    var onLevels: (([String: Any]) -> Void)?
    var onLog: ((String) -> Void)?

    init() {
        d.register(defaults: ["eqEnabled": true, "eqPreamp": 0.0, "eqGains": Array(repeating: 0.0, count: 10), "eqPreset": "Flat"])
        for (i, band) in eq.bands.enumerated() {
            band.frequency = AudioPipe.freqs[i]
            let type: AVAudioUnitEQFilterType
            if i == 0 { type = .lowShelf } else if i == 9 { type = .highShelf } else { type = .parametric }
            band.filterType = type
            band.bandwidth = 1.0
            band.bypass = false
        }
        players.forEach { engine.attach($0) }
        engine.attach(inMix)
        engine.attach(eq)
        engine.attach(limiter)
        engine.attach(fader)
        engine.attach(xfade)
        for (i, p) in players.enumerated() { engine.connect(p, to: inMix, fromBus: 0, toBus: AVAudioNodeBus(i), format: format) }
        engine.connect(inMix, to: eq, format: format)
        engine.connect(eq, to: limiter, format: format)
        engine.connect(limiter, to: fader, format: format)
        engine.connect(fader, to: xfade, format: format)
        engine.connect(xfade, to: engine.mainMixerNode, format: format)

        applySettings()
        // Paused for a while: put the audio engine to sleep (it wakes the moment music arrives again).
        idleTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.sleepIfIdle() }
        // The Mac switched speakers/headphones: the engine stops itself; start it on the new output.
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            guard let self, !self.asleep, Date().timeIntervalSince(self.lastRebind) > 1.5 else { return }   // asleep, or our own move
            // macOS also sends this for small things, like a format tweak on the same device. The engine
            // only needs moving if it stopped; if it's still running, just make sure it's playing.
            if self.engine.isRunning { self.ensureAudible() } else { self.outputMoved(force: true) }
        }
        let ws = NSWorkspace.shared.notificationCenter
        sleepObservers = [
            ws.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in self?.willSleep() },
            ws.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in self?.didWake() },
        ]
    }

    // MARK: - Sleep and wake

    /// The lid is closing: stop the engine cleanly before macOS takes the output away.
    private func willSleep() {
        asleep = true
        rebindWork?.cancel(); pendingForce = false
        lock.lock()
        if engine.isRunning && !shutDown { players.forEach { $0.pause() }; engine.pause() }
        lock.unlock()
        onLog?("Mac going to sleep: sound engine paused.")
    }

    /// Awake again. The sound outputs (AirPods especially) take a few seconds to come back, and starting
    /// on them too early is what crashed Cadenza. Wait, then attach to whatever the output is now.
    private func didWake() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self, self.asleep, !self.shutDown else { return }
            self.asleep = false
            self.onLog?("Mac awake: reconnecting the sound engine.")
            if self.handle != nil { self.rebind(force: true, attempt: 0) }
        }
    }

    // MARK: - Following the Mac's sound output

    private var rebindWork: DispatchWorkItem?
    private var lastRebind = Date.distantPast

    /// The Mac's sound output changed (AirPods connecting, dropping out for a moment and coming back,
    /// speakers, a display…). Move the engine onto the current output. Changes that come in a burst
    /// (AirPods often switch twice in a second) are handled once, after they settle.
    /// `force`: the Mac really switched output (or the engine fell over), so re-attach even if it looks
    /// like the same device. AirPods that drop out and reconnect within a second often come back with the
    /// same device number, but the engine's old connection to them is dead: skipping the move there is
    /// what left the song silent while the click sounds played.
    func outputMoved(force: Bool = false) {
        guard !asleep else { return }                              // handled when the Mac wakes
        pendingForce = pendingForce || force
        rebindWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let f = self.pendingForce; self.pendingForce = false
            self.rebind(force: f, attempt: 0)
        }
        rebindWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
    }
    private var pendingForce = false

    /// Re-attach to the current default output, but only when it really is a different device.
    /// macOS also reports "changes" that aren't (a format renegotiation, the engine's own restart);
    /// tearing the engine down for those made the sound cut in and out. For those it just makes sure
    /// the engine and player are running again.
    private var boundDevice: AudioDeviceID = 0
    private func rebind(force: Bool, attempt: Int) {
        guard handle != nil, !asleep, !shutDown else { return }    // not in use yet, asleep, or quitting
        let target = AudioPipe.defaultOutputID() ?? 0
        if target == 0 || (!force && target == boundDevice) {
            if !engine.isRunning { startEngine() }
            ensureAudible()
            return
        }
        lastRebind = Date()
        boundDevice = target
        lock.lock()
        abortCrossfade()
        player.stop()                                              // drops what's queued, which also frees the audio thread
        engine.stop()
        if var id = Optional(target), let unit = engine.outputNode.audioUnit {
            AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                                 &id, UInt32(MemoryLayout<AudioDeviceID>.size))
        }
        // The new output's own format. An output that's still waking up reports none (0 Hz, 0 channels);
        // connecting to that throws, so leave it for the retry below.
        let hw = engine.outputNode.outputFormat(forBus: 0)
        if hw.sampleRate > 0 && hw.channelCount > 0 {
            safely("connect to the new output") { engine.connect(engine.mainMixerNode, to: engine.outputNode, format: nil) }
        }
        lock.unlock()
        startEngine()
        if engine.isRunning {
            ensureAudible()
            onLog?("Sound output changed: the sound engine moved to it.")
        } else if attempt < 5 {
            // Freshly connected AirPods often refuse to start for a moment. Try again after 0.5, 1, 2,
            // 3 and 4 s; giving up here would leave the sound off until Cadenza restarts.
            let delay = [0.5, 1, 2, 3, 4][attempt]
            onLog?("The new sound output isn't ready yet; trying again in \(delay) s.")
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.rebind(force: true, attempt: attempt + 1) }
        } else {
            onLog?("The sound engine couldn't start on the new output. Try switching output in System → Devices.")
        }
    }

    /// For the stall watchdog: re-attach to the current output right away.
    func reattach() { pendingForce = false; rebindWork?.cancel(); rebind(force: true, attempt: 0) }

    private static func defaultOutputID() -> AudioDeviceID? {
        var id = AudioDeviceID(0), size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                                              mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        let err = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
        return err == noErr && id != 0 ? id : nil
    }

    // MARK: - Settings

    var enabled: Bool { d.bool(forKey: "eqEnabled") }
    var preamp: Double { d.double(forKey: "eqPreamp") }
    var gains: [Double] {
        let g = (d.array(forKey: "eqGains") as? [Double]) ?? []
        return g.count == 10 ? g : Array(repeating: 0, count: 10)
    }

    func state() -> [String: Any] {
        ["enabled": enabled, "preamp": preamp, "gains": gains, "preset": d.string(forKey: "eqPreset") ?? "Flat",
         "freqs": AudioPipe.freqs.map { Double($0) }, "running": engine.isRunning,
         "device": deviceName, "perDevice": perDevice]
    }

    // MARK: - EQ per output device (AirPods, speakers, …)

    var perDevice: Bool { d.object(forKey: "eqPerDevice") as? Bool ?? true }

    private func currentProfile() -> [String: Any] {
        ["enabled": enabled, "preamp": preamp, "gains": gains, "preset": d.string(forKey: "eqPreset") ?? "Flat"]
    }

    /// The Mac's sound output changed. Loads that device's EQ (the first time, it starts from the current one).
    /// Returns true when a different profile was loaded.
    @discardableResult
    func useDevice(uid: String, name: String) -> Bool {
        guard !uid.isEmpty, uid != deviceUID else { return false }
        deviceUID = uid
        deviceName = name
        guard perDevice else { return false }
        var profiles = d.dictionary(forKey: "eqProfiles") ?? [:]
        guard let p = profiles[uid] as? [String: Any] else {
            profiles[uid] = currentProfile()
            d.set(profiles, forKey: "eqProfiles")
            return false
        }
        if let v = p["enabled"] as? Bool { d.set(v, forKey: "eqEnabled") }
        if let v = p["preamp"] as? Double { d.set(v, forKey: "eqPreamp") }
        if let v = p["gains"] as? [Double], v.count == 10 { d.set(v, forKey: "eqGains") }
        if let v = p["preset"] as? String { d.set(v, forKey: "eqPreset") }
        applySettings()
        return true
    }

    func update(_ args: [String: Any]) {
        if let v = args["enabled"] as? Bool { d.set(v, forKey: "eqEnabled") }
        if let v = args["preamp"] as? Double { d.set(max(-12, min(12, v)), forKey: "eqPreamp") }
        if let v = args["gains"] as? [Double], v.count == 10 { d.set(v.map { max(-12, min(12, $0)) }, forKey: "eqGains") }
        if let v = args["preset"] as? String { d.set(v, forKey: "eqPreset") }
        if let v = args["perDevice"] as? Bool { d.set(v, forKey: "eqPerDevice") }
        applySettings()
        if perDevice, !deviceUID.isEmpty {                    // remember these settings for this device
            var profiles = d.dictionary(forKey: "eqProfiles") ?? [:]
            profiles[deviceUID] = currentProfile()
            d.set(profiles, forKey: "eqProfiles")
        }
    }

    private func applySettings() {
        let g = gains, on = enabled
        for (i, band) in eq.bands.enumerated() { band.gain = Float(g[i]); band.bypass = !on }
        eq.globalGain = on ? Float(preamp) : 0
    }

    // MARK: - Audio

    private func startEngine() {
        lock.lock(); defer { lock.unlock() }
        if engine.isRunning || shutDown || asleep { return }
        fader.outputVolume = 1
        do {
            guard safely("get ready", { engine.prepare() }) else { return }
            try engine.start()
            // start() can return while the output isn't really there yet (just after waking). Then playing
            // is refused: stop again, so the engine reads as "not running" and the caller tries later.
            if !playPlayer() { engine.stop(); return }
            if boundDevice == 0 { boundDevice = AudioPipe.defaultOutputID() ?? 0 }
        } catch {
            onLog?("EQ engine couldn't start: \(error.localizedDescription)")
        }
    }

    /// Start reading a new librespot process's audio (raw 16-bit stereo at 44.1 kHz).
    func attach(_ handle: FileHandle) {
        generation += 1
        let gen = generation
        self.handle = handle
        lock.lock()
        streamFrames = 0; trackStart = -1; trackLength = 0; lastBoundary = -1; inTail = false
        lock.unlock()
        startEngine()
        let slots = DispatchSemaphore(value: 4)            // 4 × 1024 frames ≈ 93 ms queued: keeps pause/skip snappy
        let thread = Thread { [weak self] in
            let frames = 1024, bytes = frames * 4
            var pending = Data()
            while let self, self.generation == gen {
                self.lock.lock()
                let (want, tail) = self.plan()
                self.lock.unlock()
                // Normally wait for room (4 buffers queued); an old song's tail is read straight away instead,
                // so the next song can start playing alongside it.
                if !tail { slots.wait() }
                let counted = !tail
                let need = max(1, min(frames, want)) * 4
                while pending.count < need {
                    guard let chunk = try? handle.read(upToCount: need - pending.count), !chunk.isEmpty else { pending = Data(); break }
                    pending.append(chunk)
                }
                if pending.isEmpty { if counted { slots.signal() }; break }      // librespot stopped
                self.lock.lock()
                let at = self.streamFrames
                self.streamFrames += Int64(pending.count / 4)
                let discarding = self.discardBytes > 0             // the end of the previous song (or spot): drop it
                if discarding { self.discardBytes -= pending.count }
                self.lock.unlock()
                if discarding { pending = Data(); if counted { slots.signal() }; continue }
                let n = pending.count / 4
                guard n > 0, let buf = AVAudioPCMBuffer(pcmFormat: self.format, frameCapacity: AVAudioFrameCount(n)),
                      let ch = buf.floatChannelData else { pending = Data(); if counted { slots.signal() }; continue }
                buf.frameLength = AVAudioFrameCount(n)
                let l = ch[0], r = ch[1]
                // 16-bit interleaved → two float channels, with Accelerate (vector instructions)
                pending.withUnsafeBytes { raw in
                    guard let base = raw.bindMemory(to: Int16.self).baseAddress else { return }
                    vDSP_vflt16(base, 2, l, 1, vDSP_Length(n))
                    vDSP_vflt16(base + 1, 2, r, 1, vDSP_Length(n))
                }
                var scale: Float = 1.0 / 32768
                vDSP_vsmul(l, 1, &scale, l, 1, vDSP_Length(n))
                vDSP_vsmul(r, 1, &scale, r, 1, vDSP_Length(n))
                pending = Data()
                self.lastAudio = Date()
                // Never wait on the main thread from here: if it's busy (or itself waiting on the engine),
                // the music would freeze. Wake the engine from there and carry on.
                if !self.engine.isRunning { DispatchQueue.main.async { self.startEngine() } }
                self.lock.lock()
                if self.shutDown { self.lock.unlock(); break }     // Cadenza is quitting
                if self.inTail && at >= self.xfBoundary {
                    // The next song begins: it goes to the other player, which fades in while the old song's
                    // tail (already queued on this one) fades out.
                    let old = self.player, wasPlaying = old.isPlaying
                    self.lastBoundary = self.xfBoundary; self.lastBoundaryAt = Date()
                    self.trackStart = self.xfBoundary
                    self.trackLength = self.nextLength                           // 0 until librespot reports it
                    self.nextLength = 0
                    self.inTail = false
                    self.cur = 1 - self.cur
                    let new = self.player
                    let secs = Double(self.xfFrames) / 44100
                    // Only blend if the old song is still playing out. If the next song came much later (the
                    // queue had run out and something new was started), it just begins, no slow fade-in.
                    let took = Date().timeIntervalSince(self.tailStartedAt)
                    let blend = took < secs + 2
                    self.xlog(blend ? String(format: "next song started; blending over %.0f s (tail read in %.2f s).", secs, took)
                                    : String(format: "next song came %.1f s after the old one ended: starting it normally.", took))
                    new.volume = blend ? 0 : 1
                    new.scheduleBuffer(buf) { if counted { slots.signal() } }
                    if wasPlaying { self.playPlayer(new) }
                    let g = self.xfGen
                    if blend { DispatchQueue.main.async { self.startCrossfade(from: old, to: new, seconds: secs, gen: g) } }
                    else { old.stop(); old.volume = 1 }
                } else {
                    self.player.scheduleBuffer(buf) { if counted { slots.signal() } }
                }
                self.lock.unlock()
            }
        }
        thread.name = "Cadenza audio"
        thread.qualityOfService = .userInteractive
        thread.start()
    }

    // MARK: - Quitting

    private var shutDown = false
    private var configObserver: NSObjectProtocol?
    /// Cadenza is quitting: stop everything that runs on its own threads (the reader, the visualizer's tap,
    /// the engine's audio thread) before macOS tears the app down. Left running, they can touch the audio
    /// engine while it's being destroyed and crash Cadenza on the way out.
    func shutdown() {
        guard !shutDown else { return }
        idleTimer?.invalidate(); fadeTimer?.invalidate(); xfadeTimer?.invalidate(); skipTimer?.invalidate()
        rebindWork?.cancel()
        if let o = configObserver { NotificationCenter.default.removeObserver(o); configObserver = nil }
        sleepObservers.forEach { NSWorkspace.shared.notificationCenter.removeObserver($0) }; sleepObservers = []
        onLevels = nil; onLog = nil
        lock.lock()
        shutDown = true
        generation += 1                                   // the reader thread stops at its next turn
        if meterOn { limiter.removeTap(onBus: 0); meterOn = false }
        xfTimer?.invalidate()
        players.forEach { $0.stop() }                     // also wakes the reader so it can see it's over
        engine.stop()
        lock.unlock()
    }

    // MARK: - Instant transport (pause, resume and skip respond immediately, before Spotify confirms)

    /// Stops the sound right away with a very short fade (no click). The queued audio stays queued,
    /// so resuming continues exactly where it stopped.
    func localPause() {
        guard engine.isRunning, player.isPlaying else { return }
        locallyPausedAt = Date()
        fade(to: 0, over: 0.12) { [weak self] in
            guard let self else { return }
            self.lock.lock(); self.players.forEach { $0.pause() }; self.lock.unlock()
        }
    }
    /// When Cadenza last stopped the sound itself (before Spotify confirmed), nil once it's playing again.
    private(set) var locallyPausedAt: Date?
    /// True while Cadenza's player is holding the sound (paused here), whatever Spotify thinks.
    var holding: Bool { engine.isRunning && !player.isPlaying }

    func localResume() {
        if sleepFading { sleepFading = false; rampTransition(to: 1, over: 0.5) }   // the sleep timer was cancelled
        locallyPausedAt = nil
        guard engine.isRunning else { fader.outputVolume = 1; return startEngine() }
        if !player.isPlaying {
            fader.outputVolume = 0
            lock.lock(); playPlayer(); if xfTimer?.isValid == true { playPlayer(other) }; lock.unlock()   // mid-crossfade: both
        }
        fade(to: 1, over: 0.18)
    }

    private func fade(to target: Float, over seconds: Double, then done: (() -> Void)? = nil) {
        fadeTimer?.invalidate()
        let start = fader.outputVolume, begin = Date()
        fadeTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] t in
            guard let self else { return t.invalidate() }
            let x = Float(min(1, Date().timeIntervalSince(begin) / seconds))
            self.fader.outputVolume = start + (target - start) * (x * x * (3 - 2 * x))
            if x >= 1 { t.invalidate(); done?() }
        }
    }

    /// Skip pressed: go quiet now; when the next song actually starts, throw away the old song's leftovers.
    func beginSkip() {
        guard engine.isRunning else { return }
        engine.mainMixerNode.outputVolume = 0
        skipTimer?.invalidate()
        skipTimer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: false) { [weak self] _ in self?.endSkip(flush: false) }
    }

    /// Called when librespot reports the new song.
    func trackChanged() {
        guard skipTimer != nil else { return }
        endSkip(flush: true)
    }

    private func endSkip(flush: Bool) {
        skipTimer?.invalidate()
        skipTimer = nil
        if flush { dropQueued() }
        engine.mainMixerNode.outputVolume = 1
    }

    /// Throw away the sound that's already on its way (about half a second: the pipe from librespot plus
    /// what's queued in the engine), so a skip or a seek is heard at once instead of after it.
    private func dropQueued() {
        var waiting: Int32 = 0                                   // bytes still sitting in the pipe
        let got = handle.map { ioctl($0.fileDescriptor, 0x4004667F /* FIONREAD */, &waiting) == 0 } ?? false
        lock.lock()
        if got { discardBytes = Int(waiting) }
        let wasPlaying = player.isPlaying
        abortCrossfade()
        trackStart = -1; trackLength = 0; lastBoundary = -1      // librespot's next report says where it is now
        player.stop()                                            // drop what's queued in the engine too
        if wasPlaying { playPlayer() }
        lock.unlock()
    }

    /// librespot jumped to a new spot in the song: drop the old spot's audio still on its way, behind a
    /// tiny fade so there's no click.
    func seeked() {
        guard engine.isRunning, player.isPlaying, skipTimer == nil else { return }
        engine.mainMixerNode.outputVolume = 0
        dropQueued()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            guard let self, self.skipTimer == nil else { return }
            self.engine.mainMixerNode.outputVolume = 1
        }
    }

    // MARK: - Smooth transitions and the sleep timer's fade

    /// Ease the transition volume to `target` over `seconds` (smoothstep, like the pause fade).
    func rampTransition(to target: Float, over seconds: Double) {
        xfadeTimer?.invalidate()
        let start = xfade.outputVolume, begin = Date()
        if seconds <= 0 || abs(start - target) < 0.001 { xfade.outputVolume = target; return }
        xfadeTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] t in
            guard let self else { return t.invalidate() }
            let x = Float(min(1, Date().timeIntervalSince(begin) / seconds))
            self.xfade.outputVolume = start + (target - start) * (x * x * (3 - 2 * x))
            if x >= 1 { t.invalidate() }
        }
    }
    /// The sleep timer's 10-second fade is running: smooth transitions leave the volume alone meanwhile.
    var sleepFading = false
    func sleepFade() { sleepFading = true; rampTransition(to: 0, over: 10) }

    /// Back to full volume at once (a pause, a seek, a skip: anything that isn't the song running out).
    func resetTransition() { xfadeTimer?.invalidate(); xfade.outputVolume = 1 }
    var transitionVolume: Float { xfade.outputVolume }

    /// Seconds since librespot last delivered any audio.
    var secondsSinceAudio: TimeInterval { Date().timeIntervalSince(lastAudio) }

    /// Safety net, called when playback (re)starts: make sure nothing was left turned down by an
    /// interrupted fade or skip, and that the engine and player are actually running.
    func ensureAudible() {
        guard !asleep, !shutDown else { return }
        if !engine.isRunning { startEngine() }
        if skipTimer == nil { engine.mainMixerNode.outputVolume = 1 }
        if fadeTimer?.isValid != true { fader.outputVolume = 1 }
        if xfadeTimer?.isValid != true && !sleepFading { xfade.outputVolume = 1 }   // a finished song-end fade
        inMix.outputVolume = 1
        if engine.isRunning && !player.isPlaying {
            locallyPausedAt = nil
            lock.lock(); playPlayer(); if xfTimer?.isValid == true { playPlayer(other) }; lock.unlock()
        }
    }

    /// Paused for a few minutes: let the sound engine (and the AirPods) rest. Not sooner: waking it takes
    /// a moment, which made pressing play after a short pause feel slow.
    private func sleepIfIdle() {
        guard engine.isRunning, Date().timeIntervalSince(lastAudio) > 180 else { return }
        lock.lock(); engine.pause(); lock.unlock()
        onLog?("Nothing playing: sound engine resting.")
    }

    // MARK: - Meter

    func setMeter(_ on: Bool) {
        guard on != meterOn else { return }
        meterOn = on
        if on {
            let ok = safely("start the level meter") {
                limiter.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buf, _ in self?.measure(buf) }
            }
            if !ok { meterOn = false }
        } else {
            limiter.removeTap(onBus: 0)
        }
    }

    // Spectrum analysis: a 4096-point FFT (Apple's Accelerate) over the most recent audio, after the EQ.
    private static let fftSize = 4096
    private static let specBands = 48
    private var history = [Float](repeating: 0, count: AudioPipe.fftSize)
    private let window = vDSP.window(ofType: Float.self, usingSequence: .hanningDenormalized, count: AudioPipe.fftSize, isHalfWindow: false)
    private let dft = vDSP.DFT(count: AudioPipe.fftSize, direction: .forward, transformType: .complexComplex, ofType: Float.self)
    private var zeros = [Float](repeating: 0, count: AudioPipe.fftSize)
    private var outRe = [Float](repeating: 0, count: AudioPipe.fftSize)
    private var outIm = [Float](repeating: 0, count: AudioPipe.fftSize)
    private var power = [Float](repeating: 0, count: AudioPipe.fftSize / 2)
    private var meterWasSilent = false
    private var ring = [Float](repeating: 0, count: AudioPipe.fftSize)
    private var ringPos = 0

    private func measure(_ buf: AVAudioPCMBuffer) {
        guard let ch = buf.floatChannelData, let dft = self.dft else { return }
        // keep a rolling window of the latest samples (mono mix)
        let n = Int(buf.frameLength), N = AudioPipe.fftSize
        guard n > 0 else { return }
        let left = ch[0], right = buf.format.channelCount > 1 ? ch[1] : ch[0]
        // Paused (or a silent stretch) and the meters already show flat: skip the FFT altogether.
        var peak: Float = 0
        vDSP_maxmgv(left, 1, &peak, vDSP_Length(n))
        if peak < 1e-5 && meterWasSilent { return }
        // newest samples go into a ring (no shuffling the whole window along every time)
        for i in max(0, n - N)..<n {
            ring[ringPos] = (left[i] + right[i]) * 0.5
            ringPos = ringPos + 1 == N ? 0 : ringPos + 1
        }
        guard Date().timeIntervalSince(lastMeter) > 0.032 else { return }      // ~30 updates a second
        lastMeter = Date()
        for i in 0..<N { history[i] = ring[(ringPos + i) % N] }               // oldest → newest

        let windowed = vDSP.multiply(history, window)
        dft.transform(inputReal: windowed, inputImaginary: zeros, outputReal: &outRe, outputImaginary: &outIm)
        for i in 0..<(N / 2) { power[i] = outRe[i] * outRe[i] + outIm[i] * outIm[i] }

        let rate = Float(buf.format.sampleRate), res = rate / Float(N)
        let fullScale = Float(N * N) / 16                       // a full-volume sine through a Hann window
        func level(_ lo: Float, _ hi: Float) -> Double {
            let a = max(1, Int((lo / res).rounded(.up))), b = max(a, min(N / 2 - 1, Int((hi / res).rounded(.down))))
            var sum: Float = 0
            for i in a...b { sum += power[i] }
            let mid = (lo * hi).squareRoot()
            // +3 dB per octave so treble shows up as clearly as bass (music has far more energy down low)
            let db = 10 * log10(max(sum / Float(b - a + 1), 1e-12) / fullScale) + 3 * log2(mid / 1000)
            let v = Double(max(0, min(1, (db + 72) / 62)))
            return (v * 100).rounded() / 100                     // short numbers = small messages
        }
        let lo: Float = 35, hi: Float = 16000, B = AudioPipe.specBands
        var spec: [Double] = []
        spec.reserveCapacity(B)
        for k in 0..<B {
            let a = lo * pow(hi / lo, Float(k) / Float(B)), b = lo * pow(hi / lo, Float(k + 1) / Float(B))
            spec.append(level(a, b))
        }
        let eqBands = AudioPipe.freqs.map { level($0 / 1.414, $0 * 1.414) }
        // Paused or silent: send one all-zero frame so the meters settle, then stay quiet (no 30-a-second
        // messages to the page while nothing is playing).
        let silent = spec.allSatisfy { $0 == 0 }
        if silent && meterWasSilent { return }
        meterWasSilent = silent
        DispatchQueue.main.async { [weak self] in self?.onLevels?(["spec": spec, "eq": eqBands]) }
    }
}
