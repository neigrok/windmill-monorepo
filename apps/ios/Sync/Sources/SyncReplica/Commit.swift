import SyncAPI
import SyncCore

// §7.1 commit: one gesture, one local transaction. A throw writes nothing; a cap refusal writes nothing and retires
// nothing; a too-large refusal writes only its notice. The clock is written back once the commit is accepted.

public struct CommitPlanner: Sendable {
  public let registry: Registry
  public let limits: Limits

  public init(registry: Registry, limits: Limits = Limits()) {
    self.registry = registry
    self.limits = limits
  }

  // §7.1 for a decided gesture. The read-and-commit form runs step 1, `checkWritable`, then its body through the
  // caller's reader, and commits here only when the body decides a gesture: a nil one writes nothing and ticks no clock.
  // `gestureIdTaken`: an outbox entry or a notice of any replica on the device carries the gesture's given id (§2.5).
  // `draws`: the ids an earlier plan of this commit drew before it stopped at `UnreadRows`, taken again first.
  // `capture`: an opted act segment's capture command, which joins the gesture when it writes a delta (§7.3).
  public func commit(_ gesture: Gesture, in scope: ScopeRef, to replica: inout LoadedReplica, as instance: Instance,
                     identities: IdentitySource, gestureIdTaken: Bool, draws: [Draw] = [],
                     actOffset: Int? = nil, actFirstOrder: Int64? = nil, capture: String? = nil) throws -> CommitOutcome {
    try checkWritable(replica.meta)
    return try commitGesture(gesture, in: scope, to: &replica, as: instance, identities: identities, gestureIdTaken: gestureIdTaken,
                             draws: draws, actOffset: actOffset, actFirstOrder: actFirstOrder, capture: capture)
  }

  // The rows a commit of `gesture` reads, for its Action to load first with the entries that touch them: the records its
  // changes, predictions, guards and retire name, an opted command's predictions in their own scopes; whole types where
  // an intent's change derives an id from a label, places by an anchor, or creates a record of a capped type, which the
  // cap counts; and for each tree or overlay scope, the governing record the scope check reads. A prediction names its
  // record and the cap counts none (§7.1 step 8), so it reads its record alone. What a plan finds it needs beyond them is
  // read once found (`UnreadRows`): the ids minted creates draw, by their keys; a capped type any other change shows one
  // more record of, whole; and every entry, where a retire's or a supersede's silent fold reaches past the entries the
  // load read. So a change of one record of a capped type reads that record alone unless it may grow the type.
  public func reads(of gesture: Gesture, in scope: ScopeRef) -> [ScopeRef: RowSelection] {
    var origin = RowSelection(keys: keys(namedBy: gesture.changes + gesture.predict), types: types(readBy: gesture.changes))
    origin.keys.formUnion(gesture.guards.map(\.key))
    origin.keys.formUnion(gesture.retire.map(\.key))
    var reads = [scope: origin]
    for prediction in gesture.scopedPredict {
      reads[prediction.scope, default: RowSelection()].keys.formUnion(keys(namedBy: prediction.changes))
    }
    for read in reads.keys {
      guard let governing = registry.governingRecord(of: read) else { continue }
      reads[governing.scope, default: RowSelection()].keys.insert(governing.key)
    }
    return reads
  }

  // The records changes name by key: a given or seeded id, or the record a change other than a create names.
  func keys(namedBy changes: [Change]) -> Set<RecordKey> {
    var keys: Set<RecordKey> = []
    for change in changes {
      guard let type = registry.type(change.type) else { continue }
      switch change.operation {
      case .create(.minted), .create(.derived): break
      case .create(.seeded(let seed, let ordinal)):
        if let id = try? SeededID(seed: seed, ordinal: ordinal, for: type).id { keys.insert(RecordKey(type.name, RecordID(id))) }
      default: if let id = change.id { keys.insert(RecordKey(type.name, id)) }
      }
    }
    return keys
  }

  // The types an intent's changes read whole: a derived id reads every id of its type, an anchor its type's order, and a
  // create of a capped type the count.
  func types(readBy changes: [Change]) -> Set<String> {
    var types: Set<String> = []
    for change in changes {
      guard let type = registry.type(change.type) else { continue }
      let creates: Bool = if case .create = change.operation { true } else { false }
      let derives: Bool = if case .create(.derived) = change.operation { true } else { false }
      if derives || change.anchor != nil || (type.cap != nil && creates) { types.insert(type.name) }
    }
    return types
  }

  // Retire loads held gestures; supersede loads the whole outbox to prove complete eligibility and fold dependents.
  public func entryReads(of gesture: Gesture) -> EntrySelection {
    gesture.supersede.isEmpty ? EntrySelection(heldGestures: !gesture.retire.isEmpty) : .every
  }

  // Step 1: the replica is anon or bound.
  public func checkWritable(_ meta: ReplicaMeta) throws {
    guard meta.state == .anon || meta.state == .bound else { throw CommitFailure(.notWritable, "a \(meta.state.rawValue) replica does not commit") }
  }

