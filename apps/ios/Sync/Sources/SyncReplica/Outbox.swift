import SyncAPI
import SyncCore

// The outbox's own moves: hold, release and undo, with the silent fold an undo, a retire and a supersede share (§7.3),
// and the dependents that folds, refusals and held-back numbering read (§7.7 step 3, §7.4).

// MARK: - Dependents (§7.7 step 3)

// Later deltas and commands that touch or name a record a source created, that carry unchanged a life register a
// source wrote, or that target a scope its governing record creates; an opted command also by what it predicts in any
// scope. Records are keyed by scope, a reference naming the record its compiled leaf resolves to (E-8), and a command's
// proposed creation names none. Dependency is transitive through `absorb`.
public struct Dependents: Sendable {
  // One later entry's dependent part: its dependent deltas, whether its command is dependent, and, when the sources are
  // being replaced, its guards on what they created.
  public struct Part: Sendable {
    public let removed: [Delta]
    public let commandGone: Bool
    public let guards: [Guard]

    public var any: Bool { !removed.isEmpty || commandGone || !guards.isEmpty }
  }

  struct ScopedLife: Hashable {
    let record: ScopedKey
    let life: Life
  }

  let registry: Registry
  // A replacement takes the sources' place and is numbered after their dependents, so a guard on what they created can no longer hold.
  let replaced: Bool
  var created: Set<ScopedKey> = []
  var governed: Set<ScopeRef> = []
  var lives: Set<ScopedLife> = []

  public init(registry: Registry, replaced: Bool = false) {
    self.registry = registry
    self.replaced = replaced
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

  // A source entry: everything it holds, in every scope it has effects in.
  public mutating func absorb(_ entry: OutboxEntry) {
    for effect in entry.effects() { absorb(scope: effect.scope, deltas: effect.deltas, stamp: entry.stamp) }
  }

  // A dependent part joins the sources: what its deltas and a dependent command's predictions create and write.
  public mutating func absorb(_ part: Part, of entry: OutboxEntry) {
    absorb(scope: entry.scope, deltas: part.removed, stamp: entry.stamp)
    guard part.commandGone else { return }
    for projection in entry.projected { absorb(scope: projection.scope, deltas: projection.deltas, stamp: entry.stamp) }
  }

  func names(_ references: [ResolvedReference]) -> Bool {
    references.contains { created.contains($0.record) }
  }

  // Whether what the sources and their dependent parts wrote stays within the records whose entries `replica` loaded: no
  // record created, which any later entry may name, no scope governed, and every life written on a record whose touching
  // entries the load read.
  func staysWithin(_ replica: LoadedReplica) -> Bool {
    created.isEmpty && governed.isEmpty && lives.allSatisfy { replica.holdsEntries(touching: $0.record.key, in: $0.record.scope) }
  }

  public func part(of entry: OutboxEntry) -> Part {
    let wholeScope = governed.contains(entry.scope)
    let removed = entry.intent.deltas.filter { wholeScope || depends($0, in: entry.scope) }
    let commandGone = entry.intent.command.map { command in
      wholeScope || names(registry.references(of: command, in: entry.scope))
        || entry.predictions != nil && entry.projected.contains { projection in
          governed.contains(projection.scope) || projection.deltas.contains { depends($0, in: projection.scope) }
        }
        || entry.predict.contains { carriesLife($0, in: entry.scope) }
    } ?? false
    let guards = replaced ? entry.intent.guards.filter { created.contains(ScopedKey(scope: entry.scope, key: $0.key)) } : []
    return Part(removed: removed, commandGone: commandGone, guards: guards)
  }

  // A delta in `scope` that touches a record a source created, carries unchanged a life a source wrote, or names a
  // record a source created.
  func depends(_ delta: Delta, in scope: ScopeRef) -> Bool {
    created.contains(ScopedKey(scope: scope, key: delta.key)) || carriesLife(delta, in: scope)
      || names(registry.references(of: delta, in: scope))
  }

  func carriesLife(_ delta: Delta, in scope: ScopeRef) -> Bool {
    delta.lattice.life.map { lives.contains(ScopedLife(record: ScopedKey(scope: scope, key: delta.key), life: $0)) } == true
  }

  // Removes a queued entry's dependent part: its deltas, the guards on their records and those the part names, and a
  // dependent command with its predictions and accepted versions. Answers the removed content; the entry may be left
  // empty.
  public static func remove(_ part: Part, from entry: inout OutboxEntry) -> NoticeContent {
    let content = part.commandGone ? NoticeContent(deltas: part.removed, command: entry.intent.command, predictions: entry.content.predictions)
      : NoticeContent(deltas: part.removed)
    let removedKeys = Set(part.removed.map(\.key))
    entry.intent.deltas.removeAll { part.removed.contains($0) }
    entry.intent.guards.removeAll { removedKeys.contains($0.key) || part.guards.contains($0) }
    if part.commandGone {
      entry.intent.command = nil
      entry.predict = []
      entry.predictions = nil
      entry.acceptedEffects = nil
    }
    return content
  }
}

extension OutboxEntry {
  public var isEmpty: Bool { intent.deltas.isEmpty && intent.command == nil }
}

// MARK: - Hold, release, undo (§7.3)

public struct Hold: Sendable {
  public let registry: Registry

