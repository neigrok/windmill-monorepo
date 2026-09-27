import DomainKit
import DomainKitTesting
import SyncAPI
import SyncCore

// The probe declarations of packages/api-contract/domain-kit/README.md: a product's entities, commands and refusal
// over the engine's test-only probe registry. Test code, not kit content.

enum Probe {
  static let scope = ScopeRef.product("probe")
  static let tree = ScopeRef.tree("b_00000001")
  static let overlay = ScopeRef.overlay("b_00000001")
  static let start = Instant(ms: 1_800_000_000_000)
}

// A probe entity decodes from a vector's `f` with its id, each field it leaves out at its default.
protocol ProbeEntity: Writable {}

extension ProbeEntity {
  static func decoding(_ id: RecordID, _ f: [String: JSON]) throws -> Self {
    try Self(Fields(Record(type: type, id: id, life: nil, born: nil, values: f, texts: [:], serials: [:], rc: nil, ru: nil,
                           isVisible: true, isPending: false, isHeld: false)))
  }
}

struct Card: ProbeEntity, Draftable, Removable, Ordered {
  static let type = "card"
  static let scope = Probe.scope
  static let orderField = "ord"
  static let savesGuarded = true
  static let heldRemoval = true
  static let title = TextSpec("card.title", unit: .chars, min: 1, max: 12, trim: true, nfc: true)
  static let body = TextSpec("card.body", unit: .bytes, min: 0, max: 24, trim: true, nfc: true)
  static let size = NumberSpec("card.size", min: -500, max: 500, quantum: 0.01)
  static let claim = TextSpec("card.claim", unit: .chars, min: 0, max: 12, trim: true, nfc: true)
  static let tier = ChoiceSpec("card.tier", values: ["draft", "review", "done", "dropped"])

  let id: ID<Card>
  var title: String
  var body: String
  var size: Double?
  var claim: String?
  var tier: String

  init(id: ID<Card>, title: String = "", body: String = "", size: Double? = nil, claim: String? = nil, tier: String = "draft") {
    self.id = id
    self.title = title
    self.body = body
    self.size = size
    self.claim = claim
    self.tier = tier
  }

  init(_ r: Fields) throws(DecodeError) {
    self.init(id: ID(r.id), title: try r.string("title", default: ""), body: try r.string("body", default: ""),
              size: try r.optionalDouble("size"), claim: try r.optionalString("claim"), tier: try r.string("tier", default: "draft"))
  }

  var fields: [String: JSON] {
    ["title": .string(title), "body": .string(body), "size": .of(size), "claim": .of(claim), "tier": .string(tier)]
  }

  static let checks: [Check<Card>] = [
    Check("title") { c, _ in c.title = try Card.title.apply(c.title, at: "title") },
    Check("body") { c, _ in c.body = try Card.body.apply(c.body, at: "body") },
    Check("size") { c, _ in c.size = try Card.size.apply(c.size, at: "size") },
    Check("claim") { c, _ in c.claim = try Card.claim.apply(c.claim, at: "claim") },
    Check("tier") { c, _ in c.tier = try Card.tier.apply(c.tier, at: "tier") },
  ]
}

struct Day: ProbeEntity, Draftable, Removable {
  static let type = "day"
  static let scope = Probe.scope
  static let savesGuarded = false
  static let heldRemoval = true
  static let score = NumberSpec("day.score", min: 0, max: 10, integer: true)

  let id: ID<Day>
  var score: Int?

  init(id: ID<Day>, score: Int? = nil) {
    self.id = id
    self.score = score
  }

  init(_ r: Fields) throws(DecodeError) {
    self.init(id: ID(r.id), score: try r.optionalInt("score"))
  }

  var fields: [String: JSON] { ["score": .of(score)] }

  static let checks: [Check<Day>] = [
    .key { d, moment in
      if let day = d.id.day, day > moment.today { throw Violation(rule: "day.notFuture", path: "id", reason: .custom("future")) }
    },
    Check("score") { d, _ in d.score = try Day.score.apply(d.score, at: "score") },
  ]
}

struct Mark: ProbeEntity, Draftable {
  static let type = "mark"
  static let scope = Probe.overlay
  static let savesGuarded = false
  static let memo = TextSpec("mark.memo", unit: .bytes, min: 0, max: 40, trim: false, nfc: false)

  let id: ID<Mark>
  var done: Bool?
  var memo: String

  init(id: ID<Mark>, done: Bool? = nil, memo: String = "") {
    self.id = id
    self.done = done
    self.memo = memo
  }

  init(_ r: Fields) throws(DecodeError) {
    self.init(id: ID(r.id), done: r.json("done").flatMap { if case .bool(let done) = $0 { done } else { nil } }, memo: r.text("memo"))
  }

  var fields: [String: JSON] { ["done": done.map { .bool($0) } ?? .null, "memo": .string(memo)] }

