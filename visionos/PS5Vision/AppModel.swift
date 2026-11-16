import Foundation
import Spatial
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
    let hands = HandControls()

    /// How the game on screen is played with bare hands; the page sends it.
    var controls = VisionControls() {
        didSet { hands.controls = controls }
    }
    /// The immersive theatre is open: the room is dark and lit by the game.
    var theaterOpen = false {
        didSet { followHands() }
    }
    /// The person wants to play with their hands (in the theatre, where
    /// hands can be followed).
    var handsOn: Bool {
        didSet {
            UserDefaults.standard.set(handsOn, forKey: "hands-on")
            followHands()
        }
    }
    /// Show the game's buttons under the screen. Until chosen: shown when
    /// there is no controller to press them on.
    var buttonsChosen: Bool? {
        didSet { UserDefaults.standard.set(buttonsChosen, forKey: "buttons-shown") }
    }
    var buttonsShown: Bool { buttonsChosen ?? (controller.name == nil) }
    /// The picture's colours, a few times a second, while the theatre is open.
    var ambient: Ambient?
    /// Where the screen's window is inside the theatre.
    var screenCorners: ScreenCorners?
    /// A panel is being pulled out: the next drag over the screen picks its part.
    var pulling = false
    /// The screen is showing the built-in demo, which has no picture to pull from.
    var screenIsDemo = false
    /// What building this game's controls is up to, in the page's words.
    var buildNote = ""
    var building = false
    private var floating: Set<PadTarget> = []

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
        handsOn = UserDefaults.standard.bool(forKey: "hands-on")
        buttonsChosen = UserDefaults.standard.object(forKey: "buttons-shown") == nil ? nil : UserDefaults.standard.bool(forKey: "buttons-shown")
        spotSaved = UserDefaults.standard.bool(forKey: "spot-saved")
        if let data = UserDefaults.standard.data(forKey: "typed-bridge") {
            typedBridge = try? JSONDecoder().decode(Bridge.self, from: data)
        }
        browser.start()
        hands.onChange = { [weak self] input in self?.controller.hands = input }
    }

    /// Hands can only be followed inside an immersive space, so they are the
    /// controller exactly while the theatre is open and they are wanted.
    private func followHands() {
        let wanted = handsOn && theaterOpen
        controller.extrasOn = wanted
        if wanted { hands.start() } else { hands.stop() }
    }

    /// A floating button going down, and coming back up.
    func press(_ target: PadTarget) {
        floating.insert(target)
        sendFloating()
    }

    func release(_ target: PadTarget) {
        floating.remove(target)
        sendFloating()
    }

    private func sendFloating() {
        var input = ExtraInput()
        for target in floating { input.press(target) }
        controller.floating = input
    }

    private func save(_ bridge: Bridge?, as key: String) {
        if let bridge, let data = try? JSONEncoder().encode(bridge) {
            UserDefaults.standard.set(data, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }
}

/// Three corners of the screen's window, in the immersive space's own
/// coordinates: enough to know where it is, how big, and which way it faces.
struct ScreenCorners: Equatable {
    var topLeft: Point3D
    var topRight: Point3D
    var bottomLeft: Point3D
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
