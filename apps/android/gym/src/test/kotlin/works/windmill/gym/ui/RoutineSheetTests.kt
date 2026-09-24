package works.windmill.gym.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.GymRoom
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.net.TrainingSyncing
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
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillApi

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class RoutineSheetTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun routinePlanOpensOverTheListAndEditsWithoutAnyHistoryRead() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try {
            val routine = Routine("rt_push", "Push Day", lastTrainedAtMs = 1_000,
                entries = listOf(
                    RoutineEntry(2, "barbell-row", List(3) { SetTarget(10, 40.0) }),
                    RoutineEntry(1, "bench-press", List(3) { SetTarget(8, 50.0) }),
                ))
            val server = FakeTraining().apply {
                written[routine.id] = routine
                refuseRoutineRead = IOException("routine history must not be read")
            }
            val account = Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }),
                User("u1", "sam@example.com", "Sam"))
            val store = TrainingStore(
                queue = SetQueue(File(tmp.root, "queue.json")),
                deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
                localLog = LocalLog(File(tmp.root, "local.json")),
                localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
                localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
                scope = scope,
                sync = { server },
            )
            runBlocking { store.connect(account) }
            compose.setContent { GymMaterial { GymRoom(account, store) } }

            compose.onNodeWithText("Bench Press · Barbell Row").assertIsDisplayed()
            compose.onNodeWithText("Push Day").performClick()
            compose.onNodeWithTag("routine-sheet").assertIsDisplayed()
            compose.onAllNodesWithText("Push Day").assertCountEquals(2)
            compose.onNodeWithText("New routine").assertExists()
            compose.onNodeWithText("3 × 8 · 50 kg").assertIsDisplayed()
            compose.onNodeWithText("3 × 10 · 40 kg").assertIsDisplayed()
            compose.onNodeWithText("History").assertDoesNotExist()
            compose.onNodeWithText("Last trained", substring = true).assertDoesNotExist()
            compose.onNodeWithText("Rest 1:30").assertDoesNotExist()
            compose.onNodeWithText("Edit routine").performClick()
            compose.onNodeWithTag("routine-sheet").assertDoesNotExist()
            compose.onNodeWithContentDescription("Routine name").assertTextEquals("Push Day")
            compose.onNodeWithText("Recent changes").assertDoesNotExist()
            compose.onNodeWithText("3 × 8 · 50kg").assertIsDisplayed()
            compose.onNodeWithText("3 × 10 · 40kg").assertIsDisplayed()
            compose.onNodeWithContentDescription("Routine name").performTextReplacement("Push A")
            compose.onNodeWithText("Save").performClick()
            compose.onNodeWithTag("routine-sheet").assertIsDisplayed()
            compose.onAllNodesWithText("Push A").assertCountEquals(2)
            compose.runOnIdle {
                assertEquals(emptyList<String>(), server.calls.filter { it == "routine" })
                assertEquals(routine.entries.sortedBy { it.position }, server.written.getValue(routine.id).entries)
            }

            compose.onNodeWithContentDescription("Close sheet").performClick()
            compose.onNodeWithTag("routine-sheet").assertDoesNotExist()
            compose.onNodeWithText("Push A").assertIsDisplayed().performClick()
            compose.onNodeWithText("Start workout").performClick()
            compose.onNodeWithTag("routine-sheet").assertDoesNotExist()
            compose.runOnIdle { assertEquals(routine.id, store.session?.routineId) }
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun refusedStartKeepsThePlanAndPendingStartCannotFireTwice() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try {
            val gate = CompletableDeferred<Unit>()
            val attempts = mutableListOf<String?>()
            val server = FakeTraining().apply {
                written["rt_push"] = Routine("rt_push", "Push A",
                    entries = listOf(RoutineEntry(1, "bench-press", listOf(SetTarget(8, 50.0)))))
            }
            val boundary = object : TrainingSyncing by server {
                override suspend fun startSession(start: SessionStart): Session {
                    attempts += start.routineId
                    if (attempts.size == 1) {
                        gate.await()
                        throw WindmillApiException.Refused(409, Refusal(message = "Keep this plan open", code = null))
                    }
                    return server.startSession(start)
                }
            }
            val account = Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }),
                User("u1", "sam@example.com", "Sam"))
            val store = TrainingStore(SetQueue(File(tmp.root, "queue.json")), DeviceCopy(File(tmp.root, "catalog.json")),
                LocalLog(File(tmp.root, "local.json")), LocalPreferences(File(tmp.root, "prefs.json")),
                LocalBodyweight(File(tmp.root, "bodyweight.json")), scope, sync = { boundary })
            runBlocking { store.connect(account) }
            compose.setContent { GymMaterial { GymRoom(account, store) } }
            compose.onNodeWithText("Push A").performClick()
            compose.onNodeWithText("Start workout").performClick()
            compose.onNodeWithText("Start workout").assertIsNotEnabled().performClick()
            compose.onNodeWithText("Edit routine").assertIsNotEnabled()
            compose.runOnIdle { assertEquals(listOf("rt_push"), attempts); gate.complete(Unit) }
            compose.onNodeWithTag("routine-sheet").assertIsDisplayed()
            compose.onNodeWithText("Keep this plan open").assertIsDisplayed()
            compose.onNodeWithText("Start workout").assertIsEnabled().performClick()
            compose.onNodeWithTag("routine-sheet").assertDoesNotExist()
            compose.runOnIdle {
                assertEquals(listOf("rt_push", "rt_push"), attempts)
                assertEquals("rt_push", store.session?.routineId)
            }
        } finally {
            scope.cancel()
        }
    }
}
