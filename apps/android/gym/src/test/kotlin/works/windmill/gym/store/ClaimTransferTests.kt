package works.windmill.gym.store

import java.io.File
import works.windmill.platform.storage.AtomicDocument
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.*
import works.windmill.gym.net.TrainingSyncing
import works.windmill.gym.net.FakeTraining
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

class ClaimTransferTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun selectingAnAccountLeavesTheWholeAnonymousBatchUntouched() {
        val log = LocalLog(File(tmp.root, "log"))
        val queue = SetQueue(File(tmp.root, "queue"))
        val weights = LocalBodyweight(File(tmp.root, "weights"))
        val prefs = LocalPreferences(File(tmp.root, "prefs"))
        val movement = Exercise("ex_local", "Local press", custom = true)
        val session = Session("ses_live", startedAtMs = 1_000)
        val weight = WeighIn("2026-09-14", 82.4, 2_000)
        val settings = GymPreferences(restSeconds = 90)
        log.hold(movement); queue.hold(session, unclaimed = true); queue.choose(movement.id); queue.flush()
        weights.record(weight); prefs.save(settings)
        val snapshot = log.claimItems() + queue.claimItems() + weights.claimItems() + prefs.claimItems()
        log.adopt("a"); queue.adopt("a"); weights.adopt("a"); prefs.adopt("a")
        assertEquals(emptyList<Exercise>(), log.exercises)
        assertNull(queue.session)
        assertEquals(emptyList<WeighIn>(), weights.entries)
        assertEquals(GymPreferences(), prefs.document)
        prefs.save(GymPreferences(restSeconds = 180))
        log.adopt("b"); queue.adopt("b"); weights.adopt("b"); prefs.adopt("b")
        assertEquals(GymPreferences(), prefs.document)
        assertEquals(snapshot, log.claimItems() + queue.claimItems() + weights.claimItems() + prefs.claimItems())
        log.adopt(null); queue.adopt(null); weights.adopt(null); prefs.adopt(null)
        assertEquals(listOf(movement), log.exercises)
        assertEquals(session, queue.session)
        assertEquals(movement.id, queue.chosenMovement)
        assertEquals(listOf(weight), weights.entries)
        assertEquals(settings, prefs.document)
    }

    @Test
    fun interruptedCrossFileTransferResumesOnceForItsApprovedOwnerAndKeepsNewAnonymousData() {
        val logFile = File(tmp.root, "log")
        val queueFile = File(tmp.root, "queue")
        val weightFile = File(tmp.root, "weight")
        val prefsFile = File(tmp.root, "prefs")
        val journalFile = File(tmp.root, "decision")
        val log = LocalLog(logFile)
        val queue = SetQueue(queueFile)
        val weights = LocalBodyweight(weightFile)
        val prefs = LocalPreferences(prefsFile)
        val movement = Exercise("ex_before", "Before", custom = true)
        val newer = Exercise("ex_after", "After", custom = true)
        val finished = LocalLog.FinishedSession(Session("ses_past", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(TrainingSet("set_1", movement.id, weightKg = 20.0, reps = 5, completedAtMs = 1_500)))
        val live = Session("ses_live", startedAtMs = 3_000)
        val weight = WeighIn("2026-09-14", 82.4, 4_000)
        val settings = GymPreferences(restSeconds = 90)
        log.hold(movement); log.hold(finished)
        queue.hold(live, unclaimed = true); queue.choose(movement.id); queue.flush()
        weights.record(weight); prefs.save(settings)
        val batch = ClaimBatch("batch", log.claimItems() + queue.claimItems() + weights.claimItems() + prefs.claimItems())
        LocalClaimConsent(journalFile).approve(batch, "a")
        queue.complete(batch, "a")
        log.complete(batch, "a")
        log.hold(newer)
        weights.record(weight.copy(weightKg = 83.0, recordedAt = 5_000))
        prefs.save(settings.copy(restSeconds = 120))

        val reopenedLog = LocalLog(logFile)
        val reopenedQueue = SetQueue(queueFile)
        val reopenedWeights = LocalBodyweight(weightFile)
        val reopenedPrefs = LocalPreferences(prefsFile)
        val approved = LocalClaimConsent(journalFile).state as ClaimConsent.Approved
        assertNull(approved.resumeFor("b"))
        assertEquals(batch, approved.resumeFor("a"))
        repeat(2) {
            reopenedLog.complete(batch, "a"); reopenedQueue.complete(batch, "a")
            reopenedWeights.complete(batch, "a"); reopenedPrefs.complete(batch, "a")
        }
        reopenedLog.adopt("a"); reopenedQueue.adopt("a"); reopenedWeights.adopt("a"); reopenedPrefs.adopt("a")
        assertEquals(listOf(movement), reopenedLog.exercises)
        assertEquals(listOf(finished), reopenedLog.finished)
        assertEquals(live, reopenedQueue.session)
        assertEquals(listOf(weight), reopenedWeights.entries)
        assertEquals(settings, reopenedPrefs.document)
        reopenedLog.adopt(null); reopenedQueue.adopt(null); reopenedWeights.adopt(null); reopenedPrefs.adopt(null)
        assertEquals(listOf(newer), reopenedLog.exercises)
        assertNull(reopenedQueue.session)
        assertEquals(listOf(weight.copy(weightKg = 83.0, recordedAt = 5_000)), reopenedWeights.entries)
        assertEquals(settings.copy(restSeconds = 120), reopenedPrefs.document)
        assertThrows(IllegalStateException::class.java) { reopenedLog.complete(batch, "b") }
    }

    @Test
    fun aFrozenDiscardRemovesOnlyExactRowsAndPreservesNewerValues() {
        val file = File(tmp.root, "log")
        val log = LocalLog(file)
        val first = Exercise("ex_first", "First", custom = true)
        val second = Exercise("ex_second", "Second", custom = true)
        log.hold(first)
        val batch = ClaimBatch("discard", log.claimItems())
        log.renameExercise(first.id, "Edited after the tap")
        log.hold(second)
        LocalClaimConsent(File(tmp.root, "decision")).discard(batch)
        log.complete(batch, null)
        assertEquals(listOf(first.copy(name = "Edited after the tap"), second), LocalLog(file).exercises)
        log.complete(batch, null)
        assertEquals(listOf(first.copy(name = "Edited after the tap"), second), log.exercises)
    }

    @Test
    fun storeApprovalIsDurableBeforeAnyTransferAndARevokedFlowCannotApprove() = runTest {
        val file = File(tmp.root, "log")
        val log = LocalLog(file)
        val movement = Exercise("ex_local", "Local press", custom = true)
        log.hold(movement)
        val journalFile = File(tmp.root, "decision")
        var failWrite = true
        val factory = { LocalClaimConsent(journalFile) { target, text ->
            if (failWrite) throw IOException("Disk is full")
            AtomicDocument.write(target, text)
        } }
        val store = TrainingStore(SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "device")), log,
            LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "weight")), backgroundScope,
            sync = { null }, openConsent = factory)
        assertNull(store.requestClaimSignIn())
        assertEquals(listOf(movement), LocalLog(file).exercises)
        assertFalse(journalFile.exists())
        failWrite = false
        val fresh = TrainingStore(SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "device")), LocalLog(file),
            LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "weight")), backgroundScope,
            sync = { null }, openConsent = factory)
        val flow = checkNotNull(fresh.requestClaimSignIn())
        fresh.withhold(Deletion.Unattributed)
        assertNull(LocalClaimConsent(journalFile).state)
        assertThrows(IllegalStateException::class.java) { fresh.approveSignIn("a", flow) }
        assertEquals(listOf(movement), LocalLog(file).exercises)
        assertNotNull(fresh.keepWithheld())
        assertNull(LocalClaimConsent(journalFile).state)
    }

    @Test
    fun signingInWithoutAnExplicitDecisionCannotPostAnonymousTraining() = runTest {
        val log = LocalLog(File(tmp.root, "log"))
        val local = Exercise("ex_local", "Local press", custom = true)
        log.hold(local)
        val server = FakeTraining()
        val store = TrainingStore(SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "device")), log,
            LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "weight")), backgroundScope,
            sync = { if (it.isSignedIn) server else null })
        val account = Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }), User("a", "a@example.com"))
        store.connect(account)
        assertEquals(emptyList<Exercise>(), log.exercises)
        assertFalse(server.exercises().any { it.id == local.id })
        assertEquals(1, store.localDataBatch?.movements)
        assertNull(store.releaseUnattributed())
        assertEquals(listOf(local), server.exercises().filter { it.id == local.id })
        assertNull(store.localDataBatch)
        assertNull(LocalClaimConsent(log.claimConsentFile).state)
    }
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun notMineKeepsItsOriginalDeadlineAndNeverDiscardsLaterAnonymousWork() = runTest {
        val file = File(tmp.root, "log")
        val log = LocalLog(file)
        val before = Exercise("ex_before", "Before", custom = true)
        val after = Exercise("ex_after", "After", custom = true)
        log.hold(before)
        val store = TrainingStore(SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "device")), log,
            LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "weight")), backgroundScope,
            now = { 1_800_000_000_000 + testScheduler.currentTime }, sync = { null })
        val anonymous = Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }), null)
        store.connect(anonymous)
        store.withhold(Deletion.Unattributed)
        val held = store.withheld.single()
        log.hold(after)
        advanceTimeBy(8_999); runCurrent()
        assertEquals(listOf(before, after), LocalLog(file).exercises)
        assertNull(LocalClaimConsent(log.claimConsentFile).state)
        assertEquals(1_800_000_009_000, held.untilMs)
        advanceTimeBy(1); runCurrent()
        assertEquals(listOf(after), LocalLog(file).exercises)
        assertEquals(emptyList<WithheldDelete>(), store.withheld)
        assertEquals(1, store.localDataBatch?.movements)
        assertNull(LocalClaimConsent(log.claimConsentFile).state)
    }

    @Test
    fun aCorruptDecisionBlocksOnlyTheClaimInsteadOfCrashingTheRoom() = runTest {
        val log = LocalLog(File(tmp.root, "log"))
        val local = Exercise("ex_local", "Local press", custom = true)
        log.hold(local)
        log.claimConsentFile.writeText("not a decision")
        val server = FakeTraining()
        val store = TrainingStore(SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "device")), log,
            LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "weight")), backgroundScope,
            sync = { server })
        store.connect(Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }), User("a", "a@example.com")))
        assertEquals("Local data could not be read safely. Restart the app to try again.", store.consentFailure)
        assertNull(store.localDataBatch)
        assertFalse(server.exercises().any { it.id == local.id })
        log.adopt(null)
        assertEquals(listOf(local), log.exercises)
    }

    @Test
    fun markerOnlyDocumentsRetainACompletedDiscardAcrossRecreation() {
        val movement = Exercise("ex_local", "Local press", custom = true)
        val session = Session("ses_local", startedAtMs = 1_000)
        val preferences = GymPreferences(restSeconds = 90)
        val logFile = File(tmp.root, "log")
        val queueFile = File(tmp.root, "queue")
        val prefsFile = File(tmp.root, "prefs")
        val log = LocalLog(logFile).apply { hold(movement) }
        val queue = SetQueue(queueFile).apply { hold(session, unclaimed = true); flush() }
        val prefs = LocalPreferences(prefsFile).apply { save(preferences) }
        val batch = ClaimBatch("discard", log.claimItems() + queue.claimItems() + prefs.claimItems())
        log.complete(batch, null); queue.complete(batch, null); prefs.complete(batch, null)
        for (file in listOf(logFile, queueFile, prefsFile)) assertEquals("""{"claims":{"discard":"discard"}}""", file.readText())
        val nextLog = LocalLog(logFile).apply { hold(movement) }
        val nextQueue = SetQueue(queueFile).apply { hold(session, unclaimed = true); flush() }
        val nextPrefs = LocalPreferences(prefsFile).apply { save(preferences) }
        nextLog.complete(batch, null); nextQueue.complete(batch, null); nextPrefs.complete(batch, null)
        assertEquals(listOf(movement), nextLog.exercises)
        assertEquals(session, nextQueue.session)
        assertEquals(preferences, nextPrefs.document)
        assertThrows(IllegalStateException::class.java) { nextLog.complete(batch, "b") }
        assertThrows(IllegalStateException::class.java) { nextQueue.complete(batch, "b") }
        assertThrows(IllegalStateException::class.java) { nextPrefs.complete(batch, "b") }
    }

    @Test
    fun anApprovedFlowCanFinishItsOwnAuthenticationAfterProcessReplacement() = runTest {
        val logFile = File(tmp.root, "log")
        LocalLog(logFile).hold(Exercise("ex_local", "Local press", custom = true))
        fun fresh() = TrainingStore(SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "device")), LocalLog(logFile),
            LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "weight")), backgroundScope,
            sync = { null })
        val first = fresh()
        val flow = checkNotNull(first.requestClaimSignIn())
        first.approveSignIn("a", flow)
        val approved = LocalClaimConsent(LocalLog(logFile).claimConsentFile).state
        val restored = fresh()
        restored.approveSignIn("a", flow)
        assertEquals(approved, LocalClaimConsent(LocalLog(logFile).claimConsentFile).state)
        assertThrows(IllegalStateException::class.java) { restored.approveSignIn("b", flow) }
        assertThrows(IllegalStateException::class.java) { restored.approveSignIn("a", "another-flow") }
        assertEquals(approved, LocalClaimConsent(LocalLog(logFile).claimConsentFile).state)
        assertEquals(1, LocalLog(logFile).exercises.size)
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun notMineSupersedesAnOlderClaimWhileItsPreflightReadIsPending() = runTest {
        val queueFile = File(tmp.root, "queue")
        val session = Session("ses_local", startedAtMs = 1_800_000_000_000)
        SetQueue(queueFile).apply { hold(session, unclaimed = true); flush() }
        val release = CompletableDeferred<Unit>()
        var hold = false
        val server = FakeTraining()
        val wire = object : TrainingSyncing by server {
            override suspend fun sessions(limit: Int, before: Long?, beforeId: String?): List<SessionSummary> {
                if (hold) release.await()
                return emptyList()
            }
        }
        val log = LocalLog(File(tmp.root, "log"))
        val store = TrainingStore(SetQueue(queueFile), DeviceCopy(File(tmp.root, "device")), log,
            LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "weight")), backgroundScope,
            now = { 1_800_000_000_000 + testScheduler.currentTime }, sync = { wire })
        val account = Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }), User("a", "a@example.com"))
        store.connect(account)
        hold = true
        val claim = async { store.releaseUnattributed() }
        runCurrent()
        assertTrue(store.claimBusy)
        store.withhold(Deletion.Unattributed)
        release.complete(Unit)
        assertNull(claim.await())
        assertFalse(store.claimBusy)
        assertNull(LocalClaimConsent(log.claimConsentFile).state)
        assertEquals(session, SetQueue(queueFile).session)
        assertEquals(emptyList<SessionStart>(), server.started)
        advanceTimeBy(9_000); runCurrent()
        assertNull(SetQueue(queueFile).session)
        assertEquals(emptyList<SessionStart>(), server.started)
        assertNull(LocalClaimConsent(log.claimConsentFile).state)
    }

    @Test
    fun failedColdPreflightCannotReplayAPartialApprovalAndDoesNotFreezeAnotherOwner() = runTest {
        val queueFile = File(tmp.root, "queue")
        val logFile = File(tmp.root, "log")
        val queue = SetQueue(queueFile)
        val local = LocalLog(logFile)
        val session = Session("ses_local", startedAtMs = 1_800_000_000_000)
        val movement = Exercise("ex_local", "Local press", custom = true)
        queue.hold(session, unclaimed = true); queue.flush(); local.hold(movement)
        val batch = ClaimBatch("partial", queue.claimItems() + local.claimItems())
        LocalClaimConsent(local.claimConsentFile).approve(batch, "a")
        queue.complete(batch, "a"); local.complete(batch, "a")
        val serverA = FakeTraining()
        val serverB = FakeTraining()
        val broken = object : TrainingSyncing by serverA {
            override suspend fun sessions(limit: Int, before: Long?, beforeId: String?): List<SessionSummary> = throw IOException("preflight failed")
        }
        val store = TrainingStore(SetQueue(queueFile), DeviceCopy(File(tmp.root, "device")), LocalLog(logFile),
            LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "weight")), backgroundScope,
            now = { 1_800_000_000_000 }, mintSession = { "ses_b" }, undoWindowMs = 0,
            sync = { if (it.user?.id == "a") broken else serverB })
        fun account(id: String) = Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }), User(id, "$id@example.com"))
        store.connect(account("a"))
        assertEquals("preflight failed", store.consentFailure)
        assertEquals(emptyList<SessionStart>(), serverA.started)
        assertEquals(emptyList<Exercise>(), serverA.catalog)
        assertEquals(listOf(movement), LocalLog(logFile, "a").exercises)
        assertEquals(ClaimConsent.Approved(batch, "a"), LocalClaimConsent(local.claimConsentFile).state)
        store.connect(account("b"))
        store.start(); store.choose("bench-press"); store.logSet(20.0, 5)
        assertEquals(listOf("ses_b"), serverB.started.map { it.id })
        assertEquals(listOf(20.0 to 5), serverB.sets["ses_b"].orEmpty().map { it.weightKg to it.reps })
        assertEquals(emptyList<SessionStart>(), serverA.started)
        assertEquals(ClaimConsent.Approved(batch, "a"), LocalClaimConsent(local.claimConsentFile).state)
    }

    @Test
    fun anAcceptedClaimWithALostReplyDrawsOneRoutineUntilItsExactReplaySettles() = runTest {
        val log = LocalLog(File(tmp.root, "lost-log"))
        val routine = Routine("rt_local", "Local consent routine", entries = listOf(RoutineEntry(1, "bench-press")))
        log.hold(routine)
        val server = FakeTraining()
        var loseReply = true
        val writes = mutableListOf<RoutineWrite>()
        val transport = object : TrainingSyncing by server {
            override suspend fun createRoutine(write: RoutineWrite): Routine {
                writes += write
                val stored = server.createRoutine(write)
                if (loseReply) throw IOException("Accepted response was lost")
                return stored
            }
        }
        val copy = DeviceCopy(File(tmp.root, "lost-copy"))
        val store = TrainingStore(SetQueue(File(tmp.root, "lost-queue")), copy, log,
            LocalPreferences(File(tmp.root, "lost-prefs")), LocalBodyweight(File(tmp.root, "lost-weight")),
            backgroundScope, sync = { if (it.isSignedIn) transport else null })
        val flow = checkNotNull(store.requestClaimSignIn())
        store.approveSignIn("a", flow)
        val account = Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }), User("a", "a@example.com"))
        store.connect(account)
        assertEquals(listOf(routine), store.allRoutines)
        assertEquals(listOf(routine), copy.routines("a"))
        assertEquals(listOf(routine), log.routines)
        assertEquals(listOf(routine), server.written.values.toList())
        loseReply = false
        store.connect(account)
        assertEquals(listOf(routine), store.allRoutines)
        assertEquals(listOf(routine), copy.routines("a"))
        assertEquals(emptyList<Routine>(), log.routines)
        assertEquals(listOf(RoutineWrite(routine), RoutineWrite(routine)), writes)
    }

}
