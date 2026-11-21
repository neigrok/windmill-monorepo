import Foundation
import RoadmapLayout
import Testing

// The shared fixtures of packages/api-contract/roadmap/layout, read as their README writes them: a roadmap, and every
// number the web draws of it. A test draws the roadmap with the port, writes it in the fixture's own shapes and
// compares whole lists.
enum Fixtures {
  // The directory, found by walking up from this file.
  static func directory(from file: String = #filePath) throws -> URL {
    var directory = URL(fileURLWithPath: file).deletingLastPathComponent()
    while directory.path != "/" {
      let fixtures = directory.appendingPathComponent("packages/api-contract/roadmap/layout", isDirectory: true)
      if FileManager.default.fileExists(atPath: fixtures.path) { return fixtures }
      directory = directory.deletingLastPathComponent()
    }
    throw CocoaError(.fileNoSuchFile)
  }

  // Every `.json` file of the directory, by name without its extension.
  static func names() throws -> [String] {
    try FileManager.default.contentsOfDirectory(atPath: directory().path).filter { $0.hasSuffix(".json") }
      .map { String($0.dropLast(".json".count)) }.sorted()
  }

  // Every file that holds a roadmap and its picture.
  static func roadmaps() throws -> [String] {
    try names().filter { $0 != "arithmetic" }
  }

  static func read<Fixture: Decodable>(_ type: Fixture.Type, _ name: String) throws -> Fixture {
    try JSONDecoder().decode(type, from: Data(contentsOf: directory().appendingPathComponent("\(name).json")))
  }
}

// A fixture's number. Two are the same when their bits are, never within a tolerance; a negative zero is written `0`,
// so a zero is the same as a zero.
struct Number: Decodable, Equatable, CustomStringConvertible {
  let value: Double

  init(_ value: Double) {
    self.value = value
  }

  init(from decoder: any Decoder) throws {
    value = try decoder.singleValueContainer().decode(Double.self)
  }

  static func == (a: Number, b: Number) -> Bool {
    a.value.bitPattern == b.value.bitPattern || (a.value == 0 && b.value == 0)
  }

  var description: String { "\(value)" }
}

// A fixture's text. Two are the same when their UTF-16 code units are, so two spellings of one character differ.
struct Text: Decodable, Equatable, CustomStringConvertible {
  let units: UTF16Text

  init(_ units: UTF16Text) {
    self.units = units
  }

  init(from decoder: any Decoder) throws {
    units = UTF16Text(try decoder.singleValueContainer().decode(String.self))
  }

  var description: String { units.text.debugDescription }
}

struct ArithmeticFixture: Decodable {
  let sin: [[Number]]
  let cos: [[Number]]
  let asin: [[Number]]
  let atan: [[Number]]
  let atan2: [[Number]]
  let hypot: [[Number]]
}

struct RoadmapFixture: Decodable {
  struct Roadmap: Decodable {
    let steps: [Step]
    let done: [String]
  }

  struct Step: Decodable {
    let id: String
    let label: String
    let ord: String
    let born: String
    let color: String
    let follows: [String]
  }

  struct Link: Decodable, Equatable {
    let from: Text
    let to: Text
    let kind: String
    let sway: Number
    let cx: Number
    let cy: Number
  }

  struct Bounds: Decodable, Equatable {
    let minX: Number
    let minY: Number
    let maxX: Number
    let maxY: Number
  }

  struct Canvas: Decodable {
    let name: String
    let viewport: Viewport
    let insets: Insets
    let blocks: [Block]
    let workingZoom: Double
    let fit: Camera
    let floor: Number
    let focus: [Focus]
    let passes: [Pass]
  }

  struct Viewport: Decodable {
    let width: Double
    let height: Double
  }

  struct Insets: Decodable {
    let top: Double
    let right: Double
    let bottom: Double
    let left: Double
  }

  struct Block: Decodable {
    let left: Double?
    let right: Double?
    let top: Double?
    let bottom: Double?
    let width: Double
    let height: Double
  }

  struct Camera: Decodable, Equatable {
    let x: Number
    let y: Number
    let zoom: Number
  }

  struct Focus: Decodable, Equatable {
    let step: Text
    let x: Number
    let y: Number
    let zoom: Number
  }

  struct Pass: Decodable {
    let now: Double
    let camera: Camera
    let selected: String?
    let hovered: String?
    let rankLimit: Int
    let captions: [Caption]
    let nextDeadline: Number?
  }

  struct Caption: Decodable, Equatable {
    let id: Text
    let anchor: Int
    let left: Number
    let top: Number
    let width: Number
    let height: Number
    let lines: [Text]
    let shown: Bool
  }

  let roadmap: Roadmap
  let engine: String
  let seats: [[Number]]
  let tiers: [Int]
  let links: [Link]
  let bounds: Bounds
  let canvases: [Canvas]

  // The roadmap as the room hands it to the layout: the steps in their order, each with whether it is done. A step's
  // `born` is `ms:counter:actor`.
  func tree() throws -> SkillTree {
    let done = Set(roadmap.done.map { UTF16Text($0) })
    return try SkillTree(steps: roadmap.steps.map { step in
      let born = step.born.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
      return SkillTree.Step(
        id: step.id, label: step.label, ord: step.ord,
        born: SkillTree.Stamp(ms: try #require(Int64(born[0])), counter: try #require(Int64(born[1])), actor: String(born[2])),
        follows: step.follows, hue: step.color, done: done.contains(UTF16Text(step.id)))
    })
  }

  // The roadmap seated by the layout the fixture names: a `radial` file is seated by the fallback directly.
  func seating() throws -> Seating {
    let engine: any LayoutEngine = engine == LayoutName.radial.rawValue ? RadialLayoutEngine() : BubbleLayoutEngine()
    return try Seating(of: try tree(), by: engine)
  }

  func renderModel() throws -> RenderModel {
    RenderModel(of: try tree(), seats: try seating().seats)
  }
}

extension RoadmapFixture.Camera {
  init(_ frame: Frame) {
    self.init(x: Number(frame.x), y: Number(frame.y), zoom: Number(frame.zoom))
  }

  var frame: Frame { Frame(x: x.value, y: y.value, zoom: zoom.value) }
}

extension RoadmapFixture.Canvas {
  var size: RoadmapLayout.Viewport { RoadmapLayout.Viewport(width: viewport.width, height: viewport.height) }

  var chrome: RoadmapLayout.Insets {
    RoadmapLayout.Insets(top: insets.top, right: insets.right, bottom: insets.bottom, left: insets.left)
  }

  // The boxes the chrome holds, each anchored to a corner by `left` or `right` and `top` or `bottom`.
  func corners() throws -> [RoadmapLayout.Block] {
    try blocks.map { block in
      let horizontal: RoadmapLayout.Block.Horizontal
      if let left = block.left { horizontal = .left(left) } else { horizontal = .right(try #require(block.right)) }
      let vertical: RoadmapLayout.Block.Vertical
      if let top = block.top { vertical = .top(top) } else { vertical = .bottom(try #require(block.bottom)) }
      return RoadmapLayout.Block(horizontal: horizontal, vertical: vertical, width: block.width, height: block.height)
    }
  }
}
