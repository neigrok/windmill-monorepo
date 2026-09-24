package works.windmill.gym.ui

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
import works.windmill.gym.domain.AskExchange

// The one owner of the conversation's scroll offset. Every correction lands in the layout phase,
// after the scroller measured its content and before it places it, so text that grew this frame is
// in view this frame: nothing animates after it and no frame shows it below the fold.
internal class CoachPresentation(initial: List<AskExchange>, val scroll: ScrollState) {
    private var exchanges: List<AskExchange> = emptyList()
    var keys: List<String> = emptyList()
        private set
    var followEnd by mutableStateOf(true)
        private set
    var tolerance = 0
    private var historyPrepended = false
    private var placedValue = 0
    private var placedMax = 0
    private var placedNewest: String? = null

    init { replace(initial) }

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

    fun replace(next: List<AskExchange>) {
        if (next == exchanges) return
        val prepended = exchanges.isNotEmpty() && next.size > exchanges.size &&
            next.last().requestId == exchanges.last().requestId && next.takeLast(exchanges.size) == exchanges
        if (prepended) historyPrepended = true
        exchanges = next
        val occurrences = mutableMapOf<String, Int>()
        keys = next.asReversed().map { exchange ->
            exchange.requestId.ifEmpty {
                val occurrence = occurrences.getOrDefault(exchange.question, 0)
                occurrences[exchange.question] = occurrence + 1
                "legacy:$occurrence:${exchange.question}"
            }
        }.asReversed()
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
internal fun rememberCoachPresentation(conversationId: String, thread: List<AskExchange>): CoachPresentation {
    val presentation = remember(conversationId) { CoachPresentation(thread, ScrollState(0)) }
    presentation.replace(thread)
    return presentation
}
