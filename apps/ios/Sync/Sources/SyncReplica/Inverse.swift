import SyncAPI
import SyncCore

// K-3 Undo and Redo of an act (engine.md §7.3 Undo of an act). A wholly held act is cancelled in place, keeping the
// receipt of what disappeared for its Redo. Otherwise an inverse request reserves its slots in the outbox at once, each an
// ordinary entry at the end of commit order that carries its optimistic projection and stops the sender until it is
// materialized; once every source of the act is authoritative, the slots bind the latest versions the act owns and its
// first preimages into restore or inverse commands, in one transaction, and a slot left with nothing settles unnumbered.
// The inverse act journals its own preimages, so a Redo takes back only what the Undo actually applied.

public struct Inverses: Sendable {
  public let registry: Registry
  let hold: Hold

  public init(registry: Registry) {
    self.registry = registry
    hold = Hold(registry: registry)
  }

  // MARK: Requests

  // requestInverse(sourceActId, inverseSlots?): an Undo of an opted act, or a Redo of an inverse act or a cancellation.
  // Asking again answers the act's existing request. `replacement`, a complete list by source ordinal, stands in for the
  // stored recipes (a product's Redo).
  public func request(_ sourceActId: String, replacing replacement: [ActUndo.Segment]? = nil, in replica: inout LoadedReplica,
                      as instance: Instance, identities: IdentitySource) throws -> InverseResult {
    if let existing = replica.journal.inverses.first(where: { $0.sourceActId.isSameID(as: sourceActId) }) { return existing.current }
    let act = replica.journal.act(sourceActId)
    let cancellation = replica.journal.cancellations.first { $0.inverseActId.isSameID(as: sourceActId) }
    guard act != nil || cancellation != nil else { return .unavailable(requestId: nil, reason: "not-reversible") }
    let entries = replica.outbox.filter { $0.gestureId.isSameID(as: sourceActId) }
    if let act, !entries.isEmpty, entries.allSatisfy({ $0.state == .held }) {
      return try cancelHeld(act, entries: entries, in: &replica, identities: identities)
    }
    let planned = act.map { plannedSlots(of: $0, replacing: replacement) } ?? redoSlots(of: cancellation!)
    let inverseActId = try identities.gestureID()
    let requestId = try identities.gestureID()
    let physNow = replica.meta.physNow(deviceNow: instance.deviceNow)
    var clock = replica.meta.hlc
    clock.observe(replica.meta.hlcHigh)
    let stamp = clock.tick(physNow: physNow, actor: instance.actor)
    let firstOrder = replica.nextCommitOrder
    let slots: [(scope: ScopeRef, slot: InverseSlot)] = planned.enumerated().map { (k: Int, planned: (scope: ScopeRef, recipe: SlotRecipe)) in
      (planned.scope, InverseSlot(localId: "\(inverseActId)/\(k)", commitOrder: firstOrder + Int64(k), recipe: planned.recipe))
    }
    var before: [ScopeRef: ScopeView] = [:]
    for (scope, _) in slots where before[scope] == nil { before[scope] = try ScopeView(replica, scope, .drawn, registry: registry) }
    let journal = inverseJournal(inverseActId, slots: slots, views: before)
    var touched: [ScopedKey] = []
    for (scope, slot) in slots {
      let deltas = slot.recipe.restoring.map { projection(of: $0, over: before[scope]!, at: stamp) } ?? []
      touched += deltas.map { ScopedKey(scope: scope, key: $0.key) }
      var entry = OutboxEntry(
        localId: slot.localId, gestureId: inverseActId, lineage: replica.meta.lineage, scope: scope, state: .ready,
        commitOrder: slot.commitOrder, releaseAt: 0, stamp: stamp,
        intent: Intent(scope: scope, command: Command(name: slot.recipe.command, args: .null), gestureId: inverseActId),
        predictions: [Projection(scope: scope, deltas: deltas)])
      entry.inverseOf = requestId
      replica.apply(.putEntry(entry))
    }
    let after = try views(of: Array(before.keys), in: replica)
    let localChanged = touched.contains { after[$0.scope]?.record($0.key) != before[$0.scope]?.record($0.key) }
    replica.updateJournal { stored in
      stored.inverses.append(InverseRequest(requestId: requestId, sourceActId: sourceActId, inverseActId: inverseActId, state: .waiting,
                                            localChanged: localChanged, slots: slots.map(\.slot)))
      stored.acts.append(journal)
    }
    replica.update { meta in
      meta.hlc = clock
      meta.hlcHigh = stamp
    }
    try materialize(requestId, in: &replica)
    return read(requestId, in: replica)
  }