  public init(registry: Registry) {
    self.registry = registry
  }

  // A held entry becomes ready; true if it was held.
  @discardableResult
  public func release(_ localId: String, in replica: inout LoadedReplica) throws -> Bool {
    guard replica.entry(localId)?.state == .held else { return false }
    try replica.move(localId, .release)
    return true
  }

  // Leaving the app, engine start, sign-in and sign-out release every held entry. True iff there was one.
  @discardableResult
  public func releaseAll(in replica: inout LoadedReplica) throws -> Bool {
    let held = replica.outbox.filter { $0.state == .held }
    for entry in held { try release(entry.localId, in: &replica) }
    return !held.isEmpty
  }

  // The in-process timer: every held entry whose `releaseAt` has come.
  public func releaseDue(at deviceNow: Int64, in replica: inout LoadedReplica) throws {
    for entry in replica.outbox where entry.state == .held && entry.releaseAt <= deviceNow {
      try release(entry.localId, in: &replica)
    }
  }

  // True iff every entry of the gesture was held, and so removed, its dependents folded silently.
  public func undo(_ gestureId: String, in replica: inout LoadedReplica) throws -> Bool {
    let gesture = replica.outbox.filter { $0.gestureId.utf8.elementsEqual(gestureId.utf8) }
    guard !gesture.isEmpty, gesture.allSatisfy({ $0.state == .held }) else { return false }
    try SilentFold(gesture.map { (entry: $0, event: .undo) }, over: replica, registry: registry).apply(to: &replica)
    return true
  }
}

// The silent fold of an undo, a retire and a supersede (§7.1 step 4), planned in one pass before anything moves: each
// entry of `ending` ends by its event, and every later held or ready entry loses its dependent part without a notice; one
// left empty ends undone. Over a load of part of the outbox the plan holds every dependent only while what it absorbs
// stays within the records whose entries the load read; otherwise it reaches entries the load left unread, and the
// commit plans again over every entry.
struct SilentFold {
  let ending: [(entry: OutboxEntry, event: IntentEvent)]
  let parts: [(entry: OutboxEntry, part: Dependents.Part)]
  let reachesUnreadEntries: Bool

  init(_ ending: [(entry: OutboxEntry, event: IntentEvent)], replaced: Bool = false, over replica: LoadedReplica, registry: Registry) {
    var dependents = Dependents(registry: registry, replaced: replaced)
    var parts: [(entry: OutboxEntry, part: Dependents.Part)] = []
    for entry in replica.entriesTouchingReads {
      if ending.contains(where: { $0.entry.commitOrder == entry.commitOrder }) {
        dependents.absorb(entry)
        continue
      }
      let part = dependents.part(of: entry)
      guard part.any else { continue }
      precondition(entry.isQueued, "\(entry.localId) is \(entry.state) and depends on a held entry")
      dependents.absorb(part, of: entry)
      parts.append((entry, part))
    }
    self.ending = ending
    self.parts = parts
    reachesUnreadEntries = !replica.holdsEveryEntry && !dependents.staysWithin(replica)
  }

  func apply(to replica: inout LoadedReplica) throws {
    precondition(!reachesUnreadEntries, "a silent fold of \(replica.id) reaches entries its load did not read")
    for (entry, event) in ending { try replica.move(entry.localId, event) }
    for (entry, part) in parts {
      replica.update(entry: entry.localId) { _ = Dependents.remove(part, from: &$0) }
      if replica.entry(entry.localId)!.isEmpty { try replica.move(entry.localId, .silentFold) }
    }
    replica.settleEnded(code: "undone")
  }
}
