package works.windmill.domain.kit

import works.windmill.sync.api.ActCommitOutcome
import works.windmill.sync.api.CommitContext
import works.windmill.sync.api.CommitFailure
import works.windmill.sync.api.CommitOutcome
import works.windmill.sync.api.CommitReceipt
import works.windmill.sync.api.InverseResult
import works.windmill.sync.api.Record
import works.windmill.sync.api.RecordID
import works.windmill.sync.api.RecordRef
import works.windmill.sync.api.Replica
import works.windmill.sync.api.UndoSegment
import works.windmill.sync.core.Json
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.core.Registry
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.core.lives

interface Decider<L, T, R> {
    val scope: ScopeRef
    val refusals: Refusals<R>
    // §9.6: a reversible action runs through the one-segment act path, so its plan may opt into Undo after its hold.
    val reversible: Boolean get() = false
    fun load(read: Reader): L
    fun decide(loaded: L, ids: IDSource): Decision<T, R>
    fun decision(loaded: L, ids: IDSource): Decision<T, R> =
        try { decide(loaded, ids) } catch (violation: Violation) { Decision.Refuse(refusals.of(violation)) }
}

interface Action<L, T, R> : Decider<L, T, R>

sealed interface Decision<out T, out R> {
    data class Write<T>(val plan: Plan, val result: T) : Decision<T, Nothing>
    data class Unchanged<T>(val result: T) : Decision<T, Nothing>
    data class Refuse<R>(val refusal: R) : Decision<Nothing, R>
}

sealed interface Outcome<out T, out R> {
    data class Committed<T>(val result: T, override val receipt: CommitReceipt) : Outcome<T, Nothing>
    data class Unchanged<T>(val result: T) : Outcome<T, Nothing>
    data class Refused<R>(val refusal: R) : Outcome<Nothing, R>
    val receipt: CommitReceipt? get() = null
}

val <T, R> Outcome<T, R>.refusal: R? get() = (this as? Outcome.Refused<R>)?.refusal

class ProgrammingFault(message: String, cause: Exception) : IllegalStateException(message, cause)

class IDSource internal constructor(private val opaque: () -> String, private val minting: (String) -> RecordID) {
    constructor(context: CommitContext) : this(context::opaqueID, context::mintID)
    fun opaqueID(): String = try { opaque() }
        catch (failure: Exception) { throw ProgrammingFault("minting an opaque identity failed", failure) }
    fun <E : Entity<E>> mint(type: EntityType<E>): Id<E> = try { Id(minting(type.type), type) }
        catch (failure: Exception) { throw ProgrammingFault("minting an entity identity failed", failure) }
}

interface ActionContext {
    var insideRun: Boolean
}

