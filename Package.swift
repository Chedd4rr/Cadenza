// swift-tools-version:5.9
// Run ./build.sh rather than swift build on its own: it also puts the app together, bundles librespot
// (see librespot.sh) and signs everything.
import PackageDescription

let package = Package(
    name: "Cadenza",
    platforms: [.macOS(.v13)],
    targets: [
        // A tiny Objective-C helper: catches the exceptions Apple's audio engine throws when it refuses
        // to start (Swift can't), so a refusal is logged and retried instead of crashing Cadenza.
        .target(name: "ObjCSafe", path: "Sources/ObjCSafe"),
        .executableTarget(
            name: "Cadenza",
            dependencies: ["ObjCSafe"],
            path: "Sources/Cadenza",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit"),
                .linkedFramework("CoreAudio"),
                .linkedFramework("MediaPlayer"),
                .linkedFramework("Carbon"),
                .linkedFramework("ServiceManagement"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("UserNotifications"),
                // Apple Intelligence (macOS 26+). Weak-linked so the app still opens on older macOS.
                .unsafeFlags(["-Xlinker", "-weak_framework", "-Xlinker", "FoundationModels"]),
                // Lyrics translation (macOS 15+), weak-linked for the same reason.
                .unsafeFlags(["-Xlinker", "-weak_framework", "-Xlinker", "Translation"]),
            ]
        ),
    ]
)
