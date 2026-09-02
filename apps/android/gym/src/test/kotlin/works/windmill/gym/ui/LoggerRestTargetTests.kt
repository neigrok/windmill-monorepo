package works.windmill.gym.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasContentDescription
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
// line carries its own rest SAYS ` · from the routine` after the target; one run against the dial
// says the target alone. The clocks row draws two numerals and a ring and speaks the whole label —
// the same bytes the old row drew — so the pin reads the description, not the drawn text. The
// settings screen says nothing about the override any more.
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
            LoggerScreen(store = store, isSignedIn = false, say = {}, onFinish = {}, onSignIn = {}, onSettings = {})
        }
    }

    @Test
    fun testARoutineLinesOwnRestIsNamedOnTheTimer() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        logger(scope, restSeconds = 60)
        compose.onNode(hasContentDescription("resting · target 1:00 · from the routine  ·  ", substring = true))
            .assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun testTheDialsRestIsNamedWithoutASource() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        logger(scope, restSeconds = null)
        compose.onNode(hasContentDescription("resting · target 3:00  ·  ", substring = true)).assertIsDisplayed()
        compose.onAllNodes(hasContentDescription("from the routine", substring = true)).assertCountEquals(0)
        scope.cancel()
    }
}
