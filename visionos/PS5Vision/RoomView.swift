import RealityKit
import SwiftUI

/// The room as it is, with nothing added but a Connect button over the PS5.
struct RoomView: View {
    @Environment(AppModel.self) private var model
    @State private var spot = ConsoleSpot()

    var body: some View {
        RealityView { content, attachments in
            content.add(spot.root)
            if let badge = attachments.entity(for: "badge") {
                badge.components.set(BillboardComponent())
                spot.attachBadge(badge)
            }
        } attachments: {
            Attachment(id: "badge") {
                ConnectBadge(spot: spot)
            }
        }
        .gesture(
            DragGesture()
                .targetedToEntity(spot.marker)
                .onChanged { value in
                    guard model.placingSpot, let parent = value.entity.parent else { return }
                    value.entity.position = value.convert(value.location3D, from: .local, to: parent)
                }
        )
        .task { await spot.run() }
        .onChange(of: model.placingSpot, initial: true) { _, placing in
            if placing { Task { await spot.startPlacing() } }
        }
        .onAppear { model.roomOpen = true }
        .onDisappear { model.roomOpen = false }
    }
}

/// Floats above the PS5. Looking at it lights it up; a pinch connects.
private struct ConnectBadge: View {
    let spot: ConsoleSpot
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow

    private var visible: Bool { model.placingSpot || spot.facing }

    var body: some View {
        VStack(spacing: 14) {
            if model.placingSpot {
                Text("Drag the blue ring onto your PS5")
                    .font(.title.weight(.semibold))
                Text("Pinch the ring and move it. You only do this once.")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                Button("Done") {
                    Task {
                        await spot.savePlacement()
                        model.placingSpot = false
                        model.spotSaved = true
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.extraLarge)
            } else if let bridge = model.bridge {
                Button {
                    if model.screenOpen {
                        dismissWindow(id: "screen", value: bridge)
                    } else {
                        openWindow(id: "screen", value: bridge)
                    }
                } label: {
                    Label(model.screenOpen ? "Disconnect" : "Connect", systemImage: "gamecontroller.fill")
                        .font(.largeTitle.weight(.semibold))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .hoverEffect(.highlight)
                Text(bridge.consoleName ?? "PS5")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            } else {
                Text("Start the bridge on your Mac")
                    .font(.title.weight(.semibold))
                Text("In the ps5-vision folder, run npm start")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
            if let problem = spot.problem {
                Text(problem)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: 360)
            }
        }
        .padding(32)
        .glassBackgroundEffect()
        .opacity(visible ? 1 : 0)
        .allowsHitTesting(visible)
        .animation(.easeInOut(duration: 0.3), value: visible)
    }
}
