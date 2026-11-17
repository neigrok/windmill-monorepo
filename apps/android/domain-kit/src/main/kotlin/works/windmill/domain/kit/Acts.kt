package works.windmill.domain.kit

import works.windmill.sync.api.ActContext
import works.windmill.sync.api.ActReceipt
import works.windmill.sync.core.Registry
import works.windmill.sync.core.ScopeRef

data class ScopedPlan(val scope: ScopeRef, val plan: Plan)
class ActPlan(segments: List<ScopedPlan>) { val segments: List<ScopedPlan> = segments.toList() }

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
}

internal class ActPrediction(val refusal: Refused) : RuntimeException()
internal sealed interface ActStep<out T, out R> {
    data class Done<T, R>(val outcome: ActOutcome<T, R>) : ActStep<T, R>
    data class Writing<T>(val plan: ActPlan, val result: T) : ActStep<T, Nothing>
}
