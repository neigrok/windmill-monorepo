package works.windmill.gym.coach

import works.windmill.gym.store.*
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.domain.kit.ActionContext
import works.windmill.domain.kit.ActionRunner
import works.windmill.domain.kit.FixedZone
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Outcome
import works.windmill.gym.domain.*
import works.windmill.gym.domain.sync.ProposeRoutine
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.net.GymRest
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
import works.windmill.gym.domain.sync.Exercise as SyncExercise
import works.windmill.gym.domain.sync.Proposal as SyncProposal
import works.windmill.gym.domain.sync.Routine as SyncRoutine
import works.windmill.gym.domain.sync.RoutineEntry as SyncEntry
import works.windmill.gym.domain.sync.SetTarget as SyncTarget

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class CoachOwnershipTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun streamSnapshotsAreDurableOffTheCallerThreadBeforePublicationAndLateStoppedWritesStayCleared() = runTest {
        val caller = Thread.currentThread()
        val writes = java.util.Collections.synchronizedList(mutableListOf<Thread>())
        val file = File(tmp.root, "coach-thread")
        val disk = LocalCoach(file) { target, text ->
            writes += Thread.currentThread()
            works.windmill.platform.storage.AtomicDocument.write(target, text)
        }
        val partial = AskGeneration("generation-a", "request-a", "Question", "running", "Café\n東京", revision = 1)
        val stopped = partial.copy(status = "stopped", revision = 2)
        val server = object : GymRest by FakeGymRest() {
            override suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit): AskAnswer {
                onSnapshot(partial)
                onSnapshot(stopped)
                return stopped.response()
            }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = server, localCoach = disk).use { room ->
            room.select("a")
            val store = room.store
            store.coach.saveDraft("thread-a", CoachDraft("Question"))
            assertEquals(1, store.coach.draftVersion)
            writes.clear()
            val shown = mutableListOf<AskGeneration>()
            val result = store.coach.ask("thread-a", "Question", "request-a", stream = true, onSnapshot = {
                assertSame(caller, Thread.currentThread())
                assertEquals(it, LocalCoach(file).snapshot("a", "request-a"))
                store.coach.saveDraft("thread-a", CoachDraft())
                assertEquals(2, store.coach.draftVersion)
                shown += it
            })
            assertEquals(AskOutcome.Answered(stopped.response()), result)
            assertEquals(listOf(partial, stopped), shown)
            assertEquals(4, writes.size)
            assertTrue(writes.all { it !== caller })
            disk.saveDraft("a", "thread-a", CoachDraft("Next question"))
            disk.record("a", partial)
            assertEquals(emptyList<AskQuestion>(), LocalCoach(file).pending("a"))
            assertNull(LocalCoach(file).snapshot("a", "request-a"))
            assertEquals(CoachDraft("Next question"), LocalCoach(file).draft("a", "thread-a"))
            assertEquals(5, writes.size)
        }
    }

    @Test
    fun accountSwitchDuringFinalDiskFlushCannotReturnThePreviousAccountsAnswer() = runTest {
        for (recover in listOf(false, true)) {
            val entered = CompletableDeferred<Unit>()
            val release = java.util.concurrent.CountDownLatch(1)
            val file = File(tmp.root, "coach-final-$recover")
            val disk = LocalCoach(file) { target, text ->
                val document = works.windmill.platform.net.WindmillJson.parseToJsonElement(text) as kotlinx.serialization.json.JsonObject
                val pending = (document["pending"] as? kotlinx.serialization.json.JsonObject)?.get("a") as? kotlinx.serialization.json.JsonObject
                val chats = (document["chats"] as? kotlinx.serialization.json.JsonObject)?.get("a") as? kotlinx.serialization.json.JsonObject
                if (pending.isNullOrEmpty() && chats?.containsKey("thread-a") == true) {
                    entered.complete(Unit)
                    check(release.await(5, java.util.concurrent.TimeUnit.SECONDS))
                }
                works.windmill.platform.storage.AtomicDocument.write(target, text)
            }
            val done = AskGeneration("generation-a", "request-a", "Question", "completed", "Private answer", revision = 2)
            val server = object : GymRest by FakeGymRest() {
                override suspend fun ask(question: AskQuestion): AskAnswer {
                    if (recover) throw WindmillApiException.Transport(java.io.IOException("interrupted"))
                    return done.response()
                }
                override suspend fun thread(id: String, before: String?): AskThread = AskThread(id, "Question", generation = done)
            }
            EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = server, localCoach = disk).use { room ->
                room.select("a")
                val outcome = async { room.store.coach.ask("thread-a", "Question", "request-a") }
                entered.await()
                try { room.select("b") } finally { release.countDown() }
                assertEquals(AskOutcome.Refused("The account changed. Open this again."), outcome.await())
                assertNull(LocalCoach(file).snapshot("b", "request-a"))
                assertEquals(emptyList<AskQuestion>(), LocalCoach(file).pending("a"))
            }
        }
    }

    @Test
    fun expiredUnlinkedPhotoIsReuploadedFromRetainedBytesWithTheSameRequestAfterRestart() = runTest {
        val file = File(tmp.root, "coach-expired")
        val disk = LocalCoach(file)
        val photo = CoachAttachment("attachment-expired", "image/png", 1, 1, 3)
        val bytes = byteArrayOf(1, 2, 3)
        val request = AskQuestion("thread-expired", "Caption", "request-expired", listOf(photo.id), purpose = "conversation")
        disk.savePhoto("a", photo.id, bytes)
        disk.saveDraft("a", request.thread, CoachDraft(request.question, photo))
        val uploads = mutableListOf<String>()
        val requests = mutableListOf<AskQuestion>()
        val boundary = object : GymRest by FakeGymRest() {
            override suspend fun uploadPhoto(threadId: String, value: CoachAttachment, body: ByteArray, onProgress: (Float) -> Unit): CoachAttachment {
                assertArrayEquals(bytes, body); uploads += value.id; return value
            }
            override suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit): AskAnswer {
                requests += question
                if (requests.size == 1) throw WindmillApiException.Refused(400, Refusal("Photo expired", code = "ask-attachment-invalid"))
                return AskGeneration("generation-expired", "request-expired", "Caption", "completed", "Photo received", attachments = listOf(photo)).response()
            }
        }
        val directory = tmp.newFolder()
        val snapshot = EngineRoomFixture(directory, backgroundScope, rest = boundary, localCoach = disk).use { first ->
            first.select("a")
            assertEquals(AskOutcome.Failed("Photo wasn’t available. Retry to upload it again."),
                first.store.coach.ask(request.thread, request.question, "request-expired", photo, stream = true))
            first.engine.snapshot()
        }
        EngineRoomFixture(directory, backgroundScope, snapshot, rest = boundary, localCoach = LocalCoach(file)).use { restored ->
            restored.selected = "a"
            restored.store.connect(restored.account())
            assertEquals(photo, restored.store.coach.pendingExchange(request).attachments.single())
            assertTrue(restored.store.coach.ask(request.thread, request.question, "request-expired", photo, stream = true) is AskOutcome.Answered)
        }
        assertEquals(listOf(request, request), requests)
        assertEquals(listOf(photo.id, photo.id), uploads)
    }

    @Test
    fun interruptedStreamRetainsPhotoAndPartialResultsThenSameRequestCanStopWithoutRestart() = runTest {
        val file = File(tmp.root, "coach-stream")
        val disk = LocalCoach(file)
        val photo = CoachAttachment("attachment-a", "image/png", 1, 1, 3)
        val bytes = byteArrayOf(1, 2, 3)
        val request = AskQuestion("thread-a", "", "request-a", listOf(photo.id), purpose = "conversation")
        val receipt = CoachResult("routine-created", "operation-a", "routine-a", "Upper body")
        val partial = AskGeneration("generation-a", "request-a", "", "running", "Created Upper", results = listOf(receipt),
            revision = 3, attachments = listOf(photo))
        disk.savePhoto("a", photo.id, bytes)
        disk.saveDraft("a", "thread-a", CoachDraft(photo = photo))
        val seen = mutableListOf<AskQuestion>()
        var uploads = 0
        val boundary = object : GymRest by FakeGymRest() {
            override suspend fun uploadPhoto(threadId: String, value: CoachAttachment, body: ByteArray, onProgress: (Float) -> Unit): CoachAttachment {
                assertEquals(photo, value); assertArrayEquals(bytes, body); uploads++; onProgress(1f); return value
            }
            override suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit): AskAnswer {
                seen += question
                onSnapshot(partial)
                if (seen.size == 1) throw WindmillApiException.Transport(java.io.IOException("lost"))
                val stopped = partial.copy(status = "stopped", revision = 4)
                onSnapshot(stopped)
                return stopped.response()
            }
        }
        val directory = tmp.newFolder()
        val snapshot = EngineRoomFixture(directory, backgroundScope, rest = boundary, localCoach = disk).use { room ->
            room.select("a")
            val snapshots = mutableListOf<AskGeneration>()
            val failure = room.store.coach.ask(request.thread, "", "request-a", photo, stream = true, onSnapshot = snapshots::add)
            assertEquals(partial, (failure as AskOutcome.Failed).generation)
            assertEquals(listOf(request), LocalCoach(file).pending("a"))
            assertEquals(partial, LocalCoach(file).snapshot("a", "request-a"))
            assertEquals(listOf(partial), snapshots)
            room.engine.snapshot()
        }
        EngineRoomFixture(directory, backgroundScope, snapshot, rest = boundary, localCoach = LocalCoach(file)).use { restored ->
            restored.selected = "a"
            restored.store.connect(restored.account())
            val answer = restored.store.coach.ask(request.thread, "", "request-a", photo, stream = true) as AskOutcome.Answered
            assertEquals("stopped", answer.answer.generation?.status)
            assertEquals(Ask.stopped, answer.exchange(partial.exchange()).trouble)
            assertFalse(answer.exchange(partial.exchange()).again)
            assertEquals(listOf(receipt), answer.answer.results)
        }
        assertEquals(listOf(request, request), seen)
        assertEquals(1, uploads)
        assertEquals(emptyList<AskQuestion>(), LocalCoach(file).pending("a"))
    }

    @Test
    fun lateStreamSnapshotsCannotWriteOrDisplayUnderAnotherAccount() = runTest {
        val file = File(tmp.root, "coach-owner")
        val release = CompletableDeferred<Unit>()
        val partial = AskGeneration("generation-a", "request-a", "Question", "completed", "Private", revision = 1)
        val boundary = object : GymRest by FakeGymRest() {
            override suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit): AskAnswer {
                release.await(); onSnapshot(partial); return partial.response()
            }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = boundary, localCoach = LocalCoach(file)).use { room ->
            room.select("a")
            val seen = mutableListOf<AskGeneration>()
            val result = async { room.store.coach.ask("thread-a", "Question", "request-a", stream = true, onSnapshot = seen::add) }
            runCurrent()
            room.select("b")
            release.complete(Unit)
            assertEquals(AskOutcome.Refused("The account changed. Open this again."), result.await())
            assertEquals(emptyList<AskGeneration>(), seen)
            assertNull(LocalCoach(file).snapshot("b", "request-a"))
            assertEquals(listOf(AskQuestion("thread-a", "Question", "request-a", purpose = "conversation")), LocalCoach(file).pending("a"))
        }
    }

    @Test
    fun pendingRepliesReuseThePersistedIdentityAndOnlyCompletionClearsIt() = runTest {
        val file = File(tmp.root, "coach")
        val request = AskQuestion("thread-a", "Please create a routine", "request-a", purpose = "conversation")
        val generation = AskGeneration("generation-a", "request-a", request.question, "running")
        val seen = mutableListOf<AskQuestion>()
        val boundary = object : GymRest by FakeGymRest() {
            override suspend fun ask(question: AskQuestion): AskAnswer {
                assertEquals(listOf(request), LocalCoach(file).pending("a"))
                seen += question
                if (seen.size < 3) return AskAnswer("", ReadTally(), generation = generation)
                return AskAnswer("Created.", ReadTally(), generation = generation.copy(status = "completed"))
            }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = boundary, localCoach = LocalCoach(file)).use { room ->
            room.select("a")
            assertTrue(room.store.coach.ask(request.thread, request.question, requireNotNull(request.requestId)) is AskOutcome.Answered)
            assertEquals(listOf(request, request, request), seen)
            assertEquals(emptyList<AskQuestion>(), LocalCoach(file).pending("a"))
        }
    }

    @Test
    fun failedReplyPreservesCreatedRoutineAndTheOriginalRequestForRetry() = runTest {
        val file = File(tmp.root, "coach")
        val request = AskQuestion("thread-a", "Please create a routine", "request-a", purpose = "conversation")
        val result = CoachResult("routine-created", "operation-a", "routine-a", "Upper body")
        val generation = AskGeneration("generation-a", "request-a", request.question, "failed", results = listOf(result))
        val server = FakeGymRest().apply {
            refuseAsk = WindmillApiException.Refused(502, Refusal("Response interrupted."))
            conversations[request.thread] = AskThread(request.thread, generation = generation)
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = server, localCoach = LocalCoach(file)).use { room ->
            room.select("a")
            val store = room.store
            assertEquals(AskOutcome.Failed("Response interrupted.", generation), store.coach.ask(request.thread, request.question, "request-a"))
            assertEquals(listOf(request), LocalCoach(file).pending("a"))
            server.refuseAsk = WindmillApiException.Refused(429, Refusal(code = "ask-daily-limit"))
            assertEquals(AskOutcome.Capped(Ask.capReached, AskCap.Daily, generation), store.coach.ask(request.thread, request.question, "request-a"))
            assertEquals(listOf(request), LocalCoach(file).pending("a"))
            assertEquals(generation, LocalCoach(file).snapshot("a", "request-a"))
            server.refuseAsk = null
            server.answers += AskAnswer("Created Upper body.", ReadTally(), generation = generation.copy(status = "completed"), results = listOf(result))
            assertTrue(store.coach.ask(request.thread, request.question, "request-a") is AskOutcome.Answered)
            assertEquals(listOf(request, request, request), server.asked)
            assertEquals(emptyList<AskQuestion>(), LocalCoach(file).pending("a"))
        }
    }

    @Test
    fun aLateAnswerAndThreadReadCannotAppearInTheNextAccount() = runTest {
        val release = CompletableDeferred<Unit>()
        val old = AskThread("thread-a", "A's question", turns = listOf(AskTurn("coach", "Private answer")))
        val boundary = object : GymRest by FakeGymRest() {
            override suspend fun ask(question: AskQuestion): AskAnswer { release.await(); return AskAnswer("Private answer", ReadTally(3, 1, 1)) }
            override suspend fun thread(id: String, before: String?): AskThread { release.await(); return old }
            override suspend fun threads(cursor: String?): ThreadPage { release.await(); return ThreadPage(listOf(old)) }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = boundary).use { room ->
            room.select("a")
            val store = room.store
            val answer = async { store.coach.ask("thread-a", "Question") }
            val detail = async { store.coach.thread("thread-a") }
            val list = async { store.coach.readThreads() }
            runCurrent()
            room.select("b")
            release.complete(Unit)
            assertEquals(AskOutcome.Refused("The account changed. Open this again."), answer.await())
            assertEquals(GymResult.Failed(WriteFailure.Refused("The account changed. Open this again.")), detail.await())
            assertEquals(GymResult.Failed(WriteFailure.Refused("The account changed. Open this again.")), list.await())
            assertEquals(emptyList<AskThread>(), store.coach.allThreads)
        }
    }

    // The server's verdict reaches A's replica, and the owner changes before the store reports it.
    @Test
    fun aStaleDecisionVerdictCannotReportItselfAfterTheOwnerChanges() = runTest {
        for ((applying, code) in listOf(true to "proposal-superseded", false to "proposal-settled")) {
            EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = FakeGymRest()).use { room ->
                val server = EngineRoomFixture.server()
                room.select("a")
                val routine = (room.store.saveRoutine(RoutineDraft(name = "A's routine")
                    .adding("bench-press", listOf(SetTarget(5, 80.0))).capturingMovements(room.store.catalog)) as GymResult.Ok).value
                room.sync(server)
                val runner = ActionRunner(room.engine, room.engine.registry, FixedZone(0), object : ActionContext { override var insideRun = false })
                assertTrue(runner.run(ProposeRoutine(Id("proposal1", SyncProposal), Id(routine.id, SyncRoutine), routine.name,
                    listOf(SyncEntry(Id("bench-press", SyncExercise), listOf(SyncTarget(6, 82.5)))), "Progress")) is Outcome.Committed)
                room.sync(server)
                room.store.refreshEngine()
                val result = async { if (applying) room.store.applyProposal("proposal1") else room.store.dismissProposal("proposal1") }
                runCurrent()
                server.refuse(code = code)
                room.sync(server)
                assertEquals(listOf(code), room.notices().map { it.member("code").str() })
                room.select("b")
                advanceTimeBy(25); runCurrent()
                assertEquals(ProposalOutcome.Failed(WriteFailure.Refused("The account changed. Open this again.")), result.await())
                assertEquals(emptyMap<String, Proposal>(), room.store.settledProposals)
                assertEquals(emptyList<Routine>(), room.store.allRoutines)
            }
        }
    }

    @Test
    fun notesReadSaveAndDeleteKeepOneAuthoritativeOrderAfterImmediateDeletion() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
            other.select("a"); other.pull(server)
            for ((id, title, body) in listOf(Triple("note000a", "First", "Original"), Triple("note000b", "Second", "Keep"),
                    Triple("note000c", "Third", "Last"))) assertTrue(other.store.saveNote(id, NoteWrite(title, body)) is GymResult.Ok)
            other.sync(server)
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = FakeGymRest()).use { room ->
            room.select("a"); room.pull(server)
            val store = room.store
            val (first, second, third) = (store.readNotes() as GymResult.Ok).value
            val saved = (store.saveNote(first.id, NoteWrite("First", "Accepted edit")) as GymResult.Ok).value
            assertNull(store.delete(Deletion.Note(second.id)))
            assertTrue(store.reorderNotes(first.id, listOf(third.id, third.id)) is GymResult.Failed)
            assertTrue(store.reorderNotes(first.id, listOf(third.id, first.id)) is GymResult.Ok)
            assertEquals(listOf(third.copy(position = 0), saved.copy(position = 1)), store.notes)
            assertEquals(2, store.noteCount)
            assertNull(store.keepWithheld())
            assertEquals(listOf(third.copy(position = 0), saved.copy(position = 1)), store.notes)
        }
    }

    @Test fun routineConfirmationRetriesTheSameOperationAndPersistsOnlyForItsOwner() = runTest {
        val file = File(tmp.root, "confirmations")
        val disk = LocalCoach(file)
        val draft = CoachRoutineDraft("operation-a", "routine-a", "Private routine", 1,
            listOf(RoutineEntry(1, "dumbbell-bench-press", listOf(SetTarget(8, 16.0)))), "pending")
        val generation = AskGeneration("generation-a", "request-a", "Private question", "failed", "Review this plan",
            revision = 3, routineDrafts = listOf(draft.copy(state = "saved")),
            results = listOf(CoachResult("routine-created", "operation-a", "routine-a", "Private routine")))
        val calls = mutableListOf<List<String>>()
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val failures = mutableListOf<String>()
        var owner: String? = "alice"
        var refreshes = 0
        val api = object : GymRest by FakeGymRest() {
            override suspend fun confirmRoutine(threadId: String, requestId: String, operationId: String): CoachRoutineConfirmation {
                calls += listOf(threadId, requestId, operationId)
                if (calls.size == 1) throw IllegalStateException("Private server text")
                return CoachRoutineConfirmation(threadId, generation)
            }
        }
        val telemetry = object : works.windmill.platform.telemetry.Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        val store = CoachStore({ owner }, { emptySet() }, { refreshes++ }, { api }, disk, telemetry, System::nanoTime, backgroundScope)
        assertEquals(emptyList<List<String>>(), calls)
        assertEquals(DraftOutcome.Failed(Ask.draftRetry), store.confirmRoutine("thread-a", "request-a", draft))
        assertNull(disk.confirmed("alice", "request-a"))
        assertEquals(DraftOutcome.Saved(generation), store.confirmRoutine("thread-a", "request-a", draft))
        assertEquals(DraftOutcome.Saved(generation), store.confirmRoutine("thread-a", "request-a", draft))
        assertEquals(listOf(listOf("thread-a", "request-a", "operation-a"), listOf("thread-a", "request-a", "operation-a")), calls)
        assertEquals(1, refreshes)
        assertEquals(generation, LocalCoach(file).confirmed("alice", "request-a"))
        assertEquals(listOf("gym.coachRoutineConfirm"), failures)
        assertEquals(listOf("started", "failed", "started", "saved").map { "gym_coach_routine_confirm" to mapOf("outcome" to it) }, events)
        owner = "bob"
        assertNull(store.confirmedGeneration("request-a"))
        disk.clear("alice", "thread-a")
        assertNull(LocalCoach(file).confirmed("alice", "request-a"))
    }

    @Test fun routineConfirmationAnswersEachRefusalByItsStatusAndCountsOnlyServerFailuresAsFailed() = runTest {
        val draft = CoachRoutineDraft("operation-a", "routine-a", "Routine", 1, emptyList(), "pending")
        val events = mutableListOf<String>()
        val failures = mutableListOf<String>()
        var failure: Exception = WindmillApiException.Offline
        val api = object : GymRest by FakeGymRest() {
            override suspend fun confirmRoutine(threadId: String, requestId: String, operationId: String): CoachRoutineConfirmation = throw failure
        }
        val telemetry = object : works.windmill.platform.telemetry.Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += "$name:${properties["outcome"]}" }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        val store = CoachStore({ "alice" }, { emptySet() }, { fail("Nothing was saved") }, { api }, LocalCoach(File(tmp.root, "refusals")),
            telemetry, System::nanoTime, backgroundScope)
        val answers = listOf(
            WindmillApiException.Refused(404, Refusal(code = "coach-draft-not-found")) to DraftOutcome.Closed(Ask.draftGone),
            WindmillApiException.Refused(422, Refusal(code = "coach-draft-invalid")) to DraftOutcome.Closed(Ask.draftInvalid),
            WindmillApiException.Refused(400, Refusal(code = "bad-request")) to DraftOutcome.Closed(Ask.draftInvalid),
            WindmillApiException.Refused(409, Refusal(code = "routine-save-in-progress")) to DraftOutcome.Failed(Ask.draftRetry),
            WindmillApiException.Refused(401, Refusal()) to DraftOutcome.Failed(Ask.draftSignIn),
            WindmillApiException.Refused(503, Refusal(code = "gym-engine-busy")) to DraftOutcome.Failed(Ask.draftRetry),
            WindmillApiException.Offline to DraftOutcome.Failed(Ask.draftRetry),
            WindmillApiException.Malformed to DraftOutcome.Failed(Ask.draftRetry))
        assertEquals(answers.map { it.second }, answers.map { (refusal, _) ->
            failure = refusal
            store.confirmRoutine("thread-a", "request-a", draft)
        })
        assertEquals(listOf("refused", "refused", "refused", "refused", "refused", "failed", "failed", "failed")
            .flatMap { listOf("gym_coach_routine_confirm:started", "gym_coach_routine_confirm:$it") }, events)
        assertEquals(emptyList<String>(), failures)
    }

    @Test fun leavingTheScreenMidSaveStillLandsTheRoutineItsRefreshAndItsOutcome() = runTest {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val file = File(tmp.root, "left-mid-save")
        val draft = CoachRoutineDraft("operation-a", "routine-a", "Routine", 1, emptyList(), "pending")
        val generation = AskGeneration("generation-a", "request-a", "Question", "completed", revision = 3,
            routineDrafts = listOf(draft.copy(state = "saved")))
        val events = mutableListOf<String>()
        var calls = 0
        var refreshes = 0
        val api = object : GymRest by FakeGymRest() {
            override suspend fun confirmRoutine(threadId: String, requestId: String, operationId: String): CoachRoutineConfirmation {
                calls++
                started.complete(Unit)
                release.await()
                return CoachRoutineConfirmation(threadId, generation)
            }
        }
        val telemetry = object : works.windmill.platform.telemetry.Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += "$name:${properties["outcome"]}" }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) = fail("Unexpected $operation")
        }
        val store = CoachStore({ "alice" }, { emptySet() }, { refreshes++ }, { api }, LocalCoach(file), telemetry, System::nanoTime, backgroundScope)
        val screen = async { store.confirmRoutine("thread-a", "request-a", draft) }
        started.await()
        screen.cancel()
        release.complete(Unit)
        assertEquals("the next tap waits for the first save and answers from it", DraftOutcome.Saved(generation),
            store.confirmRoutine("thread-a", "request-a", draft))
        assertTrue(screen.isCancelled)
        assertEquals(1, calls)
        assertEquals(generation, store.confirmedGeneration("request-a"))
        assertEquals(generation, LocalCoach(file).confirmed("alice", "request-a"))
        assertEquals(1, refreshes)
        assertEquals(listOf("gym_coach_routine_confirm:started", "gym_coach_routine_confirm:saved"), events)
    }

    @Test fun aRoutineTheLogSavedStaysSavedWhenThisPhoneCannotKeepItsCopy() = runTest {
        val draft = CoachRoutineDraft("operation-a", "routine-a", "Routine", 1, emptyList(), "pending")
        val generation = AskGeneration("generation-a", "request-a", "Question", "completed", revision = 3,
            routineDrafts = listOf(draft.copy(state = "saved")))
        val events = mutableListOf<String>()
        val failures = mutableListOf<String>()
        var refreshes = 0
        val api = object : GymRest by FakeGymRest() {
            override suspend fun confirmRoutine(threadId: String, requestId: String, operationId: String) = CoachRoutineConfirmation(threadId, generation)
        }
        val telemetry = object : works.windmill.platform.telemetry.Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += "$name:${properties["outcome"]}" }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        val disk = LocalCoach(File(tmp.root, "full-disk")) { _, _ -> throw java.io.IOException("disk full") }
        val store = CoachStore({ "alice" }, { emptySet() }, { refreshes++ }, { api }, disk, telemetry, System::nanoTime, backgroundScope)
        assertEquals(DraftOutcome.Saved(generation), store.confirmRoutine("thread-a", "request-a", draft))
        assertEquals(generation, store.confirmedGeneration("request-a"))
        assertEquals(1, refreshes)
        assertEquals(listOf("gym.coachRoutineConfirm"), failures)
        assertEquals(listOf("gym_coach_routine_confirm:started", "gym_coach_routine_confirm:saved"), events)
    }

    @Test fun lateRoutineConfirmationCannotAppearInAnotherAccount() = runTest {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var owner: String? = "alice"
        val file = File(tmp.root, "late-confirmation")
        val disk = LocalCoach(file)
        val draft = CoachRoutineDraft("operation-a", "routine-a", "Routine", 1, emptyList(), "pending")
        val api = object : GymRest by FakeGymRest() {
            override suspend fun confirmRoutine(threadId: String, requestId: String, operationId: String): CoachRoutineConfirmation {
                started.complete(Unit)
                release.await()
                return CoachRoutineConfirmation(threadId, AskGeneration("generation-a", requestId, "Question", "completed",
                    revision = 3, routineDrafts = listOf(draft.copy(state = "saved"))))
            }
        }
        val store = CoachStore({ owner }, { emptySet() }, { fail("Foreign program refresh") }, { api }, disk,
            works.windmill.platform.telemetry.Telemetry.None, System::nanoTime, backgroundScope)
        val result = async { store.confirmRoutine("thread-a", "request-a", draft) }
        started.await()
        owner = "bob"
        release.complete(Unit)
        assertTrue(result.await() is DraftOutcome.Failed)
        assertNull(store.confirmedGeneration("request-a"))
        assertNull(disk.confirmed("alice", "request-a"))
        assertNull(disk.confirmed("bob", "request-a"))
    }

}
