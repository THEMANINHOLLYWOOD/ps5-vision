import CryptoKit
import Spatial
import SwiftUI
import WebKit

/// The PS5's picture: the bridge's own page, in a window that stays 16:9
/// however it is resized, with sizes to pick from underneath.
struct ScreenView: View {
    let bridge: Bridge
    @Environment(AppModel.self) private var model
    @Environment(\.dismissImmersiveSpace) private var dismissImmersiveSpace

    var body: some View {
        ZStack {
            BridgeWebView(bridge: bridge, model: model)
                // While hands are the controller a pinch is a stick or a
                // button, not a tap on whatever the eyes happen to be on.
                .allowsHitTesting(!(model.handsOn && model.theaterOpen))
            if model.pulling { PullOutOverlay(bridge: bridge) }
        }
            .aspectRatio(16 / 9, contentMode: .fit)
            .background(.black)
            // Where this window is inside the theatre, so the glow can sit
            // right behind it. (No answer while no immersive space is open.)
            .onGeometryChange3D(for: ScreenCorners?.self) { proxy -> ScreenCorners? in
                guard let place = proxy.transform(in: NamedCoordinateSpace.immersiveSpace) else { return nil }
                let size = proxy.size
                return ScreenCorners(
                    topLeft: Point3D(x: 0, y: 0, z: 0).applying(place),
                    topRight: Point3D(x: size.width, y: 0, z: 0).applying(place),
                    bottomLeft: Point3D(x: 0, y: size.height, z: 0).applying(place)
                )
            } action: { corners in
                model.screenCorners = corners
            }
            .ornament(attachmentAnchor: .scene(.bottom), contentAlignment: .top) {
                ControlBar()
                    .padding(.top, 16)
            }
            // The page sends the picture's colours only while asked to. Asked
            // again every few seconds, since the page may have reloaded.
            .task(id: model.theaterOpen) {
                guard model.theaterOpen else {
                    model.controller.sink?("window.ps5SetAmbient&&ps5SetAmbient(false)")
                    model.ambient = nil
                    return
                }
                while !Task.isCancelled {
                    model.controller.sink?("window.ps5SetAmbient&&ps5SetAmbient(true)")
                    try? await Task.sleep(for: .seconds(3))
                }
            }
            .onAppear {
                model.screenOpen = true
                model.screenIsDemo = bridge.isDemo
            }
            .onDisappear {
                model.screenOpen = false
                model.pulling = false
                model.screenCorners = nil
                // A theatre with no screen in it is just a dark room.
                if model.theaterOpen { Task { await dismissImmersiveSpace() } }
            }
    }
}

/// A WKWebView showing the bridge's page. It trusts only the bridge's own
/// certificate, and passes the controller and rumble between page and app.
struct BridgeWebView: UIViewRepresentable {
    let bridge: Bridge
    let model: AppModel

    func makeCoordinator() -> Coordinator { Coordinator(bridge: bridge, model: model) }

    func makeUIView(context: Context) -> ScreenWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.add(context.coordinator, name: "ps5")

        let webView = ScreenWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        webView.isInspectable = true
        #endif
        webView.onScene = { [weak model] scene in
            model?.screenScene = scene
            scene?.lockScreenShape()
        }
        model.controller.sink = { [weak webView] script in
            webView?.evaluateJavaScript(script, completionHandler: nil)
        }
        if bridge.isDemo {
            if let page = Bundle.main.url(forResource: "Demo", withExtension: "html") {
                webView.loadFileURL(page, allowingReadAccessTo: page)
            }
        } else if let url = bridge.pageURL {
            webView.load(URLRequest(url: url))
        }
        return webView
    }

    func updateUIView(_ webView: ScreenWebView, context: Context) {}

    static func dismantleUIView(_ webView: ScreenWebView, coordinator: Coordinator) {
        coordinator.model.controller.sink = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "ps5")
        webView.stopLoading()
        // Leaving the page closes the stream, so the Mac knows nobody is watching.
        webView.loadHTMLString("", baseURL: nil)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let bridge: Bridge
        let model: AppModel

        init(bridge: Bridge, model: AppModel) {
            self.bridge = bridge
            self.model = model
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
                showProblem(in: webView, "This bridge's certificate is not the one \(appName) trusted before. If you reset the bridge on your Mac, remove the address in \(appName) and add it again.")
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            let code = (error as NSError).code
            guard code != NSURLErrorCancelled else { return }
            showProblem(in: webView, "Can't reach the bridge at \(bridge.host):\(bridge.port). Check that the bridge is running on your Mac and that both are on the same Wi-Fi.")
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "rumble":
                model.controller.rumble(
                    left: (body["left"] as? NSNumber)?.doubleValue ?? 0,
                    right: (body["right"] as? NSNumber)?.doubleValue ?? 0
                )
            case "controls":
                // How the game on screen is played with bare hands.
                if let controls = VisionControls(message: body), controls != model.controls { model.controls = controls }
            case "ambient":
                // The picture's colours, for lighting the theatre.
                model.ambient = model.theaterOpen ? Ambient(message: body) : nil
            case "build-note":
                model.buildNote = String((body["text"] as? String ?? "").prefix(200))
                model.building = body["busy"] as? Bool ?? false
            default:
                break
            }
        }

        private func showProblem(in webView: WKWebView, _ text: String) {
            let escaped = text
                .replacingOccurrences(of: "&", with: "&amp;")
                .replacingOccurrences(of: "<", with: "&lt;")
            webView.loadHTMLString("""
                <meta name="viewport" content="width=device-width">
                <body style="background:#07090d;color:#f4f6fa;font:28px -apple-system;display:grid;place-items:center;height:100vh;margin:0;padding:0 10%;text-align:center">
                <p>\(escaped)</p></body>
                """, baseURL: nil)
        }
    }
}

/// Tells the app which window scene it ended up in, so the screen's size can
/// be set from outside.
final class ScreenWebView: WKWebView {
    var onScene: ((UIWindowScene?) -> Void)?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        onScene?(window?.windowScene)
    }
}
