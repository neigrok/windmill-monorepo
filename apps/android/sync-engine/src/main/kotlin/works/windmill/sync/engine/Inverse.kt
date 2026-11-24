package works.windmill.sync.engine

import works.windmill.sync.api.CommitFailure
import works.windmill.sync.api.InverseResult
import works.windmill.sync.api.UndoSegment
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.*

// K-3 Undo and Redo of an act (§7.3 Undo of an act): an inverse request reserves its slots in the outbox at once, each an ordinary entry
// at the end of commit order that carries its optimistic projection and stops the sender until it is materialized. Once every source of
// the act has an authoritative outcome, the slots bind the latest versions the act owns and its first preimages into restore or inverse
// commands, in one transaction; a slot left with nothing settles unnumbered. An Undo never erases a write the device had not seen when it
// acted. The inverse act journals the values the act wrote, so a Redo writes back exactly those, and only where its Undo applied.

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

// An Undo's slots from its sources' recipes, the last source's first: one restore slot a source for its generic recipes, each target in
// one slot only, back to its first preimage (a revived life with the record that preimage read), and one slot each product recipe.
private fun plannedSlots(sources: List<SourceEntry>): List<PlannedSlot> {
    val firstPreimages = linkedMapOf<RecordSlot, Preimage>()
    for (preimage in sources.flatMap { it.preimages }) firstPreimages.putIfAbsent(preimage.target, preimage)
    val named = mutableSetOf<Any>()
    return sources.asReversed().flatMap { source ->
        val products = source.recipes.filterIsInstance<UndoRecipe.Product>().map { PlannedSlot(source.originScope, SlotRecipe.Product(it)) }
        val operations = source.recipes.flatMap { recipe -> when (recipe) {
            is UndoRecipe.CreatedRecord -> listOf(PlannedOperation.CreatedRecord(recipe.record))
            is UndoRecipe.Fields -> recipe.targets.map { (target) -> firstPreimages.getValue(target).let { PlannedOperation.Field(target, it.value, drawn = it.drawn) } }
            is UndoRecipe.Product -> emptyList()
        } }.filter { named.add(if (it is PlannedOperation.Field) it.target else it.record) }
        val command = source.recipes.mapNotNull { (it as? UndoRecipe.Fields)?.restoreCommand ?: (it as? UndoRecipe.CreatedRecord)?.restoreCommand }.lastOrNull()
        products + listOfNotNull(command?.takeIf { operations.isNotEmpty() }?.let { PlannedSlot(source.originScope, SlotRecipe.Restore(it, operations)) })
    }
}

