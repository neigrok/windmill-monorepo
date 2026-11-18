package works.windmill.sync.engine

import works.windmill.sync.api.InverseResult
import works.windmill.sync.api.UndoSegment
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.*

// K-3 Undo and Redo of an act (§7.3 Undo of an act): an inverse request reserves its slots in the outbox at once, each an ordinary entry
// at the end of commit order that carries its optimistic projection and stops the sender until it is materialized. Once every source of
// the act has an authoritative outcome, the slots bind the latest versions the act owns and its first preimages into restore or inverse
// commands, in one transaction; a slot left with nothing settles unnumbered. The inverse act journals its own preimages, so a Redo takes
// back only what the Undo actually applied.

// The logical value a slot of a record in its view form reads (a text is its string), or null while unset.
internal fun Json.drawnValue(slot: Slot): Json? = when (slot.kind) {
    Slot.Kind.born -> null
    Slot.Kind.life -> this["life"]?.arr()?.first()
    Slot.Kind.field -> this["f"]?.get(slot.name!!)?.arr()?.first()
    Slot.Kind.text -> this["x"]?.get(slot.name!!)
}

// One scope's records as `drawn` shows them, in their view form.
internal fun Engine.drawn(replica: ReplicaState, scope: ScopeRef): Map<RecordKey, Json> = viewRecords(replica, scope, ViewMode.drawn).mapValues { it.value.first }

// A slot a request reserves before it is bound, in the scope it restores in.
private data class PlannedSlot(val scope: ScopeRef, val recipe: SlotRecipe)

// An Undo's slots from the act's own recipes, the last source's first: one restore slot a source for its generic recipes, each target in
// one slot only, back to its first preimage, and one slot each product recipe. `replacement`, by source ordinal, stands in for the
// stored recipes.
private fun plannedSlots(act: ReversibleAct, replacement: List<UndoSegment>?): List<PlannedSlot> {
    val firstPreimages = linkedMapOf<RecordSlot, Json>()
    for (preimage in act.sourceEntries.flatMap { it.preimages }) firstPreimages.putIfAbsent(preimage.target, preimage.value)
    val named = mutableSetOf<Any>()
    return act.sourceEntries.asReversed().flatMap { source ->
        val recipes = replacement?.let { segments -> segments.firstOrNull { it.index == ordinalOf(source.localId) }?.recipes.orEmpty() } ?: source.recipes
        val products = recipes.filterIsInstance<UndoRecipe.Product>().map { PlannedSlot(source.originScope, SlotRecipe.Product(it)) }
        val operations = recipes.flatMap { recipe -> when (recipe) {
            is UndoRecipe.CreatedRecord -> listOf(PlannedOperation.CreatedRecord(recipe.record))
            is UndoRecipe.Fields -> recipe.targets.mapNotNull { (target) -> firstPreimages[target]?.let { PlannedOperation.Field(target, it) } }
            is UndoRecipe.Product -> emptyList()
        } }.filter { named.add(if (it is PlannedOperation.Field) it.target else it.record) }
        val command = recipes.mapNotNull { (it as? UndoRecipe.Fields)?.restoreCommand ?: (it as? UndoRecipe.CreatedRecord)?.restoreCommand }.lastOrNull()
        products + listOfNotNull(command?.takeIf { operations.isNotEmpty() }?.let { PlannedSlot(source.originScope, SlotRecipe.Restore(it, operations)) })
    }
}

// A Redo of a cancellation reserves ordinary restore slots, one a scope, in the order the cancelled act wrote: each field back to the value
// the act wrote, under the version reference it now reads, and each created record created again only while it is wholly absent.
private fun Engine.redoSlots(cancellation: CancellationReceipt): List<PlannedSlot> {
    val byScope = linkedMapOf<ScopeRef, PlannedSlot>()
    for (unit in cancellation.units.sortedBy { ordinalOf(it.ownerLocalId) }) {
        val scope = unit.record.scope
        val command = registry.commands.map(::CommandDef).firstOrNull { it.engine == "restore" && it.scope == registry.scopeKind(scope) }
        if (command == null || unit.record.key.type !in command.predicts) continue
        val operation = when (unit) {
            is CancellationUnit.Field -> PlannedOperation.Field(unit.target, unit.redoValue, unit.restored)
            is CancellationUnit.CreatedRecord -> PlannedOperation.CreateRecord(unit.record, unit.redoValues, unit.restored)
        }
        val slot = byScope[scope]?.recipe as? SlotRecipe.Restore ?: SlotRecipe.Restore(command.name, emptyList())
        byScope[scope] = PlannedSlot(scope, slot.copy(operations = slot.operations + operation))
    }
    return byScope.values.toList()
}

