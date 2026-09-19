package works.windmill.gym.ui

import androidx.compose.foundation.ScrollState
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.LinearEasing
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import works.windmill.gym.domain.AskExchange

internal class CoachPresentation(initial: List<AskExchange>, val scroll: ScrollState) {
    var exchanges by mutableStateOf(initial)
        private set
    var followEnd by mutableStateOf(true)
        private set
    var viewport by mutableStateOf(0)
    var tolerance = 0
    val positions = mutableStateMapOf<String, Int>()
    private var anchor by mutableStateOf<Anchor?>(null)
    private var jump by mutableStateOf(0)
    private var automatic = false

    val keys: List<String> get() {
        val occurrences = mutableMapOf<String, Int>()
        return exchanges.asReversed().map { exchange ->
            exchange.requestId.ifEmpty {
                val occurrence = occurrences.getOrDefault(exchange.question, 0)
                occurrences[exchange.question] = occurrence + 1
                "legacy:$occurrence:${exchange.question}"
            }
        }.asReversed()
    }
    val awayFromEnd get() = scroll.maxValue - scroll.value > tolerance

    val gestures = object : NestedScrollConnection {
        override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
            if (source == NestedScrollSource.UserInput && available.y > 0) followEnd = false
            return Offset.Zero
        }
        override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
            if (source == NestedScrollSource.UserInput && consumed.y < 0 && !awayFromEnd) followEnd = true
            return Offset.Zero
        }
    }

    fun replace(next: List<AskExchange>) {
        if (next == exchanges) return
        if (next.size > exchanges.size && next.lastOrNull()?.requestId == exchanges.lastOrNull()?.requestId &&
            next.takeLast(exchanges.size) == exchanges && exchanges.isNotEmpty()) {
            positions.entries.filter { it.value <= scroll.value }.maxByOrNull { it.value }?.let {
                anchor = Anchor(it.key, it.value - scroll.value, it.value)
            }
        }
        exchanges = next
    }

    suspend fun present(latest: () -> List<AskExchange>) {
        snapshotFlow(latest).collect {
            withFrameNanos { }
            replace(latest())
        }
    }

    fun jumpToLatest() { followEnd = true; jump++ }

    suspend fun observeReader() {
        var previous = scroll.value
        snapshotFlow { scroll.isScrollInProgress to scroll.value }.collect { (active, at) ->
            if (active && !automatic) {
                if (at < previous) followEnd = false
                else if (at > previous && !awayFromEnd) followEnd = true
            }
            previous = at
        }
    }

    suspend fun followLayout() {
        var latest: String? = null
        var jumpSeen = 0
        snapshotFlow { Layout(keys.lastOrNull(), positions[keys.lastOrNull()], scroll.maxValue, viewport, followEnd, jump, anchor, anchor?.let { positions[it.key] }) }
            .collect { layout ->
                if (layout.height == 0 || layout.top == null) return@collect
                val preserved = layout.anchor?.takeIf { layout.anchorTop != null && layout.anchorTop != it.top }
                    ?.let { requireNotNull(layout.anchorTop) - it.offset }
                val target = when {
                    preserved != null -> preserved
                    layout.latest != latest -> layout.top
                    layout.follow -> layout.end
                    else -> null
                }
                val newMessage = layout.latest != latest
                latest = layout.latest
                if (target != null) {
                    automatic = true
                    try {
                        if (layout.jump != jumpSeen) scroll.animateScrollTo(target)
                        else if (newMessage || preserved != null) scroll.scrollTo(target)
                        else scroll.animateScrollTo(target, tween(80, easing = LinearEasing))
                    } catch (cancelled: CancellationException) {
                        currentCoroutineContext().ensureActive()
                    } finally { automatic = false }
                }
                jumpSeen = layout.jump
                if (preserved != null) anchor = null
            }
    }

    private data class Layout(val latest: String?, val top: Int?, val end: Int, val height: Int,
        val follow: Boolean, val jump: Int, val anchor: Anchor?, val anchorTop: Int?)

    private data class Anchor(val key: String, val offset: Int, val top: Int)
}

@Composable
internal fun rememberCoachPresentation(conversationId: String, thread: List<AskExchange>): CoachPresentation {
    val presentation = remember(conversationId) { CoachPresentation(thread, ScrollState(0)) }
    val incoming by rememberUpdatedState(thread)
    LaunchedEffect(presentation) { presentation.present { incoming } }
    LaunchedEffect(presentation) { presentation.observeReader() }
    LaunchedEffect(presentation) { presentation.followLayout() }
    return presentation
}