// The stored recipes, or a complete replacement by source ordinal, each checked against its source's scope as at the act. A replacement's
// field target needs a first preimage its source journaled, so a cancellation's has none. Anything else is malformed.
private fun Registry.sourcesOf(sources: List<SourceEntry>, replacement: List<UndoSegment>?): List<SourceEntry> {
    if (replacement == null) return sources
    val ordinals = sources.map { ordinalOf(it.localId) }
    if (replacement.any { it.index !in ordinals } || replacement.map { it.index }.distinct().size != replacement.size) throw CommitFailure.malformed("inverse-slots")
    return sources.map { source ->
        val recipes = replacement.firstOrNull { it.index == ordinalOf(source.localId) }?.recipes.orEmpty()
        for (recipe in recipes) {
            try { recipe.check(this, source.originScope) } catch (_: IllegalArgumentException) { throw CommitFailure.malformed("inverse-slot-recipe") }
            if (recipe is UndoRecipe.Fields && recipe.targets.any { (target) -> source.preimages.none { it.target == target } }) throw CommitFailure.malformed("inverse-slot-target")
        }
        SourceEntry(source.localId, source.originScope, recipes, source.preimages, source.written, source.attempts, source.unavailable)
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

// The optimistic projection of a restore over `view` at `stamp`: each operation as the restore would write it, one delta a record. A
// record the view lacks is drawn only where a life operation revives it, with the values its preimage read; any other operation on it
// projects nothing, and a create projects only while the record is absent.
private fun Engine.projectionOf(view: Map<RecordKey, Json>, operations: List<PlannedOperation>, stamp: Stamp): List<Delta> {
    val deltas = linkedMapOf<RecordKey, Delta>()
    val revived = operations.filterIsInstance<PlannedOperation.Field>().filter { it.target.slot.kind == Slot.Kind.life && it.drawn != null }
        .associate { it.target.key to it.drawn!! }
    for (op in operations) {
        val key = op.record.key
        val type = registry.type(key.type)!!
        if (op is PlannedOperation.CreateRecord) {
            if (key in view) continue
            deltas[key] = Delta(key, Lattice(Life("alive", stamp), stamp.takeIf { type.hasBorn }, op.values.fields.mapValues { Register(it.value, stamp) }),
                op.values.texts.mapValues { TextWrite(it.value, TextBase.Text("")) })
            continue
        }
        val current = view[key] ?: revived[key] ?: continue
        val delta = deltas[key] ?: if (key in view) Delta(key, Lattice(born = Lattice(current).born.takeIf { type.hasBorn }))
            else Delta(key, Lattice(born = Lattice(current).born.takeIf { type.hasBorn }, fields = Lattice(current).fields),
                current["x"]?.obj().orEmpty().mapValues { TextWrite(it.value.str(), TextBase.Text("")) })
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

// The inverse act's own journal: each restore slot a source whose recipes put back what the inverse replaces, the values the inverted act
// wrote (`forward`), never what a later local edit shows. A life the slot takes away, a created record's among them, comes back only where
// a write can bring it back, with the record as `before` drew it, and a record the inverse creates goes again by its strict recipe; a
// product slot has no generic recipe, and its Redo is the product's. A preimage's row is the one its restore writes over, anchored at the
// restore's ACK.
private fun Engine.inverseJournal(inverseActId: String, slots: List<Pair<String, PlannedSlot>>, forward: Map<RecordSlot, Json>,
    before: Map<ScopeRef, Map<RecordKey, Json>>): ReversibleAct =
    ReversibleAct(inverseActId, true, slots.map { (localId, slot) ->
        val recipe = slot.recipe as? SlotRecipe.Restore ?: return@map SourceEntry(localId, slot.scope, emptyList(), emptyList())
        val taken = recipe.operations.mapNotNull { op -> when (op) {
            is PlannedOperation.Field -> forward[op.target]?.let { value ->
                val takenAway = op.target.slot.kind == Slot.Kind.life && value == Json.of("alive")
                Preimage(op.target, value, drawn = before.getValue(slot.scope)[op.target.key]?.takeIf { takenAway }?.drawnRecord()) to Written(op.target, op.before) }
            is PlannedOperation.CreatedRecord -> registry.type(op.record.key.type)!!.takeIf { it.identity == "keyed" || it.revivable }
                ?.let { RecordSlot(op.record, Slot(Slot.Kind.life)).let { target ->
                    Preimage(target, Json.of("alive"), drawn = before.getValue(slot.scope)[target.key]?.drawnRecord()) to Written(target, Json.of("dead")) } }
            is PlannedOperation.CreateRecord -> null
        } }
        val restorable = taken.takeIf { it.isNotEmpty() }?.let { listOf(UndoRecipe.Fields(recipe.command, it.map { (preimage) -> UndoRecipe.FieldTarget(preimage.target) })) }.orEmpty()
        val recreated = recipe.operations.filterIsInstance<PlannedOperation.CreateRecord>().map { UndoRecipe.CreatedRecord(recipe.command, it.record) }
        SourceEntry(localId, slot.scope, restorable + recreated, taken.map { it.first }, taken.map { it.second })
    })

// The value an act left in each target, its last source's.
private fun ReversibleAct.forward(): Map<RecordSlot, Json> =
    sourceEntries.sortedBy { ordinalOf(it.localId) }.flatMap { it.written }.associate { it.target to it.value }

// The value each target showed once a cancellation took the act out, which an Undo of its Redo puts back.
private fun CancellationReceipt.forward(): Map<RecordSlot, Json> =
    units.filterIsInstance<CancellationUnit.Field>().mapNotNull { unit -> unit.restoredValue?.let { unit.target to it } }.toMap()

// requestInverse(sourceActId, inverseSlots?): Undo of an opted act, or Redo of an inverse act or a cancellation. An act whose entries are all
// still held is cancelled at once, as `undo` cancels it. Otherwise the slots are reserved, projected and, where every source is already
// authoritative, materialized, all in this transaction. Asking again for the same act answers its existing request. A cancelled product
// command has no generic Redo: its Redo needs the product's replacement.
internal fun Engine.requestInverse(replica: ReplicaState, sourceActId: String, replacement: List<UndoSegment>?): InverseResult {
    replica.inverses.firstOrNull { it.sourceActId == sourceActId }?.let { return it.answer }
    val act = replica.journal.firstOrNull { it.actId == sourceActId }
    val cancellation = replica.cancellations.firstOrNull { it.inverseActId == sourceActId }
    if (act == null && cancellation == null) return InverseResult.Unavailable(null, "not-reversible")
    val entries = replica.entries().filter { it.gestureId == sourceActId }
    if (act != null && entries.isNotEmpty() && entries.all { it.state == "held" }) return cancelHeld(replica, act, entries)
    if (cancellation != null && replacement == null && cancellation.sourceEntries.any { it.command }) return InverseResult.Unavailable(null, "product-redo-required")

    val planned = when {
        act != null -> plannedSlots(registry.sourcesOf(act.sourceEntries, replacement))
        replacement != null -> plannedSlots(registry.sourcesOf(cancellation!!.sourceEntries.map { SourceEntry(it.localId, it.originScope, emptyList(), emptyList()) }, replacement))
        else -> redoSlots(cancellation!!)
    }
    val inverseActId = freshGestureId()
    val requestId = freshGestureId()
    val hlc = Hlc(replica.meta.member("hlc"))
    hlc.observe(Stamp(replica.meta.member("hlcHigh").str()))
    val stamp = hlc.tick(now(replica), actor)
    val firstOrder = replica.nextCommitOrder()
    val slots = planned.mapIndexed { k, slot -> "$inverseActId/$k" to slot }
    val before = planned.map { it.scope }.distinct().associateWith { drawn(replica, it) }
    val journal = inverseJournal(inverseActId, slots, act?.forward() ?: cancellation!!.forward(), before)
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
    val request = InverseRequest(requestId, sourceActId, inverseActId, "waiting", clock.now(), localChanged,
        slots.mapIndexed { k, (localId, slot) -> InverseSlot(localId, firstOrder + k, slot.scope, slot.recipe) })
    replica.inverses.add(request)
    replica.journal.add(journal)
    replica.meta = replica.meta.with("hlc" to hlc.json, "hlcHigh" to stamp.json)
    materialize(replica, request)
    return request.answer
}

// An act every entry of which is still held never reached the server: Undo cancels it in place, its dependents folded silently, and
// reports whether anything drawn changed. The act leaves the journal, and its cancellation receipt keeps what a Redo needs.
private fun Engine.cancelHeld(replica: ReplicaState, act: ReversibleAct, entries: List<Entry>): InverseResult {
    val ordinary = { entry: Entry -> entry.intent.command?.let { registry.command(it.name)?.engine == "capture" } ?: true }
    val scopes = entries.flatMap { entry -> entry.effects.map { it.scope } }.distinct()
    val before = scopes.associateWith { drawn(replica, it) }
    val written = entries.filter(ordinary).flatMap { entry -> entry.intent.deltas.map { Triple(entry, entry.scope, it) } }
    undoHeld(replica, entries)
    val after = scopes.associateWith { drawn(replica, it) }
    val inverseActId = freshGestureId()
    val requestId = freshGestureId()
    replica.journal.remove(act)
    replica.cancellations.add(CancellationReceipt(inverseActId, act.actId, entries.map { CancelledEntry(it.id, it.scope, !ordinary(it)) },
        cancellationUnits(replica, written, before, after)))
    val result = InverseResult.Cancelled(requestId, inverseActId, scopes.any { before[it] != after[it] })
    replica.inverses.add(InverseRequest(requestId, act.actId, inverseActId, "settled", clock.now(), null, emptyList(), result))
    return result
}

// The changes a cancellation actually took out of `drawn`, from the act's ordinary deltas (a product command's effects are its own, never
// generic), each with what restoring it must find: a register the act wrote that now reads otherwise, at the version it now reads, with
// the value it now reads, and a record it created that is now absent, with the act's own creation values. A later local edit that masks
// the act's write took nothing out, and is no unit.
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
                unit.redoValues.fields + delta.lattice.fields.filterKeys(client).mapValues { it.value.value },
                unit.redoValues.texts + delta.texts.filterKeys(client).mapValues { it.value.text }))
            continue
        }
        val slots = listOfNotNull(Slot(Slot.Kind.life).takeIf { delta.lattice.life != null }) + delta.lattice.fields.keys.map { Slot(Slot.Kind.field, it) } +
            delta.texts.keys.map { Slot(Slot.Kind.text, it) }
        for (slot in slots) {
            if (!type.restores(slot) || (was?.drawnValue(slot) ?: Json.Null) == (now.drawnValue(slot) ?: Json.Null)) continue
            val target = RecordSlot(record, slot)
            units[target] = CancellationUnit.Field(entry.id, target, was?.drawnValue(slot) ?: Json.Null, referenceOf(replica, target, now), now.drawnValue(slot))
        }
    }
    return units.values.toList()
}

