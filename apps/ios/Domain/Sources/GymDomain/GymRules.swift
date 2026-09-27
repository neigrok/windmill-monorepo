import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// The gym's rule book, every gym feature's entities and rules, pinned by packages/api-contract/gym/domain/rules.json.
public enum GymRules {
  public static let book = RuleBook(registry: SyncSchema.registry, entities: [Note.self], rules: NoteRules.rules)
}

// The gym's one refusal: every code its rules declare, mapped from the code, the subject, the path and a cap's detail.
public enum GymRefusal: ProductRefusal, Equatable {
  case invalid(Violation)
  case stale(RecordRef, Refused.Path)
  case gone(RecordRef, Refused.Path)
  case taken(RecordRef, Refused.Path)
  case full(type: String, cap: Int, Refused.Path)
  case other(Refused)

  public init(_ v: Violation) {
    self = .invalid(v)
  }

  public init(_ r: Refused) {
    switch (r.code, r.subject, r.cap) {
    case (.stale, let s?, _): self = .stale(s, r.path)
    case (.unknownRecord, let s?, _), (.recordDead, let s?, _): self = .gone(s, r.path)
    case (.idTaken, let s?, _), (.idSpent, let s?, _): self = .taken(s, r.path)
    case (.cap, _, let c?): self = .full(type: c.type, cap: c.cap, r.path)
    default: self = .other(r)
    }
  }

  public var isGeneric: Bool {
    guard case .other = self else { return false }
    return true
  }
}