  // readInverseResult(requestId): cancelled, pending, settled or unavailable.
  public func read(_ requestId: String, in replica: LoadedReplica) -> InverseResult {
    replica.journal.request(requestId)?.current ?? .unavailable(requestId: requestId, reason: "unknown-request")
  }

  // releaseReversibleAct(actId): false when the journal holds no such act.
  public func release(_ actId: String, in replica: inout LoadedReplica) -> Bool {
    replica.updateJournal { $0.release(actId) }
  }

  // The rows a request reads: the records its act's recipes and preimages name, or its cancellation's units, and every
  // record an entry of the scopes it reaches touches, which a cancellation compares before and after.
  public func reads(of sourceActId: String, in replica: LoadedReplica) -> [ScopeRef: RowSelection] {
    var reads: [ScopeRef: RowSelection] = [:]
    let add = { (address: RecordAddress) -> Void in reads[address.scope, default: RowSelection()].keys.insert(address.key) }
    for source in replica.journal.act(sourceActId)?.sourceEntries ?? [] {
      reads[source.originScope, default: RowSelection()] = reads[source.originScope] ?? RowSelection()
      for recipe in source.recipes {
        switch recipe {
        case .fields(_, let targets): targets.forEach { add($0.target.address) }
        case .createdRecord(_, let record): add(record)
        case .command: break
        }
      }
    }
    for unit in replica.journal.cancellations.first(where: { $0.inverseActId.isSameID(as: sourceActId) })?.units ?? [] {
      switch unit {
      case .field(_, let target, _, _): add(target.address)
      case .createdRecord(_, let record, _, _): add(record)
      }
    }
    for entry in replica.outbox where entry.gestureId.isSameID(as: sourceActId) {
      for effect in entry.effects() { reads[effect.scope, default: RowSelection()] = reads[effect.scope] ?? RowSelection() }
    }
    for entry in replica.outbox {
      for effect in entry.effects() where reads[effect.scope] != nil {
        reads[effect.scope]!.keys.formUnion(effect.deltas.map(\.key))
      }
    }
    return reads
  }

  // MARK: Held cancellation

  // An act every entry of which is still held never reached the server: Undo cancels it in place, its dependents folded
  // silently, and reports whether anything drawn changed. The act leaves the journal, and a cancellation receipt keeps what
  // actually disappeared for its Redo.
  func cancelHeld(_ act: ReversibleAct, entries: [OutboxEntry], in replica: inout LoadedReplica, identities: IdentitySource) throws -> InverseResult {
    var scopes: [ScopeRef] = []
    for scope in entries.flatMap(\.scopes) where !scopes.contains(scope) { scopes.append(scope) }
    let keys = Dictionary(uniqueKeysWithValues: scopes.map { (scope: ScopeRef) -> (ScopeRef, [RecordKey]) in
      (scope, Array(Set(replica.outbox.flatMap { $0.deltas(in: scope) }.map(\.key))).sorted())
    })
    let before = try views(of: scopes, in: replica)
    let written: [(entry: OutboxEntry, scope: ScopeRef, delta: Delta)] = entries.flatMap { (entry: OutboxEntry) in
      entry.effects().flatMap { (effect: ScopedDeltas) in effect.deltas.map { (entry, effect.scope, $0) } }
    }
    _ = try hold.undo(act.actId, in: &replica)
    let after = try views(of: scopes, in: replica)
    let changed = scopes.contains { scope in keys[scope]!.contains { before[scope]!.record($0) != after[scope]!.record($0) } }
    let inverseActId = try identities.gestureID()
    let requestId = try identities.gestureID()
    let units = cancellationUnits(written, before: before, after: after, in: replica)
    replica.updateJournal { journal in
      journal.acts.removeAll { $0.actId.isSameID(as: act.actId) }
      journal.cancellations.append(CancellationReceipt(inverseActId: inverseActId, cancelledActId: act.actId, units: units))
      journal.inverses.append(InverseRequest(
        requestId: requestId, sourceActId: act.actId, inverseActId: inverseActId, state: .settled, localChanged: nil, slots: [],
        result: .cancelled(requestId: requestId, inverseActId: inverseActId, changed: changed)))
    }
    return read(requestId, in: replica)
  }

  func views(of scopes: [ScopeRef], in replica: LoadedReplica) throws -> [ScopeRef: ScopeView] {
    var views: [ScopeRef: ScopeView] = [:]
    for scope in scopes { views[scope] = try ScopeView(replica, scope, .drawn, registry: registry) }
    return views
  }

