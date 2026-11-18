package works.windmill.sync.engine

import works.windmill.sync.api.InverseResult
import works.windmill.sync.core.*

// K-3 the journal of reversible acts (§7.3 Undo of an act): each act's source entries with their recipes, first local preimages and
// the receipts or refusals their ACK transactions record, beside the inverse requests and cancellation receipts that read them; their
// retention, epochs, lifecycle and settlement. The journal is the replica's local user data: its values and ids never leave the device
// but in a restore's own arguments, and never enter telemetry.

// A local id's ordinal: its position in its act's commit order.
internal fun ordinalOf(localId: String): Int = localId.substringAfterLast('/').toInt()

internal data class Preimage(val target: RecordSlot, val value: Json) {
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

// An act's entry, as its segment left it: the recipes that undo it, the values its targets read before the act, and its answers.
// `unavailable` marks a source whose history an epoch change took.
internal class SourceEntry(val localId: String, var originScope: ScopeRef, var recipes: List<UndoRecipe>, var preimages: List<Preimage>,
    var attempts: List<Attempt> = emptyList(), var unavailable: Boolean = false) {
    constructor(json: Json) : this(json.member("localId").str(), ScopeRef(json.member("originScope")), json.items("recipes").map(UndoRecipe::read),
        json.items("preimages").map(::Preimage), json.items("attempts").map(::Attempt), json.flag("unavailable"))
    val json: Json get() = Json.objectOf("localId" to Json.of(localId), "originScope" to originScope.json, "recipes" to Json.Arr(recipes.map(UndoRecipe::json)),
        "preimages" to Json.Arr(preimages.map(Preimage::json)), "attempts" to Json.Arr(attempts.map(Attempt::json))).with("unavailable" to Json.of(true).takeIf { unavailable })
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
    }

    companion object {
        private val String?.json: Json get() = this?.let(Json::of) ?: Json.Null
        operator fun invoke(json: Json): VersionReference = when (json.member("kind").str()) {
            "accepted" -> Accepted(json.member("epoch").orNull()?.str(), SlotVersion(json.member("version")))
            "pending" -> Pending(json.member("localId").str(), RecordSlot(json.member("target")))
            "fieldAbsent" -> FieldAbsent(json.member("epoch").orNull()?.str(), json.member("recordBirth").orNull()?.let { VersionReference(it) })
            else -> RecordAbsent(json.member("epoch").orNull()?.str())
        }
    }
}

