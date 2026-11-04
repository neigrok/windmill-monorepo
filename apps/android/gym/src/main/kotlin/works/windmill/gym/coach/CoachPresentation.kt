package works.windmill.gym.coach

import androidx.compose.foundation.ScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.layout.layout

// The one owner of the conversation's scroll offset. Every correction lands in the layout phase,
// after the scroller measured its content and before it places it, so text that grew this frame is
// in view this frame: nothing animates after it and no frame shows it below the fold.
internal class CoachPresentation(initial: List<CoachExchange>, val scroll: ScrollState, initialFollowEnd: Boolean = true) {
    private var exchanges: List<CoachExchange> = emptyList()
    var keys: List<String> = emptyList()
        private set
    var followEnd by mutableStateOf(initialFollowEnd)
        private set
    var tolerance = 0
    private var historyPrepended = false
    private var placedValue = 0
    private var placedMax = 0
    private var placedNewest: String? = null

    init { replace(initial); placedNewest = keys.lastOrNull() }

    val awayFromEnd: Boolean get() = scroll.maxValue - scroll.value > tolerance

    val gestures = object : NestedScrollConnection {
        override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
            if (source == NestedScrollSource.UserInput && available.y > 0) followEnd = false
            return Offset.Zero
        }
    }

    // Sits before `verticalScroll` in the chain: this placement runs once the scroller has measured
    // (`maxValue` is fresh) and before the scroller reads the offset it places its content at. The
    // scroller observes that offset, so a correction makes it re-place once more next frame: one
    // extra idempotent pass, never a loop.
    val anchoring: Modifier = Modifier.layout { measurable, constraints ->
        val scroller = measurable.measure(constraints)
        layout(scroller.width, scroller.height) {
            val max = scroll.maxValue
            val newest = keys.lastOrNull()
            if (scroll.isScrollInProgress) {
                if (scroll.value < placedValue) followEnd = false
                else if (scroll.value > placedValue && max - scroll.value <= tolerance) followEnd = true
            }
            when {
                historyPrepended && max != placedMax -> { scrollTo(scroll.value + max - placedMax); historyPrepended = false }
                newest != placedNewest -> { scrollTo(max); followEnd = true }
                followEnd && !scroll.isScrollInProgress -> scrollTo(max)
            }
            placedValue = scroll.value
            placedMax = max
            placedNewest = newest
            scroller.place(0, 0)
        }
    }

    // A conversation syncing from another phone can land messages above the ones on screen, which keep their place.
    fun replace(next: List<CoachExchange>) {
        if (next == exchanges) return
        val prepended = exchanges.isNotEmpty() && next.size > exchanges.size &&
            next.last().id == exchanges.last().id && next.takeLast(exchanges.size) == exchanges
        if (prepended) historyPrepended = true
        exchanges = next
        keys = next.map { it.id }
    }

    suspend fun jumpToLatest() {
        followEnd = false
        scroll.animateScrollTo(scroll.maxValue)
        followEnd = true
    }

    // ScrollState takes deltas and carries a fractional remainder from drags: the first delta clamps
    // to the top and clears the remainder, the second walks the exact distance.
    private fun scrollTo(target: Int) {
        if (target == scroll.value) return
        scroll.dispatchRawDelta(-(scroll.value + 1).toFloat())
        scroll.dispatchRawDelta(target.toFloat())
    }
}

@Composable
internal fun rememberCoachPresentation(conversationId: String, thread: List<CoachExchange>, owner: String = "", scroll: Int = 0, followEnd: Boolean = true): CoachPresentation {
    val presentation = remember(owner, conversationId) { CoachPresentation(thread, ScrollState(scroll), followEnd) }
    presentation.replace(thread)
    return presentation
}
