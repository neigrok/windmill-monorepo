import SyncAPI
import SyncCore

// The outbox's own moves: coalescing and the silent fold a cancel, an undo and a retire share (§7.2, §7.3), hold,
// release and undo (§7.3), and the dependents that folds, refusals and held-back numbering read (§7.7 step 3, §7.4).

// MARK: - Coalescing (§7.2)

public struct Coalescing: Sendable {
  public let registry: Registry

  public init(registry: Registry) {
    self.registry = registry
  }

  // A ready plain entry joins the last earlier entry touching its record, when that one is ready, plain and never
  // numbered, no command entry of the scope lies between them, and text comes from one engine instance. An entry that
  // made its record alive, a create or a revive, cancels with its dependents when the join leaves it dead. It made the
  // record alive only if drawn without it holds the record not alive, so a cancel never changes what is drawn (§11.2
  // property 2): a delete that absorbed a revive of a live record did not, and is sent.
  @discardableResult
  public func coalesce(_ localId: String, in replica: inout LoadedReplica) throws -> Bool {
    guard let entry = replica.entry(localId), entry.state == .ready, entry.isPlain else { return false }
    let delta = entry.intent.deltas[0]
    let earlier = replica.entries(in: entry.scope).filter { $0.commitOrder < entry.commitOrder }
    guard let target = earlier.last(where: { $0.touches(delta.key) }), target.state == .ready, !target.numbered, target.isPlain
    else { return false }
    guard !earlier.contains(where: { $0.commitOrder > target.commitOrder && $0.intent.command != nil }) else { return false }
    guard delta.texts.isEmpty || target.stamp.actor.utf8.elementsEqual(entry.stamp.actor.utf8) else { return false }

    let base = target.intent.deltas[0]
    var joined = Delta(key: base.key, lattice: try Join.record(registry.type(delta.key.type), base.lattice, delta.lattice), texts: base.texts)
    for (name, write) in delta.texts {
      joined.texts[name] = TextWrite(text: write.text, base: base.texts[name]?.base ?? write.base)
    }
    replica.update(entry: target.localId) { target in
      target.intent.deltas = [joined]
      if !base.texts.isEmpty || !delta.texts.isEmpty { target.baseTexts.merge(entry.baseTexts) { own, _ in own } }
    }
    try replica.move(localId, .coalesce)
    guard joined.lattice.born != nil, joined.removes, base.lattice.life?.isAlive == true else { return true }
    var without = replica.rows(target.scope).row(base.key)?.lattice ?? Lattice()
    for other in replica.entries(in: target.scope) where other.commitOrder != target.commitOrder {
      for delta in other.drawnDeltas where delta.key == base.key {
        without = try Join.record(registry.type(base.key.type), without, delta.lattice)
      }
    }
    if without.life?.isAlive != true { try cancel([(target, [base])], by: .coalesce, in: &replica) }
    return true
  }

  // A cancel's silent fold, which an undo and a retire share (§7.3): each source, with the deltas it gives up, ends by
  // `event`, and every later held or ready entry loses its dependent part without a notice; one left empty ends
  // coalesced by cancel. The parts are found before anything moves. A source was never numbered, and §7.4 numbers no
  // entry that depends on one ahead of it.
  func cancel(_ sources: [(entry: OutboxEntry, deltas: [Delta])], by event: IntentEvent, in replica: inout LoadedReplica) throws {
    var dependents = Dependents(registry: registry)
    var parts: [(entry: OutboxEntry, part: Dependents.Part)] = []
    for entry in replica.outbox {
      if let source = sources.first(where: { $0.entry.commitOrder == entry.commitOrder }) {
        dependents.absorb(scope: entry.scope, deltas: source.deltas, stamp: entry.stamp)
        continue
      }
      let part = dependents.part(of: entry)
      guard part.any else { continue }
      precondition(entry.isQueued, "\(entry.localId) is \(entry.state) and depends on an entry never numbered")
      dependents.absorb(part, of: entry)
      parts.append((entry, part))
    }
    for source in sources { try replica.move(source.entry.localId, event) }
    for (entry, part) in parts {
      replica.update(entry: entry.localId) { _ = Dependents.remove(part, from: &$0) }
      if replica.entry(entry.localId)!.isEmpty { try replica.move(entry.localId, .cancel) }
    }
  }
}

// MARK: - Dependents (§7.7 step 3)

// Later deltas and commands that touch or name a record a source created, that carry unchanged a life register a
// source wrote, or that target a scope its governing record creates. Records are keyed by scope, and dependency is
// transitive through `absorb`.
public struct Dependents: Sendable {
  // One later entry's dependent part: its dependent deltas, and whether its command is dependent.
  public struct Part: Sendable {
    public let removed: [Delta]
    public let commandGone: Bool

    public var any: Bool { !removed.isEmpty || commandGone }
  }

  struct ScopedLife: Hashable {
    let record: ScopedKey
    let life: Life
  }

  let registry: Registry
  var created: Set<ScopedKey> = []
  var governed: Set<ScopeRef> = []
  var lives: Set<ScopedLife> = []

  public init(registry: Registry) {
    self.registry = registry
  }

