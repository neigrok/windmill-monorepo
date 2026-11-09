package works.windmill.gym.coach

import works.windmill.platform.i18n.text
import androidx.test.core.app.ApplicationProvider
import android.app.Application
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.Clipboard
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.TextLayoutResult
import java.time.Instant
import java.time.ZoneOffset
import java.util.Locale
import kotlinx.coroutines.CancellationException
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CoachBubbleTests {
    @get:Rule val compose = createComposeRule()

    @Test fun aPlainTapDoesNothingAndBothCopyDoorsEmitOnlyTheBoundedResult() {
        lateinit var clipboard: Clipboard
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { fail(operation) }
        }
        val question = "My private question.\nCafé 東京"
        val answer = "First paragraph.\n\nSecond paragraph 🏋🏽‍♀️"
        compose.setContent { GymMaterial { CompositionLocalProvider(LocalTelemetry provides telemetry) {
            clipboard = LocalClipboard.current
            Column { CoachQuestion(question); CoachAnswer(answer, coachReply(answer), emptyList()) }
        } } }
        compose.onNodeWithText(question).performClick()
        compose.onNodeWithText("Copy question").assertDoesNotExist()
        compose.runOnIdle { assertEquals(emptyList<Any>(), events) }
        compose.onNodeWithText(question).performTouchInput { longClick() }
        compose.onNodeWithText("Copy question").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(question, clipboard.nativeClipboard.primaryClip?.getItemAt(0)?.text?.toString()) }
        val actions = compose.onNodeWithText("First paragraph.").fetchSemanticsNode().config[SemanticsActions.CustomActions]
        compose.runOnIdle {
            assertEquals(listOf("Copy answer"), actions.map { it.label })
            assertTrue(actions.single().action())
            assertEquals(answer, clipboard.nativeClipboard.primaryClip?.getItemAt(0)?.text?.toString())
            assertEquals(List(2) { "gym_action" to mapOf("screen" to "coach", "action" to "copy", "outcome" to "ok") }, events)
        }
    }

    @Test fun aFailedClipboardWriteKeepsCopyAvailableAndReportsOneContentFreeBoundary() {
        var refused = true
        var copied: String? = null
        val failures = mutableListOf<Pair<String, Map<String, String>>>()
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation to properties }
        }
        compose.setContent {
            val clipboard = object : Clipboard by LocalClipboard.current {
                override suspend fun setClipEntry(clipEntry: ClipEntry?) {
                    if (refused) throw IllegalStateException("private clipboard content")
                    copied = clipEntry?.clipData?.getItemAt(0)?.text?.toString()
                }
            }
            GymMaterial { CompositionLocalProvider(LocalTelemetry provides telemetry, LocalClipboard provides clipboard) {
                CoachAnswer("Exact fixture answer", coachReply("Exact fixture answer"), emptyList())
            } }
        }
        compose.onNodeWithText("Exact fixture answer").performTouchInput { longClick() }
        compose.onNodeWithText("Copy answer").performClick().assertIsDisplayed()
        compose.runOnIdle {
            assertNull(copied)
            assertEquals(listOf("gym.copyMessage" to emptyMap<String, String>()), failures)
            refused = false
        }
        compose.onNodeWithText("Copy answer").performClick().assertDoesNotExist()
        compose.runOnIdle {
            assertEquals("Exact fixture answer", copied)
            assertEquals(listOf(
                "gym_action" to mapOf("screen" to "coach", "action" to "copy", "outcome" to "failed"),
                "gym_action" to mapOf("screen" to "coach", "action" to "copy", "outcome" to "ok"),
            ), events)
            assertEquals(listOf("gym.copyMessage" to emptyMap<String, String>()), failures)
        }
    }

    @Test fun theAccessibleCopyActionAnswersWhetherTheClipboardTookTheText() {
        var refused = true
        var copied: String? = null
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {}
        }
        compose.setContent {
            val clipboard = object : Clipboard by LocalClipboard.current {
                override suspend fun setClipEntry(clipEntry: ClipEntry?) {
                    if (refused) throw IllegalStateException("private clipboard content")
                    copied = clipEntry?.clipData?.getItemAt(0)?.text?.toString()
                }
            }
            GymMaterial { CompositionLocalProvider(LocalTelemetry provides telemetry, LocalClipboard provides clipboard) {
                CoachAnswer("Exact fixture answer", coachReply("Exact fixture answer"), emptyList())
            } }
        }
        val copy = compose.onNodeWithText("Exact fixture answer").fetchSemanticsNode().config[SemanticsActions.CustomActions].single()
        compose.runOnIdle {
            assertFalse(copy.action())
            assertNull(copied)
            refused = false
            assertTrue(copy.action())
            assertEquals("Exact fixture answer", copied)
            assertEquals(listOf(
                "gym_action" to mapOf("screen" to "coach", "action" to "copy", "outcome" to "failed"),
                "gym_action" to mapOf("screen" to "coach", "action" to "copy", "outcome" to "ok"),
            ), events)
        }
    }

    @Test fun oneDistinctLinkHasBothCopyActionsAndEachWritesItsOwnForm() {
        lateinit var clipboard: Clipboard
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { fail(operation) }
        }
        val url = "https://example.org/top-sets"
        val displayed = "Try a top set. More on top sets."
        compose.setContent { GymMaterial { CompositionLocalProvider(LocalTelemetry provides telemetry) {
            clipboard = LocalClipboard.current
            CoachAnswer("Try a top set. [More on top sets]($url).", coachReply("Try a top set. [More on top sets]($url)."), emptyList())
        } } }
        val actions = compose.onNodeWithText(displayed).fetchSemanticsNode().config[SemanticsActions.CustomActions]
        assertEquals(listOf("Copy answer", "Copy link"), actions.map { it.label })
        compose.onNodeWithText(displayed).performTouchInput { longClick() }
        compose.onNodeWithText("Copy answer").assertIsDisplayed()
        compose.onNodeWithText("Copy link").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(url, clipboard.nativeClipboard.primaryClip?.getItemAt(0)?.text?.toString()) }
        compose.onNodeWithText(displayed).performTouchInput { longClick() }
        compose.onNodeWithText("Copy answer").performClick()
        compose.runOnIdle {
            assertEquals("Try a top set. More on top sets ($url).", clipboard.nativeClipboard.primaryClip?.getItemAt(0)?.text?.toString())
            assertEquals(listOf(
                "gym_action" to mapOf("screen" to "coach", "action" to "copy_link", "outcome" to "ok"),
                "gym_action" to mapOf("screen" to "coach", "action" to "copy", "outcome" to "ok"),
            ), events)
        }
    }

    @Test fun aRetainedCopyLinkActionReadsTheAnswersCurrentDestination() {
        lateinit var clipboard: Clipboard
        val answer = mutableStateOf("[Read the plan](https://example.org/first)")
        compose.setContent { GymMaterial {
            clipboard = LocalClipboard.current
            CoachAnswer(answer.value, coachReply(answer.value), emptyList())
        } }
        val copyLink = compose.onNodeWithText("Read the plan").fetchSemanticsNode()
            .config[SemanticsActions.CustomActions].single { it.label == "Copy link" }
        compose.runOnIdle { answer.value = "[Read the plan](https://example.org/current)" }
        compose.runOnIdle {
            assertTrue(copyLink.action())
            assertEquals("https://example.org/current", clipboard.nativeClipboard.primaryClip?.getItemAt(0)?.text?.toString())
        }
        compose.runOnIdle { answer.value += " and [another](https://example.org/another)" }
        val actions = compose.onNodeWithText("Read the plan and another").fetchSemanticsNode()
            .config[SemanticsActions.CustomActions]
        assertEquals(listOf("Copy answer"), actions.map { it.label })
    }

    @Test fun answersWithNoLinkOrSeveralLinksOnlyOfferCopyAnswer() {
        compose.setContent { GymMaterial { Column {
            CoachAnswer("No links here.", coachReply("No links here."), emptyList())
            CoachAnswer("[First](https://example.org/a) and [second](https://example.org/b).", coachReply("[First](https://example.org/a) and [second](https://example.org/b)."), emptyList())
        } } }
        for (label in listOf("No links here.", "First and second.")) {
            val actions = compose.onNodeWithText(label).fetchSemanticsNode().config[SemanticsActions.CustomActions]
            assertEquals(listOf("Copy answer"), actions.map { it.label })
            compose.onNodeWithText(label).performTouchInput { longClick() }
            compose.onNodeWithText("Copy link").assertDoesNotExist()
            compose.onNodeWithText("Copy answer").assertIsDisplayed().performClick()
        }
    }

    @Test fun longPressOnTheLinkOpensTheCopyMenuWithoutOpeningTheBrowser() {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { fail(operation) }
        }
        val displayed = "Read this plan."
        compose.setContent { GymMaterial { CompositionLocalProvider(LocalTelemetry provides telemetry) {
            CoachAnswer("Read [this plan](https://example.org/plan).", coachReply("Read [this plan](https://example.org/plan)."), emptyList())
        } } }
        val layout = mutableListOf<TextLayoutResult>()
        val text = compose.onNodeWithText(displayed, useUnmergedTree = true)
        text.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layout) }
        val linkPosition = layout.single().getBoundingBox(displayed.indexOf("this") + 1).center
        val application: Application = RuntimeEnvironment.getApplication()
        text.performTouchInput { longClick(linkPosition) }
        compose.onNodeWithText("Copy answer").assertIsDisplayed()
        compose.onNodeWithText("Copy link").assertIsDisplayed()
        compose.runOnIdle {
            assertNull(shadowOf(application).nextStartedActivity)
            assertEquals(emptyList<Pair<String, Map<String, String>>>(), events)
        }
    }

    @Test fun aRefusedLinkCopyKeepsTheMenuAndReportsOnlyTheBoundedFailure() {
        var refusal: Exception = SecurityException("private URL")
        val failures = mutableListOf<Pair<String, Map<String, String>>>()
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation to properties }
        }
        compose.setContent {
            val clipboard = object : Clipboard by LocalClipboard.current {
                override suspend fun setClipEntry(clipEntry: ClipEntry?) { throw refusal }
            }
            GymMaterial { CompositionLocalProvider(LocalTelemetry provides telemetry, LocalClipboard provides clipboard) {
                CoachAnswer("[Read the plan](https://example.org/private)", coachReply("[Read the plan](https://example.org/private)"), emptyList())
            } }
        }
        compose.onNodeWithText("Read the plan").performTouchInput { longClick() }
        listOf(SecurityException("private URL"), CancellationException("private URL")).forEachIndexed { index, error ->
            compose.runOnIdle { refusal = error }
            compose.onNodeWithText("Copy link").assertIsDisplayed().performClick().assertIsDisplayed()
            compose.runOnIdle {
                assertEquals(List(index + 1) { "gym.copyMessage" to emptyMap<String, String>() }, failures)
                assertEquals(List(index + 1) {
                    "gym_action" to mapOf("screen" to "coach", "action" to "copy_link", "outcome" to "failed")
                }, events)
            }
        }
    }

    @Test fun longMarkdownUsesTheFullLaneAndTableCellsKeepTheirContent() {
        val answer = "## Thursday · Push A\n\nKeep the same total work each week.\n\n- Bench — 3 × 3 at 90 kg\n\n| Movement | Sets | Load |\n| --- | --- | --- |\n| Incline Press | 3 × 10 | 24 kg |"
        compose.setContent { GymMaterial { Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
            CoachQuestion("What should Thursday look like?")
            CoachAnswer(answer, coachReply(answer), emptyList())
        } } }
        val question = compose.onNodeWithText("What should Thursday look like?").getUnclippedBoundsInRoot()
        val markdown = compose.onNodeWithText("Thursday · Push A").getUnclippedBoundsInRoot()
        assertTrue(question.right - question.left <= 321.dp)
        val layout = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText("What should Thursday look like?", useUnmergedTree = true)
            .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layout) }
        assertEquals(16.sp, layout.single().layoutInput.style.fontSize)
        assertEquals(22.sp, layout.single().layoutInput.style.lineHeight)
        assertEquals(380.dp, markdown.right - markdown.left)
        compose.onNodeWithText("Movement", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("Incline Press", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("3 × 10", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("24 kg", useUnmergedTree = true).assertIsDisplayed()
    }

    @Test fun timestampsFollowThePhoneClockAndKeepTheQuestionDate() {
        val previous = Locale.getDefault()
        Locale.setDefault(Locale.US)
        try {
            val now = Instant.parse("2026-10-28T19:00:00Z").toEpochMilli()
            val today = Instant.parse("2026-10-28T18:40:00Z").toEpochMilli()
            val yesterday = Instant.parse("2026-10-27T19:02:00Z").toEpochMilli()
            assertEquals("Today 18:40", coachTimestamp(today, now, true, ZoneOffset.UTC)?.text(ApplicationProvider.getApplicationContext()))
            assertEquals("Today 6:40 PM", coachTimestamp(today, now, false, ZoneOffset.UTC)?.text(ApplicationProvider.getApplicationContext()))
            assertEquals("Yesterday 19:02", coachTimestamp(yesterday, now, true, ZoneOffset.UTC)?.text(ApplicationProvider.getApplicationContext()))
            assertNull(coachTimestamp(0, now, true, ZoneOffset.UTC)?.text(ApplicationProvider.getApplicationContext()))
        } finally { Locale.setDefault(previous) }
    }
}
