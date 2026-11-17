import Foundation
import CryptoKit
import WebKit

/// Lyrics translation runs Firefox's offline translator (Bergamot) inside the web page: no Apple
/// frameworks, and nothing you translate leaves your Mac. It needs a language model for each direction
/// (about 15 to 60 MB). This class finds the right ones in Mozilla's public list (the same one Firefox
/// uses), downloads them the first time, checks each file against the hash Mozilla publishes, and keeps
/// them in ~/Library/Application Support/Cadenza/translation-models.
///
/// The page reads them (and the translator itself) through a private cadenza-files:// address that only
/// this app answers; see FilesScheme below.
final class TranslationModels {
    static let recordsURL = URL(string: "https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records")!
    static let attachmentsBase = "https://firefox-settings-attachments.cdn.mozilla.net/"
    static let maxFileBytes = 150 * 1024 * 1024

    let dir = Settings.supportDir.appendingPathComponent("translation-models", isDirectory: true)
    private var listFile: URL { dir.appendingPathComponent("records.json") }
    private let queue = DispatchQueue(label: "cadenza.translation-models", qos: .userInitiated)
    private var busy = false

    /// One file of a model, as Mozilla lists it.
    private struct Part { let type: String; let name: String; let location: String; let hash: String; let size: Int; let ext: String }

    /// Finds (and if needed downloads) the models to translate `from` → `to`: the direct pair, or through
    /// English when there isn't one. `below`: a version that didn't load, to pick an older one instead.
    /// Replies with [{from, to, version, files: {model, lex, vocab | srcvocab + trgvocab: url}}].
    func prepare(from: String, to: String, below: String?, progress: @escaping (Int, Int) -> Void,
                 done: @escaping ([[String: Any]]?, String?) -> Void) {
        let ok = { (c: String) in c.count >= 2 && c.count <= 8 && c.allSatisfy { $0.isLetter || $0 == "-" } }
        guard ok(from), ok(to), from != to else { return done(nil, "bad-language") }
        guard !busy else { return done(nil, "busy") }
        busy = true
        let finish: ([[String: Any]]?, String?) -> Void = { m, e in DispatchQueue.main.async { self.busy = false; done(m, e) } }
        queue.async {
            guard let records = self.records() else { return finish(nil, "offline") }
            var pairs: [(String, String)] = []
            if self.choose(records, from, to, below: nil) != nil { pairs = [(from, to)] }
            else if from != "en" && to != "en", self.choose(records, from, "en", below: nil) != nil, self.choose(records, "en", to, below: nil) != nil {
                pairs = [(from, "en"), ("en", to)]
            }
            guard !pairs.isEmpty else { return finish(nil, "unsupported") }
            var chosen: [(String, String, String, [Part])] = []
            for (f, t) in pairs {
                guard let pick = self.choose(records, f, t, below: below) else { return finish(nil, "unsupported") }
                chosen.append((f, t, pick.0, pick.1))
            }
            // Download what isn't here yet, reporting progress across all the files.
            let missing = chosen.flatMap { $0.3 }.filter { !FileManager.default.fileExists(atPath: self.path(for: $0).path) }
            let total = missing.reduce(0) { $0 + $1.size }
            var got = 0
            if total > 0 { DispatchQueue.main.async { progress(0, total) } }
            for part in missing {
                let before = got
                if let error = self.download(part, onBytes: { n in DispatchQueue.main.async { progress(before + n, total) } }) {
                    return finish(nil, error)
                }
                got += part.size
            }
            let out: [[String: Any]] = chosen.map { f, t, version, parts in
                var files: [String: String] = [:]
                for p in parts { files[p.type] = "cadenza-files://models/" + self.path(for: p).lastPathComponent }
                // A few models (Ukrainian, for one) need a different number format; Firefox tells them apart by name.
                let int8 = parts.contains { $0.type == "model" && $0.name.hasSuffix("intgemm8.bin") }
                return ["from": f, "to": t, "version": version, "files": files, "int8": int8]
            }
            finish(out, nil)
        }
    }

    /// Mozilla's list, kept for a week (or used as it is when there's no connection).
    private func records() -> [[String: Any]]? {
        let fm = FileManager.default
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let age = (try? listFile.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate).map { Date().timeIntervalSince($0) } ?? .infinity
        if age > 7 * 86400 {
            var req = URLRequest(url: Self.recordsURL, timeoutInterval: 20)
            req.setValue("application/json", forHTTPHeaderField: "Accept")
            if let (data, response) = Self.fetch(req), (response as? HTTPURLResponse)?.statusCode == 200, data.count < 20_000_000,
               (try? JSONSerialization.jsonObject(with: data)) is [String: Any] {
                _ = Settings.writePrivately(data, to: listFile)
            }
        }
        guard let data = try? Data(contentsOf: listFile),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        return obj["data"] as? [[String: Any]]
    }

