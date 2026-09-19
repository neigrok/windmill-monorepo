package works.windmill.gym.ui

import androidx.compose.foundation.MutatePriority
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.junit4.createComposeRule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.AskGeneration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CoachPresentationTests {
    @get:Rule val compose = createComposeRule()

    @Test
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun aBurstPublishesOneFullUnicodeReplacementAtTheNextDisplayFrame() = kotlinx.coroutines.test.runTest {
        val first = AskGeneration("generation-a", "request-a", "Question", "running", "First", revision = 1)
        var generation by mutableStateOf(first)
        val presentation = CoachPresentation(listOf(first.exchange()), androidx.compose.foundation.ScrollState(0))
        val frame = androidx.compose.runtime.BroadcastFrameClock()
        val task = launch(frame) { presentation.present { listOf(generation.exchange()) } }
        runCurrent()
        frame.sendFrame(0)
        runCurrent()
        for (revision in 2..100) {
            generation = first.copy(answer = "word ".repeat(revision), revision = revision.toLong())
            androidx.compose.runtime.snapshots.Snapshot.sendApplyNotifications()
            runCurrent()
        }
        val last = first.copy(status = "stopped", answer = "Café 東京 مرحبًا 🏋🏽‍♀️ e\u0301\n".repeat(500), revision = 101)
        generation = last
        androidx.compose.runtime.snapshots.Snapshot.sendApplyNotifications()
        runCurrent()
        assertEquals(listOf(first.exchange()), presentation.exchanges)
        assertTrue(frame.hasAwaiters)
        frame.sendFrame(16_000_000)
        runCurrent()
        assertEquals(listOf(last.exchange()), presentation.exchanges)
        assertEquals(listOf("request-a"), presentation.keys)
        task.cancel()
    }

    @Test
    fun aShortUpwardDragInterruptsFollowAndStaysPausedInsideTheEndTolerance() {
        var generation by mutableStateOf(AskGeneration("generation-a", "request-a", "Question", "running", "Line\n".repeat(60), revision = 1))
        lateinit var presentation: CoachPresentation
        lateinit var scope: CoroutineScope
        compose.setContent {
            presentation = rememberCoachPresentation("thread-a", listOf(generation.exchange()))
            scope = rememberCoroutineScope()
            presentation.viewport = 200
            presentation.tolerance = 96
            Column(Modifier.height(100.dp).fillMaxWidth().verticalScroll(presentation.scroll)) {
                Text(presentation.exchanges.single().generation!!.answer, Modifier.onGloballyPositioned {
                    presentation.positions["request-a"] = it.positionInParent().y.toInt()
                })
            }
        }
        compose.runOnIdle { presentation.jumpToLatest() }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false
        compose.runOnIdle { generation = generation.copy(answer = generation.answer + "Next line\n", revision = 2) }
        compose.mainClock.advanceTimeBy(48)
        compose.runOnIdle {
            presentation.gestures.onPreScroll(Offset(0f, 20f), NestedScrollSource.UserInput)
            scope.launch { presentation.scroll.scroll(MutatePriority.UserInput) { scrollBy(-20f) } }
        }
        compose.mainClock.advanceTimeByFrame()
        var pausedAt = 0
        compose.runOnIdle {
            pausedAt = presentation.scroll.value
            assertFalse(presentation.followEnd)
            assertTrue(presentation.scroll.maxValue - pausedAt <= presentation.tolerance)
            generation = generation.copy(answer = generation.answer + "More lines\n".repeat(5), revision = 3)
        }
        compose.mainClock.advanceTimeBy(256)
        compose.runOnIdle {
            assertFalse(presentation.followEnd)
            assertEquals(pausedAt, presentation.scroll.value)
            presentation.jumpToLatest()
        }
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        compose.runOnIdle { assertEquals(presentation.scroll.maxValue, presentation.scroll.value) }
    }
}
