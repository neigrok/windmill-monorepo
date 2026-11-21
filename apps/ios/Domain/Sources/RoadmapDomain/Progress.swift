import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// A person's mark on a step, in their own overlay of the roadmap: complete or none, with their word that it was completed
// before its prerequisites.
public struct StepMark: Writable {
  public static let type = Roadmap.Types.progress

  public let id: ID<StepMark>
  public var status: String
  public var outOfOrder: Bool

  public init(id: ID<StepMark>, status: String = "none", outOfOrder: Bool = false) {
    self.id = id
    self.status = status
    self.outOfOrder = outOfOrder
  }

  public init(_ r: Fields) throws(DecodeError) {
    guard let mark = r.json("mark"), !mark.isNull else {
      self.init(id: ID(r.id))
      return
    }
    let held = try Fields(mark)
    self.init(id: ID(r.id), status: try held.string("status", default: "none"), outOfOrder: try held.bool("outOfOrder", default: false))
  }

  public var fields: [String: JSON] { ["mark": ["status": .string(status), "outOfOrder": .bool(outOfOrder)]] }

  public static let checks: [Check<StepMark>] = [
    Check("mark") { m, _ in m.status = try RoadmapSpecs.mark.apply(m.status, at: "mark.status") },
  ]
}

// The roadmap a step opens, in its owner's overlay only (R-3).
public struct StepPointer: Writable, Removable {
  public static let type = Roadmap.Types.pointer
  public static let heldRemoval = false

  public let id: ID<StepPointer>
  // Nil where the record holds none, as a pointer cleared before any device set it.
  public var opens: ID<RoadmapEntry>?

  public init(id: ID<StepPointer>, opens: ID<RoadmapEntry>?) {
    self.id = id
    self.opens = opens
  }

  public init(_ r: Fields) throws(DecodeError) {
    self.init(id: ID(r.id), opens: try r.optionalRef("opens", RoadmapEntry.self))
  }

  public var fields: [String: JSON] { ["opens": opens?.json ?? .null] }
  public static let checks: [Check<StepPointer>] = []
}

// What a mark or a pointer reads of its step: whether the roadmap knows it and whether it owns a subtree, from the tree,
// and the person's mark and the owner's pointer on it, from the overlay.
public struct StepOverlay: Sendable {
  public let isKnown: Bool
  public let ownsSubtree: Bool
  // The mark the overlay draws, or the blank one.
  public let mark: StepMark
  public let pointer: StepPointer?
  // Whether the overlay holds a record of the pointer, drawn or not.
  public let holdsPointer: Bool
  public let moment: Moment

  init(_ step: ID<RoadmapStep>, of tree: ID<RoadmapEntry>, in read: ActReader) throws {
    let held = try read.inScope(tree.tree) { (scope: Reader) throws -> HeldRecord<RoadmapStep> in
      try HeldRecord(RoadmapStep(id: step), in: scope.repository(RoadmapStep.self))
    }
    isKnown = held.isKnown
    ownsSubtree = held.value.branch != nil
    (mark, pointer, holdsPointer, moment) = try read.inScope(tree.overlay) { (overlay: Reader) throws -> (StepMark, StepPointer?, Bool, Moment) in
      let pointers = overlay.repository(StepPointer.self)
      return (try overlay.repository(StepMark.self).find(ID(step.record), in: .drawn) ?? StepMark(id: ID(step.record)),
              try pointers.find(ID(step.record), in: .drawn), try pointers.record(ID(step.record), in: .drawn) != nil, overlay.moment)
    }
  }
}

// §5 Complete and Reset write the step's mark in the person's overlay. A step that owns a subtree, or whose pointer opens a
// standing roadmap, is complete exactly when that roadmap is, and takes no mark. Whether the pointer's roadmap stands is
// read from the account by the caller; a pointer that dangles leaves the mark its meaning.
public struct MarkStep: ActAction {
  public let tree: ID<RoadmapEntry>
  public let step: ID<RoadmapStep>
  public let completes: Bool
  // The person's word that the step was completed before its prerequisites.
  public let outOfOrder: Bool
  public let opensStanding: Bool

  public static func complete(tree: ID<RoadmapEntry>, step: ID<RoadmapStep>, outOfOrder: Bool = false, opensStanding: Bool = false) -> MarkStep {
    MarkStep(tree: tree, step: step, completes: true, outOfOrder: outOfOrder, opensStanding: opensStanding)
  }

  public static func reset(tree: ID<RoadmapEntry>, step: ID<RoadmapStep>) -> MarkStep {
    MarkStep(tree: tree, step: step, completes: false, outOfOrder: false, opensStanding: false)
  }

  public func load(_ read: ActReader) throws -> StepOverlay {
    try StepOverlay(step, of: tree, in: read)
  }

  public func decide(_ loaded: StepOverlay, ids: ActIDSource) throws(Violation) -> ActDecision<Void, RoadmapRefusal> {
    guard loaded.isKnown else { return .refuse(.gone(step.ref, .predicted)) }
    if completes && (loaded.ownsSubtree || opensStanding) {
      throw Violation(rule: RoadmapChecks.opening, path: "step", reason: .custom("opens"))
    }
    let mark = StepMark(id: loaded.mark.id, status: completes ? "complete" : "none", outOfOrder: outOfOrder)
    guard loaded.mark.fields != mark.fields else { return .unchanged(()) }
    var plan = Plan()
    plan.create(try Valid(mark, at: loaded.moment), fields: ["mark"])
    plan.undoBy(.restoring(mark.id, fields: ["mark"], by: Roadmap.Commands.restoreOverlay))
    return .write(plan, in: tree.overlay, ())
  }
}

// The roadmap a step opens, set or cleared, in its owner's overlay.
public struct PointStep: ActAction {
  public let tree: ID<RoadmapEntry>
  public let step: ID<RoadmapStep>
  // Nil clears the pointer.
  public let opens: ID<RoadmapEntry>?

  public static func set(tree: ID<RoadmapEntry>, step: ID<RoadmapStep>, opens: ID<RoadmapEntry>) -> PointStep {
    PointStep(tree: tree, step: step, opens: opens)
  }

  public static func clear(tree: ID<RoadmapEntry>, step: ID<RoadmapStep>) -> PointStep {
    PointStep(tree: tree, step: step, opens: nil)
  }

  public func load(_ read: ActReader) throws -> StepOverlay {
    try StepOverlay(step, of: tree, in: read)
  }

  public func decide(_ loaded: StepOverlay, ids: ActIDSource) throws(Violation) -> ActDecision<Void, RoadmapRefusal> {
    guard loaded.isKnown else { return .refuse(.gone(step.ref, .predicted)) }
    let pointer = ID<StepPointer>(step.record)
    var plan = Plan()
    guard let opens else {
      guard loaded.pointer != nil else { return .unchanged(()) }
      plan.remove(pointer)
      plan.undoBy(.restoring(pointer, life: true, by: Roadmap.Commands.restoreOverlay))
      return .write(plan, in: tree.overlay, ())
    }
    guard loaded.pointer?.opens != opens else { return .unchanged(()) }
    plan.create(try Valid(StepPointer(id: pointer, opens: opens), at: loaded.moment), fields: ["opens"])
    plan.undoBy(loaded.holdsPointer
      ? .restoring(pointer, fields: ["opens"], life: true, by: Roadmap.Commands.restoreOverlay)
      : .createdRecord(restoreCommand: Roadmap.Commands.restoreOverlay, record: .of(pointer)))
    return .write(plan, in: tree.overlay, ())
  }
}
