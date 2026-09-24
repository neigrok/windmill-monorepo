package works.windmill.gym.store

import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
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


    // A fix of a set whose first send is in flight is filed behind it and stands on the device at
    // once; the append's answer does not settle the corrected entry, and the PATCH follows it.
    @Test
    fun testAFixAskedWhileTheSendIsInFlightIsFiledAndThenReachesTheLog() = runTest {
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

        val outcome = store.fixSet("ses_1", offer.id, SetFix(reps = 4))

        val corrected = TrainingSet(offer.id, "bench-press", weightKg = 82.5, reps = 4, completedAtMs = 1_000)
        assertEquals(FixOutcome.Corrected(corrected), outcome)
        assertEquals(listOf(corrected), store.sets)
        assertEquals(listOf(Triple(corrected, true, Owed.Fix)),
            SetQueue(queueFile, "u1").pending.map { Triple(it.set, it.attempted, it.write) })
        assertEquals(emptyList<Any>(), server.fixes)

        landing.complete(Unit)
        runCurrent()

        val landed = corrected.copy(setNumber = 1)
        assertEquals(listOf("append", "fixSet"), server.calls.filter { it == "append" || it == "fixSet" })
        assertEquals(listOf(Triple("ses_1", offer.id, SetFix(corrected))), server.fixes)
        assertEquals(mapOf("ses_1" to listOf(landed)), server.sets)
        assertEquals(listOf(landed), store.sets)
        assertEquals(emptyList<SetQueue.Entry>(), SetQueue(queueFile, "u1").pending)
        assertEquals(0, store.strandedCount)
        assertEquals(SaveState.OnTheLog, store.saveState)
    }

    // The log stored the set and the reply was lost, and the phone is offline: the fix stands on the
    // device at once, filed behind the append. Back online the append goes again — idempotent on the
    // set id — and then the PATCH puts the corrected body on the log.
    @Test
    fun testAnOfflineFixAfterALostReplyIsFiledAndLandsAsAppendThenPatch() = runTest {
        val server = FakeTraining()
        val queueFile = File(tmp.root, "queue.json")
        val store = liveStore(server, queueFile)
        store.enter()
        server.swallowReplies = 1
        store.logSet(weightKg = 82.5, reps = 5)
        val logged = store.sets.single()
        assertEquals("the mark survives the app", listOf(true), SetQueue(queueFile, "u1").pending.map { it.attempted })
        server.online = false

        val outcome = store.fixSet("ses_1", logged.id, SetFix(reps = 4))
        runCurrent()

        val corrected = logged.copy(reps = 4)
        assertEquals(FixOutcome.Corrected(corrected), outcome)
        assertEquals(listOf(corrected), store.sets)
        assertEquals(listOf(Triple(corrected, true, Owed.Fix)),
            SetQueue(queueFile, "u1").pending.map { Triple(it.set, it.attempted, it.write) })
        assertEquals(mapOf("ses_1" to listOf(logged.copy(setNumber = 1))), server.sets)
        assertEquals(1, store.strandedCount)
        assertEquals(SaveState.Blocked(Blocker.Offline), store.saveState)

        server.online = true
        val sentBefore = server.calls.size
        val appendedBefore = server.appended.size
        store.flushPendingSets()

        val landed = corrected.copy(setNumber = 1)
        assertEquals(listOf("append", "fixSet"), server.calls.drop(sentBefore))
        assertEquals("the replay carries the body the device now reads",
            listOf(SetWrite(corrected)), server.appended.drop(appendedBefore))
        assertEquals(listOf(Triple("ses_1", logged.id, SetFix(corrected))), server.fixes)
        assertEquals(mapOf("ses_1" to listOf(landed)), server.sets)
        assertEquals(listOf(landed), store.sets)
        assertEquals(emptyList<SetQueue.Entry>(), SetQueue(queueFile, "u1").pending)
        assertEquals(0, store.strandedCount)
        assertEquals(SaveState.OnTheLog, store.saveState)
    }

    // The fix is on disk the moment it is filed, so an app killed before the signal comes back
    // still owes it: a fresh store over the same file replays the append and then the PATCH.
    @Test
    fun testAFixFiledBeforeTheAppDiesLandsAfterReopening() = runTest {
        val server = FakeTraining()
        val queueFile = File(tmp.root, "queue.json")
        val store = liveStore(server, queueFile)
        store.enter()
        server.swallowReplies = 1
        store.logSet(weightKg = 82.5, reps = 5)
        val logged = store.sets.single()
        server.online = false
        store.fixSet("ses_1", logged.id, SetFix(reps = 4))
        runCurrent()
        val corrected = logged.copy(reps = 4)
        assertEquals(listOf(Triple(corrected, true, Owed.Fix)),
            SetQueue(queueFile, "u1").pending.map { Triple(it.set, it.attempted, it.write) })

        server.online = true
        val reopened = liveStore(server, queueFile)
        reopened.enter()

        val landed = corrected.copy(setNumber = 1)
        assertEquals(listOf(Triple("ses_1", logged.id, SetFix(corrected))), server.fixes)
        assertEquals(mapOf("ses_1" to listOf(landed)), server.sets)
        assertEquals(listOf(landed), reopened.sets)
        assertEquals(emptyList<SetQueue.Entry>(), SetQueue(queueFile, "u1").pending)
        assertEquals(0, reopened.strandedCount)
    }

    // A delete asked while the first send is in flight is filed behind it: the row leaves the device
    // at once, and the DELETE removes the row the send put on the log.
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

        assertEquals(null, store.deleteSet("ses_1", offer.id))
        assertEquals(emptyList<TrainingSet>(), store.sets)
        landing.complete(Unit)
        runCurrent()

        assertEquals(listOf("append", "deleteSet"), server.calls.filter { it == "append" || it == "deleteSet" })
        assertEquals(mapOf("ses_1" to emptyList<TrainingSet>()), server.sets)
        assertEquals(emptyList<SetQueue.Entry>(), SetQueue(queueFile, "u1").pending)
        assertEquals(0, store.strandedCount)
    }

    // The log stored the set, the reply was lost and the phone is offline: the delete's window runs
    // as always, and when it closes the delete is filed behind the append rather than refused. Back
    // online the append goes again and the DELETE takes the row off the log.
    @Test
    fun testAnOfflineDeleteAfterALostReplyIsFiledAndTakesTheRowOffTheLog() = runTest {
        val server = FakeTraining()
        val queueFile = File(tmp.root, "queue.json")
        val store = liveStore(server, queueFile)
        store.enter()
        server.swallowReplies = 1
        store.logSet(weightKg = 82.5, reps = 5)
        val logged = store.sets.single()
        server.online = false

        store.withhold(Deletion.Set("ses_1", logged))
        advanceTimeBy(Withheld.windowMs + 1)
        runCurrent()

        assertEquals(emptyList<WithheldDelete>(), store.withheld)
        assertEquals(null, store.deleteRefused)
        assertEquals(emptyList<TrainingSet>(), store.sets)
        assertEquals(listOf(Triple(logged, true, Owed.Delete)),
            SetQueue(queueFile, "u1").pending.map { Triple(it.set, it.attempted, it.write) })
        assertEquals(mapOf("ses_1" to listOf(logged.copy(setNumber = 1))), server.sets)
        assertEquals(0, store.strandedCount)

        server.online = true
        val sentBefore = server.calls.size
        store.flushPendingSets()

        assertEquals(listOf("append", "deleteSet"), server.calls.drop(sentBefore))
        assertEquals(listOf("ses_1" to logged.id), server.removed)
        assertEquals(mapOf("ses_1" to emptyList<TrainingSet>()), server.sets)
        assertEquals(emptyList<TrainingSet>(), store.sets)
        assertEquals(emptyList<SetQueue.Entry>(), SetQueue(queueFile, "u1").pending)
        assertEquals(SaveState.OnTheLog, store.saveState)
    }

    // A set the log never took is no loss when it was taken back: the append the delete waits behind
    // is refused for good, and the entry is let go without a word.
    @Test
    fun testADeleteBehindAnAppendThatCanNeverLandIsDroppedQuietly() = runTest {
        val server = FakeTraining()
        val queueFile = File(tmp.root, "queue.json")
        val store = liveStore(server, queueFile)
        store.enter()
        server.online = false
        store.logSet(weightKg = 82.5, reps = 5)
        val logged = store.sets.single()
        assertEquals(null, store.deleteSet("ses_1", logged.id))
        runCurrent()
        server.stored["ses_1"] = Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000)

        server.online = true
        store.flushPendingSets()

        assertEquals(emptyList<RefusedWrite>(), store.refusals)
        assertEquals(emptyList<Pair<String, String>>(), server.removed)
        assertEquals(emptyMap<String, List<TrainingSet>>(), server.sets)
        assertEquals(emptyList<SetQueue.Entry>(), SetQueue(queueFile, "u1").pending)
    }
}
