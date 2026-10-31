package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.FixOrigin
import works.windmill.platform.telemetry.Telemetry
import org.junit.Assert.assertTrue
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.NumberEntry
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.FixOutcome
import works.windmill.gym.store.WriteFailure

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class FixSheetStateTests {
    @get:Rule val compose = createComposeRule()

    @Test
    fun pendingSaveBlocksEditsAndDeleteThenRetainsTheDraftForRetry() {
        val set = TrainingSet(id = "set_3", exerciseId = "bench-press", setNumber = 3,
            weightKg = 60.0, reps = 8, completedAtMs = 0)
        val answer = CompletableDeferred<FixOutcome>()
        val attempts = mutableListOf<SetFix>()
        val busy = mutableListOf<Boolean>()
        var saves = 0
        var deletes = 0
        compose.setContent {
            FixSheet(set, "Bench Press", 3, "Push A",
                onSave = {
                    attempts += it
                    if (attempts.size == 1) answer.await() else FixOutcome.Corrected(it.corrected(set))
                },
                onDelete = { deletes++ }, onSaved = { saves++ }, onBusy = { busy += it })
        }
        compose.onNodeWithText("Bench Press · Set 3").assertIsDisplayed()
        compose.onNodeWithText("Set note").performTextInput("left shoulder")
        compose.onNodeWithText("Save fix").performScrollTo().performClick()
        compose.onNodeWithText("Saving…").assertIsNotEnabled().performClick()
        compose.onNodeWithText("Delete set").assertIsNotEnabled().performClick()
        compose.onNodeWithText("60").assertIsNotEnabled()
        compose.runOnIdle {
            assertEquals(listOf(SetFix(note = "left shoulder")), attempts)
            assertEquals(listOf(true), busy)
            assertEquals(0, deletes)
            assertEquals(0, saves)
            answer.complete(FixOutcome.Failed(WriteFailure.NoAnswer))
        }
        compose.onNodeWithText("The log didn’t answer — that set wasn’t changed.").assertIsDisplayed()
        compose.onNodeWithText("left shoulder").assertIsDisplayed()
        compose.onNodeWithText("Save fix").performScrollTo().performClick()
        compose.runOnIdle {
            assertEquals(listOf(SetFix(note = "left shoulder"), SetFix(note = "left shoulder")), attempts)
            assertEquals(listOf(true, false, true, false), busy)
            assertEquals(1, saves)
        }
    }

    @Test
    fun bodyAndRefusedEmbeddedBufferSurviveRestorationThenCancelKeepsTheBodyDraft() {
        val set = TrainingSet(id = "set_3", exerciseId = "bench-press", setNumber = 3,
            weightKg = 60.0, reps = 8, completedAtMs = 0)
        val restorer = StateRestorationTester(compose)
        val attempts = mutableListOf<SetFix>()
        var cancel: (() -> Unit)? = null
        restorer.setContent {
            FixSheet(set, "Bench Press", 3, "Push A", onSave = {
                attempts += it
                FixOutcome.Failed(WriteFailure.Refused("This workout belongs to another account."))
            }, onDelete = {}, onEntryCancel = { cancel = it })
        }
        compose.onNodeWithText("Set note").performTextInput("controlled tempo")
        compose.onNodeWithContentDescription("Load, kg").performClick().performTextReplacement("1e999")
        compose.onNodeWithContentDescription("Load, kg").performImeAction()
        restorer.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("1e999").assertIsDisplayed()
        compose.onNodeWithText(NumberEntry.notANumber).assertIsDisplayed()
        compose.onNodeWithContentDescription("Load, kg").performClick()
        compose.onNodeWithContentDescription("Reps, reps").performClick()
        compose.onNodeWithText("1e999").assertIsDisplayed()
        compose.runOnIdle { cancel!!() }
        compose.onNodeWithText("60").assertIsDisplayed()
        compose.onNodeWithText("controlled tempo").assertIsDisplayed()
        compose.onNodeWithText("Save fix").performScrollTo().performClick()
        restorer.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("This workout belongs to another account.").assertIsDisplayed()
        compose.onNodeWithText("controlled tempo").assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf(SetFix(note = "controlled tempo")), attempts) }
    }

    @Test
    fun missingSetReportsItsOwnerOutcomeWithoutPretendingToSave() {
        val set = TrainingSet(id = "gone", exerciseId = "bench-press", setNumber = 7,
            weightKg = 60.0, reps = 8, completedAtMs = 0)
        val missing = mutableListOf<String>()
        var saves = 0
        compose.setContent {
            FixSheet(set, "Bench Press", 7, null,
                onSave = { FixOutcome.Gone("That set is no longer in the log.") },
                onDelete = {}, onSaved = { saves++ }, onGone = { missing += it })
        }
        compose.onNodeWithText("Save fix").performScrollTo().performClick()
        compose.runOnIdle {
            assertEquals(listOf("That set is no longer in the log."), missing)
            assertEquals(0, saves)
        }
    }
    @Test
    fun theDraftKeyNotTheSetDecidesTheBodyAndOpenNumberDraft() {
        var set by mutableStateOf(TrainingSet(id = "local_set", exerciseId = "bench-press", setNumber = 3,
            weightKg = 60.0, reps = 8, completedAtMs = 0))
        val attempts = mutableListOf<SetFix>()
        var cancel: (() -> Unit)? = null
        compose.setContent {
            FixSheet(set, "Bench Press", 3, "Push A", draftKey = "local_set",
                onSave = { attempts += it; FixOutcome.Corrected(it.corrected(set)) }, onDelete = {}, onEntryCancel = { cancel = it })
        }
        compose.onNodeWithText("Set note").performTextInput("controlled tempo")
        compose.onNodeWithContentDescription("Load, kg").performClick().performTextReplacement("70")
        compose.onNodeWithContentDescription("Load, kg").performImeAction()
        compose.onNodeWithContentDescription("Reps, reps").performClick().performTextReplacement("100")
        compose.onNodeWithContentDescription("Reps, reps").performImeAction()
        compose.runOnIdle { set = set.copy(id = "canonical_set") }
        compose.onNodeWithText("100").assertIsDisplayed()
        compose.onNodeWithText(NumberEntry.outsideReps).assertIsDisplayed()
        compose.onNodeWithContentDescription("Load, kg").performClick()
        compose.onNodeWithText(NumberEntry.outsideReps).assertIsDisplayed()
        compose.runOnIdle { cancel!!() }
        compose.onNodeWithText("70").assertIsDisplayed()
        compose.onNodeWithText("controlled tempo").assertIsDisplayed()
        compose.onNodeWithText("Save fix").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(SetFix(weightKg = 70.0, note = "controlled tempo")), attempts) }
    }

    @Test
    fun theDraftKeyKeepsAnInFlightSaveLockedAndItsRefusalEditable() {
        var set by mutableStateOf(TrainingSet(id = "local_set", exerciseId = "bench-press", setNumber = 3,
            weightKg = 60.0, reps = 8, completedAtMs = 0))
        val answer = CompletableDeferred<FixOutcome>()
        val attempts = mutableListOf<SetFix>()
        val busy = mutableListOf<Boolean>()
        compose.setContent {
            FixSheet(set, "Bench Press", 3, "Push A", draftKey = "local_set",
                onSave = { attempts += it; answer.await() }, onDelete = {}, onBusy = { busy += it })
        }
        compose.onNodeWithText("Set note").performTextInput("controlled tempo")
        compose.onNodeWithText("Save fix").performScrollTo().performClick()
        compose.runOnIdle { set = set.copy(id = "canonical_set") }
        compose.onNodeWithText("Saving…").assertIsNotEnabled().performClick()
        compose.onNodeWithText("Delete set").assertIsNotEnabled()
        compose.runOnIdle {
            assertEquals(listOf(SetFix(note = "controlled tempo")), attempts)
            assertEquals(listOf(true), busy)
            answer.complete(FixOutcome.Failed(WriteFailure.NoAnswer))
        }
        compose.onNodeWithText("The log didn’t answer — that set wasn’t changed.").assertIsDisplayed()
        compose.onNodeWithText("controlled tempo").assertIsDisplayed()
        compose.runOnIdle { set = set.copy(id = "reconciled_set") }
        compose.onNodeWithText("The log didn’t answer — that set wasn’t changed.").assertIsDisplayed()
        compose.onNodeWithText("controlled tempo").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(listOf(true, false), busy)
            assertEquals(listOf(SetFix(note = "controlled tempo")), attempts)
        }
    }

    @Test fun replacingTheSheetAfterItsWriteKeepsOneSettledResultAndTheSavedNote() {
        val directory = java.nio.file.Files.createTempDirectory("fix-sheet").toFile()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        var hold = false
        val waiting = ArrayDeque<Runnable>()
        val reads = object : CoroutineDispatcher() {
            override fun isDispatchNeeded(context: CoroutineContext) = hold
            override fun dispatch(context: CoroutineContext, block: Runnable) { waiting.add(block) }
        }
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val failures = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        try {
            EngineRoomFixture(directory, scope, telemetry = telemetry, readDispatcher = reads).use { room ->
                val session = runBlocking { room.select(null); room.workout() }
                var held by mutableStateOf(room.training.session(session.id)!!.sets.single())
                var shown by mutableStateOf(true)
                var saved = 0
                events.clear()
                compose.setContent { if (shown) GymMaterial {
                    FixSheet(held, "Bench Press", 1, null, origin = FixOrigin.Session,
                        onSave = { room.store.fixSet(session.id, held.id, it, FixOrigin.Session) },
                        onSaved = { saved++ }, onDelete = {})
                } }
                compose.onNodeWithText("Set note").performTextInput("  exact note\n  ")
                compose.runOnIdle { hold = true }
                compose.onNodeWithText("Save fix").performScrollTo().performClick()
                compose.onNodeWithText("Saving…").assertIsNotEnabled()
                compose.runOnIdle {
                    assertEquals(1, waiting.size)
                    assertEquals("  exact note\n  ", room.training.session(session.id)!!.sets.single().note)
                    shown = false
                }
                compose.waitForIdle()
                compose.runOnIdle {
                    hold = false
                    while (waiting.isNotEmpty()) waiting.removeFirst().run()
                }
                compose.waitForIdle()
                val persisted = room.engine.snapshot()
                compose.runOnIdle { held = room.training.session(session.id)!!.sets.single(); shown = true }
                compose.onNodeWithText("  exact note\n  ").assertIsDisplayed()
                compose.onNodeWithText("Save fix").assertIsDisplayed()
                compose.runOnIdle {
                    assertEquals(0, saved)
                    assertEquals(persisted, room.engine.snapshot())
                    assertEquals(listOf("gym_action" to mapOf("screen" to "session", "action" to "fix", "outcome" to "ok")), events)
                    assertTrue(failures.isEmpty())
                    shown = false
                }
                compose.waitForIdle()
            }
        } finally { scope.cancel(); directory.deleteRecursively() }
    }

}
