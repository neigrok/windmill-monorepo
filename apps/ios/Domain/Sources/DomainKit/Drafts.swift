import SyncAPI
import SyncCore

// D-20 an entity being edited. A value and not `Sendable`: an editor holds one draft of a record and saves it in place,
// on the actor that holds it (§10.1).
public struct Draft<E: Draftable> {
  public let id: ID<E>
  // Opened or blank; then what the last save stored.
  public private(set) var base: E
  public var current: E
  public private(set) var isNew: Bool
  public let placement: Placement?

  public init(new blank: E) {
    self.init(blank, isNew: true, placement: nil)
  }

  public init(opening value: E) {
    self.init(value, isNew: false, placement: nil)
  }

  init(_ value: E, isNew: Bool, placement: Placement?) {
    id = value.id
    base = value
    current = value
    self.isNew = isNew
    self.placement = placement
  }

  // Every field whose value in `current` differs from `base`, by JCS, in UTF-8 order.
  public var touched: [String] {
    let (before, after) = (base.fields, current.fields)
    return Array(Set(before.keys).union(after.keys).filter { before[$0] != after[$0] }).uniqueInByteOrder
  }

  public var isDirty: Bool { !touched.isEmpty }

  // §10.3 Keep mine: every touched field keeps its value in `current`, every other takes theirs, and theirs is the base.
  public func rebased(onto theirs: E) -> Draft {
    precondition(E.savesGuarded, "rebased(onto:) resolves a stale save, and \(E.type) saves unguarded")
    precondition(theirs.id == id, "rebased(onto:) takes theirs of the draft's own record, not \(theirs.id)")
    var rebased = Draft(theirs, isNew: isNew, placement: placement)
    let mine = current.fields
    rebased.current = E.decoding(id, theirs.fields.merging(touched.map { ($0, mine[$0] ?? .null) }) { _, kept in kept })
    return rebased
  }

  // §10.1 `.saved`: base and current take the saved values as the store holds them; a draft whose record exists is no
  // longer new.
  mutating func take(_ saved: Saved) {
    base = E.decoding(id, base.fields.merging(saved.values) { _, stored in stored })
    current = E.decoding(id, current.fields.merging(saved.values) { _, stored in stored })
    if saved.exists { isNew = false }
  }
}

extension Draft where E: Ordered {
  public init(new blank: E, placed: Placement) {
    self.init(blank, isNew: true, placement: placed)
  }
}

extension Draftable {
  // §3.4 step 7: a draft takes field values by decoding the record they build, which a `Draftable` always decodes.
  static func decoding(_ id: ID<Self>, _ fields: [String: JSON]) -> Self {
    do {
      return try Self(Fields(type: type, id: id.record, values: fields))
    } catch {
      preconditionFailure("\(type) does not decode the record its own fields build: \(error)")
    }
  }
}

public enum SaveResult<R: ProductRefusal>: Sendable {
  // nil: nothing needed writing.
  case saved(CommitReceipt?)
  case refused(R)
  // A store failure, or a replica that cannot write: nothing was written, and saving again is safe.
  case failed(any Error)
}

// The fields a draft takes after its save, as stored, and whether the record is in `stored` after it. Only `SaveDraft`
// makes one, and it is not `Sendable`, so no action returns it: `save` is a draft's only door (INV-14).
public struct Saved: Equatable {
  public let values: [String: JSON]
  public let exists: Bool

  init(values: [String: JSON], exists: Bool) {
    self.values = values
    self.exists = exists
  }
}

extension ActionRunner {
  // The record as `drawn` shows it, or nil when it does not.
  public func open<E: Draftable>(_ id: ID<E>) throws -> Draft<E>? {
    try read(E.scope) { try $0.repository(E.self).find(id, in: .drawn) }.map { Draft(opening: $0) }
  }

  // A keyed or singleton record, or a new draft of its blank.
  public func open<E: Draftable>(_ id: ID<E>, orNew blank: E) throws -> Draft<E> {
    let identity = registry.type(E.type)?.identity
    precondition(identity == .keyed || identity == .singleton, "open(_:orNew:) opens a keyed or singleton type, and \(E.type) is not")
    precondition(blank.id == id, "open(_:orNew:) takes a blank of \(id), not of \(blank.id)")
    return try open(id) ?? Draft(new: blank)
  }

  // §10.1 the draft's save as one commit. Synchronous, and it never throws: a refused or failed save leaves the draft as
  // it was; a programming fault traps.
  public func save<E: Draftable, R: ProductRefusal>(_ draft: inout Draft<E>, _ type: SaveDraft<E, R>.Type) -> SaveResult<R> {
    precondition(draft.current.id == draft.id, "a draft saves its own record \(draft.id), and its current names \(draft.current.id)")
    let save = SaveDraft<E, R>(draft)
    let outcome: Outcome<Saved, R>
    do {
      outcome = try perform(in: save.scope, load: save.load, decide: save.decide)
    } catch let fault as PlanError {
      preconditionFailure("a draft's save made a plan no write path makes: \(fault)")
    } catch let fault as DecodeError {
      preconditionFailure("a record of \(E.type) does not decode: \(fault)")
    } catch {
      return .failed(error)
    }
    switch outcome {
    case .committed(let saved, let receipt):
      draft.take(saved)
      return .saved(receipt)
    case .unchanged(let saved):
      draft.take(saved)
      return .saved(nil)
    case .refused(let refusal):
      return .refused(refusal)
    }
  }
}
