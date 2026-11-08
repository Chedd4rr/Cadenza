import CoreAudio
import Foundation

struct AudioOutput {
    let id: AudioDeviceID
    let uid: String
    let name: String
    let transport: String
    let isDefault: Bool

    var dict: [String: Any] { ["uid": uid, "name": name, "transport": transport, "isDefault": isDefault] }
}

/// Lists the Mac's audio outputs (speakers, AirPods, Bluetooth speakers, displays…)
/// and switches the system output. Watches for changes made anywhere in macOS.
final class AudioOutputs {
    var onListChange: (() -> Void)?
    var onDefaultChange: (() -> Void)?
    private var lastDefault: AudioDeviceID = 0
    private let system = AudioObjectID(kAudioObjectSystemObject)

    private func address(_ selector: AudioObjectPropertySelector,
                         _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    func defaultOutput() -> AudioDeviceID {
        var addr = address(kAudioHardwarePropertyDefaultOutputDevice)
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &id)
        return id
    }

    private func stringProperty(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String {
        var addr = address(selector)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &value) { ptr in
            AudioObjectGetPropertyData(id, &addr, 0, nil, &size, ptr)
        }
        guard status == noErr, let v = value else { return "" }
        return v.takeRetainedValue() as String
    }

    private func transport(_ id: AudioDeviceID) -> String {
        var addr = address(kAudioDevicePropertyTransportType)
        var t: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &t)
        switch t {
        case UInt32(kAudioDeviceTransportTypeBluetooth), UInt32(kAudioDeviceTransportTypeBluetoothLE): return "bluetooth"
        case UInt32(kAudioDeviceTransportTypeBuiltIn): return "builtin"
        case UInt32(kAudioDeviceTransportTypeUSB): return "usb"
        case UInt32(kAudioDeviceTransportTypeAirPlay): return "airplay"
        case UInt32(kAudioDeviceTransportTypeHDMI), UInt32(kAudioDeviceTransportTypeDisplayPort): return "display"
        case UInt32(kAudioDeviceTransportTypeVirtual), UInt32(kAudioDeviceTransportTypeAggregate),
             UInt32(kAudioDeviceTransportTypeAutoAggregate): return "virtual"
        default: return "other"
        }
    }

    private func hasOutputStreams(_ id: AudioDeviceID) -> Bool {
        var addr = address(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput)
        var size: UInt32 = 0
        return AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr && size > 0
    }

    func list() -> [AudioOutput] {
        var addr = address(kAudioHardwarePropertyDevices)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
        let current = defaultOutput()
        let order = ["bluetooth": 0, "builtin": 1, "usb": 2, "airplay": 3, "display": 4, "other": 5, "virtual": 6]
        return ids.filter { hasOutputStreams($0) }
            .map { id in
                AudioOutput(id: id,
                            uid: stringProperty(id, kAudioDevicePropertyDeviceUID),
                            name: stringProperty(id, kAudioObjectPropertyName),
                            transport: transport(id),
                            isDefault: id == current)
            }
            // Core Audio makes hidden "CADefaultDeviceAggregate-…" devices for apps' own audio engines
            // (Cadenza's included). They aren't speakers you can pick.
            .filter { !$0.uid.isEmpty && !$0.name.hasPrefix("CADefaultDeviceAggregate") && !$0.uid.hasPrefix("CADefaultDeviceAggregate") }
            .sorted { (order[$0.transport] ?? 9, $0.name) < (order[$1.transport] ?? 9, $1.name) }
    }

    @discardableResult
    func setDefault(uid: String) -> Bool {
        guard let device = list().first(where: { $0.uid == uid }) else { return false }
        var id = device.id
        let size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var output = address(kAudioHardwarePropertyDefaultOutputDevice)
        let status = AudioObjectSetPropertyData(system, &output, 0, nil, size, &id)
        // Also move system sounds, so alerts follow your headphones too.
        var systemOutput = address(kAudioHardwarePropertyDefaultSystemOutputDevice)
        AudioObjectSetPropertyData(system, &systemOutput, 0, nil, size, &id)
        return status == noErr
    }

    func startListening() {
        lastDefault = defaultOutput()
        var defaultAddr = address(kAudioHardwarePropertyDefaultOutputDevice)
        AudioObjectAddPropertyListenerBlock(system, &defaultAddr, DispatchQueue.main) { [weak self] _, _ in
            guard let self else { return }
            let now = self.defaultOutput()
            if now != self.lastDefault {
                self.lastDefault = now
                self.onDefaultChange?()
            }
        }
        var devicesAddr = address(kAudioHardwarePropertyDevices)
        AudioObjectAddPropertyListenerBlock(system, &devicesAddr, DispatchQueue.main) { [weak self] _, _ in
            self?.onListChange?()
        }
    }
}
