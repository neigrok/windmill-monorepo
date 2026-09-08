package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
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
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.domain.TargetEntry
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.net.WindmillApi

// R7: `±` is drawn only on the load fields of a movement the catalog loads by bodyweight — the
// one place a negative load, band assistance, is a plan a lifter can mean — and nowhere else.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class TargetSheetSignKeyTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private fun store(scope: CoroutineScope): TrainingStore {
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            sync = { null },
        )
        runBlocking {
            store.connect(Account(api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }), user = null))
        }
        return store
    }

    private fun editor(scope: CoroutineScope, opening: RoutineDraft, movement: String): () -> RoutineDraft {
        val store = store(scope)
        var draft by mutableStateOf(opening)
        compose.setContent {
            RoutineBuilder(
                draft = draft,
                store = store,
                saving = false,
                onDraft = { draft = it },
                onSave = {},
                onClose = {},
                say = {},
            )
        }
        compose.onNodeWithText(movement).performClick()
        return { draft }
    }

    private fun typed(description: String): String =
        compose.onNodeWithContentDescription(description).fetchSemanticsNode()
            .config[SemanticsProperties.EditableText].text

    private fun signKeys() = compose.onAllNodesWithContentDescription(KeypadEntry.signName)

    @Test
    fun testTheSignKeyStandsOnEveryLoadFieldOfABodyweightMovementAndOnNoBarbell() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val pull = RoutineDraft(name = "Pull A").adding("chin-up").adding("barbell-row")
            .targeting("chin-up", List(3) { SetTarget(8, 20.0) })
            .targeting("barbell-row", List(3) { SetTarget(8, 60.0) })
        editor(scope, pull, "Chin Up")

        signKeys().assertCountEquals(4)
        compose.onAllNodesWithText("±").assertCountEquals(4)
        scope.cancel()
    }

    @Test
    fun testABarbellsSheetHasNoSignKey() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft(name = "Push A").adding("bench-press")
            .targeting("bench-press", List(3) { SetTarget(8, 60.0) }), "Bench Press")

        signKeys().assertCountEquals(0)
        compose.onAllNodesWithText("±").assertCountEquals(0)
        scope.cancel()
    }

    // The head's key writes every row; a row's key writes that row alone; and a second press is the
    // way back to a loaded lift.
    @Test
    fun testTheHeadsSignWritesEveryRowAndARowsSignWritesItsOwn() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, RoutineDraft(name = "Pull A").adding("chin-up")
            .targeting("chin-up", List(3) { SetTarget(8, 20.0) }), "Chin Up")

        signKeys()[0].performClick()
        assertEquals("−20", typed("Weight target"))
        assertEquals(List(3) { "−20" }, (1..3).map { typed("Set $it load") })

        signKeys()[2].performClick()
        assertEquals("20", typed("Set 2 load"))
        assertEquals("", typed("Weight target"))
        compose.onAllNodesWithText(TargetEntry.varies, useUnmergedTree = true).assertCountEquals(1)

        signKeys()[2].performClick()
        assertEquals("−20", typed("Weight target"))

        compose.onNodeWithText("Set · 3 × 8 · −20").performClick()
        compose.runOnIdle {
            assertEquals("band-assisted work is a negative load", List(3) { SetTarget(8, -20.0) }, draft().entry("chin-up")!!.sets)
        }
        scope.cancel()
    }

    // C17: the glyph reads as nothing out loud, so both halves of the control's accessible name are
    // the same pinned bytes — the label TalkBack speaks for the click, and the description.
    @Test
    fun testTheSignKeyIsNamedTheSameBytesForItsClickAndItsDescription() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft(name = "Pull A").adding("chin-up")
            .targeting("chin-up", List(3) { SetTarget(8, 20.0) }), "Chin Up")

        val sign = signKeys()[0].fetchSemanticsNode()
        assertEquals(listOf(KeypadEntry.signName), sign.config[SemanticsProperties.ContentDescription])
        assertEquals(KeypadEntry.signName, sign.config[SemanticsActions.OnClick].label)
        scope.cancel()
    }

    // An empty load is `last time`, and a sign with no number behind it is not a load.
    @Test
    fun testTheSignOnAnEmptyFieldLeavesItEmpty() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft(name = "Pull A").adding("chin-up")
            .targeting("chin-up", List(3) { SetTarget(8) }), "Chin Up")

        signKeys()[0].performClick()
        assertEquals("", typed("Weight target"))
        compose.onNodeWithText(TargetEntry.notANumber).assertDoesNotExist()
        compose.onNodeWithContentDescription("Weight target").performTextReplacement("20")
        assertEquals(List(3) { "20" }, (1..3).map { typed("Set $it load") })
        scope.cancel()
    }
}