  // The changes a cancellation actually took out of `drawn`, each with what restoring it must find: a register the
  // cancelled act wrote that now reads otherwise, at the version it now reads (a pending entry's, accepted, or absent in
  // the record's birth), and a record it created that is now absent, with the act's own creation values. A later local
  // edit that masks the act's write took nothing out, and is no unit.
  func cancellationUnits(_ written: [(entry: OutboxEntry, scope: ScopeRef, delta: Delta)], before: [ScopeRef: ScopeView],
                         after: [ScopeRef: ScopeView], in replica: LoadedReplica) -> [CancellationUnit] {
    var order: [JSON] = []
    var units: [JSON: CancellationUnit] = [:]
    let put = { (key: JSON, unit: CancellationUnit) -> Void in
      if units[key] == nil { order.append(key) }
      units[key] = unit
    }
    for (entry, scope, delta) in written {
      guard let type = registry.type(delta.key.type) else { continue }
      let was = before[scope]!.record(delta.key)
      let now = after[scope]!.record(delta.key)
      let record = RecordAddress(scope: scope, key: delta.key)
      guard let now else {
        guard let was, registry.creatableFault(type) == nil else { continue }
        let key: JSON = ["record", record.json]
        var values = JSON.Object()
        var created: JSON.Object = [:]
        if case .createdRecord(_, _, let existing, _)? = units[key] { values = existing }
        if case .object(let fields)? = values["f"] { created = fields }
        for name in delta.lattice.fields.keys.sorted() where type.field(name)?.writer == .client { created[name] = was.lattice.fields[name]?.value }
        if !created.isEmpty { values["f"] = .object(created) }
        var texts: JSON.Object = [:]
        if case .object(let existing)? = values["x"] { texts = existing }
        for name in delta.texts.keys.sorted() where type.field(name)?.writer == .client { texts[name] = was.texts[name].map(JSON.string) }
        if !texts.isEmpty { values["x"] = .object(texts) }
        let owner = units[key]?.ownerLocalId ?? entry.localId
        put(key, .createdRecord(ownerLocalId: owner, record: record, redoValues: values, restored: .recordAbsent(epoch: replica.meta.serverEpoch)))
        continue
      }
      let slots: [EffectSlot.Slot] = (delta.lattice.life == nil ? [] : [.life]) + delta.lattice.fields.keys.sorted().map(EffectSlot.Slot.field)
        + delta.texts.keys.sorted().map(EffectSlot.Slot.text)
      for slot in slots {
        guard registry.restorableFault(type, slot) == nil, (was?.value(of: slot) ?? .null) != (now.value(of: slot) ?? .null) else { continue }
        let target = Target(record, slot)
        put(["field", target.json], .field(ownerLocalId: entry.localId, target: target, redoValue: was?.value(of: slot),
                                           restored: reference(of: target, now: now, in: replica)))
      }
    }
    return order.map { units[$0]! }
  }

  // Where the value a target reads now comes from: a pending entry that wrote it, the confirmed row's accepted version, or,
  // unset, the record's birth.
  func reference(of target: Target, now: ViewRecord, in replica: LoadedReplica) -> VersionReference {
    let epoch = replica.meta.serverEpoch
    let pending = { (slot: EffectSlot.Slot) -> VersionReference? in
      let writer = replica.outbox.reversed().first { entry in
        entry.effects(active: true).contains { effect in
          effect.scope == target.scope && effect.deltas.contains { $0.key == target.key && Inverses.writes($0, slot, now) }
        }
      }
      return writer.map { VersionReference.pending(localId: $0.localId, target: Target(target.address, slot)) }
    }
    let confirmed = replica.rows(target.scope).row(target.key)
    let accepted = { (slot: EffectSlot.Slot) -> VersionReference? in
      confirmed?.version(of: slot).map { VersionReference.accepted(epoch: epoch, version: $0) }
    }
    if let current = pending(target.slot) ?? accepted(target.slot) { return current }
    let birth = registry.type(target.key.type)?.hasBorn == true ? pending(.born) ?? accepted(.born) : nil
    return .fieldAbsent(epoch: epoch, recordBirth: birth)
  }

