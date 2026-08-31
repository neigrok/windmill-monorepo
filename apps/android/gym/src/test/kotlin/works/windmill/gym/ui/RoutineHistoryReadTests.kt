package works.windmill.gym.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import java.io.File
import java.io.IOException
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
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException

// "the log didn't answer" is a claim about the log. A log that answered with a reason keeps its own
// sentence, and only silence gets the composed one — the rule `WriteFailure.line` already holds and
// the history block used to talk over.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RoutineHistoryReadTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private fun screen(scope: CoroutineScope, refusing: Exception): TrainingStore {
        val server = FakeTraining()
        server.written["rt_1"] = Routine(
            id = "rt_1", name = "Push Day", position = 0, revision = 1,
            entries = listOf(RoutineEntry(exerciseId = "bench-press")),
        )
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            sync = { server },
        )
        runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = User(id = "u1", email = "sam@example.com", name = "Sam"),
            ))
        }
        server.refuseRoutineRead = refusing
        compose.setContent {
            RoutineScreen(
                routineId = "rt_1",
                store = store,
                isSignedIn = true,
                backTo = "Routines",
                onBack = {},
                onStart = {},
                onBuild = {},
                onOpenMovement = {},
                lookedAt = emptySet(),
                onReview = {},
                onOpenThread = {},
            )
        }
        return store
    }

    @Test
    fun testARefusedHistoryReadKeepsTheLogsOwnWords() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        screen(scope, WindmillApiException.Refused(
            403, Refusal(message = "that routine is not yours to read", code = null),
        ))

        compose.onNodeWithText("that routine is not yours to read").assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun testOnlySilenceSaysTheLogDidNotAnswer() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        screen(scope, IOException("no route to host"))

        compose.onNodeWithText(
            "the log didn’t answer — this routine’s history is out of reach",
        ).assertIsDisplayed()
        scope.cancel()
    }
}
