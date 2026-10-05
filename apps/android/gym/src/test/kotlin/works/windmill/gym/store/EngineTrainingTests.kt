package works.windmill.gym.store

import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.flow.first
import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import works.windmill.gym.domain.*
import works.windmill.gym.net.FakeTraining
import works.windmill.platform.Account
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException
import works.windmill.sync.api.*
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.engine.Engine
import works.windmill.sync.engine.EngineClock
import works.windmill.sync.engine.signIn
import works.windmill.sync.engine.signOut
import works.windmill.sync.engine.nextPush
import works.windmill.sync.engine.onPushResponse
import works.windmill.sync.engine.onPullResponse
import works.windmill.sync.engine.pullRequest
import works.windmill.sync.engine.SyncResponse
import works.windmill.sync.engine.RequestTiming
import works.windmill.sync.core.ClockReading
import works.windmill.sync.modelserver.ModelServer
import works.windmill.sync.modelserver.GymServerRules
import works.windmill.sync.modelserver.Credential
import works.windmill.platform.User
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema

class EngineTrainingTests {
    @get:Rule val tmp = TemporaryFolder()
    private val now = 1_800_000_000_000L
    private fun engine() = Engine.memory(SyncSchema.registry, clock = object : EngineClock { override fun now() = now })
    private fun seed(engine: Engine, type: String, id: String, fields: Map<String, Json>) {
        val outcome = engine.commit(works.windmill.sync.core.ScopeRef(Gym.scope), Gesture(listOf(
            if (type == Gym.Types.prefs) Change.write(type, RecordID(id), fields)
            else Change.create(type, NewID.Given(RecordID(id)), fields))))
        assertTrue(outcome is CommitOutcome.Committed)
    }
    private fun seedRoutine(engine: Engine) = seed(engine, Gym.Types.routine, "routine1", mapOf(
        "name" to Json.of("Original"), "position" to Json.of(2), "entries" to Json.parse("""[{"exerciseId":"bench-press","sets":[{"reps":8}],"restSeconds":90},{"exerciseId":"back-squat","sets":[{"reps":5,"weightKg":100}],"restSeconds":120},{"exerciseId":"deadlift","restSeconds":60}]""")))

