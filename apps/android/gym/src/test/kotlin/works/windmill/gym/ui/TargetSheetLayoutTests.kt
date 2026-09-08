package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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

// The sheet on the small phone: the ramp's five rows and Add set stand inside the first paint, the
// body needing no scroll, and the commit is pinned under the body inside the window.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h731dp-xhdpi")
class TargetSheetLayoutTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val ramp = listOf(SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0), SetTarget(1, 100.0), SetTarget(5, 80.0))

    private val lowerA = RoutineDraft(name = "Lower A").adding("back-squat").adding("deadlift")
        .targeting("back-squat", ramp)

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

    @Test
    fun testFiveRowsAndAddSetStandInsideTheFirstPaintWithTheCommitPinnedUnder() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = store(scope)
        var draft by mutableStateOf(lowerA)
        compose.setContent {
            RoutineBuilder(draft = draft, store = store, saving = false, onDraft = { draft = it }, onSave = {}, onClose = {}, say = {})
        }
        compose.onNodeWithText("Back Squat").performClick()

        val addSet = compose.onNodeWithText(TargetEntry.addSet).assertIsDisplayed().fetchSemanticsNode()
        val commit = compose.onNodeWithText("Set · 5 sets").assertIsDisplayed().fetchSemanticsNode()
        val fifthRow = compose.onNodeWithContentDescription("Set 5 load").assertIsDisplayed().fetchSemanticsNode()
        // The sheet is its own window; its root is the extent to stand inside.
        val window = addSet.root!!.semanticsOwner.rootSemanticsNode.size.height.toFloat()

        assertTrue("row 5 inside the window", fifthRow.boundsInRoot.bottom <= window)
        assertTrue("Add set under row 5", addSet.boundsInRoot.top >= fifthRow.boundsInRoot.bottom)
        assertTrue("Add set inside the window", addSet.boundsInRoot.bottom <= window)
        assertTrue("the commit under Add set", commit.boundsInRoot.top >= addSet.boundsInRoot.bottom)
        assertTrue("and inside the window", commit.boundsInRoot.bottom <= window)

        val body = compose.onNodeWithTag("target-sheet-body").fetchSemanticsNode()
        val reach = body.config.getOrNull(SemanticsProperties.VerticalScrollAxisRange)!!
        assertEquals("nothing of the body is past the fold", 0f, reach.maxValue(), 0f)
        scope.cancel()
    }
}
