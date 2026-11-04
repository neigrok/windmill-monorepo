package works.windmill.gym.coach

import android.app.Application
import android.content.Intent
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.Clipboard
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.click
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import works.windmill.domain.kit.AbilityClass
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.ReadServed
import works.windmill.gym.domain.coach.ReadTally
import works.windmill.gym.domain.coach.RecordedRead
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.PlanSnapshot
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.RoutineEntry
import works.windmill.gym.presentation.SessionSummary
import works.windmill.gym.presentation.SetTarget
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.design.LocalWindmillDark
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.core.Json

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class CoachAnswerTests {
    @get:Rule val compose = createComposeRule()

    // A read that served these workouts by identity, as a message's call records it.
    private fun workoutsRead(vararg sessions: String) = RecordedRead.Ids(ReadServed.decode(Json.objectOf(
        "sessions" to Json.Arr(sessions.map { Json.of(it) }), "sets" to Json.Arr(emptyList()), "weeks" to Json.Arr(emptyList()))))

    @Test
    fun linksKeepOnlyTheirLabelAndUseTheCurrentThemesPrimaryUnderline() {
        val dark = mutableStateOf(true)
        var primary = Color.Unspecified
        val url = "https://example.org/top-sets"
        compose.setContent {
            CompositionLocalProvider(LocalWindmillDark provides dark.value) { GymMaterial {
                primary = MaterialTheme.colorScheme.primary
                CoachAnswer("Read [more]($url).", coachReply("Read [more]($url)."), emptyList())
            } }
        }
        val primaries = mutableListOf<Color>()
        for (mode in listOf(true, false)) {
            compose.runOnIdle { dark.value = mode }
            val text = compose.onNodeWithText("Read more.", useUnmergedTree = true)
                .fetchSemanticsNode().config[SemanticsProperties.Text].single()
            assertEquals("Read more.", text.text)
            assertEquals(listOf(AnnotatedString.Range(LinkAnnotation.Url(url, TextLinkStyles(
                SpanStyle(color = primary, textDecoration = TextDecoration.Underline),
            )), 5, 9)), text.getLinkAnnotations(0, text.length))
            primaries += primary
        }
        assertNotEquals(primaries[0], primaries[1])
    }

    @Test
    fun tappingTheRenderedLinkUsesTheAnswersCustomTabHandler() {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
                throw AssertionError(operation)
            }
        }
        compose.setContent { GymMaterial { CompositionLocalProvider(LocalTelemetry provides telemetry) {
            CoachAnswer("Read [more](https://example.org/top-sets).", coachReply("Read [more](https://example.org/top-sets)."), emptyList())
        } } }
        val node = compose.onNodeWithText("Read more.", useUnmergedTree = true)
        val layouts = mutableListOf<TextLayoutResult>()
        node.fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(layouts)
        val position = layouts.single().getBoundingBox(6).center
        node.performTouchInput { click(position) }
        compose.runOnIdle {
            val application: Application = RuntimeEnvironment.getApplication()
            val intent = shadowOf(application).nextStartedActivity
            assertEquals(Intent.ACTION_VIEW, intent.action)
            assertEquals("https://example.org/top-sets", intent.data.toString())
            assertTrue(intent.hasExtra(CustomTabsIntent.EXTRA_SESSION))
            assertEquals(listOf("gym_action" to mapOf("screen" to "coach", "action" to "open_link", "outcome" to "ok")), events)
        }
    }

    @Test
    fun ordinaryMarkdownUsesSixteenDpGuttersAndTheReadTallyKeepsItsThirtyTwoDpStart() {
        val answer = "## Thursday\n\nA complete paragraph."
        compose.setContent { GymMaterial { Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
            CoachAnswer(answer, coachReply(answer, read = ReadTally(1, 1, 1)), emptyList(), receiptInset = 4.dp)
        } } }
        val bubble = compose.onNodeWithText("Thursday").getUnclippedBoundsInRoot()
        assertEquals(16.dp, bubble.left)
        assertEquals(396.dp, bubble.right)
        assertEquals(32.dp, compose.onNodeWithText("Read 1 workout · 1 week", useUnmergedTree = true)
            .getUnclippedBoundsInRoot().left)
        val target = compose.onNodeWithTag("coach-read-sources").assertHasClickAction().getUnclippedBoundsInRoot()
        assertEquals("What Coach read is a 48 dp target", 48.dp, target.bottom - target.top)
    }

    @Test
    fun aMixedWriteReceiptRetainsItsTwentyDpLaneAndExistingTypography() {
        val read = ReadTally(2, 1, 1)
        val reply = coachReply("Ordinary prose.", read = read, calls = listOf(
            coachCall("get_session", "read one workout"), coachCall("save_note", "saved a note", AbilityClass.add)))
        compose.setContent { GymMaterial { Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
            CoachAnswer("Ordinary prose.", reply, emptyList(), receiptInset = 4.dp)
        } } }
        val receipt = Ask.receipt(read).replaceFirstChar { it.uppercase() }
        assertEquals(20.dp, compose.onNodeWithText(receipt).getUnclippedBoundsInRoot().left)
        val layout = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(receipt, useUnmergedTree = true).fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(layout)
        assertEquals(13.sp, layout.single().layoutInput.style.fontSize)
        compose.onNodeWithText(receipt).performClick()
        compose.onNodeWithText("Read one workout").assertIsDisplayed()
        compose.onNodeWithText("Saved a note").assertIsDisplayed()
        compose.onNodeWithText("What Coach read").assertDoesNotExist()
    }

    @Test
    fun aSecondParagraphCopyMenuAndExpandedReceiptSurviveReplacementByOneParagraph() {
        lateinit var clipboard: Clipboard
        val initial = "First paragraph.\n\nCafé\n東京"
        val final = "Café\n東京 — 🏋🏽‍♀️ é\nFinal words."
        val text = mutableStateOf(initial)
        val calls = listOf(coachCall("list_notes", "read your notes"), coachCall("save_note", "saved a note", AbilityClass.add))
        compose.setContent { GymMaterial {
            clipboard = LocalClipboard.current
            CoachAnswer(text.value, coachReply(text.value, calls = calls), emptyList())
        } }
        compose.onNodeWithText("Read nothing from your log").performClick()
        compose.onNodeWithText("Read your notes").assertIsDisplayed()
        compose.onNodeWithText("Café\n東京").performTouchInput { longClick() }
        compose.runOnIdle { text.value = final }
        compose.onNodeWithText("Copy answer").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(final, clipboard.nativeClipboard.primaryClip?.getItemAt(0)?.text?.toString()) }
        compose.onNodeWithText("Read your notes").assertIsDisplayed()
        compose.onNodeWithText("Saved a note").assertIsDisplayed()
        compose.onNodeWithText("What Coach read").assertDoesNotExist()
    }

    @Test
    fun bothSpeakersCopyExactMultilineTextThroughLongPressAndAccessibleActions() {
        lateinit var clipboard: Clipboard
        val question = "My question.\nSecond line with 2 × 5."
        val answer = "First paragraph.\n\nSecond paragraph — exact text."
        compose.setContent { GymMaterial {
            clipboard = LocalClipboard.current
            Column { CoachQuestion(question); CoachAnswer(answer, coachReply(answer), emptyList()) }
        } }
        compose.onNodeWithText(question).performTouchInput { longClick() }
        compose.onNodeWithText("Copy question").performClick()
        compose.runOnIdle { assertEquals(question, clipboard.nativeClipboard.primaryClip?.getItemAt(0)?.text?.toString()) }
        val message = compose.onNodeWithText("First paragraph.")
        compose.onNodeWithText("Second paragraph — exact text.").assertIsDisplayed()
        val actions = message.fetchSemanticsNode().config[SemanticsActions.CustomActions]
        compose.runOnIdle {
            assertEquals(listOf("Copy answer"), actions.map { it.label })
            actions.single().action()
        }
        compose.runOnIdle { assertEquals(answer, clipboard.nativeClipboard.primaryClip?.getItemAt(0)?.text?.toString()) }
        compose.onNodeWithText("First paragraph.").performTouchInput { longClick() }
        compose.onNodeWithText("Copy answer").performClick()
        compose.runOnIdle { assertEquals(answer, clipboard.nativeClipboard.primaryClip?.getItemAt(0)?.text?.toString()) }
    }

    @Test
    fun markdownRendersAsStyledBlocksAndCopiesAsPlainText() {
        lateinit var clipboard: Clipboard
        val answer = "## Your week\n\n**Bold** start\n\n- Squat\n- Bench\n- Row\n\n1. Warm up\n2. Work"
        compose.setContent { GymMaterial {
            clipboard = LocalClipboard.current
            CoachAnswer(answer, coachReply(answer), emptyList())
        } }
        val bold = compose.onNodeWithText("Bold start").fetchSemanticsNode().config[SemanticsProperties.Text].single { it.text == "Bold start" }
        assertEquals(listOf(AnnotatedString.Range(SpanStyle(fontWeight = FontWeight.Bold), 0, 4)), bold.spanStyles)
        compose.onAllNodes(hasText("•"), useUnmergedTree = true).assertCountEquals(3)
        compose.onNodeWithText("1.", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("2.", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("Warm up", useUnmergedTree = true).assertIsDisplayed()
        val laid = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText("Your week", useUnmergedTree = true).fetchSemanticsNode()
            .config[SemanticsActions.GetTextLayoutResult].action?.invoke(laid)
        assertEquals(17.sp, laid.single().layoutInput.style.fontSize)
        assertEquals(FontWeight.Bold, laid.single().layoutInput.style.fontWeight)
        compose.onNodeWithText("Bold start").performTouchInput { longClick() }
        compose.onNodeWithText("Copy answer").performClick()
        compose.runOnIdle {
            assertEquals("Your week\n\nBold start\n\n- Squat\n- Bench\n- Row\n\n1. Warm up\n2. Work", clipboard.nativeClipboard.primaryClip?.getItemAt(0)?.text?.toString())
        }
    }

    @Test
    fun readOnlyFactsMoveIntoTheSourcesSheetWithoutInventingWorkoutTotals() {
        val log = listOf(
            SessionSummary("session-old", 1000, plan = PlanSnapshot("Old workout"), setCount = 9, tonnageKg = 2700.0),
            SessionSummary("session-asked", 2000, plan = PlanSnapshot("My actual workout"), setCount = 2, tonnageKg = 960.0),
        )
        val answer = "Keep these exact words.\n\nNo invented summary."
        val reply = coachReply(answer, read = ReadTally(4, 3, 1), calls = listOf(
            coachCall("get_sessions", "read your workouts", read = workoutsRead("session-old", "session-asked", "session-gone"))))
        compose.setContent { GymMaterial { Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            CoachAnswer(answer, reply, emptyList(), workouts = { id -> log.firstOrNull { it.id == id } })
        } } }
        compose.onNodeWithText("Keep these exact words.").assertIsDisplayed()
        compose.onNodeWithText("No invented summary.").assertIsDisplayed()
        compose.onNodeWithText("From your log").assertDoesNotExist()
        compose.onNodeWithText("Sets").assertDoesNotExist()
        compose.onNodeWithText("Read 3 workouts · 1 week").performScrollTo().performClick()
        compose.onNodeWithText("What Coach read").assertIsDisplayed()
        compose.onNodeWithText("2 sets · 960 kg", substring = true).assertIsDisplayed()
        compose.onNodeWithText("9 sets · 2700 kg", substring = true).assertIsDisplayed()
        compose.onNodeWithText("My actual workout").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Old workout").performScrollTo().assertIsDisplayed()
        compose.onAllNodes(hasText(" sets · ", substring = true)).assertCountEquals(2)
    }

    @Test
    fun multipleFullReadsHaveOneCompactReceiptAndNoStackOfMetricCards() {
        val log = (1..5).map { SessionSummary("session-$it", it * 1000L, plan = PlanSnapshot("Workout $it"), setCount = it, tonnageKg = it * 120.0) }
        val reply = coachReply("The model's focal answer stays first.", read = ReadTally(15, 5, 1),
            calls = listOf(coachCall("get_sessions", "read your workouts", read = workoutsRead(*log.map { it.id }.toTypedArray()))))
        compose.setContent { GymMaterial { Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            CoachAnswer("The model's focal answer stays first.", reply, emptyList(), workouts = { id -> log.firstOrNull { it.id == id } })
        } } }
        compose.onNodeWithText("The model's focal answer stays first.").assertIsDisplayed()
        compose.onNodeWithText("Sets").assertDoesNotExist()
        compose.onNodeWithText("Read 5 workouts · 1 week").assertIsDisplayed().performClick()
        compose.onNodeWithText("Workout 5").performScrollTo().assertIsDisplayed()
    }

    @Test fun unavailableVolumeKeepsTheExistingSourcesSlotWithoutClaimingZero() {
        val workout = SessionSummary("session-unavailable", 2000, plan = PlanSnapshot("Unavailable fixture"), setCount = 3, tonnageKg = null)
        val reply = coachReply("A factual answer.", read = ReadTally(3, 1, 1), calls = listOf(coachCall("get_session", "read one workout", read = workoutsRead(workout.id))))
        compose.setContent { GymMaterial {
            CoachAnswer("A factual answer.", reply, emptyList(), workouts = { workout })
        } }
        compose.onNodeWithText("Read 1 workout · 1 week").performClick()
        compose.onNodeWithText("3 sets · —", substring = true).assertIsDisplayed()
        compose.onNodeWithText("0 kg", substring = true).assertDoesNotExist()
    }

    @Test
    fun anAnswerNeverTreatsItsProseAsFactsAndSaysWhatItReadOnlyOnceItEnds() {
        val reply = mutableStateOf(coachReply("Nine sets, 2700kg, 48 minutes.", MessageState.running))
        compose.setContent { GymMaterial { CoachAnswer(reply.value.text, reply.value, emptyList()) } }
        compose.onNodeWithText("Nine sets, 2700kg, 48 minutes.").assertIsDisplayed()
        compose.onNodeWithText("Read nothing from your log").assertDoesNotExist()
        compose.runOnIdle { reply.value = reply.value.copy(state = MessageState.completed) }
        compose.onNodeWithText("Nine sets, 2700kg, 48 minutes.").assertIsDisplayed()
        compose.onNodeWithText("Sets").assertDoesNotExist()
        compose.onNodeWithText("From your log").assertDoesNotExist()
        compose.onNodeWithText("Read nothing from your log").assertIsDisplayed()
    }

    @Test fun routineDraftShowsEquipmentAndTargetsBeforeAnExplicitSave() {
        val draft = CoachRoutineDraft("operation-a", "Push", listOf(RoutineEntry(1, "dumbbell-bench-press", listOf(SetTarget(8, 16.0)))))
        var saves = 0
        compose.setContent { GymMaterial {
            CoachAnswer("Review this plan", coachReply("Review this plan"), listOf(Exercise("dumbbell-bench-press", "Flat press", equipment = "dumbbell")),
                routineDrafts = listOf(draft), onSaveDrafts = {
                    saves++
                    if (saves == 1) DraftOutcome.Failed(Ask.draftRetry) else DraftOutcome.Closed(Ask.draftGone)
                })
        } }
        compose.onNodeWithText("Review routine").assertIsDisplayed()
        compose.onNodeWithText("Push").assertIsDisplayed()
        compose.onNodeWithText("Flat press").assertIsDisplayed()
        compose.onNodeWithText("1 × 8 · 16 kg each · Two dumbbells").assertIsDisplayed()
        compose.runOnIdle { assertEquals(0, saves) }
        compose.onNodeWithText("Save routine").performClick()
        compose.onNodeWithText("Couldn’t save the routine. Try again.").assertIsDisplayed()
        compose.onNodeWithText("Save routine").performClick()
        compose.onNodeWithText("This draft is no longer available.").assertIsDisplayed()
        compose.onNodeWithText("Save routine").assertDoesNotExist()
        compose.onNodeWithText("Couldn’t save the routine. Try again.").assertDoesNotExist()
        compose.runOnIdle { assertEquals(2, saves) }
    }

    @Test fun routineDraftNamesEachLoadBasisByEquipmentAndCount() {
        val draft = CoachRoutineDraft("operation-b", "Mixed", listOf(
            RoutineEntry(0, "goblet-squat", listOf(SetTarget(8, 24.0))),
            RoutineEntry(1, "back-squat", listOf(SetTarget(5, 100.0))),
            RoutineEntry(2, "pull-up", listOf(SetTarget(6, -10.0))),
            RoutineEntry(3, "cable-row", listOf(SetTarget(10, 40.0)))))
        compose.setContent { GymMaterial {
            CoachAnswer("Review this plan", coachReply("Review this plan"), listOf(
                Exercise("goblet-squat", "Goblet Squat", equipment = "dumbbell", loadCount = 1),
                Exercise("back-squat", "Back Squat", equipment = "barbell"),
                Exercise("pull-up", "Pull Up", equipment = "bodyweight"),
                Exercise("cable-row", "Cable Row", equipment = "cable")),
                routineDrafts = listOf(draft), onSaveDrafts = { DraftOutcome.Closed(Ask.draftGone) })
        } }
        compose.onNodeWithText("1 × 8 · 24 kg · One dumbbell").assertIsDisplayed()
        compose.onNodeWithText("1 × 5 · 100 kg total · Barbell").assertIsDisplayed()
        compose.onNodeWithText(Readout.target(listOf(SetTarget(6, -10.0))) + " kg assisted · Bodyweight").assertIsDisplayed()
        compose.onNodeWithText("1 × 10 · 40 kg · Cable").assertIsDisplayed()
    }

    @Test fun aTurnThatCreatedItsRoutineAtOnceKeepsThePastTenseStep() {
        val opened = mutableListOf<String>()
        val reply = coachReply("Made it", read = ReadTally(sets = 1), routines = listOf(CreatedRoutine("routine-a", "Push")),
            calls = listOf(coachCall("create_routine", "created a routine", AbilityClass.add)))
        compose.setContent { GymMaterial {
            CoachAnswer("Made it", reply, emptyList(), onOpenRoutine = { opened += it })
        } }
        compose.onNodeWithText("Routine created").assertIsDisplayed()
        compose.onNodeWithText("Push").assertIsDisplayed()
        compose.onNodeWithText("Save routine").assertDoesNotExist()
        compose.onNodeWithText("Open routine").performClick()
        compose.runOnIdle { assertEquals(listOf("routine-a"), opened) }
        compose.onNodeWithText("Read 1 set").performClick()
        compose.onNodeWithText("Created a routine").assertIsDisplayed()
    }
}
