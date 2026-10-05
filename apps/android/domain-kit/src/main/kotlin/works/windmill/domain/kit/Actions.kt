package works.windmill.domain.kit

import works.windmill.sync.api.CommitContext
import works.windmill.sync.api.CommitFailure
import works.windmill.sync.api.CommitOutcome
import works.windmill.sync.api.CommitReceipt
import works.windmill.sync.api.Record
import works.windmill.sync.api.RecordRef
import works.windmill.sync.api.Replica
import works.windmill.sync.core.Json
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.core.Registry
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.core.lives

interface Decider<L, T, R> {
    val scope: ScopeRef
    val refusals: Refusals<R>
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

class IDSource(val context: CommitContext) {
    fun opaqueID(): String = try { context.opaqueID() }
        catch (failure: Exception) { throw ProgrammingFault("minting an opaque identity failed", failure) }
    fun <E : Entity<E>> mint(type: EntityType<E>): Id<E> = try { Id(context.mintID(type.type), type) }
        catch (failure: Exception) { throw ProgrammingFault("minting an entity identity failed", failure) }
}

interface ActionContext {
    var insideRun: Boolean
}

/** The caller injects its coroutine-context element; runners in that context share the nesting flag. */
class ActionRunner(private val replica: Replica, val registry: Registry, private val zone: Zone,
    private val context: ActionContext) {
    fun <L, T, R> run(action: Action<L, T, R>): Outcome<T, R> = perform(action)
    fun <T> read(scope: ScopeRef, body: (Reader) -> T): T {
        val moment = moment()
        return replica.read(scope) { body(Reader(it, scope, moment, registry)) }
    }
    fun undo(gestureId: String): Boolean = replica.undo(gestureId)
    fun <E : Entity<E>> mint(type: EntityType<E>): Id<E> = try { Id(replica.mintID(type.type), type) }
        catch (failure: Exception) { throw ProgrammingFault("minting an entity identity failed", failure) }
    fun moment(): Moment = Moment(Instant(replica.physNow()), zone)

    internal fun <L, T, R> perform(decider: Decider<L, T, R>): Outcome<T, R> {
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
                    is CommitOutcome.Refused -> Outcome.Refused(decider.refusals.of(Refused(outcome.code,
                        step.plan.subjectOfRefusal(outcome.code, outcome.detail, registry), outcome.detail, Refused.Path.predicted)))
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

fun Plan.firstGone(context: CommitContext, scope: ScopeRef, registry: Registry): Refused? {
    for (operation in operations.filter { registry.lives(it.entity.type, scope) }) {
        val needsLife = operation.kind is Operation.Kind.Update || operation.kind == Operation.Kind.Remove || operation.kind is Operation.Kind.Move
        if (needsLife && registry.type(operation.entity.type)?.life == true && context.drawn(operation.entity.type, operation.id)?.life?.isAlive != true) {
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

fun Plan.subjectOfRefusal(code: RefusalCode, detail: Json?, registry: Registry): RecordRef? {
    val writing = operations.filter { it.writes }
    if (code == RefusalCode.cap) {
        val type = (detail?.get("type") as? Json.Str)?.value
        writing.firstOrNull { it.creates && it.entity.type == type }?.let { return RecordRef(it.entity.type, it.recordID(registry)) }
    }
    return writing.firstOrNull()?.let { RecordRef(it.entity.type, it.recordID(registry)) }
}
