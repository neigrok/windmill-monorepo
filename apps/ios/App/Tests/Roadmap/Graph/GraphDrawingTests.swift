import Foundation
import SwiftUI
import Testing
import RoadmapLayout
@testable import Windmill

@Suite @MainActor struct GraphDrawingTests {
  // *Learn to sail* as the layout's shared fixture holds it, three steps done, found by walking up from this file.
  func learnToSail(from file: String = #filePath) async throws -> GraphPicture {
    struct Fixture: Decodable {
      struct Roadmap: Decodable {
        struct Step: Decodable {
          let id: String
          let label: String
          let ord: String
          let color: String
          let follows: [String]
        }

        let steps: [Step]
        let done: [String]
      }

      let roadmap: Roadmap
    }
    var directory = URL(fileURLWithPath: file).deletingLastPathComponent()
    while directory.path != "/" && !FileManager.default.fileExists(atPath: directory.appending(path: "packages/api-contract/roadmap/layout/learn-to-sail.json").path) {
      directory = directory.deletingLastPathComponent()
    }
    let roadmap = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: directory.appending(path: "packages/api-contract/roadmap/layout/learn-to-sail.json"))).roadmap
    return try await GraphPicture(GraphPicture.Steps(
      seated: roadmap.steps.map { (step: Fixture.Roadmap.Step) -> GraphPicture.Seated in
        GraphPicture.Seated(id: UTF16Text(step.id), label: UTF16Text(step.label), ord: UTF16Text(step.ord), born: .unset,
                            follows: step.follows.map { UTF16Text($0) }, hue: UTF16Text(step.color))
      },
      done: roadmap.steps.map { roadmap.done.contains($0.id) }))
  }

  // One frame on the night canvas at an iPhone 17's size, three pixels a point, and the colour it holds at a point.
  func frame(_ picture: GraphPicture, _ camera: GraphCamera, selected: String?) throws -> (CGPoint) -> String {
    let drawing = GraphDrawing(picture: picture, camera: camera, captions: [], selected: selected.flatMap { picture.placeOf[UTF16Text($0)] })
    let renderer = ImageRenderer(content: Canvas { context, _ in drawing.draw(in: &context) }
      .frame(width: camera.viewport.width, height: camera.viewport.height).background(RoadmapPalette.canvas).environment(\.colorScheme, .dark))
    renderer.scale = 3
    let image = try #require(renderer.cgImage)
    let colours = try #require(CGColorSpace(name: CGColorSpace.sRGB))
    let bitmap = try #require(CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
                                       space: colours, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    bitmap.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    let pixels = Data(bytes: try #require(bitmap.data), count: image.width * image.height * 4)
    let width = image.width
    return { (point: CGPoint) -> String in
      let pixel = (Int(point.y * 3) * width + Int(point.x * 3)) * 4
      return String(format: "#%02X%02X%02X", pixels[pixel], pixels[pixel + 1], pixels[pixel + 2])
    }
  }

  // Roadmap · iOS 04.1, 04.2 and the kit's Graph node, in the night's colour roles: a Done disc solid in its kind's
  // colour over the canvas's dot, and the crowned root wider; an Up next disc inside its accent halo; a Locked disc in
  // its kind's locked fill, ring and dot; the selected step ringed in ink in place of its halo; a link lit where it
  // leaves a done step.
  @Test func eachStepIsDrawnInItsStatesFormAndEachLinkLitOrNot() async throws {
    let picture = try await learnToSail()
    let camera = GraphCamera(framing: picture.model.bounds, in: Viewport(width: 402, height: 874), under: Insets(top: 158, bottom: 140))
    let colour = try frame(picture, camera, selected: "read")
    let seat = { (step: String) -> CGPoint in
      let node = picture.model.nodes[picture.placeOf[UTF16Text(step)] ?? 0]
      return camera.screen(node.x, node.y)
    }
    let by = { (step: String, right: Double, down: Double) -> String in colour(CGPoint(x: seat(step).x + right, y: seat(step).y + down)) }
    let along = { (bow: GraphPicture.Bow) -> String in
      let (from, to) = (picture.model.nodes[bow.from], picture.model.nodes[bow.to])
      let middle = EdgeCurve.pointOnCurve(from.x, from.y, bow.control.x, bow.control.y, to.x, to.y, 0.5)
      return colour(camera.screen(middle.x, middle.y))
    }
    let link = { (from: String, to: String) -> GraphPicture.Bow in
      picture.bows.first { $0.from == picture.placeOf[UTF16Text(from)] && $0.to == picture.placeOf[UTF16Text(to)] } ?? picture.bows[0]
    }
    #expect([
      "the root's dot \(by("choose", 0, 0))", "the root's disc \(by("choose", 20, 0))", "the root's rim \(by("choose", -29, 0))",
      "past the root's rim \(by("choose", -36, 0))",
      "a Done disc \(by("parts", 12, 0))", "a Done disc's rim \(by("parts", 0, -19))", "past a Done disc's rim \(by("rig", 0, 24))",
      "an Up next dot \(by("tie", 0, 0))", "an Up next disc \(by("tie", -12, 0))", "an Up next halo \(by("tie", -22, 0))",
      "past an Up next halo \(by("tie", -29, 0))",
      "the selected disc \(by("read", 12, 0))", "inside the selected ring \(by("read", 0, 22))", "the selected ring \(by("read", 0, 25.95))",
      "past the selected ring \(by("read", 0, 30))",
      "a Locked dot \(by("leave", 0, 0))", "a Locked fill \(by("leave", 12, 0))", "a Locked ring \(by("leave", 0, 19.3))",
      "another kind's Locked fill \(by("tri", 12, 0))", "a third kind's Locked fill \(by("solo", 12, 0))",
      "a lit link \(along(link("choose", "parts")))", "an unlit link \(along(link("leave", "tri")))",
    ] == [
      "the root's dot #0B0B0C", "the root's disc #D98B5F", "the root's rim #D98B5F", "past the root's rim #0B0B0C",
      "a Done disc #7BA6B8", "a Done disc's rim #7BA6B8", "past a Done disc's rim #0B0B0C",
      "an Up next dot #0B0B0C", "an Up next disc #9DAF5C", "an Up next halo #32241C", "past an Up next halo #0B0B0C",
      "the selected disc #7BA6B8", "inside the selected ring #0B0B0C", "the selected ring #F2F0EB", "past the selected ring #0B0B0C",
      "a Locked dot #74462C", "a Locked fill #3F2A1D", "a Locked ring #5F3B26",
      "another kind's Locked fill #31311D", "a third kind's Locked fill #413318",
      "a lit link #7E7C77", "an unlit link #2E2E32",
    ])
  }

  // The canvas draws what the camera holds, and all of it: a disc whose seat has left the canvas is drawn while its
  // rim is still on it, and a link is drawn across the canvas while both its steps stand outside.
  @Test func aDiscPartlyOnTheCanvasAndALinkCrossingItAreDrawn() async throws {
    let picture = try await learnToSail()
    let opening = GraphCamera(framing: picture.model.bounds, in: Viewport(width: 402, height: 874), under: Insets(top: 158, bottom: 140))
    let tie = picture.model.nodes[try #require(picture.placeOf[UTF16Text("tie")])]

    // Pinched in to the ceiling about a point that leaves *Tie a bowline*'s seat 20 points off the left edge.
    var edged = opening
    let ceiling = GraphCamera.pinchCeiling / opening.frame.zoom
    let seat = opening.screen(tie.x, tie.y)
    edged.zoom(by: ceiling, about: CGPoint(x: (ceiling * seat.x + 20) / (ceiling - 1), y: seat.y))
    #expect(abs(edged.screen(tie.x, tie.y).x + 20) < 1e-6)
    #expect(try frame(picture, edged, selected: nil)(CGPoint(x: 10, y: edged.screen(tie.x, tie.y).y)) == "#9DAF5C")

    // The middle of the long link from *Sail a triangle* to *Sail solo*, brought to the canvas's centre at the ceiling.
    let bow = try #require(picture.bows.first { $0.from == picture.placeOf[UTF16Text("tri")] && $0.to == picture.placeOf[UTF16Text("solo")] })
    let (tri, solo) = (picture.model.nodes[bow.from], picture.model.nodes[bow.to])
    let middle = EdgeCurve.pointOnCurve(tri.x, tri.y, bow.control.x, bow.control.y, solo.x, solo.y, 0.5)
    var crossed = opening
    let centre = CGPoint(x: 201, y: 437)
    crossed.pan(by: CGSize(width: centre.x - opening.screen(middle.x, middle.y).x, height: centre.y - opening.screen(middle.x, middle.y).y))
    crossed.zoom(by: ceiling, about: centre)
    #expect([crossed.screen(tri.x, tri.y).y < 0, crossed.screen(solo.x, solo.y).y > 874] == [true, true])
    #expect(try frame(picture, crossed, selected: nil)(centre) == "#2E2E32")
  }
}
