import Carbon

/// A system-wide keyboard shortcut (works even when the app is in the background).
final class HotKey {
    private var ref: EventHotKeyRef?
    private static var handler: (() -> Void)?
    private static var installed = false

    /// keyCode: e.g. kVK_ANSI_P; modifiers: e.g. cmdKey | optionKey
    init(keyCode: Int, modifiers: Int, handler: @escaping () -> Void) {
        HotKey.handler = handler
        if !HotKey.installed {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
                DispatchQueue.main.async { HotKey.handler?() }
                return noErr
            }, 1, &spec, nil, nil)
            HotKey.installed = true
        }
        let id = EventHotKeyID(signature: OSType(0x5033504C), id: 1)   // 'P3PL'
        RegisterEventHotKey(UInt32(keyCode), UInt32(modifiers), id, GetApplicationEventTarget(), 0, &ref)
    }

    func unregister() {
        if let ref { UnregisterEventHotKey(ref) }
        ref = nil
    }

    deinit { unregister() }
}