  // Whether a delta writes the slot as `now` reads it: the register at the stamp `now` holds, or the text.
  static func writes(_ delta: Delta, _ slot: EffectSlot.Slot, _ now: ViewRecord) -> Bool {
    switch slot {
    case .born: delta.lattice.born != nil && delta.lattice.born == now.lattice.born && delta.lattice.life?.stamp == delta.lattice.born
    case .life: delta.lattice.life != nil && delta.lattice.life == now.lattice.life
    case .field(let name): delta.lattice.fields[name] != nil && delta.lattice.fields[name] == now.lattice.fields[name]
    case .text(let name): delta.texts[name] != nil
    }
  }

  // MARK: Planning slots

  // An Undo's slots from the act's own recipes: one restore slot a source for its generic recipes, a target restored once
  // from its first preimage, and one slot each product command recipe. Undo runs the act backwards: the last source's slots
  // come first.
  func plannedSlots(of act: ReversibleAct, replacing replacement: [ActUndo.Segment]?) -> [(scope: ScopeRef, recipe: SlotRecipe)] {
    let sources: [JournalSource] = act.sourceEntries.map { (source: JournalSource) -> JournalSource in
      guard let replacement else { return source }
      var replaced = source
      replaced.recipes = replacement.first { $0.index == Inverses.ordinal(of: source.localId) }?.recipes ?? []
      return replaced
    }
    var firstOf: [Target: JSON] = [:]
    for preimage in sources.flatMap(\.preimages) where firstOf[preimage.target] == nil { firstOf[preimage.target] = preimage.value }
    var named: Set<JSON> = []
    var slots: [(scope: ScopeRef, recipe: SlotRecipe)] = []
    for source in sources.reversed() {
      var operations: [PlannedOperation] = []
      var command: String?
      for recipe in source.recipes {
        switch recipe {
        case .command(let name, let input, let evidence): slots.append((source.originScope, .command(name, input: input, evidence: evidence)))
        case .createdRecord(let restore, let record):
          command = restore
          operations.append(.createdRecord(record))
        case .fields(let restore, let targets):
          command = restore
          operations += targets.map { (item: RestoreTarget) -> PlannedOperation in .field(item.target, before: firstOf[item.target], reference: nil) }
        }
      }
      let unique = operations.filter { (operation: PlannedOperation) -> Bool in
        let key: JSON = switch operation {
        case .field(let target, _, _): target.json
        case .createdRecord, .createRecord: operation.address.json
        }
        return named.insert(key).inserted
      }
      if let command, !unique.isEmpty { slots.append((source.originScope, .restore(command: command, operations: unique))) }
    }
    return slots
  }

  // A Redo of a cancellation reserves ordinary restore slots, one a scope, in the order the cancelled act wrote: each field
  // back to the value the act wrote, under the version reference it now reads, and each created record created again only
  // where it is still wholly absent.
  func redoSlots(of cancellation: CancellationReceipt) -> [(scope: ScopeRef, recipe: SlotRecipe)] {
    var order: [ScopeRef] = []
    var commands: [ScopeRef: String] = [:]
    var operations: [ScopeRef: [PlannedOperation]] = [:]
    let units = cancellation.units.enumerated().sorted { (a, b) in
      let (first, second) = (Inverses.ordinal(of: a.element.ownerLocalId), Inverses.ordinal(of: b.element.ownerLocalId))
      return first != second ? first < second : a.offset < b.offset
    }.map(\.element)
    for unit in units {
      let (scope, type): (ScopeRef, String) = switch unit {
      case .field(_, let target, _, _): (target.scope, target.key.type)
      case .createdRecord(_, let record, _, _): (record.scope, record.key.type)
      }
      let kind = registry.scopeKind(of: scope)
      guard let command = registry.commands.first(where: { $0.engine == .restore && $0.scope == kind }),
            command.predicts.contains(where: { $0.isSameID(as: type) }) else { continue }
      if commands[scope] == nil {
        order.append(scope)
        commands[scope] = command.name
      }
      switch unit {
      case .field(_, let target, let value, let restored): operations[scope, default: []].append(.field(target, before: value, reference: restored))
      case .createdRecord(_, let record, let values, let restored):
        operations[scope, default: []].append(.createRecord(record, values: values, reference: restored))
      }
    }
    return order.map { (scope: ScopeRef) -> (scope: ScopeRef, recipe: SlotRecipe) in
      (scope, .restore(command: commands[scope]!, operations: operations[scope] ?? []))
    }
  }

  // The local id's ordinal: its position in its act's commit order.
  static func ordinal(of localId: String) -> Int {
    Int(localId[localId.index(after: localId.lastIndex(of: "/") ?? localId.startIndex)...]) ?? 0
  }

