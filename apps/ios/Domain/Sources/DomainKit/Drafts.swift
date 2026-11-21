import SyncAPI
import SyncCore

// D-20 an entity being edited. A value and not `Sendable`: an editor holds one draft of a record and saves it in place,
// on the actor that holds it (§10.1).
public struct Draft<E: Draftable> {
  public let scope: ScopeRef
  public let id: ID<E>
  // Opened or blank; then what the last save stored.
  public private(set) var base: E
  public var current: E
  public private(set) var isNew: Bool
  public let placement: Placement?

  public init(new blank: E, in scope: ScopeRef) {
    self.init(blank, in: scope, isNew: true, placement: nil)
  }

  public init(opening value: E, in scope: ScopeRef) {
    self.init(value, in: scope, isNew: false, placement: nil)
  }

  init(_ value: E, in scope: ScopeRef, isNew: Bool, placement: Placement?) {
    precondition(EntityFacts(E.self).scope.map { $0 == scope } ?? true, "\(E.type) cannot be rebound to \(scope)")
    self.scope = scope
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
    var rebased = Draft(theirs, in: scope, isNew: isNew, placement: placement)
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
  public init(new blank: E, in scope: ScopeRef, placed: Placement) {
    self.init(blank, in: scope, isNew: true, placement: placed)
  }
}

extension Draft {
  // §10.1 the keyed or singleton record of the blank's id as `drawn` shows it, or a new draft of the blank: how
  // `open(_:orNew:)` and the kit's test support open one.
  package init(orNew blank: E, in read: Reader) throws {
    let identity = read.registry.type(E.type)?.identity
    precondition(identity == .keyed || identity == .singleton, "open(_:orNew:) opens a keyed or singleton type, and \(E.type) is not")
    self = try read.repository(E.self).find(blank.id, in: .drawn).map { Draft(opening: $0, in: read.scope) } ?? Draft(new: blank, in: read.scope)
  }
}

public enum SaveResult<R: ProductRefusal>: Sendable {
  // nil: nothing needed writing.
  case saved(CommitReceipt?)
  case refused(R)
  // A store failure, or a replica that cannot write: no gesture was written, and saving again is safe.
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

// §10.2 Reversible: a draft's save as the reversible action `run` takes. Its `Saved` travels as the values and presence it
// holds, which the act path can carry, and becomes a `Saved` again only in `save`.
struct ReversibleSave<E: Draftable, R: ProductRefusal>: Action {
  struct Carried: Sendable {
    let values: [String: JSON]
    let exists: Bool

    var saved: Saved { Saved(values: values, exists: exists) }
  }

  let save: SaveDraft<E, R>

  var scope: ScopeRef { save.scope }
  var reversible: Bool { true }

  func load(_ read: Reader) throws -> SaveDraftLoaded<E> {
    try save.load(read)
  }

  func decide(_ loaded: SaveDraftLoaded<E>, ids: IDSource) throws(Violation) -> Decision<Carried, R> {
    switch try save.decide(loaded, ids: ids) {
    case .write(let plan, let saved): .write(plan, Carried(values: saved.values, exists: saved.exists))
    case .unchanged(let saved): .unchanged(Carried(values: saved.values, exists: saved.exists))
    case .refuse(let refusal): .refuse(refusal)
    }
  }
}

extension ActionRunner {
  // The record as `drawn` shows it, or nil when it does not.
  public func open<E: Draftable>(_ id: ID<E>, in scope: ScopeRef) throws -> Draft<E>? {
    precondition(EntityFacts(E.self).scope.map { $0 == scope } ?? true, "\(E.type) cannot be rebound to \(scope)")
    precondition(registry.lives(E.type, in: scope), "\(E.type) is outside \(scope)")
    return try read(scope) { try $0.repository(E.self).find(id, in: .drawn) }.map { Draft(opening: $0, in: scope) }
  }

  // A keyed or singleton record, or a new draft of its blank.
  public func open<E: Draftable>(_ id: ID<E>, in scope: ScopeRef, orNew blank: E) throws -> Draft<E> {
    precondition(EntityFacts(E.self).scope.map { $0 == scope } ?? true, "\(E.type) cannot be rebound to \(scope)")
    precondition(registry.lives(E.type, in: scope), "\(E.type) is outside \(scope)")
    precondition(blank.id == id, "open(_:orNew:) takes a blank of \(id), not of \(blank.id)")
    return try read(scope) { try Draft(orNew: blank, in: $0) }
  }

  // §10.1 the draft's save as one commit. Synchronous, and it never throws: a refused or failed save leaves the draft as
  // it was; a programming fault traps. A type that saves reversibly saves through the act path (§10.2 Reversible), so the
  // receipt's gesture id is the act an Undo names.
  public func save<E: Draftable, R: ProductRefusal>(_ draft: inout Draft<E>, _ type: SaveDraft<E, R>.Type) -> SaveResult<R> {
    let outcome: Outcome<Saved, R>
    do {
      let save = SaveDraft<E, R>(draft)
      if save.reversible {
        switch try run(ReversibleSave(save: save)) {
        case .committed(let carried, let receipt): outcome = .committed(carried.saved, receipt)
        case .unchanged(let carried): outcome = .unchanged(carried.saved)
        case .refused(let refusal): outcome = .refused(refusal)
        }
      } else {
        outcome = try perform(save)
      }
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

extension Draft where E: ProductEntity {
  public init(new blank: E) { self.init(new: blank, in: E.scope) }
  public init(opening value: E) { self.init(opening: value, in: E.scope) }
}

extension Draft where E: ProductEntity & Ordered {
  public init(new blank: E, placed: Placement) { self.init(new: blank, in: E.scope, placed: placed) }
}

extension ActionRunner {
  public func open<E: Draftable & ProductEntity>(_ id: ID<E>) throws -> Draft<E>? {
    try open(id, in: E.scope)
  }

  public func open<E: Draftable & ProductEntity>(_ id: ID<E>, orNew blank: E) throws -> Draft<E> {
    try open(id, in: E.scope, orNew: blank)
  }

  public func save<E: Draftable, R: ProductRefusal>(_ draft: inout Draft<E>, in scope: ScopeRef,
                                                  _ type: SaveDraft<E, R>.Type) -> SaveResult<R> {
    precondition(draft.scope == scope, "a draft saves in its bound scope")
    return save(&draft, type)
  }
}
