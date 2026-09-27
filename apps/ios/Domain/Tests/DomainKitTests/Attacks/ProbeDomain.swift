import DomainKit
import SyncAPI
import SyncCore

// The product domain every attack compiles against: an ordered, guarded card with a held removal, and a keyed mark with
// a text field, over the engine's probe registry.

public struct Card: Draftable, Removable, Ordered {
  public static let type = "card"
  public static let scope = ScopeRef.product("probe")
  public static let orderField = "ord"
  public static let savesGuarded = true
  public static let heldRemoval = true
  static let title = TextSpec("card.title", unit: .chars, min: 1, max: 12, trim: true, nfc: true)

  public let id: ID<Card>
  public var title: String

  public init(id: ID<Card>, title: String = "") {
    self.id = id
    self.title = title
  }

  public init(_ r: Fields) throws(DecodeError) {
    self.init(id: ID(r.id), title: try r.string("title", default: ""))
  }

  public var fields: [String: JSON] { ["title": .string(title)] }

  public static let checks: [Check<Card>] = [
    Check("title") { c, _ in c.title = try Card.title.apply(c.title, at: "title") },
  ]
}

public struct Mark: Draftable {
  public static let type = "mark"
  public static let scope = ScopeRef.overlay("b_00000001")
  public static let savesGuarded = false

  public let id: ID<Mark>
  public var memo: String

  public init(id: ID<Mark>, memo: String = "") {
    self.id = id
    self.memo = memo
  }

  public init(_ r: Fields) throws(DecodeError) {
    self.init(id: ID(r.id), memo: r.text("memo"))
  }

  public var fields: [String: JSON] { ["memo": .string(memo)] }
  public static let checks: [Check<Mark>] = []
}

public enum ProbeRefusal: ProductRefusal, Equatable {
  case violation(Violation)
  case refused(Refused)

  public init(_ violation: Violation) { self = .violation(violation) }
  public init(_ refused: Refused) { self = .refused(refused) }

  public var isGeneric: Bool {
    guard case .refused = self else { return false }
    return true
  }
}

public typealias SaveCard = SaveDraft<Card, ProbeRefusal>
public typealias SaveMark = SaveDraft<Mark, ProbeRefusal>
public typealias DeleteCard = Remove<Card, ProbeRefusal>
public typealias MoveCard = Move<Card, ProbeRefusal>
