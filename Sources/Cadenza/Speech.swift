import AVFoundation

/// The DJ's voice: macOS text-to-speech, using the best English voice installed.
/// (Download nicer voices in System Settings → Accessibility → Spoken Content → System Voice → Manage Voices.)
final class Speech: NSObject, AVSpeechSynthesizerDelegate {
    private let synth = AVSpeechSynthesizer()
    private var finished: (() -> Void)?
    /// Cadenza's sound engine: when it's playing the music, the DJ talks through it (radio sound + music ducking).
    weak var pipe: AudioPipe?
    private var token = 0

    override init() {
        super.init()
        synth.delegate = self
    }

    /// Joke voices and old robotic ones ship with every Mac; never pick those for the DJ.
    private static let robotic: Set<String> = ["Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Good News",
        "Jester", "Organ", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox", "Fred", "Junior", "Kathy", "Ralph",
        "Eddy", "Flo", "Grandma", "Grandpa", "Reed", "Rocko", "Sandy", "Shelley"]

    static func isNatural(_ v: AVSpeechSynthesisVoice) -> Bool {
        if robotic.contains(v.name) || v.identifier.lowercased().contains("eloquence") { return false }
        if #available(macOS 14.0, *), v.voiceTraits.contains(.isNoveltyVoice) { return false }   // the name list above covers macOS 13
        return true
    }

    /// Natural English voices installed, best first (Premium > Enhanced > standard; US English first).
    static func choices() -> [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix("en") && isNatural($0) }
            .sorted {
                if $0.quality.rawValue != $1.quality.rawValue { return $0.quality.rawValue > $1.quality.rawValue }
                if ($0.language == "en-US") != ($1.language == "en-US") { return $0.language == "en-US" }
                return $0.name < $1.name
            }
    }

    /// For System → DJ voice: name, quality and id of each natural voice.
    static func list() -> [[String: Any]] {
        choices().map { v in
            let q = v.quality == .premium ? "Premium" : v.quality == .enhanced ? "Enhanced" : "Standard"
            return ["id": v.identifier, "name": v.name, "quality": q, "language": v.language]
        }
    }

    private var voice: AVSpeechSynthesisVoice? {
        let saved = UserDefaults.standard.string(forKey: "djVoiceId") ?? ""
        if !saved.isEmpty, let v = AVSpeechSynthesisVoice(identifier: saved) { return v }
        return Speech.choices().first ?? AVSpeechSynthesisVoice(language: "en-US")
    }

    /// Natural pacing: short pauses after commas, longer after sentences and colons, slightly
    /// slower and lower overall, like a radio host. Uses SSML, with plain text as a fallback.
    private func utterance(_ text: String) -> AVSpeechUtterance {
        let esc = text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        var body = ""
        for ch in esc {
            body.append(ch)
            switch ch {
            case ",": body += "<break time=\"180ms\"/>"
            case ":", ";", "\u{2014}": body += "<break time=\"320ms\"/>"
            case ".", "!", "?": body += "<break time=\"380ms\"/>"
            default: break
            }
        }
        let ssml = "<speak><prosody rate=\"94%\" pitch=\"-4%\">\(body)</prosody></speak>"
        let u: AVSpeechUtterance
        if let s = AVSpeechUtterance(ssmlRepresentation: ssml) {
            u = s
        } else {
            u = AVSpeechUtterance(string: text)
            u.rate = 0.47
            u.pitchMultiplier = 0.96
        }
        u.voice = voice
        u.preUtteranceDelay = 0.1
        return u
    }

    func speak(_ text: String, done: @escaping () -> Void) {
        stop()
        guard !text.isEmpty else { return done() }
        finished = done
        token += 1
        let mine = token
        let u = utterance(text)
        guard let pipe, pipe.canVoice else { return synth.speak(u) }    // no sound engine: speak normally
        // Render the speech to audio, then play it through Cadenza's engine with the radio chain.
        // (State lives on the object, not in captured variables, so newer Swift's concurrency checks are happy.)
        parts = []
        sent = false
        synth.write(u) { [weak self] buffer in
            guard let pcm = buffer as? AVAudioPCMBuffer else { return }
            let copy = pcm.frameLength > 0 ? Speech.copy(pcm) : nil
            DispatchQueue.main.async { [weak self] in
                guard let self, self.token == mine else { return }
                if let copy {
                    self.parts.append(copy)
                    self.timeout?.cancel()
                    let w = DispatchWorkItem { [weak self] in self?.playRendered(mine) }
                    self.timeout = w
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.7, execute: w)
                } else {
                    self.playRendered(mine)
                }
            }
        }
    }

    private var parts: [AVAudioPCMBuffer] = []
    private var sent = false
    private var timeout: DispatchWorkItem?

    /// Play once the speech is fully rendered (an empty buffer marks the end; a short timeout covers voices that don't send one).
    private func playRendered(_ mine: Int) {
        guard !sent, token == mine, let pipe else { return }
        sent = true
        timeout?.cancel()
        let audio = parts
        parts = []
        pipe.playVoice(audio) { [weak self] in
            guard let self, self.token == mine else { return }
            self.finish()
        }
    }

    /// The speech engine reuses its buffers, so keep our own copy of each piece.
    private static func copy(_ b: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let c = AVAudioPCMBuffer(pcmFormat: b.format, frameCapacity: b.frameLength) else { return nil }
        c.frameLength = b.frameLength
        let src = UnsafeMutableAudioBufferListPointer(b.mutableAudioBufferList)
        let dst = UnsafeMutableAudioBufferListPointer(c.mutableAudioBufferList)
        for i in 0..<min(src.count, dst.count) {
            if let s = src[i].mData, let d = dst[i].mData { memcpy(d, s, Int(min(src[i].mDataByteSize, dst[i].mDataByteSize))) }
        }
        return c
    }

    func stop() {
        token += 1
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        pipe?.stopVoice()
        finish()
    }

    private func finish() {
        let f = finished
        finished = nil
        f?()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.finish() }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.finish() }
    }
}
