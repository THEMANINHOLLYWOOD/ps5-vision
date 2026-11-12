import SwiftUI

@main
struct PS5VisionApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup(id: "launcher") {
            LauncherView()
                .environment(model)
        }
        .windowResizability(.contentSize)

        // The PS5's screen. Its size can be dragged from the corner or picked
        // under it; it always stays 16:9.
        WindowGroup(id: "screen", for: Bridge.self) { $bridge in
            if let bridge {
                ScreenView(bridge: bridge)
                    .environment(model)
            }
        }
        .defaultSize(width: ScreenSize.standard.size.width, height: ScreenSize.standard.size.height)

        // The room exactly as it looks, plus a Connect button over the PS5.
        ImmersiveSpace(id: "room") {
            RoomView()
                .environment(model)
        }
        .immersionStyle(selection: .constant(.mixed), in: .mixed)
    }
}