// The optimistic projection of a restore over `view` at `stamp`: each operation as the restore would write it, one delta a record. An
// operation whose record the view lacks projects nothing; a create projects only while the record is absent.
private fun Engine.projectionOf(view: Map<RecordKey, Json>, operations: List<PlannedOperation>, stamp: Stamp): List<Delta> {
    val deltas = linkedMapOf<RecordKey, Delta>()
    for (op in operations) {
        val key = op.record.key
        val type = registry.type(key.type)!!
        if (op is PlannedOperation.CreateRecord) {
            if (key in view) continue
            deltas[key] = Delta(key, Lattice(Life("alive", stamp), stamp.takeIf { type.hasBorn }, op.values.fields.mapValues { Register(it.value, stamp) }),
                op.values.texts.mapValues { TextWrite(it.value, TextBase.Text("")) })
            continue
        }
        val current = view[key] ?: continue
        val delta = deltas[key] ?: Delta(key, Lattice(born = Lattice(current).born.takeIf { type.hasBorn }))
        deltas[key] = when {
            op is PlannedOperation.CreatedRecord -> delta.copy(lattice = Lattice(Life("dead", stamp), delta.lattice.born, delta.lattice.fields))
            op !is PlannedOperation.Field -> delta
            op.target.slot.kind == Slot.Kind.life -> delta.copy(lattice = Lattice(Life(op.before.str(), stamp), delta.lattice.born, delta.lattice.fields))
            op.target.slot.kind == Slot.Kind.field -> delta.copy(lattice = Lattice(delta.lattice.life, delta.lattice.born, delta.lattice.fields + (op.target.slot.name!! to Register(op.before, stamp))))
            else -> delta.copy(texts = delta.texts + (op.target.slot.name!! to TextWrite(op.before.str(), TextBase.Text(current.drawnValue(op.target.slot)?.str() ?: ""))))
        }
    }
    return deltas.values.toList()
}

// The inverse act's own journal: each restore slot a source whose recipes put back what the inverse replaces, from the values its targets
// read before it. A created record comes back by its life only where a write can bring it back; a product slot has no generic recipe,
// and its Redo is the product's.
private fun Engine.inverseJournal(replica: ReplicaState, inverseActId: String, slots: List<Pair<String, PlannedSlot>>): ReversibleAct =
    ReversibleAct(inverseActId, true, slots.map { (localId, slot) ->
        val recipe = slot.recipe as? SlotRecipe.Restore ?: return@map SourceEntry(localId, slot.scope, emptyList(), emptyList())
        val view = drawn(replica, slot.scope)
        val targets = recipe.operations.mapNotNull { op -> when (op) {
            is PlannedOperation.Field -> op.target
            is PlannedOperation.CreatedRecord -> registry.type(op.record.key.type)!!.takeIf { it.identity == "keyed" || it.revivable }?.let { RecordSlot(op.record, Slot(Slot.Kind.life)) }
            is PlannedOperation.CreateRecord -> null
        } }
        val preimages = targets.mapNotNull { target -> view[target.key]?.drawnValue(target.slot)?.let { Preimage(target, it) } }
        val recreated = recipe.operations.filterIsInstance<PlannedOperation.CreateRecord>().map { UndoRecipe.CreatedRecord(recipe.command, it.record) }
        val restorable = preimages.takeIf { it.isNotEmpty() }?.let { listOf(UndoRecipe.Fields(recipe.command, it.map { preimage -> UndoRecipe.FieldTarget(preimage.target) })) }.orEmpty()
        SourceEntry(localId, slot.scope, restorable + recreated, preimages)
    })