  // Steps 2–11, after the checks before step 2. The retire, the supersede and their one silent fold run on a working copy,
  // which the diff reads and which the replica becomes once the commit is accepted.
  func commitGesture(_ gesture: Gesture, in scope: ScopeRef, to replica: inout LoadedReplica, as instance: Instance,
                     identities: IdentitySource, gestureIdTaken: Bool, draws: [Draw], actOffset: Int?, actFirstOrder: Int64?,
                     capture: String?) throws -> CommitOutcome {
    guard registry.scopeKind(of: scope) != nil else { throw CommitFailure.malformed("\(scope) is no scope of the registry") }
    let product = try product(of: scope)
    if let taken = gesture.gestureId, gestureIdTaken { throw CommitFailure.malformed("the gesture id \(taken) is taken") }
    for row in gesture.local where registry.product(product)?.device.contains(where: { $0.keyPattern.matches(row.key) }) != true {
      throw CommitFailure.malformed("\(row.key) is not a device row of \(product)")
    }
    if try scopeIsDead(scope, in: replica) { return .refused(.scopeDead, detail: nil) }

    let physNow = replica.meta.physNow(deviceNow: instance.deviceNow)
    var clock = replica.meta.hlc
    clock.observe(replica.meta.hlcHigh)
    let stamp = clock.tick(physNow: physNow, actor: instance.actor)

    // Step 4: the retired gestures end by retire and the superseded by silent fold, a gesture in both by retire, and the
    // dependents of all of them fold in one pass, as a replacement when any gesture is superseded.
    let retiring = retiringEntries(of: gesture.retire, in: scope, replica: replica).filter {
      actOffset == nil || $0.gestureId != gesture.gestureId
    }
    if actOffset != nil, let id = gesture.gestureId, gesture.supersede.contains(id) {
      throw CommitFailure.malformed("an act cannot supersede itself")
    }
    let superseding = try supersedingEntries(gesture.supersede, in: scope, replica: replica)
    let supersedingOnly = superseding.filter { entry in !retiring.contains { $0.commitOrder == entry.commitOrder } }
    let ending = retiring.map { (entry: $0, event: IntentEvent.retire) } + supersedingOnly.map { (entry: $0, event: IntentEvent.silentFold) }
    let fold = SilentFold(ending, replaced: !superseding.isEmpty, over: replica, registry: registry)
    guard !fold.reachesUnreadEntries else { throw UnreadRows(everyEntry: true, draws: draws) }
    var retired = replica
    try fold.apply(to: &retired)
    var builder = DeltaBuilder(
      registry: registry, replica: retired, scope: scope, stamp: stamp, physNow: physNow,
      drawn: try ScopeView(retired, scope, .drawn, registry: registry),
      stored: try ScopeView(retired, scope, .stored, registry: registry), identities: identities, draws: draws)
    let deltas: [Delta]
    let predict: [Delta]
    do {
      deltas = try oneDeltaPerRecord(try gesture.changes.compactMap { change in try builder.delta(change).map { (change, $0) } })
      predict = try gesture.predict.map { try builder.predicted($0) }
    } catch where !builder.unread.isEmpty {
      throw UnreadRows(keys: builder.unread, draws: builder.draws)
    }
    guard builder.unread.isEmpty else { throw UnreadRows(keys: builder.unread, draws: builder.draws) }
    let guards = try exactGuards(gesture.guards, in: scope, stored: builder.stored)
    let captured: Command? = capture.flatMap { (name: String) -> Command? in deltas.isEmpty ? nil : Command(name: name, args: [:]) }
    let command = (gesture.command ?? captured).map(registry.rounded)
    // E-7: an opted command predicts one projection a scope, the origin's always and first, the rest by byte order, each
    // built against its own scope; `predict` is its origin's projection. A scope known gone refuses, and grouped bytes
    // past EFFECT_MAX_BYTES refuse too-large, leaving nothing.
    let definition = command.flatMap { registry.command($0.name) }
    guard definition?.scopedEffects == true || gesture.scopedPredict.isEmpty else {
      throw CommitFailure.malformed("scoped predictions belong to a command with scoped effects")
    }
    var predictions: [Projection]?
    if let definition, definition.scopedEffects {
      guard gesture.predict.isEmpty || gesture.scopedPredict.isEmpty else { throw CommitFailure.malformed("predict and scopedPredict are exclusive") }
      var groups: [ScopeRef: [Change]] = [scope: gesture.predict]
      for prediction in gesture.scopedPredict {
        guard registry.scopeKind(of: prediction.scope) != nil, registry.isScopeID(prediction.scope) else {
          throw CommitFailure.malformed("\(prediction.scope) is no scope a command predicts in")
        }
        if try scopeIsDead(prediction.scope, in: replica) { return .refused(.scopeDead, detail: nil) }
        groups[prediction.scope, default: []] += prediction.changes
      }
      let projections = try EffectReceipt.ordered(origin: scope, groups.keys).map { target in
        let changes = groups[target]!
        guard changes.allSatisfy({ change in definition.predicts.contains { $0.utf8.elementsEqual(change.type.utf8) } }) else {
          throw CommitFailure.malformed("\(definition.name) predicts no type of \(target) it was given")
        }
        guard target != scope else { return Projection(scope: target, deltas: try oneDeltaPerRecord(changes.map { ($0, try builder.predicted($0)) })) }
        var projected = DeltaBuilder(
          registry: registry, replica: retired, scope: target, stamp: stamp, physNow: physNow,
          drawn: try ScopeView(retired, target, .drawn, registry: registry),
          stored: try ScopeView(retired, target, .stored, registry: registry), identities: identities, draws: [])
        return Projection(scope: target, deltas: try oneDeltaPerRecord(changes.map { ($0, try projected.predicted($0)) }))
      }
      let grouped = JSON.array(projections.map(\.json))
      guard !grouped.holdsNul else { throw CommitFailure.malformed("a string of the predictions holds U+0000") }
      guard grouped.jcs.count <= limits.effectMaxBytes else { return .refused(.tooLarge, detail: nil) }
      predictions = projections
    }
    // E-8: a typed leaf of a value the gesture writes or predicts, or of its command's arguments, that breaks admission's
    // leaf rule throws, since dependents and id maps read every leaf of a queued entry.
    let predicted: [Delta] = (predictions ?? []).flatMap(\.deltas)
    let written: [Delta] = deltas + predict + predicted
    for delta in written {
      guard let type = registry.type(delta.key.type) else { continue }
      for (name, register) in delta.lattice.fields {
        guard let field = type.field(name), registry.typedLeafFault(of: register.value, for: field, of: type) != nil else { continue }
        throw CommitFailure.malformed("\(type.name).\(name) holds a malformed typed reference")
      }
    }
    if let command, let definition, registry.typedLeafFault(of: command.args, for: definition) != nil {
      throw CommitFailure.malformed("\(definition.name)'s arguments hold a malformed typed reference")
    }
    // Step 7: a string the intents send (their scope, deltas, guards, command and given gesture id) holding U+0000
    // throws, before step 8's caps; predictions and device rows are never sent.
    let sent = Intent(scope: scope, deltas: deltas, guards: guards, command: command, gestureId: gesture.gestureId)
    guard !sent.json.holdsNul else { throw CommitFailure.malformed("a string of the intents holds U+0000") }
    switch try capCount(deltas, stored: builder.stored) {
    case .uncounted(let types): throw UnreadRows(types: types, draws: builder.draws)
    case .over(let type, let cap): return .refused(.cap, detail: ["type": .string(type), "cap": JSON(cap)])
    case .within: break
    }
    let gestureId = try gesture.gestureId ?? identities.gestureID()
    let intents = group(deltas, guards: guards, command: command, gesture: gesture, scope: scope, gestureId: gestureId)

    // Step 8: an intent the widest request cannot carry alone refuses the gesture, so an entry as committed always fits
    // a request alone, the `anon` replica's through sign-in.
    let (id, account) = (replica.meta.replica, replica.meta.account)
    if intents.contains(where: { PushRequest(widestFor: $0, of: id, account: account).body.count > limits.pushMaxBytes }) {
      let notice = "notice:\(gestureId)/0"
      replica.apply(.putNotice(Notice(
        id: notice, product: product, scope: scope, code: .tooLarge, detail: nil,
        content: NoticeContent(deltas: deltas, command: command), at: instance.deviceNow)))
      return .refused(.tooLarge, detail: nil, notice: notice)
    }

    replica = retired
    let releaseAt = gesture.hold ? instance.deviceNow + limits.holdMs : 0
    let firstOrder = actFirstOrder.map { $0 + Int64(actOffset ?? 0) } ?? replica.nextCommitOrder
    let entries = try intents.enumerated().map { k, intent in
      guard case .state(let state) = try Machines.intent.transition(from: nil, .commit, to: .state(gesture.hold ? .held : .ready)) else {
        preconditionFailure("a commit enqueues")
      }
      let texts = Set(intent.deltas.flatMap { delta in delta.texts.keys.map { TextRef(delta.key, $0) } })
      return OutboxEntry(
        localId: "\(gestureId)/\((actOffset ?? 0) + k)", gestureId: gestureId, lineage: replica.meta.lineage, scope: scope, state: state,
        commitOrder: firstOrder + Int64(k), releaseAt: releaseAt, stamp: stamp, intent: intent,
        predict: command == nil || predictions != nil ? [] : predict, predictions: predictions,
        baseTexts: builder.baseTexts.filter { texts.contains($0.key) })
    }
    for entry in entries { replica.apply(.putEntry(entry)) }

    for row in gesture.local {
      if let value = row.value {
        replica.apply(.putDeviceRow(product: product, key: row.key, value))
      } else {
        replica.apply(.deleteDeviceRow(product: product, key: row.key))
      }
    }
    replica.update { meta in
      meta.hlc = clock
      meta.hlcHigh = stamp
    }
    var retiredGestures: [String] = []
    for entry in retiring where !retiredGestures.contains(where: { $0.utf8.elementsEqual(entry.gestureId.utf8) }) {
      retiredGestures.append(entry.gestureId)
    }
    return .committed(CommitReceipt(
      gestureId: gestureId, stamp: stamp, localIds: entries.map(\.localId), ids: builder.ids,
      releaseAt: gesture.hold ? releaseAt : nil, retired: retiredGestures,
      superseded: superseding.reduce(into: []) { ids, entry in
        if !ids.contains(where: { $0.utf8.elementsEqual(entry.gestureId.utf8) }) { ids.append(entry.gestureId) }
      }))
  }

