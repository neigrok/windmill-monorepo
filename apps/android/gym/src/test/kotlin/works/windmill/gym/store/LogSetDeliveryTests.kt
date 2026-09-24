package works.windmill.gym.store

import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import works.windmill.gym.domain.Blocker
import works.windmill.gym.domain.SetFix
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.LogSetAcceptance
import works.windmill.gym.domain.LogSetCommand
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SetWrite
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.net.FakeTraining
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

// Log set holds nothing back: there is no way back after a log, so a set goes to the log the moment
// it is accepted, and a set the log cannot take is stranded at once rather than held on purpose.
class LogSetDeliveryTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun TestScope.liveStore(server: FakeTraining, queueFile: File): TrainingStore {
        var nextSetId = 0
        val store = TrainingStore(
            queue = SetQueue(queueFile),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = backgroundScope,
            now = { 1_000L },
            mintSession = { "ses_1" },
            mintSet = { "set_${++nextSetId}" },
            sync = { server },
        )
        server.open(Session(id = "ses_1", startedAtMs = 1_000))
        return store
    }

    private suspend fun TrainingStore.enter() {
        connect(Account(
            api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
            user = User(id = "u1", email = "sam@example.com", name = "Sam")))
        choose("bench-press")
    }

    @Test
    fun testTheLogSetButtonsAcceptanceIsOnTheLogWithoutWaiting() = runTest {
        val server = FakeTraining()
        val queueFile = File(tmp.root, "queue.json")
        val store = liveStore(server, queueFile)
        store.enter()
        store.editRack(82.5, 5)
        val offer = requireNotNull(store.notification.value?.offer)

        val accepted = store.acceptSet(LogSetCommand(offer.key, offer.id))
        runCurrent()

        val logged = TrainingSet(offer.id, "bench-press", weightKg = 82.5, reps = 5, completedAtMs = 1_000)
        assertEquals(LogSetAcceptance.Accepted(offer.id), accepted)
        assertEquals(listOf(SetWrite(logged)), server.appended)
        assertEquals(listOf(logged.copy(setNumber = 1)), store.sets)
        assertEquals(SaveState.OnTheLog, store.saveState)
        assertEquals("nothing is left owed on the device", emptyList<SetQueue.Entry>(), SetQueue(queueFile, "u1").pending)
    }

    @Test
    fun testASetTheLogCannotTakeIsStrandedTheMomentItIsLogged() = runTest {
        val server = FakeTraining()
        val store = liveStore(server, File(tmp.root, "queue.json"))
        store.enter()
        server.online = false

        store.logSet(weightKg = 82.5, reps = 5)

        assertEquals(listOf(82.5), store.sets.map { it.weightKg })
        assertEquals(1, store.strandedCount)
        assertEquals(SaveState.Blocked(Blocker.Offline), store.saveState)
    }

    @Test
    fun testAQueueFileWrittenWhileLogsWereHeldStillOpensAndOwesItsSet() = runTest {
        val queueFile = File(tmp.root, "queue.json")
        queueFile.writeText(
            """{"queues":{"u.u1":{"session":{"id":"ses_1","startedAt":1000},"entries":{"set_a":{"set":""" +
                """{"id":"set_a","exerciseId":"bench-press","weightKg":82.5,"reps":5,"completedAt":1100},""" +
                """"sessionId":"ses_1","needsPush":true,"remints":0,"heldUntilMs":999999,""" +
                """"holdOrigin":{"wallMs":1100,"elapsedMs":100,"bootId":"b"},"holdDurationMs":9000}}}}}""")
        val server = FakeTraining()
        val store = liveStore(server, queueFile)

        store.enter()

        val owed = TrainingSet("set_a", "bench-press", weightKg = 82.5, reps = 5, completedAtMs = 1_100)
        assertEquals("the old hold is not honoured: the set goes out on the first walk",
            listOf(SetWrite(owed)), server.appended)
        assertEquals(emptyList<SetQueue.Entry>(), SetQueue(queueFile, "u1").pending)
    }

    // The band exists only while something is wrong, and a set on its way to the log is not wrong
    // yet: while the first send is in flight nothing is stranded, and nothing is once it lands. The
    // mark that the send went out is on disk before the send is.
    @Test
    fun testASetWhoseFirstSendIsInFlightIsNotStranded() = runTest {
        val server = FakeTraining()
        val queueFile = File(tmp.root, "queue.json")
        val store = liveStore(server, queueFile)
        store.enter()
        val landing = CompletableDeferred<Unit>()
        val onDiskDuringSend = mutableListOf<Boolean>()
        server.onAppend = {
            onDiskDuringSend += SetQueue(queueFile, "u1").pending.map { it.attempted }
            landing.await()
        }
        store.editRack(82.5, 5)
        val offer = requireNotNull(store.notification.value?.offer)

        store.acceptSet(LogSetCommand(offer.key, offer.id))
        runCurrent()

        assertEquals(listOf(true), onDiskDuringSend)
        assertEquals(0, store.strandedCount)
        assertEquals(emptySet<String>(), store.stalled)
        landing.complete(Unit)
        runCurrent()
        assertEquals(0, store.strandedCount)
        assertEquals(SaveState.OnTheLog, store.saveState)
    }

    // (a) A fix asked while the set's first send is in flight waits behind it and then goes to the
    // log as a fix, never as a rewrite of a set the log already holds.
    @Test
    fun testAFixAskedWhileTheSendIsInFlightReachesTheLog() = runTest {
        val server = FakeTraining()
        val store = liveStore(server, File(tmp.root, "queue.json"))
        store.enter()
        val landing = CompletableDeferred<Unit>()
        server.onAppend = { landing.await() }
        store.editRack(82.5, 5)
        val offer = requireNotNull(store.notification.value?.offer)
        store.acceptSet(LogSetCommand(offer.key, offer.id))
        runCurrent()

        val fixing = async { store.fixSet("ses_1", offer.id, SetFix(reps = 4)) }
        runCurrent()
        landing.complete(Unit)
        runCurrent()

        val corrected = TrainingSet(offer.id, "bench-press", setNumber = 1, weightKg = 82.5, reps = 4, completedAtMs = 1_000)
        assertEquals(FixOutcome.Corrected(corrected), fixing.await())
        assertEquals(listOf("append", "fixSet"), server.calls.filter { it == "append" || it == "fixSet" })
        assertEquals(mapOf("ses_1" to listOf(corrected)), server.sets)
        assertEquals(listOf(corrected), store.sets)
        assertEquals(0, store.strandedCount)
    }

    // (b) The log stored the set and the reply was lost: the device cannot tell that from a send that
    // never arrived, so the fix replays the append — idempotent on the set id — and then fixes the row.
    @Test
    fun testAFixAfterALostReplyReachesTheLog() = runTest {
        val server = FakeTraining()
        val queueFile = File(tmp.root, "queue.json")
        val store = liveStore(server, queueFile)
        store.enter()
        server.swallowReplies = 1
        store.logSet(weightKg = 82.5, reps = 5)
        val logged = store.sets.single()
        assertEquals(1, store.strandedCount)
        assertEquals(SaveState.Blocked(Blocker.Offline), store.saveState)
        assertEquals("the mark survives the app", listOf(true), SetQueue(queueFile, "u1").pending.map { it.attempted })

        val outcome = store.fixSet("ses_1", logged.id, SetFix(reps = 4))

        val corrected = logged.copy(setNumber = 1, reps = 4)
        assertEquals(FixOutcome.Corrected(corrected), outcome)
        assertEquals(listOf("append", "append", "fixSet"), server.calls.filter { it == "append" || it == "fixSet" })
        assertEquals(mapOf("ses_1" to listOf(corrected)), server.sets)
        assertEquals(listOf(corrected), store.sets)
        assertEquals(emptyList<SetQueue.Entry>(), SetQueue(queueFile, "u1").pending)
        assertEquals(0, store.strandedCount)
    }

    // A set the log may hold cannot be fixed on the device: offline, the fix says it did not go and
    // the set keeps the body the log may already have.
    @Test
    fun testAFixOfASetMaybeOnTheLogFailsOfflineAndChangesNothing() = runTest {
        val server = FakeTraining()
        val queueFile = File(tmp.root, "queue.json")
        val store = liveStore(server, queueFile)
        store.enter()
        server.swallowReplies = 1
        store.logSet(weightKg = 82.5, reps = 5)
        val logged = store.sets.single()
        server.online = false

        val outcome = store.fixSet("ses_1", logged.id, SetFix(reps = 4))

        assertEquals(FixOutcome.Failed(WriteFailure.NoAnswer), outcome)
        assertEquals(listOf(logged), store.sets)
        assertEquals(listOf(logged), SetQueue(queueFile, "u1").pending.map { it.set })
        assertEquals(emptyList<Any>(), server.fixes)
    }

    // (a) A delete asked while the first send is in flight waits behind it and removes the row the
    // send put on the log.
    @Test
    fun testADeleteAskedWhileTheSendIsInFlightRemovesTheRowFromTheLog() = runTest {
        val server = FakeTraining()
        val queueFile = File(tmp.root, "queue.json")
        val store = liveStore(server, queueFile)
        store.enter()
        val landing = CompletableDeferred<Unit>()
        server.onAppend = { landing.await() }
        store.editRack(82.5, 5)
        val offer = requireNotNull(store.notification.value?.offer)
        store.acceptSet(LogSetCommand(offer.key, offer.id))
        runCurrent()

        val deleting = async { store.deleteSet("ses_1", offer.id) }
        runCurrent()
        landing.complete(Unit)
        runCurrent()

        assertEquals(null, deleting.await())
        assertEquals(listOf("append", "deleteSet"), server.calls.filter { it == "append" || it == "deleteSet" })
        assertEquals(mapOf("ses_1" to emptyList<TrainingSet>()), server.sets)
        assertEquals(emptyList<SetQueue.Entry>(), SetQueue(queueFile, "u1").pending)
        assertEquals(0, store.strandedCount)
    }

    // (b) The log stored the set and the reply was lost: the delete goes over the wire, where an
    // absent row and a present one both answer 204, and the row is gone from the log.
    @Test
    fun testADeleteAfterALostReplyRemovesTheRowFromTheLog() = runTest {
        val server = FakeTraining()
        val queueFile = File(tmp.root, "queue.json")
        val store = liveStore(server, queueFile)
        store.enter()
        server.swallowReplies = 1
        store.logSet(weightKg = 82.5, reps = 5)
        val logged = store.sets.single()
        assertEquals(listOf(logged.copy(setNumber = 1)), server.sets["ses_1"])

        val refused = store.deleteSet("ses_1", logged.id)

        assertEquals(null, refused)
        assertEquals(listOf("ses_1" to logged.id), server.removed)
        assertEquals(mapOf("ses_1" to emptyList<TrainingSet>()), server.sets)
        assertEquals(emptyList<SetQueue.Entry>(), SetQueue(queueFile, "u1").pending)
        assertEquals(0, store.strandedCount)
    }
}