// requestInverse(sourceActId, inverseSlots?): Undo of an opted act, or Redo of an inverse act. An act whose entries are all still held is
// cancelled at once, as `undo` cancels it. Otherwise the slots are reserved, projected and, where every source is already authoritative,
// materialized, all in this transaction. Asking again for the same act answers its existing request.
internal fun Engine.requestInverse(replica: ReplicaState, sourceActId: String, replacement: List<UndoSegment>?): InverseResult {
    replica.inverses.firstOrNull { it.sourceActId == sourceActId }?.let { return it.answer }
    val act = replica.journal.firstOrNull { it.actId == sourceActId }
    val cancellation = replica.cancellations.firstOrNull { it.inverseActId == sourceActId }
    if (act == null && cancellation == null) return InverseResult.Unavailable(null, "not-reversible")
    val entries = replica.entries().filter { it.gestureId == sourceActId }
    if (act != null && entries.isNotEmpty() && entries.all { it.state == "held" }) return cancelHeld(replica, act, entries)

    val planned = if (act != null) plannedSlots(act, replacement) else redoSlots(cancellation!!)
    val inverseActId = freshGestureId()
    val requestId = freshGestureId()
    val clock = Hlc(replica.meta.member("hlc"))
    clock.observe(Stamp(replica.meta.member("hlcHigh").str()))
    val stamp = clock.tick(now(replica), actor)
    val firstOrder = (replica.outbox.maxOfOrNull { it.order } ?: 0) + 1
    val slots = planned.mapIndexed { k, slot -> "$inverseActId/$k" to slot }
    val before = planned.map { it.scope }.distinct().associateWith { drawn(replica, it) }
    val journal = inverseJournal(replica, inverseActId, slots)
    val touched = mutableSetOf<Pair<ScopeRef, RecordKey>>()
    for ((k, pair) in slots.withIndex()) {
        val (localId, slot) = pair
        val deltas = (slot.recipe as? SlotRecipe.Restore)?.let { projectionOf(before.getValue(slot.scope), it.operations, stamp) }.orEmpty()
        touched.addAll(deltas.map { slot.scope to it.key })
        replica.outbox.add(Entry(Json.objectOf("localId" to Json.of(localId), "gestureId" to Json.of(inverseActId), "lineage" to Json.of(replica.account ?: "anon"),
            "scope" to slot.scope.json, "state" to Json.of("ready"), "commitOrder" to Json.of(firstOrder + k), "releaseAt" to Json.of(0), "stamp" to stamp.json,
            "inverseOf" to Json.of(requestId), "intent" to Intent(slot.scope, command = Command(slot.recipe.command, Json.Null), gestureId = inverseActId).json,
            "predictions" to Json.array(Projection(slot.scope, deltas).json))))
    }
    val localChanged = touched.any { (scope, key) -> before.getValue(scope)[key] != drawn(replica, scope)[key] }
    val request = InverseRequest(requestId, sourceActId, inverseActId, "waiting", localChanged,
        slots.mapIndexed { k, (localId, slot) -> InverseSlot(localId, firstOrder + k, slot.recipe) })
    replica.inverses.add(request)
    replica.journal.add(journal)
    replica.meta = replica.meta.with("hlc" to clock.json, "hlcHigh" to stamp.json)
    materialize(replica, request)
    return request.answer
}

// An act every entry of which is still held never reached the server: Undo cancels it in place, its dependents folded silently, and
// reports whether anything drawn changed. The act leaves the journal, and its cancellation receipt keeps what a Redo needs.
private fun Engine.cancelHeld(replica: ReplicaState, act: ReversibleAct, entries: List<Entry>): InverseResult {
    val scopes = entries.flatMap { entry -> entry.effects.map { it.scope } }.distinct()
    val before = scopes.associateWith { drawn(replica, it) }
    val written = entries.flatMap { entry -> entry.effects.flatMap { effect -> effect.deltas.map { Triple(entry, effect.scope, it) } } }
    undoHeld(replica, entries)
    val after = scopes.associateWith { drawn(replica, it) }
    val inverseActId = freshGestureId()
    val requestId = freshGestureId()
    replica.journal.remove(act)
    replica.cancellations.add(CancellationReceipt(inverseActId, act.actId, cancellationUnits(replica, written, before, after)))
    val result = InverseResult.Cancelled(requestId, inverseActId, scopes.any { before[it] != after[it] })
    replica.inverses.add(InverseRequest(requestId, act.actId, inverseActId, "settled", null, emptyList(), result))
    return result
}