  func supersedingEntries(_ ids: [String], in scope: ScopeRef, replica: LoadedReplica) throws -> [OutboxEntry] {
    guard !ids.isEmpty else { return [] }
    guard replica.meta.state == .anon, Set(ids.map { Array($0.utf8) }).count == ids.count else {
      throw CommitFailure.malformed("supersede requires distinct anonymous gestures")
    }
    for id in ids {
      let entries = replica.outbox.filter { $0.gestureId.utf8.elementsEqual(id.utf8) }
      guard !entries.isEmpty, entries.allSatisfy({ $0.scope == scope && $0.isQueued && $0.n == nil }) else {
        throw CommitFailure.malformed("supersede requires a complete never-numbered gesture in this scope")
      }
    }
    return replica.outbox.filter { entry in ids.contains { $0.utf8.elementsEqual(entry.gestureId.utf8) } }
  }

  func product(of scope: ScopeRef) throws -> String {
    guard let product = registry.product(of: scope) else { throw CommitFailure.malformed("\(scope) belongs to no product") }
    return product
  }

  // Step 2: a tree or overlay scope whose governing record is dead in `stored`, or that is known gone or not found.
  func scopeIsDead(_ scope: ScopeRef, in replica: LoadedReplica) throws -> Bool {
    guard let tree = scope.tree else { return false }
    if replica.known[scope] != nil || replica.known[.tree(tree)] != nil { return true }
    guard let governing = registry.governingRecord(of: scope) else { return false }
    return try ScopeView(replica, governing.scope, .stored, registry: registry).record(governing.key)?.lattice.life?.state == .dead
  }

