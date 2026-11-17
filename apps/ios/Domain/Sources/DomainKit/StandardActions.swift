import SyncAPI
import SyncCore

// §10.2 and §11: a draft's save, and the standard removal and move. Each is a decider, so an action may compose it into
// its own plan (§9.3).

public struct SaveDraft<E: Draftable, R: ProductRefusal>: Decider {
  public let scope: ScopeRef
  let recordID: ID<E>
  let base: E
  let current: E
  let isNew: Bool
  let placement: Placement?
  let touched: [String]
  let creating: Bool

  // Only `ActionRunner.save` builds a draft's save, and the kit's test support, which runs one over a product's vectors.
  package init(_ draft: Draft<E>) {
    precondition(draft.current.id == draft.id, "a draft saves its own record \(draft.id), and its current names \(draft.current.id)")
    scope = draft.scope
    recordID = draft.id
    base = draft.base
    current = draft.current
    isNew = draft.isNew
    placement = draft.placement
    touched = draft.touched
    creating = false
  }

  // An executor's own new record of a minted type, every field touched.
  public init(creating value: E, in scope: ScopeRef) {
    self.init(creating: value, in: scope, placement: nil)
  }

  init(creating value: E, in scope: ScopeRef, placement: Placement?) {
    precondition(EntityFacts(E.self).scope.map { $0 == scope } ?? true, "\(E.type) cannot be rebound to \(scope)")
    self.scope = scope
    recordID = value.id
    base = value
    current = value
    isNew = true
    self.placement = placement
    touched = Array(value.fields.keys).uniqueInByteOrder
    creating = true
  }

  public var id: ID<E> { recordID }

  public func load(_ read: Reader) throws -> SaveDraftLoaded<E> {
    precondition(read.scope == scope, "a decider loads its bound scope")
    guard let definition = read.registry.type(E.type) else { preconditionFailure("the registry holds no type \(E.type)") }
    let repository = read.repository(E.self)
    let folded = try repository.record(id.record, in: .stored).map { record throws in try E(Fields(record)) }
    let orderField = (E.self as? any Ordered.Type)?.orderField
    let anchor = try orderField.flatMap { field in isNew ? try repository.anchor(placement ?? .bottom, orderField: field) : nil }
    return SaveDraftLoaded(drawn: try repository.find(id, in: .drawn), stored: try repository.find(id, in: .stored), folded: folded,
                           anchor: anchor, moment: read.moment, definition: definition)
  }

  // §10.2, in order: taken (a creating save), whole, unchanged, gone, create, present again, update.
  public func decide(_ loaded: SaveDraftLoaded<E>, ids: IDSource) throws(Violation) -> Decision<Saved, R> {
    if creating && (loaded.drawn != nil || loaded.stored != nil) { return .refuse(refusal(.idTaken)) }
    if loaded.definition.wholePut { return try whole(loaded) }
    let minted = loaded.definition.identity == .minted
    if touched.isEmpty && !(isNew && minted) { return .unchanged(Saved(values: [:], exists: loaded.stored != nil)) }
    if loaded.drawn == nil && isGone(loaded) { return .refuse(refusal(.unknownRecord)) }
    if minted && loaded.stored == nil { return try create(loaded) }
    if !minted && loaded.drawn == nil { return try presentAgain(loaded) }
    return try update(loaded)
  }

  // Step 1: a record that is one fact (engine §2.4) is saved whole, whatever is touched: every field validated, a
  // `Timestamped` entity's at the moment's now, and written with a fresh life. So it is never unchanged, gone or stale,
  // and it retires this device's held removal of it: the newest save wins whole.
  func whole(_ loaded: SaveDraftLoaded<E>) throws(Violation) -> Decision<Saved, R> {
    let valid = try Valid(current, at: loaded.moment)
    var plan = Plan()
    plan.create(valid)
    return .write(plan, Saved(values: valid.value.fields, exists: true))
  }

  // Step 3: a minted record that is not new, or stored while drawn is not; a keyed record another device deleted.
  func isGone(_ loaded: SaveDraftLoaded<E>) -> Bool {
    switch loaded.definition.identity {
    case .minted: !isNew || loaded.stored != nil
    case .keyed where loaded.definition.life: !isNew && loaded.stored == nil
    default: false
    }
  }

  // Step 4: every field validated and written; an ordered type placed below its anchor. A nil time field is the engine's
  // to fill, with the commit's now, which is the moment's.
  func create(_ loaded: SaveDraftLoaded<E>) throws(Violation) -> Decision<Saved, R> {
    let valid = try Valid(current, at: loaded.moment)
    var plan = Plan()
    if E.self is any Ordered.Type {
      plan.place(valid, below: loaded.anchor)
    } else {
      plan.create(valid)
    }
    let stamped = valid.value.fields.map { name, value in
      (name, value.isNull && loaded.definition.field(name)?.isTime == true ? JSON(loaded.moment.now.ms) : value)
    }
    return .write(plan, Saved(values: Dictionary(uniqueKeysWithValues: stamped), exists: true))
  }

