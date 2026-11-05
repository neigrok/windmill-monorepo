package works.windmill.gym

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.coach.Ask
import works.windmill.gym.coach.Threads
import works.windmill.gym.coach.turn.ScriptedTurns
import works.windmill.gym.presentation.Routine
import works.windmill.gym.presentation.RoutineDraft
import works.windmill.gym.presentation.SetTarget
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.FinishOutcome
import works.windmill.gym.store.GymResult
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.LocalShellActions
import works.windmill.platform.ShellActions
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.core.Json
import works.windmill.sync.modelserver.ModelServer
import works.windmill.sync.api.Change
import works.windmill.sync.api.Gesture
import works.windmill.sync.api.NewID
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.Gym

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class CoachOverWorkoutTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()
    private val events = mutableListOf<Pair<String, Map<String, String>>>()
    private val failures = mutableListOf<String>()
    private val telemetry = object : Telemetry {
        override fun event(name: String, properties: Map<String, String>) { events += name to properties }
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
    }

    private val pushA = listOf("bench-press", "overhead-press", "incline-dumbbell-press", "cable-fly", "triceps-pushdown")

    private fun workoutRoom(server: ScriptedTurns = ScriptedTurns(emptyList()), signedIn: Boolean = true, routineId: String = "rt_00000001", coachShown: Boolean = true,
        log: ModelServer = EngineRoomFixture.server(), test: (EngineRoomFixture, Routine) -> Unit) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val phone = EngineRoomFixture(tmp.newFolder(), scope, telemetry = telemetry, coachServer = server, mintRoutine = { routineId }, coachShown = coachShown)
        var showing by mutableStateOf(true)
        try {
            val routine = runBlocking {
                phone.select("u1".takeIf { signedIn })
                if (signedIn) phone.pull(log)
                val draft = pushA.fold(RoutineDraft(name = "Push A")) { held, movement -> held.adding(movement, List(3) { SetTarget(8) }) }
                val saved = (phone.store.routines.saveRoutine(draft.capturingMovements(phone.store.routines.catalog)) as GymResult.Ok).value
                assertTrue(phone.store.workout.start(saved.id) is GymResult.Ok)
                phone.store.workout.choose("overhead-press")
                saved
            }
            phone.store.observeEngine()
            val account = phone.account()
            val shell = ShellActions(openYou = {})
            compose.setContent {
                if (showing) CompositionLocalProvider(LocalShellActions provides shell, LocalTelemetry provides telemetry) {
                    GymMaterial { GymRoom(account, phone.store) }
                }
            }
            events.clear()
            test(phone, routine)
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            scope.cancel(); phone.close()
        }
    }

    private val session = "session01"

    private fun entry(movement: String) = """{"exerciseId":"$movement","sets":[{"reps":8},{"reps":8},{"reps":8}]}"""

    // Incline Dumbbell Press out, a dumbbell bench at 20 kg each in its place, as Coach's call.
    private val swap = """{"callId":"toolu_1","name":"propose_workout_change","input":{"id":"wpWWWWWWWWWWWWW1","sessionId":"$session","summary":"","entries":[
        ${entry("bench-press")},${entry("overhead-press")},{"exerciseId":"dumbbell-bench-press","sets":[{"reps":10,"weightKg":20},{"reps":10,"weightKg":20},{"reps":10,"weightKg":20}]},${entry("cable-fly")},${entry("triceps-pushdown")}]}}"""

    private fun answering(vararg calls: String) = ScriptedTurns(Json.parse("""[
        {"event":"calls","data":{"batch":1,"calls":[${calls.joinToString(",")}]}},
        {"await":"results","batch":1},
        {"event":"text","data":{"delta":"Overhead Press is logged, so it stays."}},
        {"event":"done","data":{"state":"completed"}}]""").arr())

    private fun asking(question: String = "My shoulder is sore today.") {
        compose.onNodeWithContentDescription("Coach").performClick()
        compose.onNodeWithContentDescription("Question").performClick().performTextReplacement(question)
        compose.onNodeWithContentDescription("Send").performClick()
    }

    private fun waitFor(text: String) = compose.waitUntil(10_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }

    private fun outcomes() = events.filter { it.first == "gym_proposal_outcome" }.map { it.second }

    private fun screens() = events.filter { it.first == "gym_screen_viewed" }.map { it.second["screen"] }

    @Test fun theBarOpensCoachOnAFreshChatAndClosingItLeavesTheRackAsItWas() = workoutRoom { phone, _ ->
        val rack = phone.store.workout.rack
        val before = phone.store.coach.selectedChatId
        compose.onNodeWithText("Finish").assertIsDisplayed()
        compose.onNodeWithContentDescription("Hide workout").assertIsDisplayed()
        compose.onNodeWithText("Push A").getUnclippedBoundsInRoot().let { title ->
            assertEquals("the title stays centred between Finish and its two actions", 206.dp, (title.left + title.right) / 2)
        }

        compose.onNodeWithContentDescription("Coach").performClick()

        compose.onNodeWithContentDescription("History").assertIsDisplayed()
        compose.onNodeWithText(Ask.placeholder).assertIsDisplayed()
        compose.onNodeWithText(Ask.title).assertIsDisplayed()
        compose.onNodeWithContentDescription("Your account").assertDoesNotExist()
        compose.runOnIdle { assertNotEquals(before, phone.store.coach.selectedChatId) }
        compose.runOnIdle { assertEquals(listOf(mapOf("screen" to "coach", "action" to "fresh_entry", "outcome" to "ok"), mapOf("screen" to "workout", "action" to "open_coach", "outcome" to "ok")),
            events.filter { it.first == "gym_action" }.map { it.second }) }
        compose.waitUntil(5_000) { "coach" in screens() }

        compose.onNode(hasContentDescription("Close sheet")).performSemanticsAction(SemanticsActions.OnClick)
        compose.waitUntil(5_000) { compose.onAllNodesWithText(Ask.placeholder).fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithText("Finish").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(rack, phone.store.workout.rack)
            assertEquals("overhead-press", phone.store.workout.exerciseId)
            assertEquals(listOf("coach", "workout"), screens().takeLast(2))
        }
    }

    @Test fun coachOverTheWorkoutReadsWhileItsSheetStandsAndNotAfter() = workoutRoom(coachShown = false) { phone, _ ->
        val conversations = phone.store.conversations
        fun plant(id: String) = phone.engine.commit(ScopeRef(Gym.scope), Gesture(listOf(Change.create(Gym.Types.thread, NewID.Given(RecordID(id)), mapOf("title" to Json.of(id))))))
        plant("thread-one")
        compose.onNodeWithText("Finish").assertIsDisplayed()
        compose.runOnIdle { assertEquals(emptyList<String>(), conversations.threads.map { it.title }) }

        compose.onNodeWithContentDescription("Coach").performClick()
        compose.waitUntil(60_000) {
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
            conversations.threads.isNotEmpty()
        }
        compose.runOnIdle { assertEquals(listOf("thread-one"), conversations.threads.map { it.title }) }

        compose.onNode(hasContentDescription("Close sheet")).performSemanticsAction(SemanticsActions.OnClick)
        compose.waitUntil(60_000) { compose.onAllNodesWithText(Ask.placeholder).fetchSemanticsNodes().isEmpty() }
        plant("thread-two")
        compose.waitForIdle()
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
        compose.runOnIdle { assertEquals(listOf("thread-one"), conversations.threads.map { it.title }) }
    }

    @Test fun signedOutWithNoCoachForThisPhoneTheBarHasNoDoor() = workoutRoom(signedIn = false) { _, _ ->
        compose.onNodeWithText("Finish").assertIsDisplayed()
        compose.onNodeWithContentDescription("Hide workout").assertIsDisplayed()
        compose.onNodeWithContentDescription("Coach").assertDoesNotExist()
    }

    @Test fun aChangeToThisWorkoutIsReviewedAppliedAndRewritesTheRunningPlanAlone() = workoutRoom(answering(swap)) { phone, routine ->
        asking()
        waitFor("Proposal · This workout")
        compose.onNodeWithText("2 changes to this workout.").assertIsDisplayed()
        compose.onNodeWithText("2 changes").assertIsDisplayed()
        compose.onNodeWithText(Ask.promise).assertIsDisplayed()
        assertEquals("over the workout the card and its promise stand on the thread's own edge", 16.dp, compose.onNodeWithText(Ask.promise).getUnclippedBoundsInRoot().left)
        compose.onNodeWithText("Applied · this workout · 2 changes").assertDoesNotExist()

        compose.onNodeWithText("Review").performClick()

        waitFor("Apply all 2")
        compose.onAllNodesWithText("Proposal · This workout").fetchSemanticsNodes().let { assertEquals("the card beneath and the sheet's head", 2, it.size) }
        compose.onNodeWithText("Remove Incline Dumbbell Press").assertIsDisplayed()
        compose.onNodeWithText("removed from this workout · never logged").assertIsDisplayed()
        compose.onNodeWithText("Add Dumbbell Bench Press").assertIsDisplayed()
        compose.onNodeWithText("3 × 10 · 20 kg each · after Overhead Press").assertIsDisplayed()
        compose.onNodeWithText("and 4 lines unchanged").assertIsDisplayed()
        compose.onNodeWithText("All two or none. Nothing is applied until you tap.").assertIsDisplayed()
        compose.onNodeWithText("Turn this down").assertIsDisplayed()
        compose.onNodeWithText("Ask Coach").assertDoesNotExist()
        compose.waitUntil(5_000) { "proposal" in screens() }

        compose.onNodeWithText("Apply all 2").performClick()

        waitFor("Applied · this workout · 2 changes")
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Apply all 2").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithText(Ask.promise).assertDoesNotExist()
        compose.onNodeWithText("Proposal · This workout").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(listOf("bench-press", "overhead-press", "dumbbell-bench-press", "cable-fly", "triceps-pushdown"),
                phone.store.workout.session!!.plan!!.entries.map { it.exerciseId })
            assertEquals(listOf("bench-press", "overhead-press", "dumbbell-bench-press", "cable-fly", "triceps-pushdown"), phone.store.workout.order)
            assertEquals("the routine it came from stands", pushA, phone.store.routines.routine(routine.id)!!.entries.map { it.exerciseId })
            assertEquals("the log has not answered", emptyList<Map<String, String>>(), outcomes())
            assertEquals(emptyList<String>(), failures)
        }
    }

    @Test fun turningItDownIsConfirmedAndSaysNothingChanged() = workoutRoom(answering(swap)) { phone, _ ->
        asking()
        waitFor("Proposal · This workout")
        compose.onNodeWithText("Review").performClick()
        waitFor("Turn this down")
        compose.onNodeWithText("Turn this down").performClick()
        compose.onNodeWithText("Turn down").performClick()

        waitFor("Turned down · nothing changed.")
        compose.runOnIdle { assertEquals(pushA, phone.store.workout.session!!.plan!!.entries.map { it.exerciseId }) }
    }

    private fun routineChange(routineId: String, vararg movements: String) =
        """{"callId":"toolu_2","name":"propose_routine_change","input":{"id":"prWWWWWWWWWWWWW1","routineId":"$routineId","summary":"","entries":[${movements.joinToString(",") { entry(it) }}]}}"""

    // A routine's change reaches that routine's next workout: its card says so, and its review is the ordinary one (08.56).
    @Test fun oneAnswerCarriesBothKindsEachOnItsOwnCardAndClosingARoutinesReviewReturnsToCoachOverTheRack() {
        val routineId = "rt_00000009"
        workoutRoom(answering(swap, routineChange(routineId, "bench-press")), routineId = routineId) { phone, _ ->
            val rack = phone.store.workout.rack
            asking()
            waitFor("Proposal · This workout")
            waitFor("Proposal · Push A · next time")
            compose.onNodeWithText("Proposal · Push A · next time").performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("4 changes to Push A.").performScrollTo().assertIsDisplayed()
            assertEquals("the promise stands once, under them", 1, compose.onAllNodesWithText(Ask.promise).fetchSemanticsNodes().size)

            assertEquals(2, compose.onAllNodesWithText("Review").fetchSemanticsNodes().size)
            compose.onAllNodesWithText("Review")[1].performScrollTo().performClick()

            waitFor("Proposal · Push A")
            compose.onNodeWithText("Finish this session").assertDoesNotExist()
            compose.onNodeWithText("Remove Incline Dumbbell Press").assertIsDisplayed()
            compose.onNodeWithText("Apply all 4").assertIsDisplayed()
            compose.onNodeWithText("Turn this down").assertIsDisplayed()
            compose.onNodeWithText("Ask Coach").assertDoesNotExist()

            compose.onAllNodes(hasContentDescription("Close sheet")).onLast().performSemanticsAction(SemanticsActions.OnClick)
            compose.waitUntil(5_000) { compose.onAllNodesWithText("Apply all 4").fetchSemanticsNodes().isEmpty() }
            compose.onNodeWithText(Ask.placeholder).assertIsDisplayed()
            compose.onNodeWithText("Finish").assertExists()
            compose.runOnIdle { assertEquals(rack, phone.store.workout.rack) }
        }
    }

    @Test fun aRoutinesChangeAppliedOverTheWorkoutsCoachLandsInTheConversationAndTheRackStands() {
        val routineId = "rt_00000009"
        val log = EngineRoomFixture.server()
        workoutRoom(answering(routineChange(routineId, "bench-press", "overhead-press", "cable-fly", "triceps-pushdown")), routineId = routineId, log = log) { phone, _ ->
            val rack = phone.store.workout.rack
            val plan = phone.store.workout.session!!.plan
            asking()
            waitFor("Proposal · Push A · next time")
            compose.onNodeWithText("Review").performScrollTo().performClick()
            waitFor("Remove Incline Dumbbell Press")
            compose.runOnIdle { phone.sync(log) }

            compose.onNodeWithText("Apply").performClick()
            compose.waitUntil(5_000) { compose.runOnIdle { phone.outbox().any { it["intent"]?.get("cmd")?.get("name")?.str() == "gym.applyProposal" } } }
            compose.runOnIdle { phone.sync(log) }

            compose.waitUntil(15_000) {
                org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
                compose.onAllNodesWithText("Applied · Push A · 1 change").fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText(Ask.placeholder).assertIsDisplayed()
            compose.runOnIdle {
                assertEquals(listOf("bench-press", "overhead-press", "cable-fly", "triceps-pushdown"), phone.store.routines.routine(routineId)!!.entries.map { it.exerciseId })
                assertEquals("the running plan stands", plan, phone.store.workout.session!!.plan)
                assertEquals(pushA, phone.store.workout.session!!.plan!!.entries.map { it.exerciseId })
                assertEquals("the rack stands", rack, phone.store.workout.rack)
                assertEquals(listOf(mapOf("action" to "apply", "outcome" to "decided")), outcomes())
                assertEquals(emptyList<String>(), failures)
            }
        }
    }

    // Logged movements stay immutable: logging what the proposal changes takes its decision away, and its card and sheet say why.
    @Test fun aMovementLoggedSinceTakesTheDecisionAwayAndTheCardSaysWhich() = workoutRoom(answering(swap)) { phone, _ ->
        asking()
        waitFor("Proposal · This workout")
        val line = "You logged Incline Dumbbell Press since this suggestion. Nothing was applied."

        runBlocking {
            phone.store.workout.choose("incline-dumbbell-press")
            phone.store.workout.logSet(20.0, 8)
            phone.store.refreshEngine()
        }

        waitFor("Proposal · This workout · out of date")
        compose.onNodeWithText(line).assertIsDisplayed()
        compose.onNodeWithText(Ask.promise).assertDoesNotExist()

        compose.onNodeWithText("Review").performClick()

        compose.waitUntil(10_000) { compose.onAllNodesWithText(line).fetchSemanticsNodes().size == 2 }
        compose.onNodeWithText("Apply all 2").assertDoesNotExist()
        compose.onNodeWithText("Turn this down").assertDoesNotExist()
        compose.onNodeWithText("removed from this workout · 1 logged set kept").assertIsDisplayed()
    }

    // History closes the sheet and stands over the logger; a new question from it comes back to the sheet.
    @Test fun aDoorClosesTheSheetFirstAndANewQuestionReturnsToIt() = workoutRoom { phone, _ ->
        compose.onNodeWithContentDescription("Coach").performClick()
        compose.onNodeWithContentDescription("History").performClick()

        compose.waitUntil(5_000) { compose.onAllNodesWithText(Ask.placeholder).fetchSemanticsNodes().isEmpty() }
        waitFor("History")
        compose.waitUntil(5_000) { "threads" in screens() }

        val before = compose.runOnIdle { phone.store.coach.selectedChatId }
        compose.onNodeWithContentDescription(Threads.open).performClick()

        waitFor(Ask.placeholder)
        compose.onNodeWithText("Finish").assertExists()
        compose.runOnIdle { assertNotEquals(before, phone.store.coach.selectedChatId) }
    }

    @Test fun theSheetGoesWithTheWorkout() = workoutRoom { phone, _ ->
        compose.onNodeWithContentDescription("Coach").performClick()
        compose.onNodeWithText(Ask.placeholder).assertIsDisplayed()

        runBlocking { assertTrue(phone.store.workout.finish() is FinishOutcome.Closed) }

        compose.waitUntil(5_000) { compose.onAllNodesWithText(Ask.placeholder).fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithContentDescription("Coach").assertDoesNotExist()
    }
}
