package works.windmill.gym.coach

import android.app.Application
import android.content.Intent
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.Clipboard
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.click
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
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
import works.windmill.gym.domain.coach.AbilityCall
import works.windmill.gym.domain.coach.AbilityRefusal
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.ReadServed
import works.windmill.gym.domain.coach.ReadTally
import works.windmill.gym.domain.coach.RecordedRead
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.RoutineEntry
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
    fun ordinaryMarkdownUsesSixteenDpGuttersAndTheReadLineStandsOnItsMarginWithAFullTarget() {
        val answer = "## Thursday\n\nA complete paragraph."
        compose.setContent { GymMaterial { Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
            CoachAnswer(answer, coachReply(answer, read = ReadTally(1, 1, 1), calls = listOf(coachCall("list_sessions", "read your recent workouts"))), emptyList())
        } } }
        val bubble = compose.onNodeWithText("Thursday").getUnclippedBoundsInRoot()
        assertEquals(16.dp, bubble.left)
        assertEquals(396.dp, bubble.right)
        val line = compose.onNodeWithText("Read 1 workout · 1 week", useUnmergedTree = true).getUnclippedBoundsInRoot()
        assertEquals(28.dp, line.left)
        assertEquals("the line stands 6 dp under its bubble, as drawn", 6f, (line.top - bubble.bottom).value, 1f)
        val target = compose.onNodeWithTag("coach-read-sources").assertHasClickAction()
        assertEquals("the line stands 22 dp in the column", 22f, target.getUnclippedBoundsInRoot().let { it.bottom - it.top }.value, 1f)
        target.performTouchInput { click(Offset(center.x, height + 10.dp.toPx())) }
        compose.onNodeWithText("What Coach read").assertIsDisplayed()
    }

    @Test
    fun anAnswerWithNothingItRanSaysWhatItReadWithNoDoor() {
        compose.setContent { GymMaterial { CoachAnswer("Prose.", coachReply("Prose."), emptyList()) } }
        compose.onNodeWithText("Read nothing from your log").assertIsDisplayed().assert(hasClickAction().not())
    }

    @Test
    fun aRetainedAnswerSaysNothingOfWhatItRead() {
        compose.setContent { GymMaterial { CoachAnswer("Prose.", coachReply("Prose."), emptyList(), saysWhatItRead = false) } }
        compose.onNodeWithText("Prose.").assertIsDisplayed()
        compose.onNodeWithTag("coach-read-sources").assertDoesNotExist()
    }

    @Test
    fun aSecondParagraphCopyMenuSurvivesReplacementByOneParagraph() {
        lateinit var clipboard: Clipboard
        val initial = "First paragraph.\n\nCafé\n東京"
        val final = "Café\n東京 — 🏋🏽‍♀️ é\nFinal words."
        val text = mutableStateOf(initial)
        compose.setContent { GymMaterial {
            clipboard = LocalClipboard.current
            CoachAnswer(text.value, coachReply(text.value), emptyList())
        } }
        compose.onNodeWithText("Café\n東京").performTouchInput { longClick() }
        compose.runOnIdle { text.value = final }
        compose.onNodeWithText("Copy answer").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(final, clipboard.nativeClipboard.primaryClip?.getItemAt(0)?.text?.toString()) }
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
    fun whatCoachReadListsOneRowPerAbilityInOrderWithWhatItReturned() {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) = throw AssertionError(operation)
        }
        val reply = coachReply("Keep these exact words.", read = ReadTally(40, 18, 6), calls = listOf(
            coachCall("list_sessions", "read your recent workouts", read = workoutsRead(*Array(18) { "session-$it" }), detail = "6 weeks · Sep 14 – Oct 25"),
            coachCall("list_notes", "read your notes", detail = "2 notes"),
            coachCall("list_exercises", "read your movement list"),
            coachCall("list_routines", "read your program", detail = "Push A · Pull A · Legs"),
            coachCall("propose_routine_change", "wrote a proposal for one of your routines", detail = "Push A · 3 changes"),
            coachCall("summon_lightning", phrase = null),
            coachCall("get_stats", "read your movement history", outcome = AbilityCall.Outcome.Refused(AbilityRefusal.refused)),
        ))
        compose.setContent { GymMaterial { CompositionLocalProvider(LocalTelemetry provides telemetry) { Column(Modifier.fillMaxSize()) {
            CoachAnswer("Keep these exact words.", reply, emptyList())
        } } } }
        compose.onNodeWithText("What Coach read").assertDoesNotExist()
        compose.onNodeWithText("Read 18 workouts · 6 weeks").assertIsDisplayed().performClick()
        val shown = listOf("What Coach read", "What Coach used, in order",
            "Read 18 workouts", "6 weeks · Sep 14 – Oct 25",
            "Read your notes", "2 notes",
            "Read your movement list",
            "Read your program", "Push A · Pull A · Legs",
            "Wrote a proposal for one of your routines", "Push A · 3 changes",
            "A workout read twice counts once.")
        val tops = shown.map { compose.onNodeWithText(it).performScrollTo().assertIsDisplayed().getUnclippedBoundsInRoot().top }
        assertEquals("the rows stand in the order the turn ran them", tops.sortedBy { it.value }, tops)
        compose.onNodeWithText("summon_lightning", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Read your movement history").assertDoesNotExist()
        compose.onNodeWithText("Close").performScrollTo().performClick()
        compose.onNodeWithText("What Coach read").assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf("gym_action" to mapOf("screen" to "coach", "action" to "read_sources", "outcome" to "ok")), events) }
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

    @Test fun aTurnThatCreatedItsRoutinesDrawsOneReceiptEachThenWhatItRead() {
        val opened = mutableListOf<String>()
        val reply = coachReply("I made 2 routines.", routines = listOf(CreatedRoutine("routine-a", "Full body A", 3), CreatedRoutine("routine-b", "Full body B", 1)),
            calls = listOf(coachCall("create_routine", "created a routine", detail = "Full body A"), coachCall("create_routine", "created a routine", detail = "Full body B")))
        compose.setContent { GymMaterial {
            CoachAnswer("I made 2 routines.", reply, emptyList(), onOpenRoutine = { opened += it })
        } }
        compose.onNodeWithText("Routine created · 3 movements", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("Routine created · 1 movement", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("Save routine").assertDoesNotExist()
        compose.onNodeWithText("Only on this phone ·").assertDoesNotExist()
        compose.onNodeWithText("Full body B", useUnmergedTree = true).performClick()
        compose.runOnIdle { assertEquals(listOf("routine-b"), opened) }
        val card = compose.onNodeWithText("Routine created · 1 movement", useUnmergedTree = true).getUnclippedBoundsInRoot()
        val line = compose.onNodeWithText("Read nothing from your log", useUnmergedTree = true).getUnclippedBoundsInRoot()
        assertTrue("what it read stands under the card", line.top > card.bottom)
        compose.onNodeWithText("Read nothing from your log").performClick()
        compose.onAllNodesWithText("Created a routine").assertCountEquals(2)
    }

    @Test fun signedOutTheRoutinesATurnCreatedOfferKeepingThem() {
        var kept = 0
        val reply = coachReply("I made a routine.", routines = listOf(CreatedRoutine("routine-a", "Full body A", 3)), calls = listOf(coachCall("create_routine", "created a routine")))
        compose.setContent { GymMaterial { CoachAnswer("I made a routine.", reply, emptyList(), onKeep = { kept++ }) } }
        compose.onNodeWithText("Only on this phone ·").assertIsDisplayed()
        compose.onNodeWithText("Keep it").assertHasClickAction().performClick()
        compose.runOnIdle { assertEquals(1, kept) }
    }

    @Test fun aRunningAnswerDrawsTheStepsSoFarAndNothingOfHowItEnded() {
        val reply = mutableStateOf(coachReply("Thursday is still a Push day.", MessageState.running, calls = listOf(
            coachCall("list_sessions", "read your recent workouts"), coachCall("list_notes", "read your notes"))))
        compose.setContent { GymMaterial { CoachAnswer(reply.value.text, reply.value, emptyList()) } }
        compose.onNodeWithTag("coach-step-line").assertTextEquals("read your recent workouts · read your notes")
        compose.onNodeWithTag("coach-ending").assertDoesNotExist()
        compose.onNodeWithTag("coach-read-sources").assertDoesNotExist()
        compose.runOnIdle { reply.value = reply.value.copy(state = MessageState.completed) }
        compose.onNodeWithTag("coach-step-line").assertDoesNotExist()
        compose.onNodeWithText("Read nothing from your log").assertIsDisplayed()
    }

    @Test fun anAnswerOnItsWayWithNoWordsYetDrawsTheDotsOverItsSteps() {
        compose.setContent { GymMaterial {
            CoachAnswer("", coachReply("", MessageState.running, calls = listOf(coachCall("list_sessions", "read your recent workouts"))), emptyList())
        } }
        compose.onNodeWithContentDescription("Coach is thinking").assertIsDisplayed()
        compose.onNodeWithTag("coach-step-line").assertTextEquals("read your recent workouts")
    }

    @Test fun aTurnEndedShortSaysHowInItsLineOverWhatItRead() {
        val read = ReadTally(40, 18, 6)
        val calls = listOf(coachCall("list_sessions", "read your recent workouts"))
        val endings = mapOf(
            coachReply("Thursday is still a Push day.", truncated = true, read = read, calls = calls) to "Cut short. Ask Coach to go on.",
            coachReply("", MessageState.declined, read = read, calls = calls) to "Coach declined to answer this.",
            coachReply("Thursday is still a Push day.", MessageState.failed, read = read, calls = calls) to "Coach couldn’t finish. Ask again.",
            coachReply("Thursday is still a Push day.", MessageState.stopped, read = read, calls = calls) to "Stopped.",
            coachReply("Thursday is still a Push day.", MessageState.interrupted, read = read, calls = calls) to "Interrupted. What arrived is kept.",
        )
        val reply = mutableStateOf(endings.keys.first())
        compose.setContent { GymMaterial { CoachAnswer(reply.value.text, reply.value, emptyList()) } }
        endings.forEach { (ended, line) ->
            compose.runOnIdle { reply.value = ended }
            compose.onNodeWithTag("coach-ending").assertTextEquals(line)
            val bottom = compose.onNodeWithTag("coach-ending").getUnclippedBoundsInRoot().bottom
            val under = compose.onNodeWithText("Read 18 workouts · 6 weeks", useUnmergedTree = true).getUnclippedBoundsInRoot().top
            assertEquals("the receipt stands 4 dp under the line", 4f, (under - bottom).value, 1f)
        }
    }

    @Test fun aRunningAnswerAnotherDeviceWritesSaysOnlyThat() {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) = throw AssertionError(operation)
        }
        val reply = coachReply("", MessageState.running, onThisPhone = false, calls = listOf(coachCall("list_sessions", "read your recent workouts")))
        compose.setContent { GymMaterial { CompositionLocalProvider(LocalTelemetry provides telemetry) { CoachAnswer("", reply, emptyList()) } } }
        compose.onNodeWithText("Answering on another device").assertIsDisplayed()
        compose.onNodeWithContentDescription("Coach is thinking").assertDoesNotExist()
        compose.onNodeWithTag("coach-step-line").assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf("gym_action" to mapOf("screen" to "coach", "action" to "answering_elsewhere", "outcome" to "ok")), events) }
    }

    @Test fun aMovementCoachMadeReadsAsOneAddedChange() {
        val reply = coachReply("Done.", madeMovements = listOf(MadeMovement("movement-a", "Incline Dumbbell Press", "Dumbbells", 2.5)), calls = listOf(coachCall("create_exercise", "created a movement")))
        compose.setContent { GymMaterial { Column(Modifier.fillMaxSize()) { CoachAnswer("Done.", reply, emptyList()) } } }
        listOf("Made a movement", "Added", "Name", "Equipment", "Dumbbells", "Step", "2.5 kg").forEach { compose.onNodeWithText(it).assertIsDisplayed() }
        compose.onAllNodesWithText("Incline Dumbbell Press").assertCountEquals(2)
    }

    @Test fun aNoteCoachSavedReadsAsItsCard() {
        val reply = coachReply("I saved this as a note.", savedNotes = listOf(SavedNote("note-a", "Left shoulder hurts on wide-grip bench.")), calls = listOf(coachCall("save_note", "saved a note")))
        compose.setContent { GymMaterial { Column(Modifier.fillMaxSize()) { CoachAnswer("I saved this as a note.", reply, emptyList()) } } }
        listOf("Saved a note", "Note", "Left shoulder hurts on wide-grip bench.").forEach { compose.onNodeWithText(it).assertIsDisplayed() }
    }

    @Test fun aCallThatNeededTheAccountOffersSignInOnceTheAnswerEnded() {
        var doors = 0
        val refused = coachCall("save_note", "saved a note", outcome = AbilityCall.Outcome.Refused(AbilityRefusal.seatRequired))
        val reply = mutableStateOf(coachReply("I can’t save that signed out.", MessageState.running, calls = listOf(refused)))
        compose.setContent { GymMaterial { CoachAnswer(reply.value.text, reply.value, emptyList(), onSignIn = { doors++ }) } }
        compose.onNodeWithText("Sign in").assertDoesNotExist()
        compose.runOnIdle { reply.value = reply.value.copy(state = MessageState.completed) }
        compose.onNodeWithText("Sign in").performClick()
        compose.runOnIdle { assertEquals(1, doors) }
        val door = compose.onNodeWithText("Sign in").getUnclippedBoundsInRoot()
        assertTrue("the receipt stands under the door", compose.onNodeWithText("Read nothing from your log", useUnmergedTree = true).getUnclippedBoundsInRoot().top > door.bottom)
    }
}
