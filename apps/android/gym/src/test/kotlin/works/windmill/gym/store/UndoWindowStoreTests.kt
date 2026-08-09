package works.windmill.gym.store

import java.io.File
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.net.FakeTraining
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

// THE UNDO WINDOW, DRIVEN THROUGH THE STORE — the wiring above the queue promises pinned in
// UndoWindowTests: that the walk really skips a held set, that the save line stays silent over a
// send nobody attempted, and that finish, leaving the room and the boot read each force the window
// shut rather than stranding the set behind it.
class UndoWindowStoreTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private var clockMs = 1_000L
    private lateinit var queueFile: File
    private lateinit var catalogFile: File

    @Before
    fun setUp() {
        clockMs = 1_000
        queueFile = File(tmp.root, "gym-undo-${System.nanoTime()}.json")
        catalogFile = File(tmp.root, "gym-undo-catalog-${System.nanoTime()}.json")
    }

    private fun TestScope.makeStore(server: FakeTraining) = TrainingStore(
        queue = SetQueue(queueFile) { clockMs },
        deviceCatalog = DeviceCatalog(catalogFile),
        scope = backgroundScope,
        now = { clockMs },
        mintSession = { "ses_1" },
        mintSet = { "set_$clockMs" },
        sync = { server },
    )

    private suspend fun TestScope.liveStore(server: FakeTraining): TrainingStore {
        server.open(Session(id = "ses_1", startedAtMs = 1_000))
        val store = makeStore(server)
        store.connect(Account(
            api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
            user = User(id = "u1", email = "sam@example.com", name = "Sam")))
        store.choose("bench-press")
        return store
    }

    // The set is on the device the instant it is tapped — the window changes when it is SENT,
    // never whether it was kept.
    @Test
    fun testASetJustLoggedIsOnTheDeviceAndNotYetOnTheLog() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        store.logSet(weightKg = 82.5, reps = 5)

        assertEquals(listOf(82.5), store.sets.map { it.weightKg })
        assertEquals("nothing goes out while it can still be taken back", 0, server.appended.size)
        assertEquals(82.5, store.undoable?.weightKg)
        assertEquals("and it is on disk, not in memory", 1, SetQueue(queueFile).pending.size)
    }

    // "Offline" would be the wrong word for a send nobody has attempted. Silence is the honest
    // state while the window is open.
    @Test
    fun testASetInsideItsWindowIsNotCalledOffline() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        store.logSet(weightKg = 82.5, reps = 5)

        assertEquals(SaveState.Idle, store.saveState)
        assertNull(store.saveState.line)
    }

    // The gesture the window exists for: the set never reaches the log at all, so nothing already
    // written is destroyed by one tap.
    @Test
    fun testUndoTakesTheSetBackAndTheLogNeverHearsOfIt() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        store.logSet(weightKg = 82.5, reps = 5)
        assertTrue(store.undoLast())

        assertEquals(emptyList<TrainingSet>(), store.sets)
        assertEquals(0, server.appended.size)
        assertEquals("and the disk agrees", 0, SetQueue(queueFile).pending.size)
        assertNull(store.undoable)
    }

    // Undo answers the tap the lifter just made, not the oldest one still waiting.
    @Test
    fun testUndoTakesBackTheNewestSetAndLeavesTheRest() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += 1_000
        store.logSet(weightKg = 85.0, reps = 3)
        assertTrue(store.undoLast())

        assertEquals(listOf(82.5), store.sets.map { it.weightKg })
    }

    // Once the window closes the set goes out on its own — a hold that never ended would be a set
    // that never landed.
    @Test
    fun testWhenTheWindowClosesTheSetGoesOutByItself() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += SetQueue.undoWindowMs + 1
        store.flushPendingSets()

        assertEquals(listOf(82.5), server.appended.map { it.weightKg })
        assertEquals(SaveState.OnTheLog, store.saveState)
        assertNull("and there is nothing left to take back", store.undoable)
    }

    // Past the window the log holds the row, and the wire has no route that deletes one. The
    // answer is no rather than a screen that quietly disagrees with the account.
    @Test
    fun testUndoAfterTheSetHasLandedRefusesRatherThanPretending() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += SetQueue.undoWindowMs + 1
        store.flushPendingSets()

        assertFalse(store.undoLast())
        assertEquals("the set the log has stays on screen",
            listOf(82.5), store.sets.map { it.weightKg })
    }

    // Finishing is this device's statement that everything the session holds is already delivered.
    // A walk that skipped a held set would leave it behind, and the close would refuse it FOREVER.
    @Test
    fun testFinishSendsASetStillInsideItsWindowBeforeItCloses() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        store.logSet(weightKg = 100.0, reps = 5)
        assertTrue("the session closed, because nothing was left to lose",
            store.finish() is FinishOutcome.Closed)

        assertEquals(listOf(100.0), server.appended.map { it.weightKg })
        assertEquals("the set goes out before the close, never after",
            listOf("append", "finish"), server.calls.filter { it == "append" || it == "finish" })
    }

    // Leaving the room ends the window whether or not its nine seconds are up: the affordance goes
    // with the subtree, and the store that would have sent it is about to be let go.
    @Test
    fun testLeavingTheRoomEndsTheWindowAndSendsWhatIsHeld() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        store.logSet(weightKg = 82.5, reps = 5)
        store.flushPendingSets()
        assertEquals("backgrounding the phone keeps the window", 0, server.appended.size)

        store.flushPendingSets(force = true)
        assertEquals(listOf(82.5), server.appended.map { it.weightKg })
    }

    // A relaunch is the other end of the same rule: the row is gone from the screen, so the window
    // is protecting a gesture nobody can still make — and the boot read would settle the session
    // over it.
    @Test
    fun testAReadOfTheLogSendsWhatIsHeldFirst() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)
        store.logSet(weightKg = 82.5, reps = 5)

        val relaunched = makeStore(server)
        relaunched.connect(Account(
            api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
            user = User(id = "u1", email = "sam@example.com", name = "Sam")))

        assertEquals(listOf(82.5), server.appended.map { it.weightKg })
        assertEquals("and the first store still draws the workout it held", 1, store.sets.size)
    }
}
