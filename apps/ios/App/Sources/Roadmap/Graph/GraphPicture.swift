import CoreText
import UIKit
import RoadmapDomain
import RoadmapLayout
import SyncCore

// A roadmap's picture as RoadmapLayout draws it (Roadmap on iOS §5): every step's seat and tier, every link's bow, and
// each step's caption wrapped under the font the canvas draws it in. It is made off the main actor from the domain's
// read of the roadmap, the captions wrapped while the layout seats the steps. The seats, the tiers, the bows and the
// wrapping are the layout's and a step's state is the domain's: the picture decides none of them.
nonisolated struct GraphPicture: Sendable {
  // What seats a step: all the layout reads of it but whether it is done, each text by its code units, as the layout
  // compares them.
  struct Seated: Sendable, Equatable {
    let id: UTF16Text
    let label: UTF16Text
    let ord: UTF16Text
    let born: Stamp
    let follows: [UTF16Text]
    let hue: UTF16Text
  }

  // The steps the layout reads, in the roadmap's order: what seats each, and whether it is done.
  struct Steps: Sendable, Equatable {
    let seated: [Seated]
    let done: [Bool]

    init(seated: [Seated], done: [Bool]) {
      self.seated = seated
      self.done = done
    }

    // A roadmap's present steps as the domain reads them: each following what it follows through any step that is
    // gone, and done where its state is complete.
    init(of roadmap: FollowGraph) {
      var seated: [Seated] = []
      var done: [Bool] = []
      for (id, state) in roadmap.states {
        guard let step = roadmap.tree.step(id) else { continue }
        seated.append(Seated(id: UTF16Text(id), label: UTF16Text(step.label), ord: UTF16Text(step.ord), born: step.born,
                             follows: roadmap.followed(id).map { UTF16Text($0.id) }, hue: UTF16Text(step.color)))
        done.append(state == .complete)
      }
      self.init(seated: seated, done: done)
    }
  }

  // A link as the canvas draws it: its two steps by their places, the control point of its curve, the box that holds
  // the curve, and whether it is lit, which a link leaving a done step is.
  struct Bow: Sendable {
    let from: Int
    let to: Int
    let control: Point
    let box: Rect
    let lit: Bool
  }

  // The captions' type: the kit's 13 pt semibold, which the layout's 20 px line holds.
  static let captionSize: CGFloat = 13

  // A step's place in `steps` names it in every list below.
  let steps: Steps
  // The layout that seated the roadmap: radial where the bubble layout threw and the fallback took over.
  let engine: LayoutName
  let seats: [Point]
  let model: RenderModel
  let bows: [Bow]
  // The hues the roadmap's steps wear, and each step's among them.
  let hues: [String]
  let hueOf: [Int]
  let placeOf: [UTF16Text: Int]
  // What the layout's caption placer reads beside the model: the steps near a view, and each step's wrapped caption.
  let grid: SpatialGrid
  let metrics: [UTF16Text: CaptionMetric]

  // The picture of these steps, seated by `engine`, or by the layout's fallback where it refuses them. `previous` is
  // the picture last drawn, which lends its seats and captions where only a step's being done changed, since that
  // moves no seat. `measure` is a text's width in points under the caption's font; the font itself measures where
  // none is given.
  init(_ steps: Steps, after previous: GraphPicture? = nil, by engine: any LayoutEngine = BubbleLayoutEngine(),
       measure: (@Sendable (String) -> Double)? = nil) async throws {
    let tree = try SkillTree(steps: zip(steps.seated, steps.done).map { (step: Seated, done: Bool) -> SkillTree.Step in
      SkillTree.Step(id: step.id.text, label: step.label.text, ord: step.ord.text,
                     born: SkillTree.Stamp(ms: step.born.ms, counter: Int64(step.born.counter), actor: step.born.actor),
                     follows: step.follows.map(\.text), hue: step.hue.text, done: done)
    })
    if let previous, previous.steps.seated == steps.seated {
      self.engine = previous.engine
      seats = previous.seats
      metrics = previous.metrics
    } else {
      // One wrap for each distinct label; a blank label has no caption.
      async let captions = { () -> [UTF16Text: CaptionMetric] in
        let font = UIFont.systemFont(ofSize: Self.captionSize, weight: .semibold)
        let width = measure ?? { (text: String) -> Double in
          CTLineGetTypographicBounds(CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [.font: font])), nil, nil, nil)
        }
        var wrapped: [UTF16Text: CaptionMetric?] = [:]
        var metrics: [UTF16Text: CaptionMetric] = [:]
        for step in steps.seated {
          if wrapped[step.label] == nil { wrapped[step.label] = .some(CaptionMetric(wrapping: step.label.text, measure: width)) }
          if let metric = wrapped[step.label] ?? nil { metrics[step.id] = metric }
        }
        return metrics
      }()
      let seating = try Seating(of: tree, by: engine)
      self.engine = seating.engine
      seats = seating.seats
      metrics = await captions
    }
    let model = RenderModel(of: tree, seats: seats)
    self.steps = steps
    self.model = model
    bows = model.links.map { (link: RenderModel.Link) -> Bow in
      let (from, to, control) = (model.nodes[link.from], model.nodes[link.to], model.controlPoint(of: link))
      return Bow(from: link.from, to: link.to, control: control,
                 box: Rect(minX: min(from.x, to.x, control.x), maxX: max(from.x, to.x, control.x),
                           minY: min(from.y, to.y, control.y), maxY: max(from.y, to.y, control.y)),
                 lit: from.tier == .complete)
    }
    var hues: [String] = []
    var known: [UTF16Text: Int] = [:]
    hueOf = steps.seated.map { (step: Seated) -> Int in
      if let place = known[step.hue] { return place }
      known[step.hue] = hues.count
      hues.append(step.hue.text)
      return hues.count - 1
    }
    self.hues = hues
    placeOf = Dictionary(steps.seated.enumerated().map { ($0.element.id, $0.offset) }) { first, _ in first }
    grid = SpatialGrid(model.nodes, cellSize: Theme.nodeSize * 2)
  }
}
