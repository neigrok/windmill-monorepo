package works.windmill.gym.ui

import androidx.activity.OnBackPressedDispatcher
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.GymRoom
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.RoutineEntryWrite
import works.windmill.gym.domain.RoutineWrite
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.*
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class RoutineSaveTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    private fun deferredSave(refuse: Boolean) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val gate = CompletableDeferred<Unit>()
        val writes = mutableListOf<RoutineWrite>()
        val original = Routine("rt_push", "Push", entries = listOf(RoutineEntry(1, "bench-press"), RoutineEntry(2, "back-squat")))
        val server = FakeTraining().apply {
            written[original.id] = original
            refuseRoutine = { write ->
                writes += write
                gate.await()
                if (refuse) WindmillApiException.Refused(409, Refusal(message = "Keep this draft", code = "revision-conflict")) else null
            }
        }
        val account = Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }),
            User(id = "a", email = "a@example.com", name = "A"))
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")), deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")), localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")), scope = scope, sync = { server },
        )
        runBlocking { store.connect(account) }
        lateinit var back: OnBackPressedDispatcher
        compose.setContent {
            back = LocalOnBackPressedDispatcherOwner.current!!.onBackPressedDispatcher
            GymMaterial { GymRoom(account, store) }
        }
        compose.onNodeWithText("Push").performClick()
        compose.onNodeWithText("Edit routine").performClick()
        compose.onNodeWithContentDescription("Routine name").performTextReplacement("Saved push")
        compose.onNodeWithText("Save").performClick()
        compose.onNodeWithText("Saving…").assertIsNotEnabled().performClick()
        compose.onNodeWithContentDescription("Routine name").assertIsNotEnabled().performClick()
        compose.onNodeWithText("Bench Press").assertIsNotEnabled().performClick()
        compose.onNodeWithText("Bench Press").performTouchInput { swipeLeft() }
        compose.onNodeWithText("Add movement").assertIsNotEnabled().performClick()
        compose.onNodeWithContentDescription("Move Bench Press, 1 of 2", useUnmergedTree = true).assertIsNotEnabled()
        compose.onNodeWithContentDescription("Back to the routine you were on").assertIsNotEnabled().performClick()
        compose.runOnIdle { back.onBackPressed() }
        compose.onNodeWithContentDescription("Routine name").assertTextEquals("Saved push")
        compose.onNodeWithText("Edit routine").assertIsDisplayed()
        assertEquals(listOf(RoutineWrite("rt_push", "Saved push", 0,
            listOf(RoutineEntryWrite("bench-press"), RoutineEntryWrite("back-squat")), expectedRevision = 1)), writes)
        val row = compose.onNodeWithText("Bench Press").fetchSemanticsNode()
        assertTrue(row.config[SemanticsActions.CustomActions].isEmpty())
        compose.runOnIdle { gate.complete(Unit) }
        compose.waitForIdle()
        if (refuse) {
            compose.onNodeWithContentDescription("Routine name").assertIsEnabled().assertTextEquals("Saved push")
            compose.onNodeWithText("Save").assertIsEnabled()
            compose.onNodeWithText("Keep this draft").assertIsDisplayed()
            compose.onNodeWithContentDescription("Routine name").performTextReplacement("Retry push")
            compose.onNodeWithContentDescription("Routine name").assertTextEquals("Retry push")
            assertEquals(original, server.written[original.id])
        } else {
            compose.onNodeWithContentDescription("Routine name").assertDoesNotExist()
            compose.onNodeWithText("Saved push").assertIsDisplayed()
            assertEquals(original.copy(name = "Saved push", revision = 2), server.written[original.id])
        }
        scope.cancel()
    }

    @Test fun successfulSaveFreezesTheInvokingDraftUntilItLands() = deferredSave(refuse = false)
    @Test fun refusedSaveUnfreezesTheSameRecoverableDraft() = deferredSave(refuse = true)
}
