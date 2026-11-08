import AppKit

Migration.run()          // settings and data from when the app was called Chord

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
