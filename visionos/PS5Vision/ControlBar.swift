import SwiftUI

/// Under the screen: its size, the immersive theatre, playing with hands,
/// and the buttons of the game being played.
struct ControlBar: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openImmersiveSpace) private var openImmersiveSpace
    @Environment(\.dismissImmersiveSpace) private var dismissImmersiveSpace
    @State private var switching = false

    var body: some View {
        VStack(spacing: 10) {
            if model.handsOn && model.theaterOpen && model.hands.problem == nil { HandGuide() }
            if model.buttonsShown { GameButtons() }
            HStack(spacing: 8) {
                Menu {
                    ForEach(ScreenSize.allCases) { size in
                        Button(size.rawValue) { model.screenScene?.lockScreenShape(size: size.size) }
                    }
                } label: {
                    Label("Size", systemImage: "rectangle.expand.diagonal")
                }
                Toggle(isOn: Binding(get: { model.theaterOpen }, set: { on in Task { await setTheater(on) } })) {
                    Label("Immersive", systemImage: "moon.stars.fill")
                }
                .disabled(switching)
                Toggle(isOn: Binding(get: { model.handsOn }, set: { on in
                    model.handsOn = on
                    // Hands can only be followed inside the theatre.
                    if on, !model.theaterOpen { Task { await setTheater(true) } }
                })) {
                    Label("Hands", systemImage: "hand.pinch.fill")
                }
                Toggle(isOn: Binding(get: { model.buttonsShown }, set: { model.buttonsChosen = $0 })) {
                    Label("Buttons", systemImage: "circle.grid.2x2.fill")
                }
                Button {
                    model.controller.sink?("window.ps5BuildForGame&&ps5BuildForGame()")
                } label: {
                    Label(model.controls.built ? "Rebuild for this game" : "Build for this game", systemImage: "sparkles")
                }
                .disabled(model.building)
            }
            .toggleStyle(.button)
            if let note {
                Text(note)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: 760)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(12)
        .glassBackgroundEffect()
    }

    private var note: String? {
        if model.handsOn, model.theaterOpen, let problem = model.hands.problem { return problem }
        if !model.buildNote.isEmpty { return model.buildNote }
        if model.controls.built { return "Controls for \(model.controls.game)" }
        return nil
    }

    private func setTheater(_ on: Bool) async {
        guard !switching, on != model.theaterOpen else { return }
        switching = true
        defer { switching = false }
        if on {
            // One immersive space at a time: the room with the Connect
            // button makes way, and comes back afterwards.
            if model.roomOpen {
                await dismissImmersiveSpace()
                try? await Task.sleep(for: .milliseconds(400))
            }
            _ = await openImmersiveSpace(id: "theater")
        } else {
            await dismissImmersiveSpace()
            if model.spotSaved {
                try? await Task.sleep(for: .milliseconds(400))
                _ = await openImmersiveSpace(id: "room")
            }
        }
    }
}

/// What each hand does in this game, lighting up as it is done: the quickest
/// way to learn a set of controls nobody has seen before.
private struct HandGuide: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 6) {
            row(left: true)
            row(left: false)
        }
    }

    private func row(left: Bool) -> some View {
        let controls = model.controls
        let hands = model.hands
        let drag = left ? controls.leftDrag : controls.rightDrag
        return HStack(spacing: 6) {
            if drag != .none {
                chip("\(left ? "Left" : "Right") pinch and move", drag.name, lit: left ? hands.leftDragging : hands.rightDragging)
            }
            ForEach(HandGesture.allCases.filter { $0.isLeft == left }) { gesture in
                if let target = controls.gestures[gesture] {
                    chip("\(gesture.name) finger", controls.label(for: target), lit: hands.held.contains(gesture))
                }
            }
        }
    }

    private func chip(_ how: String, _ what: String, lit: Bool) -> some View {
        HStack(spacing: 6) {
            Text(how)
                .foregroundStyle(.secondary)
            Text(what)
                .fontWeight(.semibold)
        }
        .font(.callout)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(lit ? AnyShapeStyle(.tint) : AnyShapeStyle(.thinMaterial), in: .capsule)
    }
}

/// The game's buttons, to look at and pinch: the ones chosen for this game
/// first, every other button of the controller under the dots.
private struct GameButtons: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 8) {
            ForEach(model.controls.panel) { target in
                GameButton(target: target)
            }
            Menu {
                ForEach(model.controls.more) { target in
                    Button(model.controls.labels[target].map { "\($0) (\(target.name))" } ?? target.name) {
                        model.press(target)
                        Task {
                            try? await Task.sleep(for: .milliseconds(120))
                            model.release(target)
                        }
                    }
                }
            } label: {
                Label("More buttons", systemImage: "ellipsis")
                    .labelStyle(.iconOnly)
            }
        }
    }
}

/// Held for as long as the pinch is.
private struct GameButton: View {
    let target: PadTarget
    @Environment(AppModel.self) private var model
    @State private var down = false

    var body: some View {
        VStack(spacing: 1) {
            Text(model.controls.label(for: target))
                .font(.headline)
            if model.controls.labels[target] != nil {
                Text(target.name)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(minWidth: 84, minHeight: 48)
        .background(down ? AnyShapeStyle(.tint) : AnyShapeStyle(.thinMaterial), in: .capsule)
        .contentShape(.capsule)
        .hoverEffect()
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    guard !down else { return }
                    down = true
                    model.press(target)
                }
                .onEnded { _ in
                    down = false
                    Task {
                        // Long enough that the quickest pinch is still a press.
                        try? await Task.sleep(for: .milliseconds(90))
                        if !down { model.release(target) }
                    }
                }
        )
        .accessibilityLabel(model.controls.label(for: target))
        .accessibilityAddTraits(.isButton)
    }
}
