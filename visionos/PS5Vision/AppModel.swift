import Foundation
import UIKit

/// The app's name as people see it (set once, as APP_NAME in project.yml).
let appName = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Lookplay"
/// Where setting up the Mac side is explained.
let setupGuide = URL(string: "https://github.com/THEMANINHOLLYWOOD/ps5-vision#readme")!

/// What the app's windows and the room share.
@Observable
final class AppModel {
    let browser = BridgeBrowser()
    let controller = NativeController()

    /// A bridge typed in by hand wins over ones found on the network.
    var typedBridge: Bridge? {
        didSet { save(typedBridge, as: "typed-bridge") }
    }
    var bridge: Bridge? { typedBridge ?? browser.found.first }

    var roomOpen = false
    var screenOpen = false
    /// True while the person is dragging the marker onto their PS5.
    var placingSpot = false
    /// Set once a spot has been saved, so the room opens by itself next time.
    var spotSaved: Bool {
        didSet { UserDefaults.standard.set(spotSaved, forKey: "spot-saved") }
    }

    /// The screen window's scene, so its size can be changed from the size bar.
    weak var screenScene: UIWindowScene?

    init() {
        spotSaved = UserDefaults.standard.bool(forKey: "spot-saved")
        if let data = UserDefaults.standard.data(forKey: "typed-bridge") {
            typedBridge = try? JSONDecoder().decode(Bridge.self, from: data)
        }
        browser.start()
    }

    private func save(_ bridge: Bridge?, as key: String) {
        if let bridge, let data = try? JSONEncoder().encode(bridge) {
            UserDefaults.standard.set(data, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }
}

/// Screen sizes to pick from, like Mac Virtual Display's. Widths are in
/// points; at the distance visionOS places windows a point is about a millimetre.
enum ScreenSize: String, CaseIterable, Identifiable {
    case small = "Small"
    case standard = "Standard"
    case large = "Large"
    case cinema = "Cinema"

    var id: String { rawValue }

    var width: CGFloat {
        switch self {
        case .small: 960
        case .standard: 1600
        case .large: 2400
        case .cinema: 3600
        }
    }

    var size: CGSize { CGSize(width: width, height: width * 9 / 16) }
    static let minimum = CGSize(width: 640, height: 360)
}

extension UIWindowScene {
    /// Keeps the screen 16:9 however it is resized; optionally sets a size.
    func lockScreenShape(size: CGSize? = nil) {
        let preferences = UIWindowScene.GeometryPreferences.Vision(
            size: size,
            minimumSize: ScreenSize.minimum,
            maximumSize: nil,
            resizingRestrictions: .uniform
        )
        requestGeometryUpdate(preferences) { _ in }
    }
}
