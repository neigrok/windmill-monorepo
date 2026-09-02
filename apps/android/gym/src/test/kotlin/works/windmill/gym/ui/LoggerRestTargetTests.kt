package works.windmill.gym.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.net.WindmillApi

// The rest target says where it came from, once, on the timer: a session run from a routine whose
// line carries its own rest draws ` · from the routine` after the target; one run against the dial
// draws the target alone. The settings screen says nothing about the override any more.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class LoggerRestTargetTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private fun logger(scope: CoroutineScope, restSeconds: Int?) {
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
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = null))
            store.savePreferences(GymPreferences(restSeconds = 180))
            store.saveRoutine(RoutineDraft(name = "Push", entries = listOf(
                RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 3, targetReps = 5,
                    restSeconds = restSeconds))))
            store.start(store.routines.single().id)
            store.choose("bench-press")
            store.logSet(60.0, 5)
        }
        compose.setContent {
            LoggerScreen(store = store, isSignedIn = false, say = {}, onFinish = {}, onSignIn = {})
        }
    }

    @Test
    fun testARoutineLinesOwnRestIsNamedOnTheTimer() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        logger(scope, restSeconds = 60)
        compose.onNodeWithText("resting · target 1:00 · from the routine").assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun testTheDialsRestIsNamedWithoutASource() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        logger(scope, restSeconds = null)
        compose.onNodeWithText("resting · target 3:00").assertIsDisplayed()
        scope.cancel()
    }
}
