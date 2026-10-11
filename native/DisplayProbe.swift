import AppKit
import CoreGraphics
import Foundation

// One bounded snapshot per invocation. No activation, windows, session content,
// shell commands, or privileged APIs; stdout is exclusively this JSON contract.
struct Rect: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    init(_ rect: NSRect) {
        x = rect.origin.x; y = rect.origin.y
        width = rect.width; height = rect.height
    }
}
struct Insets: Codable {
    let top: Double
    let left: Double
    let bottom: Double
    let right: Double
}
struct Display: Codable {
    let id: UInt32
    let uuid: String?
    let name: String
    let builtIn: Bool
    let frame: Rect
    let visibleFrame: Rect
    let backingScaleFactor: Double
    let safeAreaInsets: Insets
    let auxiliaryLeft: Rect?
    let auxiliaryRight: Rect?
}
struct Snapshot: Codable {
    let version: Int
    let displays: [Display]
}

func usable(_ rect: NSRect?) -> Rect? {
    guard let rect, !rect.isEmpty else { return nil }
    return Rect(rect)
}

guard CommandLine.arguments == [CommandLine.arguments[0], "--snapshot"] else {
    FileHandle.standardError.write(Data("Expected --snapshot\n".utf8))
    exit(2)
}
NSApplication.shared.setActivationPolicy(.prohibited)
let displays: [Display] = NSScreen.screens.compactMap { screen in
    guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else {
        return nil
    }
    let id = number.uint32Value
    let uuid = CGDisplayCreateUUIDFromDisplayID(id).map {
        CFUUIDCreateString(nil, $0.takeRetainedValue()) as String
    }
    let inset = screen.safeAreaInsets
    return Display(
        id: id, uuid: uuid, name: screen.localizedName,
        builtIn: CGDisplayIsBuiltin(id) != 0,
        frame: Rect(screen.frame), visibleFrame: Rect(screen.visibleFrame),
        backingScaleFactor: screen.backingScaleFactor,
        safeAreaInsets: Insets(top: inset.top, left: inset.left, bottom: inset.bottom, right: inset.right),
        auxiliaryLeft: usable(screen.auxiliaryTopLeftArea),
        auxiliaryRight: usable(screen.auxiliaryTopRightArea)
    )
}
do {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(Snapshot(version: 1, displays: displays))
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    FileHandle.standardError.write(Data("Display snapshot encoding failed\n".utf8))
    exit(1)
}
