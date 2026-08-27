package works.windmill.gym.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
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
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.CoachDoors
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.Review
import works.windmill.gym.domain.Session
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.Withheld
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

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

    private val doors = CoachDoors(
        origin = "https://windmill.works",
        mint = { error("no link is minted here") },
        revoke = { error("no link is revoked here") },
    )

    // Four working sets: NOT a `slight` session, which is the only shape the finish screen ever drew
    // Discard for — this is the ordinary past workout whose only path used to be a long press.
    private fun store(scope: CoroutineScope, server: FakeTraining): TrainingStore {
        val root = File(System.getProperty("java.io.tmpdir"), "discard-${System.nanoTime()}")
        root.mkdirs()
        val store = TrainingStore(
            queue = SetQueue(File(root, "queue.json")),
            deviceCopy = DeviceCopy(File(root, "catalog.json")),
            localLog = LocalLog(File(root, "local.json")),
            localPreferences = LocalPreferences(File(root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(root, "bodyweight.json")),
            scope = scope,
            mintSession = { "ses_1" },
            mintSet = Ids::set,
            undoWindowMs = SetQueue.undoWindowMs,
            sync = { if (it.isSignedIn) server else null },
        )
        runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = User(id = "u1", email = "sam@example.com", name = "Sam")))
            store.choose("bench-press")
            store.logSet(weightKg = 82.5, reps = 5)
            store.logSet(weightKg = 90.0, reps = 3)
            store.logSet(weightKg = 90.0, reps = 3)
            store.logSet(weightKg = 90.0, reps = 2)
            store.flushPendingSets(force = true)
            store.finish()
        }
        return store
    }

    // Wired to the act the room performs, so the door is proved against what it actually reaches and
    // not against a spy that stands in for it.
    private fun screen(store: TrainingStore) {
        val summary = store.recent.single()
        compose.setContent {
            SessionScreen(
                summary = summary,
                store = store,
                coach = doors,
                backTo = "The log",
                onBack = {},
                say = {},
                onOpenMovement = {},
                onDiscard = { store.withhold(Deletion.Session(summary.id)) },
            )
        }
    }

    @Test
    fun testTheReviewScreenDrawsDiscardSoTheLongPressIsNeverTheOnlyPath() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.open(Session(id = "ses_1", startedAtMs = 1_000))
        val store = store(scope, server)
        screen(store)

        compose.onNodeWithText(Finish.discard).performScrollTo().assertIsDisplayed()
        compose.runOnIdle {
            assertEquals("and this is NOT the slight session the finish screen draws it for",
                Review.slightWorkingSets, store.recent.single().workingSetCount)
        }
        scope.cancel()
    }

    // No confirmation and nothing on the wire: the window and its transient ARE the way back, and a
    // dialog over an act that has an undo is a tap that buys nothing.
    @Test
    fun testTheDrawnDiscardWithholdsTheSessionAndAsksTheLogNothing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.open(Session(id = "ses_1", startedAtMs = 1_000))
        val store = store(scope, server)
        screen(store)

        compose.onNodeWithText(Finish.discard).performScrollTo().performClick()

        compose.runOnIdle {
            assertEquals("the same window every other door opens", 1, store.withheld.size)
            assertEquals("the same transient, in the same words",
                "Session deleted.", Withheld.line(store.withheld))
            assertEquals("and the same Undo", "Undo", Withheld.undo)
            assertEquals("the row is off the log", emptyList<String>(), store.recent.map { it.id })
            assertTrue("while the workout is still on the account", "ses_1" in server.stored)
            assertEquals("nothing went on the wire before the clock", 0,
                server.calls.count { it == "discard" })
        }
        compose.onAllNodesWithText("Discard", substring = true).assertCountEquals(1)
        scope.cancel()
    }

    // One constant behind three doors — the finish screen's slight session, the log row's long press
    // and this one — so three spellings of one act cannot drift apart.
    @Test
    fun testTheThreeDoorsSayOneThing() {
        assertEquals("Discard session", Finish.discard)
    }
}