// Where the value a target reads now comes from: an entry that wrote it (pending until its ACK, then the version it wrote), the confirmed
// row's accepted version, or, unset, the record's birth.
private fun Engine.referenceOf(replica: ReplicaState, target: RecordSlot, now: Json): VersionReference {
    val epoch = replica.meta["serverEpoch"]?.orNull()?.str()
    val shown = Lattice(now)
    fun writes(delta: Delta, slot: Slot): Boolean = when (slot.kind) {
        Slot.Kind.born -> delta.lattice.born != null && delta.lattice.born == shown.born && delta.lattice.life?.stamp == delta.lattice.born
        Slot.Kind.life -> delta.lattice.life != null && delta.lattice.life == shown.life
        Slot.Kind.field -> delta.lattice.fields[slot.name]?.let { it == shown.fields[slot.name] } == true
        Slot.Kind.text -> slot.name in delta.texts
    }
    fun pending(slot: Slot): VersionReference? {
        val entry = replica.entries().asReversed().firstOrNull { entry -> entry.active.any { effect -> effect.scope == target.scope &&
            effect.deltas.any { it.key == target.key && writes(it, slot) } } } ?: return null
        val reference = VersionReference.Pending(entry.id, RecordSlot(target.record, slot))
        return if (entry.state == "acked") reference.boundTo(entry, entry.json["resultEpoch"]?.orNull()?.str()) else reference
    }
    val confirmed = store.row(replica.id, target.scope, target.key)
    fun accepted(slot: Slot) = confirmed?.version(slot)?.let { VersionReference.Accepted(epoch, it) }
    return pending(target.slot) ?: accepted(target.slot) ?: VersionReference.FieldAbsent(epoch,
        if (registry.type(target.key.type)!!.hasBorn) pending(Slot(Slot.Kind.born)) ?: accepted(Slot(Slot.Kind.born)) else null)
}

