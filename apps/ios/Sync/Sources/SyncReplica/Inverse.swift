import SyncAPI
import SyncCore

// K-3 Undo and Redo of an act (engine.md §7.3 Undo of an act). A wholly held act is cancelled in place, keeping the
// receipt of what disappeared for its Redo. Otherwise an inverse request reserves its slots in the outbox at once, each an
// ordinary entry at the end of commit order that carries its optimistic projection and stops the sender until it is
// materialized; once every source of the act is authoritative, the slots bind the latest versions the act owns and its
// first preimages into restore or inverse commands, in one transaction, and a slot left with nothing settles unnumbered.
// An Undo never erases a write the device had not seen when it acted. The inverse act journals the values the act wrote,
// so a Redo writes back exactly those, and only where its Undo applied.

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
  // stored recipes (a product's Redo). A cancelled product command has no generic Redo: its Redo needs the product's
  // replacement.
  public func request(_ sourceActId: String, replacing replacement: [ActUndo.Segment]? = nil, in replica: inout LoadedReplica,
                      as instance: Instance, identities: IdentitySource) throws -> InverseResult {
    if let existing = replica.journal.inverses.first(where: { $0.sourceActId.isSameID(as: sourceActId) }) { return existing.current }
    let act = replica.journal.act(sourceActId)
    let cancellation = replica.journal.cancellations.first { $0.inverseActId.isSameID(as: sourceActId) }
    let entries = replica.outbox.filter { $0.gestureId.isSameID(as: sourceActId) }
    if let act, !entries.isEmpty, entries.allSatisfy({ $0.state == .held }) {
      return try cancelHeld(act, entries: entries, in: &replica, at: instance.deviceNow, identities: identities)
    }
    let forward: [Target: JSON]
    let planned: [(scope: ScopeRef, recipe: SlotRecipe)]
    switch (act, cancellation, replacement) {
    case (let act?, _, _):
      forward = Inverses.forward(of: act)
      planned = plannedSlots(of: try sources(act.sourceEntries, replacing: replacement))
    case (nil, let cancellation?, let replacement?):
      let cancelled = cancellation.sourceEntries.map { (source: CancellationReceipt.Source) -> JournalSource in
        JournalSource(localId: source.localId, originScope: source.originScope, recipes: [], preimages: [])
      }
      forward = Inverses.forward(of: cancellation)
      planned = plannedSlots(of: try sources(cancelled, replacing: replacement))
    case (nil, let cancellation?, nil):
      guard !cancellation.sourceEntries.contains(where: \.command) else { return .unavailable(requestId: nil, reason: "product-redo-required") }
      forward = Inverses.forward(of: cancellation)
      planned = redoSlots(of: cancellation)
    case (nil, nil, _):
      return .unavailable(requestId: nil, reason: "not-reversible")
    }
    let inverseActId = try identities.gestureID()
    let requestId = try identities.gestureID()
    let physNow = replica.meta.physNow(deviceNow: instance.deviceNow)
    var clock = replica.meta.hlc
    clock.observe(replica.meta.hlcHigh)
    let stamp = clock.tick(physNow: physNow, actor: instance.actor)
    let firstOrder = replica.nextCommitOrder
    let slots: [InverseSlot] = planned.enumerated().map { (k: Int, planned: (scope: ScopeRef, recipe: SlotRecipe)) -> InverseSlot in
      InverseSlot(localId: "\(inverseActId)/\(k)", commitOrder: firstOrder + Int64(k), originScope: planned.scope, recipe: planned.recipe)
    }
    var before: [ScopeRef: ScopeView] = [:]
    for slot in slots where before[slot.originScope] == nil {
      before[slot.originScope] = try ScopeView(replica, slot.originScope, .drawn, registry: registry)
    }
    let journal = inverseJournal(inverseActId, slots: slots, forward: forward, drawn: before)
    var touched: [ScopedKey] = []
    for slot in slots {
      let scope = slot.originScope
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
                                            requestedAt: instance.deviceNow, localChanged: localChanged, slots: slots))
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

  // The rows a request reads: the records its act's recipes and preimages name, or its cancellation's units, in every
  // scope its sources wrote, and every record an entry of the scopes it reaches touches, which a cancellation compares
  // before and after.
  public func reads(of sourceActId: String, in replica: LoadedReplica) -> [ScopeRef: RowSelection] {
    var reads: [ScopeRef: RowSelection] = [:]
    let add = { (address: RecordAddress) -> Void in reads[address.scope, default: RowSelection()].keys.insert(address.key) }
    for source in replica.journal.act(sourceActId)?.sourceEntries ?? [] {
      reads[source.originScope] = reads[source.originScope] ?? RowSelection()
      for recipe in source.recipes {
        switch recipe {
        case .fields(_, let targets): targets.forEach { add($0.target.address) }
        case .createdRecord(_, let record): add(record)
        case .command: break
        }
      }
    }
    if let cancellation = replica.journal.cancellations.first(where: { $0.inverseActId.isSameID(as: sourceActId) }) {
      for source in cancellation.sourceEntries { reads[source.originScope] = reads[source.originScope] ?? RowSelection() }
      for unit in cancellation.units { add(unit.address) }
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
  // actually disappeared of its ordinary writes for its Redo, and which of its entries were product commands.
  func cancelHeld(_ act: ReversibleAct, entries: [OutboxEntry], in replica: inout LoadedReplica, at deviceNow: Int64,
                  identities: IdentitySource) throws -> InverseResult {
    var scopes: [ScopeRef] = []
    for scope in entries.flatMap(\.scopes) where !scopes.contains(scope) { scopes.append(scope) }
    let keys = Dictionary(uniqueKeysWithValues: scopes.map { (scope: ScopeRef) -> (ScopeRef, [RecordKey]) in
      (scope, Array(Set(replica.outbox.flatMap { $0.deltas(in: scope) }.map(\.key))).sorted())
    })
    let before = try views(of: scopes, in: replica)
    let ordinary = { (entry: OutboxEntry) -> Bool in registry.ownCommand(of: entry) == nil }
    let written: [(entry: OutboxEntry, scope: ScopeRef, delta: Delta)] = entries.filter(ordinary).flatMap { (entry: OutboxEntry) in
      entry.intent.deltas.map { (entry, entry.scope, $0) }
    }
    let sources = entries.map { (entry: OutboxEntry) -> CancellationReceipt.Source in
      CancellationReceipt.Source(localId: entry.localId, originScope: entry.scope, command: !ordinary(entry))
    }
    _ = try hold.undo(act.actId, in: &replica)
    let after = try views(of: scopes, in: replica)
    let changed = scopes.contains { scope in keys[scope]!.contains { before[scope]!.record($0) != after[scope]!.record($0) } }
    let inverseActId = try identities.gestureID()
    let requestId = try identities.gestureID()
    let units = cancellationUnits(written, before: before, after: after, in: replica)
    replica.updateJournal { journal in
      journal.acts.removeAll { $0.actId.isSameID(as: act.actId) }
      journal.cancellations.append(CancellationReceipt(inverseActId: inverseActId, cancelledActId: act.actId, sourceEntries: sources, units: units))
      journal.inverses.append(InverseRequest(
        requestId: requestId, sourceActId: act.actId, inverseActId: inverseActId, state: .settled, requestedAt: deviceNow, localChanged: nil,
        slots: [], result: .cancelled(requestId: requestId, inverseActId: inverseActId, changed: changed)))
    }
    return read(requestId, in: replica)
  }

  func views(of scopes: [ScopeRef], in replica: LoadedReplica) throws -> [ScopeRef: ScopeView] {
    var views: [ScopeRef: ScopeView] = [:]
    for scope in scopes { views[scope] = try ScopeView(replica, scope, .drawn, registry: registry) }
    return views
  }

  // The changes a cancellation actually took out of `drawn`, from the act's ordinary deltas (a product command's effects are
  // its own, never generic), each with what restoring it must find: a register the act wrote that now reads otherwise, at
  // the version it now reads (accepted, a pending entry's, or absent in the record's birth) with the value it now reads,
  // and a record it created that is now absent, with the act's own creation values. A later local edit that masks the
  // act's write took nothing out, and is no unit.
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
        guard was != nil, registry.creatableFault(type) == nil else { continue }
        let key: JSON = ["record", record.json]
        var values = JSON.Object()
        var created: JSON.Object = [:]
        if case .createdRecord(_, _, let existing, _)? = units[key] { values = existing }
        if case .object(let fields)? = values["f"] { created = fields }
        for (name, register) in delta.lattice.fields where type.field(name)?.writer == .client { created[name] = register.value }
        if !created.isEmpty { values["f"] = .object(created) }
        var texts: JSON.Object = [:]
        if case .object(let existing)? = values["x"] { texts = existing }
        for (name, write) in delta.texts where type.field(name)?.writer == .client { texts[name] = .string(write.text) }
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
                                           restored: reference(of: target, now: now, in: replica), restoredValue: now.value(of: slot)))
      }
    }
    return order.map { units[$0]! }
  }

  // Where the value a target reads now comes from: an entry that wrote it (pending until its ACK, then the version it
  // wrote), the confirmed row's accepted version, or, unset, the record's birth.
  func reference(of target: Target, now: ViewRecord, in replica: LoadedReplica) -> VersionReference {
    let epoch = replica.meta.serverEpoch
    let pending = { (slot: EffectSlot.Slot) -> VersionReference? in
      let writer = replica.outbox.reversed().first { entry in
        entry.effects(active: true).contains { effect in
          effect.scope == target.scope && effect.deltas.contains { $0.key == target.key && Inverses.writes($0, slot, now) }
        }
      }
      guard let writer else { return nil }
      let written = Target(target.address, slot)
      return writer.state == .acked ? Inverses.version(of: written, writtenBy: writer, epoch: writer.resultEpoch)
        : VersionReference.pending(localId: writer.localId, target: written)
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

  // The stored recipes, or a complete replacement by source ordinal, each checked against its source's scope; a
  // replacement's field target needs a first preimage the act journaled, so a cancellation's has none.
  func sources(_ sources: [JournalSource], replacing replacement: [ActUndo.Segment]?) throws -> [JournalSource] {
    guard let replacement else { return sources }
    let ordinals = sources.map { Inverses.ordinal(of: $0.localId) }
    guard replacement.allSatisfy({ ordinals.contains($0.index) }), Set(replacement.map(\.index)).count == replacement.count else {
      throw CommitFailure.malformed("inverse slots name sources by ordinal, once each")
    }
    return try sources.map { (source: JournalSource) throws -> JournalSource in
      var replaced = source
      replaced.recipes = replacement.first { $0.index == Inverses.ordinal(of: source.localId) }?.recipes ?? []
      for recipe in replaced.recipes {
        var fault = registry.recipeFault(recipe, in: source.originScope)
        if fault == nil, case .fields(_, let targets) = recipe,
           targets.contains(where: { (item: RestoreTarget) -> Bool in !source.preimages.contains { $0.target == item.target } }) {
          fault = "an inverse slot restores only a target its act journaled"
        }
        if let fault { throw CommitFailure.malformed("an inverse slot recipe is malformed: \(fault)") }
      }
      return replaced
    }
  }

  // The value an act left in each target, its last source's.
  static func forward(of act: ReversibleAct) -> [Target: JSON] {
    var forward: [Target: JSON] = [:]
    for source in act.sourceEntries.sorted(by: { Inverses.ordinal(of: $0.localId) < Inverses.ordinal(of: $1.localId) }) {
      for written in source.written { forward[written.target] = written.value }
    }
    return forward
  }

  // The value each target showed once a cancellation took the act out, which an Undo of its Redo puts back.
  static func forward(of cancellation: CancellationReceipt) -> [Target: JSON] {
    var forward: [Target: JSON] = [:]
    for case .field(_, let target, _, _, let restoredValue?) in cancellation.units { forward[target] = restoredValue }
    return forward
  }

  // An Undo's slots from the act's own recipes: one restore slot a source for its generic recipes, a target restored once
  // from its first preimage, a revived life with the record that preimage read, and one slot each product command recipe.
  // Undo runs the act backwards: the last source's slots come first.
  func plannedSlots(of sources: [JournalSource]) -> [(scope: ScopeRef, recipe: SlotRecipe)] {
    var firstOf: [Target: Preimage] = [:]
    for preimage in sources.flatMap(\.preimages) where firstOf[preimage.target] == nil { firstOf[preimage.target] = preimage }
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
          operations += targets.map { (item: RestoreTarget) -> PlannedOperation in
            .field(item.target, before: firstOf[item.target]?.value, reference: nil, record: firstOf[item.target]?.record)
          }
        }
      }
      let unique = operations.filter { (operation: PlannedOperation) -> Bool in
        let key: JSON = switch operation {
        case .field(let target, _, _, _): target.json
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
      let scope = unit.address.scope
      let kind = registry.scopeKind(of: scope)
      guard let command = registry.commands.first(where: { $0.engine == .restore && $0.scope == kind }),
            command.predicts.contains(where: { $0.isSameID(as: unit.address.key.type) }) else { continue }
      if commands[scope] == nil {
        order.append(scope)
        commands[scope] = command.name
      }
      switch unit {
      case .field(_, let target, let value, let restored, _):
        operations[scope, default: []].append(.field(target, before: value, reference: restored, record: nil))
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
  // delta a record. A record the view lacks is drawn only where a life operation revives it, with the values its preimage
  // read; any other operation on it projects nothing.
  func projection(of operations: [PlannedOperation], over view: ScopeView, at stamp: Stamp) -> [Delta] {
    var revived: [RecordKey: ViewRecord] = [:]
    for case .field(let target, _, _, let record?) in operations where target.slot == .life {
      revived[target.key] = ViewRecord(key: target.key, lattice: Lattice(born: record.born, fields: record.fields), texts: record.texts)
    }
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
      let absent = view.record(key) == nil
      guard let current = view.record(key) ?? revived[key] else { continue }
      var delta = deltas[key] ?? Delta(key: key, lattice: Lattice(born: type.hasBorn ? current.lattice.born : nil))
      if deltas[key] == nil, absent {
        delta.lattice.fields = current.lattice.fields
        delta.texts = current.texts.mapValues { (text: String) -> TextWrite in TextWrite(text: text, base: .text("")) }
      }
      switch operation {
      case .createdRecord: delta.lattice.life = Life(.dead, stamp)
      case .field(let target, let before, _, _):
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
  // values the inverted act wrote (`forward`), never what a later local edit shows. A life the slot takes away, a created
  // record's among them, comes back only where a write can bring it back, with the record as `drawn` held it, and a record
  // the inverse creates goes again by its strict recipe; a product slot has no generic recipe, and its Redo is the product's.
  // A preimage's row sequence is the row its restore wrote over, which the restore's version check proved held it (`anchor`).
  func inverseJournal(_ inverseActId: String, slots: [InverseSlot], forward: [Target: JSON], drawn: [ScopeRef: ScopeView]) -> ReversibleAct {
    let sources = slots.map { (slot: InverseSlot) -> JournalSource in
      guard case .restore(let command, let operations) = slot.recipe else {
        return JournalSource(localId: slot.localId, originScope: slot.originScope, recipes: [], preimages: [])
      }
      var preimages: [Preimage] = []
      var written: [WrittenValue] = []
      var recreated: [ActUndoRecipe] = []
      for operation in operations {
        switch operation {
        case .createRecord(let record, _, _):
          recreated.append(.createdRecord(restoreCommand: command, record: record))
        case .createdRecord(let record):
          guard let type = registry.type(record.key.type), type.identity == .keyed || type.revivable == true else { continue }
          let target = Target(record, .life)
          preimages.append(Preimage(target: target, value: "alive", record: drawn[record.scope]?.record(record.key).map(RecordValues.init)))
          written.append(WrittenValue(target: target, value: "dead"))
        case .field(let target, let before, _, _):
          guard let value = forward[target] else { continue }
          let takenAway = target.slot == .life && value == "alive"
          preimages.append(Preimage(target: target, value: value, record: takenAway ? drawn[target.scope]?.record(target.key).map(RecordValues.init) : nil))
          written.append(WrittenValue(target: target, value: before ?? .null))
        }
      }
      let restorable: [RestoreTarget] = preimages.map { RestoreTarget(target: $0.target) }
      let recipes: [ActUndoRecipe] = (restorable.isEmpty ? [] : [.fields(restoreCommand: command, targets: restorable)]) + recreated
      return JournalSource(localId: slot.localId, originScope: slot.originScope, recipes: recipes, preimages: preimages, written: written)
    }
    return ReversibleAct(actId: inverseActId, sourceEntries: sources)
  }

  // MARK: Materializing

  // Binds a waiting request's slots once its sources are authoritative: each restore operation takes the latest version
  // the act owns where nothing the device had not seen came between, or skips, or goes; each product slot its evidence, or
  // skips whole. Settlement only removes operations and projections; a slot left with nothing to send settles unnumbered.
  func materialize(_ requestId: String, in replica: inout LoadedReplica) throws {
    guard let request = replica.journal.request(requestId), request.state == .waiting else { return }
    let act = replica.journal.act(request.sourceActId)
    if let act, !authoritative(act, in: replica) { return }
    if act == nil, !referencesAuthoritative(request, in: replica) { return }
    let source = act ?? ReversibleAct(actId: request.sourceActId, sourceEntries: [])
    let history = ownedHistory(of: source, in: replica)
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
      let recorded = slots[index].skipped ?? []
      slots[index].skipped = recorded
      switch slots[index].recipe {
      case .restore(let command, let operations):
        guard let epoch else { break }
        var sent: [(operation: PlannedOperation, wire: RestoreOperation)] = []
        for operation in operations {
          switch bound(operation, of: source, history: history, epoch: epoch, in: replica) {
          case .send(let wire)?: sent.append((operation, wire))
          case .skip(let code)?: slots[index].skipped?.append(code)
          case nil: break
          }
        }
        slots[index].recipe = .restore(command: command, operations: sent.map(\.operation))
        if !sent.isEmpty { args = RestoreArguments(expectedEpoch: epoch, operations: sent.map(\.wire)).json }
      case .command(_, let input, let selection):
        guard let epoch else { break }
        let records = selection.unchangedCreatedRecords.map { (record: RecordAddress) -> Evidence.CreatedRecord? in
          guard case .proven(let rowSeq, let footprint)? = Inverses.footprint(history, record) else { return nil }
          return Evidence.CreatedRecord(record: record, rowSeq: rowSeq, footprint: footprint)
        }
        let scopes = selection.unchangedCreatedScopes.map { Inverses.createdScope(history, $0) }
        guard records.allSatisfy({ $0 != nil }), scopes.allSatisfy({ $0 != nil }) else {
          slots[index].skipped = recorded + ["history-changed"]
          break
        }
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

  // A Redo of a cancellation waits while the replica holds no epoch, in which a waiting slot's references bind, and while
  // an entry its references name has no result yet.
  func referencesAuthoritative(_ request: InverseRequest, in replica: LoadedReplica) -> Bool {
    let waiting = request.slots.filter { $0.state == .waiting }
    if replica.meta.serverEpoch == nil && !waiting.isEmpty { return false }
    return waiting.flatMap(\.recipe.pendingLocalIds).allSatisfy { replica.named($0) == nil }
  }

  // The accepted receipts the act's sources own in the current epoch, in commit order; a source whose history is
  // unavailable is lost.
  func ownedHistory(of act: ReversibleAct, in replica: LoadedReplica) -> [(lost: Bool, effects: [EffectReceipt])] {
    act.sourceEntries.sorted { Inverses.ordinal(of: $0.localId) < Inverses.ordinal(of: $1.localId) }.map { source in
      (source.unavailable, source.accepted(in: replica.meta.serverEpoch) ?? [])
    }
  }

  static func rows(_ effects: [EffectReceipt], _ address: RecordAddress) -> [EffectRow] {
    effects.filter { $0.scope == address.scope }.flatMap(\.rows).filter { $0.key == address.key }
  }

  // The act's own receipt rows of a record, in commit order.
  static func rows(_ history: [(lost: Bool, effects: [EffectReceipt])], _ address: RecordAddress) -> [EffectRow] {
    history.flatMap { Inverses.rows($0.effects, address) }
  }

  // The latest accepted version the act owns of a target, or nil.
  static func latestOwned(_ history: [(lost: Bool, effects: [EffectReceipt])], _ target: Target) -> EffectSlot.Version? {
    rows(history, target.address).compactMap { (row: EffectRow) -> EffectSlot.Version? in
      row.slots.first { $0.slot == target.slot }?.version
    }.last
  }

  // Whether nothing but this device's own receipted writes came between the row sequence a preimage was read over and the
  // act's last write of the record: following the journal's receipts from that sequence, each next row starting where the
  // last ended, reaches the act's last row. A write the device had not seen breaks the walk.
  static func unbroken(_ history: [(lost: Bool, effects: [EffectReceipt])], _ address: RecordAddress, from rowSeq: Int64?,
                       in replica: LoadedReplica) -> Bool {
    guard let last = rows(history, address).last else { return false }
    let own: [EffectRow] = replica.journal.acts.flatMap(\.sourceEntries).flatMap { (source: JournalSource) -> [EffectRow] in
      Inverses.rows(source.accepted(in: replica.meta.serverEpoch) ?? [], address)
    }
    var at = rowSeq
    while at != last.rowSeq {
      let next = own.filter { (row: EffectRow) -> Bool in
        guard row.beforeRowSeq == at else { return false }
        guard let at else { return true }
        return row.rowSeq > at
      }.min { $0.rowSeq < $1.rowSeq }
      guard let next else { return false }
      at = next.rowSeq
    }
    return true
  }

  // What the act's own receipts prove of a record it created.
  enum CreatedProof: Equatable {
    // Its creation's complete footprint, each later own write continuing the row sequence.
    case proven(rowSeq: Int64, footprint: [EffectSlot])
    // A gap, or history the device no longer holds, proves nothing.
    case broken
  }

  // A record the act created, proven unchanged by its own receipts alone, or nil when the act never wrote it.
  static func footprint(_ history: [(lost: Bool, effects: [EffectReceipt])], _ record: RecordAddress) -> CreatedProof? {
    let rows = Inverses.rows(history, record)
    guard let first = rows.first else { return nil }
    guard !history.contains(where: \.lost), first.beforeRowSeq == nil else { return .broken }
    var slots: [EffectSlot.Slot: EffectSlot] = [:]
    var previous: Int64?
    for row in rows {
      if let previous, row.beforeRowSeq != previous { return .broken }
      for slot in row.slots { slots[slot.slot] = slot }
      previous = row.rowSeq
    }
    return .proven(rowSeq: previous!, footprint: slots.values.sorted { EffectSlot.Slot.precedes($0.slot, $1.slot) })
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

  // What one planned restore operation becomes: its wire form, or a skip by a code the request counts.
  enum Bound {
    case send(RestoreOperation)
    case skip(String)
  }

  // One planned operation bound to what it must find, a skip, or nil where the act never wrote the target, so there is
  // nothing to take back. Where a source's history is unavailable, an unowned target may be one it wrote, and skips. A keyed
  // record's life brought back alive carries the values its preimage's record read, as the slot's projection draws them, to
  // a server that declares them.
  func bound(_ operation: PlannedOperation, of act: ReversibleAct, history: [(lost: Bool, effects: [EffectReceipt])], epoch: String,
             in replica: LoadedReplica) -> Bound? {
    let declared = (replica.meta.serverSchema ?? 0) >= RestoreOperation.revivalValuesSchema
    let field = { (target: Target, before: JSON?, expected: RestoreOperation.Expected, record: RecordValues?) -> RestoreOperation in
      let before = before ?? .null
      let values = record.flatMap { (record: RecordValues) -> JSON.Object? in
        guard declared, let type = self.registry.type(target.key.type), self.registry.revivesKeyed(type, target.slot, before) else { return nil }
        let values = self.registry.revivalValues(type, fields: record.fields, texts: record.texts)
        return values.isEmpty ? nil : values
      }
      return .field(target.key, slot: target.slot, expected: expected, before: before, values: values)
    }
    switch operation {
    case .field(let target, let before, let reference?, let record):
      guard let expected = expected(of: reference, in: replica) else { return .skip("reference-unbound") }
      return .send(field(target, before, expected, record))
    case .field(let target, let before, nil, let record):
      guard let version = Inverses.latestOwned(history, target) else { return history.contains(where: \.lost) ? .skip("history-changed") : nil }
      let preimage = act.sourceEntries.flatMap(\.preimages).first { $0.target == target }
      if !(preimage?.epoch ?? epoch).isSameID(as: epoch) { return .skip("epoch-changed") }
      guard let preimage, Inverses.unbroken(history, target.address, from: preimage.rowSeq, in: replica) else { return .skip("history-changed") }
      return .send(field(target, before, .version(version), record))
    case .createdRecord(let record):
      switch Inverses.footprint(history, record) {
      case .proven(let rowSeq, let footprint)?: return .send(.createdRecord(record.key, rowSeq: rowSeq, footprint: footprint))
      case .broken?: return .skip("history-changed")
      case nil: return nil
      }
    case .createRecord(let record, let values, let reference):
      guard (reference.epoch ?? epoch).isSameID(as: epoch) else { return .skip("epoch-changed") }
      return .send(.createRecord(record.key, values: values))
    }
  }

  // The version a reference binds to now, or nil: an accepted version of this epoch (a reference taken before any epoch
  // binds to the first), or an absence in the incarnation its birth names. A pending reference binds at its entry's result
  // (`resolveReferences`); one whose entry ended without one binds nothing.
  func expected(of reference: VersionReference, in replica: LoadedReplica) -> RestoreOperation.Expected? {
    let epoch = replica.meta.serverEpoch
    switch reference {
    case .accepted(let held, let version):
      return (held ?? epoch)?.isSameID(as: epoch) == true ? .version(version) : nil
    case .fieldAbsent(let held, let birth):
      guard (held ?? epoch)?.isSameID(as: epoch) == true else { return nil }
      guard let birth else { return .absent(born: nil) }
      guard case .version(.stamp(let born))? = expected(of: birth, in: replica) else { return nil }
      return .absent(born: born)
    case .pending, .recordAbsent, .unbound: return nil
    }
  }

  // The result of an entry a cancellation's references wait on, in its ACK transaction: each reference to it binds the
  // version it wrote.
  func resolveReferences(of entry: OutboxEntry, epoch: String, in replica: inout LoadedReplica) {
    let pending = replica.journal.cancellations.flatMap(\.units).flatMap(\.restored.pendingLocalIds)
      + replica.journal.inverses.flatMap(\.slots).filter { $0.state == .waiting }.flatMap(\.recipe.pendingLocalIds)
    guard pending.contains(where: { $0.isSameID(as: entry.localId) }) else { return }
    let bind = { (target: Target) -> VersionReference in Inverses.version(of: target, writtenBy: entry, epoch: epoch) }
    replica.updateJournal { journal in
      for index in journal.cancellations.indices {
        journal.cancellations[index].units = journal.cancellations[index].units.map { (unit: CancellationUnit) -> CancellationUnit in
          unit.restoring(unit.restored.resolving(entry.localId, by: bind))
        }
      }
      for request in journal.inverses.indices {
        for slot in journal.inverses[request].slots.indices where journal.inverses[request].slots[slot].state == .waiting {
          guard case .restore(let command, let operations) = journal.inverses[request].slots[slot].recipe else { continue }
          journal.inverses[request].slots[slot].recipe = .restore(command: command, operations: operations.map { $0.resolving(entry.localId, by: bind) })
        }
      }
    }
  }

  // A pending reference bound to the version its acknowledged entry wrote, in `epoch`: from the entry's receipt, or, for an
  // ordinary entry, its own delta's stamp, which the restore's condition then checks. A text without a receipt, or a
  // register the entry did not write, binds nothing.
  static func version(of target: Target, writtenBy entry: OutboxEntry, epoch: String?) -> VersionReference {
    if let effects = entry.acceptedEffects {
      let version = rows(effects, target.address).last?.slots.first { $0.slot == target.slot }?.version
      return version.map { VersionReference.accepted(epoch: epoch, version: $0) } ?? .unbound
    }
    guard target.scope == entry.scope, let delta = entry.intent.deltas.first(where: { $0.key == target.key }) else { return .unbound }
    let stamp: Stamp? = switch target.slot {
    case .born: delta.lattice.born
    case .life: delta.lattice.life?.stamp
    case .field(let name): delta.lattice.fields[name]?.stamp
    case .text: nil
    }
    return stamp.map { VersionReference.accepted(epoch: epoch, version: .stamp($0)) } ?? .unbound
  }

  // The projection of the operations a slot still holds, the rest withdrawn; a revived record keeps the values it is drawn
  // with.
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
          case .field(let target, _, _, let record):
            if record != nil {
              next.lattice.fields.merge(delta.lattice.fields) { (kept: Register, _: Register) -> Register in kept }
              next.texts.merge(delta.texts) { (kept: TextWrite, _: TextWrite) -> TextWrite in kept }
            }
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

  // MARK: Adoption

  // §7.10 Add: an act adopted from the anon replica never read `into`'s own writes, which reach the server before its
  // own. Each adopted act gives up every field target whose record `into` holds a write of, an outbox entry whose stored
  // effects write it or a receipt row its journal keeps: the target leaves its recipes, preimages and written values, and
  // a waiting request withdraws its operation there, with its projection, counted skipped `history-changed`. A created
  // record and a command recipe stay, proven by the act's own receipts alone. The anon journal and entries as they move,
  // and how many targets the adopted acts gave up.
  static func givingUpUnread(_ journal: Journal, entries: [OutboxEntry], into: LoadedReplica) -> (journal: Journal, entries: [OutboxEntry], givenUp: Int) {
    var written: Set<RecordAddress> = []
    for entry in into.outbox {
      for effect in entry.effects() { written.formUnion(effect.deltas.map { RecordAddress(scope: effect.scope, key: $0.key) }) }
    }
    for attempt in into.journal.acts.flatMap(\.sourceEntries).flatMap(\.attempts) {
      for effect in attempt.acceptedEffects ?? [] { written.formUnion(effect.rows.map { RecordAddress(scope: effect.scope, key: $0.key) }) }
    }
    guard !written.isEmpty else { return (journal, entries, 0) }
    var adopted = journal
    var moving = entries
    var givenUp = 0
    for act in adopted.acts.indices {
      for index in adopted.acts[act].sourceEntries.indices {
        var source = adopted.acts[act].sourceEntries[index]
        source.recipes = source.recipes.compactMap { (recipe: ActUndoRecipe) -> ActUndoRecipe? in
          guard case .fields(let command, let targets) = recipe else { return recipe }
          let kept = targets.filter { !written.contains($0.target.address) }
          givenUp += targets.count - kept.count
          return kept.isEmpty ? nil : .fields(restoreCommand: command, targets: kept)
        }
        source.preimages.removeAll { written.contains($0.target.address) }
        source.written.removeAll { written.contains($0.target.address) }
        adopted.acts[act].sourceEntries[index] = source
      }
    }
    for request in adopted.inverses.indices where adopted.inverses[request].state == .waiting {
      for index in adopted.inverses[request].slots.indices where adopted.inverses[request].slots[index].state == .waiting {
        let slot = adopted.inverses[request].slots[index]
        guard case .restore(let command, let operations) = slot.recipe else { continue }
        let kept = operations.filter { (operation: PlannedOperation) -> Bool in
          guard case .field(let target, _, .none, _) = operation else { return true }
          return !written.contains(target.address)
        }
        guard kept.count < operations.count else { continue }
        adopted.inverses[request].slots[index].recipe = .restore(command: command, operations: kept)
        adopted.inverses[request].slots[index].skipped = (slot.skipped ?? []) + Array(repeating: "history-changed", count: operations.count - kept.count)
        if let entry = moving.firstIndex(where: { $0.localId.isSameID(as: slot.localId) }) { Inverses.keep(kept, in: &moving[entry]) }
      }
    }
    return (adopted, moving, givenUp)
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

  // An inverse entry's outcomes, checked before the answer changes anything; throws when they are malformed.
  func check(_ result: PushResult, of entry: OutboxEntry, in replica: LoadedReplica) throws(JSONError) {
    guard case .ok = result.verdict, let (request, index) = slot(of: entry, in: replica) else { return }
    let slot = replica.journal.inverses[request].slots[index]
    guard slot.state != .settled else { return }
    _ = try InverseOutcome.reported(in: result.detail?["command"], count: slot.recipe.count)
  }

  // An inverse entry's result, in its ACK or refusal transaction: its outcomes settle the slot, a skipped operation's
  // projection is withdrawn, the inverse act's preimages anchor at the rows its restore wrote over, and the request
  // settles with its last slot.
  func settle(_ entry: OutboxEntry, by result: PushResult, epoch: String, in replica: inout LoadedReplica) throws {
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
      let effects: [EffectReceipt] = replica.entry(entry.localId)?.acceptedEffects ?? []
      slot.changed = effects.contains { !$0.rows.isEmpty }
      let inverseActId = replica.journal.inverses[request].inverseActId
      replica.updateJournal { journal in
        if let source = journal.source(of: entry.localId), journal.acts[source.act].actId.isSameID(as: inverseActId) {
          Inverses.anchor(&journal.acts[source.act].sourceEntries[source.source].preimages, at: effects, epoch: epoch)
        }
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

  // An applied restore wrote each record over the row whose version it checked: the inverse act's preimages there were read
  // at that row, in the answer's epoch.
  static func anchor(_ preimages: inout [Preimage], at effects: [EffectReceipt], epoch: String) {
    for index in preimages.indices {
      guard let row = rows(effects, preimages[index].target.address).first else { continue }
      preimages[index].rowSeq = row.beforeRowSeq
      preimages[index].epoch = epoch
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