  // Step 4's retire: the held gestures of the scope with no command, whose every delta removes a named record.
  // A capture command is the ordinary deltas' own, so it does not stop a retire.
  func retiringEntries(of retire: [RecordRef], in scope: ScopeRef, replica: LoadedReplica) -> [OutboxEntry] {
    guard !retire.isEmpty else { return [] }
    let named = Set(retire.map(\.key))
    let commandFree = { (entry: OutboxEntry) -> Bool in
      entry.intent.command.map { (command: Command) -> Bool in self.registry.command(command.name)?.engine == .capture } ?? true
    }
    let removesNamed = { (entry: OutboxEntry) -> Bool in
      commandFree(entry) && !entry.intent.deltas.isEmpty
        && entry.intent.deltas.allSatisfy { $0.removes && named.contains($0.key) }
    }
    var gestures: [(id: String, entries: [OutboxEntry])] = []
    for entry in replica.heldGestures {
      if let index = gestures.firstIndex(where: { $0.id.utf8.elementsEqual(entry.gestureId.utf8) }) {
        gestures[index].entries.append(entry)
      } else {
        gestures.append((entry.gestureId, [entry]))
      }
    }
    return gestures.filter { gesture in
      gesture.entries.allSatisfy { $0.state == .held && $0.scope == scope && removesNamed($0) }
    }.flatMap(\.entries)
  }

  // Step 6: exactly the listed registers, each at its stamp in `stored`, null when unset. Only a lattice field the
  // type declares can be guarded; `life` and text fields throw.
  func exactGuards(_ listed: [RegisterRef], in scope: ScopeRef, stored: ScopeView) throws -> [Guard] {
    var guards: [Guard] = []
    for register in listed {
      guard registry.lives(register.type, in: scope) else { throw CommitFailure.malformed("a guard on \(register.type) does not live in \(scope)") }
      guard registry.type(register.type)?.field(register.field)?.kind.isLattice == true else {
        throw CommitFailure.malformed("\(register.type).\(register.field) is not a guardable register")
      }
      let stamp = stored.record(register.key)?.lattice.fields[register.field]?.stamp
      let named = Guard(key: register.key, field: register.field, stamp: stamp)
      if !guards.contains(where: { $0.key == named.key && $0.field.utf8.elementsEqual(named.field.utf8) }) { guards.append(named) }
    }
    return guards
  }

  // Steps 4 and 7: a move and an update of one record fold into one delta, the update leaving the move's field alone.
  // Any other changes that give one record two deltas throw: an intent changes a record at most once.
  func oneDeltaPerRecord(_ built: [(change: Change, delta: Delta)]) throws -> [Delta] {
    var deltas: [Delta] = []
    var changes: [[Change]] = []
    for (change, delta) in built {
      guard let index = deltas.firstIndex(where: { $0.key == delta.key }) else {
        deltas.append(delta)
        changes.append([change])
        continue
      }
      let pair = changes[index] + [change]
      let move = pair.first { if case .move = $0.operation { true } else { false } }
      let update = pair.first { if case .update = $0.operation { true } else { false } }
      guard pair.count == 2, let move, let update, let field = move.anchor?.field else {
        throw CommitFailure.malformed("an intent changes a record at most once")
      }
      guard update.values[field] == nil else { throw CommitFailure.malformed("\(delta.key.type).\(field) is written beside a move") }
      changes[index] = pair
      deltas[index].lattice.fields.merge(delta.lattice.fields) { $1 }
      deltas[index].texts.merge(delta.texts) { $1 }
    }
    return deltas
  }

