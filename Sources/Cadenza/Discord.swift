import Foundation
import Darwin

/// "Listening to …" on your Discord profile, through the Discord app's local connection (Rich Presence).
/// No Discord login or token is involved: the Discord app running on this Mac shows the status.
/// It needs a Discord application ID (free: discord.com/developers → New Application, name it "Cadenza").
final class DiscordPresence {
    private let q = DispatchQueue(label: "cadenza.discord")
    private var fd: Int32 = -1
    private var connectedId = ""
    private var nextTry = Date.distantPast
    private var activity: [String: Any]?        // what we last wanted to show (nil = nothing)
    private var sentKey = ""
    private var sentStart: Double = 0
    private var state = "off"
    private var timer: Timer?

    var appId: String { (UserDefaults.standard.string(forKey: "discordAppId") ?? "").trimmingCharacters(in: .whitespaces) }

    var enabled = false {
        didSet {
            if enabled == oldValue { return }
            if enabled {
                timer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
                    guard let me = self else { return }
                    me.q.async { me.resend(force: false) }
                }
                q.async { self.nextTry = .distantPast; self.resend(force: true) }
            } else {
                timer?.invalidate(); timer = nil
                q.async { self.disconnect(); self.state = "off" }
            }
        }
    }

    /// For System: "connected", "waiting for Discord", "needs an application ID" …
    var status: String { q.sync { state } }

    /// Called whenever the song or play state changes.
    func update(_ np: [String: Any]) {
        let title = (np["title"] as? String) ?? ""
        let playing = (np["playing"] as? Bool) ?? false
        guard !title.isEmpty, playing else { q.async { self.activity = nil; self.resend(force: false) }; return }
        let artist = (np["artist"] as? String) ?? ""
        let album = (np["album"] as? String) ?? ""
        let duration = (np["duration"] as? Double) ?? Double((np["duration"] as? Int) ?? 0)
        let position = (np["position"] as? Double) ?? Double((np["position"] as? Int) ?? 0)
        let now = Date().timeIntervalSince1970 * 1000
        let start = now - position
        var a: [String: Any] = [
            "type": 2,                                                   // "Listening to"
            "details": DiscordPresence.fit(title),
            "state": DiscordPresence.fit("by " + artist),
            "timestamps": ["start": Int64(start), "end": Int64(start + max(duration, 1000))],
        ]
        var assets: [String: Any] = [:]
        if let art = np["art"] as? String, art.hasPrefix("https://") { assets["large_image"] = art }
        if !album.isEmpty { assets["large_text"] = DiscordPresence.fit(album) }
        if !assets.isEmpty { a["assets"] = assets }
        if let uri = np["uri"] as? String {
            let p = uri.split(separator: ":")
            if p.count == 3, p[1] == "track" || p[1] == "episode" {
                a["buttons"] = [["label": "Open in Spotify", "url": "https://open.spotify.com/\(p[1])/\(p[2])"]]
            }
        }
        let key = title + "|" + artist, act = a
        q.async {
            self.activity = act
            // Same song, still on time: nothing to send. A seek moves the start time, so resend then.
            let moved = abs(start - self.sentStart) > 4000
            if key != self.sentKey || moved { self.sentKey = key; self.sentStart = start; self.resend(force: true) }
        }
    }

    // Discord wants 2 to 128 characters.
    private static func fit(_ s: String) -> String {
        var t = s.trimmingCharacters(in: .whitespaces)
        if t.count < 2 { t += "  " }
        return t.count > 128 ? String(t.prefix(127)) + "…" : t
    }

    // MARK: - Connection (always on the queue)

    private func resend(force: Bool) {
        guard enabled else { return }
        guard !appId.isEmpty else { state = "needs an application ID"; return }
        if fd < 0 || connectedId != appId {
            disconnect()
            guard Date() >= nextTry else { return }
            guard connect() else { nextTry = Date().addingTimeInterval(15); return }
            sentKey = ""                                                 // fresh connection: send everything again
        } else if !force { return }
        var args: [String: Any] = ["pid": Int(ProcessInfo.processInfo.processIdentifier)]
        if let activity { args["activity"] = activity }
        let ok = send(1, ["cmd": "SET_ACTIVITY", "args": args, "nonce": UUID().uuidString])
        if ok, let reply = read(), reply.op == 1 {
            if (reply.json["evt"] as? String) == "ERROR" {
                let msg = ((reply.json["data"] as? [String: Any])?["message"] as? String) ?? "rejected"
                state = "Discord said: " + msg
            } else { state = "connected" }
        } else {
            disconnect(); state = "waiting for Discord"
        }
    }

    private func connect() -> Bool {
        var dirs: [String] = []
        for d in [ProcessInfo.processInfo.environment["TMPDIR"], NSTemporaryDirectory(), "/tmp/"].compactMap({ $0 }) where !dirs.contains(d) { dirs.append(d) }
        for dir in dirs {
            for i in 0..<10 {
                let path = (dir as NSString).appendingPathComponent("discord-ipc-\(i)")
                // Only a socket that belongs to you: /tmp is shared, and another account on this Mac
                // could leave a fake "discord-ipc-0" there to read what you're playing.
                var st = stat()
                guard lstat(path, &st) == 0, st.st_uid == getuid(), (st.st_mode & S_IFMT) == S_IFSOCK else { continue }
                let s = socket(AF_UNIX, SOCK_STREAM, 0)
                guard s >= 0 else { continue }
                var one: Int32 = 1
                setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
                var tv = timeval(tv_sec: 2, tv_usec: 0)
                setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
                setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
                var addr = sockaddr_un()
                addr.sun_family = sa_family_t(AF_UNIX)
                let bytes = Array(path.utf8CString)
                let room = MemoryLayout.size(ofValue: addr.sun_path)
                guard bytes.count <= room else { close(s); continue }
                withUnsafeMutableBytes(of: &addr.sun_path) { raw in
                    bytes.withUnsafeBytes { src in raw.copyMemory(from: src) }
                }
                let len = socklen_t(MemoryLayout<sockaddr_un>.size)
                let r = withUnsafePointer(to: &addr) { p in
                    p.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(s, $0, len) }
                }
                if r != 0 { close(s); continue }
                fd = s
                guard send(0, ["v": 1, "client_id": appId]), let reply = read() else { disconnect(); continue }
                if reply.op == 2 {                                       // Discord closed: usually a wrong application ID
                    state = "Discord said: " + ((reply.json["message"] as? String) ?? "invalid application ID")
                    disconnect()
                    return false
                }
                connectedId = appId
                state = "connected"
                return true
            }
        }
        state = "waiting for Discord (is the Discord app open?)"
        return false
    }

    private func disconnect() {
        if fd >= 0 { close(fd) }
        fd = -1
        connectedId = ""
    }

    /// One message: 4-byte opcode, 4-byte length (little-endian), then JSON.
    private func send(_ op: UInt32, _ obj: [String: Any]) -> Bool {
        guard fd >= 0, let body = try? JSONSerialization.data(withJSONObject: obj) else { return false }
        var frame = Data()
        var o = op.littleEndian, l = UInt32(body.count).littleEndian
        withUnsafeBytes(of: &o) { frame.append(contentsOf: $0) }
        withUnsafeBytes(of: &l) { frame.append(contentsOf: $0) }
        frame.append(body)
        return frame.withUnsafeBytes { raw -> Bool in
            guard let base = raw.baseAddress else { return false }
            var off = 0
            while off < raw.count {
                let n = Darwin.write(fd, base + off, raw.count - off)
                if n <= 0 { return false }
                off += n
            }
            return true
        }
    }

    private func readExactly(_ count: Int) -> Data? {
        var out = Data(count: count)
        var off = 0
        let ok = out.withUnsafeMutableBytes { raw -> Bool in
            guard let base = raw.baseAddress else { return false }
            while off < count {
                let n = Darwin.read(fd, base + off, count - off)
                if n <= 0 { return false }
                off += n
            }
            return true
        }
        return ok ? out : nil
    }

    private func read() -> (op: UInt32, json: [String: Any])? {
        guard fd >= 0, let head = readExactly(8) else { return nil }
        let op = head.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 0, as: UInt32.self) }.littleEndian
        let len = Int(head.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 4, as: UInt32.self) }.littleEndian)
        guard len >= 0, len < 1 << 20, let body = readExactly(len) else { return nil }
        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        return (op, json)
    }
}
