package works.windmill.sync.engine

import works.windmill.sync.api.InverseResult
import works.windmill.sync.core.*

// K-3 the journal of reversible acts (§7.3 Undo of an act): each act's source entries with their recipes, first local preimages, the
// values the act wrote and the receipts or refusals their ACK transactions record, beside the inverse requests and cancellation receipts
// that read them; their retention, epochs, lifecycle and settlement. The journal is the replica's local user data: its values and ids
// never leave the device but in a restore's own arguments, and never enter telemetry.

// A local id's ordinal: its position in its act's commit order.
internal fun ordinalOf(localId: String): Int = localId.substringAfterLast('/').toInt()

// A target's value before the act, with the row it was read over (null where none was) and the epoch that row counts in. An inverse act's
// preimage is anchored at its restore's ACK to the row the restore wrote over. A life's keeps the record as `drawn` read it (`drawn`: its
// birth, field registers and texts), which a revival draws.
internal data class Preimage(val target: RecordSlot, val value: Json, val rowSeq: Long? = null, val epoch: String? = null, val drawn: Json? = null) {
    constructor(json: Json) : this(RecordSlot(json.member("target")), json.member("value"), json["rowSeq"]?.orNull()?.long(), json["epoch"]?.orNull()?.str(), json["record"])
    val json: Json get() = Json.objectOf("target" to target.json, "value" to value, "rowSeq" to (rowSeq?.let(Json::of) ?: Json.Null),
        "epoch" to (epoch?.let(Json::of) ?: Json.Null)).with("record" to drawn)

    // §7.3 Capture: `drawn` read over this device's own earlier write of the record, so the preimage stands on the row that write left, once
    // the write's receipt shows it started where the preimage stood, in the preimage's epoch (one taken before the replica held an epoch
    // takes the receipt's). An entry with no receipt, an ordinary one, moves nothing.
    fun steppedOver(entry: Entry): Preimage {
        val answered = entry.json["resultEpoch"]?.str() ?: return this
        if (entry.state != "acked" || (epoch ?: answered) != answered) return this
        if (entry.effects.none { effect -> effect.scope == target.scope && effect.deltas.any { it.key == target.key } }) return this
        val row = entry.acceptedEffects.firstOrNull { it.scope == target.scope }?.row(target.key) ?: return this
        return if (row.beforeRowSeq == rowSeq) copy(rowSeq = row.rowSeq, epoch = answered) else this
    }
}

// A record in its view form as a revival draws it: its birth, field registers and texts, never its life.
internal fun Json.drawnRecord(): Json = Json.objectOf().with("born" to this["born"], "f" to this["f"], "x" to this["x"])

// The value an act left in a target, which a Redo writes back.
internal data class Written(val target: RecordSlot, val value: Json) {
    constructor(json: Json) : this(RecordSlot(json.member("target")), json.member("value"))
    val json: Json get() = Json.objectOf("target" to target.json, "value" to value)
}

// One answer a source entry earned in an epoch: its accepted receipt, or its terminal refusal.
internal data class Attempt(val epoch: String, val n: Long, val ok: Boolean, val acceptedEffects: List<EffectReceipt>? = null) {
    constructor(json: Json) : this(json.member("epoch").str(), json.member("n").long(), json.member("outcome").str() == "ok",
        json["acceptedEffects"]?.arr()?.map(::EffectReceipt))
    val json: Json get() = Json.objectOf("epoch" to Json.of(epoch), "n" to Json.of(n), "outcome" to Json.of(if (ok) "ok" else "refused"))
        .with("acceptedEffects" to acceptedEffects?.let { Json.Arr(it.map(EffectReceipt::json)) })
}