  // The optimistic projection of a restore slot over `view`, at `stamp`: each operation as the restore would write it, one
  // delta a record. An operation whose record the view lacks projects nothing.
  func projection(of operations: [PlannedOperation], over view: ScopeView, at stamp: Stamp) -> [Delta] {
    var order: [RecordKey] = []
    var deltas: [RecordKey: Delta] = [:]
    for operation in operations {
      let key = operation.address.key
      guard let type = registry.type(key.type) else { continue }
      if case .createRecord(_, let values, _) = operation {
        guard view.record(key) == nil else { continue }
        var created = Delta(key: key, lattice: Lattice(life: Life(.alive, stamp), born: type.hasBorn ? stamp : nil))
        if case .object(let fields)? = values["f"] {
          for (name, value) in fields.members { created.lattice.fields[name] = Register(value, stamp) }
        }
        if case .object(let texts)? = values["x"] {
          for (name, text) in texts.members { created.texts[name] = TextWrite(text: Inverses.string(text), base: .text("")) }
        }
        if deltas[key] == nil { order.append(key) }
        deltas[key] = created
        continue
      }
      guard let current = view.record(key) else { continue }
      var delta = deltas[key] ?? Delta(key: key, lattice: Lattice(born: type.hasBorn ? current.lattice.born : nil))
      switch operation {
      case .createdRecord: delta.lattice.life = Life(.dead, stamp)
      case .field(let target, let before, _):
        switch target.slot {
        case .life: delta.lattice.life = Life(before == "alive" ? .alive : .dead, stamp)
        case .field(let name): delta.lattice.fields[name] = Register(before ?? .null, stamp)
        case .text(let name):
          delta.texts[name] = TextWrite(text: Inverses.string(before ?? .null), base: .text(current.texts[name] ?? ""))
        case .born: break
        }
      case .createRecord: break
      }
      if deltas[key] == nil { order.append(key) }
      deltas[key] = delta
    }
    return order.map { deltas[$0]! }
  }

  static func string(_ value: JSON) -> String {
    guard case .string(let text) = value else { return "" }
    return text
  }

  // The inverse act's own journal: each restore slot a source whose recipes put back what the inverse replaces, from the
  // values the slot's targets read before it. A created record comes back by its life only where a write can bring it
  // back; a product slot has no generic recipe, and its Redo is the product's.
  func inverseJournal(_ inverseActId: String, slots: [(scope: ScopeRef, slot: InverseSlot)], views: [ScopeRef: ScopeView]) -> ReversibleAct {
    let sources = slots.map { (scope: ScopeRef, slot: InverseSlot) -> JournalSource in
      guard case .restore(let command, let operations) = slot.recipe else {
        return JournalSource(localId: slot.localId, originScope: scope, recipes: [], preimages: [])
      }
      let targets: [Target] = operations.flatMap { (operation: PlannedOperation) -> [Target] in
        switch operation {
        case .field(let target, _, _): return [target]
        case .createRecord: return []
        case .createdRecord(let record):
          guard let type = registry.type(record.key.type), type.identity == .keyed || type.revivable == true else { return [] }
          return [Target(record, .life)]
        }
      }
      let preimages: [Preimage] = targets.compactMap { (target: Target) -> Preimage? in
        views[scope]?.record(target.key)?.value(of: target.slot).map { Preimage(target: target, value: $0) }
      }
      let recreated: [UndoRecipe] = operations.compactMap { (operation: PlannedOperation) -> UndoRecipe? in
        guard case .createRecord(let record, _, _) = operation else { return nil }
        return .createdRecord(restoreCommand: command, record: record)
      }
      let restorable: [RestoreTarget] = preimages.map { RestoreTarget(target: $0.target) }
      let recipes: [UndoRecipe] = (restorable.isEmpty ? [] : [.fields(restoreCommand: command, targets: restorable)]) + recreated
      return JournalSource(localId: slot.localId, originScope: scope, recipes: recipes, preimages: preimages)
    }
    return ReversibleAct(actId: inverseActId, sourceEntries: sources)
  }

  // MARK: Materializing

