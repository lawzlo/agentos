import AppKit
import CoreGraphics
import Foundation
import Vision

enum HelperError: Error {
    case invalidArguments(String)
    case unsupported(String)
    case captureFailed
}

struct Json {
    static func printObject(_ value: Any) {
        let data = try! JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
}

func parsePoint(_ x: String, _ y: String) throws -> CGPoint {
    guard let xValue = Double(x), let yValue = Double(y) else {
        throw HelperError.invalidArguments("Expected numeric x and y arguments.")
    }
    return CGPoint(x: xValue, y: yValue)
}

func captureScreen(to path: String) throws -> [String: Any] {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", path]
    try process.run()
    process.waitUntilExit()

    guard process.terminationStatus == 0 else {
        throw HelperError.captureFailed
    }

    return ["ok": true, "path": path]
}

func normalizedBoxToPixels(_ box: CGRect, width: CGFloat, height: CGFloat) -> [String: Double] {
    let rect = CGRect(
        x: box.origin.x * width,
        y: (1 - box.origin.y - box.height) * height,
        width: box.width * width,
        height: box.height * height
    )

    return [
        "x": rect.origin.x,
        "y": rect.origin.y,
        "width": rect.width,
        "height": rect.height,
        "centerX": rect.midX,
        "centerY": rect.midY
    ]
}

func recognizeText(in image: CGImage) throws -> [[String: Any]] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])

    let width = CGFloat(image.width)
    let height = CGFloat(image.height)

    return (request.results ?? []).compactMap { observation in
        guard let topCandidate = observation.topCandidates(1).first else {
            return nil
        }

        return [
            "text": topCandidate.string,
            "confidence": topCandidate.confidence,
            "box": normalizedBoxToPixels(observation.boundingBox, width: width, height: height)
        ]
    }
}

func findBestTextMatch(in image: CGImage, query: String) throws -> [String: Any] {
    let observations = try recognizeText(in: image)
    let queryLower = query.lowercased()

    let ranked = observations.compactMap { observation -> (score: Int, value: [String: Any])? in
        guard let text = observation["text"] as? String else {
            return nil
        }

        let lower = text.lowercased()
        if lower == queryLower {
          return (2, observation)
        }
        if lower.contains(queryLower) {
          return (1, observation)
        }
        return nil
    }.sorted { lhs, rhs in
        if lhs.score != rhs.score {
            return lhs.score > rhs.score
        }
        let lhsConfidence = lhs.value["confidence"] as? Float ?? 0
        let rhsConfidence = rhs.value["confidence"] as? Float ?? 0
        return lhsConfidence > rhsConfidence
    }

    if let match = ranked.first {
        return ["found": true, "match": match.value, "count": observations.count]
    }

    return ["found": false, "count": observations.count]
}

func postMouseEvent(type: CGEventType, point: CGPoint, button: CGMouseButton = .left) {
    let source = CGEventSource(stateID: .hidSystemState)
    let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button)
    event?.post(tap: .cghidEventTap)
}

func click(at point: CGPoint) {
    postMouseEvent(type: .mouseMoved, point: point)
    postMouseEvent(type: .leftMouseDown, point: point)
    postMouseEvent(type: .leftMouseUp, point: point)
}

func moveMouse(to point: CGPoint) {
    postMouseEvent(type: .mouseMoved, point: point)
}

func scroll(dx: Int32, dy: Int32) {
    let source = CGEventSource(stateID: .hidSystemState)
    let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
    event?.post(tap: .cghidEventTap)
}

func typeText(_ text: String) {
    let source = CGEventSource(stateID: .hidSystemState)
    let characters = Array(text.utf16)
    let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
    down?.keyboardSetUnicodeString(stringLength: characters.count, unicodeString: characters)
    down?.post(tap: .cghidEventTap)
    let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
    up?.keyboardSetUnicodeString(stringLength: characters.count, unicodeString: characters)
    up?.post(tap: .cghidEventTap)
}

let keyCodes: [String: CGKeyCode] = [
    "return": 36,
    "enter": 36,
    "tab": 48,
    "space": 49,
    "escape": 53,
    "delete": 51,
    "left": 123,
    "right": 124,
    "down": 125,
    "up": 126
]