// An act's entry, as its segment left it: the recipes that undo it, the values its targets read before the act and the values it left,
// and its answers. `unavailable` marks a source whose history is lost: an epoch change took it, its `ok` came without a readable receipt,
// or its scope ended.
internal class SourceEntry(val localId: String, var originScope: ScopeRef, var recipes: List<UndoRecipe>, var preimages: List<Preimage>,
    var written: List<Written> = emptyList(), var attempts: List<Attempt> = emptyList(), var unavailable: Boolean = false) {
    constructor(json: Json) : this(json.member("localId").str(), ScopeRef(json.member("originScope")), json.items("recipes").map(UndoRecipe::read),
        json.items("preimages").map(::Preimage), json.items("written").map(::Written), json.items("attempts").map(::Attempt), json.flag("unavailable"))
    val json: Json get() = Json.objectOf("localId" to Json.of(localId), "originScope" to originScope.json, "recipes" to Json.Arr(recipes.map(UndoRecipe::json)),
        "preimages" to Json.Arr(preimages.map(Preimage::json)), "written" to Json.Arr(written.map(Written::json)),
        "attempts" to Json.Arr(attempts.map(Attempt::json))).with("unavailable" to Json.of(true).takeIf { unavailable })
    // The receipts this source's accepted answer in `epoch` holds, or null without one.
    fun accepted(epoch: String?): List<EffectReceipt>? = attempts.firstOrNull { it.ok && it.epoch == epoch }?.let { it.acceptedEffects.orEmpty() }
}

// The journal of one act opted into Undo, by its gesture id; `retained` while the product's stack still holds it.
internal class ReversibleAct(val actId: String, var retained: Boolean, var sourceEntries: List<SourceEntry>) {
    constructor(json: Json) : this(json.member("actId").str(), json.member("retained").bool(), json.items("sourceEntries").map(::SourceEntry))
    val json: Json get() = Json.objectOf("version" to Json.of(1), "actId" to Json.of(actId), "retained" to Json.of(retained),
        "sourceEntries" to Json.Arr(sourceEntries.map(SourceEntry::json)))
}

// Where the value a cancellation took out of `drawn` came from, which its Redo expects to find: a version accepted in an epoch, a
// pending entry's write, the slot unset in the record's birth, or the record wholly absent. A null epoch is the one the replica takes next.
internal sealed interface VersionReference {
    val json: Json
    data class Accepted(val epoch: String?, val version: SlotVersion) : VersionReference {
        override val json: Json get() = Json.objectOf("kind" to Json.of("accepted"), "epoch" to epoch.json, "version" to version.json)
    }
    data class Pending(val localId: String, val target: RecordSlot) : VersionReference {
        override val json: Json get() = Json.objectOf("kind" to Json.of("pending"), "localId" to Json.of(localId), "target" to target.json)
    }
    data class FieldAbsent(val epoch: String?, val recordBirth: VersionReference?) : VersionReference {
        override val json: Json get() = Json.objectOf("kind" to Json.of("fieldAbsent"), "epoch" to epoch.json, "recordBirth" to (recordBirth?.json ?: Json.Null))
    }
    data class RecordAbsent(val epoch: String?) : VersionReference {
        override val json: Json get() = Json.objectOf("kind" to Json.of("recordAbsent"), "epoch" to epoch.json)
    }
    // A pending entry acknowledged without a version for the target: its operation skips `reference-unbound`.
    data object Unbound : VersionReference {
        override val json: Json get() = Json.objectOf("kind" to Json.of("unbound"))
    }

    // The pending entries the reference waits on for their accepted versions.
    val waitsOn: List<String> get() = when (this) {
        is Pending -> listOf(localId)
        is FieldAbsent -> recordBirth?.waitsOn.orEmpty()
        else -> emptyList()
    }

    // §7.5 step 1: a reference taken before the replica held an epoch belongs to the epoch it then took.
    fun bound(epoch: String?): VersionReference = when (this) {
        is Accepted -> copy(epoch = this.epoch ?: epoch)
        is Pending -> this
        is FieldAbsent -> copy(epoch = this.epoch ?: epoch, recordBirth = recordBirth?.bound(epoch))
        is RecordAbsent -> copy(epoch = this.epoch ?: epoch)
        Unbound -> this
    }

    companion object {
        private val String?.json: Json get() = this?.let(Json::of) ?: Json.Null
        operator fun invoke(json: Json): VersionReference = when (json.member("kind").str()) {
            "accepted" -> Accepted(json.member("epoch").orNull()?.str(), SlotVersion(json.member("version")))
            "pending" -> Pending(json.member("localId").str(), RecordSlot(json.member("target")))
            "fieldAbsent" -> FieldAbsent(json.member("epoch").orNull()?.str(), json.member("recordBirth").orNull()?.let { VersionReference(it) })
            "unbound" -> Unbound
            else -> RecordAbsent(json.member("epoch").orNull()?.str())
        }
    }
}