  // Step 5: a keyed or singleton record drawn nowhere writes the touched fields, never compared with `stored`; a text
  // field edits from the base's text (§10.1), "" in a blank.
  func presentAgain(_ loaded: SaveDraftLoaded<E>) throws(Violation) -> Decision<Saved, R> {
    let valid = isNew ? try Valid(current, at: loaded.moment) : try Valid(current, fields: touched, at: loaded.moment)
    var plan = Plan()
    plan.create(valid, fields: touched, from: base)
    let written = valid.value.fields
    let values = (loaded.folded ?? base).fields.merging(touched.map { ($0, written[$0] ?? .null) }) { _, touched in touched }
    return .write(plan, Saved(values: values, exists: true))
  }

  // Step 6: the touched fields the store does not already hold, refused stale when a guarded one moved since the base.
  func update(_ loaded: SaveDraftLoaded<E>) throws(Violation) -> Decision<Saved, R> {
    let valid = try Valid(current, fields: touched, at: loaded.moment)
    let (stored, written, before) = (loaded.stored?.fields ?? [:], valid.value.fields, base.fields)
    let settled = Dictionary(uniqueKeysWithValues: touched.map { ($0, written[$0] ?? .null) })
    let changed = touched.filter { stored[$0] != written[$0] }
    if changed.isEmpty { return .unchanged(Saved(values: settled, exists: loaded.stored != nil)) }
    if E.savesGuarded && changed.contains(where: { loaded.definition.field($0)?.kind.isLattice == true && stored[$0] != before[$0] }) {
      return .refuse(refusal(.stale))
    }
    var plan = Plan()
    plan.update(valid, fields: changed, from: base, guarded: E.savesGuarded)
    return .write(plan, Saved(values: settled, exists: true))
  }

  func refusal(_ code: RefusalCode) -> R {
    R(Refused(code, subject: id.ref, path: .predicted))
  }
}

extension SaveDraft where E: Ordered {
  public init(creating value: E, in scope: ScopeRef, placed: Placement) {
    self.init(creating: value, in: scope, placement: placed)
  }
}

// §10.2's load: the record in each view, the stored record visible or not, the anchor of a new ordered draft, the moment.
public struct SaveDraftLoaded<E: Draftable>: Sendable {
  public let drawn: E?, stored: E?, folded: E?, anchor: RecordID?
  public let moment: Moment
  let definition: TypeDef

  init(drawn: E?, stored: E?, folded: E?, anchor: RecordID?, moment: Moment, definition: TypeDef) {
    self.drawn = drawn
    self.stored = stored
    self.folded = folded
    self.anchor = anchor
    self.moment = moment
    self.definition = definition
  }
}

// §11 a removal of what the person sees, held per `E.heldRemoval`; a record they cannot see is not removed again.
public struct Remove<E: Removable, R: ProductRefusal>: Action {
  let id: ID<E>

  public let scope: ScopeRef

  public init(_ id: ID<E>, in scope: ScopeRef) {
    precondition(EntityFacts(E.self).scope.map { $0 == scope } ?? true, "\(E.type) cannot be rebound to \(scope)")
    self.scope = scope
    self.id = id
  }

  public func load(_ read: Reader) throws -> E? {
    precondition(read.scope == scope, "a decider loads its bound scope")
    return try read.repository(E.self).find(id, in: .drawn)
  }

  public func decide(_ loaded: E?, ids: IDSource) throws(Violation) -> Decision<Void, R> {
    guard loaded != nil else { return .unchanged(()) }
    var plan = Plan()
    plan.remove(id)
    return .write(plan)
  }
}

// §11 a move below another member of the drawn list; a drop in place writes nothing, so it never reverts another device's
// reorder.
public struct Move<E: Ordered, R: ProductRefusal>: Action {
  let id: ID<E>
  let below: ID<E>?

  public let scope: ScopeRef

  public init(_ id: ID<E>, in scope: ScopeRef, below: ID<E>?) {
    precondition(EntityFacts(E.self).scope.map { $0 == scope } ?? true, "\(E.type) cannot be rebound to \(scope)")
    self.scope = scope
    self.id = id
    self.below = below
  }

  public func load(_ read: Reader) throws -> (moving: E?, above: ID<E>?) {
    precondition(read.scope == scope, "a decider loads its bound scope")
    let members = try read.repository(E.self).all(in: .drawn)
    guard let index = members.firstIndex(where: { $0.id == id }) else { return (nil, nil) }
    return (members[index], index == members.startIndex ? nil : members[index - 1].id)
  }

  public func decide(_ loaded: (moving: E?, above: ID<E>?), ids: IDSource) throws(Violation) -> Decision<Void, R> {
    guard loaded.moving != nil else { return .refuse(R(Refused(.unknownRecord, subject: id.ref, path: .predicted))) }
    if below == id || below == loaded.above { return .unchanged(()) }
    var plan = Plan()
    plan.move(id, below: below)
    return .write(plan)
  }
}

extension SaveDraft where E: ProductEntity {
  public init(creating value: E) { self.init(creating: value, in: E.scope) }
}

extension SaveDraft where E: ProductEntity & Ordered {
  public init(creating value: E, placed: Placement) { self.init(creating: value, in: E.scope, placed: placed) }
}

extension Remove where E: ProductEntity {
  public init(_ id: ID<E>) { self.init(id, in: E.scope) }
}

extension Move where E: ProductEntity {
  public init(_ id: ID<E>, below: ID<E>?) { self.init(id, in: E.scope, below: below) }
}