  // A source's deltas, written at `stamp`: the records they create (a life made alive at its born), the scopes their
  // governing records create, and the life registers they wrote (stamped at or after `stamp`), which a later keyed put
  // may carry unchanged (§7.1 step 4).
  public mutating func absorb(scope: ScopeRef, deltas: [Delta], stamp: Stamp) {
    for delta in deltas {
      if let life = delta.lattice.life, life.stamp >= stamp {
        lives.insert(ScopedLife(record: ScopedKey(scope: scope, key: delta.key), life: life))
      }
      guard delta.creates else { continue }
      created.insert(ScopedKey(scope: scope, key: delta.key))
      if registry.type(delta.key.type)?.governsTree == true {
        governed.insert(.tree(delta.key.id.description))
        governed.insert(.overlay(delta.key.id.description))
      }
    }
  }

  // A dependent part joins the sources: what its deltas and a dependent command's prediction create and write.
  public mutating func absorb(_ part: Part, of entry: OutboxEntry) {
    absorb(scope: entry.scope, deltas: part.removed + (part.commandGone ? entry.predict : []), stamp: entry.stamp)
  }

  // A reference names a record in the scope its type lives in: a product scope, or the tree and overlay scopes of
  // the referencing scope's tree.
  func names(_ key: RecordKey, from scope: ScopeRef) -> Bool {
    guard let target = registry.scope(ofType: key.type, from: scope) else { return false }
    return created.contains(ScopedKey(scope: target, key: key))
  }

  public func part(of entry: OutboxEntry) -> Part {
    let wholeScope = governed.contains(entry.scope)
    let removed = entry.intent.deltas.filter { delta in
      let record = ScopedKey(scope: entry.scope, key: delta.key)
      return wholeScope || created.contains(record)
        || delta.lattice.life.map { lives.contains(ScopedLife(record: record, life: $0)) } == true
        || references(of: delta).contains { names($0, from: entry.scope) }
    }
    let commandGone = entry.intent.command.map { command in
      wholeScope || Dependents.references(of: command, registry: registry).contains { names($0.key, from: entry.scope) }
    } ?? false
    return Part(removed: removed, commandGone: commandGone)
  }

  func references(of delta: Delta) -> [RecordKey] {
    registry.type(delta.key.type)?.references(of: delta.key.id, values: delta.lattice.fields.mapValues(\.value)) ?? []
  }

  // A command's `ref<t>` arguments that hold an id, with the argument's name.
  public static func references(of command: Command, registry: Registry) -> [(key: RecordKey, argument: String)] {
    guard let def = registry.command(command.name) else { return [] }
    return def.args.compactMap { arg in
      guard let type = arg.type.ref, case .string(let id)? = command.args[arg.name] else { return nil }
      return (RecordKey(type, RecordID(id)), arg.name)
    }
  }

  // Removes a queued entry's dependent part: its deltas, the guards on their records, and a dependent command with its
  // prediction. Answers the removed content; the entry may be left empty.
  public static func remove(_ part: Part, from entry: inout OutboxEntry) -> NoticeContent {
    let content = NoticeContent(deltas: part.removed, command: part.commandGone ? entry.intent.command : nil)
    let removedKeys = Set(part.removed.map(\.key))
    entry.intent.deltas.removeAll { part.removed.contains($0) }
    entry.intent.guards.removeAll { removedKeys.contains($0.key) }
    if part.commandGone {
      entry.intent.command = nil
      entry.predict = []
    }
    return content
  }
}

extension OutboxEntry {
  public var isEmpty: Bool { intent.deltas.isEmpty && intent.command == nil }
}

// MARK: - Hold, release, undo (§7.3)

public struct Hold: Sendable {
  public let coalescing: Coalescing

  public init(registry: Registry) {
    coalescing = Coalescing(registry: registry)
  }

  // The rows a release reads, for its Action to load first: the record of each held plain entry, whose coalescing
  // decides a cancel by the record's confirmed row.
  public func reads(releasing outbox: [OutboxEntry]) -> [ScopeRef: RowSelection] {
    var reads: [ScopeRef: RowSelection] = [:]
    for entry in outbox where entry.state == .held && entry.isPlain {
      reads[entry.scope, default: RowSelection()].keys.insert(entry.intent.deltas[0].key)
    }
    return reads
  }

  // A held entry becomes ready and coalesces; true if it was held.
  @discardableResult
  public func release(_ localId: String, in replica: inout LoadedReplica) throws -> Bool {
    guard replica.entry(localId)?.state == .held else { return false }
    try replica.move(localId, .release)
    try coalescing.coalesce(localId, in: &replica)
    return true
  }

  // Leaving the app, engine start, sign-in and sign-out release every held entry.
  public func releaseAll(in replica: inout LoadedReplica) throws {
    for entry in replica.outbox where entry.state == .held { try release(entry.localId, in: &replica) }
  }

  // The in-process timer: every held entry whose `releaseAt` has come.
  public func releaseDue(at deviceNow: Int64, in replica: inout LoadedReplica) throws {
    for entry in replica.outbox where entry.state == .held && entry.releaseAt <= deviceNow {
      try release(entry.localId, in: &replica)
    }
  }

  // True iff every entry of the gesture was held, and so removed, its dependents folded as a cancel folds them.
  public func undo(_ gestureId: String, in replica: inout LoadedReplica) throws -> Bool {
    let gesture = replica.outbox.filter { $0.gestureId.utf8.elementsEqual(gestureId.utf8) }
    guard !gesture.isEmpty, gesture.allSatisfy({ $0.state == .held }) else { return false }
    try coalescing.cancel(gesture.map { ($0, $0.drawnDeltas) }, by: .undo, in: &replica)
    return true
  }
}