// An operation a restore slot plans before it binds: a field back to `before`, a created record deleted again, or a record created
// again. A Redo's operations expect what their reference binds to; an Undo's expect the latest version the act owns.
internal sealed interface PlannedOperation {
    val record: RecordAddress
    val json: Json
    // A field back to `before`; a revived life also carries the record its preimage read (`drawn`).
    data class Field(val target: RecordSlot, val before: Json, val reference: VersionReference? = null, val drawn: Json? = null) : PlannedOperation {
        override val record: RecordAddress get() = target.record
        override val json: Json get() = Json.objectOf("kind" to Json.of("field"), "target" to target.json, "before" to before)
            .with("reference" to reference?.json, "record" to drawn)
    }
    data class CreatedRecord(override val record: RecordAddress) : PlannedOperation {
        override val json: Json get() = Json.objectOf("kind" to Json.of("createdRecord"), "record" to record.json)
    }
    data class CreateRecord(override val record: RecordAddress, val values: CreationValues, val reference: VersionReference) : PlannedOperation {
        override val json: Json get() = Json.objectOf("kind" to Json.of("createRecord"), "record" to record.json, "values" to values.json, "reference" to reference.json)
    }
    companion object {
        operator fun invoke(json: Json): PlannedOperation = when (json.member("kind").str()) {
            "field" -> Field(RecordSlot(json.member("target")), json.member("before"), json["reference"]?.let { VersionReference(it) }, json["record"])
            "createdRecord" -> CreatedRecord(RecordAddress(json.member("record")))
            else -> CreateRecord(RecordAddress(json.member("record")), CreationValues(json.member("values")), VersionReference(json.member("reference")))
        }
    }
}

// What an inverse slot runs: a restore of planned operations, a product inverse command, or nothing once a Discard withdrew its values.
internal sealed interface SlotRecipe {
    val command: String
    val json: Json
    // How many conditional operations its result reports: one a restore operation, one for an atomic product command.
    val count: Int
    data class Restore(override val command: String, val operations: List<PlannedOperation>) : SlotRecipe {
        override val count: Int get() = operations.size
        override val json: Json get() = Json.objectOf("kind" to Json.of("restore"), "command" to Json.of(command), "operations" to Json.Arr(operations.map(PlannedOperation::json)))
    }
    data class Product(val recipe: UndoRecipe.Product) : SlotRecipe {
        override val command: String get() = recipe.command
        override val count: Int get() = 1
        override val json: Json get() = recipe.json
    }
    data class Withdrawn(override val command: String) : SlotRecipe {
        override val count: Int get() = 1
        override val json: Json get() = Json.objectOf("kind" to Json.of("withdrawn"), "command" to Json.of(command))
    }
    companion object {
        operator fun invoke(json: Json): SlotRecipe = when (json.member("kind").str()) {
            "restore" -> Restore(json.member("command").str(), json.member("operations").arr().map { PlannedOperation(it) })
            "command" -> Product(UndoRecipe.read(json) as UndoRecipe.Product)
            else -> Withdrawn(json.member("command").str())
        }
    }
}

// One outbox entry an inverse request reserved in `originScope`: waiting for its sources, materialized with bound arguments, or settled.
// `skipped` holds the codes of the operations it skipped before sending.
internal class InverseSlot(val localId: String, val commitOrder: Long, var originScope: ScopeRef, var recipe: SlotRecipe, var state: String = "waiting",
    var skipped: List<String>? = null, var outcomes: List<InverseOutcome>? = null, var changed: Boolean? = null) {
    constructor(json: Json) : this(json.member("localId").str(), json.member("commitOrder").long(), ScopeRef(json.member("originScope")),
        SlotRecipe(json.member("recipe")), json.member("state").str(), json["skipped"]?.arr()?.map { it.member("code").str() },
        json["outcomes"]?.arr()?.map(::InverseOutcome), json["changed"]?.bool())
    val json: Json get() = Json.objectOf("localId" to Json.of(localId), "commitOrder" to Json.of(commitOrder), "originScope" to originScope.json,
        "recipe" to recipe.json, "state" to Json.of(state)).with("skipped" to skipped?.let { codes -> Json.Arr(codes.map { Json.objectOf("code" to Json.of(it)) }) },
        "outcomes" to outcomes?.let { Json.Arr(it.map(InverseOutcome::json)) }, "changed" to changed?.let(Json::of))

    // The slot's answer: its outcomes, or every operation skipped by `code`. A settled slot keeps no values: its recipe gives way to its
    // command's name.
    fun settle(answered: List<InverseOutcome>?, code: String? = null) {
        outcomes = answered ?: List(recipe.count) { InverseOutcome(it, code) }
        recipe = SlotRecipe.Withdrawn(recipe.command)
        state = "settled"
    }
}

