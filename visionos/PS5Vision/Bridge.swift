import Foundation
import Network

/// A bridge (the Node server on a Mac), as announced over Bonjour
/// or typed in by hand.
struct Bridge: Identifiable, Hashable, Codable {
    var name: String
    var scheme: String = "https"
    var host: String
    var port: Int
    var path: String = "/"
    var consoleName: String?
    /// SHA-256 of the bridge's certificate, lowercase hex. The bridge makes its
    /// own certificate, so this is what says it is the right one.
    var fingerprint: String?

    var id: String { "\(host.lowercased()):\(port)" }

    /// Not a bridge at all: the demo built into the app, for trying the
    /// screen and a controller with no console and no Mac.
    static let demo = Bridge(name: "Demo", scheme: "demo", host: "demo", port: 0)
    var isDemo: Bool { scheme == "demo" }

    /// The page, with `app=1` so it knows a native app is hosting it.
    var pageURL: URL? {
        var parts = URLComponents()
        parts.scheme = scheme
        parts.host = host
        parts.port = port
        parts.path = path.isEmpty ? "/" : path
        parts.queryItems = [URLQueryItem(name: "app", value: "1")]
        return parts.url
    }

    /// Reads "Mac.local", "Mac.local:8443", "192.168.1.5:8443" or a full URL.
    static func fromTyped(_ text: String) -> Bridge? {
        var typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty else { return nil }
        if !typed.contains("://") { typed = "https://" + typed }
        guard let parts = URLComponents(string: typed), let host = parts.host, !host.isEmpty else { return nil }
        let scheme = parts.scheme == "http" ? "http" : "https"
        return Bridge(
            name: host,
            scheme: scheme,
            host: host,
            port: parts.port ?? (scheme == "https" ? 8443 : 8080),
            path: parts.path.isEmpty ? "/" : parts.path
        )
    }
}

/// Watches the local network for bridges.
@Observable
final class BridgeBrowser {
    private(set) var found: [Bridge] = []
    private(set) var problem: String?
    private var browser: NWBrowser?

    func start() {
        guard browser == nil else { return }
        let parameters = NWParameters()
        parameters.includePeerToPeer = false
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: "_ps5vision._tcp", domain: nil), using: parameters)
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            let bridges = results.compactMap(Self.bridge(from:)).sorted { $0.name < $1.name }
            Task { @MainActor in self?.found = bridges }
        }
        browser.stateUpdateHandler = { [weak self] state in
            let message: String? = switch state {
            case .failed(let error), .waiting(let error):
                "Can't look for the bridge: \(error.localizedDescription). Allow Local Network access for this app in Settings."
            default:
                nil
            }
            Task { @MainActor in self?.problem = message }
        }
        browser.start(queue: .main)
        self.browser = browser
    }

    nonisolated private static func bridge(from result: NWBrowser.Result) -> Bridge? {
        guard case let .service(name, _, _, _) = result.endpoint,
              case let .bonjour(record) = result.metadata else { return nil }
        let fields = record.dictionary
        guard let host = fields["host"], !host.isEmpty, let port = Int(fields["port"] ?? "") else { return nil }
        return Bridge(
            name: name,
            scheme: fields["scheme"] == "http" ? "http" : "https",
            host: host,
            port: port,
            path: fields["path"] ?? "/",
            consoleName: fields["console"],
            fingerprint: fields["sha256"]
        )
    }
}

/// Which certificate each bridge may present. A bridge found over Bonjour
/// says which one it uses; one typed in by hand is trusted the first time and
/// held to that certificate afterwards.
enum TrustStore {
    static func accepts(fingerprint: String, for bridge: Bridge) -> Bool {
        if let announced = bridge.fingerprint { return announced.lowercased() == fingerprint }
        let key = "trusted-certificate.\(bridge.id)"
        if let remembered = UserDefaults.standard.string(forKey: key) { return remembered == fingerprint }
        UserDefaults.standard.set(fingerprint, forKey: key)
        return true
    }

    static func forget(_ bridge: Bridge) {
        UserDefaults.standard.removeObject(forKey: "trusted-certificate.\(bridge.id)")
    }
}