  // Step 7: atomic, held or command gestures are one intent; otherwise one intent per record, each with its guards, and a
  // guard on a record no delta writes rides the first. `oneDeltaPerRecord` has left each record one delta.
  func group(_ deltas: [Delta], guards: [Guard], command: Command?, gesture: Gesture, scope: ScopeRef, gestureId: String) -> [Intent] {
    if gesture.atomic || gesture.hold || command != nil {
      guard !deltas.isEmpty || command != nil else { return [] }
      return [Intent(scope: scope, deltas: deltas, guards: guards, command: command, gestureId: gestureId)]
    }
    var intents = deltas.map { delta in
      Intent(scope: scope, deltas: [delta], guards: guards.filter { $0.key == delta.key }, gestureId: gestureId)
    }
    let unplaced = guards.filter { guardKey in !deltas.contains { $0.key == guardKey.key } }
    if !unplaced.isEmpty && !intents.isEmpty { intents[0].guards += unplaced }
    return intents
  }

  // Step 8 as the deltas, applied to `stored`, meet each cap by the growth rule; a held delete still occupies its slot.
  enum CapCount {
    case within
    // The first capped type, in the order the deltas name them, grown past its cap.
    case over(String, cap: Int)
    // The capped types whose count the load did not read.
    case uncounted([String])
  }

  // A type grows only where a delta shows a record `stored` does not, so only such a type is counted; one the load did not
  // read whole is uncounted.
  func capCount(_ deltas: [Delta], stored: ScopeView) throws -> CapCount {
    var after = stored
    for delta in deltas { try after.fold(delta) }
    var types: [String] = []
    for delta in deltas where !types.contains(delta.key.type) { types.append(delta.key.type) }
    let grown = types.compactMap { (type: String) -> (name: String, cap: Int)? in
      guard let cap = registry.type(type)?.cap else { return nil }
      let shows = deltas.contains { (delta: Delta) -> Bool in
        delta.key.type.utf8.elementsEqual(type.utf8) && after.record(delta.key).map(after.isVisible) == true
          && stored.record(delta.key).map(stored.isVisible) != true
      }
      return shows ? (type, cap) : nil
    }
    let uncounted = grown.map(\.name).filter { !stored.covers(type: $0) }
    guard uncounted.isEmpty else { return .uncounted(uncounted) }
    let over = grown.first { (type: (name: String, cap: Int)) -> Bool in
      let count = after.visibleCount(type.name)
      return count > type.cap && count > stored.visibleCount(type.name)
    }
    return over.map { .over($0.name, cap: $0.cap) } ?? .within
  }
}

// An id a commit drew by a type's mint.
public struct Draw: Sendable, Hashable {
  public let mint: Mint
  public let id: RecordID
}

// What a plan needed of the replica that its load did not read, so it decided nothing: the keys of the minted ids it drew,
// the capped types whose count a change that shows one more of their records needs, and every entry, where a silent fold
// reaches past the entries the load read. The Action reads them, with the entries that touch the rows, and plans the
// commit again, which takes `draws`, every id drawn so far in order, before it draws another, so it draws and decides as
// one plan over every row and entry would.
public struct UnreadRows: Error, Sendable {
  public let keys: [RecordKey]
  public let types: [String]
  public let everyEntry: Bool
  public let draws: [Draw]

  init(keys: [RecordKey] = [], types: [String] = [], everyEntry: Bool = false, draws: [Draw]) {
    self.keys = keys
    self.types = types
    self.everyEntry = everyEntry
    self.draws = draws
  }
}

// §7.1 step 7 on a device: the identities a commit draws from, a gesture id drawn again while an outbox entry or a notice
// of any replica on the device carries it, so a minted gesture id is never another gesture's.
public final class UniqueGestureIDs: IdentitySource {
  let drawing: IdentitySource
  let carries: (String) throws -> Bool

  public init(_ drawing: IdentitySource, carries: @escaping (String) throws -> Bool) {
    self.drawing = drawing
    self.carries = carries
  }

  public func gestureID() throws -> String {
    while true {
      let id = try drawing.gestureID()
      if try !carries(id) { return id }
    }
  }

  public func draw(below bound: Int) throws -> Int { try drawing.draw(below: bound) }
  public func replicaID() throws -> String { try drawing.replicaID() }
  public func actor() throws -> Stamp.Actor { try drawing.actor() }
  public func forkGuard() throws -> String { try drawing.forkGuard() }
}

// MARK: - Deltas (§7.1 steps 4 and 5)

// Diffs one gesture's changes against `drawn`, stamped `s`, resolving each create's id.
struct DeltaBuilder {
  let registry: Registry
  let replica: LoadedReplica
  let scope: ScopeRef
  let stamp: Stamp
  let physNow: Int64
  let drawn: ScopeView
  let stored: ScopeView
  let identities: IdentitySource
  var draws: [Draw]
  var drawsTaken = 0
  var unread: [RecordKey] = []
  var chosen: Set<RecordID> = []
  var baseTexts: [TextRef: String] = [:]
  var ids: [RecordID?] = []