// One Undo or Redo of an act, asked for at device time `requestedAt`, its slots in commit order.
internal class InverseRequest(val requestId: String, val sourceActId: String, val inverseActId: String, var state: String, val requestedAt: Long,
    val localChanged: Boolean?, var slots: List<InverseSlot>, var result: InverseResult? = null) {
    constructor(json: Json) : this(json.member("requestId").str(), json.member("sourceActId").str(), json.member("inverseActId").str(), json.member("state").str(),
        json.member("requestedAt").long(0), json["localChanged"]?.bool(), json.items("slots").map(::InverseSlot), json["result"]?.let { InverseResult(it) })
    val json: Json get() = Json.objectOf("version" to Json.of(1), "requestId" to Json.of(requestId), "sourceActId" to Json.of(sourceActId),
        "inverseActId" to Json.of(inverseActId), "state" to Json.of(state), "requestedAt" to Json.of(requestedAt), "slots" to Json.Arr(slots.map(InverseSlot::json)))
        .with("localChanged" to localChanged?.let(Json::of), "result" to result?.json)
    val answer: InverseResult get() = result ?: InverseResult.Pending(requestId, inverseActId, localChanged == true)
}

// What a held cancellation actually took out of `drawn`, kept for its Redo: a register the act wrote, or a record it created.
internal sealed interface CancellationUnit {
    val ownerLocalId: String
    val record: RecordAddress
    val restored: VersionReference
    val json: Json
    // A register the act wrote, the value it wrote, and what the cancellation left there: its version and, where set, its value.
    data class Field(override val ownerLocalId: String, val target: RecordSlot, val redoValue: Json, override val restored: VersionReference,
        val restoredValue: Json? = null) : CancellationUnit {
        override val record: RecordAddress get() = target.record
        override val json: Json get() = Json.objectOf("kind" to Json.of("field"), "ownerLocalId" to Json.of(ownerLocalId), "target" to target.json,
            "redoValue" to redoValue, "restored" to restored.json).with("restoredValue" to restoredValue)
    }
    data class CreatedRecord(override val ownerLocalId: String, override val record: RecordAddress, val redoValues: CreationValues,
        override val restored: VersionReference) : CancellationUnit {
        override val json: Json get() = Json.objectOf("kind" to Json.of("createdRecord"), "ownerLocalId" to Json.of(ownerLocalId), "record" to record.json,
            "redoValues" to redoValues.json, "restored" to restored.json)
    }
    companion object {
        operator fun invoke(json: Json): CancellationUnit = if (json.member("kind").str() == "field")
            Field(json.member("ownerLocalId").str(), RecordSlot(json.member("target")), json.member("redoValue"), VersionReference(json.member("restored")), json["restoredValue"])
            else CreatedRecord(json.member("ownerLocalId").str(), RecordAddress(json.member("record")), CreationValues(json.member("redoValues")), VersionReference(json.member("restored")))
    }
}

// One entry a held cancellation took out; `command` marks one that ran a product command, which has no generic Redo.
internal data class CancelledEntry(val localId: String, val originScope: ScopeRef, val command: Boolean) {
    constructor(json: Json) : this(json.member("localId").str(), ScopeRef(json.member("originScope")), json.flag("command"))
    val json: Json get() = Json.objectOf("localId" to Json.of(localId), "originScope" to originScope.json).with("command" to Json.of(true).takeIf { command })
}

// A held cancellation's receipt, by the inverse act a Redo names it with: the entries it took out and what they took out of `drawn`.
internal class CancellationReceipt(val inverseActId: String, val cancelledActId: String, var sourceEntries: List<CancelledEntry>, var units: List<CancellationUnit>,
    var retained: Boolean = true) {
    constructor(json: Json) : this(json.member("inverseActId").str(), json.member("cancelledActId").str(), json.items("sourceEntries").map(::CancelledEntry),
        json.items("units").map { CancellationUnit(it) }, json["retained"]?.bool() ?: true)
    val json: Json get() = Json.objectOf("version" to Json.of(1), "inverseActId" to Json.of(inverseActId), "cancelledActId" to Json.of(cancelledActId),
        "sourceEntries" to Json.Arr(sourceEntries.map(CancelledEntry::json)), "units" to Json.Arr(units.map(CancellationUnit::json))).with("retained" to Json.of(false).takeIf { !retained })
}

