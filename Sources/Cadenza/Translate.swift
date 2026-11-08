import AppKit
import NaturalLanguage
import SwiftUI
#if canImport(Translation)
import Translation
#endif

/// Lyrics translation with Apple's Translation framework: on your Mac, nothing is sent anywhere.
/// Needs macOS 15 or later. The first time for a language, macOS asks to download it.
///
/// Apple only hands out a translation session through a SwiftUI view, so a 1×1 invisible view sits in
/// the window and does the work when asked.
final class LyricsTranslator {
    private var host: NSView?
    private var model: AnyObject?

    /// The language lyrics are translated into: the Mac's own.
    static var targetCode: String { Locale.current.language.languageCode?.identifier ?? "en" }

    /// Translates `lines` (blank ones are kept as they are). `done(lines, error)`: error is
    /// "needs-macos-15", "same-language", or a message.
    func translate(_ lines: [String], in window: NSWindow?, done: @escaping ([String]?, String?) -> Void) {
        // What language are the lyrics in? If they're already in the Mac's language, there's nothing to do.
        let text = lines.joined(separator: "\n")
        let rec = NLLanguageRecognizer()
        rec.processString(text)
        let source = rec.dominantLanguage?.rawValue
        if let source, Locale.Language(identifier: source).languageCode?.identifier == LyricsTranslator.targetCode {
            return done(nil, "same-language")
        }
        #if canImport(Translation)
        if #available(macOS 15.0, *) {
            let m: TranslateModel
            if let existing = model as? TranslateModel { m = existing } else {
                m = TranslateModel()
                model = m
                let view = NSHostingView(rootView: TranslateHost(model: m))
                view.frame = NSRect(x: 0, y: 0, width: 1, height: 1)
                window?.contentView?.addSubview(view)
                host = view
            }
            m.run(lines: lines, source: source, done: done)
            return
        }
        #endif
        done(nil, "needs-macos-15")
    }
}

#if canImport(Translation)
@available(macOS 15.0, *)
final class TranslateModel: ObservableObject {
    @Published var config: TranslationSession.Configuration?
    var lines: [String] = []
    var done: (([String]?, String?) -> Void)?

    func run(lines: [String], source: String?, done: @escaping ([String]?, String?) -> Void) {
        self.lines = lines
        self.done = done
        let src = source.map { Locale.Language(identifier: $0) }
        let target = Locale.Language(identifier: LyricsTranslator.targetCode)
        if config != nil, config?.source == src, config?.target == target {
            config?.invalidate()                         // same languages: run the task again
        } else {
            config = TranslationSession.Configuration(source: src, target: target)
        }
    }
}

@available(macOS 15.0, *)
struct TranslateHost: View {
    @ObservedObject var model: TranslateModel

    var body: some View {
        Color.clear
            .frame(width: 1, height: 1)
            .translationTask(model.config) { session in
                let lines = model.lines
                guard let done = model.done else { return }
                model.done = nil
                var requests: [TranslationSession.Request] = []
                for (i, line) in lines.enumerated() where !line.trimmingCharacters(in: .whitespaces).isEmpty && line != "♪" {
                    requests.append(TranslationSession.Request(sourceText: line, clientIdentifier: String(i)))
                }
                if requests.isEmpty { DispatchQueue.main.async { done(lines.map { _ in "" }, nil) }; return }
                do {
                    let responses = try await session.translations(from: requests)
                    var out = lines.map { _ in "" }
                    for r in responses {
                        if let id = r.clientIdentifier, let i = Int(id), i < out.count { out[i] = r.targetText }
                    }
                    DispatchQueue.main.async { done(out, nil) }
                } catch {
                    DispatchQueue.main.async { done(nil, error.localizedDescription) }
                }
            }
    }
}
#endif