// A pending reference bound to the version its acknowledged entry wrote, in `epoch`: from the entry's receipt, or, for an ordinary entry,
// its own delta's stamp, which the restore's condition then checks. A text without a receipt, or a register the entry did not write, binds
// nothing.
private fun VersionReference.Pending.boundTo(entry: Entry, epoch: String?): VersionReference {
    if (entry.predictions != null) return OwnedHistory(false, entry.acceptedEffects).rows(target.record).lastOrNull()?.slot(target.slot)
        ?.let { VersionReference.Accepted(epoch, it.version) } ?: VersionReference.Unbound
    if (target.scope != entry.scope || target.slot.kind == Slot.Kind.text) return VersionReference.Unbound
    val delta = entry.intent.deltas.firstOrNull { it.key == target.key }
    val stamp = when (target.slot.kind) {
        Slot.Kind.born -> delta?.lattice?.born
        Slot.Kind.life -> delta?.lattice?.life?.stamp
        else -> delta?.lattice?.fields?.get(target.slot.name)?.stamp
    }
    return stamp?.let { VersionReference.Accepted(epoch, SlotVersion.Stamped(it)) } ?: VersionReference.Unbound
}

// The result of an entry a cancellation's references wait on, in its ACK transaction: each reference to it binds the version it wrote.
internal fun ReplicaState.resolveReferences(entry: Entry, epoch: String) {
    fun resolve(reference: VersionReference): VersionReference = when (reference) {
        is VersionReference.FieldAbsent -> reference.copy(recordBirth = reference.recordBirth?.let(::resolve))
        is VersionReference.Pending -> if (reference.localId == entry.id) reference.boundTo(entry, epoch) else reference
        else -> reference
    }
    for (cancellation in cancellations) cancellation.units = cancellation.units.map { unit -> when (unit) {
        is CancellationUnit.Field -> unit.copy(restored = resolve(unit.restored))
        is CancellationUnit.CreatedRecord -> unit.copy(restored = resolve(unit.restored))
    } }
    for (slot in inverses.flatMap { it.slots }.filter { it.state == "waiting" }) {
        val recipe = slot.recipe as? SlotRecipe.Restore ?: continue
        slot.recipe = recipe.copy(operations = recipe.operations.map { op -> when (op) {
            is PlannedOperation.Field -> op.copy(reference = op.reference?.let(::resolve))
            is PlannedOperation.CreateRecord -> op.copy(reference = resolve(op.reference))
            is PlannedOperation.CreatedRecord -> op
        } })
    }
}

