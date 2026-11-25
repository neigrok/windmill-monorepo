import CoreGraphics
import Foundation
import ImageIO

// usage: scan <png> row <y> | col <x> | diag <x> <y> <dx> <dy> <steps>
// prints runs of similar colour along the line, in pixels
let arguments = CommandLine.arguments
let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: arguments[1]) as CFURL, nil)!
let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
let width = image.width, height = image.height
var pixels = [UInt8](repeating: 0, count: width * height * 4)
let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

func colour(_ x: Int, _ y: Int) -> [Int] {
    let offset = (y * width + x) * 4
    return [Int(pixels[offset]), Int(pixels[offset + 1]), Int(pixels[offset + 2])]
}

var points: [(Int, Int)] = []
switch arguments[2] {
case "row": points = (0..<width).map { ($0, Int(arguments[3])!) }
case "col": points = (0..<height).map { (Int(arguments[3])!, $0) }
default:
    let x = Int(arguments[3])!, y = Int(arguments[4])!, dx = Int(arguments[5])!, dy = Int(arguments[6])!
    points = (0..<Int(arguments[7])!).map { (x + $0 * dx, y + $0 * dy) }
}
let tolerance = 6
var runStart = 0
var runColour = colour(points[0].0, points[0].1)
for index in 1...points.count {
    let current = index < points.count ? colour(points[index].0, points[index].1) : [-99, -99, -99]
    let differs = zip(current, runColour).contains { abs($0 - $1) > tolerance }
    if differs {
        let length = index - runStart
        if length >= 3 {
            let position = arguments[2] == "row" ? points[runStart].0 : arguments[2] == "col" ? points[runStart].1 : runStart
            print("\(position)..\(position + length - 1) len \(length) rgb \(runColour)")
        }
        runStart = index
        runColour = current
    }
}