// The changes a cancellation actually took out of `drawn`, each with what restoring it must find: a register the cancelled act wrote that
// now reads otherwise, at the version it now reads, and a record it created that is now absent, with the act's own creation values. A
// later local edit that masks the act's write took nothing out, and is no unit.
private fun Engine.cancellationUnits(replica: ReplicaState, written: List<Triple<Entry, ScopeRef, Delta>>, before: Map<ScopeRef, Map<RecordKey, Json>>,
    after: Map<ScopeRef, Map<RecordKey, Json>>): List<CancellationUnit> {
    val units = linkedMapOf<Any, CancellationUnit>()
    for ((entry, scope, delta) in written) {
        val type = registry.type(delta.key.type)!!
        val was = before.getValue(scope)[delta.key]
        val now = after.getValue(scope)[delta.key]
        val record = RecordAddress(scope, delta.key)
        if (now == null) {
            if (was == null || !type.recreatable) continue
            val unit = units[record] as? CancellationUnit.CreatedRecord
                ?: CancellationUnit.CreatedRecord(entry.id, record, CreationValues(), VersionReference.RecordAbsent(replica.meta["serverEpoch"]?.orNull()?.str()))
            val client = { name: String -> type.fields[name]?.writer == "client" }
            units[record] = unit.copy(redoValues = CreationValues(
                unit.redoValues.fields + delta.lattice.fields.keys.filter(client).associateWith { was.drawnValue(Slot(Slot.Kind.field, it))!! },
                unit.redoValues.texts + delta.texts.keys.filter(client).associateWith { was.drawnValue(Slot(Slot.Kind.text, it))!!.str() }))
            continue
        }
        val slots = listOfNotNull(Slot(Slot.Kind.life).takeIf { delta.lattice.life != null }) + delta.lattice.fields.keys.map { Slot(Slot.Kind.field, it) } +
            delta.texts.keys.map { Slot(Slot.Kind.text, it) }
        for (slot in slots) {
            if (!type.restores(slot) || (was?.drawnValue(slot) ?: Json.Null) == (now.drawnValue(slot) ?: Json.Null)) continue
            val target = RecordSlot(record, slot)
            units[target] = CancellationUnit.Field(entry.id, target, was?.drawnValue(slot) ?: Json.Null, referenceOf(replica, target, now))
        }
    }
    return units.values.toList()
}

// Where the value a target reads now comes from: a pending entry that wrote it, the confirmed row's accepted version, or, unset, the
// record's birth.
private fun Engine.referenceOf(replica: ReplicaState, target: RecordSlot, now: Json): VersionReference {
    val epoch = replica.meta["serverEpoch"]?.orNull()?.str()
    val shown = Lattice(now)
    fun writes(delta: Delta, slot: Slot): Boolean = when (slot.kind) {
        Slot.Kind.born -> delta.lattice.born != null && delta.lattice.born == shown.born && delta.lattice.life?.stamp == delta.lattice.born
        Slot.Kind.life -> delta.lattice.life != null && delta.lattice.life == shown.life
        Slot.Kind.field -> delta.lattice.fields[slot.name]?.let { it == shown.fields[slot.name] } == true
        Slot.Kind.text -> slot.name in delta.texts
    }
    fun pending(slot: Slot) = replica.entries().asReversed().firstOrNull { entry -> entry.active.any { effect -> effect.scope == target.scope &&
        effect.deltas.any { it.key == target.key && writes(it, slot) } } }?.let { VersionReference.Pending(it.id, RecordSlot(target.record, slot)) }
    val confirmed = store.row(replica.id, target.scope, target.key)
    fun accepted(slot: Slot) = confirmed?.version(slot)?.let { VersionReference.Accepted(epoch, it) }
    return pending(target.slot) ?: accepted(target.slot) ?: VersionReference.FieldAbsent(epoch,
        if (registry.type(target.key.type)!!.hasBorn) pending(Slot(Slot.Kind.born)) ?: accepted(Slot(Slot.Kind.born)) else null)
}