// An operation a restore slot plans before it binds: a field back to `before`, a created record deleted again, or a record created
// again. A Redo's operations expect what their reference binds to; an Undo's expect the latest version the act owns.
internal sealed interface PlannedOperation {
    val record: RecordAddress
    val json: Json
    data class Field(val target: RecordSlot, val before: Json, val reference: VersionReference? = null) : PlannedOperation {
        override val record: RecordAddress get() = target.record
        override val json: Json get() = Json.objectOf("kind" to Json.of("field"), "target" to target.json, "before" to before).with("reference" to reference?.json)
    }
    data class CreatedRecord(override val record: RecordAddress) : PlannedOperation {
        override val json: Json get() = Json.objectOf("kind" to Json.of("createdRecord"), "record" to record.json)
    }
    data class CreateRecord(override val record: RecordAddress, val values: CreationValues, val reference: VersionReference) : PlannedOperation {
        override val json: Json get() = Json.objectOf("kind" to Json.of("createRecord"), "record" to record.json, "values" to values.json, "reference" to reference.json)
    }
    companion object {
        operator fun invoke(json: Json): PlannedOperation = when (json.member("kind").str()) {
            "field" -> Field(RecordSlot(json.member("target")), json.member("before"), json["reference"]?.let { VersionReference(it) })
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

// One outbox entry an inverse request reserved: waiting for its sources, materialized with bound arguments, or settled.
internal class InverseSlot(val localId: String, val commitOrder: Long, var recipe: SlotRecipe, var state: String = "waiting",
    var outcomes: List<InverseOutcome>? = null, var changed: Boolean? = null) {
    constructor(json: Json) : this(json.member("localId").str(), json.member("commitOrder").long(), SlotRecipe(json.member("recipe")), json.member("state").str(),
        json["outcomes"]?.arr()?.map(::InverseOutcome), json["changed"]?.bool())
    val json: Json get() = Json.objectOf("localId" to Json.of(localId), "commitOrder" to Json.of(commitOrder), "recipe" to recipe.json, "state" to Json.of(state))
        .with("outcomes" to outcomes?.let { Json.Arr(it.map(InverseOutcome::json)) }, "changed" to changed?.let(Json::of))

    // The slot's answer: its outcomes, or every operation skipped by `code`.
    fun settle(answered: List<InverseOutcome>?, code: String? = null) {
        outcomes = answered ?: List(recipe.count) { InverseOutcome(it, code) }
        state = "settled"
    }
}

// One Undo or Redo of an act, its slots in commit order.
internal class InverseRequest(val requestId: String, val sourceActId: String, val inverseActId: String, var state: String, val localChanged: Boolean?,
    val slots: List<InverseSlot>, var result: InverseResult? = null) {
    constructor(json: Json) : this(json.member("requestId").str(), json.member("sourceActId").str(), json.member("inverseActId").str(), json.member("state").str(),
        json["localChanged"]?.bool(), json.items("slots").map(::InverseSlot), json["result"]?.let { InverseResult(it) })
    val json: Json get() = Json.objectOf("version" to Json.of(1), "requestId" to Json.of(requestId), "sourceActId" to Json.of(sourceActId),
        "inverseActId" to Json.of(inverseActId), "state" to Json.of(state), "slots" to Json.Arr(slots.map(InverseSlot::json)))
        .with("localChanged" to localChanged?.let(Json::of), "result" to result?.json)
    val answer: InverseResult get() = result ?: InverseResult.Pending(requestId, inverseActId, localChanged == true)
}

// What a held cancellation actually took out of `drawn`, kept for its Redo: a register the act wrote, or a record it created.
internal sealed interface CancellationUnit {
    val ownerLocalId: String
    val record: RecordAddress
    val restored: VersionReference
    val json: Json
    data class Field(override val ownerLocalId: String, val target: RecordSlot, val redoValue: Json, override val restored: VersionReference) : CancellationUnit {
        override val record: RecordAddress get() = target.record
        override val json: Json get() = Json.objectOf("kind" to Json.of("field"), "ownerLocalId" to Json.of(ownerLocalId), "target" to target.json,
            "redoValue" to redoValue, "restored" to restored.json)
    }
    data class CreatedRecord(override val ownerLocalId: String, override val record: RecordAddress, val redoValues: CreationValues,
        override val restored: VersionReference) : CancellationUnit {
        override val json: Json get() = Json.objectOf("kind" to Json.of("createdRecord"), "ownerLocalId" to Json.of(ownerLocalId), "record" to record.json,
            "redoValues" to redoValues.json, "restored" to restored.json)
    }
    companion object {
        operator fun invoke(json: Json): CancellationUnit = if (json.member("kind").str() == "field")
            Field(json.member("ownerLocalId").str(), RecordSlot(json.member("target")), json.member("redoValue"), VersionReference(json.member("restored")))
            else CreatedRecord(json.member("ownerLocalId").str(), RecordAddress(json.member("record")), CreationValues(json.member("redoValues")), VersionReference(json.member("restored")))
    }
}

// A held cancellation's receipt, by the inverse act a Redo names it with.
internal class CancellationReceipt(val inverseActId: String, val cancelledActId: String, var units: List<CancellationUnit>, var retained: Boolean = true) {
    constructor(json: Json) : this(json.member("inverseActId").str(), json.member("cancelledActId").str(), json.items("units").map { CancellationUnit(it) },
        json["retained"]?.bool() ?: true)
    val json: Json get() = Json.objectOf("version" to Json.of(1), "inverseActId" to Json.of(inverseActId), "cancelledActId" to Json.of(cancelledActId),
        "units" to Json.Arr(units.map(CancellationUnit::json))).with("retained" to Json.of(false).takeIf { !retained })
}

internal fun ReplicaState.sourceOf(localId: String): Pair<ReversibleAct, SourceEntry>? =
    journal.firstNotNullOfOrNull { act -> act.sourceEntries.firstOrNull { it.localId == localId }?.let { act to it } }

// The ACK transaction's retention point (§7.4): a source keeps its accepted receipt, or its refusal, under the answer's epoch, before its
// entry can settle or be collected. One attempt an epoch: a replay's replaces it.
internal fun ReplicaState.retainOutcome(localId: String, attempt: Attempt) {
    val source = sourceOf(localId)?.second ?: return
    source.attempts = source.attempts.filter { it.epoch != attempt.epoch } + attempt
}

// §7.5 step 1: a restored server invalidates each source's proofs from another epoch. A source still in the outbox replays and earns its
// own; a collected one has none left, and its history is unavailable.
internal fun ReplicaState.invalidateEpochs(epoch: String) {
    for (source in journal.flatMap { it.sourceEntries }) {
        if (entry(source.localId) == null && source.attempts.any { it.ok && it.epoch != epoch }) source.unavailable = true
        source.attempts = source.attempts.filter { it.epoch == epoch }
    }
}

// §7.10: a Discard of a product's work removes the journal's whole source entries of that product, values included; an act left with none goes.
internal fun ReplicaState.discardJournal(registry: Registry, product: String) {
    for (act in journal) act.sourceEntries = act.sourceEntries.filter { registry.product(it.originScope) != product }
    journal.removeAll { it.sourceEntries.isEmpty() }
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

// A request settles once every slot has: changed is whether any slot's accepted effects changed a row.
internal fun ReplicaState.settleRequest(request: InverseRequest) {
    if (request.state == "settled" || request.slots.any { it.state != "settled" }) return
    val outcomes = request.slots.flatMap { it.outcomes.orEmpty() }
    request.state = "settled"
    request.result = InverseResult.Settled(request.requestId, request.inverseActId, request.slots.any { it.changed == true },
        outcomes.count { it.applied }, outcomes.count { !it.applied })
    collectJournal()
}

// The slots whose entries ended without a result (a fold, or a Discard) settle skipped by `code`. A Discard also withdraws their values:
// the slot keeps only its outcomes.
internal fun ReplicaState.settleEnded(code: String, withdraw: Boolean = false) {
    for (request in inverses.filter { it.state != "settled" }) {
        for (slot in request.slots) {
            if (slot.state == "settled" || entry(slot.localId) != null) continue
            slot.settle(null, code)
            if (withdraw) slot.recipe = SlotRecipe.Withdrawn(slot.recipe.command)
        }
        settleRequest(request)
    }
}

// §7.7 write map and E-8: the journal's scoped references follow the same logical map as the queue.
internal fun Registry.remapJournal(replica: ReplicaState, map: RecordMap) {
    fun address(record: RecordAddress) = RecordAddress(references.remapRecord(record.scope, record.json, map)).let { it.copy(scope = map.scope(it.scope)) }
    fun target(target: RecordSlot) = RecordSlot(address(target.record), target.slot)
    for (source in replica.journal.flatMap { it.sourceEntries }) {
        val origin = source.originScope
        source.originScope = map.scope(origin)
        source.recipes = source.recipes.map { recipe -> when (recipe) {
            is UndoRecipe.Fields -> recipe.copy(targets = recipe.targets.map { it.copy(target = target(it.target)) })
            is UndoRecipe.CreatedRecord -> recipe.copy(record = address(recipe.record))
            is UndoRecipe.Product -> UndoRecipe.Product(recipe.command,
                references.remapCommand(origin, Json.objectOf("name" to Json.of(recipe.command), "args" to Json.objectOf("input" to recipe.input)), map).member("args").member("input"),
                EvidenceSelection(recipe.evidence.ownedFields.map(::target), recipe.evidence.unchangedCreatedRecords.map(::address), recipe.evidence.unchangedCreatedScopes.map(map::scope)))
        } }
        source.preimages = source.preimages.map { it.copy(target = target(it.target)) }
        source.attempts = source.attempts.map { attempt -> attempt.copy(acceptedEffects = attempt.acceptedEffects?.map { effect ->
            EffectReceipt(map.scope(effect.scope), effect.beforeSeq, effect.seq, effect.rows.map { row -> EffectRow(references.remapRecord(effect.scope, row.json, map)) })
        }) }
    }
}
