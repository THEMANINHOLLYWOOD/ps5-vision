import SwiftUI

/// The small window the app opens with: which bridge it found, and the ways
/// to start playing.
struct LauncherView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openImmersiveSpace) private var openImmersiveSpace
    @Environment(\.dismissImmersiveSpace) private var dismissImmersiveSpace
    @State private var typedAddress = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 6) {
                Text("PS5 Vision")
                    .font(.extraLargeTitle2)
                Text(statusLine)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 14) {
                Button {
                    if let bridge = model.bridge { openWindow(id: "screen", value: bridge) }
                } label: {
                    Label("Open screen", systemImage: "play.rectangle.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.bridge == nil || model.screenOpen)

                Button {
                    Task { await setRoom(open: !model.roomOpen) }
                } label: {
                    Label(model.roomOpen ? "Stop looking for PS5" : "Look at my PS5", systemImage: "eye")
                }
                .disabled(!model.spotSaved && !model.roomOpen)
            }

            Button {
                Task {
                    await setRoom(open: true)
                    model.placingSpot = true
                }
            } label: {
                Label(model.spotSaved ? "Move the PS5 spot" : "Show the app where your PS5 is", systemImage: "scope")
            }

            Text(model.spotSaved
                 ? "Look at your PS5 and pinch Connect, like connecting to a Mac. Resize the screen from its corner, or pick a size under it."
                 : "Show the app where your PS5 is once. After that, a Connect button appears over it whenever you look at it.")
                .font(.callout)
                .foregroundStyle(.secondary)

            DisclosureGroup("Bridge address") {
                VStack(alignment: .leading, spacing: 10) {
                    TextField("Your-Mac.local:8443", text: $typedAddress)
                        .textFieldStyle(.roundedBorder)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .onSubmit(useTypedAddress)
                    HStack {
                        Button("Use this address", action: useTypedAddress)
                            .disabled(Bridge.fromTyped(typedAddress) == nil)
                        if let typed = model.typedBridge {
                            Button("Find it on the network instead") {
                                TrustStore.forget(typed)
                                model.typedBridge = nil
                            }
                        }
                    }
                    Text("Only needed if the bridge isn't found by itself. Use the https address that npm start prints.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 8)
            }
        }
        .padding(40)
        .frame(width: 620)
        .task {
            if model.spotSaved { await setRoom(open: true) }
            // Same as the links, from the command line: launch with `-open connect`.
            if let action = UserDefaults.standard.string(forKey: "open"),
               let url = URL(string: "ps5vision://\(action)") {
                await follow(url)
            }
        }
        // ps5vision://connect opens the screen (handy from Shortcuts),
        // ps5vision://room looks for the PS5, ps5vision://place moves its spot.
        .onOpenURL { url in
            Task { await follow(url) }
        }
    }

    private func follow(_ url: URL) async {
        switch url.host() {
        case "connect":
            // The bridge may still be being looked for when the link arrives.
            for _ in 0..<50 where model.bridge == nil { try? await Task.sleep(for: .milliseconds(100)) }
            if let bridge = model.bridge, !model.screenOpen { openWindow(id: "screen", value: bridge) }
        case "room":
            await setRoom(open: true)
        case "place":
            await setRoom(open: true)
            model.placingSpot = true
        default:
            break
        }
    }

    private var statusLine: String {
        var parts: [String] = []
        if let bridge = model.bridge {
            parts.append("Bridge: \(bridge.name)\(bridge.consoleName.map { " · \($0)" } ?? "")")
        } else if let problem = model.browser.problem {
            parts.append(problem)
        } else {
            parts.append("Looking for the bridge… run npm start on your Mac.")
        }
        parts.append(model.controller.name.map { "Controller: \($0)" }
                     ?? "No controller yet: pair one with this headset in Settings > Bluetooth.")
        return parts.joined(separator: "\n")
    }

    private func useTypedAddress() {
        guard let bridge = Bridge.fromTyped(typedAddress) else { return }
        model.typedBridge = bridge
        typedAddress = ""
    }

    private func setRoom(open: Bool) async {
        if open, !model.roomOpen {
            _ = await openImmersiveSpace(id: "room")
        } else if !open, model.roomOpen {
            model.placingSpot = false
            await dismissImmersiveSpace()
        }
    }
}