  mutating func delta(_ change: Change) throws -> Delta? {
    let type = try typeOf(change.type)
    if change.anchor != nil {
      switch change.operation {
      case .create, .move: break
      default: throw CommitFailure.malformed("an anchor goes with a create or a move")
      }
    }
    switch change.operation {
    case .create(let newID): return try create(type, newID, change)
    case .move(let id):
      ids.append(id)
      return try move(type, id, change.anchor)
    case .update(let id):
      ids.append(id)
      return try update(type, id, values: change.values, texts: change.texts)
    case .delete(let id):
      ids.append(id)
      return try remove(type, id, values: change.values, texts: change.texts)
    case .revive(let id):
      ids.append(id)
      return try revive(type, id, values: change.values)
    case .put(let id, let present):
      ids.append(id)
      return try put(type, id, present: present, values: change.values, texts: change.texts)
    case .write(let id):
      ids.append(id)
      return try write(type, id, values: change.values, texts: change.texts)
    }
  }

  // A command's prediction stays local, including deaths and server-assigned serial values.
  mutating func predicted(_ change: Change) throws -> Delta {
    let type = try typeOf(change.type)
    guard let id = change.id else { throw CommitFailure.malformed("a prediction names its record") }
    for (name, value) in change.serials {
      guard let field = type.field(name), case .serial = field.kind else {
        throw CommitFailure.malformed("\(type.name).\(name) is not a serial field")
      }
      guard (try? value.asInteger(atLeast: 1)) != nil else {
        throw CommitFailure.malformed("\(type.name).\(name) is not a positive serial value")
      }
    }
    let key = RecordKey(type.name, id)
    let current = drawn.record(key)
    var delta = Delta(key: key)
    switch change.operation {
    case .create:
      if type.life {
        delta.lattice.born = stamp
        delta.lattice.life = Life(.alive, stamp)
      }
      delta.lattice.fields = try fields(type, change.values, current: nil, server: true)
    case .delete:
      guard type.life else { throw CommitFailure.malformed("\(type.name) has no life") }
      if type.hasBorn {
        guard let current else { throw CommitFailure.malformed("a predicted delete of \(key) absent from drawn") }
        delta.lattice.born = current.lattice.born
      }
      delta.lattice.life = Life(.dead, stamp)
      return delta
    case .update, .write, .put:
      if type.hasBorn {
        guard let current else { throw CommitFailure.malformed("a predicted update of \(key) absent from drawn") }
        delta.lattice.born = current.lattice.born
      }
      if case .put(_, let present) = change.operation, type.identity == .keyed, type.life {
        guard present != nil || current != nil else {
          throw CommitFailure.malformed("a predicted put keeping the presence of \(key) finds it absent from drawn")
        }
        let presentBefore = current?.lattice.life?.isAlive == true
        let present = present ?? presentBefore
        var life = current?.lattice.life
        if present && (!presentBefore || type.wholePut) { life = Life(.alive, stamp) }
        if !present && presentBefore { life = Life(.dead, stamp) }
        delta.lattice.life = life
      }
      delta.lattice.fields = try fields(type, change.values, current: current, server: true)
    default:
      throw CommitFailure.malformed("a prediction is a create, update, delete, put or write")
    }
    delta.texts = try texts(type, key, change.texts, current: current, server: true)
    delta.serials = change.serials
    return delta
  }

  func typeOf(_ name: String) throws -> TypeDef {
    guard let type = registry.type(name), registry.lives(name, in: scope) else { throw CommitFailure.malformed("\(name) does not live in \(scope)") }
    return type
  }

  // Step 5: a given id; a seeded one (D-8); a derived one from its label (D-26); else one minted by the type's mint,
  // drawn again while chosen earlier in this gesture, or taken in drawn or spent, which its key alone answers. A drawn key
  // the load did not read answers nothing yet: it is noted unread, and the plan goes on only to draw the rest.
  mutating func id(of type: TypeDef, _ newID: NewID) throws -> RecordID {
    switch newID {
    case .given(let id): return id
    case .seeded(let seed, let ordinal):
      do {
        return RecordID(try SeededID(seed: seed, ordinal: ordinal, for: type).id)
      } catch {
        throw CommitFailure.malformed("\(error)")
      }
    case .derived(let label):
      guard type.identity == .derived, let fallback = type.deriveFallback else { throw CommitFailure.malformed("\(type.name) does not derive ids") }
      do {
        return RecordID(try DerivedID.from(label: label, fallback: fallback,
                                          taken: takenIDs(of: type).compactMap(\.string), maxChars: type.idMaxChars))
      } catch {
        throw CommitFailure.malformed("a derived id cannot fit its domain")
      }
    case .minted:
      guard let mint = type.mint else { throw CommitFailure.malformed("\(type.name) does not mint ids") }
      while true {
        let id = try draw(by: mint)
        let key = RecordKey(type.name, id)
        if chosen.contains(id) { continue }
        guard drawn.covers(key) else {
          unread.append(key)
          return id
        }
        if drawn.record(key) == nil && replica.spentIDs(scope)[key] == nil { return id }
      }
    }
  }

