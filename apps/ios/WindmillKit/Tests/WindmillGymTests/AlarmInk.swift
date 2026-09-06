import SwiftUI
import UIKit

// The alarm ink counted off the glass. `GymSkin.instrument.alarmInk` (#D08268) is the room's ink for
// a write that failed and for nothing else, so counting it answers which of two states a screen is
// drawing rather than which property a view happened to set. Rendered at device scale rather than at
// 1: a 12.5pt line drawn at 1x is all antialiasing and hits its own colour exactly nowhere.
@MainActor
func alarmPixels(of window: UIWindow) -> Int {
    inkPixels(of: window, near: (0xD0, 0x82, 0x68))
}

// The accent (`GymSkin.instrument.accent`, verdigris #5FCDB4): the fill of a primary button.
@MainActor
func accentPixels(of window: UIWindow) -> Int {
    inkPixels(of: window, near: (0x5F, 0xCD, 0xB4))
}

@MainActor
func inkPixels(of window: UIWindow, near ink: (r: Int, g: Int, b: Int)) -> Int {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 3
    let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { context in
        window.layer.render(in: context.cgContext)
    }
    guard let cg = image.cgImage, let data = cg.dataProvider?.data,
          let bytes = CFDataGetBytePtr(data) else { return 0 }
    let width = cg.width, height = cg.height, perRow = cg.bytesPerRow, perPixel = cg.bitsPerPixel / 8
    let alphaFirst = cg.alphaInfo == .premultipliedFirst || cg.alphaInfo == .first
        || cg.alphaInfo == .noneSkipFirst
    let bgr = cg.bitmapInfo.contains(.byteOrder32Little)
    var lit = 0
    for y in 0..<height {
        for x in 0..<width {
            let at = y * perRow + x * perPixel
            let r: Int, g: Int, b: Int
            if bgr { (r, g, b) = (Int(bytes[at + 2]), Int(bytes[at + 1]), Int(bytes[at])) }
            else if alphaFirst { (r, g, b) = (Int(bytes[at + 1]), Int(bytes[at + 2]), Int(bytes[at + 3])) }
            else { (r, g, b) = (Int(bytes[at]), Int(bytes[at + 1]), Int(bytes[at + 2])) }
            if abs(r - ink.r) < 10 && abs(g - ink.g) < 10 && abs(b - ink.b) < 10 { lit += 1 }
        }
    }
    return lit
}
