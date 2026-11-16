import RealityKit
import simd
import SwiftUI
import UIKit

/// The immersive theatre: the room goes dark and is lit by the game. A soft
/// glow in the picture's own colours spreads from behind the screen, and the
/// darkness around takes on a trace of them.
struct TheaterView: View {
    @Environment(AppModel.self) private var model
    @State private var glow = Glow()

    var body: some View {
        // Read here so the view is refreshed when either changes.
        let ambient = model.ambient
        let corners = model.screenCorners
        RealityView { content in
            content.add(glow.root)
        } update: { content in
            // Where the screen's window is, in the theatre's own coordinates.
            let place = corners.map { corners in
                Glow.Screen(
                    topLeft: content.convert(corners.topLeft, from: NamedCoordinateSpace.immersiveSpace, to: .scene),
                    topRight: content.convert(corners.topRight, from: NamedCoordinateSpace.immersiveSpace, to: .scene),
                    bottomLeft: content.convert(corners.bottomLeft, from: NamedCoordinateSpace.immersiveSpace, to: .scene)
                )
            }
            glow.show(ambient, around: place)
        }
        .onAppear { model.theaterOpen = true }
        .onDisappear { model.theaterOpen = false }
    }
}

/// The light the game throws into the room.
final class Glow {
    /// Three corners of the screen, in metres.
    struct Screen {
        var topLeft: SIMD3<Float>
        var topRight: SIMD3<Float>
        var bottomLeft: SIMD3<Float>
    }

    let root = Entity()
    private let dome: ModelEntity
    private let halo = Entity()
    private var blobs: [ModelEntity] = []
    private let falloff: TextureResource?

    init() {
        falloff = Self.softDisc().flatMap { try? TextureResource(image: $0, options: .init(semantic: .color)) }

        // The darkness itself, far away on every side, seen from inside.
        dome = ModelEntity(mesh: .generateSphere(radius: 40), materials: [UnlitMaterial(color: .black)])
        dome.scale = [-1, 1, 1]
        root.addChild(dome)

        // One pool of light behind the middle of the screen and one behind each edge.
        for _ in 0..<5 {
            let blob = ModelEntity(mesh: .generatePlane(width: 1, height: 1), materials: [material(.black, opacity: 0)])
            blobs.append(blob)
            halo.addChild(blob)
        }
        halo.isEnabled = false
        root.addChild(halo)
    }

    func show(_ ambient: Ambient?, around screen: Screen?) {
        guard let ambient else {
            halo.isEnabled = false
            dome.model?.materials = [UnlitMaterial(color: .black)]
            return
        }
        // Barely there: enough that the dark is the game's dark.
        dome.model?.materials = [UnlitMaterial(color: Self.colour(ambient.all, brightness: 0.07))]

        guard let screen else {
            halo.isEnabled = false
            return
        }
        let across = screen.topRight - screen.topLeft
        let downward = screen.bottomLeft - screen.topLeft
        let width = simd_length(across)
        let height = simd_length(downward)
        guard width > 0.05, height > 0.05 else {
            halo.isEnabled = false
            return
        }
        let x = across / width
        let y = -downward / height
        let z = simd_normalize(simd_cross(x, y)) // out of the screen, towards the person
        halo.isEnabled = true
        halo.setTransformMatrix(simd_float4x4(
            SIMD4(x, 0), SIMD4(y, 0), SIMD4(z, 0),
            SIMD4(screen.topLeft + across / 2 + downward / 2, 1)
        ), relativeTo: nil)

        // (colour, where on the screen it sits, how big, how strong)
        let pools: [(SIMD3<Float>, SIMD2<Float>, SIMD2<Float>, Float)] = [
            (ambient.all, [0, 0], [width * 2.3, height * 2.6], 0.55),
            (ambient.top, [0, height * 0.5], [width * 1.7, height * 1.5], 0.8),
            (ambient.bottom, [0, -height * 0.5], [width * 1.7, height * 1.5], 0.8),
            (ambient.left, [-width * 0.5, 0], [width * 1.1, height * 1.9], 0.8),
            (ambient.right, [width * 0.5, 0], [width * 1.1, height * 1.9], 0.8),
        ]
        for (index, (blob, pool)) in zip(blobs, pools).enumerated() {
            // Behind the screen, each a little further back so they don't fight.
            blob.position = [pool.1.x, pool.1.y, -0.08 - Float(index) * 0.01]
            blob.scale = [pool.2.x, pool.2.y, 1]
            blob.model?.materials = [material(Self.colour(pool.0, brightness: 1), opacity: pool.3)]
        }
    }

    private func material(_ colour: UIColor, opacity: Float) -> UnlitMaterial {
        var material = UnlitMaterial()
        material.color = .init(tint: colour, texture: falloff.map { MaterialParameters.Texture($0) })
        material.blending = .transparent(opacity: .init(scale: opacity))
        return material
    }

    /// A picture's average colour is mostly dull: keep its hue, lift it to a
    /// light worth seeing, then dim it to the brightness asked for.
    private static func colour(_ rgb: SIMD3<Float>, brightness: Float) -> UIColor {
        let peak = max(rgb.x, rgb.y, rgb.z)
        guard peak > 0.02 else { return .black } // a black screen throws no light
        let mean = (rgb.x + rgb.y + rgb.z) / 3
        let vivid = simd_clamp(mean + (rgb - mean) * 1.5, SIMD3(repeating: 0), SIMD3(repeating: 1))
        let lifted = vivid / max(vivid.x, vivid.y, vivid.z, 0.001) * min(1, 0.25 + peak * 1.1)
        let out = lifted * brightness
        return UIColor(red: CGFloat(out.x), green: CGFloat(out.y), blue: CGFloat(out.z), alpha: 1)
    }

    /// White in the middle fading to nothing at the edge.
    private static func softDisc() -> CGImage? {
        let side = 128
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let fade = CGGradient(colorsSpace: space, colors: [
                  CGColor(red: 1, green: 1, blue: 1, alpha: 1),
                  CGColor(red: 1, green: 1, blue: 1, alpha: 0.45),
                  CGColor(red: 1, green: 1, blue: 1, alpha: 0),
              ] as CFArray, locations: [0, 0.45, 1])
        else { return nil }
        let centre = CGPoint(x: side / 2, y: side / 2)
        context.drawRadialGradient(fade, startCenter: centre, startRadius: 0, endCenter: centre, endRadius: CGFloat(side / 2), options: [])
        return context.makeImage()
    }
}
