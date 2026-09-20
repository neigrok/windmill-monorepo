package works.windmill.gym.ui

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import java.io.File
import kotlinx.coroutines.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.*
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.net.TrainingSyncing
import works.windmill.gym.store.*
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
import androidx.activity.ComponentDialog
import org.robolectric.shadows.ShadowDialog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class RecordStateTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()
    private fun store(scope: CoroutineScope, server: TrainingSyncing): TrainingStore = TrainingStore(
        SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "catalog")), LocalLog(File(tmp.root, "log")),
        LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "weight")), scope, sync = { server }).also {
        runBlocking { it.connect(Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }), User("a", "a@example.com", "A"))) }
    }

    @Test
    fun initialReadIsHonestAndRenameKeepsOverlongDraftWithoutInventingARecord() {
        val movement = Exercise("bench", "Bench Press", "push", "barbell")
        val release = CompletableDeferred<Unit>()
        val server = FakeTraining().apply { catalog = listOf(movement); records[movement.id] = MovementRecord(movement) }
        val boundary = object : TrainingSyncing by server {
            override suspend fun record(exerciseId: String): MovementRecord? { release.await(); return server.record(exerciseId) }
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = store(scope, boundary)
        compose.setContent { GymMaterial { RecordScreen(movement.id, store, "Log", {}) } }
        compose.onNodeWithText("Reading your log…").assertIsDisplayed()
        compose.onNodeWithText("Rename").assertDoesNotExist()
        compose.runOnIdle { release.complete(Unit) }
        compose.onNodeWithText("Nothing logged for this movement yet. The first set you log lands here.").assertIsDisplayed()
        compose.onNodeWithText("Rename").performClick()
        compose.onNode(hasSetTextAction()).performTextReplacement("N".repeat(61))
        compose.onNodeWithText("61/60").assertIsDisplayed()
        compose.onNode(hasText("Rename") and hasAnyAncestor(isDialog())).assertIsNotEnabled()
        compose.onNodeWithText("Old name: Bench Press\nSearchable as an alias.").assertExists()
        assertEquals(listOf(movement), store.catalog.filter { it.id == movement.id })
        scope.cancel()
    }

    @Test
    fun sharedProgressFailureCannotExposeRenameOrFallbackMetrics() {
        val movement = Exercise("bench", "Bench Press", "push", "barbell")
        val server = FakeTraining().apply { catalog = listOf(movement); records[movement.id] = MovementRecord(movement,
            bestE1rm = RecordMark(999.0, 1, 1, 999.0)) }
        val boundary = object : TrainingSyncing by server { override suspend fun progress(): StatsProgress = throw java.io.IOException("offline") }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = store(scope, boundary)
        compose.setContent { GymMaterial { RecordScreen(movement.id, store, "Log", {}) } }
        compose.onNodeWithText("Record unavailable").assertIsDisplayed()
        compose.onNodeWithText("Rename").assertDoesNotExist()
        compose.onNodeWithText("999").assertDoesNotExist()
        compose.onNodeWithText("Try again").assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun pendingRenameKeepsItsDraftAndDismissalLockThenShowsOnlyTheConfirmedName() {
        val movement = Exercise("bench", "Bench Press", "push", "barbell")
        val confirmed = movement.copy(name = "Paused Bench Press")
        val server = FakeTraining().apply { catalog = listOf(movement); records[movement.id] = MovementRecord(movement) }
        val release = CompletableDeferred<Unit>()
        val writes = mutableListOf<Pair<String, String>>()
        val boundary = object : TrainingSyncing by server {
            override suspend fun renameExercise(exerciseId: String, name: String): Exercise {
                writes += exerciseId to name
                if (writes.size == 1) {
                    release.await()
                    throw WindmillApiException.Refused(400, Refusal(message = "That name could not be saved."))
                }
                return confirmed
            }
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = store(scope, boundary)
        compose.setContent { GymMaterial { RecordScreen(movement.id, store, "Log", {}) } }
        compose.onNodeWithText("Rename").performClick()
        compose.onNode(hasSetTextAction()).performTextReplacement("Paused Bench")
        compose.onNode(hasText("Rename") and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithText("Renaming…").assertIsNotEnabled().performClick()
        compose.onNodeWithText("Paused Bench").assertIsNotEnabled()
        compose.runOnIdle { (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText("Paused Bench").assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf("bench" to "Paused Bench"), writes); release.complete(Unit) }
        compose.onNodeWithText("That name could not be saved.").assertIsDisplayed()
        compose.onNodeWithText("Paused Bench").assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf(movement), store.catalog.filter { it.id == "bench" }) }
        compose.onNode(hasText("Rename") and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithText("Paused Bench Press").assertIsDisplayed()
        compose.onNodeWithText("Rename movement").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(listOf("bench" to "Paused Bench", "bench" to "Paused Bench"), writes)
            assertEquals(listOf(confirmed), store.catalog.filter { it.id == "bench" })
        }
        scope.cancel()
    }
}
