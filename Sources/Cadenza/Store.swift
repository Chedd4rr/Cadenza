import Foundation

/// Tiny key-value store for the UI (cached playlist tags, Up Next, true-shuffle lists…), saved as JSON
/// in Application Support. Changes are written a second later, all at once, off the main thread.
final class Store {
    private var data: [String: Any] = [:]
    private let file = Settings.supportDir.appendingPathComponent("store.json")
    private var saveScheduled = false
    private let io = DispatchQueue(label: "cadenza.store", qos: .utility)

    init() {
        if let d = try? Data(contentsOf: file), let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
            data = obj
        }
        // True shuffle keeps one song list per playlist. Older builds kept a copy for every version of a
        // playlist ("trueShuffle:<id>:<version>", saved as a plain list), so clear those out.
        let old = data.keys.filter { $0.hasPrefix("trueShuffle:") && data[$0] is [Any] }
        if !old.isEmpty { old.forEach { data.removeValue(forKey: $0) }; scheduleSave() }
    }

    func get(_ key: String) -> Any? { data[key] }

    func set(_ key: String, _ value: Any?) {
        if let value, !(value is NSNull) {
            // One value JSON can't hold (NaN, say) would stop the whole file from ever saving again.
            guard JSONSerialization.isValidJSONObject([value]) else { return NSLog("Cadenza: not saving \(key): not valid JSON") }
            data[key] = value
        } else {
            data.removeValue(forKey: key)
        }
        scheduleSave()
    }

    private func scheduleSave() {
        guard !saveScheduled else { return }
        saveScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.save() }
    }

    private func save() {
        saveScheduled = false
        let snapshot = data, file = file                       // a copy, so the main thread can carry on
        io.async {
            guard JSONSerialization.isValidJSONObject(snapshot),
                  let d = try? JSONSerialization.data(withJSONObject: snapshot) else { return }
            _ = Settings.writePrivately(d, to: file)
        }
    }

    /// Write anything pending right away (Cadenza is quitting).
    func flush() {
        guard saveScheduled else { io.sync {}; return }        // (let a write already under way finish)
        saveScheduled = false
        let snapshot = data, file = file
        io.sync {
            if JSONSerialization.isValidJSONObject(snapshot), let d = try? JSONSerialization.data(withJSONObject: snapshot) {
                _ = Settings.writePrivately(d, to: file)
            }
        }
    }
}
