package works.windmill.gym.ui

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onFirst
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult

// D8. A swipe arrives faster than a sheet can rise, so a second walk while a deviation is pending is
// REFUSED rather than overwriting it — overwriting would take the question about the movement you
// left and never ask it. What this file pins is that the refusal is SAID: a stroke that quietly did
// nothing reads as a broken stroke, and the sentence names the movement whose question is standing.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class LoggerWalkRefusalTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val said = mutableListOf<String?>()

    // Signed out, so the whole workout is composed on the device and the plan comes from the routine
    // the device holds — nothing here depends on a server.
    private fun logger(scope: CoroutineScope): EngineRoomFixture {
        val room = EngineRoomFixture(tmp.newFolder(), scope)
        room.now = System.currentTimeMillis()
        runBlocking {
            room.select(null)
            val routine = (room.store.saveRoutine(
                RoutineDraft(name = "Push A")
                    .adding("bench-press")
                    .adding("barbell-row")
                    .targeting("bench-press", List(5) { SetTarget(5, 82.5) })
            ) as GymResult.Ok).value
            room.store.start(routine.id)
            // The walk is what the session HOLDS, in the order it was walked.
            room.store.choose("bench-press")
            room.store.choose("barbell-row")
            room.store.choose("bench-press")
            // Heavier than the plan's 82.5, which is the whole reason a question gets raised.
            room.store.logSet(weightKg = 87.5, reps = 5)
        }
        room.store.observeEngine()
        compose.setContent {
            LoggerScreen(store = room.store, isSignedIn = false, say = { said += it },
                         onFinish = {}, onSignIn = {}, onSettings = {})
        }
        return room
    }

    private fun walk(from: String) = compose
        .onAllNodes(hasText(from) and hasClickAction()).onFirst()
        .fetchSemanticsNode().config.getOrNull(SemanticsActions.CustomActions).orEmpty()
        .single { it.label == "Next movement" }.action!!

    @Test
    fun aSecondWalkWhileAQuestionIsPendingIsRefusedInWordsThatNameTheMovement() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope).use { room ->
            // Both walks land in the same frame, before the sheet can rise: the case a stroke makes
            // ordinary and a tap never did.
            val leaving = walk("Bench Press")
            compose.runOnUiThread {
                leaving()
                leaving()
            }
            compose.waitForIdle()

            assertEquals("Bench Press first — that question is still open.", said.last())
            assertEquals("the pending question was not overwritten", "barbell-row", room.store.exerciseId)
        } } finally { scope.cancel() }
    }

    @Test
    fun anOrdinaryWalkSaysNothingAtAllAndClearsWhatWasSaidBefore() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope).use {
            compose.runOnUiThread { walk("Bench Press")() }
            compose.waitForIdle()

            assertNull("a walk that went through has nothing to say", said.last())
        } } finally { scope.cancel() }
    }
}
