// Draws the app icon's three layers (visionOS stacks them with depth).
//
//   swift visionos/icon/make-icon.swift
//
// Run from the project root. Writes the PNGs into the asset catalog, and
// preview.png (all three, flattened and round as the headset shows it) here.
import AppKit
import CoreGraphics

let size = 1024
let space = CGColorSpace(name: CGColorSpace.sRGB)!

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(colorSpace: space, components: [
        CGFloat((hex >> 16) & 0xff) / 255, CGFloat((hex >> 8) & 0xff) / 255, CGFloat(hex & 0xff) / 255, alpha,
    ])!
}

/// A 1024-point canvas with y going down, like the design was drawn.
func layer(opaque: Bool = false, _ draw: (CGContext) -> Void) -> CGImage {
    let info = opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: info)!
    context.translateBy(x: 0, y: CGFloat(size))
    context.scaleBy(x: 1, y: -1)
    draw(context)
    return context.makeImage()!
}

func save(_ image: CGImage, to path: String) {
    let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])!
    try! data.write(to: URL(fileURLWithPath: path))
    print("wrote \(path)")
}

// Back: night sky, lit from where the screen floats.
let back = layer(opaque: true) { context in
    let sky = CGGradient(colorsSpace: space, colors: [color(0x16206b), color(0x0c1240), color(0x05071c)] as CFArray, locations: [0, 0.55, 1])!
    context.drawLinearGradient(sky, start: .zero, end: CGPoint(x: 0, y: size), options: [])
    let glow = CGGradient(colorsSpace: space, colors: [color(0x4f7dff, 0.55), color(0x4f7dff, 0)] as CFArray, locations: [0, 1])!
    let centre = CGPoint(x: 512, y: 370)
    context.drawRadialGradient(glow, startCenter: centre, startRadius: 0, endCenter: centre, endRadius: 620, options: [])
}

// Middle: the ring you drop on your console, seen at an angle.
let middle = layer { context in
    let ring = CGRect(x: 262, y: 654, width: 500, height: 124)
    context.setShadow(offset: .zero, blur: 46, color: color(0x3fd0ff, 0.9))
    context.setStrokeColor(color(0x6fb6ff))
    context.setLineWidth(20)
    context.strokeEllipse(in: ring)
    context.setShadow(offset: .zero, blur: 0, color: nil)
    context.setStrokeColor(color(0xa9d8ff))
    context.setLineWidth(8)
    context.strokeEllipse(in: ring)
}

// Front: the floating screen, 16:9.
let front = layer { context in
    let screen = CGPath(roundedRect: CGRect(x: 232, y: 262, width: 560, height: 315), cornerWidth: 44, cornerHeight: 44, transform: nil)
    context.saveGState()
    context.addPath(screen)
    context.clip()
    let glass = CGGradient(colorsSpace: space, colors: [color(0xffffff), color(0xd5e2ff)] as CFArray, locations: [0, 1])!
    context.drawLinearGradient(glass, start: CGPoint(x: 0, y: 262), end: CGPoint(x: 0, y: 577), options: [])
    context.restoreGState()

    let play = CGMutablePath()
    play.move(to: CGPoint(x: 476, y: 366))
    play.addLine(to: CGPoint(x: 476, y: 473))
    play.addLine(to: CGPoint(x: 572, y: 419.5))
    play.closeSubpath()
    context.setFillColor(color(0x16206b))
    context.setStrokeColor(color(0x16206b))
    context.setLineWidth(22)
    context.setLineJoin(.round)
    context.addPath(play)
    context.drawPath(using: .fillStroke)
}

let stack = "visionos/PS5Vision/Assets.xcassets/AppIcon.solidimagestack"
save(back, to: "\(stack)/Back.solidimagestacklayer/Content.imageset/back.png")
save(middle, to: "\(stack)/Middle.solidimagestacklayer/Content.imageset/middle.png")
save(front, to: "\(stack)/Front.solidimagestacklayer/Content.imageset/front.png")

let preview = layer { context in
    context.addEllipse(in: CGRect(x: 0, y: 0, width: size, height: size))
    context.clip()
    // The layers are already top-down; undo the flip while drawing them.
    context.translateBy(x: 0, y: CGFloat(size))
    context.scaleBy(x: 1, y: -1)
    for image in [back, middle, front] {
        context.draw(image, in: CGRect(x: 0, y: 0, width: size, height: size))
    }
}
save(preview, to: "visionos/icon/preview.png")