internal fun ReplicaState.sourceOf(localId: String): Pair<ReversibleAct, SourceEntry>? =
    journal.firstNotNullOfOrNull { act -> act.sourceEntries.firstOrNull { it.localId == localId }?.let { act to it } }

// The ACK transaction's retention point (§7.4): a source keeps its accepted receipt, or its refusal, under the answer's epoch, before its
// entry can settle or be collected. One attempt an epoch: a replay's replaces it. An `ok` without a readable receipt proves nothing of what
// the act wrote: the source's history is unavailable.
internal fun ReplicaState.retainOutcome(localId: String, attempt: Attempt) {
    val source = sourceOf(localId)?.second ?: return
    source.attempts = source.attempts.filter { it.epoch != attempt.epoch } + attempt
    if (attempt.ok && attempt.acceptedEffects == null) source.unavailable = true
}

// §7.3 Capture: the acknowledged entries with a receipt that write each record, in commit order, the only writes a capture's preimages can
// step over; an entry still unanswered is passed over before its deltas are read.
internal fun ReplicaState.acknowledgedWrites(): Map<RecordAddress, List<Entry>> {
    val writes = linkedMapOf<RecordAddress, MutableList<Entry>>()
    for (entry in entries()) {
        if (entry.state != "acked" || entry.acceptedEffects.isEmpty()) continue
        for (effect in entry.effects) for (delta in effect.deltas) {
            val record = writes.getOrPut(RecordAddress(effect.scope, delta.key)) { mutableListOf() }
            if (record.lastOrNull() !== entry) record.add(entry)
        }
    }
    return writes
}

// The ACK transaction's retention point, after the source's own: each preimage of another act's source entry still in the outbox after this
// entry in commit order was read over its write, and steps over it. An act's own segments come after its preimages were read.
internal fun ReplicaState.stepPreimagesOver(entry: Entry) {
    for (source in journal.filter { it.actId != entry.gestureId }.flatMap { it.sourceEntries }) {
        val later = entry(source.localId) ?: continue
        if (later.order > entry.order) source.preimages = source.preimages.map { it.steppedOver(entry) }
    }
}

// §7.5 step 1: a restored server invalidates each source's proofs from another epoch. A source still in the outbox replays and earns its
// own; a collected one has none left, and its history is unavailable.
internal fun ReplicaState.invalidateEpochs(epoch: String) {
    for (source in journal.flatMap { it.sourceEntries }) {
        if (entry(source.localId) == null && source.attempts.any { it.ok && it.epoch != epoch }) source.unavailable = true
        source.attempts = source.attempts.filter { it.epoch == epoch }
    }
}

// §7.10: a Discard of a product's work removes the journal's whole source entries of that product, values included, and its cancellations'
// units and inverse requests; a record left with nothing of its own goes. The discarded slots settle skipped first.
internal fun ReplicaState.discardJournal(registry: Registry, product: String) {
    fun theirs(scope: ScopeRef) = registry.product(scope) == product
    for (act in journal) act.sourceEntries = act.sourceEntries.filter { !theirs(it.originScope) }
    journal.removeAll { it.sourceEntries.isEmpty() }
    settleEnded("discarded")
    for (cancellation in cancellations) {
        cancellation.sourceEntries = cancellation.sourceEntries.filter { !theirs(it.originScope) }
        val kept = cancellation.sourceEntries.map { it.localId }.toSet()
        cancellation.units = cancellation.units.filter { it.ownerLocalId in kept }
    }
    val gone = cancellations.filter { it.sourceEntries.isEmpty() }.map { it.inverseActId }.toSet()
    cancellations.removeAll { it.inverseActId in gone }
    inverses.removeAll { request -> if (request.slots.isNotEmpty()) request.slots.all { theirs(it.originScope) } else request.inverseActId in gone }
}

