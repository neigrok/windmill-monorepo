import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// A kind of the roadmap's legend: a hue, its words, and its place among the roadmap's kinds.
public struct RoadmapKind: Writable, Removable {
  public static let type = Roadmap.Types.kind
  public static let heldRemoval = false

  public let id: ID<RoadmapKind>
  public var hue: String
  public var label: String
  public var description: String
  public var ord: String?

  public init(id: ID<RoadmapKind>, hue: String = Roadmap.Defaults.Kind.hue, label: String = Roadmap.Defaults.Kind.label,
              description: String = Roadmap.Defaults.Kind.description, ord: String? = nil) {
    self.id = id
    self.hue = hue
    self.label = label
    self.description = description
    self.ord = ord
  }

  public init(_ r: Fields) throws(DecodeError) {
    self.init(id: ID(r.id), hue: try r.string("hue", default: Roadmap.Defaults.Kind.hue), label: try r.string("label", default: Roadmap.Defaults.Kind.label),
              description: try r.string("description", default: Roadmap.Defaults.Kind.description), ord: try r.optionalString("ord"))
  }

  public var fields: [String: JSON] {
    ["hue": .string(hue), "label": .string(label), "description": .string(description), "ord": .of(ord)]
  }

  public static let checks: [Check<RoadmapKind>] = [
    Check("hue") { k, _ in k.hue = try RoadmapSpecs.hue.apply(k.hue, at: "hue") },
    Check("label") { k, _ in k.label = try RoadmapSpecs.kindLabel.apply(k.label, at: "label") },
    Check("description") { k, _ in k.description = try RoadmapSpecs.kindDescription.apply(k.description, at: "description") },
  ]
}
