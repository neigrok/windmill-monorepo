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
