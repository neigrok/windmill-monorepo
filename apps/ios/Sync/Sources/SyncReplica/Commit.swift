import SyncAPI
import SyncCore

// §7.1 commit: one gesture, one local transaction. A throw writes nothing; a cap refusal writes nothing and retires
// nothing; a too-large refusal writes only its notice. The clock is written back once the commit is accepted.

public struct CommitPlanner: Sendable {
  public let registry: Registry
  public let limits: Limits
  let hold: Hold

  public init(registry: Registry, limits: Limits = Limits()) {
    self.registry = registry
    self.limits = limits
    hold = Hold(registry: registry)
  }

  // §7.1 for a decided gesture. The read-and-commit form runs step 1, `checkWritable`, then its body through the
  // caller's reader, and commits here only when the body decides a gesture: a nil one writes nothing and ticks no clock.
  // `gestureIdTaken`: an outbox entry or a notice of any replica on the device carries the gesture's given id (§2.5).
  public func commit(_ gesture: Gesture, in scope: ScopeRef, to replica: inout LoadedReplica, as instance: Instance,
                     identities: IdentitySource, gestureIdTaken: Bool) throws -> CommitOutcome {
    try checkWritable(replica.meta)
    return try commitGesture(gesture, in: scope, to: &replica, as: instance, identities: identities, gestureIdTaken: gestureIdTaken)
  }

  // The rows a commit of `gesture` reads, for its Action to load first: the records its changes, predictions and
  // guards name; whole types where it mints or derives an id, places by an anchor, or may grow a capped type; and in a
  // tree or overlay scope, the governing record the scope check reads.
  public func reads(of gesture: Gesture, in scope: ScopeRef) -> [ScopeRef: RowSelection] {
    var selection = RowSelection()
    for change in gesture.changes + gesture.predict {
      guard let type = registry.type(change.type) else { continue }
      switch change.operation {
      case .create(.minted), .create(.derived): selection.types.insert(type.name)
      case .create(.seeded(let seed, let ordinal)):
        if let id = try? SeededID(seed: seed, ordinal: ordinal, for: type).id { selection.keys.insert(RecordKey(type.name, RecordID(id))) }
      default: if let id = change.id { selection.keys.insert(RecordKey(type.name, id)) }
      }
      if change.anchor != nil || type.cap != nil { selection.types.insert(type.name) }
    }
    selection.keys.formUnion(gesture.guards.map(\.key))
    var reads = [scope: selection]
    if let tree = scope.tree, let governing = registry.governingType, let productScope = registry.governingScope() {
      reads[productScope, default: RowSelection()].keys.insert(RecordKey(governing.name, RecordID(tree)))
    }
    return reads
  }

  // Step 1: the replica is anon or bound.
  public func checkWritable(_ meta: ReplicaMeta) throws {
    guard meta.state == .anon || meta.state == .bound else { throw CommitFailure(.notWritable, "a \(meta.state.rawValue) replica does not commit") }
  }