  // Binds a waiting request's slots once its act's sources are authoritative: each restore operation takes the latest
  // version the act owns, or goes; each product slot its evidence, or goes whole. Settlement only removes operations and
  // projections; a slot left with nothing settles unnumbered.
  func materialize(_ requestId: String, in replica: inout LoadedReplica) throws {
    guard let request = replica.journal.request(requestId), request.state == .waiting else { return }
    let act = replica.journal.act(request.sourceActId)
    if let act, !authoritative(act, in: replica) { return }
    if act == nil, !referencesAuthoritative(request, in: replica) { return }
    let history = act.map { ownedHistory(of: $0, in: replica) } ?? []
    let epoch = replica.meta.serverEpoch
    var slots = request.slots
    var vacated: [String] = []
    var outcomes: [Int: [InverseOutcome]?] = [:]
    for index in slots.indices {
      guard let entry = replica.named(slots[index].localId) else {
        outcomes[index] = .some(nil)
        continue
      }
      var args: JSON?
      switch slots[index].recipe {
      case .restore(let command, let operations):
        guard let epoch else { break }
        let bound: [(operation: PlannedOperation, wire: RestoreOperation)] = operations.compactMap { (operation: PlannedOperation) in
          bind(operation, history: history, epoch: epoch, in: replica).map { (operation, $0) }
        }
        slots[index].recipe = .restore(command: command, operations: bound.map(\.operation))
        if !bound.isEmpty { args = RestoreArguments(expectedEpoch: epoch, operations: bound.map(\.wire)).json }
      case .command(_, let input, let selection):
        guard let epoch else { break }
        let records = selection.unchangedCreatedRecords.map { (record: RecordAddress) -> Evidence.CreatedRecord? in
          Inverses.footprint(history, record).map { Evidence.CreatedRecord(record: record, rowSeq: $0.rowSeq, footprint: $0.footprint) }
        }
        let scopes = selection.unchangedCreatedScopes.map { Inverses.createdScope(history, $0) }
        guard records.allSatisfy({ $0 != nil }), scopes.allSatisfy({ $0 != nil }) else { break }
        let owned = selection.ownedFields.compactMap { (target: Target) -> Evidence.OwnedField? in
          Inverses.latestOwned(history, target).map { Evidence.OwnedField(target: target, version: $0) }
        }
        let evidence = Evidence(expectedEpoch: epoch, ownedFields: owned, unchangedCreatedRecords: records.compactMap { $0 },
                                unchangedCreatedScopes: scopes.compactMap { $0 })
        args = ["input": input, "evidence": evidence.json]
      case .withdrawn: break
      }
      guard let args else {
        if case .restore(let command, _) = slots[index].recipe { slots[index].recipe = .restore(command: command, operations: []) }
        vacated.append(entry.localId)
        outcomes[index] = .some([])
        continue
      }
      let recipe = slots[index].recipe
      replica.update(entry: entry.localId) { stored in
        if case .restore(_, let operations) = recipe { Inverses.keep(operations, in: &stored) }
        stored.intent.command = Command(name: recipe.command, args: args)
      }
      slots[index].state = .materialized
    }
    for localId in vacated { try replica.move(localId, .vacate) }
    replica.updateJournal { journal in
      guard let position = journal.inverses.firstIndex(where: { $0.requestId.isSameID(as: requestId) }) else { return }
      journal.inverses[position].slots = slots
      for (index, outcome) in outcomes.sorted(by: { $0.key < $1.key }) {
        journal.inverses[position].settle(slot: index, outcomes: outcome, code: "refused")
      }
      journal.inverses[position].state = .materialized
      journal.settle(request: position)
    }
  }

  // Whether every source of an act has its authoritative outcome: an entry still queued, sent or held, or acknowledged in
  // another epoch, has none yet.
  func authoritative(_ act: ReversibleAct, in replica: LoadedReplica) -> Bool {
    act.sourceEntries.allSatisfy { source in
      guard let entry = replica.named(source.localId) else { return true }
      return entry.state == .acked && source.accepted(in: replica.meta.serverEpoch) != nil
    }
  }

  // A Redo of a cancellation waits while an entry its references name has no authoritative outcome.
  func referencesAuthoritative(_ request: InverseRequest, in replica: LoadedReplica) -> Bool {
    let pending = request.slots.filter { $0.state == .waiting }.flatMap(\.recipe.pendingLocalIds)
    return pending.allSatisfy { localId in
      guard let entry = replica.named(localId) else { return true }
      return entry.state == .acked && entry.resultEpoch?.isSameID(as: replica.meta.serverEpoch) == true
    }
  }

  // The accepted receipts the act's sources own in the current epoch, in commit order; a source whose history another
  // epoch took is lost.
  func ownedHistory(of act: ReversibleAct, in replica: LoadedReplica) -> [(lost: Bool, effects: [EffectReceipt])] {
    act.sourceEntries.sorted { Inverses.ordinal(of: $0.localId) < Inverses.ordinal(of: $1.localId) }.map { source in
      (source.unavailable, source.accepted(in: replica.meta.serverEpoch) ?? [])
    }
  }