/** The caller injects its coroutine-context element; runners in that context share the nesting flag. */
class ActionRunner(private val replica: Replica, val registry: Registry, private val zone: Zone,
    private val context: ActionContext) {
    fun <L, T, R> run(action: Action<L, T, R>): Outcome<T, R> = perform(action)
    // One decider's run: a reversible one through the one-segment act path, so its receipt's gesture id is the act an Undo names (§9.6),
    // and any other as one commit.
    internal fun <L, T, R> perform(decider: Decider<L, T, R>): Outcome<T, R> {
        if (!decider.reversible) return commitOne(decider)
        val scope = decider.scope
        val outcome = runAct(object : ActAction<L, T, R> {
            override val refusals = decider.refusals
            override fun load(read: ActReader): L = read.inScope(scope, decider::load)
            override fun decide(loaded: L, ids: ActIDSource): ActDecision<T, R> = when (val decided = decider.decision(loaded, ids.inScope(scope))) {
                is Decision.Write -> ActDecision.Write(ActPlan(listOf(ScopedPlan(scope, decided.plan))), decided.result)
                is Decision.Unchanged -> ActDecision.Unchanged(decided.result)
                is Decision.Refuse -> ActDecision.Refuse(decided.refusal)
            }
        })
        return when (outcome) {
            is ActOutcome.Committed -> outcome.receipt.let { receipt ->
                val segment = receipt.segments.single()
                Outcome.Committed(outcome.result, CommitReceipt(receipt.gestureId, checkNotNull(segment.stamp), segment.localIds, segment.ids, receipt.releaseAt,
                    receipt.retired, receipt.superseded))
            }
            is ActOutcome.Unchanged -> Outcome.Unchanged(outcome.result)
            is ActOutcome.Refused -> Outcome.Refused(outcome.refusal)
        }
    }
    fun <L, T, R> runAct(action: ActAction<L, T, R>): ActOutcome<T, R> {
        check(!context.insideRun) { "a run cannot enter inside a run" }
        context.insideRun = true
        try {
            val committed = replica.commitAct<ActStep<T, R>>({ source ->
                when (val decision = action.decision(source, registry, Moment(Instant(source.now), zone))) {
                    is ActDecision.Refuse -> null to ActStep.Done(ActOutcome.Refused(decision.refusal))
                    is ActDecision.Unchanged -> null to ActStep.Done(ActOutcome.Unchanged(decision.result))
                    is ActDecision.Write -> decision.plan.request() to ActStep.Writing(decision.plan, decision.result)
                }
            }, { step, index, source ->
                check(step is ActStep.Writing)
                step.plan.segments[index].gesture(source, registry)
            })
            return when (val step = committed.second) {
                is ActStep.Done -> step.outcome
                is ActStep.Writing -> when (val outcome = committed.first) {
                    is ActCommitOutcome.Committed -> ActOutcome.Committed(step.result, outcome.receipt)
                    is ActCommitOutcome.Refused -> ActOutcome.Refused(action.refusals.of(step.plan.segments[outcome.segment].plan.refused(outcome.code, outcome.detail, registry)))
                    null -> ActOutcome.Unchanged(step.result)
                }
            }
        } catch (prediction: ActPrediction) { return ActOutcome.Refused(action.refusals.of(prediction.refusal)) }
        catch (failure: CommitFailure) {
            if (failure.kind == CommitFailure.Kind.malformed) throw ProgrammingFault("a malformed act is a programming fault", failure)
            throw failure
        } finally { context.insideRun = false }
    }
    // §9.7: several acts as one. Each part loads through the segments of the parts before it, which the engine stages on the act's tentative
    // copy, and then decides. A part's refusal, a failed check, a gone record or a segment the engine would refuse refuses the whole act, in
    // that part's words, before anything is written. The parts' segments commit as one act: one gesture id, one hold, held when any part's
    // plan holds, and one Undo carrying every part's recipes.
    fun <R> runComposed(parts: List<ActAction<*, *, R>>): ComposedOutcome<R> {
        require(parts.isNotEmpty()) { "a composed act has parts" }
        check(!context.insideRun) { "a run cannot enter inside a run" }
        context.insideRun = true
        fun refused(part: Int, refusal: Refused) = ComposedOutcome.Refused(part, parts[part].refusals.of(refusal))
        try {
            val committed = replica.commitAct<ComposedStep<R>>({ source ->
                val moment = Moment(Instant(source.now), zone)
                val results = mutableListOf<Any?>()
                val segments = mutableListOf<PartSegment>()
                for ((part, action) in parts.withIndex()) {
                    if (part > 0) source.beginPart()
                    val plan = when (val decision = action.decision(source, registry, moment)) {
                        is ActDecision.Refuse -> return@commitAct null to ComposedStep.Done(ComposedOutcome.Refused(part, decision.refusal))
                        is ActDecision.Unchanged -> { results.add(decision.result); continue }
                        is ActDecision.Write -> { results.add(decision.result); decision.plan }
                    }
                    for (scoped in plan.segments) {
                        val staged = try { source.stage(scoped.scope) { scoped.gesture(it, registry) } }
                            catch (prediction: ActPrediction) { return@commitAct null to ComposedStep.Done(refused(part, prediction.refusal)) }
                        if (staged != null) return@commitAct null to ComposedStep.Done(refused(part, scoped.plan.refused(staged.code, staged.detail, registry)))
                        segments.add(PartSegment(part, scoped))
                    }
                }
                if (segments.isEmpty()) null to ComposedStep.Done(ComposedOutcome.Unchanged(results))
                else ActPlan(segments.map { it.scoped }).request() to ComposedStep.Writing(segments, results)
            }, { step, index, source ->
                check(step is ComposedStep.Writing)
                val segment = step.segments[index]
                try { segment.scoped.gesture(source, registry) }
                catch (prediction: ActPrediction) { throw ActPrediction(prediction.refusal, segment.part) }
            })
            return when (val step = committed.second) {
                is ComposedStep.Done -> step.outcome
                is ComposedStep.Writing -> when (val outcome = committed.first) {
                    is ActCommitOutcome.Committed -> ComposedOutcome.Committed(step.results, outcome.receipt)
                    is ActCommitOutcome.Refused -> step.segments[outcome.segment].let { (part, scoped) ->
                        refused(part, scoped.plan.refused(outcome.code, outcome.detail, registry)) }
                    null -> ComposedOutcome.Unchanged(step.results)
                }
            }
        } catch (prediction: ActPrediction) { return refused(prediction.part, prediction.refusal) }
        catch (failure: CommitFailure) {
            if (failure.kind == CommitFailure.Kind.malformed) throw ProgrammingFault("a malformed act is a programming fault", failure)
            throw failure
        } finally { context.insideRun = false }
    }
    fun <T> read(scope: ScopeRef, body: (Reader) -> T): T {
        val moment = moment()
        return replica.read(scope) { body(Reader(it, scope, moment, registry)) }
    }
    // Engine §7.3: cancels a gesture while every entry of it is still held; true iff it did.
    fun cancelHeld(gestureId: String): Boolean = replica.cancelHeld(gestureId)
    // §9.6: the inverse of an act opted into Undo. A wholly held act is cancelled in place; otherwise the inverse is reserved at once and
    // settles as its sources do.
    fun undo(actId: String): InverseResult = replica.requestInverse(actId)
    // The inverse of an Undo, restoring only what it applied, or what `productSlots` name instead (a product's Redo of a terminal creation).
    fun redo(requestId: String, productSlots: List<ProductSlot>? = null): InverseResult {
        val inverseActId = when (val undone = inverseResult(requestId)) {
            is InverseResult.Unavailable -> return undone
            is InverseResult.Cancelled -> undone.inverseActId
            is InverseResult.Pending -> undone.inverseActId
            is InverseResult.Settled -> undone.inverseActId
        }
        return replica.requestInverse(inverseActId, productSlots?.map { slot -> slot.plan.undoSegment(slot.index, slot.scope) ?: UndoSegment(slot.index, emptyList()) })
    }
    fun inverseResult(requestId: String): InverseResult = replica.readInverseResult(requestId)
    // The product's stack no longer holds the act: its journal record and values go.
    fun release(actId: String) { replica.releaseReversibleAct(actId) }
    fun <E : Entity<E>> mint(type: EntityType<E>, scope: ScopeRef = type.boundScope()): Id<E> {
        type.boundScope(scope)
        check(registry.lives(type.type, scope)) { "${type.type} is outside $scope" }
        return try { Id(replica.mintID(type.type), type) }
        catch (failure: Exception) { throw ProgrammingFault("minting an entity identity failed", failure) }
    }
    fun moment(): Moment = Moment(Instant(replica.physNow()), zone)

    private fun <L, T, R> commitOne(decider: Decider<L, T, R>): Outcome<T, R> {
        check(!context.insideRun) { "a run cannot enter inside a run" }
        context.insideRun = true
        try {
            val committed: Pair<CommitOutcome?, Step<T, R>> = try {
                replica.commit(decider.scope) { context ->
                    val reader = Reader(context, decider.scope, Moment(Instant(context.now), zone), registry)
                    when (val decision = decider.decision(decider.load(reader), IDSource(context))) {
                        is Decision.Refuse -> null to Step.Done(Outcome.Refused(decision.refusal))
                        is Decision.Unchanged -> null to Step.Done(Outcome.Unchanged(decision.result))
                        is Decision.Write -> {
                            if (decision.plan.undo != null) throw PlanError(10, "only a reversible action opts its plan into Undo")
                            val gone = decision.plan.firstGone(context, decider.scope, registry)
                            if (gone != null) null to Step.Done(Outcome.Refused(decider.refusals.of(gone)))
                            else decision.plan.gesture(decider.scope, registry) to Step.Writing(decision.plan, decision.result)
                        }
                    }
                }
            } catch (failure: CommitFailure) {
                if (failure.kind == CommitFailure.Kind.malformed) throw ProgrammingFault("a malformed commit is a programming fault", failure)
                throw failure
            }
            val outcome = committed.first
            if (outcome is CommitOutcome.Refused) outcome.notice?.let { replica.dismissNotice(it) }
            return when (val step = committed.second) {
                is Step.Done -> step.outcome
                is Step.Writing -> when (outcome) {
                    is CommitOutcome.Committed -> {
                        val receipt = outcome.receipt
                        val wroteNothing = receipt.localIds.isEmpty() && receipt.retired.isEmpty() &&
                            receipt.superseded.isEmpty() && step.plan.deviceWrites.isEmpty()
                        if (wroteNothing) Outcome.Unchanged(step.result) else Outcome.Committed(step.result, receipt)
                    }
                    is CommitOutcome.Refused -> Outcome.Refused(decider.refusals.of(step.plan.refused(outcome.code, outcome.detail, registry)))
                    null -> error("the engine answered a gesture without an outcome")
                }
            }
        } finally { context.insideRun = false }
    }
}