// §7.5 step 2: a scope that ends (its `gone` or `not-found`, or a dead governing row) keeps none of its values in the journal. Its sources
// keep their receipts and become unavailable; a cancellation's units there go; a slot still waiting there vacates, skipped `scope-gone`.
internal fun ReplicaState.forgetJournalScope(scope: ScopeRef, ended: MutableList<Json>) {
    for (source in journal.flatMap { it.sourceEntries }.filter { it.originScope == scope }) {
        source.recipes = emptyList(); source.preimages = emptyList(); source.written = emptyList(); source.unavailable = true
    }
    for (cancellation in cancellations) cancellation.units = cancellation.units.filter { it.record.scope != scope }
    for (request in inverses.filter { it.state != "settled" }) {
        for (slot in request.slots.filter { it.state == "waiting" && it.originScope == scope }) {
            entry(slot.localId)?.let { move(it, "vacate", ended) }
            slot.settle(null, "scope-gone")
        }
        settleRequest(request)
    }
}

// §7.3 engine start: no product stack outlives its process, so every act and cancellation no unsettled request reads goes.
internal fun ReplicaState.releaseJournal() {
    journal.forEach { it.retained = false }
    cancellations.forEach { it.retained = false }
    collectJournal()
}

// An Add moves a replica's journal into another, keeping act and local ids.
internal fun ReplicaState.adoptJournal(source: ReplicaState) {
    journal.addAll(source.journal); inverses.addAll(source.inverses); cancellations.addAll(source.cancellations)
}

// The product's stack no longer needs the act. Its record goes unless an unsettled inverse still reads it; a cancellation's receipt and a
// settled request whose inverse act this is go with it.
internal fun ReplicaState.releaseReversibleAct(actId: String): Boolean {
    val act = journal.firstOrNull { it.actId == actId }
    val cancellation = cancellations.firstOrNull { it.inverseActId == actId }
    if (act == null && cancellation == null) return false
    act?.retained = false
    cancellation?.retained = false
    inverses.removeAll { it.state == "settled" && it.inverseActId == actId }
    collectJournal()
    return true
}

// The journal keeps acts the product's stack retains, acts an unsettled request inverts, and acts whose sources a kept cancellation's
// references wait on; cancellations stay while retained or redone.
internal fun ReplicaState.collectJournal() {
    val unsettled = inverses.filter { it.state != "settled" }.map { it.sourceActId }.toSet()
    cancellations.removeAll { !it.retained && it.inverseActId !in unsettled }
    val referenced = cancellations.flatMap { it.units }.flatMap { it.restored.waitsOn }.toSet()
    journal.removeAll { act -> !act.retained && act.actId !in unsettled && act.sourceEntries.none { it.localId in referenced } }
}

// A request settles once every slot has: changed is whether any slot's accepted effects changed a row, and the counts take every operation
// a slot sent and every one it skipped before sending.
internal fun ReplicaState.settleRequest(request: InverseRequest) {
    if (request.state == "settled" || request.slots.any { it.state != "settled" }) return
    val outcomes = request.slots.flatMap { slot -> slot.outcomes.orEmpty().map { it.applied } + slot.skipped.orEmpty().map { false } }
    request.state = "settled"
    request.result = InverseResult.Settled(request.requestId, request.inverseActId, request.slots.any { it.changed == true },
        outcomes.count { it }, outcomes.count { !it })
    collectJournal()
}

// The slots whose entries ended without a result (a fold, or a Discard) settle skipped by `code`.
internal fun ReplicaState.settleEnded(code: String) {
    for (request in inverses.filter { it.state != "settled" }) {
        for (slot in request.slots) {
            if (slot.state == "settled" || entry(slot.localId) != null) continue
            slot.settle(null, code)
        }
        settleRequest(request)
    }
}

