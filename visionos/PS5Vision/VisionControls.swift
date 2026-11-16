import Foundation

/// A button on the controller, named as the bridge names it.
enum PadTarget: String, CaseIterable, Identifiable {
    case cross = "CROSS", circle = "CIRCLE", square = "SQUARE", triangle = "TRIANGLE"
    case l1 = "L1", r1 = "R1", l2 = "L2", r2 = "R2", l3 = "L3", r3 = "R3"
    case up = "DPAD_UP", down = "DPAD_DOWN", left = "DPAD_LEFT", right = "DPAD_RIGHT"
    case options = "OPTIONS", create = "CREATE", ps = "PS", touchpad = "TOUCHPAD"

    var id: String { rawValue }

    /// Its bit in the state the console expects (same as web/controller.js);
    /// nil for the two triggers, which are pressed by amount.
    var bit: Int? {
        switch self {
        case .cross: 1 << 0
        case .circle: 1 << 1
        case .square: 1 << 2
        case .triangle: 1 << 3
        case .left: 1 << 4
        case .right: 1 << 5
        case .up: 1 << 6
        case .down: 1 << 7
        case .l1: 1 << 8
        case .r1: 1 << 9
        case .l3: 1 << 10
        case .r3: 1 << 11
        case .options: 1 << 12
        case .create: 1 << 13
        case .touchpad: 1 << 14
        case .ps: 1 << 15
        case .l2, .r2: nil
        }
    }

    /// What it is called on the controller.
    var name: String {
        switch self {
        case .cross: "Cross"
        case .circle: "Circle"
        case .square: "Square"
        case .triangle: "Triangle"
        case .up: "D-pad up"
        case .down: "D-pad down"
        case .left: "D-pad left"
        case .right: "D-pad right"
        case .options: "Options"
        case .create: "Create"
        case .ps: "Home"
        case .touchpad: "Touchpad"
        case .l1, .r1, .l2, .r2, .l3, .r3: rawValue
        }
    }
}

/// What the hands and the floating buttons are pressing, on top of whatever
/// a real controller is doing. Sticks run -32767...32767, down and right
/// positive; triggers 0...255.
struct ExtraInput: Equatable {
    var buttons = 0
    var l2 = 0
    var r2 = 0
    var lx = 0
    var ly = 0
    var rx = 0
    var ry = 0

    var isIdle: Bool { self == ExtraInput() }

    mutating func press(_ target: PadTarget) {
        switch target {
        case .l2: l2 = 255
        case .r2: r2 = 255
        default: buttons |= target.bit ?? 0
        }
    }

    func merged(with other: ExtraInput) -> ExtraInput {
        let sum = { (a: Int, b: Int) in max(-32767, min(32767, a + b)) }
        return ExtraInput(
            buttons: buttons | other.buttons,
            l2: max(l2, other.l2), r2: max(r2, other.r2),
            lx: sum(lx, other.lx), ly: sum(ly, other.ly),
            rx: sum(rx, other.rx), ry: sum(ry, other.ry)
        )
    }
}

/// What pinching thumb and index finger and moving the hand does.
enum HandDrag: String {
    case leftStick = "LS", rightStick = "RS", dpad = "DPAD", none = "NONE"

    var name: String {
        switch self {
        case .leftStick: "move"
        case .rightStick: "look"
        case .dpad: "D-pad"
        case .none: ""
        }
    }
}

enum Finger: CaseIterable {
    case middle, ring, little
}

/// The thumb touching another finger of one hand.
enum HandGesture: String, CaseIterable, Identifiable {
    case rightMiddle, leftMiddle, rightRing, leftRing, rightLittle, leftLittle

    var id: String { rawValue }
    var isLeft: Bool { self == .leftMiddle || self == .leftRing || self == .leftLittle }
    var finger: Finger {
        switch self {
        case .rightMiddle, .leftMiddle: .middle
        case .rightRing, .leftRing: .ring
        case .rightLittle, .leftLittle: .little
        }
    }
    var name: String {
        let hand = isLeft ? "Left" : "Right"
        switch finger {
        case .middle: return "\(hand) middle"
        case .ring: return "\(hand) ring"
        case .little: return "\(hand) little"
        }
    }
}

/// How one game is played with bare hands: which gesture presses what, and
/// which buttons float under the screen. Built per game on the Mac (by
/// Claude, with the keyboard layout) and handed over by the page; until then,
/// a general set that works the PS5's menus and most games.
struct VisionControls: Equatable {
    var id = "standard"
    var game = "Any game"
    /// Made for this particular game, rather than the general set.
    var built = false
    /// What each button does in this game: "reload", "jump".
    var labels: [PadTarget: String] = [.cross: "select", .circle: "back", .ps: "home"]
    var leftDrag = HandDrag.leftStick
    var rightDrag = HandDrag.rightStick
    var gestures: [HandGesture: PadTarget] = [
        .rightMiddle: .cross, .leftMiddle: .square, .rightRing: .r2, .leftRing: .l2,
        .rightLittle: .circle, .leftLittle: .triangle,
    ]
    var panel: [PadTarget] = [.up, .down, .left, .right, .options, .ps]

    init() {}

    /// From the page's "controls" message. Everything in it was already
    /// checked on the Mac; anything unknown here is simply left out.
    init?(message: [String: Any]) {
        guard let vision = message["vision"] as? [String: Any] else { return nil }
        id = message["id"] as? String ?? "game"
        game = message["name"] as? String ?? "This game"
        built = message["built"] as? Bool ?? false
        labels = [:]
        for (key, value) in message["labels"] as? [String: String] ?? [:] {
            if let target = PadTarget(rawValue: key) { labels[target] = String(value.prefix(28)) }
        }
        leftDrag = HandDrag(rawValue: vision["leftDrag"] as? String ?? "") ?? .leftStick
        rightDrag = HandDrag(rawValue: vision["rightDrag"] as? String ?? "") ?? .rightStick
        gestures = [:]
        for (key, value) in vision["gestures"] as? [String: String] ?? [:] {
            if let gesture = HandGesture(rawValue: key), let target = PadTarget(rawValue: value) { gestures[gesture] = target }
        }
        panel = (vision["panel"] as? [String] ?? []).compactMap(PadTarget.init(rawValue:))
    }

    /// Every button neither a gesture nor the panel reaches, so nothing in
    /// any game is out of reach.
    var more: [PadTarget] {
        let reached = Set(gestures.values).union(panel)
        return PadTarget.allCases.filter { !reached.contains($0) }
    }

    /// "reload", or the button's own name when the game has none for it.
    func label(for target: PadTarget) -> String {
        labels[target] ?? target.name
    }
}

/// The colours along the edges of the picture, 0...1, for lighting the room.
struct Ambient: Equatable {
    var all: SIMD3<Float>
    var top: SIMD3<Float>
    var bottom: SIMD3<Float>
    var left: SIMD3<Float>
    var right: SIMD3<Float>

    init?(message: [String: Any]) {
        func colour(_ key: String) -> SIMD3<Float>? {
            guard let parts = message[key] as? [NSNumber], parts.count == 3 else { return nil }
            return SIMD3(parts[0].floatValue, parts[1].floatValue, parts[2].floatValue) / 255
        }
        guard let all = colour("all") else { return nil }
        self.all = all
        top = colour("top") ?? all
        bottom = colour("bottom") ?? all
        left = colour("left") ?? all
        right = colour("right") ?? all
    }
}
