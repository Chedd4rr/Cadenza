import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Playlist tags (genre, mood, tempo) from Apple Intelligence's on-device model.
/// Runs entirely on your Mac. Needs macOS 26+, Apple silicon, and Apple Intelligence turned on.
final class TagAI {
    private static let instructions = """
    You label music playlists. You are given a playlist's name and some of its songs and artists.
    Reply with ONLY a JSON object, no other text: {"genre": "...", "mood": "...", "tempo": "..."}
    - genre: the main genre, 1-2 words (e.g. "Indie Rock", "Lo-Fi", "Hip-Hop", "J-Pop", "Classic Soul").
    - mood: the overall feeling, 1-2 words (e.g. "Chill", "Hype", "Melancholy", "Dreamy", "Feel-Good").
    - tempo: exactly one of: "Slow", "Laid-Back", "Mid-Tempo", "Upbeat", "Fast", "Mixed Tempo".
    Use Title Case. Base it on what you know about these artists and songs.
    """

    /// ["available": Bool, "reason": String]
    func status() -> [String: Any] {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            let availability = SystemLanguageModel.default.availability
            if case .available = availability { return ["available": true, "reason": ""] }
            return ["available": false, "reason": String(describing: availability)]
        }
        #endif
        return ["available": false, "reason": "needsNewerMacOS"]
    }

    func tags(prompt: String, done: @escaping ([String: String]?, String?) -> Void) {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            Task {
                do {
                    let session = LanguageModelSession(instructions: TagAI.instructions)
                    let response = try await session.respond(to: prompt)
                    let parsed = TagAI.parse(response.content)
                    DispatchQueue.main.async { done(parsed, parsed == nil ? "Unreadable answer" : nil) }
                } catch {
                    DispatchQueue.main.async { done(nil, String(describing: error)) }
                }
            }
            return
        }
        #endif
        done(nil, "Apple Intelligence needs macOS 26 or later")
    }

    /// Pull {"genre","mood","tempo"} out of the model's reply, tidy each to 1-2 words.
    static func parse(_ text: String) -> [String: String]? {
        guard let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start < end,
              let data = String(text[start...end]).data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        var out: [String: String] = [:]
        for key in ["genre", "mood", "tempo"] {
            guard let raw = obj[key] as? String else { return nil }
            let words = raw.replacingOccurrences(of: "\"", with: "")
                .split(whereSeparator: { $0 == " " || $0 == "\n" }).prefix(2)
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            let clean = words.joined(separator: " ").trimmingCharacters(in: .punctuationCharacters)
            if clean.isEmpty { return nil }
            out[key] = String(clean.prefix(22))
        }
        return out
    }
}