// §7.7 write map and E-8: the journal, its inverse requests and its cancellations follow the same logical map as the queue. Each record a
// holder names is renamed in the scope it names, and a command input in the scope its holder had, before that scope moves. A value recorded
// for a field (a preimage, a written value, a default, an operation's earlier value, a redo value, a revival's registers) is renamed as that
// record's field would be, so a typed reference it holds follows the map too; a text or a life holds none.
internal fun Registry.remapJournal(replica: ReplicaState, map: RecordMap) {
    fun address(record: RecordAddress) = RecordAddress(references.remapRecord(record.scope, record.json, map)).let { it.copy(scope = map.scope(it.scope)) }
    fun target(target: RecordSlot) = RecordSlot(address(target.record), target.slot)
    fun registers(record: RecordAddress, fields: Json): Json = references.remapRecord(record.scope, record.json.with("f" to fields), map).member("f")
    fun value(target: RecordSlot, value: Json): Json = target.slot.name?.takeIf { target.slot.kind == Slot.Kind.field }
        ?.let { name -> registers(target.record, Json.objectOf(name to Json.array(value, Json.Null))).member(name).arr().first() } ?: value
    fun values(record: RecordAddress, values: Map<String, Json>): Map<String, Json> =
        registers(record, Json.Obj(values.map { (name, value) -> name to Json.array(value, Json.Null) })).obj().mapValues { it.value.arr().first() }
    fun drawn(target: RecordSlot, record: Json?): Json? = record?.let { read -> read["f"]?.let { read.with("f" to registers(target.record, it)) } ?: read }
    fun reference(named: VersionReference): VersionReference = when (named) {
        is VersionReference.Pending -> named.copy(target = target(named.target))
        is VersionReference.FieldAbsent -> named.copy(recordBirth = named.recordBirth?.let(::reference))
        else -> named
    }
    fun recipe(scope: ScopeRef, recipe: UndoRecipe): UndoRecipe = when (recipe) {
        is UndoRecipe.Fields -> recipe.copy(targets = recipe.targets.map { UndoRecipe.FieldTarget(target(it.target), it.defaultValue?.let { default -> value(it.target, default) }) })
        is UndoRecipe.CreatedRecord -> recipe.copy(record = address(recipe.record))
        is UndoRecipe.Product -> UndoRecipe.Product(recipe.command,
            references.remapCommand(scope, Json.objectOf("name" to Json.of(recipe.command), "args" to Json.objectOf("input" to recipe.input)), map).member("args").member("input"),
            EvidenceSelection(recipe.evidence.ownedFields.map(::target), recipe.evidence.unchangedCreatedRecords.map(::address), recipe.evidence.unchangedCreatedScopes.map(map::scope)))
    }
    fun slotRecipe(scope: ScopeRef, recipe: SlotRecipe): SlotRecipe = when (recipe) {
        is SlotRecipe.Restore -> recipe.copy(operations = recipe.operations.map { op -> when (op) {
            is PlannedOperation.Field -> PlannedOperation.Field(target(op.target), value(op.target, op.before), op.reference?.let(::reference), drawn(op.target, op.drawn))
            is PlannedOperation.CreatedRecord -> PlannedOperation.CreatedRecord(address(op.record))
            is PlannedOperation.CreateRecord -> PlannedOperation.CreateRecord(address(op.record),
                op.values.copy(fields = op.values.fields.takeIf { it.isNotEmpty() }?.let { values(op.record, it) }.orEmpty()), reference(op.reference))
        } })
        is SlotRecipe.Product -> SlotRecipe.Product(recipe(scope, recipe.recipe) as UndoRecipe.Product)
        is SlotRecipe.Withdrawn -> recipe
    }
    for (source in replica.journal.flatMap { it.sourceEntries }) {
        source.recipes = source.recipes.map { recipe(source.originScope, it) }
        source.originScope = map.scope(source.originScope)
        source.preimages = source.preimages.map { it.copy(target = target(it.target), value = value(it.target, it.value), drawn = drawn(it.target, it.drawn)) }
        source.written = source.written.map { Written(target(it.target), value(it.target, it.value)) }
        source.attempts = source.attempts.map { attempt -> attempt.copy(acceptedEffects = attempt.acceptedEffects?.map { effect ->
            EffectReceipt(map.scope(effect.scope), effect.beforeSeq, effect.seq, effect.rows.map { row -> EffectRow(references.remapRecord(effect.scope, row.json, map)) })
        }) }
    }
    for (slot in replica.inverses.flatMap { it.slots }) {
        slot.recipe = slotRecipe(slot.originScope, slot.recipe)
        slot.originScope = map.scope(slot.originScope)
    }
    for (cancellation in replica.cancellations) {
        cancellation.sourceEntries = cancellation.sourceEntries.map { it.copy(originScope = map.scope(it.originScope)) }
        cancellation.units = cancellation.units.map { unit -> when (unit) {
            is CancellationUnit.Field -> CancellationUnit.Field(unit.ownerLocalId, target(unit.target), value(unit.target, unit.redoValue), reference(unit.restored),
                unit.restoredValue?.let { value(unit.target, it) })
            is CancellationUnit.CreatedRecord -> CancellationUnit.CreatedRecord(unit.ownerLocalId, address(unit.record),
                unit.redoValues.copy(fields = unit.redoValues.fields.takeIf { it.isNotEmpty() }?.let { values(unit.record, it) }.orEmpty()), reference(unit.restored))
        } }
    }
}
