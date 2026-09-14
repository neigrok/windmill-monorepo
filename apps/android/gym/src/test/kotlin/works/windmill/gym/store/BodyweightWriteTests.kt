package works.windmill.gym.store

import java.io.File
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.*
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.net.TrainingSyncing
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class BodyweightWriteTests {
    @get:Rule val tmp = TemporaryFolder()
    private fun account(id: String) = Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }), User(id, "$id@example.com", id))
    private fun TestScope.store(logs: Map<String, TrainingSyncing>) = TrainingStore(
        SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "catalog")), LocalLog(File(tmp.root, "log")),
        LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "weight")), backgroundScope,
        now = { 1_800_000_000_000 + testScheduler.currentTime }, sync = { logs[it.user?.id] })

    @Test
    fun firstReadRepeatsAfterLocalSaveSoOlderAccountDatesRemainComplete() = runTest {
        val older = WeighIn("2026-01-01", 82.0, 100)
        val server = FakeTraining().apply { weighIns[older.dateLocal] = older }
        val release = CompletableDeferred<Unit>()
        var reads = 0
        val boundary = object : TrainingSyncing by server {
            override suspend fun bodyweight(from: String?, to: String?): List<WeighIn> {
                val read = server.bodyweight(from, to)
                if (++reads == 1) release.await()
                return read
            }
        }
        val store = store(mapOf("a" to boundary))
        val connect = async { store.connect(account("a")) }
        runCurrent()
        assertTrue(store.bodyweightLoading)
        assertFalse(store.bodyweightRead)
        assertNull(store.weighIn("2026-01-02", 83.0))
        release.complete(Unit)
        connect.await()
        assertEquals(2, reads)
        assertEquals(listOf(older, WeighIn("2026-01-02", 83.0, 1_800_000_000_000)), store.bodyweight)
        assertTrue(store.bodyweightRead)
        assertFalse(store.bodyweightLoading)
    }

    @Test
    fun rejectedCorrectionRestoresConfirmedRowAndKeepsLaterAcceptedRow() = runTest {
        val original = WeighIn("2026-01-01", 82.0, 100)
        val server = FakeTraining().apply { weighIns[original.dateLocal] = original }
        val release = CompletableDeferred<Unit>()
        val boundary = object : TrainingSyncing by server {
            override suspend fun putBodyweight(dateLocal: String, write: WeighInWrite): WeighIn {
                if (write.weightKg == 83.0) {
                    release.await()
                    throw WindmillApiException.Refused(400, Refusal(message = "Cannot store this correction."))
                }
                return server.putBodyweight(dateLocal, write)
            }
        }
        val store = store(mapOf("a" to boundary))
        store.connect(account("a"))
        val refused = async { store.weighIn(original.dateLocal, 83.0) }
        runCurrent()
        release.complete(Unit)
        assertEquals(WriteFailure.Refused("Cannot store this correction."), refused.await())
        assertEquals(listOf(original), store.bodyweight)
        assertNull(store.weighIn(original.dateLocal, 84.0))
        assertEquals(listOf(WeighIn(original.dateLocal, 84.0, 1_800_000_000_000)), store.bodyweight)
    }

    @Test
    fun queuedDeleteCannotOvertakeRewriteAndOldAckCannotRetireNewDelete() = runTest {
        val day = "2026-01-01"
        val server = FakeTraining().apply { weighIns[day] = WeighIn(day, 82.0, 100) }
        val firstDelete = CompletableDeferred<Unit>()
        val releaseDelete = CompletableDeferred<Unit>()
        var deletes = 0
        val boundary = object : TrainingSyncing by server {
            override suspend fun deleteBodyweight(dateLocal: String) {
                if (++deletes == 1) {
                    firstDelete.complete(Unit)
                    releaseDelete.await()
                }
                server.deleteBodyweight(dateLocal)
            }
        }
        val store = store(mapOf("a" to boundary))
        store.connect(account("a"))
        val oldDelete = async { store.deleteWeighIn(day) }
        firstDelete.await()
        val rewrite = async { store.weighIn(day, 84.0) }
        runCurrent()
        val newDelete = async { store.deleteWeighIn(day) }
        runCurrent()
        releaseDelete.complete(Unit)
        oldDelete.await(); rewrite.await(); newDelete.await()
        assertEquals(2, deletes)
        assertEquals(emptyList<WeighIn>(), store.bodyweight)
        assertEquals(emptyMap<String, WeighIn>(), server.weighIns)
        assertEquals(emptyList<String>(), LocalBodyweight(File(tmp.root, "weight"), "a").deletions)
    }

    @Test
    fun oldOwnerWriteAndMalformedDateReplyCannotPopulateNewOwnerOrDifferentDate() = runTest {
        val release = CompletableDeferred<WeighIn>()
        val a = object : TrainingSyncing by FakeTraining() {
            override suspend fun putBodyweight(dateLocal: String, write: WeighInWrite) = release.await()
        }
        val b = FakeTraining()
        val store = store(mapOf("a" to a, "b" to b))
        store.connect(account("a"))
        val write = async { store.weighIn("2026-01-01", 82.0) }
        runCurrent()
        store.connect(account("b"))
        release.complete(WeighIn("2026-01-02", 90.0, 100))
        assertEquals(WriteFailure.Refused("The account changed while saving."), write.await())
        assertTrue(store.bodyweight.isEmpty())
        assertTrue(b.weighIns.isEmpty())
    }
    @Test
    fun replayedDeleteAndDirectRewriteShareOneOrderedSendBoundary() = runTest {
        val day = "2026-01-01"
        val server = FakeTraining().apply { weighIns[day] = WeighIn(day, 82.0, 100) }
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var pause = false
        val events = mutableListOf<String>()
        val boundary = object : TrainingSyncing by server {
            override suspend fun deleteBodyweight(dateLocal: String) {
                if (pause) { events += "delete starts"; entered.complete(Unit); release.await() }
                server.deleteBodyweight(dateLocal)
                if (pause) events += "delete ends"
            }
            override suspend fun putBodyweight(dateLocal: String, write: WeighInWrite): WeighIn {
                events += "put ${write.weightKg}"
                return server.putBodyweight(dateLocal, write)
            }
        }
        val store = store(mapOf("a" to boundary))
        store.connect(account("a"))
        server.online = false
        store.deleteWeighIn(day)
        server.online = true
        pause = true
        val replay = async { store.connect(account("a")) }
        entered.await()
        val write = async { store.weighIn(day, 84.0) }
        runCurrent()
        assertEquals(listOf("delete starts"), events)
        release.complete(Unit)
        replay.await(); assertNull(write.await())
        val expected = WeighIn(day, 84.0, 1_800_000_000_000)
        assertEquals(listOf("delete starts", "delete ends", "put 84.0"), events)
        assertEquals(listOf(expected), store.bodyweight)
        assertEquals(mapOf(day to expected), server.weighIns)
        assertEquals(emptyList<String>(), LocalBodyweight(File(tmp.root, "weight"), "a").deletions)
    }

    @Test
    fun malformedDateReplyKeepsTheAcceptedLocalWriteOwedAtItsOriginalDate() = runTest {
        val server = object : TrainingSyncing by FakeTraining() {
            override suspend fun putBodyweight(dateLocal: String, write: WeighInWrite) = WeighIn("2026-01-02", 90.0, write.recordedAt)
        }
        val store = store(mapOf("a" to server))
        store.connect(account("a"))
        assertNull(store.weighIn("2026-01-01", 82.0))
        val expected = WeighIn("2026-01-01", 82.0, 1_800_000_000_000)
        assertEquals(listOf(expected), store.bodyweight)
        assertEquals(listOf(expected), LocalBodyweight(File(tmp.root, "weight"), "a").owed)
    }

    @Test
    fun terminalCorrectionRefusalRestoresThePreviousAcceptedButUndeliveredDate() = runTest {
        val day = "2026-01-01"
        val server = FakeTraining()
        val boundary = object : TrainingSyncing by server {
            override suspend fun putBodyweight(dateLocal: String, write: WeighInWrite): WeighIn {
                if (write.weightKg == 83.0) throw WindmillApiException.Refused(400, Refusal(message = "Cannot store this correction."))
                return server.putBodyweight(dateLocal, write)
            }
        }
        val store = store(mapOf("a" to boundary))
        store.connect(account("a"))
        server.online = false
        assertNull(store.weighIn(day, 82.0))
        val original = WeighIn(day, 82.0, 1_800_000_000_000)
        assertEquals(WriteFailure.Refused("Cannot store this correction."), store.weighIn(day, 83.0))
        assertEquals(listOf(original), store.bodyweight)
        assertEquals(listOf(original), LocalBodyweight(File(tmp.root, "weight"), "a").owed)
        server.online = true
        store.connect(account("a"))
        assertEquals(mapOf(day to original), server.weighIns)
        assertEquals(listOf(original), store.bodyweight)
        assertEquals(emptyList<WeighIn>(), LocalBodyweight(File(tmp.root, "weight"), "a").owed)
    }

}
