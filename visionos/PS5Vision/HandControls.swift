import ARKit
import Foundation
import QuartzCore
import simd

/// Plays the game with bare hands.
///
/// Pinch thumb and index finger and move that hand: it is a stick, pushed as
/// far as the hand has moved from where the pinch began. Touch the thumb to
/// the middle, ring or little finger: it is a button, held for as long as
/// they touch. Which stick and which button comes from the game's controls.
///
/// Hands are only tracked while an immersive space is open, and only on a
/// real headset.
@Observable
final class HandControls {
    private(set) var running = false
    private(set) var problem: String?
    /// Gestures being held right now, so the guide can light them up.
    private(set) var held: Set<HandGesture> = []
    private(set) var leftDragging = false
    private(set) var rightDragging = false

    var controls = VisionControls() {
        didSet { publish() }
    }
    /// Called whenever what the hands are pressing changes.
    var onChange: ((ExtraInput) -> Void)?

    static var isSupported: Bool { HandTrackingProvider.isSupported }

    private let session = ARKitSession()
    private var task: Task<Void, Never>?
    private var left = Hand()
    private var right = Hand()
    private var last = ExtraInput()

    // Fingertips count as touching inside the first distance, and as apart
    // again beyond the second, so a touch doesn't flicker at the edge.
    private static let touch: Float = 0.018
    private static let apart: Float = 0.032
    /// How far the hand moves, in metres, to push a stick all the way.
    private static let reach: Float = 0.07
    private static let deadZone: Float = 0.16

    private struct Hand {
        var pinching = false
        /// Where the pinch began, and which way the person was facing then.
        var origin = SIMD3<Float>()
        var rightward = SIMD3<Float>(1, 0, 0)
        var forward = SIMD3<Float>(0, 0, -1)
        /// x to the right, y down, each -1...1.
        var stick = SIMD2<Float>()
        var touching: Set<Finger> = []
    }

    func start() {
        guard task == nil else { return }
        task = Task { await run() }
    }

    func stop() {
        task?.cancel()
        task = nil
        session.stop()
        running = false
        left = Hand()
        right = Hand()
        publish()
    }

    private func run() async {
        guard HandTrackingProvider.isSupported else {
            problem = "Hand controls need a real Vision Pro."
            return
        }
        let allowed = await session.requestAuthorization(for: [.handTracking])
        guard allowed[.handTracking] == .allowed else {
            problem = "Allow hand tracking for \(appName) in Settings > Apps to play with your hands."
            return
        }
        let hands = HandTrackingProvider()
        let world = WorldTrackingProvider()
        do {
            try await session.run([hands, world])
        } catch {
            problem = "Can't follow your hands: \(error.localizedDescription)"
            return
        }
        problem = nil
        running = true
        for await update in hands.anchorUpdates {
            if Task.isCancelled { break }
            follow(update.anchor, gone: update.event == .removed, world: world)
        }
        running = false
    }

    private func follow(_ anchor: HandAnchor, gone: Bool, world: WorldTrackingProvider) {
        let isLeft = anchor.chirality == .left
        var hand = isLeft ? left : right
        defer {
            if isLeft { left = hand } else { right = hand }
            publish()
        }
        guard !gone, anchor.isTracked, let skeleton = anchor.handSkeleton else {
            hand = Hand() // out of sight: let go of everything
            return
        }
        func tip(_ name: HandSkeleton.JointName) -> SIMD3<Float>? {
            let joint = skeleton.joint(name)
            guard joint.isTracked else { return nil }
            let place = anchor.originFromAnchorTransform * joint.anchorFromJointTransform
            return SIMD3(place.columns.3.x, place.columns.3.y, place.columns.3.z)
        }
        guard let thumb = tip(.thumbTip) else {
            hand = Hand()
            return
        }

        // Thumb and index finger: the stick.
        let gap = tip(.indexFingerTip).map { simd_distance($0, thumb) } ?? .infinity
        if !hand.pinching, gap < Self.touch {
            hand.pinching = true
            hand.origin = thumb
            hand.stick = .zero
            // "Right" and "forward" are the person's own, as they face now.
            if let head = world.queryDeviceAnchor(atTimestamp: CACurrentMediaTime())?.originFromAnchorTransform {
                var forward = -SIMD3<Float>(head.columns.2.x, 0, head.columns.2.z)
                if simd_length(forward) < 0.01 { forward = [0, 0, -1] }
                hand.forward = simd_normalize(forward)
                hand.rightward = simd_normalize(simd_cross(hand.forward, [0, 1, 0]))
            }
        } else if hand.pinching, gap > Self.apart {
            hand.pinching = false
            hand.stick = .zero
        }
        if hand.pinching {
            let moved = thumb - hand.origin
            // Raising the hand and pushing it away both mean "up".
            var stick = SIMD2<Float>(
                simd_dot(moved, hand.rightward),
                -(moved.y + simd_dot(moved, hand.forward))
            ) / Self.reach
            let push = simd_length(stick)
            if push < Self.deadZone {
                stick = .zero
            } else {
                // Starts from nothing at the edge of the dead zone, and tops out at 1.
                stick *= min(1, (push - Self.deadZone) / (1 - Self.deadZone)) / push
            }
            hand.stick = stick
        }

        // Thumb and each other finger: the buttons.
        for (finger, joint) in [(Finger.middle, HandSkeleton.JointName.middleFingerTip), (.ring, .ringFingerTip), (.little, .littleFingerTip)] {
            let distance = tip(joint).map { simd_distance($0, thumb) } ?? .infinity
            if distance < Self.touch {
                hand.touching.insert(finger)
            } else if distance > Self.apart {
                hand.touching.remove(finger)
            }
        }
    }

    /// Works out what the two hands are pressing and passes it on if it changed.
    private func publish() {
        var input = ExtraInput()
        push(controls.leftDrag, left.stick, into: &input)
        push(controls.rightDrag, right.stick, into: &input)
        var nowHeld: Set<HandGesture> = []
        for (gesture, target) in controls.gestures where (gesture.isLeft ? left : right).touching.contains(gesture.finger) {
            input.press(target)
            nowHeld.insert(gesture)
        }
        if nowHeld != held { held = nowHeld }
        if left.pinching != leftDragging { leftDragging = left.pinching }
        if right.pinching != rightDragging { rightDragging = right.pinching }
        guard input != last else { return }
        last = input
        onChange?(input)
    }

    private func push(_ drag: HandDrag, _ stick: SIMD2<Float>, into input: inout ExtraInput) {
        let amount = { (value: Float) in Int((max(-1, min(1, value)) * 32767).rounded()) }
        switch drag {
        case .leftStick:
            input.lx = amount(stick.x)
            input.ly = amount(stick.y)
        case .rightStick:
            input.rx = amount(stick.x)
            input.ry = amount(stick.y)
        case .dpad:
            if stick.x < -0.5 { input.press(.left) }
            if stick.x > 0.5 { input.press(.right) }
            if stick.y < -0.5 { input.press(.up) }
            if stick.y > 0.5 { input.press(.down) }
        case .none:
            break
        }
    }
}
