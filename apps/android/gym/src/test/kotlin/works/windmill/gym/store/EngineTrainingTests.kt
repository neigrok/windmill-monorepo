package works.windmill.gym.store

import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Test
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import works.windmill.gym.domain.*
import works.windmill.sync.api.*
import works.windmill.sync.core.Json
import works.windmill.sync.core.ClockReading
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.engine.Engine
import works.windmill.sync.engine.EngineClock
import works.windmill.sync.engine.signIn
import works.windmill.sync.engine.signOut
import works.windmill.sync.engine.nextPush
import works.windmill.sync.engine.onPushResponse
import works.windmill.sync.engine.RequestTiming
import works.windmill.sync.engine.SyncResponse
import works.windmill.sync.modelserver.Credential
import works.windmill.sync.modelserver.ModelServer
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
            assertEquals(listOf("Mine", "Original"), room.training.catalogue().first { it.id == "exercise1" }.aliases)
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

    private suspend fun proposalFixture(room: EngineRoomFixture, server: ModelServer, removing: Boolean = false) {
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
                listOf(works.windmill.gym.domain.sync.SetTarget(6, 82.5)))), "Progress", removing)) is works.windmill.domain.kit.Outcome.Committed)
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

    @Test fun queuedAndInFlightSetsKeepTheirDeviceMarkersWithoutAFalseDeliveryFailure() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val server = EngineRoomFixture.server()
            room.select("A"); room.pull(server)
            room.store.start(); room.sync(server)
            room.store.choose("bench-press"); room.store.logSet(80.0, 5)
            val pending = setOf(room.store.sets.single().id)
            assertEquals(pending, room.store.stalled)
            assertEquals(0, room.store.strandedCount)
            assertNull(room.store.strandedBy)
            assertEquals(SaveState.OnThisDevice, room.store.saveState)

            assertNotNull(room.engine.nextPush())
            room.store.refreshEngine()
            assertEquals(pending, room.store.stalled)
            assertEquals(0, room.store.strandedCount)
            assertNull(room.store.strandedBy)

            room.training.reportDelivery(room.engine.activeReplica(), works.windmill.sync.engine.Reply.Unreachable)
            room.store.refreshEngine()
            assertEquals(1, room.store.strandedCount)
            assertEquals(Blocker.Offline, room.store.strandedBy)
            assertEquals(SaveState.Blocked(Blocker.Offline), room.store.saveState)

            room.training.reportDelivery(room.engine.activeReplica(), works.windmill.sync.engine.Reply.Answer(SyncResponse(200, Json.objectOf())))
            room.store.refreshEngine()
            assertEquals(pending, room.store.stalled)
            assertEquals(0, room.store.strandedCount)
            assertNull(room.store.strandedBy)
            assertEquals(SaveState.OnThisDevice, room.store.saveState)
            room.sync(server); room.store.refreshEngine()
            assertEquals(emptySet<String>(), room.store.stalled)
            assertEquals(0, room.store.strandedCount)
            assertEquals(SaveState.OnTheLog, room.store.saveState)
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

    @Test fun proposalDecisionsReturnOnlyTheConfirmedServerReceiptAndLeaveTheCardWhileWaiting() = runTest {
        for ((applying, removing) in listOf(false to false, true to false, true to true)) EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val server = EngineRoomFixture.server(); proposalFixture(room, server, removing)
            val decision = async { if (applying) room.training.applyProposal("proposal1") else room.training.dismissProposal("proposal1") }
            runCurrent()
            assertFalse("a local prediction is not a receipt", decision.isCompleted)
            assertEquals(ProposalState.Pending, room.training.proposal("proposal1")!!.state)
            assertEquals("Original", room.training.routine("routine1")!!.name)
            assertEquals("proposal1", room.training.routine("routine1")!!.pendingProposal!!.id)
            room.now += 1_000
            if (removing) {
                val request = requireNotNull(room.engine.nextPush())
                val response = server.push(request, Credential.Account("A"), room.now)
                assertEquals(200, response.status)
                val clock = ClockReading(room.now, room.now, "test")
                room.engine.onPushResponse(request, SyncResponse(response.status, response.body), RequestTiming(clock, clock))
                advanceTimeBy(25); runCurrent()
                assertFalse("an acknowledged command still waits for its pull", decision.isCompleted)
                assertEquals(ProposalState.Pending, room.training.proposal("proposal1")!!.state)
                room.pull(server)
            } else room.sync(server)
            advanceTimeBy(25); runCurrent()
            val receipt = decision.await()
            assertEquals(if (applying) ProposalState.Applied else ProposalState.Dismissed, receipt.proposal.state)
            if (removing) assertNull("the removal result carries no settlement timestamp", receipt.proposal.settledAtMs)
            else assertEquals(room.now, receipt.proposal.settledAtMs)
            assertEquals(if (removing) null else if (applying) "Proposed" else "Original", receipt.routine?.name)
            assertNotNull(receipt.proposal.receipt)
            if (removing) {
                assertNull(room.training.routine("routine1"))
                assertNull("a cold proposal read does not resurrect the removed record", room.training.proposal("proposal1"))
            }
        }
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test fun proposalRefusalNeverReportsThePredictedReceiptOrChangesTheConfirmedRoutine() = runTest {
        for (removing in listOf(false, true)) EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val server = EngineRoomFixture.server(); proposalFixture(room, server, removing)
            val decision = async { runCatching { room.training.applyProposal("proposal1") } }
            runCurrent(); server.refuse(code = "stale"); room.sync(server)
            withContext(Dispatchers.IO) { withTimeout(2_000) { room.engine.notices("gym").notices.first { it.isNotEmpty() } } }
            advanceTimeBy(25); runCurrent()
            assertEquals("stale", (decision.await().exceptionOrNull() as TrainingRefused).code)
            assertEquals(ProposalState.Pending, room.training.proposal("proposal1")!!.state)
            assertEquals("Original", room.training.routine("routine1")!!.name)
        }
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test fun proposalTimeoutCancellationAndAccountChangeCannotInventAReceiptOrLoseThePendingIntent() = runTest {
        for (removing in listOf(false, true)) for (ending in listOf("timeout", "cancel", "account")) EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val server = EngineRoomFixture.server(); proposalFixture(room, server, removing)
            val decision = async { runCatching {
                if (removing) room.training.applyProposal("proposal1") else room.training.dismissProposal("proposal1")
            } }
            runCurrent()
            val queued = room.outbox()
            when (ending) {
                "cancel" -> { decision.cancelAndJoin(); assertTrue(decision.isCancelled) }
                "account" -> { room.select(null); advanceTimeBy(25); runCurrent(); assertEquals("account-changed", (decision.await().exceptionOrNull() as TrainingRefused).code) }
                else -> { advanceTimeBy(15_001); runCurrent(); assertEquals(TrainingUnanswered, decision.await().exceptionOrNull()) }
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
            val gym = EngineTraining(engine)
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
            val gym = EngineTraining(engine)
            gym.replaceRoutine("routine1", RoutineWrite("routine1", "Renamed", 0, listOf(RoutineEntryWrite("back-squat"))))
            val outbox = engine.snapshot().member("replicas").arr().first().member("outbox").arr()
            assertTrue(outbox.all { it["guards"] == null || it["guards"]!!.arr().none { guard -> guard["field"] == Json.of("revision") } })
            assertEquals("Renamed", gym.routine("routine1")!!.name)
        }
    }
    @Test fun aFailedRoutinePreservationReadNeverSendsAReplacement() = runBlocking {
        engine().use { engine ->
            seedRoutine(engine)
            val gym = EngineTraining(engine)
            engine.failNextCommit()
            try { gym.replaceRoutine("routine1", RoutineWrite("routine1", "Changed", 0, listOf(RoutineEntryWrite("back-squat")))); fail("Must preserve the existing routine when storage fails.") }
            catch (_: CommitFailure) {}
            assertEquals("Original", gym.routine("routine1")!!.name)
        }
    }
    @Test fun unitWritesPreserveTheFreshServerDocumentIncludingUnownedFields() = runBlocking {
        engine().use { engine ->
            seed(engine, Gym.Types.prefs, "prefs", mapOf("units" to Json.of("kg"), "restSeconds" to Json.of(180), "restSound" to Json.of(true)))
            val gym = EngineTraining(engine)
            assertEquals(GymPreferences(), gym.settings())
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
            val gym = EngineTraining(engine)
            gym.savePreferences(GymPreferences(units = Units.Pounds))
            engine.failNextCommit()
            try { gym.savePreferences(GymPreferences()); fail("Storage must preserve the saved preferences.") } catch (_: CommitFailure) {}
            assertEquals(GymPreferences(units = Units.Pounds), gym.settings())
        }
    }
    @Test fun anonymousWorkoutIsDurableInTheEngineWithoutRestAndAllIdsSurviveRestore() = runBlocking {
        val original = engine()
        val gym = EngineTraining(original)
        gym.startSession(SessionStart("session1", now - 10_000))
        gym.appendSet("session1", SetWrite("set00001", "back-squat", 80.0, 5, SetKind.Working, now - 9_000))
        gym.finishSession("session1", now - 5_000)
        val snapshot = original.snapshot()
        original.close()
        Engine.memory(SyncSchema.registry, snapshot, clock = object : EngineClock { override fun now() = now }).use { engine ->
            val restored = EngineTraining(engine)
            assertEquals(Session("session1", now - 10_000, now - 5_000), restored.session("session1")!!.session)
            assertEquals(listOf(TrainingSet("set00001", "back-squat", weightKg = 80.0, reps = 5, completedAtMs = now - 9_000)), restored.session("session1")!!.sets)
        }
    }
    @Test fun ambiguousAppendReplaysTheExistingIdBeforeApplyingCorrectionAndDeletion() = runBlocking {
        engine().use { engine ->
            val gym = EngineTraining(engine)
            gym.startSession(SessionStart("session1", now - 10_000))
            val write = SetWrite("set00001", "back-squat", 80.0, 5, SetKind.Working, now - 9_000)
            gym.appendSet("session1", write)
            val beforeCollision = engine.snapshot()
            for ((session, collision) in listOf("session2" to write, "session1" to write.copy(exerciseId = "bench-press"),
                "session1" to write.copy(completedAt = now - 8_000))) {
                try { gym.appendSet(session, collision); fail("A set identity cannot acquire another immutable origin.") }
                catch (failure: TrainingRefused) {
                    assertEquals("set-id-taken", failure.code)
                    assertEquals("that set id is already used", failure.line)
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
    @Test fun aStartRefusesWhileAnotherWorkoutIsOpen() = runBlocking {
        engine().use { engine ->
            val gym = EngineTraining(engine)
            gym.startSession(SessionStart("session1", now - 10_000))
            val before = engine.snapshot()
            try { gym.startSession(SessionStart("session2", now - 9_000)); fail("A start must refuse an already open workout.") }
            catch (failure: TrainingRefused) {
                assertEquals("session-already-open", failure.code)
                assertEquals("A workout is already open. Finish it first.", failure.line)
            }
            assertEquals(before, engine.snapshot())
        }
    }
    @Test fun cursorUsesBothHalvesAndWarmupsDoNotBecomeLastTimeOrProgress() = runBlocking {
        engine().use { engine ->
            val gym = EngineTraining(engine)
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
    @Test fun aNoteMoveWritesOnlyItsPositionAndWeighinsSaveAtTheCommitMoment() = runBlocking {
        engine().use { engine ->
            val gym = EngineTraining(engine)
            gym.writeNote("note0001", NoteWrite("One", "First"))
            gym.writeNote("note0002", NoteWrite("Two", "Second"))
            gym.writeNote("note0003", NoteWrite("Three", "Third"))
            fun positions() = engine.read(ScopeRef(Gym.scope)) { read ->
                read.stored(Gym.Types.note).associate { it.id.string!! to it.values.getValue("ord") }
            }
            val standing = positions()
            val before = engine.snapshot().jcs
            try { gym.moveNote("note0001", listOf("note0002", "note0001", "note_missing"), emptySet()); fail("An order must name every note.") } catch (_: TrainingRefused) {}
            assertEquals(before, engine.snapshot().jcs)
            val order = listOf("note0002", "note0001", "note0003")
            assertTrue(gym.moveNote("note0001", order, emptySet()))
            assertEquals(order, gym.notes().map { it.id })
            assertEquals(standing.filterKeys { it != "note0001" }, positions().filterKeys { it != "note0001" })
            val moved = engine.snapshot()
            assertFalse(gym.moveNote("note0001", order, emptySet()))
            assertEquals(moved, engine.snapshot())
            gym.putBodyweight("2026-01-01", 70.0)
            assertEquals(WeighIn("2026-01-01", 80.0, now), gym.putBodyweight("2026-01-01", 80.0))
        }
    }
    @Test fun aNoteMoveCommitsOnceAndFailuresRestoreEveryPosition() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val server = EngineRoomFixture.server()
            room.select("A"); room.pull(server)
            for (id in listOf("note0001", "note0002", "note0003", "note0004"))
                assertTrue(room.store.saveNote(id, NoteWrite(id, "Body")) is GymResult.Ok)
            room.sync(server); room.store.refreshEngine()
            val before = room.store.notes
            val order = listOf("note0003", "note0001", "note0002", "note0004")
            val reordered = order.mapIndexed { index, id -> before.single { it.id == id }.copy(position = index) }
            assertTrue(room.store.reorderNotes("note0003", listOf("note0001", "note0001", "note0003", "note0004")) is GymResult.Failed)
            assertEquals(before, room.store.notes)
            assertTrue(room.outbox().isEmpty())

            room.engine.failNextCommit()
            assertEquals(GymResult.Failed(WriteFailure.NoAnswer), room.store.reorderNotes("note0003", order))
            assertEquals(before, room.store.notes)
            assertEquals(before, room.training.notes())
            assertTrue(room.outbox().isEmpty())

            assertEquals(GymResult.Ok(reordered), room.store.reorderNotes("note0003", order))
            val writes = room.outbox().single().member("intent").member("d").arr()
            assertEquals(listOf("note0003"), writes.map { it.member("id").str() })
            assertTrue(writes.all { it.member("f").obj().keys == setOf("ord") })
            server.refuse(code = "invalid"); room.sync(server); room.store.refreshEngine()
            assertEquals(before, room.store.notes)
            assertEquals(before, room.training.notes())
            assertTrue(room.outbox().isEmpty())
            assertEquals(GymResult.Ok(reordered), room.store.reorderNotes("note0003", order))
            room.sync(server); room.store.refreshEngine()
            assertEquals(reordered, room.store.notes)
        }
    }
    @Test fun readoutsPreserveRecordsAndFrozenPlanComparison() {
        fun detail(id: String, at: Long, kg: Double) = SessionDetail(Session(id, at, at + 100, "routine1", PlanSnapshot("Frozen", listOf(PlanEntry("back-squat", listOf(SetTarget(5, 80.0)))))),
            (1..4).map { TrainingSet("set$id$it", "back-squat", weightKg = kg, reps = 5, completedAtMs = at + it) })
        val earlier = detail("session1", 1000, 80.0)
        val later = detail("session2", 2000, 90.0)
        val review = Review.of(later, listOf(earlier, later))
        assertEquals("e1rm", review.record!!.kind)
        assertEquals("session1", review.against!!.sessionId)
        assertEquals(PlannedLine(listOf(SetTarget(5, 80.0))), review.against!!.movements.single().planned)
        assertTrue(SessionSummary.of(later, listOf(earlier, later)).record)
    }
    @Test fun trainingStoreUsesEngineForAnonymousAndNotificationLogThenFinish() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val session = (room.store.start() as GymResult.Ok).value
            room.store.choose("back-squat")
            room.store.logSet(80.0, 5)
            assertEquals(1, room.training.session(session.id)!!.sets.size)
            assertTrue(room.store.finish() is FinishOutcome.Closed)
            assertFalse(room.training.session(session.id)!!.session.isOpen)
        }
    }
    @Test fun anUnreadAccountDoesNotClaimNeverLoggedOrAFirstWorkout() = runBlocking {
        engine().use { engine ->
            engine.signIn("A", mapOf("gym" to true))
            val gym = EngineTraining(engine)
            try { gym.lastSets(); fail("An unread account cannot say never logged.") } catch (_: TrainingUnanswered) {}
            try { gym.lastTime("bench-press"); fail("An unread account cannot invent the last workout.") } catch (_: TrainingUnanswered) {}
            try { gym.sessions(50, null, null); fail("An unread account cannot say first workout.") } catch (_: TrainingUnanswered) {}
        }
    }
    @Test fun addAndDiscardThenKeepSignoutCannotResurrectAnOldAnonymousMirror() = runTest {
        for (choice in listOf("add", "discard")) EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val session = (room.store.start() as GymResult.Ok).value
            room.store.choose("back-squat")
            val offer = room.store.notification.value!!.offer!!
            assertTrue(room.store.acceptSet(LogSetCommand(offer.key, offer.id)) is LogSetAcceptance.Accepted)
            assertEquals(1, room.training.session(session.id)!!.sets.size)
            room.store.prepareEngineTransition()
            room.engine.signIn("A", mapOf("gym" to true), mapOf("gym" to choice))
            room.store.connect(room.account("A"))
            if (choice == "add") assertEquals(session.id, room.store.session!!.id) else assertNull(room.store.session)
            room.store.prepareEngineTransition()
            room.engine.signOut("keep")
            room.store.connect(room.account(null))
            assertNull(room.store.session)
            assertEquals(emptyList<SessionSummary>(), room.store.allSessions)
            assertEquals(emptyList<SessionDetail>(), room.training.details())
        }
    }
    @Test fun productionActionContextCopiesNestingAcrossHopsAndIsolatesIndependentEntriesAfterCancel() = runBlocking {
        engine().use { engine ->
            val gym = EngineTraining(engine)
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
            assertEquals(listOf("exercise1", "exercise2"), gym.catalogue().filter { it.custom }.map { it.id }.sorted())
        }
    }

    @Test fun reviewPriorMarksUseCompletedTimeAcrossMidnight() {
        val midnight = 1_800_057_600_000L
        fun detail(id: String, started: Long, completed: Long, load: Double, count: Int = 1) = SessionDetail(
            Session(id, started, completed + 1, "routine1", PlanSnapshot("Frozen", listOf(PlanEntry("bench-press", listOf(SetTarget(5, load)))))),
            (0 until count).map { TrainingSet("set$id$it", "bench-press", it + 1, load, 5, SetKind.Working, null, "", completed + it) })
        val first = detail("session1", midnight - 30_000, midnight + 20_000, 100.0)
        val tied = detail("session2", midnight - 10_000, midnight + 10_000, 100.0)
        val today = detail("session3", midnight + 60_000, midnight + 70_000, 110.0, 5)
        val history = listOf(today, first, tied)
        val review = Review.of(today, history)
        assertEquals(midnight + 10_000, review.record!!.previousAtMs)
        assertEquals("e1rm", review.record!!.kind)
        assertEquals("Frozen", review.against!!.routine)
    }
}
