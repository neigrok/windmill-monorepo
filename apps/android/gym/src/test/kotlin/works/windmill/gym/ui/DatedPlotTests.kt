package works.windmill.gym.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import java.time.LocalDate
import java.time.ZoneOffset
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import works.windmill.gym.domain.DatedPoint
import works.windmill.gym.domain.DatedSeries

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w320dp-h640dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DatedPlotTests {
    @get:Rule val compose = createComposeRule()

    @Test
    fun previewHasOnlyItsParentNavigationAndNoChartActions() {
        val points = (0..3).map { DatedPoint("$it", it * 86_400_000L, 60.0 + it, "Point $it") }
        var navigations = 0
        val actions = mutableListOf<String>()
        compose.setContent {
            GymMaterial {
                Box(Modifier.width(280.dp).clickable { navigations++ }) {
                    DatedPlot(DatedSeries(points, 0, points.last().atMs, ZoneOffset.UTC, 21), Modifier.testTag("plot"),
                        onInspect = { actions.add("inspect") }, onSelect = { actions.add("select") })
                }
            }
        }
        compose.onNodeWithTag("plot", useUnmergedTree = true).performTouchInput { click() }
        compose.runOnIdle {
            assertEquals(1, navigations)
            assertEquals(emptyList<String>(), actions)
        }
        compose.onNodeWithContentDescription("Session estimates").assertDoesNotExist()
    }

    @Test
    fun aHeldScrubReadsTheNearestActualPointAndReleaseRestoresLatest() {
        val points = (0..3).map { DatedPoint("$it", it * 7 * 86_400_000L, 60.0 + it, "Point $it") }
        val reads = mutableListOf<String?>()
        val ticks = mutableListOf<HapticFeedbackType>()
        val haptic = object : HapticFeedback {
            override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) { ticks.add(hapticFeedbackType) }
        }
        var untilMs by mutableLongStateOf(points.last().atMs)
        compose.setContent {
            CompositionLocalProvider(LocalHapticFeedback provides haptic) {
                GymMaterial {
                    DatedPlot(DatedSeries(points, 0, untilMs, ZoneOffset.UTC, 21), Modifier.width(280.dp),
                        PlotInteraction.Inspect, onInspect = { reads.add(it?.id); untilMs += 1_000 })
                }
            }
        }
        val first = compose.onNodeWithContentDescription("Point 0", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.center
        val third = compose.onNodeWithContentDescription("Point 2", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.center
        compose.mainClock.autoAdvance = false
        compose.onRoot().performTouchInput { down(first) }
        compose.mainClock.advanceTimeBy(700)
        compose.runOnIdle { assertEquals("0", reads.last()) }
        compose.onRoot().performTouchInput { moveTo(first + Offset(2f, 0f), delayMillis = 40) }
        compose.mainClock.advanceTimeByFrame()
        compose.runOnIdle { assertEquals(listOf(GymHaptics.light), ticks) }
        compose.onRoot().performTouchInput { moveTo(third, delayMillis = 40) }
        compose.mainClock.advanceTimeByFrame()
        compose.runOnIdle { assertEquals("2", reads.last()) }
        compose.onRoot().performTouchInput { up() }
        compose.mainClock.autoAdvance = true
        compose.runOnIdle {
            assertEquals(listOf("0", "2", null), reads)
            assertEquals(listOf(GymHaptics.light, GymHaptics.light), ticks)
        }
    }

    @Test
    fun aPanContinuesAfterReleaseAndAFreshHoldStopsMomentumAtTheSamePoint() {
        val points = (0..60).map { DatedPoint("$it", it * 86_400_000L, 60.0 + it, "Point $it") }
        compose.setContent {
            GymMaterial {
                DatedPlot(DatedSeries(points, 0, points.last().atMs, ZoneOffset.UTC, 21), Modifier.width(280.dp),
                    PlotInteraction.Inspect)
            }
        }
        val pointLabel = SemanticsMatcher("dated point") { node ->
            node.config.getOrNull(SemanticsProperties.ContentDescription)?.singleOrNull()?.startsWith("Point ") == true
        }
        fun firstVisible(): Int = compose.onAllNodes(pointLabel, useUnmergedTree = true).fetchSemanticsNodes()
            .minOf { it.config[SemanticsProperties.ContentDescription].single().removePrefix("Point ").toInt() }
        val plot = compose.onNodeWithContentDescription("Session estimates")
        compose.mainClock.autoAdvance = false
        plot.performTouchInput {
            down(Offset(width * .5f, height * .5f))
            moveBy(Offset(width * .2f, 0f), delayMillis = 60)
            up()
        }
        compose.mainClock.advanceTimeByFrame()
        val released = firstVisible()
        compose.mainClock.advanceTimeBy(120)
        assertTrue(firstVisible() < released)
        val earlier = plot.fetchSemanticsNode().config[SemanticsActions.CustomActions].single { it.label == "Earlier session" }
        compose.runOnIdle { assertTrue(earlier.action()) }
        compose.mainClock.autoAdvance = true
        val selected = compose.onNodeWithContentDescription("Point 59", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        compose.mainClock.autoAdvance = false
        compose.mainClock.advanceTimeBy(800)
        assertEquals(selected, compose.onNodeWithContentDescription("Point 59", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot)
        plot.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Point 59"))
        plot.assert(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite))
        plot.performTouchInput {
            down(Offset(width * .5f, height * .5f))
            moveBy(Offset(width * .2f, 0f), delayMillis = 60)
            up()
        }
        compose.mainClock.advanceTimeBy(120)
        plot.performTouchInput { down(Offset(width * .5f, height * .5f)) }
        compose.mainClock.advanceTimeByFrame()
        val held = firstVisible()
        compose.mainClock.advanceTimeBy(800)
        assertEquals(held, firstVisible())
        plot.performTouchInput { up() }
        compose.mainClock.autoAdvance = true
        repeat(8) {
            plot.performTouchInput { swipe(Offset(width * .4f, height * .5f), Offset(width * .95f, height * .5f), 100) }
        }
        assertEquals(0, firstVisible())
        val oldest = compose.onNodeWithContentDescription("Point 0", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertTrue(oldest.left >= plot.fetchSemanticsNode().boundsInRoot.left)
    }

    @Test
    fun horizontalPanReachesOlderSessionsAndAccessibleStepsPreserveIdentity() {
        val points = (0..30).map { DatedPoint("$it", it * 86_400_000L, 60.0 + it, "Point $it") }
        val reads = mutableListOf<String?>()
        compose.setContent {
            GymMaterial {
                DatedPlot(DatedSeries(points, 0, points.last().atMs, ZoneOffset.UTC, 21), Modifier.width(280.dp),
                    PlotInteraction.Inspect, onInspect = { reads.add(it?.id) })
            }
        }
        compose.onNodeWithContentDescription("Point 15", useUnmergedTree = true).assertDoesNotExist()
        val plot = compose.onNodeWithContentDescription("Session estimates")
        plot.performTouchInput { swipe(Offset(width * .45f, height * .5f), Offset(width * .95f, height * .5f), 500) }
        compose.onNodeWithContentDescription("Point 15", useUnmergedTree = true).assertExists()
        val earlier = plot.fetchSemanticsNode().config[SemanticsActions.CustomActions].single { it.label == "Earlier session" }
        compose.runOnIdle { assertTrue(earlier.action()) }
        compose.runOnIdle { assertEquals("29", reads.last()) }
        compose.onNodeWithContentDescription("Point 29", useUnmergedTree = true).assertExists()
        val later = plot.fetchSemanticsNode().config[SemanticsActions.CustomActions].single { it.label == "Later session" }
        compose.runOnIdle { assertTrue(later.action()) }
        compose.runOnIdle { assertEquals("30", reads.last()) }
    }

    @Test
    fun verticalMovementYieldsToThePageWithoutSelectingARecordPoint() {
        val points = (0..3).map { DatedPoint("$it", it * 86_400_000L, 60.0 + it, "Point $it") }
        val reads = mutableListOf<String?>()
        var offset = 0
        compose.setContent {
            val scroll = rememberScrollState()
            offset = scroll.value
            GymMaterial {
                Column(Modifier.height(300.dp).verticalScroll(scroll)) {
                    DatedPlot(DatedSeries(points, 0, points.last().atMs, ZoneOffset.UTC, 21),
                        interaction = PlotInteraction.Inspect, onInspect = { reads.add(it?.id) })
                    Spacer(Modifier.height(900.dp))
                }
            }
        }
        compose.onNodeWithContentDescription("Session estimates").performTouchInput {
            swipe(Offset(width * .6f, height * .75f), Offset(width * .6f, height * .25f), 250)
        }
        compose.runOnIdle { assertTrue(offset > 0); assertTrue(reads.all { it == null }) }
    }

    @Test
    fun selectUsesTheTappedDotsIdentityAndLargeAxisDatesStayInsideThePlot() {
        val from = LocalDate.parse("2025-12-20").atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
        val until = LocalDate.parse("2026-01-10").atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
        val point = DatedPoint("2025-12-30", (from + until) / 2, 82.4, "30 Dec 2025 · 82.4 kg")
        val selections = mutableListOf<String>()
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(2f, 2f)) {
                GymMaterial {
                    DatedPlot(DatedSeries(listOf(point), from, until, ZoneOffset.UTC, 7), Modifier.width(280.dp).testTag("plot"),
                        PlotInteraction.Select, onSelect = { selections.add(it.id) })
                }
            }
        }
        val plot = compose.onNodeWithTag("plot")
        val bounds = plot.fetchSemanticsNode().boundsInRoot
        val labels = compose.onAllNodes(hasText("20 Dec 25") or hasText("10 Jan 26") or hasText("82.4"))
        assertEquals(3, labels.fetchSemanticsNodes().size)
        labels.fetchSemanticsNodes().forEach { node ->
            assertTrue(node.boundsInRoot.left >= bounds.left)
            assertTrue(node.boundsInRoot.right <= bounds.right)
            assertTrue(node.boundsInRoot.bottom <= bounds.bottom)
            val layout = mutableListOf<TextLayoutResult>()
            node.config[SemanticsActions.GetTextLayoutResult].action!!(layout)
            assertFalse(layout.single().hasVisualOverflow)
        }
        val leftLabel = compose.onNodeWithText("82.4").fetchSemanticsNode().boundsInRoot
        val dates = compose.onNodeWithText("20 Dec 25").fetchSemanticsNode().boundsInRoot
        val rightDate = compose.onNodeWithText("10 Jan 26").fetchSemanticsNode().boundsInRoot
        val x = (dates.left + rightDate.right) / 2
        compose.onRoot().performTouchInput { click(Offset(x, leftLabel.center.y)) }
        compose.runOnIdle { assertEquals(listOf(point.id), selections) }
        assertFalse(plot.fetchSemanticsNode().config.contains(SemanticsActions.CustomActions))
    }
}
