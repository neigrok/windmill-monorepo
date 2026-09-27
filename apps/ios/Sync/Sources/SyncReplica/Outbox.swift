import SyncAPI
import SyncCore

// The outbox's own moves: coalescing and cancel (§7.2), hold, release and undo (§7.3), and the dependents a cancel or
// a refusal folds (§7.7 step 3).

// MARK: - Coalescing (§7.2)

public struct Coalescing: Sendable {
  public let registry: Registry

  public init(registry: Registry) {
    self.registry = registry
  }

  // A ready plain entry joins the last earlier entry touching its record, when that one is ready and plain, no command
  // entry of the scope lies between them, and text comes from one engine instance. A never-numbered create or revive
  // that the join leaves dead cancels, with its dependents.
  @discardableResult
  public func coalesce(_ localId: String, in replica: inout LoadedReplica) throws -> Bool {
    guard let entry = replica.entry(localId), entry.state == .ready, entry.isPlain, entry.orphanOf == nil else { return false }
    let delta = entry.intent.deltas[0]
    let earlier = replica.entries(in: entry.scope).filter { $0.commitOrder < entry.commitOrder }
    guard let target = earlier.last(where: { $0.touches(delta.key) }), target.state == .ready, target.isPlain,
          target.orphanOf == nil else { return false }
    guard !earlier.contains(where: { $0.commitOrder > target.commitOrder && $0.intent.command != nil }) else { return false }
    guard delta.texts.isEmpty || target.stamp.actor.utf8.elementsEqual(entry.stamp.actor.utf8) else { return false }

    let base = target.intent.deltas[0]
    let cancels = base.lattice.life?.isAlive == true && !target.numbered
    var joined = Delta(key: base.key, lattice: try Join.record(registry.type(delta.key.type), base.lattice, delta.lattice), texts: base.texts)
    for (name, write) in delta.texts {
      joined.texts[name] = TextWrite(text: write.text, base: base.texts[name]?.base ?? write.base)
    }
    replica.update(entry: target.localId) { target in
      target.intent.deltas = [joined]
      if !base.texts.isEmpty || !delta.texts.isEmpty { target.baseTexts.merge(entry.baseTexts) { own, _ in own } }
    }
    try replica.move(localId, .coalesce)
    if joined.lattice.born != nil, joined.removes, cancels {
      try replica.move(target.localId, .coalesce)
      try cancelDependents(of: target, created: base, in: &replica)
    }
    return true
  }

  // The cancelled record's dependents fold silently: their dependent part is removed with no notice, and an entry
  // left empty ends coalesced. Sent entries stay as they are.
  func cancelDependents(of cancelled: OutboxEntry, created: Delta, in replica: inout LoadedReplica) throws {
    var dependents = Dependents(registry: registry, scope: cancelled.scope, deltas: [created])
    for later in replica.outbox where later.commitOrder > cancelled.commitOrder {
      guard let entry = replica.entry(later.localId), entry.isQueued else { continue }
      let part = dependents.part(of: entry)
      guard part.any else { continue }
      dependents.absorb(scope: entry.scope, deltas: part.removed + (part.commandGone ? entry.predict : []))
      replica.update(entry: entry.localId) { _ = Dependents.remove(part, from: &$0) }
      if replica.entry(entry.localId)!.isEmpty { try replica.move(entry.localId, .cancel) }
    }
  }
}

// MARK: - Dependents (§7.7 step 3)

// Later deltas and commands that touch or name a record a source created, or that target a scope its governing record
// creates; records are keyed by scope, and dependency is transitive through `absorb`.
public struct Dependents: Sendable {
  // One later entry's dependent part: its dependent deltas, whether its command is dependent, and whether all of it is.
  public struct Part: Sendable {
    public let removed: [Delta]
    public let commandGone: Bool
    public let any: Bool
    public let whole: Bool
  }

  struct ScopedKey: Hashable {
    let scope: ScopeRef
    let key: RecordKey
  }

  let registry: Registry
  var created: Set<ScopedKey> = []
  var governed: Set<ScopeRef> = []

  public init(registry: Registry, scope: ScopeRef, deltas: [Delta]) {
    self.registry = registry
    absorb(scope: scope, deltas: deltas)
  }

  // The records these deltas create join the source's, with the scopes their governing records create.
  public mutating func absorb(scope: ScopeRef, deltas: [Delta]) {
    for delta in deltas where delta.creates {
      created.insert(ScopedKey(scope: scope, key: delta.key))
      if registry.type(delta.key.type)?.governsTree == true {
        governed.insert(.tree(delta.key.id.description))
        governed.insert(.overlay(delta.key.id.description))
      }
    }
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
      wholeScope || created.contains(ScopedKey(scope: entry.scope, key: delta.key))
        || references(of: delta).contains { names($0, from: entry.scope) }
    }
    let commandGone = entry.intent.command.map { command in
      wholeScope || Dependents.references(of: command, registry: registry).contains { names($0.key, from: entry.scope) }
    } ?? false
    return Part(
      removed: removed, commandGone: commandGone, any: !removed.isEmpty || commandGone,
      whole: removed.count == entry.intent.deltas.count && (entry.intent.command == nil || commandGone))
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

  // True iff every entry of the gesture was held, and so removed.
  public func undo(_ gestureId: String, in replica: inout LoadedReplica) throws -> Bool {
    let gesture = replica.outbox.filter { $0.gestureId == gestureId }
    guard !gesture.isEmpty, gesture.allSatisfy({ $0.state == .held }) else { return false }
    for entry in gesture { try replica.move(entry.localId, .undo) }
    return true
  }
}
