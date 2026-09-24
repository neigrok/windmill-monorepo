package works.windmill.gym.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import java.io.File
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import works.windmill.gym.domain.PlanSnapshot
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w320dp-h640dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LogRowLayoutTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun doubleTextStacksTheDateAndGivesTheRecordTheFullCardWidth() {
        val now = LocalDate.of(2026, 9, 24).atTime(12, 0).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
        val session = Session("push", now - 86_400_000, now - 86_400_000 + 3_600_000, plan = PlanSnapshot("Push A"))
        val set = TrainingSet("best", "bench-press", weightKg = 62.5, reps = 8, completedAtMs = session.startedAtMs)
        val server = FakeTraining().apply {
            stored[session.id] = session
            sets[session.id] = mutableListOf(set)
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = TrainingStore(SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "catalog")), LocalLog(File(tmp.root, "log")),
            LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "weight")), scope, now = { now }, sync = { server })
        val account = Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }), User("a", "a@example.com", "A"))
        runBlocking { store.connect(account) }
        val opened = mutableListOf<SessionSummary>()
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(density = 2f, fontScale = 2f)) {
                GymMaterial { LogScreen(store, "A", { opened += it }, {}, {}, {}, now = { now }) }
            }
        }
        try {
            val title = compose.onNodeWithText("Push A", useUnmergedTree = true).assertIsDisplayed().getBoundsInRoot()
            val date = compose.onNodeWithText("Yesterday", useUnmergedTree = true).assertIsDisplayed().getBoundsInRoot()
            val record = compose.onNodeWithText("Record · Bench Press 62.5 × 8", useUnmergedTree = true).assertIsDisplayed()
            val fact = record.getBoundsInRoot()
            val row = compose.onNode(hasText("Push A") and hasClickAction()).getBoundsInRoot()
            assertTrue(date.top >= title.bottom)
            assertTrue(fact.top >= date.bottom)
            assertEquals(title.left.value, date.left.value, 0.5f)
            assertEquals(title.left.value, fact.left.value, 0.5f)
            assertEquals(row.right.value - 16f, fact.right.value, 0.5f)
            val layouts = mutableListOf<TextLayoutResult>()
            record.fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!(layouts)
            val layout = layouts.single()
            assertFalse(layout.didOverflowWidth)
            assertFalse(layout.didOverflowHeight)
            assertTrue("The full-width record needs at most two lines", layout.lineCount <= 2)
            assertEquals("Record · Bench Press 62.5 × 8", layout.layoutInput.text.text)
            compose.onNodeWithText("Weigh in").assertIsDisplayed()
            compose.onNode(hasText("Push A") and hasClickAction()).performClick()
            assertEquals(listOf(SessionSummary(session, listOf(set))), opened)
        } finally { scope.cancel() }
    }
}