private sealed interface Step<out T, out R> {
    data class Done<T, R>(val outcome: Outcome<T, R>) : Step<T, R>
    data class Writing<T>(val plan: Plan, val result: T) : Step<T, Nothing>
}

// §9.2 step 5: an update, removal or move of a type with life needs its record alive in `drawn`; a revival, a known born, the drawn record's or,
// where `drawn` holds none, its spent id's; an insert or move, its anchor listed in `drawn` or `stored` (engine D-25).
fun Plan.firstGone(context: CommitContext, scope: ScopeRef, registry: Registry): Refused? {
    for (operation in operations.filter { registry.lives(it.entity.type, scope) }) {
        val definition = registry.type(operation.entity.type)
        if (operation.kind is Operation.Kind.Revive && definition?.hasBorn == true && definition.json["revivable"]?.bool() == true) {
            val drawn = context.drawn(operation.entity.type, operation.id)
            val born = if (drawn == null) context.spentBorn(operation.entity.type, operation.id) else drawn.born
            if (born == null) return Refused(RefusalCode.unknownRecord, operation.ref, path = Refused.Path.predicted)
        }
        val needsLife = operation.kind is Operation.Kind.Update || operation.kind == Operation.Kind.Remove || operation.kind is Operation.Kind.Move
        if (needsLife && definition?.life == true && context.drawn(operation.entity.type, operation.id)?.life?.isAlive != true) {
            return Refused(RefusalCode.unknownRecord, operation.ref, path = Refused.Path.predicted)
        }
        val anchor = operation.anchor
        val order = operation.entity.orderField
        if (anchor != null && order != null && !isListed(context.drawn(operation.entity.type, anchor), order) && !isListed(context.stored(operation.entity.type, anchor), order)) {
            return Refused(RefusalCode.unknownRecord, RecordRef(operation.entity.type, anchor), path = Refused.Path.predicted)
        }
    }
    return null
}

private fun isListed(record: Record?, orderField: String): Boolean = record?.isVisible == true && record.values[orderField] is Json.Str

// An engine refusal of a plan's segment, as the kit names it.
internal fun Plan.refused(code: RefusalCode, detail: Json?, registry: Registry) = Refused(code, subjectOfRefusal(code, detail, registry), detail, Refused.Path.predicted)

fun Plan.subjectOfRefusal(code: RefusalCode, detail: Json?, registry: Registry): RecordRef? {
    val writing = operations.filter { it.writes }
    if (code == RefusalCode.cap) {
        val type = (detail?.get("type") as? Json.Str)?.value
        writing.firstOrNull { it.creates && it.entity.type == type }?.let { return RecordRef(it.entity.type, it.recordID(registry)) }
    }
    return writing.firstOrNull()?.let { RecordRef(it.entity.type, it.recordID(registry)) }
}
