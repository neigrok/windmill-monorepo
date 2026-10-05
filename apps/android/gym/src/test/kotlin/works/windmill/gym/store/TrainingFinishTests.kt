package works.windmill.gym.store

import java.io.File
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
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
import works.windmill.sync.engine.*

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class TrainingFinishTests {
    @get:Rule val tmp = TemporaryFolder()

    private fun TestScope.store(logs: Map<String, TrainingSyncing>, undoMs: Long = 9_000,
        mintSession: () -> String = { "ses_mine" },
    ): TrainingStore {
        val folder = tmp.newFolder()
        var nextSetId = 0
        return TrainingStore(
        queue = SetQueue(File(folder, "queue")),
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

    @Test fun aDelayedFinishedPageCannotCloseTheNextWorkoutOrReplaceItsOffer() = runTest {
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
        val queueFile = tmp.root.walkTopDown().single { it.name == "queue" }
        val queue = queueFile.readText()
        gate.complete(Unit)
        runCurrent()

        assertEquals("ses_next", live.id)
        assertEquals(live, store.session)
        assertEquals(rows, store.sets)
        assertEquals(notification, store.notification.value)
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
        assertEquals(next, server.stored.getValue(next.id))
        assertEquals(listOf(nextSet), server.sets.getValue(next.id))
    }

    @Test fun aCorrectionFiledDuringTheAppendPatchesItsCanonicalId() = runTest {
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
        val filed = TrainingSet("set_2", "bench-press", null, 60.0, 9, completedAtMs = 1_000)
        assertEquals(FixOutcome.Corrected(filed), store.fixSet("ses_mine", "set_2", SetFix(reps = 9)))
        assertEquals(listOf(filed), store.sets)
        assertTrue(server.fixes.isEmpty())
        gate.complete(Unit)
        append.join()
        runCurrent()
        val expected = TrainingSet("set_canonical", "bench-press", 7, 60.0, 9, completedAtMs = 1_000)
        assertEquals(listOf(Triple("ses_mine", "set_canonical", SetFix(expected))), server.fixes)
        assertEquals(listOf(expected), server.sets.getValue("ses_mine"))
        assertEquals(listOf(expected), store.sets)
        assertEquals(listOf(expected), (store.finish() as FinishOutcome.Closed).detail.sets)
    }

    @Test fun aCorrectionTheLogCannotTakeYetStaysOwedAndLandsOnTheNextWalk() = runTest {
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
        val logged = TrainingSet("set_2", "bench-press", null, 60.0, 8, completedAtMs = 1_000)
        server.refuseFix = { IOException("offline") }
        assertEquals(FixOutcome.Corrected(fix.corrected(logged)), store.fixSet("ses_mine", "set_2", fix))
        gate.complete(Unit)
        append.join()
        runCurrent()
        val stored = TrainingSet("set_2", "bench-press", 1, 60.0, 8, completedAtMs = 1_000)
        assertEquals(listOf(stored), server.sets.getValue("ses_mine"))
        assertEquals(listOf(fix.corrected(stored)), store.sets)
        assertEquals(1, store.strandedCount)
        server.refuseFix = { null }
        store.flushPendingSets()
        assertEquals("every attempt carried the one correction",
            setOf(Triple("ses_mine", "set_2", SetFix(fix.corrected(stored)))), server.fixes.toSet())
        assertEquals(listOf(fix.corrected(stored)), server.sets.getValue("ses_mine"))
        assertEquals(listOf(fix.corrected(stored)), store.sets)
        assertEquals(0, store.strandedCount)
    }

    // A correction still owed keeps the session open: the closed workout is drawn from the log, and
    // a PATCH landing after the finish would race any later fix of the past session.
    @Test fun finishWaitsForAnOwedCorrectionAndTheClosedWorkoutShowsIt() = runTest {
        val server = FakeTraining()
        val store = store(mapOf("a" to server), undoMs = 0)
        store.connect(account())
        store.start()
        store.choose("bench-press")
        store.logSet(60.0, 8)
        val logged = TrainingSet("set_2", "bench-press", 1, 60.0, 8, completedAtMs = 1_000)
        assertEquals(listOf(logged), store.sets)
        server.refuseFix = { IOException("offline") }
        store.fixSet("ses_mine", "set_2", SetFix(reps = 9))
        runCurrent()

        assertEquals(FinishOutcome.Stranded(1), store.finish())
        assertEquals(emptyList<Pair<String, Long>>(), server.finished)
        assertEquals(listOf(logged), server.sets.getValue("ses_mine"))

        server.refuseFix = { null }
        val fixed = logged.copy(reps = 9)
        val closed = store.finish() as FinishOutcome.Closed
        assertEquals(listOf(fixed), closed.detail.sets)
        assertEquals(listOf(fixed), server.sets.getValue("ses_mine"))
        assertEquals(listOf(fixed), (store.sessionDetail("ses_mine") as GymResult.Ok).value.sets)
    }

    @Test fun finishWaitsForAnOwedDeleteAndTheClosedWorkoutLacksTheRow() = runTest {
        val server = FakeTraining()
        val store = store(mapOf("a" to server), undoMs = 0)
        store.connect(account())
        store.start()
        store.choose("bench-press")
        store.logSet(60.0, 8)
        store.logSet(62.5, 6)
        val (kept, deleted) = store.sets
        server.refuseDelete = IOException("offline")
        assertNull(store.deleteSet("ses_mine", deleted.id))
        runCurrent()

        assertEquals(FinishOutcome.Stranded(1), store.finish())
        assertEquals(emptyList<Pair<String, Long>>(), server.finished)
        assertEquals(listOf(kept, deleted), server.sets.getValue("ses_mine"))

        server.refuseDelete = null
        val closed = store.finish() as FinishOutcome.Closed
        assertEquals(listOf(kept), closed.detail.sets)
        assertEquals(listOf(kept), server.sets.getValue("ses_mine"))
        assertEquals(listOf(kept), (store.sessionDetail("ses_mine") as GymResult.Ok).value.sets)
    }

    @Test fun accountChangeDuringAppendDiscardsItsReplyAndSendsNoCorrection() = runTest {
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
        assertEquals(FixOutcome.Corrected(TrainingSet("set_2", "bench-press", null, 60.0, 9, completedAtMs = 1_000)),
            correction.await())
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
        server.online = false
        store.logSet(60.0, 8)
        val live = store.session
        val sets = store.sets
        assertEquals(FinishOutcome.Stranded(1), store.finish())
        assertTrue(server.finished.isEmpty())
        assertEquals(live, store.session)
        assertEquals(sets, store.sets)
    }
    @Test fun aReceiptAlreadyShownKeepsItsIdentityAndDeletionDeadlineDuringEngineDelivery() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            room.workout(60.0)
            val live = room.workout(100.0, "back-squat", finish = false)
            val performed = room.store.sets.single()
            room.engine.releaseHeld(true)
            val pending = room.engine.nextPush()!!
            val finish = async { room.store.finish() }
            runCurrent()
            assertTrue("local finish remains independent of the older push", finish.isCompleted)
            val receipt = (finish.await() as FinishOutcome.Closed).detail
            assertEquals(live.id, receipt.session.id)
            assertEquals(listOf(performed), receipt.sets)
            room.store.withhold(Deletion.Set(live.id, performed))
            val deadline = room.store.withheld.single().untilMs
            val server = EngineRoomFixture.server()
            val response = server.push(pending, works.windmill.sync.modelserver.Credential.Account("alice"), room.now)
            val reading = works.windmill.sync.core.ClockReading(room.now, room.now, "test")
            room.engine.onPushResponse(pending, works.windmill.sync.engine.SyncResponse(response.status, response.body),
                works.windmill.sync.engine.RequestTiming(reading, reading))
            room.sync(server); room.store.refreshEngine()
            val expected = (room.store.sessionDetail(live.id) as GymResult.Ok).value
            assertEquals(receipt.session.id, expected.session.id)
            assertEquals(listOf(performed.id), expected.sets.map { it.id })
            assertEquals(expected, room.store.retainedSession(receipt))
            assertEquals(listOf(WithheldDelete(Deletion.Set(live.id, expected.sets.single()), deadline)), room.store.withheld)
            assertNull(room.store.session)
        }
    }

    @Test fun finishDuringAnEngineIdentityRefusalKeepsTheOriginalReceiptAndExplainsTheFailure() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            val live = room.workout(60.0, finish = false)
            val performed = room.store.sets.single()
            val finish = async { room.store.finish() }
            runCurrent()
            assertTrue(finish.isCompleted)
            val receipt = (finish.await() as FinishOutcome.Closed).detail
            assertEquals(live.id, receipt.session.id)
            assertEquals(listOf(performed), receipt.sets)
            val server = EngineRoomFixture.server()
            server.refuse(code = "id-taken")
            room.sync(server)
            withContext(Dispatchers.IO) { withTimeout(2_000) { room.engine.notices("gym").notices.first { it.isNotEmpty() } } }
            room.store.refreshEngine()
            assertEquals("a refusal never remints the receipt", receipt, room.store.retainedSession(receipt))
            assertTrue(room.store.refusals.isNotEmpty())
            assertTrue("the engine retains the refused original source", room.engine.notices("gym").notices.value.any {
                it.content.command?.args?.get("id") == works.windmill.sync.core.Json.of(live.id)
            })
            assertNull(room.store.session)
        }
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
