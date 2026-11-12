import CoreHaptics
import Foundation
import GameController

/// Reads the controller paired with the headset and hands its state to the
/// page, which sends it to the PS5. Reading it natively means every button
/// works, the PS button included, and rumble reaches the controller.
@Observable
final class NativeController {
    private(set) var name: String?

    /// Runs JavaScript in the page; set while a screen is open.
    var sink: ((String) -> Void)?

    private var pollTask: Task<Void, Never>?
    private var lastScript = ""
    private var lastSentAt = Date.distantPast
    private var hapticEngine: CHHapticEngine?
    private var rumblePlayer: CHHapticPatternPlayer?

    // Bit positions the console expects (same as web/controller.js).
    private enum Bit {
        static let cross = 1 << 0, circle = 1 << 1, square = 1 << 2, triangle = 1 << 3
        static let left = 1 << 4, right = 1 << 5, up = 1 << 6, down = 1 << 7
        static let l1 = 1 << 8, r1 = 1 << 9, l3 = 1 << 10, r3 = 1 << 11
        static let options = 1 << 12, create = 1 << 13, touchpad = 1 << 14, ps = 1 << 15
    }

    init() {
        let center = NotificationCenter.default
        center.addObserver(forName: .GCControllerDidConnect, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.controllersChanged() }
        }
        center.addObserver(forName: .GCControllerDidDisconnect, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.controllersChanged() }
        }
        controllersChanged()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                self?.poll()
                try? await Task.sleep(for: .milliseconds(8))
            }
        }
    }

    private var current: GCController? {
        GCController.current ?? GCController.controllers().first { $0.extendedGamepad != nil }
    }

    private func controllersChanged() {
        let controller = current
        name = controller?.vendorName
        hapticEngine = nil
        rumblePlayer = nil
        // Let the PS button reach the game instead of opening the system menu.
        controller?.extendedGamepad?.buttonHome?.preferredSystemGestureState = .disabled
        controller?.extendedGamepad?.buttonMenu.preferredSystemGestureState = .disabled
        controller?.extendedGamepad?.buttonOptions?.preferredSystemGestureState = .disabled
    }

    private func poll() {
        guard let sink, let pad = current?.extendedGamepad else { return }
        var buttons = 0
        func add(_ pressed: Bool, _ bit: Int) { if pressed { buttons |= bit } }
        add(pad.buttonA.isPressed, Bit.cross)
        add(pad.buttonB.isPressed, Bit.circle)
        add(pad.buttonX.isPressed, Bit.square)
        add(pad.buttonY.isPressed, Bit.triangle)
        add(pad.dpad.left.isPressed, Bit.left)
        add(pad.dpad.right.isPressed, Bit.right)
        add(pad.dpad.up.isPressed, Bit.up)
        add(pad.dpad.down.isPressed, Bit.down)
        add(pad.leftShoulder.isPressed, Bit.l1)
        add(pad.rightShoulder.isPressed, Bit.r1)
        add(pad.leftThumbstickButton?.isPressed ?? false, Bit.l3)
        add(pad.rightThumbstickButton?.isPressed ?? false, Bit.r3)
        add(pad.buttonMenu.isPressed, Bit.options)
        add(pad.buttonOptions?.isPressed ?? false, Bit.create)
        add(pad.buttonHome?.isPressed ?? false, Bit.ps)
        if let dualSense = pad as? GCDualSenseGamepad { add(dualSense.touchpadButton.isPressed, Bit.touchpad) }

        let trigger = { (value: Float) in Int((max(0, min(1, value)) * 255).rounded()) }
        // The console counts down as positive, the opposite of GameController.
        let stick = { (value: Float) in abs(value) < 0.02 ? 0 : Int((max(-1, min(1, value)) * 32767).rounded()) }
        let script = "window.ps5NativeInput&&ps5NativeInput({buttons:\(buttons),"
            + "l2:\(trigger(pad.leftTrigger.value)),r2:\(trigger(pad.rightTrigger.value)),"
            + "lx:\(stick(pad.leftThumbstick.xAxis.value)),ly:\(stick(-pad.leftThumbstick.yAxis.value)),"
            + "rx:\(stick(pad.rightThumbstick.xAxis.value)),ry:\(stick(-pad.rightThumbstick.yAxis.value))})"

        // Send changes at once, and repeat the current state now and then so
        // the page knows the controller is still there.
        let now = Date()
        guard script != lastScript || now.timeIntervalSince(lastSentAt) > 0.1 else { return }
        sink(script)
        lastScript = script
        lastSentAt = now
    }

    /// The console's rumble levels, 0–255 for each motor.
    func rumble(left: Double, right: Double) {
        rumblePlayer.map { try? $0.stop(atTime: CHHapticTimeImmediate) }
        rumblePlayer = nil
        let strength = Float(max(left, right) / 255)
        guard strength > 0, let engine = engine() else { return }
        let event = CHHapticEvent(
            eventType: .hapticContinuous,
            parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: min(1, strength)),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: Float(right / 255) * 0.5),
            ],
            relativeTime: 0,
            duration: 5 // until the console sends the next level
        )
        guard let pattern = try? CHHapticPattern(events: [event], parameters: []),
              let player = try? engine.makePlayer(with: pattern) else { return }
        try? player.start(atTime: CHHapticTimeImmediate)
        rumblePlayer = player
    }

    private func engine() -> CHHapticEngine? {
        if let hapticEngine { return hapticEngine }
        guard let engine = current?.haptics?.createEngine(withLocality: .default) else { return nil }
        engine.isAutoShutdownEnabled = true
        try? engine.start()
        hapticEngine = engine
        return engine
    }
}
