package works.windmill.gym.ui

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onFirst
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.net.WindmillApi

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
    private fun logger(scope: CoroutineScope): TrainingStore {
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            mintSession = { "ses_1" },
            mintSet = Ids::set,
            undoWindowMs = SetQueue.undoWindowMs,
            sync = { null },
        )
        runBlocking {
            // The six ride with every seat, so Bench Press and Barbell Row are already named.
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = null))
            val routine = (store.saveRoutine(
                RoutineDraft(name = "Push A")
                    .adding("bench-press")
                    .adding("barbell-row")
                    .targeting("bench-press", sets = 5, reps = 5, weightKg = 82.5)
            ) as GymResult.Ok).value
            store.start(routine.id)
            // The walk is what the session HOLDS, in the order it was walked.
            store.choose("bench-press")
            store.choose("barbell-row")
            store.choose("bench-press")
            // Heavier than the plan's 82.5, which is the whole reason a question gets raised.
            store.logSet(weightKg = 87.5, reps = 5)
        }
        compose.setContent {
            LoggerScreen(store = store, isSignedIn = false, say = { said += it },
                         onFinish = {}, onSignIn = {}, onSettings = {})
        }
        return store
    }

    private fun walk(from: String) = compose
        .onAllNodes(hasText(from) and hasClickAction()).onFirst()
        .fetchSemanticsNode().config.getOrNull(SemanticsActions.CustomActions).orEmpty()
        .single { it.label == "Next movement" }.action!!

    @Test
    fun aSecondWalkWhileAQuestionIsPendingIsRefusedInWordsThatNameTheMovement() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = logger(scope)

        // Both walks land in the same frame, before the sheet can rise: the case a stroke makes
        // ordinary and a tap never did.
        val leaving = walk("Bench Press")
        compose.runOnUiThread {
            leaving()
            leaving()
        }
        compose.waitForIdle()

        assertEquals("Bench Press first — that question is still open.", said.last())
        assertEquals("the pending question was not overwritten", "barbell-row", store.exerciseId)
        scope.cancel()
    }

    @Test
    fun anOrdinaryWalkSaysNothingAtAllAndClearsWhatWasSaidBefore() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        logger(scope)

        compose.runOnUiThread { walk("Bench Press")() }
        compose.waitForIdle()

        assertNull("a walk that went through has nothing to say", said.last())
        scope.cancel()
    }
}