// Whether every source of an act has its authoritative outcome: an entry still held, queued or sent, or acknowledged in another epoch,
// has none yet.
private fun ReplicaState.authoritative(act: ReversibleAct): Boolean = act.sourceEntries.all { source ->
    val entry = entry(source.localId) ?: return@all true
    entry.state == "acked" && source.accepted(meta["serverEpoch"]?.orNull()?.str()) != null
}

// A Redo of a cancellation waits while an entry its references name has no authoritative outcome.
private fun ReplicaState.referencesAuthoritative(request: InverseRequest): Boolean = request.slots.filter { it.state == "waiting" }
    .flatMap { (it.recipe as? SlotRecipe.Restore)?.operations.orEmpty() }
    .flatMap { op -> when (op) { is PlannedOperation.Field -> op.reference?.waitsOn.orEmpty(); is PlannedOperation.CreateRecord -> op.reference.waitsOn; else -> emptyList() } }
    .all { localId -> entry(localId).let { it == null || it.state == "acked" && it.json["resultEpoch"] == meta["serverEpoch"] } }

// The receipts an act's sources own in the current epoch, in commit order, beside whether another epoch took a source's history.
private class OwnedHistory(val lost: Boolean, val effects: List<EffectReceipt>) {
    fun rows(address: RecordAddress): List<EffectRow> = effects.filter { it.scope == address.scope }.flatMap { effect -> effect.rows.filter { it.key == address.key } }

    // The latest accepted version the act owns of a target, or null.
    fun latestOwned(target: RecordSlot): SlotVersion? = rows(target.record).mapNotNull { it.slot(target.slot)?.version }.lastOrNull()

    // A record the act created, proven unchanged by its own receipts alone: its creation's complete footprint and each later own write
    // continuing the row sequence, next.beforeRowSeq = previous.rowSeq. A gap, or history another epoch took, proves nothing.
    fun createdFootprint(record: RecordAddress): Evidence.CreatedRecordProof? {
        if (lost) return null
        val rows = rows(record)
        if (rows.firstOrNull()?.beforeRowSeq != null || rows.isEmpty()) return null
        if (rows.zipWithNext().any { (previous, next) -> next.beforeRowSeq != previous.rowSeq }) return null
        val footprint = rows.flatMap { it.slots }.associateBy { it.slot }.values.sortedWith { a, b -> compareBytes(a.slot.order, b.slot.order) }
        return Evidence.CreatedRecordProof(record, rows.last().rowSeq, footprint)
    }

    // A scope the act created, proven unchanged by its own receipts: created (beforeSeq null), then each next receipt of it starting where
    // the last ended.
    fun createdScope(scope: ScopeRef): Evidence.CreatedScopeProof? {
        if (lost) return null
        val receipts = effects.filter { it.scope == scope }
        val first = receipts.firstOrNull() ?: return null
        if (first.beforeSeq != null || first.seq == null) return null
        var seq: Long? = first.seq
        for (receipt in receipts.drop(1)) { if (receipt.beforeSeq != seq) return null; seq = receipt.seq }
        return seq?.let { Evidence.CreatedScopeProof(scope, it) }
    }
}

private fun ReplicaState.ownedHistory(act: ReversibleAct?): OwnedHistory {
    val sources = act?.sourceEntries.orEmpty().sortedBy { ordinalOf(it.localId) }
    return OwnedHistory(sources.any { it.unavailable }, sources.flatMap { it.accepted(meta["serverEpoch"]?.orNull()?.str()).orEmpty() })
}