// Whether every source of an act has its authoritative outcome: an entry still held, queued or sent, or acknowledged in another epoch,
// has none yet.
private fun ReplicaState.authoritative(act: ReversibleAct): Boolean = act.sourceEntries.all { source ->
    val entry = entry(source.localId) ?: return@all true
    entry.state == "acked" && source.accepted(meta["serverEpoch"]?.orNull()?.str()) != null
}

// A Redo of a cancellation waits while the replica holds no epoch, in which a waiting slot's references bind, and while an entry its
// references name has no result yet.
private fun ReplicaState.referencesAuthoritative(request: InverseRequest): Boolean {
    val waiting = request.slots.filter { it.state == "waiting" }
    if (meta["serverEpoch"]?.orNull() == null && waiting.isNotEmpty()) return false
    return waiting.flatMap { (it.recipe as? SlotRecipe.Restore)?.operations.orEmpty() }
        .flatMap { op -> when (op) { is PlannedOperation.Field -> op.reference?.waitsOn.orEmpty(); is PlannedOperation.CreateRecord -> op.reference.waitsOn; else -> emptyList() } }
        .all { entry(it) == null }
}

// The receipts an act's sources own in the current epoch, in commit order, beside whether a source's history is lost.
private class OwnedHistory(val lost: Boolean, val effects: List<EffectReceipt>) {
    fun rows(address: RecordAddress): List<EffectRow> = effects.filter { it.scope == address.scope }.flatMap { effect -> effect.rows.filter { it.key == address.key } }

    // The latest accepted version the act owns of a target, or null.
    fun latestOwned(target: RecordSlot): SlotVersion? = rows(target.record).mapNotNull { it.slot(target.slot)?.version }.lastOrNull()