  static let checks: [Check<Mark>] = [
    Check("memo") { m, _ in m.memo = try Mark.memo.apply(m.memo, at: "memo") },
  ]
}

struct Meta: ProbeEntity, Draftable {
  static let type = "meta"
  static let scope = Probe.tree
  static let savesGuarded = false
  static let title = TextSpec("meta.title", unit: .chars, min: 0, max: 12, trim: true, nfc: true)

  let id: ID<Meta>
  var title: String

  init(id: ID<Meta>, title: String = "") {
    self.id = id
    self.title = title
  }

  init(_ r: Fields) throws(DecodeError) {
    self.init(id: ID(r.id), title: try r.string("title", default: ""))
  }

  var fields: [String: JSON] { ["title": .string(title)] }

  static let checks: [Check<Meta>] = [
    Check("title") { m, _ in m.title = try Meta.title.apply(m.title, at: "title") },
  ]
}

struct Lap: ProbeEntity, Removable {
  static let type = "lap"
  static let scope = Probe.scope
  static let heldRemoval = false
  static let weight = NumberSpec("lap.weight", min: -500, max: 500, quantum: 0.01)

  let id: ID<Lap>
  var runId: String
  var at: Instant?
  var weight: Double?

  init(_ r: Fields) throws(DecodeError) {
    id = ID(r.id)
    runId = try r.string("runId", default: "")
    at = try r.optionalInstant("at")
    weight = try r.optionalDouble("weight")
  }

  var fields: [String: JSON] { ["runId": .string(runId), "at": .of(at), "weight": .of(weight)] }

  static let checks: [Check<Lap>] = [
    Check("weight") { l, _ in l.weight = try Lap.weight.apply(l.weight, at: "weight") },
  ]
}

struct Run: ProbeEntity, Removable {
  static let type = "run"
  static let scope = Probe.scope
  static let heldRemoval = false
  static let label = TextSpec("run.label", unit: .chars, min: 0, max: 12, trim: true, nfc: true)

  let id: ID<Run>
  var startedAt: Instant?
  var label: String?

  init(_ r: Fields) throws(DecodeError) {
    id = ID(r.id)
    startedAt = try r.optionalInstant("startedAt")
    label = try r.optionalString("label")
  }

  var fields: [String: JSON] { ["startedAt": .of(startedAt), "label": .of(label)] }

  static let checks: [Check<Run>] = [
    Check("label") { r, _ in r.label = try Run.label.apply(r.label, at: "label") },
  ]
}

struct Link: ProbeEntity, Removable {
  static let type = "link"
  static let scope = Probe.tree
  static let heldRemoval = true
  static let strength = NumberSpec("link.strength", min: 0, max: 9, integer: true)

  let id: ID<Link>
  var strength: Int?

  init(_ r: Fields) throws(DecodeError) {
    id = ID(r.id)
    strength = try r.optionalInt("strength")
  }

  var fields: [String: JSON] { ["strength": .of(strength)] }

  static let checks: [Check<Link>] = [
    Check("strength") { l, _ in l.strength = try Link.strength.apply(l.strength, at: "strength") },
  ]
}

struct Tag: ProbeEntity {
  static let type = "tag"
  static let scope = Probe.tree

  let id: ID<Tag>
  var label: String

  init(_ r: Fields) throws(DecodeError) {
    id = ID(r.id)
    label = try r.string("label", default: "")
  }

  var fields: [String: JSON] { ["label": .string(label)] }

  static let checks: [Check<Tag>] = []
}

// The entity a vector names by its registry type.
func probeEntity(_ type: String) throws -> any ProbeEntity.Type {
  let entities: [any ProbeEntity.Type] = [Card.self, Day.self, Mark.self, Meta.self, Lap.self, Run.self, Link.self, Tag.self]
  guard let entity = entities.first(where: { $0.type == type }) else { throw ContractError("no probe entity \(type)") }
  return entity
}

// MARK: - Commands

struct ProbeStart: ServerCommand {
  static let name = "probe.start"
  static let specs: [any ValueSpec] = [TextSpec("probe.start.label", unit: .chars, min: 0, max: 12, trim: true, nfc: true)]
  let args: [String: JSON]
}

struct ProbeEnd: ServerCommand {
  static let name = "probe.end"
  static let specs: [any ValueSpec] = []
  let args: [String: JSON]
}

struct ProbeCopy: ServerCommand {
  static let name = "probe.copy"
  static let specs: [any ValueSpec] = []
  let args: [String: JSON]
}

// MARK: - The refusal

enum ProbeRefusal: ProductRefusal, Equatable {
  case violation(Violation)
  case refused(Refused)

  init(_ violation: Violation) {
    self = .violation(violation)
  }

  init(_ refused: Refused) {
    self = .refused(refused)
  }

  var isGeneric: Bool {
    guard case .refused = self else { return false }
    return true
  }

  var form: JSON {
    switch self {
    case .violation(let violation): ["violation": violation.form]
    case .refused(let refused): ["refused": refused.form]
    }
  }
}