  // The next id `mint` draws: the next an earlier plan of this commit drew, while that plan drew it by the same mint,
  // else a new one.
  mutating func draw(by mint: Mint) throws -> RecordID {
    if drawsTaken < draws.count && draws[drawsTaken].mint != mint { draws.removeSubrange(drawsTaken...) }
    if drawsTaken == draws.count { draws.append(Draw(mint: mint, id: RecordID(try mint.id(drawing: identities.draw(below:))))) }
    drawsTaken += 1
    return draws[drawsTaken - 1].id
  }

  func takenIDs(of type: TypeDef) -> Set<RecordID> {
    chosen.union(drawn.records(ofType: type.name).map(\.key.id))
      .union(replica.spentIDs(scope).keys.filter { $0.type.utf8.elementsEqual(type.name.utf8) }.map(\.id))
  }

  mutating func create(_ type: TypeDef, _ newID: NewID, _ change: Change) throws -> Delta? {
    guard type.hasBorn else { throw CommitFailure.malformed("\(type.name) is created by put or write") }
    let id = try id(of: type, newID)
    ids.append(id)
    chosen.insert(id)
    let key = RecordKey(type.name, id)
    if unread.contains(key) { return nil }
    let values = try change.anchor.map { try placed(type, id, change.values, $0) } ?? change.values
    if drawn.record(key) != nil { return nil }
    var delta = Delta(key: key, lattice: Lattice(life: Life(.alive, stamp), born: stamp))
    delta.lattice.fields = try fields(type, values, current: nil, create: true)
    delta.texts = try texts(type, key, change.texts, current: nil)
    return delta
  }

  // A move writes only its anchor's order field, by an update: only minted and derived types hold one (§2.4).
  mutating func move(_ type: TypeDef, _ id: RecordID, _ anchor: OrderAnchor?) throws -> Delta? {
    guard let anchor else { throw CommitFailure.malformed("a move carries an anchor") }
    return try update(type, id, values: try placed(type, id, [:], anchor), texts: [:])
  }

  // The values with the anchor's order field at D-25's drop position: the anchor is looked up in drawn, then in
  // stored, and the list is the type's visible records that hold the field.
  func placed(_ type: TypeDef, _ id: RecordID, _ values: [String: JSON], _ anchor: OrderAnchor) throws -> [String: JSON] {
    guard case .fracKey? = type.field(anchor.field)?.domain?.shape else {
      throw CommitFailure.malformed("\(type.name).\(anchor.field) is not an order field")
    }
    guard values[anchor.field] == nil else { throw CommitFailure.malformed("\(type.name).\(anchor.field) is written beside an anchor") }
    do {
      let members = { (view: ScopeView) throws -> [ListMember] in
        try view.records(ofType: type.name).filter(view.isVisible).compactMap { record in
          guard let key = record.value(anchor.field) else { return nil }
          return ListMember(id: record.key.id.json, key: try FractionalKey(key.asString()))
        }
      }
      let key = try FractionalKey(dropping: id.json, below: anchor.below?.json, stored: members(stored), drawn: members(drawn))
      return values.merging([anchor.field: .string(key.text)]) { $1 }
    } catch let error as CommitFailure {
      throw error
    } catch {
      throw CommitFailure.malformed("no drop position: \(error)")
    }
  }

  func existing(_ type: TypeDef, _ id: RecordID) throws -> ViewRecord {
    guard let current = drawn.record(RecordKey(type.name, id)) else { throw CommitFailure.malformed("\(type.name) \(id) is absent from drawn") }
    return current
  }

  mutating func update(_ type: TypeDef, _ id: RecordID, values: [String: JSON], texts edits: [String: TextEdit]) throws -> Delta? {
    guard type.hasBorn else { throw CommitFailure.malformed("\(type.name) is updated by put or write") }
    let current = try existing(type, id)
    var delta = Delta(key: current.key, lattice: Lattice(born: current.lattice.born))
    return try withChanges(&delta, type, values, edits, current: current) ? delta : nil
  }

  // A keyed record is removed by a put that makes it absent, with what the change names.
  mutating func remove(_ type: TypeDef, _ id: RecordID, values: [String: JSON], texts edits: [String: TextEdit]) throws -> Delta? {
    guard type.identity != .keyed else { return try put(type, id, present: false, values: values, texts: edits) }
    guard type.hasBorn else { throw CommitFailure.malformed("\(type.name) has no life") }
    let current = try existing(type, id)
    return Delta(key: current.key, lattice: Lattice(life: Life(.dead, stamp), born: current.lattice.born))
  }

  func revive(_ type: TypeDef, _ id: RecordID, values: [String: JSON]) throws -> Delta? {
    guard type.hasBorn else { throw CommitFailure.malformed("\(type.name) is not revived") }
    let key = RecordKey(type.name, id)
    let current = drawn.record(key)
    guard let born = current?.lattice.born ?? replica.spentIDs(scope)[key]?.born else {
      throw CommitFailure.malformed("a revive of \(key) without a born")
    }
    var delta = Delta(key: key, lattice: Lattice(life: Life(.alive, stamp), born: born))
    delta.lattice.fields = try fields(type, values, current: current)
    return delta
  }