    // A record the act created, proven unchanged by its own receipts alone: its creation's complete footprint and each later own write
    // continuing the row sequence, next.beforeRowSeq = previous.rowSeq. Null when the act never wrote it; Broken when a gap, or lost
    // history, proves nothing.
    fun createdFootprint(record: RecordAddress): CreatedProof? {
        val rows = rows(record).takeIf { it.isNotEmpty() } ?: return null
        if (lost || rows.first().beforeRowSeq != null || rows.zipWithNext().any { (previous, next) -> next.beforeRowSeq != previous.rowSeq }) return CreatedProof.Broken
        val footprint = rows.flatMap { it.slots }.associateBy { it.slot }.values.sortedWith { a, b -> compareBytes(a.slot.order, b.slot.order) }
        return CreatedProof.Held(Evidence.CreatedRecordProof(record, rows.last().rowSeq, footprint))
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

private sealed interface CreatedProof {
    data class Held(val proof: Evidence.CreatedRecordProof) : CreatedProof
    data object Broken : CreatedProof
}

private fun ReplicaState.ownedHistory(act: ReversibleAct?): OwnedHistory {
    val sources = act?.sourceEntries.orEmpty().sortedBy { ordinalOf(it.localId) }
    return OwnedHistory(sources.any { it.unavailable }, sources.flatMap { it.accepted(meta["serverEpoch"]?.orNull()?.str()).orEmpty() })
}

// Whether nothing but this device's own receipted writes came between the row a preimage was read over and the act's last write of the
// record: following the journal's receipts from that row, each next row starting where the last ended, reaches the act's last row. A write
// the device had not seen breaks the walk.
private fun ReplicaState.unbroken(history: OwnedHistory, address: RecordAddress, fromRowSeq: Long?): Boolean {
    val last = history.rows(address).last().rowSeq
    val epoch = meta["serverEpoch"]?.orNull()?.str()
    val own = journal.flatMap { it.sourceEntries }.flatMap { OwnedHistory(false, it.accepted(epoch).orEmpty()).rows(address) }
    var at = fromRowSeq
    while (at != last) {
        at = own.filter { it.beforeRowSeq == at && (at == null || it.rowSeq > at) }.minOfOrNull { it.rowSeq } ?: return false
    }
    return true
}

// What a Redo's reference binds to now, or null: an accepted version of this epoch, or an absence in the incarnation its birth names. A
// pending reference binds at its entry's result (`resolveReferences`); one whose entry ended without one binds nothing.
private fun ReplicaState.expectedOf(reference: VersionReference): Expectation? {
    val epoch = meta["serverEpoch"]?.orNull()?.str()
    return when (reference) {
        is VersionReference.Accepted -> Expectation.Version(reference.version).takeIf { (reference.epoch ?: epoch) == epoch }
        is VersionReference.FieldAbsent -> when {
            (reference.epoch ?: epoch) != epoch -> null
            reference.recordBirth == null -> Expectation.Absent(null)
            else -> ((expectedOf(reference.recordBirth) as? Expectation.Version)?.version as? SlotVersion.Stamped)?.let { Expectation.Absent(it.stamp) }
        }
        else -> null
    }
}

// §7.5 step 1: references and preimages taken before the replica held an epoch belong to the epoch it then took, which an epoch change now
// leaves.
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
    for (source in journal.flatMap { it.sourceEntries }) source.preimages = source.preimages.map { it.copy(epoch = it.epoch ?: epoch) }
}

// What one planned restore operation becomes: its wire form, a skip by its code the request counts, or nothing where the act never wrote
// the target, so there is nothing to take back. Where a source's history is lost, an unowned target may be one it wrote, and skips. A keyed
// record's life brought back alive carries the values its preimage's record read, as the slot's projection draws them, to a server that
// declares them.
private sealed interface Bound {
    data class Sent(val operation: RestoreOperation) : Bound
    data class Skipped(val code: String) : Bound
}

private fun ReplicaState.bind(registry: Registry, act: ReversibleAct?, history: OwnedHistory, op: PlannedOperation): Bound? {
    val epoch = meta["serverEpoch"]?.orNull()?.str()
    return when (op) {
        is PlannedOperation.Field -> {
            val type = registry.type(op.target.key.type)!!
            val declared = (meta["serverSchema"]?.long() ?: 0L) >= REVIVAL_VALUES_SCHEMA
            val values = op.drawn?.takeIf { declared && type.revivesKeyed(op.target.slot, op.before) }?.let { CreationValues.revival(type, it) }?.takeUnless { it.isEmpty }
            val sent = { expected: Expectation -> Bound.Sent(RestoreOperation.Field(op.target.key, op.target.slot, expected, op.before, values)) }
            if (op.reference != null) return expectedOf(op.reference)?.let(sent) ?: Bound.Skipped("reference-unbound")
            val expected = history.latestOwned(op.target) ?: return if (history.lost) Bound.Skipped("history-changed") else null
            val preimage = act?.sourceEntries.orEmpty().flatMap { it.preimages }.firstOrNull { it.target == op.target }
            when {
                (preimage?.epoch ?: epoch) != epoch -> Bound.Skipped("epoch-changed")
                preimage == null || !unbroken(history, op.target.record, preimage.rowSeq) -> Bound.Skipped("history-changed")
                else -> sent(Expectation.Version(expected))
            }
        }
        is PlannedOperation.CreatedRecord -> when (val proof = history.createdFootprint(op.record)) {
            null -> null
            CreatedProof.Broken -> Bound.Skipped("history-changed")
            is CreatedProof.Held -> Bound.Sent(RestoreOperation.CreatedRecord(op.record.key, proof.proof.rowSeq, proof.proof.footprint))
        }
        is PlannedOperation.CreateRecord -> if (((op.reference as? VersionReference.RecordAbsent)?.epoch ?: epoch) == epoch)
            Bound.Sent(RestoreOperation.CreateRecord(op.record.key, op.values)) else Bound.Skipped("epoch-changed")
    }
}

// Binds a waiting request's slots once its sources are authoritative: each restore operation takes the latest version the act owns where
// nothing the device had not seen came between, or skips, or goes; each product slot its evidence, or skips whole. Settlement only removes
// operations and projections; a slot left with nothing to send settles unnumbered.
internal fun Engine.materialize(replica: ReplicaState, request: InverseRequest) {
    if (request.state != "waiting") return
    val act = replica.journal.firstOrNull { it.actId == request.sourceActId }
    if (if (act != null) !replica.authoritative(act) else !replica.referencesAuthoritative(request)) return
    val history = replica.ownedHistory(act)
    val epoch = replica.meta["serverEpoch"]?.orNull()?.str()
    for (slot in request.slots) {
        val entry = replica.entry(slot.localId)
        if (entry == null) { slot.settle(null, "refused"); continue }
        val recipe = slot.recipe
        val recorded = slot.skipped.orEmpty()
        slot.skipped = recorded
        val args: Json? = when {
            epoch == null -> null
            recipe is SlotRecipe.Restore -> {
                val results = recipe.operations.map { op -> op to replica.bind(registry, act, history, op) }
                slot.skipped = recorded + results.mapNotNull { (it.second as? Bound.Skipped)?.code }
                val sent = results.mapNotNull { (op, result) -> (result as? Bound.Sent)?.let { op to it.operation } }
                slot.recipe = recipe.copy(operations = sent.map { it.first })
                sent.takeIf { it.isNotEmpty() }?.let { RestoreArguments(epoch, it.map { (_, wire) -> wire }).json }
            }
            recipe is SlotRecipe.Product -> {
                val selection = recipe.recipe.evidence
                val records = selection.unchangedCreatedRecords.map { (history.createdFootprint(it) as? CreatedProof.Held)?.proof }
                val scopes = selection.unchangedCreatedScopes.map(history::createdScope)
                if (records.any { it == null } || scopes.any { it == null }) null.also { slot.skipped = recorded + "history-changed" }
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

// §7.10 Add: an act adopted from `from` never read this replica's own writes, which reach the server before its own. Each adopted act
// gives up every field target whose record this replica holds a write of, an outbox entry whose stored effects write it or a receipt row
// its journal keeps: the target leaves its recipes, preimages and written values, and a waiting request withdraws its operation there,
// with its projection, counted skipped `history-changed`. A created record and a command recipe stay, proven by the act's own receipts
// alone. Answers how many targets the adopted acts gave up.
internal fun ReplicaState.giveUpUnread(from: ReplicaState): Int {
    val written = buildSet {
        for (entry in outbox) for (effect in entry.effects) for (delta in effect.deltas) add(RecordAddress(effect.scope, delta.key))
        for (attempt in journal.flatMap { it.sourceEntries }.flatMap { it.attempts }) {
            for (effect in attempt.acceptedEffects.orEmpty()) for (row in effect.rows) add(RecordAddress(effect.scope, row.key))
        }
    }
    if (written.isEmpty()) return 0
    var givenUp = 0
    for (source in from.journal.flatMap { it.sourceEntries }) {
        source.recipes = source.recipes.mapNotNull { recipe ->
            if (recipe !is UndoRecipe.Fields) return@mapNotNull recipe
            val kept = recipe.targets.filter { it.target.record !in written }
            givenUp += recipe.targets.size - kept.size
            kept.takeIf { it.isNotEmpty() }?.let { recipe.copy(targets = it) }
        }
        source.preimages = source.preimages.filter { it.target.record !in written }
        source.written = source.written.filter { it.target.record !in written }
    }
    for (request in from.inverses.filter { it.state == "waiting" }) for (slot in request.slots.filter { it.state == "waiting" }) {
        val recipe = slot.recipe as? SlotRecipe.Restore ?: continue
        val kept = recipe.operations.filter { it !is PlannedOperation.Field || it.reference != null || it.target.record !in written }
        val withdrawn = recipe.operations.size - kept.size
        if (withdrawn == 0) continue
        slot.recipe = recipe.copy(operations = kept)
        slot.skipped = slot.skipped.orEmpty() + List(withdrawn) { "history-changed" }
        from.entry(slot.localId)?.let { keepProjection(it, kept) }
    }
    return givenUp
}

// The projection of the operations a slot still holds, the rest withdrawn.
private fun keepProjection(entry: Entry, operations: List<PlannedOperation>) {
    entry.predictions = entry.predictions?.map { projection -> projection.copy(deltas = projection.deltas.mapNotNull { delta ->
        val kept = operations.filter { it.record == RecordAddress(projection.scope, delta.key) }
        when {
            kept.isEmpty() -> null
            kept.any { it is PlannedOperation.CreateRecord } -> delta
            else -> kept.fold(Delta(delta.key, Lattice(born = delta.lattice.born))) { built, op ->
                // A revival keeps the record it draws.
                val next = if ((op as? PlannedOperation.Field)?.drawn == null) built else Delta(built.key,
                    Lattice(built.lattice.life, built.lattice.born, delta.lattice.fields + built.lattice.fields), delta.texts + built.texts)
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

// An inverse entry's outcomes, checked before the ACK changes anything: one an operation, or the result is unreadable (JsonError).
internal fun ReplicaState.checkInverseResult(entry: Entry, result: Json) {
    val (_, slot) = slotOf(entry) ?: return
    if (slot.state != "settled" && result.member("s").str() == "ok") InverseOutcome.read(result["detail"]?.get("command"), slot.recipe.count)
}

// The result of an inverse entry, in its ACK or refusal transaction: its outcomes settle the slot, a skipped operation's projection is
// withdrawn, the inverse act's preimages anchor at the rows the restore wrote over, and the request settles with its last slot.
internal fun ReplicaState.applyInverseResult(entry: Entry, result: Json, epoch: String) {
    val (request, slot) = slotOf(entry) ?: return
    if (slot.state == "settled") return
    if (result.member("s").str() == "ok") {
        val outcomes = InverseOutcome.read(result["detail"]?.get("command"), slot.recipe.count)
        (slot.recipe as? SlotRecipe.Restore)?.let { recipe -> keepProjection(entry, recipe.operations.filterIndexed { index, _ -> outcomes[index].applied }) }
        anchorPreimages(request, entry, epoch)
        slot.changed = entry.acceptedEffects.any { it.rows.isNotEmpty() }
        slot.settle(outcomes)
    } else if (entry(entry.id) !== entry) slot.settle(null, result.member("code").str())
    settleRequest(request)
}

// An applied restore wrote each record over the row whose version it checked: the inverse act's preimages there were read at that row,
// in the answer's epoch.
private fun ReplicaState.anchorPreimages(request: InverseRequest, entry: Entry, epoch: String) {
    val source = journal.firstOrNull { it.actId == request.inverseActId }?.sourceEntries?.firstOrNull { it.localId == entry.id } ?: return
    val effects = OwnedHistory(false, entry.acceptedEffects)
    source.preimages = source.preimages.map { preimage -> effects.rows(preimage.target.record).firstOrNull()?.let { preimage.copy(rowSeq = it.beforeRowSeq, epoch = epoch) } ?: preimage }
}

// readInverseResult(requestId): cancelled, pending, settled or unavailable.
internal fun ReplicaState.readInverseResult(requestId: String): InverseResult =
    inverses.firstOrNull { it.requestId == requestId }?.answer ?: InverseResult.Unavailable(requestId, "unknown-request")
