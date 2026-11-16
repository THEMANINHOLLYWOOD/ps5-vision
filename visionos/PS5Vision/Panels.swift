import CryptoKit
import SwiftUI
import WebKit

/// A panel pulled out of the screen: the PS5's picture, or one part of it (a
/// map, a scoreboard, a video), in a window of its own that can be put
/// anywhere and made any size.
///
/// The PS5 sends one picture, so every panel is a window on that same
/// picture. A panel can be held, though: it then keeps what it was showing,
/// like a card of that moment, while the game goes on elsewhere.
struct PanelSpec: Codable, Hashable, Identifiable {
    var id = UUID()
    var bridge: Bridge
    /// The part of the picture it shows, each a share of the whole (0...1).
    var x: Double
    var y: Double
    var width: Double
    var height: Double

    /// Its shape: the picture is 16:9, the part of it may be anything.
    var aspect: Double { (width * 16) / (height * 9) }

    var pageURL: URL? {
        var parts = URLComponents()
        parts.scheme = bridge.scheme
        parts.host = bridge.host
        parts.port = bridge.port
        parts.path = "/panel.html"
        let numbers = [x, y, width, height].map { String(format: "%.4f", $0) }.joined(separator: ",")
        parts.queryItems = [URLQueryItem(name: "crop", value: numbers)]
        return parts.url
    }

    /// From a rectangle dragged over the screen. Too small to be meant as a
    /// part (a pinch without a drag): the whole picture.
    static func pulled(from bridge: Bridge, _ drawn: CGRect, in screen: CGSize) -> PanelSpec {
        guard screen.width > 0, screen.height > 0 else { return PanelSpec(bridge: bridge, x: 0, y: 0, width: 1, height: 1) }
        let part = drawn.standardized.intersection(CGRect(origin: .zero, size: screen))
        let width = part.width / screen.width
        let height = part.height / screen.height
        guard width >= 0.06, height >= 0.06 else { return PanelSpec(bridge: bridge, x: 0, y: 0, width: 1, height: 1) }
        return PanelSpec(bridge: bridge, x: part.minX / screen.width, y: part.minY / screen.height, width: width, height: height)
    }
}

struct PanelView: View {
    let spec: PanelSpec
    @State private var held = false

    var body: some View {
        PanelWebView(spec: spec, held: held)
            .aspectRatio(spec.aspect, contentMode: .fit)
            .background(.black)
            .ornament(attachmentAnchor: .scene(.bottom), contentAlignment: .top) {
                Toggle(isOn: $held) {
                    Label(held ? "Held" : "Hold this picture", systemImage: held ? "pause.fill" : "pause")
                }
                .toggleStyle(.button)
                .padding(8)
                .glassBackgroundEffect()
                .padding(.top, 12)
            }
    }
}

/// Laid over the screen while a panel is being pulled out: drag over the
/// part wanted, or pinch once for the whole picture.
struct PullOutOverlay: View {
    let bridge: Bridge
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    @State private var drawn: CGRect?

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .topLeading) {
                Color.black.opacity(0.45)
                if let drawn {
                    Rectangle()
                        .fill(.white.opacity(0.14))
                        .overlay(Rectangle().strokeBorder(.white, lineWidth: 3))
                        .frame(width: drawn.width, height: drawn.height)
                        .offset(x: drawn.minX, y: drawn.minY)
                } else {
                    VStack(spacing: 14) {
                        Text("Drag over the part to pull out")
                            .font(.largeTitle.weight(.semibold))
                        Text("A map, a scoreboard, a video. Or pinch once for the whole picture.")
                            .font(.title3)
                            .foregroundStyle(.secondary)
                        Button("Cancel") { model.pulling = false }
                            .controlSize(.large)
                            .padding(.top, 8)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        drawn = CGRect(
                            x: min(value.startLocation.x, value.location.x),
                            y: min(value.startLocation.y, value.location.y),
                            width: abs(value.location.x - value.startLocation.x),
                            height: abs(value.location.y - value.startLocation.y)
                        )
                    }
                    .onEnded { _ in
                        openWindow(id: "panel", value: PanelSpec.pulled(from: bridge, drawn ?? .zero, in: geometry.size))
                        drawn = nil
                        model.pulling = false
                    }
            )
        }
    }
}

/// A WKWebView on the bridge's panel page. Like the screen's, it trusts only
/// the bridge's own certificate; unlike it, it only watches.
struct PanelWebView: UIViewRepresentable {
    let spec: PanelSpec
    let held: Bool

    func makeCoordinator() -> Coordinator { Coordinator(bridge: spec.bridge) }

    func makeUIView(context: Context) -> ScreenWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let webView = ScreenWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        let aspect = spec.aspect
        webView.onScene = { scene in
            // Keeps the part's own shape however the window is resized.
            let width: CGFloat = aspect >= 1 ? 900 : 900 * aspect
            scene?.requestGeometryUpdate(UIWindowScene.GeometryPreferences.Vision(
                size: CGSize(width: width, height: width / aspect),
                minimumSize: CGSize(width: 240, height: 240 / aspect),
                maximumSize: nil,
                resizingRestrictions: .uniform
            )) { _ in }
        }
        if let url = spec.pageURL { webView.load(URLRequest(url: url)) }
        return webView
    }

    func updateUIView(_ webView: ScreenWebView, context: Context) {
        webView.evaluateJavaScript("window.ps5Freeze&&ps5Freeze(\(held))", completionHandler: nil)
    }

    static func dismantleUIView(_ webView: ScreenWebView, coordinator: Coordinator) {
        webView.stopLoading()
        // Leaving the page closes its connection to the Mac.
        webView.loadHTMLString("", baseURL: nil)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        let bridge: Bridge

        init(bridge: Bridge) {
            self.bridge = bridge
        }

        func webView(
            _ webView: WKWebView,
            didReceive challenge: URLAuthenticationChallenge,
            completionHandler: @escaping @MainActor (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
        ) {
            let space = challenge.protectionSpace
            guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
                  space.host.lowercased() == bridge.host.lowercased(),
                  let trust = space.serverTrust,
                  let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first
            else {
                completionHandler(.performDefaultHandling, nil)
                return
            }
            let fingerprint = SHA256.hash(data: SecCertificateCopyData(leaf) as Data)
                .map { String(format: "%02x", $0) }
                .joined()
            if TrustStore.accepts(fingerprint: fingerprint, for: bridge) {
                completionHandler(.useCredential, URLCredential(trust: trust))
            } else {
                completionHandler(.cancelAuthenticationChallenge, nil)
            }
        }
    }
}
