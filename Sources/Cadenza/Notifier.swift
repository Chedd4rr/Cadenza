import AppKit
import UserNotifications

/// "Now playing" pop-up when the track changes while Cadenza isn't the app in front.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    var enabled = true
    var onClick: (() -> Void)?
    private var lastKey: String?
    private var requested = false

    func start() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        requestPermission()
    }

    func requestPermission() {
        guard !requested else { return }
        requested = true
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) { _, _ in }
    }

    /// Called with every now-playing update; only posts when the song itself changes.
    func update(_ info: [String: Any]) {
        guard let title = info["title"] as? String, !title.isEmpty else { return }
        let artist = (info["artist"] as? String) ?? ""
        let key = title + "|" + artist
        let first = lastKey == nil
        guard key != lastKey else { return }
        lastKey = key
        guard enabled, !first, !NSApp.isActive else { return }

        let content = UNMutableNotificationContent()
        content.title = title
        let album = (info["album"] as? String) ?? ""
        content.body = album.isEmpty ? artist : "\(artist) · \(album)"
        content.threadIdentifier = "cadenza.nowplaying"

        let post: (UNMutableNotificationContent) -> Void = { c in
            let center = UNUserNotificationCenter.current()
            center.removeDeliveredNotifications(withIdentifiers: ["cadenza.track"])
            center.add(UNNotificationRequest(identifier: "cadenza.track", content: c, trigger: nil))
        }
        guard let art = info["art"] as? String, !art.isEmpty else { return post(content) }
        // Attach the album cover (notifications need it as a file).
        CoverArt.data(art) { data in
            if let data {
                let file = FileManager.default.temporaryDirectory.appendingPathComponent("cadenza-cover-\(UUID().uuidString).jpg")
                if (try? data.write(to: file)) != nil,
                   let attachment = try? UNNotificationAttachment(identifier: "cover", url: file, options: nil) {
                    content.attachments = [attachment]
                }
            }
            post(content)
        }
    }

    // Clicking the notification brings Cadenza forward.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        DispatchQueue.main.async { self.onClick?() }
        completionHandler()
    }
}
