package works.windmill.gym.store

import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.CopyableThreadContextElement
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.withContext
import works.windmill.domain.kit.ActionContext

@OptIn(ExperimentalCoroutinesApi::class, DelicateCoroutinesApi::class)
internal class GymActionContext : AbstractCoroutineContextElement(Key), ActionContext, CopyableThreadContextElement<Unit> {
    override var insideRun = false
    override fun updateThreadContext(context: CoroutineContext) = Unit
    override fun restoreThreadContext(context: CoroutineContext, oldState: Unit) = Unit
    override fun copyForChild() = GymActionContext().also { it.insideRun = insideRun }
    override fun mergeForChild(overwritingElement: CoroutineContext.Element): CoroutineContext = overwritingElement
    companion object Key : CoroutineContext.Key<GymActionContext>
}

internal suspend fun <T> withGymActionContext(body: suspend (ActionContext) -> T): T {
    val inherited = coroutineContext[GymActionContext]
    if (inherited?.insideRun == true) return body(inherited)
    return withContext(GymActionContext()) { body(requireNotNull(coroutineContext[GymActionContext])) }
}