// What a Redo's reference binds to now, or null: an accepted version of this epoch, the version a pending entry's receipt accepted for
// it, or an absence in the incarnation its birth names.
private fun ReplicaState.expectedOf(reference: VersionReference): Expectation? {
    val epoch = meta["serverEpoch"]?.orNull()?.str()
    return when (reference) {
        is VersionReference.Accepted -> Expectation.Version(reference.version).takeIf { (reference.epoch ?: epoch) == epoch }
        is VersionReference.Pending -> {
            val effects = entry(reference.localId)?.acceptedEffects ?: sourceOf(reference.localId)?.second?.accepted(epoch).orEmpty()
            OwnedHistory(false, effects).latestOwned(reference.target)?.let(Expectation::Version)
        }
        is VersionReference.FieldAbsent -> when {
            (reference.epoch ?: epoch) != epoch -> null
            reference.recordBirth == null -> Expectation.Absent(null)
            else -> ((expectedOf(reference.recordBirth) as? Expectation.Version)?.version as? SlotVersion.Stamped)?.let { Expectation.Absent(it.stamp) }
        }
        is VersionReference.RecordAbsent -> null
    }
}

// §7.5 step 1: references taken before the replica held an epoch belong to the epoch it then took, which an epoch change now leaves.
internal fun ReplicaState.bindReferences(epoch: String?) {
    for (cancellation in cancellations) cancellation.units = cancellation.units.map { unit -> when (unit) {
        is CancellationUnit.Field -> unit.copy(restored = unit.restored.bound(epoch))
        is CancellationUnit.CreatedRecord -> unit.copy(restored = unit.restored.bound(epoch))
    } }
    for (slot in inverses.flatMap { it.slots }) {
        val recipe = slot.recipe as? SlotRecipe.Restore ?: continue
        slot.recipe = recipe.copy(operations = recipe.operations.map { op -> when (op) {
            is PlannedOperation.Field -> op.copy(reference = op.reference?.bound(epoch))
            is PlannedOperation.CreateRecord -> op.copy(reference = op.reference.bound(epoch))
            is PlannedOperation.CreatedRecord -> op
        } })
    }
}

// Binds a waiting request's slots once its act's sources are authoritative: each restore operation takes the latest version the act owns,
// or goes; each product slot its evidence, or goes whole. Settlement only removes operations and projections; a slot left with nothing
// settles unnumbered.
internal fun Engine.materialize(replica: ReplicaState, request: InverseRequest) {
    if (request.state != "waiting") return
    val act = replica.journal.firstOrNull { it.actId == request.sourceActId }
    if (if (act != null) !replica.authoritative(act) else !replica.referencesAuthoritative(request)) return
    val history = replica.ownedHistory(act)
    val epoch = replica.meta["serverEpoch"]?.orNull()?.str()
    fun bind(op: PlannedOperation): RestoreOperation? = when (op) {
        is PlannedOperation.Field -> (if (op.reference != null) replica.expectedOf(op.reference) else history.latestOwned(op.target)?.let(Expectation::Version))
            ?.let { RestoreOperation.Field(op.target.key, op.target.slot, it, op.before) }
        is PlannedOperation.CreatedRecord -> history.createdFootprint(op.record)?.let { RestoreOperation.CreatedRecord(op.record.key, it.rowSeq, it.footprint) }
        is PlannedOperation.CreateRecord -> RestoreOperation.CreateRecord(op.record.key, op.values).takeIf { ((op.reference as? VersionReference.RecordAbsent)?.epoch ?: epoch) == epoch }
    }
    for (slot in request.slots) {
        val entry = replica.entry(slot.localId)
        if (entry == null) { slot.settle(null, "refused"); continue }
        val recipe = slot.recipe
        val args: Json? = when {
            epoch == null -> null
            recipe is SlotRecipe.Restore -> {
                val bound = recipe.operations.mapNotNull { op -> bind(op)?.let { op to it } }
                slot.recipe = recipe.copy(operations = bound.map { it.first })
                bound.takeIf { it.isNotEmpty() }?.let { RestoreArguments(epoch, it.map { (_, wire) -> wire }).json }
            }
            recipe is SlotRecipe.Product -> {
                val selection = recipe.recipe.evidence
                val records = selection.unchangedCreatedRecords.map(history::createdFootprint)
                val scopes = selection.unchangedCreatedScopes.map(history::createdScope)
                if (records.any { it == null } || scopes.any { it == null }) null
                else Json.objectOf("input" to recipe.recipe.input, "evidence" to Evidence(epoch,
                    selection.ownedFields.mapNotNull { target -> history.latestOwned(target)?.let { Evidence.OwnedField(target, it) } },
                    records.filterNotNull(), scopes.filterNotNull()).json)
            }
            else -> null
        }
        if (args == null) {
            (slot.recipe as? SlotRecipe.Restore)?.let { slot.recipe = it.copy(operations = emptyList()) }
            replica.move(entry, "vacate", ended)
            slot.settle(emptyList())
            continue
        }
        (slot.recipe as? SlotRecipe.Restore)?.let { keepProjection(entry, it.operations) }
        entry.intent = entry.intent.copy(command = Command(recipe.command, args))
        slot.state = "materialized"
    }
    request.state = "materialized"
    replica.settleRequest(request)
}