    @Test fun formerNamesRemainSearchableOnThePhoneAndConfirmedRenamesKeepNewestAliasesFirst() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            room.training.createExercise(ExerciseWrite("exercise1", "Original", "pull", "machine"))
            assertEquals(listOf("Original"), room.training.renameExercise("exercise1", "Mine").aliases)
            assertEquals(listOf("Bench Press"), room.training.renameExercise("bench-press", "Phone bench").aliases)
            assertFalse("the signed-out UI keeps its existing promise", room.store.renameKeepsAnAlias("exercise1"))
            room.select("A")
            val server = EngineRoomFixture.server()
            room.sync(server)
            EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
                other.select("A"); other.pull(server)
                other.training.renameExercise("exercise1", "Elsewhere")
                other.sync(server)
            }
            room.pull(server)
            assertEquals(listOf("Mine", "Original"), room.training.exercises().first { it.id == "exercise1" }.aliases)
            room.training.renameExercise("exercise1", "Phone name")
            assertEquals(listOf("Phone name", "Elsewhere", "Mine", "Original"), room.training.renameExercise("exercise1", "Final").aliases)
        }
    }

    @Test fun offlineEngineRowsAndFinishedHistoryKeepDeviceMarkersUntilTheServerConfirmsThem() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("A")
            val tokens = object : works.windmill.sync.engine.SessionTokens {
                override fun token(account: String) = "test"
                override fun save(account: String, token: String) {}
                override fun delete(account: String) {}
                override fun accounts() = setOf("A")
            }
            val transport = object : works.windmill.sync.engine.SyncTransport {
                override suspend fun hello(token: String?) = works.windmill.sync.engine.Reply.Unreachable
                override suspend fun push(request: Json, token: String) = works.windmill.sync.engine.Reply.Unreachable
                override suspend fun pull(request: Json, token: String?) = works.windmill.sync.engine.Reply.Unreachable
                override suspend fun openLive(token: String) = works.windmill.sync.engine.Reply.Unreachable
            }
            works.windmill.sync.engine.SyncRuntime(room.engine, transport, tokens, "test").use { runtime ->
                runtime.connectivity(false)
                withContext(Dispatchers.IO) { withTimeout(2_000) { room.engine.status.state.first { !it.online } } }
                val opened = room.workout(finish = false)
                val set = room.store.sets.single()
                assertEquals(setOf(set.id), room.store.stalled)
                assertEquals(1, room.store.strandedCount)
                assertEquals(Blocker.Offline, room.store.strandedBy)
                assertEquals(SaveState.Blocked(Blocker.Offline), room.store.saveState)
                assertTrue(LiveLines.rows(room.store.sets, room.store.stalled).single().isOnThisDevice)
                assertTrue("offline finish queues its dependent command", room.store.finish() is FinishOutcome.Closed)
                room.store.refreshEngine()
                assertEquals(setOf(opened.id), room.store.deviceOnlySessionIds)
                assertTrue(LogReadout.row(room.store.recent.single(), opened.id in room.store.deviceOnlySessionIds,
                    null, room.store.catalog, room.now, java.time.ZoneId.systemDefault()).onThisDeviceOnly)
                val server = EngineRoomFixture.server()
                room.sync(server); room.store.refreshEngine()
                assertEquals(emptySet<String>(), room.store.deviceOnlySessionIds)
                assertEquals(emptySet<String>(), room.store.stalled)
                assertEquals(SaveState.OnTheLog, room.store.saveState)
                assertNull(room.store.deleteSet(opened.id, set.id))
                assertEquals("a pending tombstone still marks its finished workout", setOf(opened.id), room.store.deviceOnlySessionIds)
                room.sync(server); room.store.refreshEngine()
                assertEquals(emptySet<String>(), room.store.deviceOnlySessionIds)
            }
        }
    }

    private suspend fun proposalFixture(room: EngineRoomFixture, server: ModelServer) {
        room.select("A")
        room.training.createRoutine(RoutineWrite("routine1", "Original", 0,
            listOf(RoutineEntryWrite("bench-press", listOf(SetTarget(5, 80.0))))))
        room.sync(server)
        val runner = works.windmill.domain.kit.ActionRunner(room.engine, room.engine.registry,
            works.windmill.domain.kit.FixedZone(0), object : works.windmill.domain.kit.ActionContext { override var insideRun = false })
        assertTrue(runner.run(works.windmill.gym.domain.sync.ProposeRoutine(
            works.windmill.domain.kit.Id("proposal1", works.windmill.gym.domain.sync.Proposal),
            works.windmill.domain.kit.Id("routine1", works.windmill.gym.domain.sync.Routine), "Proposed",
            listOf(works.windmill.gym.domain.sync.RoutineEntry(works.windmill.domain.kit.Id("bench-press", works.windmill.gym.domain.sync.Exercise),
                listOf(works.windmill.gym.domain.sync.SetTarget(6, 82.5)))), "Progress")) is works.windmill.domain.kit.Outcome.Committed)
        room.sync(server)
    }

    @Test fun deliveryFailureCopyMatchesTheBoundaryAndAStaleAccountCompletionCannotChangeIt() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("A"); room.workout(finish = false)
            val a = room.engine.activeReplica()
            assertTrue(room.training.reportDelivery(a, works.windmill.sync.engine.Reply.Unreachable))
            room.store.refreshEngine()
            assertEquals(Blocker.Offline, room.store.strandedBy)
            assertEquals(SaveState.Blocked(Blocker.Offline), room.store.saveState)
            assertTrue(room.training.reportDelivery(a, works.windmill.sync.engine.Reply.Failed(SyncResponse(503, Json.objectOf()))))
            room.store.refreshEngine()
            assertEquals(Blocker.LogFailed, room.store.strandedBy)
            assertEquals(SaveState.Blocked(Blocker.LogFailed), room.store.saveState)
            assertTrue(room.training.reportDelivery(a, works.windmill.sync.engine.Reply.Answer(SyncResponse(200, Json.objectOf()))))
            room.store.refreshEngine()
            assertNull(room.store.strandedBy)
            assertEquals(SaveState.OnThisDevice, room.store.saveState)
            room.select("B"); room.workout(finish = false)
            val b = room.engine.activeReplica()
            room.training.reportDelivery(b, works.windmill.sync.engine.Reply.Failed(SyncResponse(401, Json.objectOf())))
            assertFalse(room.training.reportDelivery(a, works.windmill.sync.engine.Reply.Answer(SyncResponse(200, Json.objectOf()))))
            assertFalse(room.training.reportDelivery(a, works.windmill.sync.engine.Reply.Unreachable))
            room.store.refreshEngine()
            assertEquals(Blocker.SignInLapsed, room.store.strandedBy)
            assertEquals(SaveState.Blocked(Blocker.SignInLapsed), room.store.saveState)
        }
    }

    @Test fun aRealHttp503And401DisplayTheSameDeliveryFailureAsFailedReplies() = runTest {
        val server = MockWebServer()
        server.start()
        try {
            works.windmill.sync.engine.HTTPTransport(server.url("/").toString(), SyncSchema.registry.version.toInt()).use { http ->
                EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
                    room.select("A"); room.workout(finish = false)
                    val request = checkNotNull(room.engine.nextPush())
                    for ((status, blocker) in listOf(503 to Blocker.LogFailed, 401 to Blocker.SignInLapsed)) {
                        server.enqueue(MockResponse().setResponseCode(status).setBody("{}"))
                        val reply = http.push(request, "test")
                        val response = (reply as works.windmill.sync.engine.Reply.Answer<SyncResponse>).value
                        assertEquals(status, response.status)
                        assertEquals("/v1/sync/push", server.takeRequest().path)
                        assertTrue(room.training.reportDelivery(room.engine.activeReplica(), reply))
                        room.store.refreshEngine()
                        assertEquals(blocker, room.store.strandedBy)
                        assertEquals(SaveState.Blocked(blocker), room.store.saveState)
                        assertTrue(room.training.reportDelivery(room.engine.activeReplica(), works.windmill.sync.engine.Reply.Failed(response)))
                        room.store.refreshEngine()
                        assertEquals(SaveState.Blocked(blocker), room.store.saveState)
                    }
                }
            }
        } finally { server.shutdown() }
    }

    @Test fun settlingAMigratedAttemptedAppendPreservesConfirmedMutableFieldsUnlessAFixIsOwed() = runTest {
        for (correcting in listOf(false, true)) {
            val server = EngineRoomFixture.server()
            EngineRoomFixture(tmp.newFolder(), backgroundScope).use { remote ->
                remote.select("A")
                val opened = remote.workout(finish = false)
                remote.sync(server)
                val original = remote.training.session(opened.id)!!.sets.single()
                val corrected = remote.training.fixSet(opened.id, original.id,
                    SetFix(weightKg = 95.0, reps = 8, kind = SetKind.Warmup, rpeNamed = true, rpe = 9.0, note = "Server correction"))
                remote.sync(server)
                val directory = tmp.newFolder()
                val queue = SetQueue(File(directory, SetQueue.fileName), "A")
                queue.hold(opened, unclaimed = false)
                queue.store(original, opened.id, needsPush = true)
                queue.sending(queue.pending.single())
                val requested = original.copy(weightKg = 85.0, reps = 6, rpe = 7.5, note = "Explicit correction")
                if (correcting) queue.fix(requested)
                EngineRoomFixture(directory, backgroundScope).use { local ->
                    LegacyGymMigration(directory, local.engine, "A").run()
                    local.selected = "A"
                    local.pull(server)
                    val born = local.engine.read(LegacyGymMigration.scope) { it.confirmed(Gym.Types.set, RecordID(original.id))!!.born }
                    local.training.reconcileLegacyOperations()
                    val expected = if (correcting) requested else corrected
                    assertEquals(expected, local.training.session(opened.id)!!.sets.single())
                    local.sync(server)
                    assertEquals(expected, local.training.session(opened.id)!!.sets.single())
                    assertEquals(born, local.engine.read(LegacyGymMigration.scope) { it.confirmed(Gym.Types.set, RecordID(original.id))!!.born })
                    assertTrue(LegacyGymMigration.operations(local.engine).isEmpty())
                }
            }
        }
    }

    @Test fun aMigratedPendingDeleteNeverReappearsInTheOfflineWorkoutProjection() = runTest {
        val directory = tmp.newFolder()
        val session = Session("legacy01", now - 1_000)
        val removed = TrainingSet("gone0001", "bench-press", weightKg = 82.5, reps = 5, completedAtMs = now)
        SetQueue(File(directory, SetQueue.fileName), "A").apply {
            hold(session, unclaimed = true)
            store(removed, session.id, needsPush = false)
            delete(removed.id)
        }
        EngineRoomFixture(directory, backgroundScope).use { local ->
            LegacyGymMigration(directory, local.engine, "A").run()
            local.selected = "A"
            local.store.connect(local.account())
            assertEquals(session, local.store.session)
            assertEquals(emptyList<TrainingSet>(), local.store.sets)
            assertEquals(emptyList<TrainingSet>(), local.training.session(session.id)!!.sets)
            assertEquals(Owed.Delete, LegacyGymMigration.operations(local.engine).single().entry.write)
            assertEquals(removed, LegacyGymMigration.operations(local.engine).single().entry.set)
        }
    }

    @Test fun ownedPlannedMigrationCanLogAFourthSetAndFinishOfflineThenResumeOneStrictImport() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { remote ->
            remote.select("A")
            val routine = remote.training.createRoutine(RoutineWrite("routine1", "Original", 0,
                entries = listOf(RoutineEntryWrite("bench-press", listOf(SetTarget(5, 82.5))))))
            val otherOpen = remote.training.startSession(SessionStart("remote01", remote.now))
            remote.training.appendSet(otherOpen.id, SetWrite("remoteSet1", "bench-press", 82.5, 5, SetKind.Working, remote.now))
            remote.now += 60_000
            remote.sync(server)
            val directory = tmp.newFolder()
            val savedSession = Session("legacy01", remote.now - 4_000, routineId = routine.id, plan = PlanSnapshot(routine))
            val originalSets = (1..3).map { index -> TrainingSet("original$index", "bench-press",
                weightKg = 82.5, reps = 5, completedAtMs = savedSession.startedAtMs + index * 1_000) }
            val legacy = SetQueue(File(directory, SetQueue.fileName), "A")
            legacy.hold(savedSession, unclaimed = true)
            originalSets.forEach { legacy.store(it, savedSession.id, needsPush = true) }
            val attempted = legacy.sending(legacy.pending.first())
            DeviceCopy(File(directory, DeviceCopy.fileName)).apply {
                hold("A", TheSix.movements)
                holdRoutines("A", listOf(routine))
            }
            val snapshot: Json
            val closed: SessionDetail
            EngineRoomFixture(directory, backgroundScope).use { local ->
                local.now = remote.now
                LegacyGymMigration(directory, local.engine, "A").run()
                local.selected = "A"
                local.store.connect(local.account())
                assertEquals(savedSession, local.store.session)
                assertEquals(originalSets, local.store.sets)
                assertTrue(local.outbox().isEmpty())
                local.store.choose("bench-press")
                local.store.logSet(85.0, 6)
                assertEquals(4, local.store.sets.size)
                assertEquals(originalSets, local.store.sets.take(3))
                assertTrue(local.outbox().isEmpty())
                assertEquals(attempted, LegacyGymMigration.operations(local.engine).first { it.entry.set.id == attempted.set.id }.entry)
                closed = (local.store.finish() as FinishOutcome.Closed).detail
                assertEquals(savedSession.plan, closed.session.plan)
                assertEquals(4, closed.sets.size)
                assertTrue(local.outbox().isEmpty())
                snapshot = local.engine.snapshot()
                runCurrent()
            }
            EngineRoomFixture(directory, backgroundScope, snapshot).use { restarted ->
                restarted.now = closed.session.finishedAtMs!! + 1_000
                restarted.selected = "A"
                restarted.store.connect(restarted.account())
                assertEquals(closed, restarted.training.session(savedSession.id))
                assertTrue(restarted.outbox().isEmpty())
                restarted.pull(server)
                restarted.training.reconcileLegacyOperations()
                val command = restarted.outbox().single().member("intent").member("cmd")
                assertEquals("gym.importSession", command.member("name").str())
                assertEquals(closed.sets.map { it.id }, command.member("args").member("sets").arr().map { it.member("id").str() })
                restarted.sync(server)
                assertNotNull("import refusals=${LegacyGymMigration.refusals(restarted.engine)}; notices=${restarted.engine.notices("gym").notices.value}; outbox=${restarted.outbox()}",
                    restarted.engine.read(LegacyGymMigration.scope) { it.confirmed(Gym.Types.session, RecordID(savedSession.id)) })
                val confirmed = restarted.training.session(savedSession.id)!!
                assertEquals(closed.session, confirmed.session)
                assertEquals(closed.sets.mapIndexed { index, set -> set.copy(setNumber = index + 1) }, confirmed.sets)
                assertTrue(restarted.training.session(otherOpen.id)!!.session.isOpen)
            }
        }
    }

    @Test fun deletingACachedMigratedWeighInBeforePullSurvivesRestartAndRemovesTheServerRow() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { remote ->
            remote.select("A")
            val weight = remote.training.putBodyweight("2026-01-01", WeighInWrite(70.0, remote.now))
            remote.sync(server)
            val directory = tmp.newFolder()
            LocalBodyweight(File(directory, LocalBodyweight.fileName), "A").apply { record(weight); landed(weight) }
            val snapshot: Json
            EngineRoomFixture(directory, backgroundScope).use { local ->
                LegacyGymMigration(directory, local.engine, "A").run()
                assertFalse(local.training.firstPullComplete)
                assertEquals(listOf(weight), local.training.bodyweight(null, null))
                local.training.deleteBodyweight(weight.dateLocal)
                assertEquals(emptyList<WeighIn>(), local.training.bodyweight(null, null))
                snapshot = local.engine.snapshot()
            }
            EngineRoomFixture(directory, backgroundScope, snapshot).use { restarted ->
                restarted.selected = "A"
                assertEquals(emptyList<WeighIn>(), restarted.training.bodyweight(null, null))
                restarted.pull(server)
                restarted.training.reconcileLegacyOperations()
                assertEquals(emptyList<WeighIn>(), restarted.training.bodyweight(null, null))
                restarted.sync(server)
                assertEquals(emptyList<WeighIn>(), restarted.training.bodyweight(null, null))
                remote.pull(server)
                assertEquals(emptyList<WeighIn>(), remote.training.bodyweight(null, null))
            }
        }
    }

    @Test fun replacingACachedWeighInDeletionResolvesItInTheSameCommitAndSurvivesReconnect() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { remote ->
            remote.select("A")
            val original = remote.training.putBodyweight("2026-01-01", WeighInWrite(70.0, remote.now))
            remote.sync(server)
            val directory = tmp.newFolder()
            LocalBodyweight(File(directory, LocalBodyweight.fileName), "A").apply { record(original); landed(original) }
            val snapshot: Json
            val replacement: WeighIn
            EngineRoomFixture(directory, backgroundScope).use { local ->
                LegacyGymMigration(directory, local.engine, "A").run()
                local.training.deleteBodyweight(original.dateLocal)
                val before = local.engine.snapshot()
                local.engine.failNextCommit()
                try { local.training.putBodyweight(original.dateLocal, WeighInWrite(80.0, local.now)); fail("A failed save must keep the cached deletion.") }
                catch (_: CommitFailure) {}
                assertEquals(before, local.engine.snapshot())
                assertEquals(emptyList<WeighIn>(), local.training.bodyweight(null, null))
                replacement = local.training.putBodyweight(original.dateLocal, WeighInWrite(80.0, local.now))
                assertTrue(LegacyGymMigration.edits(local.engine).isEmpty())
                snapshot = local.engine.snapshot()
            }
            EngineRoomFixture(directory, backgroundScope, snapshot).use { restarted ->
                restarted.selected = "A"
                assertEquals(listOf(replacement), restarted.training.bodyweight(null, null))
                restarted.pull(server); restarted.training.reconcileLegacyOperations(); restarted.sync(server)
                assertEquals(listOf(replacement), restarted.training.bodyweight(null, null))
                remote.pull(server)
                assertEquals(listOf(replacement), remote.training.bodyweight(null, null))
            }
        }
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test fun proposalDecisionsReturnOnlyTheConfirmedServerReceiptAndLeaveTheCardWhileWaiting() = runTest {
        for (applying in listOf(false, true)) EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val server = EngineRoomFixture.server(); proposalFixture(room, server)
            val decision = async { if (applying) room.training.applyProposal("proposal1") else room.training.dismissProposal("proposal1") }
            runCurrent()
            assertFalse("a local prediction is not a receipt", decision.isCompleted)
            assertEquals(ProposalState.Pending, room.training.proposal("proposal1")!!.state)
            assertEquals("Original", room.training.routine("routine1")!!.name)
            assertEquals("proposal1", room.training.routine("routine1")!!.pendingProposal!!.id)
            room.now += 1_000; room.sync(server); advanceTimeBy(25); runCurrent()
            val receipt = decision.await()
            assertEquals(if (applying) ProposalState.Applied else ProposalState.Dismissed, receipt.proposal.state)
            assertEquals(room.now, receipt.proposal.settledAtMs)
            assertEquals(if (applying) "Proposed" else "Original", receipt.routine!!.name)
        }
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test fun proposalRefusalNeverReportsThePredictedReceiptOrChangesTheConfirmedRoutine() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val server = EngineRoomFixture.server(); proposalFixture(room, server)
            val decision = async { runCatching { room.training.applyProposal("proposal1") } }
            runCurrent(); server.refuse(code = "stale"); room.sync(server)
            withContext(Dispatchers.IO) { withTimeout(2_000) { room.engine.notices("gym").notices.first { it.isNotEmpty() } } }
            advanceTimeBy(25); runCurrent()
            assertTrue(decision.await().exceptionOrNull() is WindmillApiException.Refused)
            assertEquals(ProposalState.Pending, room.training.proposal("proposal1")!!.state)
            assertEquals("Original", room.training.routine("routine1")!!.name)
        }
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test fun proposalTimeoutCancellationAndAccountChangeCannotInventAReceiptOrLoseThePendingIntent() = runTest {
        for (ending in listOf("timeout", "cancel", "account")) EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val server = EngineRoomFixture.server(); proposalFixture(room, server)
            val decision = async { runCatching { room.training.dismissProposal("proposal1") } }
            runCurrent()
            val queued = room.outbox()
            when (ending) {
                "cancel" -> { decision.cancelAndJoin(); assertTrue(decision.isCancelled) }
                "account" -> { room.select(null); advanceTimeBy(25); runCurrent(); assertTrue(decision.await().exceptionOrNull() is WindmillApiException.Refused) }
                else -> { advanceTimeBy(15_001); runCurrent(); assertTrue(decision.await().exceptionOrNull() is WindmillApiException.Offline) }
            }
            assertEquals(queued, room.outbox())
            if (ending != "account") {
                assertEquals(ProposalState.Pending, room.training.proposal("proposal1")!!.state)
                assertEquals("Original", room.training.routine("routine1")!!.name)
            } else assertNull(room.training.proposal("proposal1"))
        }
    }

    @Test fun routineEditsPreserveUnownedFieldsByMovementWhileTargetsAndOrderComeFromTheDraft() = runBlocking {
        engine().use { engine ->
            seedRoutine(engine)
            val gym = EngineTraining(engine) { null }
            val saved = gym.replaceRoutine("routine1", RoutineWrite("routine1", "Reordered", 0, listOf(
                RoutineEntryWrite("back-squat"), RoutineEntryWrite("bench-press", listOf(SetTarget(6, 80.0))), RoutineEntryWrite("chin-up", listOf(SetTarget(10))),
            )))
            assertEquals(listOf(RoutineEntry(1, "back-squat"), RoutineEntry(2, "bench-press", listOf(SetTarget(6, 80.0))), RoutineEntry(3, "chin-up", listOf(SetTarget(10)))), saved.entries)
            engine.read(works.windmill.sync.core.ScopeRef(Gym.scope)) { reader ->
                val entries = reader.drawn(Gym.Types.routine, RecordID("routine1"))!!.values.getValue("entries").arr()
                assertEquals(Json.of(120), entries[0]["restSeconds"])
                assertEquals(Json.of(90), entries[1]["restSeconds"])
                assertNull(entries[2]["restSeconds"])
            }
        }
    }
    @Test fun routineEditsNeverAcquireARevisionFromThePreservationRead() = runBlocking {
        engine().use { engine ->
            seedRoutine(engine)
            val gym = EngineTraining(engine) { null }
            gym.replaceRoutine("routine1", RoutineWrite("routine1", "Renamed", 0, listOf(RoutineEntryWrite("back-squat"))))
            val outbox = engine.snapshot().member("replicas").arr().first().member("outbox").arr()
            assertTrue(outbox.all { it["guards"] == null || it["guards"]!!.arr().none { guard -> guard["field"] == Json.of("revision") } })
            assertEquals("Renamed", gym.routine("routine1")!!.name)
        }
    }
    @Test fun aFailedRoutinePreservationReadNeverSendsAReplacement() = runBlocking {
        engine().use { engine ->
            seedRoutine(engine)
            val gym = EngineTraining(engine) { null }
            engine.failNextCommit()
            try { gym.replaceRoutine("routine1", RoutineWrite("routine1", "Changed", 0, listOf(RoutineEntryWrite("back-squat")))); fail("Must preserve the existing routine when storage fails.") }
            catch (_: CommitFailure) {}
            assertEquals("Original", gym.routine("routine1")!!.name)
        }
    }
    @Test fun unitWritesPreserveTheFreshServerDocumentIncludingUnownedFields() = runBlocking {
        engine().use { engine ->
            seed(engine, Gym.Types.prefs, "prefs", mapOf("units" to Json.of("kg"), "restSeconds" to Json.of(180), "restSound" to Json.of(true)))
            val gym = EngineTraining(engine) { null }
            assertEquals(GymPreferences(), gym.preferences())
            assertEquals(GymPreferences(units = Units.Pounds), gym.savePreferences(GymPreferences(units = Units.Pounds)))
            assertEquals(GymPreferences(), gym.savePreferences(GymPreferences()))
            engine.read(works.windmill.sync.core.ScopeRef(Gym.scope)) { reader ->
                val prefs = reader.drawn(Gym.Types.prefs, RecordID("prefs"))!!
                assertEquals(Json.of(180), prefs.values["restSeconds"])
                assertEquals(Json.of(true), prefs.values["restSound"])
            }
        }
    }
    @Test fun aFailedPreferenceReadCannotReplaceTheServerDocumentWithDefaults() = runBlocking {
        engine().use { engine ->
            val gym = EngineTraining(engine) { null }
            gym.savePreferences(GymPreferences(units = Units.Pounds))
            engine.failNextCommit()
            try { gym.savePreferences(GymPreferences()); fail("Storage must preserve the saved preferences.") } catch (_: CommitFailure) {}
            assertEquals(GymPreferences(units = Units.Pounds), gym.preferences())
        }
    }
    @Test fun anonymousWorkoutIsDurableInTheEngineWithoutRestAndAllIdsSurviveRestore() = runBlocking {
        val original = engine()
        val gym = EngineTraining(original) { error("Gym data must not call REST.") }
        gym.startSession(SessionStart("session1", now - 10_000, joinOpenSession = false))
        gym.appendSet("session1", SetWrite("set00001", "back-squat", 80.0, 5, SetKind.Working, now - 9_000))
        gym.finishSession("session1", now - 5_000)
        val snapshot = original.snapshot()
        original.close()
        Engine.memory(SyncSchema.registry, snapshot, clock = object : EngineClock { override fun now() = now }).use { engine ->
            val restored = EngineTraining(engine) { null }
            assertEquals(Session("session1", now - 10_000, now - 5_000), restored.session("session1")!!.session)
            assertEquals(listOf(TrainingSet("set00001", "back-squat", weightKg = 80.0, reps = 5, completedAtMs = now - 9_000)), restored.session("session1")!!.sets)
        }
    }
    @Test fun ambiguousAppendReplaysTheExistingIdBeforeApplyingCorrectionAndDeletion() = runBlocking {
        engine().use { engine ->
            val gym = EngineTraining(engine) { null }
            gym.startSession(SessionStart("session1", now - 10_000))
            val write = SetWrite("set00001", "back-squat", 80.0, 5, SetKind.Working, now - 9_000)
            gym.appendSet("session1", write)
            val beforeCollision = engine.snapshot()
            for ((session, collision) in listOf("session2" to write, "session1" to write.copy(exerciseId = "bench-press"),
                "session1" to write.copy(completedAt = now - 8_000))) {
                try { gym.appendSet(session, collision); fail("A set identity cannot acquire another immutable origin.") }
                catch (failure: WindmillApiException.Refused) {
                    assertEquals(409, failure.status)
                    assertEquals("set-id-taken", failure.refusal.code)
                    assertEquals("that set id is already used", failure.refusal.message)
                }
                assertEquals(beforeCollision, engine.snapshot())
            }
            gym.fixSet("session1", write.id, SetFix(weightKg = 82.5, rpeNamed = true, rpe = 8.5, note = "felt heavy"))
            assertEquals(82.5, gym.appendSet("session1", write).weightKg, 0.0)
            val fixed = gym.fixSet("session1", write.id, SetFix(rpeNamed = true, rpe = null, note = ""))
            assertNull(fixed.rpe)
            assertEquals("", fixed.note)
            gym.deleteSet("session1", write.id)
            assertEquals(emptyList<TrainingSet>(), gym.session("session1")!!.sets)
        }
    }
    @Test fun explicitStartRefusesAndMigrationStartJoinsTheOpenWorkout() = runBlocking {
        engine().use { engine ->
            val gym = EngineTraining(engine) { null }
            gym.startSession(SessionStart("session1", now - 10_000, joinOpenSession = false))
            try { gym.startSession(SessionStart("session2", now - 9_000, joinOpenSession = false)); fail("An explicit start must refuse an already open workout.") }
            catch (failure: WindmillApiException.Refused) { assertEquals("session-already-open", failure.refusal.code) }
            assertEquals("session1", gym.startSession(SessionStart("session2", now - 9_000, joinOpenSession = true)).id)
        }
    }
    @Test fun cursorUsesBothHalvesAndWarmupsDoNotBecomeLastTimeOrProgress() = runBlocking {
        engine().use { engine ->
            val gym = EngineTraining(engine) { null }
            for (id in listOf("session1", "session2")) {
                gym.startSession(SessionStart(id, now - 10_000))
                gym.appendSet(id, SetWrite("set0000" + id.last(), "back-squat", 80.0, 5, if (id == "session1") SetKind.Warmup else SetKind.Working, now - 9_000))
                gym.finishSession(id, now - 5_000)
            }
            assertEquals(listOf("session2"), gym.sessions(1, null, null).map { it.id })
            assertEquals(listOf("session1"), gym.sessions(50, now - 10_000, "session2").map { it.id })
            assertEquals("session2", gym.lastTime("back-squat").session!!.id)
            assertEquals(listOf("session2"), gym.progress().sessions.map { it.sessionId })
        }
    }
    @Test fun notesReorderAtomicallyAndWeighinsKeepTheNewerRecordedAt() = runBlocking {
        engine().use { engine ->
            val gym = EngineTraining(engine) { null }
            gym.writeNote("note0001", NoteWrite("One", "First"))
            gym.writeNote("note0002", NoteWrite("Two", "Second"))
            val before = engine.snapshot().jcs
            try { gym.reorderNotes(listOf("note0001")); fail("An order must name every note.") } catch (_: WindmillApiException.Refused) {}
            assertEquals(before, engine.snapshot().jcs)
            assertEquals(listOf("note0002", "note0001"), gym.reorderNotes(listOf("note0002", "note0001")).map { it.id })
            gym.putBodyweight("2026-01-01", WeighInWrite(70.0, now - 1))
            assertEquals(WeighIn("2026-01-01", 70.0, now), gym.putBodyweight("2026-01-01", WeighInWrite(80.0, now - 2)))
        }
    }
    @Test fun readoutsPreserveRecordsAndFrozenPlanComparison() {
        fun detail(id: String, at: Long, kg: Double) = SessionDetail(Session(id, at, at + 100, "routine1", PlanSnapshot("Frozen", listOf(PlanEntry("back-squat", listOf(SetTarget(5, 80.0)))))),
            (1..4).map { TrainingSet("set$id$it", "back-squat", weightKg = kg, reps = 5, completedAtMs = at + it) })
        val earlier = detail("session1", 1000, 80.0)
        val later = detail("session2", 2000, 90.0)
        val review = EngineReadouts.review(later, listOf(earlier, later))
        assertEquals("e1rm", review.record!!.kind)
        assertEquals("session1", review.against!!.sessionId)
        assertEquals(PlannedLine(listOf(SetTarget(5, 80.0))), review.against!!.movements.single().planned)
        assertTrue(EngineReadouts.summary(later, listOf(earlier, later)).record)
        val record = EngineReadouts.record(TheSix.movements.first(), listOf(earlier, later), emptyList(), 3000)
        assertEquals(105.0, record.bestE1rm!!.e1rm!!, 0.0)
        assertEquals(listOf(RecordMark(90.0, 5, 2000, 105.0)), record.records)
    }
    @Test fun trainingStoreUsesEngineForAnonymousAndNotificationLogThenFinish() = runTest {
        engine().use { engine ->
            val gym = EngineTraining(engine) { null }
            var nextSet = 0
            val store = TrainingStore(SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "copy")), LocalLog(File(tmp.root, "log")),
                LocalPreferences(File(tmp.root, "preferences")), LocalBodyweight(File(tmp.root, "weight")), backgroundScope,
                now = { now - 9_000 }, mintSession = { "session1" }, mintSet = { "set0000${++nextSet}" }, sync = { gym }, engineTraining = gym)
            val account = Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }), user = null)
            store.connect(account)
            assertTrue(store.start() is GymResult.Ok)
            store.choose("back-squat")
            store.logSet(80.0, 5)
            assertEquals(1, gym.session("session1")!!.sets.size)
            assertTrue(store.finish() is FinishOutcome.Closed)
            assertFalse(gym.session("session1")!!.session.isOpen)
        }
    }
    @Test fun migratedAccountCacheStartsItsFrozenRoutineAndLogsItsCustomMovementOfflineBeforeFirstPull() = runBlocking {
        engine().use { engine ->
            val custom = Exercise("exercise1", "Cable curl", equipment = "machine", stepKg = 5.0, custom = true)
            val routine = Routine("routine1", "Frozen", entries = listOf(RoutineEntry(1, custom.id, listOf(SetTarget(8, 20.0)))))
            val directory = File(tmp.root, "cached").also { it.mkdirs() }
            val copy = DeviceCopy(File(directory, DeviceCopy.fileName))
            copy.hold("A", listOf(custom))
            copy.holdRoutines("A", listOf(routine))
            LegacyGymMigration(directory, engine, "A").run()
            val gym = EngineTraining(engine) { error("Offline gym data cannot use REST.") }
            assertFalse(gym.firstPullComplete)
            assertEquals(routine, gym.routine(routine.id))
            val session = gym.startSession(SessionStart("session1", now - 10_000, routine.id, false))
            assertEquals(PlanSnapshot(routine), session.plan)
            val set = gym.appendSet(session.id, SetWrite("set00001", custom.id, 20.0, 8, SetKind.Working, now - 9_000))
            assertEquals(custom.id, set.exerciseId)
            assertEquals(listOf(set), gym.session(session.id)!!.sets)
            engine.read(works.windmill.sync.core.ScopeRef(Gym.scope)) { read ->
                assertNull(read.stored(Gym.Types.exercise, RecordID(custom.id)))
                assertNull(read.stored(Gym.Types.routine, RecordID(routine.id)))
            }
        }
    }
    @Test fun cachedAccountEditsPersistWithoutInventingBornAndApplyAfterTheFirstRealPull() = runBlocking {
        val server = EngineRoomFixture.server()
        val credential = Credential.Account("A")
        val reading = ClockReading(now, now, "boot")
        val scope = works.windmill.sync.core.ScopeRef(Gym.scope)
        fun pull(engine: Engine) {
            val request = engine.pullRequest(listOf(scope))!!
            val reply = server.pull(request, credential, now)
            engine.onPullResponse(request, SyncResponse(reply.status, reply.body), RequestTiming(reading, reading))
        }
        fun push(engine: Engine) {
            while (true) {
                val request = engine.nextPush() ?: break
                val reply = server.push(request, credential, now)
                assertEquals(200, reply.status)
                engine.onPushResponse(request, SyncResponse(reply.status, reply.body), RequestTiming(reading, reading))
                pull(engine)
            }
        }
        engine().use { remote ->
            val source = EngineTraining(remote) { null }
            source.createExercise(ExerciseWrite("exercise1", "Old name", "isolation", "machine"))
            source.createRoutine(RoutineWrite("routine1", "Old routine", 0, entries = listOf(RoutineEntryWrite("exercise1", listOf(SetTarget(8, 20.0))))))
            remote.signIn("A", emptyMap()); push(remote)
            val directory = File(tmp.root, "cached-edits").also { it.mkdirs() }
            val copy = DeviceCopy(File(directory, DeviceCopy.fileName))
            copy.hold("A", source.exercises()); copy.holdRoutines("A", source.routines())
            val original = File(directory, DeviceCopy.fileName).readText()
            var snapshot: Json
            engine().use { local ->
                LegacyGymMigration(directory, local, "A").run()
                val gym = EngineTraining(local) { null }
                gym.renameExercise("exercise1", "New name")
                gym.replaceRoutine("routine1", RoutineWrite(gym.routine("routine1")!!).copy(name = "New routine"))
                assertEquals("New name", gym.exercises().first { it.id == "exercise1" }.name)
                assertEquals(listOf("Old name"), gym.exercises().first { it.id == "exercise1" }.aliases)
                assertEquals("New routine", gym.routine("routine1")!!.name)
                assertEquals(2, LegacyGymMigration.edits(local).size)
                local.read(scope) { assertNull(it.stored(Gym.Types.exercise, RecordID("exercise1"))); assertNull(it.stored(Gym.Types.routine, RecordID("routine1"))) }
                snapshot = local.snapshot()
            }
            Engine.memory(SyncSchema.registry, snapshot, clock = object : EngineClock { override fun now() = now }).use { local ->
                val gym = EngineTraining(local) { null }
                assertEquals("New routine", gym.routine("routine1")!!.name)
                pull(local)
                val born = local.read(scope) { it.stored(Gym.Types.exercise, RecordID("exercise1"))!!.born }
                gym.reconcileLegacyOperations(); push(local)
                assertEquals(emptyList<LegacyEdit>(), LegacyGymMigration.edits(local))
                assertEquals("New routine", gym.routine("routine1")!!.name)
                assertEquals("New name", gym.exercises().first { it.id == "exercise1" }.name)
                assertEquals(born, local.read(scope) { it.stored(Gym.Types.exercise, RecordID("exercise1"))!!.born })
            }
            assertEquals(original, File(directory, DeviceCopy.fileName).readText())
        }
    }

    @Test fun cachedLastSetsKeepRememberedEffortAndAnUnreadAccountDoesNotClaimNeverLogged() = runBlocking {
        for (answered in listOf(false, true)) engine().use { engine ->
            val directory = File(tmp.root, "last-set-$answered").also { it.mkdirs() }
            val copy = DeviceCopy(File(directory, DeviceCopy.fileName))
            copy.hold("A", TheSix.movements)
            val remembered = LastSet("bench-press", 82.5, 5, now - 100_000)
            if (answered) copy.holdLastSets("A", listOf(remembered))
            LegacyGymMigration(directory, engine, "A").run()
            val gym = EngineTraining(engine) { null }
            if (answered) assertEquals(listOf(remembered), gym.lastSets()) else {
                try { gym.lastSets(); fail("An unread cache cannot say never logged.") } catch (_: WindmillApiException.Offline) {}
            }
            try { gym.lastTime("bench-press"); fail("A summary cache cannot invent the last workout.") } catch (_: WindmillApiException.Offline) {}
            try { gym.sessions(50, null, null); fail("An unread account cannot say first workout.") } catch (_: WindmillApiException.Offline) {}
        }
    }
    @Test fun addAndDiscardThenKeepSignoutCannotResurrectAnOldAnonymousMirror() = runTest {
        for (choice in listOf("add", "discard")) engine().use { engine ->
            val gym = EngineTraining(engine) { null }
            val directory = File(tmp.root, choice).also { it.mkdirs() }
            var nextSet = 0
            val store = TrainingStore(SetQueue(File(directory, "queue")), DeviceCopy(File(directory, "copy")), LocalLog(File(directory, "log")),
                LocalPreferences(File(directory, "preferences")), LocalBodyweight(File(directory, "weight")), backgroundScope,
                now = { now - 9_000 }, mintSession = { "session1" }, mintSet = { "set0000${++nextSet}" }, sync = { gym }, engineTraining = gym)
            val api = WindmillApi("https://windmill.works".toHttpUrl(), { null })
            store.connect(Account(api, null))
            store.start()
            store.choose("back-squat")
            val offer = store.notification.value!!.offer!!
            assertTrue(store.acceptSet(LogSetCommand(offer.key, offer.id), scheduleDelivery = false) is LogSetAcceptance.Accepted)
            assertEquals(1, gym.session("session1")!!.sets.size)
            store.prepareEngineTransition()
            engine.signIn("A", mapOf("gym" to true), mapOf("gym" to choice))
            store.connect(Account(api, User("A", "a@example.com")))
            if (choice == "add") assertEquals("session1", store.session!!.id) else assertNull(store.session)
            store.prepareEngineTransition()
            engine.signOut("keep")
            store.connect(Account(api, null))
            assertNull(store.session)
            assertEquals(emptyList<SessionSummary>(), store.allSessions)
            store.flushPendingSets()
            assertEquals(emptyList<SessionDetail>(), gym.details())
        }
    }
    @Test fun productionActionContextCopiesNestingAcrossHopsAndIsolatesIndependentEntriesAfterCancel() = runBlocking {
        engine().use { engine ->
            val gym = EngineTraining(engine) { null }
            withGymActionContext { parent ->
                parent.insideRun = true
                try {
                    withContext(Dispatchers.Default) {
                        assertTrue(kotlin.coroutines.coroutineContext[GymActionContext]!!.insideRun)
                        try { gym.createExercise(ExerciseWrite("exercise1", "One", "isolation", "barbell")); fail("A nested action must be refused.") }
                        catch (_: IllegalStateException) {}
                    }
                    coroutineScope {
                        async { withGymActionContext { child -> assertNotSame(parent, child); assertTrue(child.insideRun) } }.await()
                    }
                } finally { parent.insideRun = false }
            }
            coroutineScope {
                val cancelled = launch { withGymActionContext { it.insideRun = true; try { awaitCancellation() } finally { it.insideRun = false } } }
                yield()
                gym.createExercise(ExerciseWrite("exercise1", "One", "isolation", "barbell"))
                cancelled.cancelAndJoin()
                async(Dispatchers.Default) { gym.createExercise(ExerciseWrite("exercise2", "Two", "isolation", "bodyweight")) }.await()
            }
            withGymActionContext { assertFalse(it.insideRun) }
            assertEquals(listOf("exercise1", "exercise2"), gym.exercises().filter { it.custom }.map { it.id }.sorted())
        }
    }

    @Test fun reviewPriorMarksUseCompletedTimeAcrossMidnightAndRecordProgramsKeepPositionOrder() {
        val midnight = 1_800_057_600_000L
        fun detail(id: String, started: Long, completed: Long, load: Double, count: Int = 1) = SessionDetail(
            Session(id, started, completed + 1, "routine1", PlanSnapshot("Frozen", listOf(PlanEntry("bench-press", listOf(SetTarget(5, load)))))),
            (0 until count).map { TrainingSet("set$id$it", "bench-press", it + 1, load, 5, SetKind.Working, null, "", completed + it) })
        val first = detail("session1", midnight - 30_000, midnight + 20_000, 100.0)
        val tied = detail("session2", midnight - 10_000, midnight + 10_000, 100.0)
        val today = detail("session3", midnight + 60_000, midnight + 70_000, 110.0, 5)
        val history = listOf(today, first, tied)
        val review = EngineReadouts.review(today, history)
        assertEquals(midnight + 10_000, review.record!!.previousAtMs)
        assertEquals("e1rm", review.record!!.kind)
        assertEquals("Frozen", review.against!!.routine)
        val programs = listOf(Routine("routine2", "Second", 2, midnight + 60_000,
            listOf(RoutineEntry(1, "bench-press"))), Routine("routine1", "First", 1, midnight,
            listOf(RoutineEntry(1, "bench-press"))))
        val record = EngineReadouts.record(TheSix.movements.first { it.id == "bench-press" }, history, programs, midnight + 100_000)
        assertEquals(listOf("First", "Second"), record.routines)
    }
}