  // A keyed put's life: alive when it makes the record present, dead when it removes it, else the drawn life unchanged. A
  // put that makes the record present diffs against no record, since the server keeps no field of a dead keyed record
  // (G1). A put that leaves a `wholePut` record present is a whole put; any other carries its life alone, since §6.1 step 2
  // refuses a dead whole delta with a field register, so one that names a field value throws.
  mutating func put(_ type: TypeDef, _ id: RecordID, present: Bool?, values: [String: JSON], texts edits: [String: TextEdit]) throws -> Delta? {
    guard type.identity == .keyed, type.life else { throw CommitFailure.malformed("\(type.name) is not keyed with life") }
    let key = RecordKey(type.name, id)
    let current = drawn.record(key)
    guard present != nil || current != nil else { throw CommitFailure.malformed("a put keeping the presence of \(key) finds it absent from drawn") }
    let presentBefore = current?.lattice.life?.isAlive == true
    let present = present ?? presentBefore
    if present && type.wholePut { return try wholePut(type, key, values: values, texts: edits) }
    guard !type.wholePut || (values.isEmpty && edits.isEmpty) else { throw CommitFailure.malformed("a removal of \(key) carries its life alone") }
    let makesPresent = present && !presentBefore
    var life = current?.lattice.life
    if makesPresent { life = Life(.alive, stamp) }
    if !present && presentBefore { life = Life(.dead, stamp) }
    guard let life else { return nil }
    var delta = Delta(key: key, lattice: Lattice(life: life))
    let changed = try withChanges(&delta, type, values, edits, current: makesPresent ? nil : current)
    return changed || life != current?.lattice.life ? delta : nil
  }

  // §7.1 step 4: every client-written lattice field of the type, changed or not, and a fresh life, all stamped `s`, so the
  // newest save wins whole. A change that leaves such a field out throws, as does a text edit, since the type has none.
  func wholePut(_ type: TypeDef, _ key: RecordKey, values: [String: JSON], texts edits: [String: TextEdit]) throws -> Delta {
    let missing = type.clientLatticeFields.map(\.name).filter { values[$0] == nil }
    guard missing.isEmpty else { throw CommitFailure.malformed("a whole put of \(key) leaves out \(missing.joined(separator: ", "))") }
    guard edits.isEmpty else { throw CommitFailure.malformed("\(type.name) has no text field") }
    return Delta(key: key, lattice: Lattice(life: Life(.alive, stamp), fields: try fields(type, values, current: nil)))
  }

  mutating func write(_ type: TypeDef, _ id: RecordID, values: [String: JSON], texts edits: [String: TextEdit]) throws -> Delta? {
    guard !type.life else { throw CommitFailure.malformed("\(type.name) has life") }
    let key = RecordKey(type.name, id)
    var delta = Delta(key: key)
    return try withChanges(&delta, type, values, edits, current: drawn.record(key)) ? delta : nil
  }

  mutating func withChanges(_ delta: inout Delta, _ type: TypeDef, _ values: [String: JSON], _ edits: [String: TextEdit],
                            current: ViewRecord?) throws -> Bool {
    delta.lattice.fields = try fields(type, values, current: current)
    delta.texts = try texts(type, delta.key, edits, current: current)
    return !delta.lattice.fields.isEmpty || !delta.texts.isEmpty
  }

  // Only the fields whose value differs from drawn, every number rounded to its domain's quantum at any depth; a create's
  // unset client time fields take physNow. A client write of a server field throws; a prediction may write one.
  func fields(_ type: TypeDef, _ values: [String: JSON], current: ViewRecord?, create: Bool = false,
              server: Bool = false) throws -> [String: Register] {
    var out: [String: Register] = [:]
    for (name, raw) in values {
      guard let field = type.field(name), field.kind.isLattice else { throw CommitFailure.malformed("\(type.name).\(name) is not a lattice field") }
      guard field.writer == .client || server else { throw CommitFailure.malformed("\(type.name).\(name) is written by the server") }
      let value = field.domain?.rounded(raw) ?? raw
      if let register = current?.lattice.fields[name], register.value == value { continue }
      out[name] = Register(value, stamp)
    }
    if create {
      for name in type.clientTimeFields where out[name] == nil { out[name] = Register(JSON(physNow), stamp) }
    }
    return out
  }

  // A text change names the text it was edited from (the drawn text by default); its base is the confirmed rev when
  // that text is the confirmed one, otherwise the text itself.
  mutating func texts(_ type: TypeDef, _ key: RecordKey, _ edits: [String: TextEdit], current: ViewRecord?, server: Bool = false) throws -> [String: TextWrite] {
    var out: [String: TextWrite] = [:]
    for (name, edit) in edits {
      guard let field = type.field(name), case .text = field.kind else { throw CommitFailure.malformed("\(type.name).\(name) is not a text field") }
      guard field.writer == .client || server else { throw CommitFailure.malformed("\(type.name).\(name) is written by the server") }
      let shown = current?.texts[name] ?? ""
      let from = edit.editedFrom ?? shown
      if edit.text.utf8.elementsEqual(shown.utf8) { continue }
      let confirmed = replica.rows(scope).row(key)?.texts[name]
      let base: TextBase = if let confirmed, confirmed.text.utf8.elementsEqual(from.utf8) { .rev(confirmed.rev) } else { .text(from) }
      out[name] = TextWrite(text: edit.text, base: base)
      baseTexts[TextRef(key, name)] = from
    }
    return out
  }
}