func modifierFlags(from modifiers: [String]) -> CGEventFlags {
    modifiers.reduce([]) { partial, item in
        switch item.lowercased() {
        case "shift":
            return partial.union(.maskShift)
        case "command", "cmd":
            return partial.union(.maskCommand)
        case "control", "ctrl":
            return partial.union(.maskControl)
        case "option", "alt":
            return partial.union(.maskAlternate)
        default:
            return partial
        }
    }
}

func keyPress(_ key: String, modifiers: [String]) throws {
    guard let code = keyCodes[key.lowercased()] else {
        throw HelperError.unsupported("Unsupported key: \(key)")
    }

    let source = CGEventSource(stateID: .hidSystemState)
    let flags = modifierFlags(from: modifiers)
    let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
    down?.flags = flags
    down?.post(tap: .cghidEventTap)
    let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
    up?.flags = flags
    up?.post(tap: .cghidEventTap)
}

func frontmostApp() -> [String: Any] {
    let app = NSWorkspace.shared.frontmostApplication
    return [
        "appName": app?.localizedName ?? "Unknown",
        "bundleIdentifier": app?.bundleIdentifier ?? ""
    ]
}

let arguments = CommandLine.arguments

do {
    guard arguments.count >= 2 else {
        throw HelperError.invalidArguments("Missing command.")
    }

    switch arguments[1] {
    case "frontmost-app":
        Json.printObject(frontmostApp())
    case "capture-screen":
        guard arguments.count >= 3 else {
            throw HelperError.invalidArguments("capture-screen requires a destination path.")
        }
        Json.printObject(try captureScreen(to: arguments[2]))
    case "ocr-image":
        guard arguments.count >= 3 else {
            throw HelperError.invalidArguments("ocr-image requires an image path.")
        }
        guard let image = NSImage(contentsOfFile: arguments[2]),
              let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let cgImage = bitmap.cgImage else {
            throw HelperError.invalidArguments("Could not open image at path \(arguments[2]).")
        }
        Json.printObject(["observations": try recognizeText(in: cgImage)])
    case "find-text":
        guard arguments.count >= 4 else {
            throw HelperError.invalidArguments("find-text requires an image path and query.")
        }
        guard let image = NSImage(contentsOfFile: arguments[2]),
              let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let cgImage = bitmap.cgImage else {
            throw HelperError.invalidArguments("Could not open image at path \(arguments[2]).")
        }
        Json.printObject(try findBestTextMatch(in: cgImage, query: arguments[3]))
    case "click-at":
        guard arguments.count >= 4 else {
            throw HelperError.invalidArguments("click-at requires x and y.")
        }
        let point = try parsePoint(arguments[2], arguments[3])
        click(at: point)
        Json.printObject(["ok": true, "x": point.x, "y": point.y])
    case "move-mouse":
        guard arguments.count >= 4 else {
            throw HelperError.invalidArguments("move-mouse requires x and y.")
        }
        let point = try parsePoint(arguments[2], arguments[3])
        moveMouse(to: point)
        Json.printObject(["ok": true, "x": point.x, "y": point.y])
    case "scroll":
        guard arguments.count >= 4,
              let dx = Int32(arguments[2]),
              let dy = Int32(arguments[3]) else {
            throw HelperError.invalidArguments("scroll requires integer dx and dy.")
        }
        scroll(dx: dx, dy: dy)
        Json.printObject(["ok": true, "dx": dx, "dy": dy])
    case "type-text":
        guard arguments.count >= 3 else {
            throw HelperError.invalidArguments("type-text requires text.")
        }
        typeText(arguments[2])
        Json.printObject(["ok": true, "typed": arguments[2].count])
    case "key-press":
        guard arguments.count >= 3 else {
            throw HelperError.invalidArguments("key-press requires a key.")
        }
        let modifiers = arguments.count >= 4 ? arguments[3].split(separator: ",").map(String.init) : []
        try keyPress(arguments[2], modifiers: modifiers)
        Json.printObject(["ok": true, "key": arguments[2], "modifiers": modifiers])
    default:
        throw HelperError.invalidArguments("Unknown command: \(arguments[1])")
    }
} catch {
    let message: String
    switch error {
    case let helperError as HelperError:
        switch helperError {
        case .invalidArguments(let detail):
            message = detail
        case .unsupported(let detail):
            message = detail
        case .captureFailed:
            message = "Failed to capture the screen."
        }
    default:
        message = error.localizedDescription
    }

    Json.printObject(["error": message])
    exit(1)
}