// The projection of the operations a slot still holds, the rest withdrawn.
private fun keepProjection(entry: Entry, operations: List<PlannedOperation>) {
    entry.predictions = entry.predictions?.map { projection -> projection.copy(deltas = projection.deltas.mapNotNull { delta ->
        val kept = operations.filter { it.record == RecordAddress(projection.scope, delta.key) }
        when {
            kept.isEmpty() -> null
            kept.any { it is PlannedOperation.CreateRecord } -> delta
            else -> kept.fold(Delta(delta.key, Lattice(born = delta.lattice.born))) { next, op ->
                val slot = (op as? PlannedOperation.Field)?.target?.slot
                when (slot?.kind) {
                    null, Slot.Kind.life -> next.copy(lattice = Lattice(delta.lattice.life, next.lattice.born, next.lattice.fields))
                    Slot.Kind.field -> next.copy(lattice = Lattice(next.lattice.life, next.lattice.born, next.lattice.fields + delta.lattice.fields.filterKeys { it == slot.name }))
                    else -> next.copy(texts = next.texts + delta.texts.filterKeys { it == slot.name })
                }
            }
        }
    }) }
}

private fun ReplicaState.slotOf(entry: Entry): Pair<InverseRequest, InverseSlot>? {
    val request = inverses.firstOrNull { it.requestId == entry.inverseOf } ?: return null
    return request.slots.firstOrNull { it.localId == entry.id }?.let { request to it }
}

// The sender's barrier (§7.4): an inverse slot not yet materialized is materialized now if it can be; one that still waits stops numbering.
// Answers whether the entry may be numbered.
internal fun Engine.passesBarrier(replica: ReplicaState, entry: Entry): Boolean {
    val (request, slot) = replica.slotOf(entry) ?: return true
    if (slot.state != "waiting") return true
    materialize(replica, request)
    return slot.state != "waiting"
}

// An inverse entry's outcomes, checked before the ACK changes anything: one an operation, or the response is malformed.
internal fun ReplicaState.checkInverseResult(entry: Entry, result: Json) {
    val (_, slot) = slotOf(entry) ?: return
    if (result.member("s").str() == "ok") InverseOutcome.read(result["detail"]?.get("command"), slot.recipe.count)
}

// The result of an inverse entry, in its ACK or refusal transaction: its outcomes settle the slot, a skipped operation's projection is
// withdrawn, and the request settles with its last slot.
internal fun ReplicaState.applyInverseResult(entry: Entry, result: Json) {
    val (request, slot) = slotOf(entry) ?: return
    if (slot.state == "settled") return
    if (result.member("s").str() == "ok") {
        val outcomes = InverseOutcome.read(result["detail"]?.get("command"), slot.recipe.count)
        (slot.recipe as? SlotRecipe.Restore)?.let { recipe -> keepProjection(entry, recipe.operations.filterIndexed { index, _ -> outcomes[index].applied }) }
        slot.changed = entry.acceptedEffects.any { it.rows.isNotEmpty() }
        slot.settle(outcomes)
    } else if (entry(entry.id) !== entry) slot.settle(null, result.member("code").str())
    settleRequest(request)
}

// readInverseResult(requestId): cancelled, pending, settled or unavailable.
internal fun ReplicaState.readInverseResult(requestId: String): InverseResult =
    inverses.firstOrNull { it.requestId == requestId }?.answer ?: InverseResult.Unavailable(requestId, "unknown-request")
