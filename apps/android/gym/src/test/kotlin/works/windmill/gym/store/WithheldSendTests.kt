package works.windmill.gym.store

import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.Session
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.net.TrainingSyncing
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

// A delete the log has not answered yet: the wire is held open so the store can be asked what it
// says about a set already committed to.
private class HeldDelete(private val inner: FakeTraining) : TrainingSyncing by inner {
    val entered = CompletableDeferred<Unit>()
    val release = CompletableDeferred<Unit>()

    override suspend fun deleteSet(sessionId: String, setId: String) {
        entered.complete(Unit)
        release.await()
        inner.deleteSet(sessionId, setId)
    }
}

// The undo window is the lifter's; the send is not. Once `settleWithheld` has committed a delete to
// the wire there is no taking it back, so the slot must be empty from that moment — a `keepWithheld`
// that answered true there would report a keep the log has already lost.
class WithheldSendTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private var clockMs = 1_000L

    @Before
    fun setUp() {
        clockMs = 1_000
    }

    private fun TestScope.storeOver(sync: TrainingSyncing) = TrainingStore(
        queue = SetQueue(File(tmp.root, "queue.json")) { clockMs },
        deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
        localLog = LocalLog(File(tmp.root, "local.json")),
        localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
        localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
        scope = backgroundScope,
        now = { clockMs += 1; clockMs },
        mintSession = { "ses_minted" },
        mintSet = Ids::set,
        undoWindowMs = SetQueue.undoWindowMs,
        sync = { if (it.isSignedIn) sync else null },
    )

    private fun account() = Account(
        api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
        user = User(id = "u1", email = "sam@example.com", name = "Sam"),
    )

    @Test
    fun testUndoAnswersFalseOnceTheDeleteIsOnTheWireAndTheSetGoesAnyway() = runTest {
        val server = FakeTraining()
        server.open(Session(id = "ses_1", startedAtMs = 1_000))
        val held = HeldDelete(server)
        val store = storeOver(held)
        store.connect(account())
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)
        store.logSet(weightKg = 90.0, reps = 3)
        clockMs += 60_000
        store.flushPendingSets(force = true)
        store.finish()
        val taken = server.sets.getValue("ses_1").first()

        store.withhold(Deletion.Set("ses_1", taken))
        assertNotNull("the lifter's own window, before anything is told", store.holding)

        val settling = backgroundScope.launch { store.settleWithheld(taken.id) }
        held.entered.await()
        runCurrent()

        assertFalse("the row stops being the lifter's the moment the delete is committed to",
            store.withheld.single().takeable)
        assertNull("which is the key the room's transient hangs on, so the Undo goes down with it",
            store.holding)
        assertNull("and Undo cannot report a keep the log has already lost", store.keepWithheld())

        held.release.complete(Unit)
        settling.join()
        assertEquals(listOf("ses_1" to taken.id), server.removed)
        assertEquals("the set is gone from the log", listOf(90.0),
            server.sets.getValue("ses_1").map { it.weightKg })
    }

    @Test
    fun testASettleCancelledMidFlightIsStillOwedAndTheNextOneSendsIt() = runTest {
        val server = FakeTraining()
        server.open(Session(id = "ses_1", startedAtMs = 1_000))
        val held = HeldDelete(server)
        val store = storeOver(held)
        store.connect(account())
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)
        store.logSet(weightKg = 90.0, reps = 3)
        clockMs += 60_000
        store.flushPendingSets(force = true)
        store.finish()
        val taken = server.sets.getValue("ses_1").first()

        store.withhold(Deletion.Set("ses_1", taken))
        val settling = backgroundScope.launch { store.settleWithheld(taken.id) }
        held.entered.await()
        runCurrent()
        settling.cancel()
        runCurrent()

        assertTrue("the row is still owed, so a settle over the same row re-sends it",
            store.withheld.isNotEmpty())
        assertNull("and it is nobody's to take back any more", store.keepWithheld())

        held.release.complete(Unit)
        assertNull(store.settleWithheld(taken.id))
        assertEquals(emptyList<WithheldDelete>(), store.withheld)
        assertEquals("the set is gone from the log", listOf(90.0),
            server.sets.getValue("ses_1").map { it.weightKg })
    }
}
