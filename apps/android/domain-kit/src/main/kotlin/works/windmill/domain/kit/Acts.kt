package works.windmill.domain.kit

import works.windmill.sync.api.ActContext
import works.windmill.sync.api.ActReceipt
import works.windmill.sync.api.ActRequest
import works.windmill.sync.api.CommitContext
import works.windmill.sync.api.Gesture
import works.windmill.sync.core.Registry
import works.windmill.sync.core.ScopeRef

data class ScopedPlan(val scope: ScopeRef, val plan: Plan) {
    // The segment's gesture over the views through the act's earlier segments; a gone record refuses it.
    internal fun gesture(over: CommitContext, registry: Registry): Gesture {
        plan.firstGone(over, scope, registry)?.let { throw ActPrediction(it) }
        return plan.gesture(scope, registry)
    }
}
// §9.6: a product's Redo slot, replacing the recipes of the inverse act's source `index`, which wrote `scope`.
data class ProductSlot(val index: Int, val scope: ScopeRef, val plan: Plan)
class ActPlan(segments: List<ScopedPlan>) {
    val segments: List<ScopedPlan> = segments.toList()
    // The engine's request for these segments: their scopes in order, one hold when any plan holds, and each opted segment's Undo by its index.
    internal fun request() = ActRequest(segments.map { it.scope }, segments.any { it.plan.isHeld },
        undo = segments.mapIndexedNotNull { index, segment -> segment.plan.undoSegment(index, segment.scope) }.takeIf { it.isNotEmpty() })
}

interface ActAction<L, T, R> {
    val refusals: Refusals<R>
    fun load(read: ActReader): L
    fun decide(loaded: L, ids: ActIDSource): ActDecision<T, R>
}
sealed interface ActDecision<out T, out R> {
    data class Write<T>(val plan: ActPlan, val result: T) : ActDecision<T, Nothing>
    data class Unchanged<T>(val result: T) : ActDecision<T, Nothing>
    data class Refuse<R>(val refusal: R) : ActDecision<Nothing, R>
}
sealed interface ActOutcome<out T, out R> {
    data class Committed<T>(val result: T, val receipt: ActReceipt) : ActOutcome<T, Nothing>
    data class Unchanged<T>(val result: T) : ActOutcome<T, Nothing>
    data class Refused<R>(val refusal: R) : ActOutcome<Nothing, R>
}
// §9.7: a composed act's outcome, each part's result in order, or the refusal of the part that met it.
sealed interface ComposedOutcome<out R> {
    data class Committed(val results: List<Any?>, val receipt: ActReceipt) : ComposedOutcome<Nothing>
    data class Unchanged(val results: List<Any?>) : ComposedOutcome<Nothing>
    data class Refused<R>(val part: Int, val refusal: R) : ComposedOutcome<R>
}

class ActReader internal constructor(private val context: ActContext, private val registry: Registry, val moment: Moment) {
    internal var open = true
    fun <T> inScope(scope: ScopeRef, body: (Reader) -> T): T {
        check(open) { "an act reads only during load" }
        return context.inScope(scope) { body(Reader(it, scope, moment, registry)) }
    }
}

class ActIDSource internal constructor(private val context: ActContext) {
    fun <E : Entity<E>> mint(type: EntityType<E>, scope: ScopeRef = type.boundScope()): Id<E> {
        type.boundScope(scope)
        return try { Id(context.mintID(type.type, scope), type) }
        catch (failure: Exception) { throw ProgrammingFault("minting an act identity failed", failure) }
    }
    fun opaqueID(): String = try { context.opaqueID() }
        catch (failure: Exception) { throw ProgrammingFault("minting an opaque act identity failed", failure) }
    // A single action's identities inside its one-segment act (§9.6): minted in `scope`.
    internal fun inScope(scope: ScopeRef): IDSource = IDSource({ context.opaqueID() }, { type -> context.mintID(type, scope) })
}

// An act's load over `context` and its one decision (§9.5); a violation refuses the act. The runner commits what it decides.
fun <L, T, R> ActAction<L, T, R>.decision(context: ActContext, registry: Registry, moment: Moment): ActDecision<T, R> {
    val read = ActReader(context, registry, moment)
    val loaded = try { load(read) } finally { read.open = false }
    context.finishLoad()
    return try { decide(loaded, ActIDSource(context)) } catch (violation: Violation) { ActDecision.Refuse(refusals.of(violation)) }
}

// A segment the kit refuses before the engine writes it (a gone record), naming the composed act's part it belongs to.
internal class ActPrediction(val refusal: Refused, val part: Int = 0) : RuntimeException()
internal sealed interface ActStep<out T, out R> {
    data class Done<T, R>(val outcome: ActOutcome<T, R>) : ActStep<T, R>
    data class Writing<T>(val plan: ActPlan, val result: T) : ActStep<T, Nothing>
}
// A composed act's prepare value: its outcome when it ends there, or else its parts' segments in order, each with its part, and their results.
internal sealed interface ComposedStep<out R> {
    data class Done<R>(val outcome: ComposedOutcome<R>) : ComposedStep<R>
    data class Writing(val segments: List<PartSegment>, val results: List<Any?>) : ComposedStep<Nothing>
}
internal data class PartSegment(val part: Int, val scoped: ScopedPlan)
