import CryptoKit
import SwiftUI
import WebKit

/// The PS5's picture: the bridge's own page, in a window that stays 16:9
/// however it is resized, with sizes to pick from underneath.
struct ScreenView: View {
    let bridge: Bridge
    @Environment(AppModel.self) private var model

    var body: some View {
        BridgeWebView(bridge: bridge, model: model)
            .aspectRatio(16 / 9, contentMode: .fit)
            .background(.black)
            .ornament(attachmentAnchor: .scene(.bottom), contentAlignment: .top) {
                SizeBar()
                    .padding(.top, 16)
            }
            .onAppear { model.screenOpen = true }
            .onDisappear { model.screenOpen = false }
    }
}

private struct SizeBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "rectangle.expand.diagonal")
                .foregroundStyle(.secondary)
                .padding(.leading, 8)
            ForEach(ScreenSize.allCases) { size in
                Button(size.rawValue) {
                    model.screenScene?.lockScreenShape(size: size.size)
                }
            }
        }
        .padding(8)
        .glassBackgroundEffect()
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
        webView.isInspectable = true
        webView.onScene = { [weak model] scene in
            model?.screenScene = scene
            scene?.lockScreenShape()
        }
        model.controller.sink = { [weak webView] script in
            webView?.evaluateJavaScript(script, completionHandler: nil)
        }
        if let url = bridge.pageURL { webView.load(URLRequest(url: url)) }
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
                showProblem(in: webView, "This bridge's certificate is not the one PS5 Vision trusted before. If you reset the bridge on your Mac, remove the address in PS5 Vision and add it again.")
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            let code = (error as NSError).code
            guard code != NSURLErrorCancelled else { return }
            showProblem(in: webView, "Can't reach the bridge at \(bridge.host):\(bridge.port). Check that `npm start` is running on your Mac and that both are on the same Wi-Fi.")
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], body["type"] as? String == "rumble" else { return }
            model.controller.rumble(
                left: (body["left"] as? NSNumber)?.doubleValue ?? 0,
                right: (body["right"] as? NSNumber)?.doubleValue ?? 0
            )
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
