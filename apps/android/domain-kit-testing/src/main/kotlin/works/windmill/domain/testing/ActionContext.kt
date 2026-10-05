package works.windmill.domain.testing

import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.CopyableThreadContextElement
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.withContext
import works.windmill.domain.kit.ActionContext

@OptIn(DelicateCoroutinesApi::class, ExperimentalCoroutinesApi::class)
class ActionContextElement : AbstractCoroutineContextElement(Key), ActionContext, CopyableThreadContextElement<Unit> {
    override var insideRun = false
    override fun updateThreadContext(context: CoroutineContext) = Unit
    override fun restoreThreadContext(context: CoroutineContext, oldState: Unit) {}
    override fun copyForChild() = ActionContextElement().also { it.insideRun = insideRun }
    override fun mergeForChild(overwritingElement: CoroutineContext.Element): CoroutineContext = overwritingElement
    companion object Key : CoroutineContext.Key<ActionContextElement>
}

suspend fun <T> withActionContext(body: suspend (ActionContext) -> T): T {
    val inherited = coroutineContext[ActionContextElement]
    if (inherited?.insideRun == true) return body(inherited)
    val context = ActionContextElement()
    return withContext(context) { body(requireNotNull(coroutineContext[ActionContextElement])) }
}
