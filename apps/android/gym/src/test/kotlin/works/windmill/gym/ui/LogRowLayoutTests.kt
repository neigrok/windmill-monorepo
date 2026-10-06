package works.windmill.gym.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
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
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.FinishOutcome
import works.windmill.gym.store.GymResult

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w320dp-h640dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LogRowLayoutTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun doubleTextStacksTheDateAndGivesTheRecordTheFullCardWidth() {
        val now = LocalDate.of(2026, 9, 24).atTime(12, 0).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            // Yesterday's Push A, logged on another phone: one working set of bench, the account's record.
            val phoneScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
            try { EngineRoomFixture(tmp.newFolder(), phoneScope).use { phone -> runBlocking {
                phone.now = now - 86_400_000
                phone.select("u1")
                phone.pull(server)
                val pushA = (phone.store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")) as GymResult.Ok).value
                phone.store.start(pushA.id)
                phone.store.choose("bench-press")
                phone.store.logSet(62.5, 8)
                phone.now += 3_600_000
                assertTrue(phone.store.finish() is FinishOutcome.Closed)
                phone.sync(server)
            } } } finally { phoneScope.cancel() }
            room.now = now
            runBlocking {
                room.select("u1")
                room.pull(server)
                room.store.refreshEngine()
            }
            room.store.observeEngine()
            val opened = mutableListOf<SessionSummary>()
            compose.setContent {
                CompositionLocalProvider(LocalDensity provides Density(density = 2f, fontScale = 2f)) {
                    GymMaterial { LogScreen(room.store, "A", { opened += it }, {}, {}, {}, now = { now }) }
                }
            }
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
            assertEquals("the row opens the one session the log holds", room.store.recent, opened)
        } } finally { scope.cancel() }
    }
}
