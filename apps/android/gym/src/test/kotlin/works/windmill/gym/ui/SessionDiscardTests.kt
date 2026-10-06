package works.windmill.gym.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.sharing.WorkoutShareActions
import works.windmill.gym.domain.Review
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.FinishOutcome
import works.windmill.gym.store.Withheld
import works.windmill.sync.core.Json

// D12. The session review screen draws `Discard session`. Without it the log row's long press is the
// only way an ordinary past workout can be discarded — a gesture as the ONLY path to an action,
// which `13-gestures.md` Law 1 forbids, and which is the very thing D7 leaned on when it put Discard
// behind that long press in the first place.
//
// The drawn door is the same ACT as the other two: the same nine-second window, the same transient
// and Undo, nothing on the wire before the clock, and no confirmation (Law 2). The finish screen's
// slight-session door is untouched.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class SessionDiscardTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val doors = WorkoutShareActions(
        origin = "https://windmill.works",
        mint = { error("no link is minted here") },
        revoke = { error("no link is revoked here") },
    )

    // Four working sets: NOT a `slight` session, which is the only shape the finish screen ever drew
    // Discard for — this is the ordinary past workout whose only path used to be a long press. Synced,
    // so the workout is on the account's log and nothing is owed.
    private fun store(scope: CoroutineScope): EngineRoomFixture {
        val room = EngineRoomFixture(tmp.newFolder(), scope)
        // A minute's workout that has just finished, on the wall clock.
        room.now = System.currentTimeMillis() - 60_000
        val server = EngineRoomFixture.server()
        runBlocking {
            room.select("u1")
            room.pull(server)
            room.store.start()
            room.store.choose("bench-press")
            room.store.logSet(weightKg = 82.5, reps = 5)
            room.store.logSet(weightKg = 90.0, reps = 3)
            room.store.logSet(weightKg = 90.0, reps = 3)
            room.store.logSet(weightKg = 90.0, reps = 2)
            room.now += 60_000
            assertTrue(room.store.finish() is FinishOutcome.Closed)
            room.sync(server)
            room.store.refreshEngine()
        }
        room.store.observeEngine()
        return room
    }

    // Wired to the act the room performs, so the door is proved against what it actually reaches and
    // not against a spy that stands in for it.
    private fun screen(room: EngineRoomFixture) {
        val summary = room.store.recent.single()
        compose.setContent {
            SessionScreen(
                summary = summary,
                store = room.store,
                sharing = doors,
                backTo = "The log",
                onBack = {},
                say = {},
                onOpenMovement = {},
                onDiscard = { room.store.withhold(Deletion.Session(summary.id)) },
            )
        }
    }

    @Test
    fun testTheReviewScreenDrawsDiscardSoTheLongPressIsNeverTheOnlyPath() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { store(scope).use { room ->
            screen(room)

            compose.onNodeWithText(Finish.discard).performScrollTo().assertIsDisplayed()
            compose.runOnIdle {
                assertEquals("and this is NOT the slight session the finish screen draws it for",
                    Review.slightWorkingSets, room.store.recent.single().workingSetCount)
            }
        } } finally { scope.cancel() }
    }

    // No confirmation and nothing on the wire: the window and its transient ARE the way back, and a
    // dialog over an act that has an undo is a tap that buys nothing.
    @Test
    fun testTheDrawnDiscardWithholdsTheSessionAndAsksTheLogNothing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { store(scope).use { room ->
            val workout = room.store.recent.single()
            screen(room)

            compose.onNodeWithText(Finish.discard).performScrollTo().performClick()

            compose.runOnIdle {
                assertEquals("the same window every other door opens", 1, room.store.withheld.size)
                assertEquals("the same transient, in the same words",
                    "Session deleted.", Withheld.line(room.store.withheld))
                assertEquals("and the same Undo", "Undo", Withheld.undo)
                assertEquals("the row is off the log", emptyList<String>(), room.store.recent.map { it.id })
                assertEquals("while the workout is still on the account", listOf(workout.id),
                    room.training.details().map { it.session.id })
                assertEquals("nothing went on the wire before the clock", emptyList<Json>(), room.outbox())
            }
            compose.onAllNodesWithText("Discard", substring = true).assertCountEquals(1)
        } } finally { scope.cancel() }
    }

    // One constant behind three doors — the finish screen's slight session, the log row's long press
    // and this one — so three spellings of one act cannot drift apart.
    @Test
    fun testTheThreeDoorsSayOneThing() {
        assertEquals("Discard session", Finish.discard)
    }
}
