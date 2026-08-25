package works.windmill.gym.ui

import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasStateDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import java.io.File
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
import works.windmill.gym.domain.Ask
import works.windmill.gym.domain.AskAnswer
import works.windmill.gym.domain.AskExchange
import works.windmill.gym.domain.AskStep
import works.windmill.gym.domain.ReadTally
import works.windmill.gym.domain.Threads
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AskScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val read = ReadTally(sets = 214, sessions = 34, weeks = 12)

    private fun store(scope: CoroutineScope): TrainingStore {
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            scope = scope,
            sync = { FakeTraining() },
        )
        runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = User(id = "u1", email = "sam@example.com", name = "Sam"),
            ))
        }
        return store
    }

    private fun room(
        store: TrainingStore,
        thread: List<AskExchange>,
        capped: Boolean,
        doors: MutableList<String>,
    ) {
        compose.setContent {
            AskScreen(
                store = store,
                thread = thread,
                asking = false,
                capped = capped,
                onAsk = { doors += "ask:$it" },
                onRetry = {},
                onAskNew = { doors += "askNew" },
                seed = "",
                origin = "https://windmill.works",
                backLabel = null,
                onBack = null,
                onThreads = { doors += "threads" },
                onNotes = { doors += "notes" },
                onReview = {},
            )
        }
    }

    @Test
    fun theAllowanceIsOneLineAboveTheComposerAndTheParagraphIsGone() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        room(store(scope), thread = emptyList(), capped = false, doors = mutableListOf())

        compose.onNodeWithText(Ask.title).assertIsDisplayed()
        compose.onNodeWithText(Ask.subtitle).assertIsDisplayed()
        compose.onNodeWithText("Ten questions a day, three back to back.").assertIsDisplayed()
        compose.onNodeWithText(Ask.placeholder).assertIsDisplayed()
        compose.onNodeWithText("There is nothing to buy here.", substring = true).assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun theAllowanceStaysOnceAQuestionIsSpentAndTheStepsSitBehindTheReceiptInTheLiftersWords() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val answered = AskExchange(
            question = "what’s stalled?",
            answer = AskAnswer(
                answer = "Bench has been flat for three weeks.",
                read = read,
                steps = listOf(
                    AskStep("get_stats"),
                    AskStep("summon_lightning"),
                    AskStep("list_notes"),
                    AskStep("get_stats"),
                ),
            ),
        )
        room(store(scope), thread = listOf(answered), capped = false, doors = mutableListOf())

        compose.onNodeWithText(Ask.allowance).assertIsDisplayed()
        val receipt = compose.onNodeWithText(Ask.receipt(read)).performScrollTo()
        receipt.assertIsDisplayed()
        receipt.assert(hasStateDescription("collapsed"))
        compose.onNodeWithText("read your movement history").assertDoesNotExist()
        compose.onNodeWithText("summon_lightning", substring = true).assertDoesNotExist()

        receipt.performClick()

        compose.onNodeWithText(Ask.receipt(read)).assert(hasStateDescription("expanded"))
        compose.onNodeWithText("read your movement history").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("read your notes").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(Ask.receipt(read)).assertIsDisplayed()
        compose.onNodeWithText("summon_lightning", substring = true).assertDoesNotExist()
        compose.onNodeWithText("get_stats", substring = true).assertDoesNotExist()
        compose.onNodeWithText("list_notes", substring = true).assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun theCapReachedMomentReplacesTheComposerWithWhatToDoNextAndTheConnectDoor() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val refused = AskExchange(
            question = "is my week too light?",
            trouble = "the next question frees up in a couple of hours",
        )
        val doors = mutableListOf<String>()
        room(store(scope), thread = listOf(refused), capped = true, doors = doors)

        compose.onNodeWithText("The next question frees up in a couple of hours.").assertIsDisplayed()
        // The refusal the log sent is the same sentence: it is said once, by the state, never twice.
        compose.onNodeWithText("the next question frees up in a couple of hours").assertDoesNotExist()
        compose.onNodeWithText("is my week too light?").assertIsDisplayed()
        compose.onNodeWithText(Threads.open).assertIsDisplayed()
        compose.onNodeWithText(Ask.connect).assertIsDisplayed()
        compose.onNodeWithText(Ask.placeholder).assertDoesNotExist()
        // A10: the promise stays drawn above the moment it ran out.
        compose.onNodeWithText(Ask.allowance).assertIsDisplayed()
        compose.onNodeWithText("Try again").assertDoesNotExist()

        compose.onNodeWithText(Threads.open).performClick()
        compose.runOnIdle { assertEquals(listOf("askNew"), doors) }
        scope.cancel()
    }

    @Test
    fun theNotesDoorIsARowInTheRoomAndOpensTheNotes() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val doors = mutableListOf<String>()
        room(store(scope), thread = emptyList(), capped = false, doors = doors)

        compose.onNodeWithText("Notes").performClick()
        compose.onNodeWithText("Threads").performClick()
        compose.runOnIdle { assertEquals(listOf("notes", "threads"), doors) }
        scope.cancel()
    }
}