  static func rows(_ effects: [EffectReceipt], _ address: RecordAddress) -> [EffectRow] {
    effects.filter { $0.scope == address.scope }.flatMap(\.rows).filter { $0.key == address.key }
  }

  // The latest accepted version the act owns of a target, or nil.
  static func latestOwned(_ history: [(lost: Bool, effects: [EffectReceipt])], _ target: Target) -> EffectSlot.Version? {
    var version: EffectSlot.Version?
    for (_, effects) in history {
      for row in rows(effects, target.address) {
        if let found = row.slots.first(where: { $0.slot == target.slot }) { version = found.version }
      }
    }
    return version
  }

  // A record the act created, proven unchanged by its own receipts alone: its creation's complete footprint and each
  // later own write continuing the row sequence. A gap, or history another epoch took, proves nothing.
  static func footprint(_ history: [(lost: Bool, effects: [EffectReceipt])], _ record: RecordAddress) -> (rowSeq: Int64, footprint: [EffectSlot])? {
    guard !history.contains(where: \.lost) else { return nil }
    let rows = history.flatMap { Inverses.rows($0.effects, record) }
    guard let first = rows.first, first.beforeRowSeq == nil else { return nil }
    var slots: [EffectSlot.Slot: EffectSlot] = [:]
    var previous: Int64?
    for row in rows {
      if let previous, row.beforeRowSeq != previous { return nil }
      for slot in row.slots { slots[slot.slot] = slot }
      previous = row.rowSeq
    }
    return (previous!, slots.values.sorted { EffectSlot.Slot.precedes($0.slot, $1.slot) })
  }

  // A scope the act created, proven unchanged by its own receipts: created, then each next receipt of it starting where
  // the last ended.
  static func createdScope(_ history: [(lost: Bool, effects: [EffectReceipt])], _ scope: ScopeRef) -> Evidence.CreatedScope? {
    guard !history.contains(where: \.lost) else { return nil }
    let effects = history.flatMap(\.effects).filter { $0.scope == scope }
    guard let first = effects.first, first.beforeSeq == nil, var seq = first.seq else { return nil }
    for effect in effects.dropFirst() {
      guard effect.beforeSeq == seq, let next = effect.seq else { return nil }
      seq = next
    }
    return Evidence.CreatedScope(scope: scope, seq: seq)
  }

  // One planned operation bound to what it must find, or nil when nothing proves it.
  func bind(_ operation: PlannedOperation, history: [(lost: Bool, effects: [EffectReceipt])], epoch: String,
            in replica: LoadedReplica) -> RestoreOperation? {
    switch operation {
    case .field(let target, let before, let reference):
      let expected: RestoreOperation.Expected? = reference.map { expected(of: $0, in: replica) }
        ?? Inverses.latestOwned(history, target).map(RestoreOperation.Expected.version)
      return expected.map { .field(target.key, slot: target.slot, expected: $0, before: before ?? .null) }
    case .createdRecord(let record):
      return Inverses.footprint(history, record).map { .createdRecord(record.key, rowSeq: $0.rowSeq, footprint: $0.footprint) }
    case .createRecord(let record, let values, let reference):
      guard case .recordAbsent(let held) = reference, (held ?? epoch).isSameID(as: epoch) else { return nil }
      return .createRecord(record.key, values: values)
    }
  }

  // The version a reference binds to now, or nil: an accepted version of this epoch, the version a pending entry's receipt
  // accepted, or an absence in the incarnation its birth names.
  func expected(of reference: VersionReference, in replica: LoadedReplica) -> RestoreOperation.Expected? {
    let epoch = replica.meta.serverEpoch
    switch reference {
    case .accepted(let held, let version):
      return (held ?? epoch)?.isSameID(as: epoch) == true ? .version(version) : nil
    case .pending(let localId, let target):
      let effects: [EffectReceipt]? = replica.named(localId).map { $0.acceptedEffects ?? [] }
        ?? replica.journal.source(of: localId).flatMap { replica.journal.acts[$0.act].sourceEntries[$0.source].accepted(in: epoch) }
      let row = Inverses.rows(effects ?? [], target.address).last
      return row?.slots.first { $0.slot == target.slot }.map { .version($0.version) }
    case .fieldAbsent(let held, let birth):
      guard (held ?? epoch)?.isSameID(as: epoch) == true else { return nil }
      guard let birth else { return .absent(born: nil) }
      guard case .version(.stamp(let born))? = expected(of: birth, in: replica) else { return nil }
      return .absent(born: born)
    case .recordAbsent: return nil
    }
  }