    /// The newest complete model for a direction (below `below`, if given). Records meant only for Firefox
    /// on Android or for test builds are left out, and so are alpha versions.
    private func choose(_ records: [[String: Any]], _ from: String, _ to: String, below: String?) -> (String, [Part])? {
        var byVersion: [String: [Part]] = [:]
        for r in records {
            guard (r["fromLang"] as? String) == from, (r["toLang"] as? String) == to,
                  let version = r["version"] as? String, Self.number(version) != nil,
                  let type = r["fileType"] as? String, ["model", "lex", "vocab", "srcvocab", "trgvocab"].contains(type),
                  let a = r["attachment"] as? [String: Any], let location = a["location"] as? String,
                  let hash = a["hash"] as? String, hash.count == 64, hash.allSatisfy({ $0.isHexDigit }),
                  let size = (a["size"] as? NSNumber)?.intValue, size > 0, size <= Self.maxFileBytes,
                  !location.contains(".."), !location.hasPrefix("/") else { continue }
            let filter = (r["filter_expression"] as? String) ?? ""
            if filter.contains("== 'Android'") || filter.contains("channel ==") { continue }
            let ext = (location as NSString).pathExtension.lowercased() == "spm" ? "spm" : "bin"
            byVersion[version, default: []].append(Part(type: type, name: (r["name"] as? String) ?? "", location: location, hash: hash.lowercased(), size: size, ext: ext))
        }
        let limit = below.flatMap(Self.number)
        let versions = byVersion.keys.filter { v in limit.map { Self.number(v)! < $0 } ?? true }
            .sorted { Self.number($0)! > Self.number($1)! }
        for v in versions {
            var parts: [String: Part] = [:]
            for p in byVersion[v]! where parts[p.type] == nil { parts[p.type] = p }
            let vocabs = parts["vocab"] != nil || (parts["srcvocab"] != nil && parts["trgvocab"] != nil)
            if parts["model"] != nil, parts["lex"] != nil, vocabs { return (v, Array(parts.values)) }
        }
        return nil
    }

    /// "2.1" → 2.1 (for sorting); nil for anything else, like "2.0a1".
    private static func number(_ v: String) -> Double? {
        let bits = v.split(separator: ".")
        guard bits.count >= 1, bits.count <= 3, bits.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) }) else { return nil }
        return bits.enumerated().reduce(0.0) { $0 + (Double($1.element) ?? 0) / pow(1000, Double($1.offset)) }
    }

    /// Files are named by their hash, so a changed model never mixes with an old one.
    private func path(for p: Part) -> URL { dir.appendingPathComponent("\(p.hash).\(p.ext)") }

    /// Downloads one file, checks its size and hash, and only then keeps it. Returns an error, or nil.
    private func download(_ p: Part, onBytes: @escaping (Int) -> Void) -> String? {
        guard let url = URL(string: Self.attachmentsBase + p.location), url.host == "firefox-settings-attachments.cdn.mozilla.net" else { return "bad-url" }
        let sem = DispatchSemaphore(value: 0)
        var result: String? = "download-failed"
        let task = URLSession.shared.downloadTask(with: URLRequest(url: url, timeoutInterval: 60)) { tmp, response, _ in
            defer { sem.signal() }
            guard let tmp, (response as? HTTPURLResponse)?.statusCode == 200,
                  let data = try? Data(contentsOf: tmp, options: .mappedIfSafe) else { return }
            guard data.count == p.size else { result = "size-mismatch"; return }
            let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            guard digest == p.hash else { result = "hash-mismatch"; return }
            result = Settings.writePrivately(data, to: self.path(for: p)) ? nil : "write-failed"
        }
        let watch = task.progress.observe(\.completedUnitCount) { pr, _ in onBytes(Int(pr.completedUnitCount)) }
        task.resume()
        sem.wait()
        watch.invalidate()
        return result
    }

    private static func fetch(_ req: URLRequest) -> (Data, URLResponse)? {
        let sem = DispatchSemaphore(value: 0)
        var out: (Data, URLResponse)?
        URLSession.shared.dataTask(with: req) { data, response, _ in
            if let data, let response { out = (data, response) }
            sem.signal()
        }.resume()
        sem.wait()
        return out
    }

    /// How much the downloaded languages take up, in bytes.
    func diskUsage() -> Int {
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        return files.reduce(0) { $0 + ((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
    }

    /// Deletes every downloaded language (they're downloaded again when needed).
    func clear() {
        queue.async { try? FileManager.default.removeItem(at: self.dir) }
    }
}

/// Answers cadenza-files:// for the page, and nothing else:
/// - cadenza-files://app/vendor/… → the translator and language detector bundled with the app;
/// - cadenza-files://models/<hash>.bin|.spm → a downloaded translation model.
/// The page is loaded from a file, and browsers won't let it fetch other files directly; this is the
/// narrow way through, limited to those two folders.
final class FilesScheme: NSObject, WKURLSchemeHandler {
    static let scheme = "cadenza-files"
    private let vendor: URL?
    private let models: URL

    init(webRoot: URL?, models: URL) {
        self.vendor = webRoot?.appendingPathComponent("vendor", isDirectory: true).resolvingSymlinksInPath()
        self.models = models
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, let file = resolve(url),
              let data = try? Data(contentsOf: file, options: .mappedIfSafe) else {
            task.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        let type: String
        switch file.pathExtension.lowercased() {
        case "js": type = "text/javascript"
        case "wasm": type = "application/wasm"
        default: type = "application/octet-stream"
        }
        let headers = ["Content-Type": type, "Content-Length": String(data.count),
                       "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"]
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func resolve(_ url: URL) -> URL? {
        let name = url.lastPathComponent
        switch url.host {
        case "models":
            guard name.range(of: #"^[0-9a-f]{64}\.(bin|spm)$"#, options: .regularExpression) != nil else { return nil }
            return models.appendingPathComponent(name)
        case "app":
            guard let vendor else { return nil }
            let parts = url.path.split(separator: "/").map(String.init)
            guard parts.count >= 2, parts[0] == "vendor", parts.allSatisfy({ $0 != ".." && !$0.isEmpty }) else { return nil }
            let file = vendor.appendingPathComponent(parts.dropFirst().joined(separator: "/")).resolvingSymlinksInPath()
            return file.path.hasPrefix(vendor.path + "/") ? file : nil
        default:
            return nil
        }
    }
}
