package works.windmill.gym.ui

import androidx.compose.foundation.MutatePriority
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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
    fun aBurstOfSupersedingRevisionsLeavesOneTextNodeShowingTheFinalUnicodeText() {
        val first = AskGeneration("generation-a", "request-a", "Question", "running", "First", revision = 1)
        var generation by mutableStateOf(first)
        lateinit var presentation: CoachPresentation
        compose.setContent { GymMaterial {
            presentation = rememberCoachPresentation("thread-a", listOf(generation.exchange()))
            Column(Modifier.fillMaxSize().then(presentation.anchoring).verticalScroll(presentation.scroll)) {
                CoachAnswer(generation.answer, null, emptyList(), 0)
            }
        } }
        val final = List(500) { "Café 東京 مرحبًا 🏋🏽‍♀️ é" }.joinToString("\n")
        compose.runOnIdle {
            for (revision in 2..100) generation = first.copy(answer = "word ".repeat(revision), revision = revision.toLong())
            generation = first.copy(status = "stopped", answer = final, revision = 101)
        }
        compose.onAllNodes(hasText(final), useUnmergedTree = true).assertCountEquals(1)
        compose.onAllNodes(hasText("word", substring = true), useUnmergedTree = true).assertCountEquals(0)
        compose.runOnIdle {
            assertEquals(listOf("request-a"), presentation.keys)
            assertEquals(presentation.scroll.maxValue, presentation.scroll.value)
        }
    }

    @Test
    fun noPlacementEverShowsTheOffsetLaggingTheEndWhileFollowing() {
        var generation by mutableStateOf(AskGeneration("generation-a", "request-a", "Question", "running", "Line\n".repeat(60), revision = 1))
        lateinit var presentation: CoachPresentation
        val placements = mutableListOf<Pair<Int, Int>>()
        compose.setContent {
            presentation = rememberCoachPresentation("thread-a", listOf(generation.exchange()))
            Column(Modifier.height(100.dp).fillMaxWidth().then(presentation.anchoring).verticalScroll(presentation.scroll)) {
                Text(generation.answer, Modifier.onPlaced {
                    placements += presentation.scroll.maxValue to presentation.scroll.value
                })
            }
        }
        var opened = 0
        compose.runOnIdle {
            opened = presentation.scroll.maxValue
            assertTrue(opened > 0)
        }
        for (revision in 2..6) {
            compose.runOnIdle { generation = generation.copy(answer = generation.answer + "More\n".repeat(10), revision = revision.toLong()) }
        }
        compose.runOnIdle {
            assertTrue(presentation.scroll.maxValue > opened)
            assertEquals(placements.map { it.first }, placements.map { it.second })
            assertEquals(6, placements.map { it.first }.distinct().size)
            assertTrue(presentation.followEnd)
        }
    }

    @Test
    fun aShortUpwardDragInterruptsFollowAndStaysPausedInsideTheEndTolerance() {
        var generation by mutableStateOf(AskGeneration("generation-a", "request-a", "Question", "running", "Line\n".repeat(60), revision = 1))
        lateinit var presentation: CoachPresentation
        lateinit var scope: CoroutineScope
        compose.setContent {
            presentation = rememberCoachPresentation("thread-a", listOf(generation.exchange()))
            scope = rememberCoroutineScope()
            presentation.tolerance = 96
            Column(Modifier.height(100.dp).fillMaxWidth().then(presentation.anchoring).verticalScroll(presentation.scroll)) {
                Text(generation.answer)
            }
        }
        compose.runOnIdle { scope.launch { presentation.jumpToLatest() } }
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
            scope.launch { presentation.jumpToLatest() }
        }
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        compose.runOnIdle {
            assertEquals(presentation.scroll.maxValue, presentation.scroll.value)
            assertTrue(presentation.followEnd)
        }
    }
}