  // The projection of the operations a slot still holds, the rest withdrawn.
  static func keep(_ operations: [PlannedOperation], in entry: inout OutboxEntry) {
    guard var predictions = entry.predictions else { return }
    for index in predictions.indices {
      let scope = predictions[index].scope
      predictions[index].deltas = predictions[index].deltas.compactMap { (delta: Delta) -> Delta? in
        let kept = operations.filter { $0.address == RecordAddress(scope: scope, key: delta.key) }
        if kept.isEmpty { return nil }
        if kept.contains(where: { if case .createRecord = $0 { true } else { false } }) { return delta }
        var next = Delta(key: delta.key, lattice: Lattice(born: delta.lattice.born))
        for operation in kept {
          switch operation {
          case .createdRecord: next.lattice.life = delta.lattice.life
          case .field(let target, _, _):
            switch target.slot {
            case .life: next.lattice.life = delta.lattice.life
            case .field(let name): next.lattice.fields[name] = delta.lattice.fields[name]
            case .text(let name): next.texts[name] = delta.texts[name]
            case .born: break
            }
          case .createRecord: break
          }
        }
        return next
      }
    }
    entry.predictions = predictions
  }

  // MARK: The sender

  // §7.4's barrier: an inverse slot not yet materialized is materialized now if it can be; one that still waits stops
  // numbering. Whether the entry may be numbered.
  func passesBarrier(_ entry: OutboxEntry, in replica: inout LoadedReplica) throws -> Bool {
    guard let requestId = entry.inverseOf, let request = replica.journal.request(requestId),
          let slot = request.slots.first(where: { $0.localId.isSameID(as: entry.localId) }), slot.state == .waiting else { return true }
    try materialize(requestId, in: &replica)
    return replica.journal.request(requestId)?.slots.first { $0.localId.isSameID(as: entry.localId) }?.state != .waiting
  }

  // An inverse entry's outcomes, checked before the answer changes anything.
  func check(_ result: PushResult, of entry: OutboxEntry, in replica: LoadedReplica) throws {
    guard case .ok = result.verdict, let (request, index) = slot(of: entry, in: replica) else { return }
    _ = try InverseOutcome.reported(in: result.detail?["command"], count: replica.journal.inverses[request].slots[index].recipe.count)
  }

  // An inverse entry's result, in its ACK or refusal transaction: its outcomes settle the slot, a skipped operation's
  // projection is withdrawn, and the request settles with its last slot.
  func settle(_ entry: OutboxEntry, by result: PushResult, in replica: inout LoadedReplica) throws {
    guard let (request, index) = slot(of: entry, in: replica) else { return }
    var slot = replica.journal.inverses[request].slots[index]
    guard slot.state != .settled else { return }
    switch result.verdict {
    case .ok:
      let outcomes = try InverseOutcome.reported(in: result.detail?["command"], count: slot.recipe.count)
      if case .restore(_, let operations) = slot.recipe {
        let applied = zip(operations, outcomes).filter { $0.1.applied }.map(\.0)
        replica.update(entry: entry.localId) { Inverses.keep(applied, in: &$0) }
      }
      slot.changed = (replica.entry(entry.localId)?.acceptedEffects ?? []).contains { !$0.rows.isEmpty }
      replica.updateJournal { journal in
        journal.inverses[request].slots[index].changed = slot.changed
        journal.inverses[request].settle(slot: index, outcomes: outcomes, code: "")
        journal.settle(request: request)
      }
    case .refused(let code):
      guard replica.entry(entry.localId) == nil else { return }
      replica.updateJournal { journal in
        journal.inverses[request].settle(slot: index, outcomes: nil, code: code.text)
        journal.settle(request: request)
      }
    }
  }

  // The slot an inverse entry reserved, with its request's index.
  func slot(of entry: OutboxEntry, in replica: LoadedReplica) -> (request: Int, slot: Int)? {
    guard let requestId = entry.inverseOf,
          let request = replica.journal.inverses.firstIndex(where: { $0.requestId.isSameID(as: requestId) }),
          let slot = replica.journal.inverses[request].slots.firstIndex(where: { $0.localId.isSameID(as: entry.localId) }) else { return nil }
    return (request, slot)
  }
}

extension SlotRecipe {
  // A restore slot's operations, nil for any other recipe.
  var restoring: [PlannedOperation]? {
    guard case .restore(_, let operations) = self else { return nil }
    return operations
  }
}
