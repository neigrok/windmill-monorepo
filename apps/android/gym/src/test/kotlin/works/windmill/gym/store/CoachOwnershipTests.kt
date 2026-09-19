package works.windmill.gym.store

import java.io.File
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
class CoachOwnershipTests {
    @get:Rule val tmp = TemporaryFolder()
    private fun account(id: String) = Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }), User(id, "$id@example.com"))
    private fun TestScope.store(logs: Map<String, TrainingSyncing>, localCoach: LocalCoach? = null) = TrainingStore(
        SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "catalog")), LocalLog(File(tmp.root, "log")),
        LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "weight")), backgroundScope,
        now = { 1_800_000_000_000 + testScheduler.currentTime }, sync = { logs[it.user?.id] }, localCoach = localCoach)

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
        val server = object : TrainingSyncing by FakeTraining() {
            override suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit): AskAnswer {
                onSnapshot(partial)
                onSnapshot(stopped)
                return stopped.response()
            }
        }
        val store = store(mapOf("a" to server), disk)
        store.connect(account("a"))
        store.saveCoachDraft("thread-a", CoachDraft("Question"))
        assertEquals(1, store.coachDraftVersion)
        writes.clear()
        val shown = mutableListOf<AskGeneration>()
        val result = store.ask("thread-a", "Question", "request-a", stream = true, onSnapshot = {
            assertSame(caller, Thread.currentThread())
            assertEquals(it, LocalCoach(file).snapshot("a", "request-a"))
            store.saveCoachDraft("thread-a", CoachDraft())
            assertEquals(2, store.coachDraftVersion)
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

    @Test
    fun accountSwitchDuringFinalDiskFlushCannotReturnThePreviousAccountsAnswer() = runTest {
        for (recover in listOf(false, true)) {
            val entered = CompletableDeferred<Unit>()
            val release = java.util.concurrent.CountDownLatch(1)
            val file = File(tmp.root, "coach-final-$recover")
            val disk = LocalCoach(file) { target, text ->
                if (text == "{}") {
                    entered.complete(Unit)
                    check(release.await(5, java.util.concurrent.TimeUnit.SECONDS))
                }
                works.windmill.platform.storage.AtomicDocument.write(target, text)
            }
            val done = AskGeneration("generation-a", "request-a", "Question", "completed", "Private answer", revision = 2)
            val server = object : TrainingSyncing by FakeTraining() {
                override suspend fun ask(question: AskQuestion): AskAnswer {
                    if (recover) throw WindmillApiException.Transport(java.io.IOException("interrupted"))
                    return done.response()
                }
                override suspend fun thread(id: String): AskThread = AskThread(id, "Question", generation = done)
            }
            val store = store(mapOf("a" to server, "b" to FakeTraining()), disk)
            store.connect(account("a"))
            val outcome = async { store.ask("thread-a", "Question", "request-a") }
            entered.await()
            try { store.connect(account("b")) } finally { release.countDown() }
            assertEquals(AskOutcome.Refused("The account changed. Open this again."), outcome.await())
            assertNull(LocalCoach(file).snapshot("b", "request-a"))
            assertEquals(emptyList<AskQuestion>(), LocalCoach(file).pending("a"))
        }
    }

    @Test
    fun expiredUnlinkedPhotoIsReuploadedFromRetainedBytesWithTheSameRequestAfterRestart() = runTest {
        val file = File(tmp.root, "coach-expired")
        val disk = LocalCoach(file)
        val photo = CoachAttachment("attachment-expired", "image/png", 1, 1, 3)
        val bytes = byteArrayOf(1, 2, 3)
        val request = AskQuestion("thread-expired", "Caption", "request-expired", listOf(photo.id))
        disk.savePhoto("a", photo.id, bytes)
        disk.saveDraft("a", request.thread, CoachDraft(request.question, photo))
        val uploads = mutableListOf<String>()
        val requests = mutableListOf<AskQuestion>()
        val boundary = object : TrainingSyncing by FakeTraining() {
            override suspend fun uploadPhoto(threadId: String, value: CoachAttachment, body: ByteArray, onProgress: (Float) -> Unit): CoachAttachment {
                assertArrayEquals(bytes, body); uploads += value.id; return value
            }
            override suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit): AskAnswer {
                requests += question
                if (requests.size == 1) throw WindmillApiException.Refused(400, Refusal("Photo expired", code = "ask-attachment-invalid"))
                return AskGeneration("generation-expired", "request-expired", "Caption", "completed", "Photo received", attachments = listOf(photo)).response()
            }
        }
        val first = store(mapOf("a" to boundary), disk)
        first.connect(account("a"))
        assertEquals(AskOutcome.Failed("Photo wasn’t available. Retry to upload it again."),
            first.ask(request.thread, request.question, "request-expired", photo, stream = true))
        val restored = store(mapOf("a" to boundary), LocalCoach(file))
        restored.connect(account("a"))
        assertEquals(photo, restored.pendingExchange(request).attachments.single())
        assertTrue(restored.ask(request.thread, request.question, "request-expired", photo, stream = true) is AskOutcome.Answered)
        assertEquals(listOf(request, request), requests)
        assertEquals(listOf(photo.id, photo.id), uploads)
    }

    @Test
    fun interruptedStreamRetainsPhotoAndPartialResultsThenSameRequestCanStopWithoutRestart() = runTest {
        val file = File(tmp.root, "coach-stream")
        val disk = LocalCoach(file)
        val photo = CoachAttachment("attachment-a", "image/png", 1, 1, 3)
        val bytes = byteArrayOf(1, 2, 3)
        val request = AskQuestion("thread-a", "", "request-a", listOf(photo.id))
        val receipt = CoachResult("routine-created", "operation-a", "routine-a", "Upper body")
        val partial = AskGeneration("generation-a", "request-a", "", "running", "Created Upper", results = listOf(receipt),
            revision = 3, attachments = listOf(photo))
        disk.savePhoto("a", photo.id, bytes)
        disk.saveDraft("a", "thread-a", CoachDraft(photo = photo))
        val seen = mutableListOf<AskQuestion>()
        var uploads = 0
        val boundary = object : TrainingSyncing by FakeTraining() {
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
        val store = store(mapOf("a" to boundary), disk)
        store.connect(account("a"))
        val snapshots = mutableListOf<AskGeneration>()
        val failure = store.ask(request.thread, "", "request-a", photo, stream = true, onSnapshot = snapshots::add)
        assertEquals(partial, (failure as AskOutcome.Failed).generation)
        assertEquals(listOf(request), LocalCoach(file).pending("a"))
        assertEquals(partial, LocalCoach(file).snapshot("a", "request-a"))
        assertEquals(listOf(partial), snapshots)
        val restored = store(mapOf("a" to boundary), LocalCoach(file))
        restored.connect(account("a"))
        val answer = restored.ask(request.thread, "", "request-a", photo, stream = true) as AskOutcome.Answered
        assertEquals("stopped", answer.answer.generation?.status)
        assertEquals(Ask.stopped, answer.exchange(partial.exchange()).trouble)
        assertFalse(answer.exchange(partial.exchange()).again)
        assertEquals(listOf(receipt), answer.answer.results)
        assertEquals(listOf(request, request), seen)
        assertEquals(1, uploads)
        assertEquals(emptyList<AskQuestion>(), LocalCoach(file).pending("a"))
    }

    @Test
    fun lateStreamSnapshotsCannotWriteOrDisplayUnderAnotherAccount() = runTest {
        val file = File(tmp.root, "coach-owner")
        val release = CompletableDeferred<Unit>()
        val partial = AskGeneration("generation-a", "request-a", "Question", "completed", "Private", revision = 1)
        val boundary = object : TrainingSyncing by FakeTraining() {
            override suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit): AskAnswer {
                release.await(); onSnapshot(partial); return partial.response()
            }
        }
        val store = store(mapOf("a" to boundary, "b" to FakeTraining()), LocalCoach(file))
        store.connect(account("a"))
        val seen = mutableListOf<AskGeneration>()
        val result = async { store.ask("thread-a", "Question", "request-a", stream = true, onSnapshot = seen::add) }
        runCurrent()
        store.connect(account("b"))
        release.complete(Unit)
        assertEquals(AskOutcome.Refused("The account changed. Open this again."), result.await())
        assertEquals(emptyList<AskGeneration>(), seen)
        assertNull(LocalCoach(file).snapshot("b", "request-a"))
        assertEquals(listOf(AskQuestion("thread-a", "Question", "request-a")), LocalCoach(file).pending("a"))
    }

    @Test
    fun pendingRepliesReuseThePersistedIdentityAndOnlyCompletionClearsIt() = runTest {
        val file = File(tmp.root, "coach")
        val request = AskQuestion("thread-a", "Please create a routine", "request-a")
        val generation = AskGeneration("generation-a", "request-a", request.question, "running")
        val seen = mutableListOf<AskQuestion>()
        val boundary = object : TrainingSyncing by FakeTraining() {
            override suspend fun ask(question: AskQuestion): AskAnswer {
                assertEquals(listOf(request), LocalCoach(file).pending("a"))
                seen += question
                if (seen.size < 3) return AskAnswer("", ReadTally(), generation = generation)
                return AskAnswer("Created.", ReadTally(), generation = generation.copy(status = "completed"))
            }
        }
        val store = store(mapOf("a" to boundary), LocalCoach(file))
        store.connect(account("a"))
        assertTrue(store.ask(request.thread, request.question, requireNotNull(request.requestId)) is AskOutcome.Answered)
        assertEquals(listOf(request, request, request), seen)
        assertEquals(emptyList<AskQuestion>(), LocalCoach(file).pending("a"))
    }

    @Test
    fun failedReplyPreservesCreatedRoutineAndTheOriginalRequestForRetry() = runTest {
        val file = File(tmp.root, "coach")
        val request = AskQuestion("thread-a", "Please create a routine", "request-a")
        val result = CoachResult("routine-created", "operation-a", "routine-a", "Upper body")
        val generation = AskGeneration("generation-a", "request-a", request.question, "failed", results = listOf(result))
        val server = FakeTraining().apply {
            refuseAsk = WindmillApiException.Refused(502, Refusal("Response interrupted."))
            conversations[request.thread] = AskThread(request.thread, generation = generation)
        }
        val store = store(mapOf("a" to server), LocalCoach(file))
        store.connect(account("a"))
        assertEquals(AskOutcome.Failed("Response interrupted.", generation), store.ask(request.thread, request.question, "request-a"))
        assertEquals(listOf(request), LocalCoach(file).pending("a"))
        server.refuseAsk = WindmillApiException.Refused(429, Refusal(code = "ask-daily-limit"))
        assertEquals(AskOutcome.Capped(Ask.capReached, AskCap.Daily, generation), store.ask(request.thread, request.question, "request-a"))
        assertEquals(listOf(request), LocalCoach(file).pending("a"))
        assertEquals(generation, LocalCoach(file).snapshot("a", "request-a"))
        server.refuseAsk = null
        server.answers += AskAnswer("Created Upper body.", ReadTally(), generation = generation.copy(status = "completed"), results = listOf(result))
        assertTrue(store.ask(request.thread, request.question, "request-a") is AskOutcome.Answered)
        assertEquals(listOf(request, request, request), server.asked)
        assertEquals(emptyList<AskQuestion>(), LocalCoach(file).pending("a"))
    }

    @Test
    fun aLateAnswerAndThreadReadCannotAppearInTheNextAccount() = runTest {
        val release = CompletableDeferred<Unit>()
        val server = FakeTraining()
        val old = AskThread("thread-a", "A's question", turns = listOf(AskTurn("coach", "Private answer")))
        val boundary = object : TrainingSyncing by server {
            override suspend fun ask(question: AskQuestion): AskAnswer { release.await(); return AskAnswer("Private answer", ReadTally(3, 1, 1)) }
            override suspend fun threadPage(id: String, before: String?): AskThread { release.await(); return old }
            override suspend fun threadsPage(cursor: String?): ThreadPage { release.await(); return ThreadPage(listOf(old)) }
        }
        val store = store(mapOf("a" to boundary, "b" to FakeTraining()))
        store.connect(account("a"))
        val answer = async { store.ask("thread-a", "Question") }
        val detail = async { store.thread("thread-a") }
        val list = async { store.readThreads() }
        runCurrent()
        store.connect(account("b"))
        release.complete(Unit)
        assertEquals(AskOutcome.Refused("The account changed. Open this again."), answer.await())
        assertEquals(GymResult.Failed(WriteFailure.Refused("The account changed. Open this again.")), detail.await())
        assertEquals(GymResult.Failed(WriteFailure.Refused("The account changed. Open this again.")), list.await())
        assertEquals(emptyList<AskThread>(), store.allThreads)
    }

    @Test
    fun aStaleDecisionReadbackCannotReportItsVerdictAfterTheOwnerChanges() = runTest {
        for ((verb, code) in listOf(true to "proposal-superseded", false to "proposal-settled")) {
            val release = CompletableDeferred<Unit>()
            var holdRead = false
            val server = FakeTraining().apply {
                refuseApply = WindmillApiException.Refused(409, Refusal(message = "A's changed routine", code = code))
                refuseDismiss = refuseApply
            }
            val boundary = object : TrainingSyncing by server {
                override suspend fun routines(): List<Routine> { val answer = server.routines(); if (holdRead) release.await(); return answer }
            }
            val store = store(mapOf("a" to boundary, "b" to FakeTraining()))
            store.connect(account("a"))
            holdRead = true
            val result = async { if (verb) store.applyProposal("proposal-a") else store.dismissProposal("proposal-a") }
            runCurrent()
            store.connect(account("b"))
            release.complete(Unit)
            assertEquals(ProposalOutcome.Failed(WriteFailure.Refused("The account changed. Open this again.")), result.await())
            assertEquals(emptyMap<String, Proposal>(), store.settledProposals)
            assertEquals(emptyList<Routine>(), store.allRoutines)
        }
    }

    @Test
    fun notesReadSaveAndDeleteKeepOneAuthoritativeOrderAcrossHeldDeletion() = runTest {
        val first = Note("note-a", 1, "First", "Original")
        val second = Note("note-b", 2, "Second", "Keep")
        val third = Note("note-c", 3, "Third", "Last")
        val server = FakeTraining().apply { notebook += listOf(first, second, third) }
        val release = CompletableDeferred<Unit>()
        val boundary = object : TrainingSyncing by server {
            override suspend fun notes(): List<Note> { val answer = server.notes(); release.await(); return answer }
        }
        val store = store(mapOf("a" to boundary))
        store.connect(account("a"))
        val read = async { store.readNotes() }
        runCurrent()
        val save = async { store.saveNote(first.id, NoteWrite("First", "Accepted edit")) }
        runCurrent()
        assertFalse(save.isCompleted)
        release.complete(Unit)
        read.await()
        val saved = (save.await() as GymResult.Ok).value
        store.withhold(Deletion.Note(second.id))
        assertTrue(store.reorderNotes(listOf(third.id, third.id)) is GymResult.Failed)
        assertTrue(store.reorderNotes(listOf(third.id, first.id)) is GymResult.Ok)
        assertEquals(listOf(third.copy(position = 0), saved.copy(position = 2)), store.notes)
        assertEquals(3, store.noteCount)
        store.keepWithheld()
        assertEquals(listOf(third.copy(position = 0), second.copy(position = 1), saved.copy(position = 2)), store.notes)
    }

    @Test
    fun aLateSavedNoteCannotWriteOrCloseTheNextOwnersNotebook() = runTest {
        val release = CompletableDeferred<Unit>()
        val server = FakeTraining()
        val boundary = object : TrainingSyncing by server {
            override suspend fun writeNote(id: String, write: NoteWrite): Note { val answer = server.writeNote(id, write); release.await(); return answer }
        }
        val fresh = Note("note-b", 1, "B", "B's note")
        val store = store(mapOf("a" to boundary, "b" to FakeTraining().apply { notebook += fresh }))
        store.connect(account("a"))
        val save = async { store.saveNote("note-a", NoteWrite("A", "A's note")) }
        runCurrent()
        store.connect(account("b"))
        release.complete(Unit)
        assertEquals(GymResult.Failed(WriteFailure.Refused("The account changed. Open this again.")), save.await())
        store.readNotes()
        assertEquals(listOf(fresh), store.notes)
    }
}
