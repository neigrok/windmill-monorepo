package works.windmill.gym.store

import java.io.File
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
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
import works.windmill.platform.net.WindmillApi

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class TrainingFinishTests {
    @get:Rule val tmp = TemporaryFolder()

    private fun TestScope.store(logs: Map<String, TrainingSyncing>, undoMs: Long = 9_000,
        mintSession: () -> String = { "ses_mine" },
    ): TrainingStore {
        val folder = tmp.newFolder()
        var nextSetId = 0
        return TrainingStore(
        queue = SetQueue(File(folder, "queue"), null) { testScheduler.currentTime + 1_000 },
        deviceCopy = DeviceCopy(File(folder, "catalog")),
        localLog = LocalLog(File(folder, "local")),
        localPreferences = LocalPreferences(File(folder, "prefs")),
        localBodyweight = LocalBodyweight(File(folder, "body")),
        scope = backgroundScope,
        now = { testScheduler.currentTime + 1_000 },
        mintSession = mintSession, mintSet = { "set_${++nextSetId}" },
        undoWindowMs = undoMs,
        sync = { logs[it.user?.id] },
        )
    }

    private fun account(id: String = "a") = Account(
        api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
        user = User(id = id, email = "$id@example.com", name = id),
    )

    @Test fun finishCarriesCanonicalRowsAndKeepsTheHeldDeletionDeadline() = runTest {
        val server = FakeTraining()
        val log = object : TrainingSyncing by server {
            override suspend fun appendSet(sessionId: String, write: SetWrite): TrainingSet {
                val stored = server.appendSet(sessionId, write).copy(id = "set_canonical", setNumber = 7)
                server.sets[sessionId] = mutableListOf(stored)
                return stored
            }
        }
        val store = store(mapOf("a" to log))
        store.connect(account())
        store.start()
        store.choose("bench-press")
        store.logSet(60.0, 8)
        val local = store.sets.single()
        store.withhold(Deletion.Set("ses_mine", local))
        val deadline = store.withheld.single().untilMs
        val closed = store.finish() as FinishOutcome.Closed
        val canonical = local.copy(id = "set_canonical", setNumber = 7)
        assertEquals(SessionDetail(server.stored.getValue("ses_mine"), listOf(canonical)), closed.detail)
        assertEquals(listOf(WithheldDelete(Deletion.Set("ses_mine", canonical), deadline)), store.withheld)
        assertEquals(store.withheld.single(), store.keepWithheld())
        assertEquals(closed.detail, store.retainedSession(closed.detail))
        assertTrue(server.removed.isEmpty())
        assertNull(store.session)
    }

    @Test fun aFinishedWorkoutsQueuedOrPendingRefreshCannotReadOrReplaceTheNextAccount() = runTest {
        for (startRefresh in listOf(false, true)) {
            val first = FakeTraining()
            val second = FakeTraining()
            val secondSession = Session("ses_b", startedAtMs = 500, finishedAtMs = 800)
            val secondSet = TrainingSet("set_b", "back-squat", 1, 80.0, 5, completedAtMs = 600)
            second.open(secondSession)
            second.sets[secondSession.id] = mutableListOf(secondSet)
            val gate = CompletableDeferred<Unit>()
            var closed = false
            var refreshes = 0
            val log = object : TrainingSyncing by first {
                override suspend fun finishSession(sessionId: String, finishedAtMs: Long): Session =
                    first.finishSession(sessionId, finishedAtMs).also { closed = true }

                override suspend fun sessions(limit: Int, before: Long?, beforeId: String?): List<SessionSummary> {
                    val rows = first.sessions(limit, before, beforeId)
                    if (closed) { refreshes++; gate.await() }
                    return rows
                }
            }
            val store = store(mapOf("a" to log, "b" to second))
            store.connect(account())
            store.start()
            store.choose("bench-press")
            store.logSet(60.0, 8)
            val performed = store.sets.single().copy(setNumber = 1)
            val receipt = store.finish() as FinishOutcome.Closed
            assertEquals(SessionDetail(first.stored.getValue("ses_mine"), listOf(performed)), receipt.detail)
            assertEquals(receipt.detail, store.retainedSession(receipt.detail))
            assertNull(store.session)
            assertFalse(store.isFinishing)
            if (startRefresh) runCurrent()
            store.connect(account("b"))
            val secondHistory = listOf(SessionSummary(secondSession, listOf(secondSet)))
            assertEquals(secondHistory, store.allSessions)
            gate.complete(Unit)
            runCurrent()
            assertEquals(if (startRefresh) 1 else 0, refreshes)
            assertEquals(secondHistory, store.allSessions)
            assertEquals(mapOf(secondSession.id to secondSession), second.stored)
            assertEquals(mapOf(secondSession.id to listOf(secondSet)), second.sets)
            assertEquals(mapOf(receipt.detail.session.id to receipt.detail.session), first.stored)
            assertEquals(mapOf(receipt.detail.session.id to listOf(performed)), first.sets)
            assertNull(store.session)
            assertEquals(emptyList<TrainingSet>(), store.sets)
        }
    }

    @Test fun aDelayedFinishedPageCannotCloseTheNextWorkoutOrReplaceItsRestAndOffer() = runTest {
        val server = FakeTraining()
        val gate = CompletableDeferred<Unit>()
        var holdRefresh = false
        val log = object : TrainingSyncing by server {
            override suspend fun sessions(limit: Int, before: Long?, beforeId: String?): List<SessionSummary> {
                val page = server.sessions(limit, before, beforeId)
                if (holdRefresh) { holdRefresh = false; gate.await() }
                return page
            }
        }
        val ids = mutableListOf("ses_first", "ses_next")
        val store = store(mapOf("a" to log), mintSession = { ids.removeAt(0) })
        store.connect(account())
        store.start()
        store.choose("bench-press")
        store.logSet(60.0, 8)
        holdRefresh = true
        val receipt = store.finish() as FinishOutcome.Closed
        runCurrent()
        assertFalse(holdRefresh)
        advanceTimeBy(1_000)
        store.start()
        store.choose("back-squat")
        store.logSet(100.0, 5)
        runCurrent()
        val live = store.session!!
        val rows = store.sets.toList()
        val notification = store.notification.value!!
        val rest = store.restStartedAtMs
        val queueFile = tmp.root.walkTopDown().single { it.name == "queue" }
        val queue = queueFile.readText()
        gate.complete(Unit)
        runCurrent()

        assertEquals("ses_next", live.id)
        assertEquals(live, store.session)
        assertEquals(rows, store.sets)
        assertEquals(notification, store.notification.value)
        assertEquals(rest, store.restStartedAtMs)
        assertEquals(queue, queueFile.readText())
        assertEquals(receipt.detail, store.retainedSession(receipt.detail))
        assertEquals(mapOf(receipt.detail.session.id to receipt.detail.session, live.id to live), server.stored)
        assertTrue(server.stored.getValue(live.id).isOpen)
    }

    @Test fun aNewerHistoryReadWinsOverTheDelayedPostFinishSnapshot() = runTest {
        val server = FakeTraining()
        val gate = CompletableDeferred<Unit>()
        var holdRefresh = false
        val log = object : TrainingSyncing by server {
            override suspend fun sessions(limit: Int, before: Long?, beforeId: String?): List<SessionSummary> {
                val page = server.sessions(limit, before, beforeId)
                if (holdRefresh) { holdRefresh = false; gate.await() }
                return page
            }
        }
        val store = store(mapOf("a" to log))
        store.connect(account())
        store.start()
        store.choose("bench-press")
        store.logSet(60.0, 8)
        holdRefresh = true
        val receipt = store.finish() as FinishOutcome.Closed
        runCurrent()
        val later = Session("ses_later", startedAtMs = 2_000, finishedAtMs = 3_000)
        val laterSet = TrainingSet("set_later", "back-squat", 1, 100.0, 5, completedAtMs = 2_500)
        server.open(later)
        server.sets[later.id] = mutableListOf(laterSet)
        store.connect(account())
        val expected = listOf(SessionSummary(later, listOf(laterSet)), SessionSummary(receipt.detail.session, receipt.detail.sets))
        assertEquals(expected, store.allSessions)
        gate.complete(Unit)
        runCurrent()
        assertEquals(expected, store.allSessions)
        assertEquals(Older.End, store.older)
        assertEquals(receipt.detail, store.retainedSession(receipt.detail))
        assertNull(store.session)
    }

    @Test fun aPostFinishOpenDetailCannotReplaceAWorkoutAdoptedByANewerRead() = runTest {
        val server = FakeTraining()
        val gate = CompletableDeferred<Unit>()
        var detailPending = false
        val log = object : TrainingSyncing by server {
            override suspend fun session(id: String): SessionDetail? {
                val detail = server.session(id)?.let { it.copy(sets = it.sets.toList()) }
                if (id == "ses_remote") { detailPending = true; gate.await() }
                return detail
            }
        }
        val store = store(mapOf("a" to log))
        store.connect(account())
        store.start()
        store.choose("bench-press")
        store.logSet(60.0, 8)
        store.finish()
        val remote = Session("ses_remote", startedAtMs = 1_000)
        server.open(remote)
        server.sets[remote.id] = mutableListOf(TrainingSet("remote_set", "bench-press", 1, 80.0, 5, completedAtMs = 1_000))
        runCurrent()
        assertTrue(detailPending)
        server.stored[remote.id] = remote.copy(finishedAtMs = 1_000)
        val next = Session("ses_next", startedAtMs = 1_000)
        val nextSet = TrainingSet("next_set", "back-squat", 1, 100.0, 5, completedAtMs = 1_000)
        server.open(next)
        server.sets[next.id] = mutableListOf(nextSet)
        store.connect(account())
        val notification = store.notification.value!!
        val history = store.allSessions.toList()
        val queueFile = tmp.root.walkTopDown().single { it.name == "queue" }
        val queue = queueFile.readText()
        gate.complete(Unit)
        runCurrent()

        assertEquals(next, store.session)
        assertEquals(listOf(nextSet), store.sets)
        assertEquals(notification, store.notification.value)
        assertEquals(history, store.allSessions)
        assertEquals(queue, queueFile.readText())
        assertEquals(1_000L, store.restStartedAtMs)
        assertEquals(next, server.stored.getValue(next.id))
        assertEquals(listOf(nextSet), server.sets.getValue(next.id))
    }

    @Test fun aCorrectionWaitsForAppendAndPatchesItsCanonicalId() = runTest {
        val server = FakeTraining()
        val gate = CompletableDeferred<Unit>()
        val log = object : TrainingSyncing by server {
            override suspend fun appendSet(sessionId: String, write: SetWrite): TrainingSet {
                gate.await()
                val stored = server.appendSet(sessionId, write).copy(id = "set_canonical", setNumber = 7)
                server.sets[sessionId] = mutableListOf(stored)
                return stored
            }
        }
        val store = store(mapOf("a" to log), undoMs = 0)
        store.connect(account())
        store.start()
        store.choose("bench-press")
        val append = launch { store.logSet(60.0, 8) }
        runCurrent()
        val correction = async { store.fixSet("ses_mine", "set_2", SetFix(reps = 9)) }
        runCurrent()
        assertFalse(correction.isCompleted)
        assertTrue(server.fixes.isEmpty())
        gate.complete(Unit)
        append.join()
        runCurrent()
        val expected = TrainingSet("set_canonical", "bench-press", 7, 60.0, 9, completedAtMs = 1_000)
        assertEquals(FixOutcome.Corrected(expected), correction.await())
        assertEquals(listOf(Triple("ses_mine", "set_canonical", SetFix(reps = 9))), server.fixes)
        assertEquals(listOf(expected), store.sets)
        assertEquals(listOf(expected), (store.finish() as FinishOutcome.Closed).detail.sets)
    }

    @Test fun aFailedCorrectionKeepsTheSettledSetAndCanRetryTheSameDraft() = runTest {
        val server = FakeTraining()
        val gate = CompletableDeferred<Unit>()
        server.onAppend = { gate.await() }
        val store = store(mapOf("a" to server), undoMs = 0)
        store.connect(account())
        store.start()
        store.choose("bench-press")
        val append = launch { store.logSet(60.0, 8) }
        runCurrent()
        val fix = SetFix(reps = 9, note = "kept input")
        val correction = async { store.fixSet("ses_mine", "set_2", fix) }
        server.refuseFix = { IOException("offline") }
        gate.complete(Unit)
        append.join()
        runCurrent()
        assertTrue(correction.await() is FixOutcome.Failed)
        val stored = TrainingSet("set_2", "bench-press", 1, 60.0, 8, completedAtMs = 1_000)
        assertEquals(listOf(stored), store.sets)
        server.refuseFix = { null }
        assertEquals(FixOutcome.Corrected(fix.corrected(stored)), store.fixSet("ses_mine", "set_2", fix))
        assertEquals(listOf(fix.corrected(stored)), store.sets)
    }

    @Test fun accountChangeDuringAppendDiscardsItsReplyAndTheWaitingCorrection() = runTest {
        val first = FakeTraining()
        val second = FakeTraining()
        val gate = CompletableDeferred<Unit>()
        first.onAppend = { gate.await() }
        val store = store(mapOf("a" to first, "b" to second), undoMs = 0)
        store.connect(account())
        store.start()
        store.choose("bench-press")
        val append = launch { store.logSet(60.0, 8) }
        runCurrent()
        val correction = async { store.fixSet("ses_mine", "set_2", SetFix(reps = 9)) }
        val arrival = launch { store.connect(account("b")) }
        runCurrent()
        gate.complete(Unit)
        append.join()
        arrival.join()
        assertTrue(correction.await() is FixOutcome.Failed)
        assertEquals(emptyList<TrainingSet>(), store.sets)
        assertTrue(first.fixes.isEmpty())
        assertTrue(second.appended.isEmpty())
        assertNull(store.session)
    }

    @Test fun strandedSetsPreventTheServerFinishAndRetainTheLiveWorkout() = runTest {
        val server = FakeTraining()
        val store = store(mapOf("a" to server))
        store.connect(account())
        store.start()
        store.choose("bench-press")
        store.logSet(60.0, 8)
        val live = store.session
        val sets = store.sets
        server.online = false
        assertEquals(FinishOutcome.Stranded(1), store.finish())
        assertTrue(server.finished.isEmpty())
        assertEquals(live, store.session)
        assertEquals(sets, store.sets)
    }
    @Test fun aReceiptAlreadyShownFollowsTheLaterClaimRemintWithoutWaitingForThatClaim() = runTest {
        val server = FakeTraining().apply { online = false }
        val gate = CompletableDeferred<Unit>()
        val log = object : TrainingSyncing by server {
            override suspend fun startSession(start: SessionStart): Session {
                if (server.online && start.id == "ses_second") throw works.windmill.platform.net.WindmillApiException.Refused(
                    409, works.windmill.platform.net.Refusal(code = "session-id-taken", message = "taken"))
                return server.startSession(start)
            }
            override suspend fun appendSet(sessionId: String, write: SetWrite): TrainingSet {
                val stored = server.appendSet(sessionId, write)
                if (sessionId != "ses_canonical") return stored
                return stored.copy(id = "set_canonical", setNumber = 4).also {
                    server.sets[sessionId] = mutableListOf(it)
                }
            }
        }
        val ids = mutableListOf("ses_first", "ses_second", "ses_canonical")
        val store = store(mapOf("a" to log), mintSession = { ids.removeAt(0) })
        store.connect(account())
        store.start()
        store.choose("bench-press")
        store.logSet(60.0, 8)
        store.finish()
        store.start()
        store.choose("back-squat")
        store.logSet(100.0, 5)
        val performed = store.sets.single()
        server.online = true
        server.onFinish = { if (server.finished.last().first == "ses_first") gate.await() }
        val reconnect = launch { store.connect(account()) }
        runCurrent()
        val finish = async { store.finish() }
        runCurrent()
        assertTrue("local finish remains independent of the older claim", finish.isCompleted)
        val receipt = (finish.await() as FinishOutcome.Closed).detail
        assertEquals("ses_second", receipt.session.id)
        assertEquals(listOf(performed), receipt.sets)
        store.withhold(Deletion.Set(receipt.session.id, performed))
        val deadline = store.withheld.single().untilMs
        gate.complete(Unit)
        reconnect.join()
        val canonical = performed.copy(id = "set_canonical", setNumber = 4)
        val expected = SessionDetail(server.stored.getValue("ses_canonical"), listOf(canonical))
        assertEquals(expected, store.retainedSession(receipt))
        assertEquals(listOf(WithheldDelete(Deletion.Set("ses_canonical", canonical), deadline)), store.withheld)
        assertEquals(expected.sets, (store.sessionDetail(expected.session.id) as GymResult.Ok).value.sets)
        assertNull(store.session)
    }

    @Test fun finishDuringALiveClaimCollisionMovesTheShelfAndReceiptTogether() = runTest {
        val server = FakeTraining().apply { online = false }
        val gate = CompletableDeferred<Unit>()
        var deferred = false
        val log = object : TrainingSyncing by server {
            override suspend fun startSession(start: SessionStart): Session {
                if (deferred && start.id == "ses_mine") {
                    gate.await()
                    throw works.windmill.platform.net.WindmillApiException.Refused(409,
                        works.windmill.platform.net.Refusal(code = "session-id-taken", message = "taken"))
                }
                return server.startSession(start)
            }
        }
        val ids = mutableListOf("ses_mine", "ses_canonical")
        val store = store(mapOf("a" to log), mintSession = { ids.removeAt(0) })
        store.connect(account())
        store.start()
        store.choose("bench-press")
        store.logSet(60.0, 8)
        val performed = store.sets.single()
        deferred = true
        server.online = true
        val connect = launch { store.connect(account()) }
        runCurrent()
        val finish = async { store.finish() }
        runCurrent()
        assertTrue(finish.isCompleted)
        val receipt = (finish.await() as FinishOutcome.Closed).detail
        assertEquals("ses_mine", receipt.session.id)
        gate.complete(Unit)
        connect.join()
        val expected = SessionDetail(server.stored.getValue("ses_canonical"), listOf(performed.copy(setNumber = 1)))
        assertEquals(expected, store.retainedSession(receipt))
        assertEquals(listOf("ses_canonical"), server.stored.keys.toList())
        assertFalse(server.stored.getValue("ses_canonical").isOpen)
        assertNull(store.session)
        assertTrue(store.refusals.isEmpty())
    }

    @Test fun aStartReplyOrLostReplyCannotAdoptIntoTheNextAccount() = runTest {
        for (lost in listOf(false, true)) {
            val first = FakeTraining()
            val second = FakeTraining()
            val gate = CompletableDeferred<Unit>()
            val log = object : TrainingSyncing by first {
                override suspend fun startSession(start: SessionStart): Session {
                    gate.await()
                    val session = first.startSession(start)
                    if (lost) throw IOException("lost reply")
                    return session
                }
            }
            val store = store(mapOf("a" to log, "b" to second))
            store.connect(account())
            val start = async { store.start() }
            runCurrent()
            store.connect(account("b"))
            gate.complete(Unit)
            assertEquals(GymResult.Failed(WriteFailure.Refused("the account changed while starting")), start.await())
            assertNull(store.session)
            assertTrue(store.sets.isEmpty())
            assertTrue(second.started.isEmpty())
        }
    }

    @Test fun theRemappedDeletionFiresAtItsOriginalDeadlineAndFailureRestoresTheSavedFacts() = runTest {
        for (failed in listOf(false, true)) {
            val server = FakeTraining()
            val log = object : TrainingSyncing by server {
                override suspend fun appendSet(sessionId: String, write: SetWrite): TrainingSet {
                    val stored = server.appendSet(sessionId, write).copy(id = "set_canonical", setNumber = 7)
                    server.sets[sessionId] = mutableListOf(stored)
                    return stored
                }
            }
            val store = store(mapOf("a" to log))
            store.connect(account())
            store.start()
            store.choose("bench-press")
            store.logSet(60.0, 8)
            store.withhold(Deletion.Set("ses_mine", store.sets.single()))
            val receipt = (store.finish() as FinishOutcome.Closed).detail
            if (failed) server.refuseDelete = IOException("offline")
            advanceTimeBy(8_999)
            runCurrent()
            assertTrue(server.removed.isEmpty())
            advanceTimeBy(1)
            runCurrent()
            assertEquals(listOf("ses_mine" to "set_canonical"), server.removed)
            assertTrue(store.withheld.isEmpty())
            assertEquals(if (failed) receipt.sets else emptyList<TrainingSet>(), store.retainedSession(receipt).sets)
            assertEquals(if (failed) receipt.sets else emptyList<TrainingSet>(), server.sets.getValue("ses_mine"))
        }
    }

    @Test fun aDeletionTimerCannotPublishItsOldAccountsFailureIntoTheNextSeat() = runTest {
        val first = FakeTraining()
        val second = FakeTraining()
        val gate = CompletableDeferred<Unit>()
        val log = object : TrainingSyncing by first {
            override suspend fun deleteSet(sessionId: String, setId: String) {
                gate.await()
                throw IOException("offline")
            }
        }
        val store = store(mapOf("a" to log, "b" to second))
        store.connect(account())
        store.start()
        store.choose("bench-press")
        store.logSet(60.0, 8)
        val receipt = (store.finish() as FinishOutcome.Closed).detail
        store.withhold(Deletion.Set(receipt.session.id, receipt.sets.single()))
        advanceTimeBy(9_000)
        runCurrent()
        val arrival = launch { store.connect(account("b")) }
        runCurrent()
        gate.complete(Unit)
        arrival.join()
        runCurrent()
        assertNull(store.deleteRefused)
        assertTrue(store.withheld.isEmpty())
        assertTrue(second.removed.isEmpty())
    }

    @Test fun aSeededReadCannotOverwriteACorrectionAcceptedWhileItWasInFlight() = runTest {
        val server = FakeTraining()
        val gate = CompletableDeferred<Unit>()
        var deferNextRead = false
        val log = object : TrainingSyncing by server {
            override suspend fun session(id: String): SessionDetail? {
                val result = server.session(id)?.let { it.copy(sets = it.sets.toList()) }
                if (deferNextRead) { deferNextRead = false; gate.await() }
                return result
            }
        }
        val store = store(mapOf("a" to log))
        store.connect(account()); store.start(); store.choose("bench-press"); store.logSet(60.0, 8)
        val receipt = (store.finish() as FinishOutcome.Closed).detail
        deferNextRead = true
        val read = async { store.sessionDetail(receipt.session.id, receipt) }
        runCurrent()
        val fixed = store.fixSet(receipt.session.id, receipt.sets.single().id, SetFix(weightKg = 62.5, note = "steady"))
        val expected = receipt.copy(sets = listOf((fixed as FixOutcome.Corrected).set))
        gate.complete(Unit)
        assertEquals(GymResult.Ok(expected), read.await())
        assertEquals(expected, store.retainedSession(receipt))
        assertEquals(expected.sets, server.sets.getValue(receipt.session.id))
    }

    @Test fun eachAccountResumesItsOwnCursorWhenTheirMovementOrdersOverlap() = runTest {
        val plan = PlanSnapshot("Push A", listOf(PlanEntry("bench-press"), PlanEntry("overhead-press")))
        val a = FakeTraining().apply { open(Session("live_a", startedAtMs = 1_000, plan = plan)) }
        val b = FakeTraining().apply { open(Session("live_b", startedAtMs = 1_000, plan = plan)) }
        val store = store(mapOf("a" to a, "b" to b))
        store.connect(account("a")); store.choose("overhead-press")
        store.connect(account("b")); store.choose("bench-press")
        store.connect(account("a"))
        assertEquals("overhead-press", store.exerciseId)
        store.connect(account("b"))
        assertEquals("bench-press", store.exerciseId)
    }

    @Test fun keepingTheReceiptRetriesOneCreationDocumentEvenAfterTheProgramGrows() = runTest {
        val server = FakeTraining()
        var lost = true
        val log = object : TrainingSyncing by server {
            override suspend fun createRoutine(write: RoutineWrite): Routine {
                val made = server.createRoutine(write)
                if (lost) { lost = false; throw IOException("accepted reply lost") }
                return made
            }
        }
        val store = store(mapOf("a" to log))
        store.connect(account())
        val rows = listOf(TrainingSet("set_a", "bench-press", weightKg = 60.0, reps = 8, completedAtMs = 1_000))
        val first = store.keep(rows, "Push A", "rt_receipt", position = 0)
        val retried = store.keep(rows, "Push A", "rt_receipt", position = 0)
        assertEquals(first, retried)
        assertEquals(listOf("rt_receipt"), server.written.keys.toList())
        assertEquals(listOf("rt_receipt"), store.allRoutines.map { it.id })
        assertEquals(listOf(RoutineEntry(exerciseId = "bench-press", position = 1, sets = listOf(SetTarget(8, 60.0)))),
            server.written.getValue("rt_receipt").entries)
    }

    @Test fun anInterruptedKeepCannotClaimADifferentNameUnderItsOriginalIdentity() = runTest {
        val server = FakeTraining()
        val log = object : TrainingSyncing by server {
            override suspend fun createRoutine(write: RoutineWrite): Routine {
                server.createRoutine(write)
                throw IOException("accepted reply lost")
            }
        }
        val store = store(mapOf("a" to log))
        store.connect(account())
        val rows = listOf(TrainingSet("set_a", "bench-press", weightKg = 60.0, reps = 8, completedAtMs = 1_000))
        val kept = store.keep(rows, "Push A", "rt_receipt", position = 0) as GymResult.Ok
        val retry = store.keep(rows, "Push B", "rt_receipt", position = 0)
        assertEquals(GymResult.Failed(WriteFailure.Refused(
            "this save already holds different details — reopen the saved routine to edit it")), retry)
        assertEquals(listOf(kept.value), server.written.values.toList())
        assertEquals(listOf(kept.value), store.allRoutines)
        assertEquals("Push A", kept.value.name)
    }

}
