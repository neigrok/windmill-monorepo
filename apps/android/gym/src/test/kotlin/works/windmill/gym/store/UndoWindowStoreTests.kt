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

class UndoWindowStoreTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private var clockMs = 1_000L
    private lateinit var queueFile: File
    private lateinit var catalogFile: File
    private lateinit var localFile: File
    private lateinit var preferencesFile: File

    @Before
    fun setUp() {
        clockMs = 1_000
        queueFile = File(tmp.root, "gym-undo-${System.nanoTime()}.json")
        catalogFile = File(tmp.root, "gym-undo-catalog-${System.nanoTime()}.json")
        localFile = File(tmp.root, "gym-undo-local-${System.nanoTime()}.json")
        preferencesFile = File(tmp.root, "gym-undo-prefs-${System.nanoTime()}.json")
    }

    private fun onDisk() = SetQueue(queueFile, "u1")

    private fun TestScope.makeStore(server: FakeTraining) = TrainingStore(
        queue = SetQueue(queueFile) { clockMs },
        deviceCopy = DeviceCopy(catalogFile),
        localLog = LocalLog(localFile),
        localPreferences = LocalPreferences(preferencesFile),
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

    @Test
    fun testASetJustLoggedIsOnTheDeviceAndNotYetOnTheLog() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        store.logSet(weightKg = 82.5, reps = 5)

        assertEquals(listOf(82.5), store.sets.map { it.weightKg })
        assertEquals("nothing goes out while it can still be taken back", 0, server.appended.size)
        assertEquals(82.5, store.undoable?.weightKg)
        assertEquals("and it is on disk, not in memory", 1, onDisk().pending.size)
    }

    @Test
    fun testASetInsideItsWindowIsNotCalledOffline() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        store.logSet(weightKg = 82.5, reps = 5)

        assertEquals(SaveState.Idle, store.saveState)
        assertNull(store.saveState.line)
    }

    @Test
    fun testUndoTakesTheSetBackAndTheLogNeverHearsOfIt() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        store.logSet(weightKg = 82.5, reps = 5)
        assertTrue(store.undoLast())

        assertEquals(emptyList<TrainingSet>(), store.sets)
        assertEquals(0, server.appended.size)
        assertEquals("and the disk agrees", 0, onDisk().pending.size)
        assertNull(store.undoable)
    }

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

    @Test
    fun testUndoFollowsTheRowAndIsNotOfferedFromAnotherMovement() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        store.logSet(weightKg = 82.5, reps = 5)
        assertEquals(82.5, store.undoable?.weightKg)

        store.choose("overhead-press")
        assertNull("the row is on no screen, so neither is the verb", store.undoable)
        assertFalse("and it cannot be taken back from here either", store.undoLast())
        assertEquals("the set is untouched — nothing was withdrawn and nothing was sent",
            listOf(82.5), store.sets.map { it.weightKg })
        assertEquals(0, server.appended.size)

        store.choose("bench-press")
        assertEquals("walking back inside the window finds the row and the Undo on it",
            82.5, store.undoable?.weightKg)
        assertTrue(store.undoLast())
        assertEquals(emptyList<TrainingSet>(), store.sets)
    }

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
