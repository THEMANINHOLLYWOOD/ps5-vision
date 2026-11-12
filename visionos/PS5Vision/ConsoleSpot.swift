import ARKit
import QuartzCore
import RealityKit
import SwiftUI

/// Where the PS5 is in the room.
///
/// The person shows it once, by dragging a ring onto the console; visionOS
/// keeps that spot as a world anchor, so it is there again every time the app
/// opens in this room. If the app carries a scanned model of the console (a
/// `.referenceobject` file), the console is also found by sight.
@Observable
final class ConsoleSpot {
    let root = Entity()
    /// Sits on the PS5. The Connect badge floats above it.
    let marker = Entity()
    private let ring: ModelEntity

    /// The marker is on the PS5 (or being placed).
    private(set) var located = false
    /// The person is looking towards the PS5, give or take.
    private(set) var facing = true
    private(set) var problem: String?
    var placing = false {
        didSet { ring.isEnabled = placing }
    }

    private let session = ARKitSession()
    private let world = WorldTrackingProvider()
    private var badge: Entity?
    private var anchorID: UUID? {
        didSet { UserDefaults.standard.set(anchorID?.uuidString, forKey: "spot-anchor") }
    }

    private static let badgeHeight: Float = 0.18
    /// How far off-centre the PS5 can be and still count as looked at.
    private static let lookAngle: Float = 28 * .pi / 180

    init() {
        var material = UnlitMaterial(color: .systemBlue)
        material.blending = .transparent(opacity: 0.55)
        ring = ModelEntity(mesh: .generateCylinder(height: 0.006, radius: 0.13), materials: [material])
        ring.isEnabled = false
        marker.addChild(ring)
        marker.components.set(CollisionComponent(shapes: [.generateBox(size: [0.32, 0.12, 0.32])]))
        marker.components.set(InputTargetComponent())
        marker.components.set(HoverEffectComponent())
        marker.isEnabled = false
        root.addChild(marker)
        anchorID = UserDefaults.standard.string(forKey: "spot-anchor").flatMap(UUID.init(uuidString:))
    }

    func attachBadge(_ entity: Entity) {
        badge = entity
        entity.position = [0, Self.badgeHeight, 0]
        marker.addChild(entity)
    }

    // MARK: - Tracking

    func run() async {
        guard WorldTrackingProvider.isSupported else {
            // The simulator has no world tracking: put the console in front.
            marker.position = [0.7, 0.75, -1.5]
            show()
            return
        }
        var providers: [any DataProvider] = [world]
        let objects = await objectTracking()
        if let objects { providers.append(objects) }
        do {
            try await session.run(providers)
        } catch {
            problem = "Can't track the room: \(error.localizedDescription)"
            return
        }
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.followSavedSpot() }
            if let objects { group.addTask { await self.followConsole(objects) } }
            group.addTask { await self.watchWhereThePersonLooks() }
        }
    }

    private func followSavedSpot() async {
        for await update in world.anchorUpdates {
            guard update.anchor.id == anchorID, !placing else { continue }
            switch update.event {
            case .added, .updated:
                marker.setTransformMatrix(update.anchor.originFromAnchorTransform, relativeTo: nil)
                if update.anchor.isTracked { show() }
            case .removed:
                hide()
            }
        }
    }

    /// Uses any scanned model of the console bundled with the app.
    private func objectTracking() async -> ObjectTrackingProvider? {
        guard ObjectTrackingProvider.isSupported else { return nil }
        var objects: [ReferenceObject] = []
        for url in Bundle.main.urls(forResourcesWithExtension: "referenceobject", subdirectory: nil) ?? [] {
            if let object = try? await ReferenceObject(from: url) { objects.append(object) }
        }
        return objects.isEmpty ? nil : ObjectTrackingProvider(referenceObjects: objects)
    }

    private func followConsole(_ provider: ObjectTrackingProvider) async {
        for await update in provider.anchorUpdates {
            guard !placing, update.anchor.isTracked else { continue }
            marker.setTransformMatrix(update.anchor.originFromAnchorTransform, relativeTo: nil)
            badge?.position = [0, update.anchor.boundingBox.extent.y + 0.1, 0]
            show()
        }
    }

    /// Like the Mac's Connect button, the badge shows when the person turns
    /// towards the console. (Apps can't see exactly where the eyes point; the
    /// head's direction is a good stand-in, and looking at the badge itself
    /// still lights it up.)
    private func watchWhereThePersonLooks() async {
        while !Task.isCancelled {
            if let device = world.queryDeviceAnchor(atTimestamp: CACurrentMediaTime()), marker.isEnabled {
                let head = device.originFromAnchorTransform
                let eye = SIMD3<Float>(head.columns.3.x, head.columns.3.y, head.columns.3.z)
                let forward = -SIMD3<Float>(head.columns.2.x, head.columns.2.y, head.columns.2.z)
                let toConsole = marker.position(relativeTo: nil) - eye
                let angle = acos(max(-1, min(1, simd_dot(simd_normalize(forward), simd_normalize(toConsole)))))
                let nowFacing = angle < Self.lookAngle
                if nowFacing != facing { facing = nowFacing }
            }
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    // MARK: - Showing where the console is

    /// Puts the ring in front of the person, ready to be dragged onto the PS5.
    func startPlacing() async {
        placing = true
        // Tracking takes a moment to start when the room has just opened.
        var device: DeviceAnchor?
        for _ in 0..<30 where WorldTrackingProvider.isSupported {
            device = world.queryDeviceAnchor(atTimestamp: CACurrentMediaTime())
            if device != nil || !placing { break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        guard placing else { return }
        if let device {
            let head = device.originFromAnchorTransform
            var forward = -SIMD3<Float>(head.columns.2.x, 0, head.columns.2.z)
            if simd_length(forward) < 0.01 { forward = [0, 0, -1] }
            let eye = SIMD3<Float>(head.columns.3.x, head.columns.3.y, head.columns.3.z)
            marker.setPosition(eye + simd_normalize(forward) * 1.2 + [0, -0.45, 0], relativeTo: nil)
            marker.setOrientation(simd_quatf(angle: 0, axis: [0, 1, 0]), relativeTo: nil)
        } else {
            marker.setPosition([0, 0.8, -1.3], relativeTo: nil) // in front of where the room opened
        }
        show()
    }

    /// Keeps the ring where it is now, for this and every later visit.
    func savePlacement() async {
        defer { placing = false }
        guard WorldTrackingProvider.isSupported else { return }
        let anchor = WorldAnchor(originFromAnchorTransform: marker.transformMatrix(relativeTo: nil))
        do {
            try await world.addAnchor(anchor)
            if let old = anchorID { try? await world.removeAnchor(forID: old) }
            anchorID = anchor.id
            problem = nil
        } catch {
            problem = "Couldn't remember the spot: \(error.localizedDescription)"
        }
    }

    private func show() {
        marker.isEnabled = true
        located = true
    }

    private func hide() {
        marker.isEnabled = false
        located = false
    }
}