  // Steps 2–11, after the checks before step 2. The retire and its silent fold run on a working copy, which the diff reads
  // and which the replica becomes once the commit is accepted.
  func commitGesture(_ gesture: Gesture, in scope: ScopeRef, to replica: inout LoadedReplica, as instance: Instance,
                     identities: IdentitySource, gestureIdTaken: Bool) throws -> CommitOutcome {
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

    let retiring = retiringEntries(of: gesture.retire, in: scope, replica: replica)
    var retired = replica
    try hold.end(retiring, by: .retire, in: &retired)
    var builder = DeltaBuilder(
      registry: registry, replica: retired, scope: scope, stamp: stamp, physNow: physNow,
      drawn: try ScopeView(retired, scope, .drawn, registry: registry),
      stored: try ScopeView(retired, scope, .stored, registry: registry), identities: identities)
    let deltas = try oneDeltaPerRecord(try gesture.changes.compactMap { change in try builder.delta(change).map { (change, $0) } })
    let predict = try gesture.predict.map { try builder.predicted($0) }
    let guards = try exactGuards(gesture.guards, in: scope, stored: builder.stored)
    // Step 7: a string the intents send (their scope, deltas, guards, command and given gesture id) holding U+0000
    // throws, before step 8's caps; predictions and device rows are never sent.
    let sent = Intent(scope: scope, deltas: deltas, guards: guards, command: gesture.command, gestureId: gesture.gestureId)
    guard !sent.json.holdsNul else { throw CommitFailure.malformed("a string of the intents holds U+0000") }
    if let capped = try cappedType(deltas, stored: builder.stored), let cap = registry.type(capped)?.cap {
      return .refused(.cap, detail: ["type": .string(capped), "cap": JSON(cap)])
    }
    let gestureId = try gesture.gestureId ?? identities.gestureID()
    guard gesture.gestureId != nil || !replica.outbox.contains(where: { $0.gestureId.utf8.elementsEqual(gestureId.utf8) }) else {
      throw CommitFailure.malformed("the minted gesture id \(gestureId) is taken")
    }
    let intents = group(deltas, guards: guards, gesture: gesture, scope: scope, gestureId: gestureId)

    // Step 8: an intent the widest request cannot carry alone refuses the gesture, so an entry as committed always fits
    // a request alone.
    if intents.contains(where: { PushRequest(widestFor: $0, of: replica.meta.replica).body.count > limits.pushMaxBytes }) {
      let notice = "notice:\(gestureId)/0"
      replica.apply(.putNotice(Notice(
        id: notice, product: product, scope: scope, code: .tooLarge, detail: nil,
        content: NoticeContent(deltas: deltas, command: gesture.command), at: instance.deviceNow)))
      return .refused(.tooLarge, detail: nil, notice: notice)
    }

    replica = retired
    let releaseAt = gesture.hold ? instance.deviceNow + limits.holdMs : 0
    let firstOrder = replica.nextCommitOrder
    let entries = try intents.enumerated().map { k, intent in
      guard case .state(let state) = try Machines.intent.transition(from: nil, .commit, to: .state(gesture.hold ? .held : .ready)) else {
        preconditionFailure("a commit enqueues")
      }
      let texts = Set(intent.deltas.flatMap { delta in delta.texts.keys.map { TextRef(delta.key, $0) } })
      return OutboxEntry(
        localId: "\(gestureId)/\(k)", gestureId: gestureId, lineage: replica.meta.lineage, scope: scope, state: state,
        commitOrder: firstOrder + Int64(k), releaseAt: releaseAt, stamp: stamp, intent: intent,
        predict: gesture.command == nil ? [] : predict, baseTexts: builder.baseTexts.filter { texts.contains($0.key) })
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
      releaseAt: gesture.hold ? releaseAt : nil, retired: retiredGestures))
  }

  func product(of scope: ScopeRef) throws -> String {
    guard let product = registry.product(of: scope) else { throw CommitFailure.malformed("\(scope) belongs to no product") }
    return product
  }

  // Step 2: a tree or overlay scope whose governing record is dead in `stored`, or that is known gone or not found.
  func scopeIsDead(_ scope: ScopeRef, in replica: LoadedReplica) throws -> Bool {
    guard let tree = scope.tree else { return false }
    if replica.known[scope] != nil || replica.known[.tree(tree)] != nil { return true }
    guard let governing = registry.governingType, let productScope = registry.governingScope() else { return false }
    let stored = try ScopeView(replica, productScope, .stored, registry: registry)
    return stored.record(RecordKey(governing.name, RecordID(tree)))?.lattice.life?.state == .dead
  }

  // Step 4's retire: the held gestures of the scope with no command, whose every delta removes a named record.
  func retiringEntries(of retire: [RecordRef], in scope: ScopeRef, replica: LoadedReplica) -> [OutboxEntry] {
    guard !retire.isEmpty else { return [] }
    let named = Set(retire.map(\.key))
    let removesNamed = { (entry: OutboxEntry) in
      entry.intent.command == nil && !entry.intent.deltas.isEmpty
        && entry.intent.deltas.allSatisfy { $0.removes && named.contains($0.key) }
    }
    var gestures: [(id: String, entries: [OutboxEntry])] = []
    for entry in replica.outbox {
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
  func group(_ deltas: [Delta], guards: [Guard], gesture: Gesture, scope: ScopeRef, gestureId: String) -> [Intent] {
    if gesture.atomic || gesture.hold || gesture.command != nil {
      guard !deltas.isEmpty || gesture.command != nil else { return [] }
      return [Intent(scope: scope, deltas: deltas, guards: guards, command: gesture.command, gestureId: gestureId)]
    }
    var intents = deltas.map { delta in
      Intent(scope: scope, deltas: [delta], guards: guards.filter { $0.key == delta.key }, gestureId: gestureId)
    }
    let unplaced = guards.filter { guardKey in !deltas.contains { $0.key == guardKey.key } }
    if !unplaced.isEmpty && !intents.isEmpty { intents[0].guards += unplaced }
    return intents
  }

  // Step 8: the capped type the deltas, applied to `stored`, grow past its cap by the growth rule; a held delete still
  // occupies its slot.
  func cappedType(_ deltas: [Delta], stored: ScopeView) throws -> String? {
    var after = stored
    for delta in deltas { try after.fold(delta) }
    var types: [String] = []
    for delta in deltas where !types.contains(delta.key.type) { types.append(delta.key.type) }
    return types.first { type in
      guard let cap = registry.type(type)?.cap else { return false }
      let count = after.visibleCount(type)
      return count > cap && count > stored.visibleCount(type)
    }
  }
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
      return try remove(type, id)
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

  // A command's prediction: a create or an update of any field, server-written ones included.
  func predicted(_ change: Change) throws -> Delta {
    let type = try typeOf(change.type)
    guard let id = change.id else { throw CommitFailure.malformed("a prediction names its record") }
    let key = RecordKey(type.name, id)
    let current = drawn.record(key)
    var delta = Delta(key: key)
    switch change.operation {
    case .create:
      delta.lattice.born = stamp
      delta.lattice.life = Life(.alive, stamp)
      delta.lattice.fields = try fields(type, change.values, current: nil, server: true)
    case .update:
      if type.hasBorn {
        guard let current else { throw CommitFailure.malformed("a predicted update of \(key) absent from drawn") }
        delta.lattice.born = current.lattice.born
      }
      delta.lattice.fields = try fields(type, change.values, current: current, server: true)
    default:
      throw CommitFailure.malformed("a prediction is a create or an update")
    }
    return delta
  }

  func typeOf(_ name: String) throws -> TypeDef {
    guard let type = registry.type(name), registry.lives(name, in: scope) else { throw CommitFailure.malformed("\(name) does not live in \(scope)") }
    return type
  }

  // Step 5: a given id; a seeded one (D-8); a derived one from its label (D-26); else one minted by the type's mint,
  // drawn again while taken in drawn, spent, or chosen earlier in this gesture.
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
      return RecordID(DerivedID.from(label: label, fallback: fallback, taken: takenIDs(of: type).compactMap(\.string)))
    case .minted:
      guard let mint = type.mint else { throw CommitFailure.malformed("\(type.name) does not mint ids") }
      let taken = takenIDs(of: type)
      let identities = self.identities
      let draw = { () throws -> RecordID in RecordID(try mint.id(drawing: identities.draw(below:))) }
      var id = try draw()
      while taken.contains(id) { id = try draw() }
      return id
    }
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
    let values = try change.anchor.map { try placed(type, id, change.values, $0) } ?? change.values
    let key = RecordKey(type.name, id)
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

  mutating func remove(_ type: TypeDef, _ id: RecordID) throws -> Delta? {
    guard type.identity != .keyed else { return try put(type, id, present: false, values: [:], texts: [:]) }
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

  // A keyed put's life: alive when it makes the record present, dead when it removes it, else the drawn life unchanged.
  mutating func put(_ type: TypeDef, _ id: RecordID, present: Bool?, values: [String: JSON], texts edits: [String: TextEdit]) throws -> Delta? {
    guard type.identity == .keyed, type.life else { throw CommitFailure.malformed("\(type.name) is not keyed with life") }
    let key = RecordKey(type.name, id)
    let current = drawn.record(key)
    guard present != nil || current != nil else { throw CommitFailure.malformed("a put keeping the presence of \(key) finds it absent from drawn") }
    let presentBefore = current?.lattice.life?.isAlive == true
    let present = present ?? presentBefore
    var life = current?.lattice.life
    if present && !presentBefore { life = Life(.alive, stamp) }
    if !present && presentBefore { life = Life(.dead, stamp) }
    guard let life else { return nil }
    var delta = Delta(key: key, lattice: Lattice(life: life))
    let changed = try withChanges(&delta, type, values, edits, current: current)
    return changed || life != current?.lattice.life ? delta : nil
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

  // Only the fields whose value differs from drawn, each rounded to its quantum; a create's unset client time fields
  // take physNow. A client write of a server field throws; a prediction may write one.
  func fields(_ type: TypeDef, _ values: [String: JSON], current: ViewRecord?, create: Bool = false,
              server: Bool = false) throws -> [String: Register] {
    var out: [String: Register] = [:]
    for (name, raw) in values {
      guard let field = type.field(name), field.kind.isLattice else { throw CommitFailure.malformed("\(type.name).\(name) is not a lattice field") }
      guard field.writer == .client || server else { throw CommitFailure.malformed("\(type.name).\(name) is written by the server") }
      var value = raw
      if let quantum = field.quantum, case .number(let number) = raw, let rounded = JSON.Number(quantum.rounded(number.value)) {
        value = .number(rounded)
      }
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
  mutating func texts(_ type: TypeDef, _ key: RecordKey, _ edits: [String: TextEdit], current: ViewRecord?) throws -> [String: TextWrite] {
    var out: [String: TextWrite] = [:]
    for (name, edit) in edits {
      guard case .text? = type.field(name)?.kind else { throw CommitFailure.malformed("\(type.name).\(name) is not a text field") }
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
