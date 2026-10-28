package works.windmill.gym.coach

import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.net.GymRest
import works.windmill.gym.store.GymResult
import works.windmill.platform.storage.AtomicDocument
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.Refusal
import works.windmill.platform.telemetry.Telemetry

@OptIn(ExperimentalCoroutinesApi::class)
class CoachChatTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun freshChatRetainsThePreviousDraftPhotoPositionAndSelectionAcrossRestart() = runTest {
        val file = File(tmp.root, "coach")
        val disk = LocalCoach(file)
        val store = CoachStore({ "alice" }, { emptySet() }, {}, { FakeGymRest() }, disk, Telemetry.None, System::nanoTime, backgroundScope)
        val first = store.freshChat()
        val photo = CoachAttachment("attachment-a", "image/png", 1, 1, 3)
        disk.savePhoto("alice", photo.id, byteArrayOf(1, 2, 3))
        store.saveDraft(first, CoachDraft("A meaningful draft", photo))
        store.keepPosition(first, 124, false)
        val second = store.freshChat()
        assertNotEquals(first, second)
        assertEquals(CoachDraft(), store.draft(second))
        assertEquals(listOf(first), store.allThreads.map { it.id })
        store.selectChat(first)
        val restored = CoachStore({ "alice" }, { emptySet() }, {}, { FakeGymRest() }, LocalCoach(file), Telemetry.None, System::nanoTime, backgroundScope)
        assertEquals(first, restored.selectedChatId)
        assertEquals(CoachDraft("A meaningful draft", photo), restored.draft(first))
        assertEquals(124, restored.chat(first)?.scroll)
        assertEquals(false, restored.chat(first)?.followEnd)
        assertArrayEquals(byteArrayOf(1, 2, 3), LocalCoach(file).photoFile("alice", photo.id).readBytes())
    }

    @Test fun aReplyArrivesInItsOriginWhileANewChatKeepsItsOwnDraft() = runTest {
        val started = CompletableDeferred<AskQuestion>()
        val release = CompletableDeferred<Unit>()
        val api = object : GymRest by FakeGymRest() {
            override suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit): AskAnswer {
                started.complete(question)
                val partial = AskGeneration("generation-a", requireNotNull(question.requestId), question.question, "running", "First", revision = 1)
                onSnapshot(partial)
                release.await()
                return partial.copy(status = "completed", answer = "First answer", revision = 2).response()
            }
        }
        val file = File(tmp.root, "pending")
        val store = CoachStore({ "alice" }, { emptySet() }, {}, { api }, LocalCoach(file), Telemetry.None, System::nanoTime, backgroundScope)
        val first = store.freshChat()
        assertTrue(store.submit(first, "First question", requestId = "request-a"))
        runCurrent()
        assertEquals(AskQuestion(first, "First question", "request-a"), started.await())
        val second = store.freshChat()
        store.saveDraft(second, CoachDraft("Second draft"))
        assertEquals(first, store.pendingChat(second)?.id)
        assertTrue(store.isAsking(first))
        release.complete(Unit)
        while (store.isAsking(first)) { runCurrent(); Thread.yield() }
        assertEquals(second, store.selectedChatId)
        assertEquals(CoachDraft("Second draft"), store.draft(second))
        assertEquals("First answer", store.chat(first)?.exchanges?.single()?.answer?.answer)
        assertEquals(emptyList<AskExchange>(), store.chat(second)?.exchanges)
        assertEquals("First answer", LocalCoach(file).chats("alice").first { it.id == first }.exchanges.single().answer?.answer)
    }

    @Test fun anonymousHistoryNeverCallsTheServerAndAccountArchivesStayIsolated() = runTest {
        var owner: String? = null
        var serverCalls = 0
        val file = File(tmp.root, "owners")
        val api = object : GymRest by FakeGymRest() {
            override suspend fun threads(cursor: String?): ThreadPage { serverCalls++; error("No signed-out server history") }
        }
        val disk = LocalCoach(file)
        val store = CoachStore({ owner }, { emptySet() }, {}, { api }, disk, Telemetry.None, System::nanoTime, backgroundScope)
        val anonymous = store.freshChat()
        store.saveDraft(anonymous, CoachDraft("Anonymous draft"))
        val anonymousOwner = disk.anonymousOwner()
        owner = "alice"
        val alice = store.freshChat()
        store.saveDraft(alice, CoachDraft("Alice draft"))
        owner = "bob"
        assertEquals(emptyList<AskThread>(), store.allThreads)
        assertEquals(CoachDraft(), store.draft(alice))
        assertNull(store.chat(anonymous))
        owner = null
        assertEquals(GymResult.Ok(store.allThreads), store.readThreads())
        assertEquals(listOf(anonymous), store.allThreads.map { it.id })
        assertEquals(anonymousOwner, LocalCoach(file).anonymousOwner())
        assertEquals(0, serverCalls)
        owner = "alice"
        assertEquals(listOf(alice), store.allThreads.map { it.id })
        assertEquals(CoachDraft("Alice draft"), store.draft(alice))
    }

    @Test fun localDraftAndServerConversationMergeIntoOneHistoryRow() = runTest {
        val api = object : GymRest by FakeGymRest() {
            var id = ""
            override suspend fun threads(cursor: String?) = ThreadPage(listOf(AskThread(id, "Server first question", askedAtMs = 10)))
        }
        val store = CoachStore({ "alice" }, { emptySet() }, {}, { api }, LocalCoach(File(tmp.root, "merge")), Telemetry.None, System::nanoTime, backgroundScope)
        val id = store.freshChat()
        store.saveDraft(id, CoachDraft("Still typing"))
        api.id = id
        assertTrue(store.readThreads() is GymResult.Ok)
        assertEquals(listOf(id), store.allThreads.map { it.id })
        assertEquals(CoachDraft("Still typing"), store.draft(id))
    }

    @Test fun cachedServerSummariesSurviveOfflineRestartAndNeverAppearForAnotherOwner() = runTest {
        var owner: String? = "alice"
        val file = File(tmp.root, "cached-history")
        val summary = AskThread("thread-a", "First question", askedAtMs = 10, answerPreview = "Completed answer")
        val api = FakeGymRest().apply { conversations[summary.id] = summary }
        val store = CoachStore({ owner }, { emptySet() }, {}, { api }, LocalCoach(file), Telemetry.None, System::nanoTime, backgroundScope)
        assertEquals(GymResult.Ok(listOf(summary)), store.readThreads())
        owner = "bob"
        assertEquals(emptyList<AskThread>(), store.allThreads)
        owner = null
        assertEquals(emptyList<AskThread>(), store.allThreads)
        owner = "alice"
        val restored = CoachStore({ owner }, { emptySet() }, {}, { null }, LocalCoach(file), Telemetry.None, System::nanoTime, backgroundScope)
        assertEquals(listOf(summary), restored.allThreads)
        assertTrue(restored.readThreads() is GymResult.Failed)
        assertEquals(listOf(summary), restored.allThreads)
    }

    @Test fun restartResumesTheOriginalRequestWithoutChangingTheSelectedDraft() = runTest {
        val file = File(tmp.root, "restart-pending")
        val disk = LocalCoach(file)
        val request = AskQuestion("origin", "Original question", "request-a")
        disk.saveChat("alice", LocalChat(request.thread))
        disk.keep("alice", request)
        disk.record("alice", AskGeneration("generation-a", "request-a", request.question, "running", "Partial", revision = 1))
        disk.saveChat("alice", LocalChat("selected"), select = true)
        disk.saveDraft("alice", "selected", CoachDraft("Keep editing"))
        val calls = mutableListOf<AskQuestion>()
        val api = object : GymRest by FakeGymRest() {
            override suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit): AskAnswer {
                calls += question
                return AskGeneration("generation-a", "request-a", question.question, "completed", "Complete", revision = 2).response()
            }
        }
        val store = CoachStore({ "alice" }, { emptySet() }, {}, { api }, LocalCoach(file), Telemetry.None, System::nanoTime, backgroundScope)
        store.resumeChats()
        val deadline = System.nanoTime() + 5_000_000_000
        while (store.isAsking("origin") && System.nanoTime() < deadline) { runCurrent(); Thread.yield() }
        assertFalse(store.isAsking("origin"))
        assertEquals(listOf(request), calls)
        assertEquals("selected", store.selectedChatId)
        assertEquals(CoachDraft("Keep editing"), store.draft("selected"))
        assertEquals("Complete", store.chat("origin")?.exchanges?.single()?.answer?.answer)
        assertEquals(emptyList<AskQuestion>(), LocalCoach(file).pending("alice"))
    }

    @Test fun loadedOlderMessagesAndManualScrollSurviveRestartAndNewestPageRefresh() = runTest {
        val file = File(tmp.root, "paged-restart")
        fun page(request: String, position: Long, older: String?) = AskThread("thread-a", "First question",
            turns = listOf(AskTurn(Ask.fromLifter, "Question $request", position = position, requestId = request),
                AskTurn("coach", "Answer $request", position = position + 1, requestId = request)), nextCursor = older)
        val latest = page("new", 3, "older")
        val old = page("old", 1, null)
        val api = object : GymRest by FakeGymRest() {
            override suspend fun thread(id: String, before: String?) = if (before == null) latest else old
        }
        val store = CoachStore({ "alice" }, { emptySet() }, {}, { api }, LocalCoach(file), Telemetry.None, System::nanoTime, backgroundScope)
        store.selectChat("thread-a")
        assertTrue(store.thread("thread-a") is GymResult.Ok)
        assertEquals(GymResult.Ok(Unit), store.readOlderChat("thread-a", "older"))
        store.keepPosition("thread-a", 140, false)
        val restored = CoachStore({ "alice" }, { emptySet() }, {}, { api }, LocalCoach(file), Telemetry.None, System::nanoTime, backgroundScope)
        assertTrue(restored.thread("thread-a") is GymResult.Ok)
        assertEquals(listOf("old", "new"), restored.chat("thread-a")?.exchanges?.map { it.requestId })
        assertEquals(listOf(1L, 3L), restored.chat("thread-a")?.exchanges?.map { it.position })
        assertEquals(140, restored.chat("thread-a")?.scroll)
        assertEquals(false, restored.chat("thread-a")?.followEnd)
        assertEquals("thread-a", restored.selectedChatId)
    }

    @Test fun repeatedOverlappingPagesAndRefreshRetainTheOldestCursorAndCanonicalHeadline() = runTest {
        val file = File(tmp.root, "overlapping-pages")
        fun pair(position: Long, request: String = "") = listOf(
            AskTurn(Ask.fromLifter, "Repeated question", position = position, requestId = request),
            AskTurn("coach", "Repeated answer", position = position + 1, requestId = request),
        )
        val latest = AskThread("thread-a", "Original first question", turns = pair(40, "new"), nextCursor = "40")
        val middle = latest.copy(turns = pair(20) + pair(30) + pair(40, "new"), nextCursor = "20")
        val first = latest.copy(turns = pair(10) + pair(20), nextCursor = null)
        val calls = mutableListOf<String?>()
        val api = object : GymRest by FakeGymRest() {
            override suspend fun thread(id: String, before: String?): AskThread {
                calls += before
                return when (before) { "40" -> middle; "20" -> first; else -> latest }
            }
        }
        val store = CoachStore({ "alice" }, { emptySet() }, {}, { api }, LocalCoach(file), Telemetry.None, System::nanoTime, backgroundScope)
        store.selectChat("thread-a")
        assertTrue(store.thread("thread-a") is GymResult.Ok)
        assertEquals("Original first question", store.allThreads.single().title)
        assertEquals(GymResult.Ok(Unit), store.readOlderChat("thread-a", "40"))
        assertEquals(GymResult.Ok(Unit), store.readOlderChat("thread-a", "40"))
        assertEquals(listOf(null, "40"), calls)
        assertTrue(store.thread("thread-a") is GymResult.Ok)
        assertEquals("20", store.chat("thread-a")?.history?.nextCursor)
        val restored = CoachStore({ "alice" }, { emptySet() }, {}, { api }, LocalCoach(file), Telemetry.None, System::nanoTime, backgroundScope)
        assertTrue(restored.thread("thread-a") is GymResult.Ok)
        assertEquals("20", restored.chat("thread-a")?.history?.nextCursor)
        assertEquals(GymResult.Ok(Unit), restored.readOlderChat("thread-a", "20"))
        assertEquals(GymResult.Ok(Unit), restored.readOlderChat("thread-a", "20"))
        assertTrue(restored.thread("thread-a") is GymResult.Ok)
        assertEquals(listOf(null, "40", null, null, "20", null), calls)
        assertNull(restored.chat("thread-a")?.history?.nextCursor)
        assertEquals((pair(10) + pair(20) + pair(30) + pair(40, "new")).let { latest.copy(turns = it).exchanges() },
            restored.chat("thread-a")?.exchanges)
        assertEquals("Original first question", restored.allThreads.single().title)
        assertEquals("Original first question", LocalCoach(file).chats("alice").single().title)
    }

    @Test fun localDraftDeletionNeverUsesTransportAndAQueuedOwnerChangeRefusesIt() = runTest {
        var owner: String? = "alice"
        var transports = 0
        val store = CoachStore({ owner }, { emptySet() }, {}, { transports++; FakeGymRest() },
            LocalCoach(File(tmp.root, "local-delete")), Telemetry.None, System::nanoTime, backgroundScope)
        val draft = store.freshChat("Draft to delete")
        assertEquals(GymResult.Ok(Unit), store.deleteThread(draft))
        assertEquals(0, transports)
        assertNull(store.chat(draft))
        val retained = store.freshChat("Alice draft")
        val deletion = async(start = CoroutineStart.UNDISPATCHED) { store.deleteThread(retained) }
        owner = "bob"
        runCurrent()
        assertTrue(deletion.await() is GymResult.Failed)
        assertEquals(0, transports)
        assertNull(store.chat(retained))
        owner = "alice"
        assertEquals(CoachDraft("Alice draft"), store.draft(retained))
    }

    @Test fun aServer404CompletesDeletionAndLeavingTheScreenDoesNotCancelAnAdmittedDelete() = runTest {
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val api = object : GymRest by FakeGymRest() {
            override suspend fun deleteThread(id: String) {
                entered.complete(Unit)
                release.await()
                throw WindmillApiException.Refused(404, Refusal())
            }
        }
        val file = File(tmp.root, "server-delete")
        val disk = LocalCoach(file)
        disk.saveChat("alice", LocalChat("thread-a", history = AskThread("thread-a", "Server question")))
        val outcomes = mutableListOf<Map<String, String>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { outcomes += properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { fail(operation) }
        }
        val store = CoachStore({ "alice" }, { emptySet() }, {}, { api }, disk, telemetry, System::nanoTime, backgroundScope)
        val screen = launch { store.deleteThread("thread-a") }
        runCurrent()
        entered.await()
        screen.cancel()
        release.complete(Unit)
        runCurrent()
        assertNull(store.chat("thread-a"))
        assertEquals(emptyList<LocalChat>(), LocalCoach(file).chats("alice"))
        assertEquals(listOf(mapOf("screen" to "threads", "action" to "delete", "outcome" to "ok")), outcomes)
    }

    @Test fun failedDraftPersistenceKeepsTheRecoverableTextAndReportsOneStaticBoundary() = runTest {
        var failWrites = false
        val failures = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {}
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        val disk = LocalCoach(File(tmp.root, "failed")) { file, text ->
            if (failWrites) throw java.io.IOException("private draft must not reach telemetry")
            AtomicDocument.write(file, text)
        }
        val store = CoachStore({ "alice" }, { emptySet() }, {}, { FakeGymRest() }, disk, telemetry, System::nanoTime, backgroundScope)
        val id = store.freshChat()
        failWrites = true
        assertThrows(java.io.IOException::class.java) { store.saveDraft(id, CoachDraft("Recover me")) }
        assertEquals(CoachDraft("Recover me"), store.draft(id))
        assertEquals(listOf("gym.saveDraft"), failures)
        failWrites = false
        store.saveDraft(id, CoachDraft("Recover me"))
        assertEquals(CoachDraft("Recover me"), LocalCoach(File(tmp.root, "failed")).draft("alice", id))
    }
    @Test fun aQueuedSubmissionCannotResolveTransportFromTheNextAccount() = runTest {
        var owner: String? = "alice"
        val calls = mutableListOf<String?>()
        val file = File(tmp.root, "queued-ask")
        val store = CoachStore({ owner }, { emptySet() }, {}, {
            calls += owner
            FakeGymRest()
        }, LocalCoach(file), Telemetry.None, System::nanoTime, backgroundScope)
        val id = store.freshChat()
        assertTrue(store.submit(id, "Alice private draft", requestId = "request-a"))
        owner = "bob"
        runCurrent()
        assertEquals(emptyList<String?>(), calls)
        assertNull(store.chat(id))
        assertEquals(CoachDraft(), store.draft(id))
        owner = "alice"
        assertEquals(CoachDraft("Alice private draft"), store.draft(id))
        assertEquals("Alice private draft", store.chat(id)?.exchanges?.single()?.question)
        assertFalse(store.isAsking(id))
    }

    @Test fun queuedResumeAndStopCannotUseTheNextAccountsTransport() = runTest {
        var owner: String? = "alice"
        var transports = 0
        val file = File(tmp.root, "queued-resume")
        val disk = LocalCoach(file)
        val request = AskQuestion("thread-a", "Alice question", "request-a")
        disk.keep("alice", request)
        disk.saveDraft("alice", request.thread, CoachDraft(request.question))
        val store = CoachStore({ owner }, { emptySet() }, {}, { transports++; FakeGymRest() },
            disk, Telemetry.None, System::nanoTime, backgroundScope)
        store.resumeChats()
        owner = "bob"
        runCurrent()
        assertEquals(0, transports)
        owner = "alice"
        store.stopChat(request.thread)
        owner = "bob"
        runCurrent()
        assertEquals(0, transports)
        assertEquals(CoachDraft("Alice question"), LocalCoach(file).draft("alice", request.thread))
    }

    @Test fun aFailedHistoryArchiveWriteReportsOnceAndRetainsTheReceivedSummary() = runTest {
        var failNext = false
        val failures = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {}
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        val disk = LocalCoach(File(tmp.root, "history-write")) { file, text ->
            if (failNext) { failNext = false; throw java.io.IOException("private local content") }
            AtomicDocument.write(file, text)
        }
        val api = FakeGymRest().apply { conversations["thread-a"] = AskThread("thread-a", "First question", askedAtMs = 10) }
        val store = CoachStore({ "alice" }, { emptySet() }, {}, { api }, disk, telemetry, System::nanoTime, backgroundScope)
        failNext = true
        assertTrue(store.readThreads() is GymResult.Ok)
        assertEquals(listOf("thread-a"), store.allThreads.map { it.id })
        assertEquals("First question", store.chat("thread-a")?.history?.title)
        assertEquals(listOf("gym.saveConversation"), failures)
    }

    @Test fun aFailedFinalAnswerArchiveWriteKeepsTheAnswerAndItsAnsweredOutcome() = runTest {
        var failFinal = true
        val failures = mutableListOf<String>()
        val outcomes = mutableListOf<Map<String, String>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {
                if (name == "gym_ask_outcome") outcomes += properties.filterKeys { it != "duration_ms" }
            }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        val disk = LocalCoach(File(tmp.root, "answer-write")) { file, text ->
            if (failFinal && text.contains("Final answer")) { failFinal = false; throw java.io.IOException("private local content") }
            AtomicDocument.write(file, text)
        }
        val api = object : GymRest by FakeGymRest() {
            override suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit) = AskAnswer("Final answer", ReadTally())
        }
        val store = CoachStore({ "alice" }, { emptySet() }, {}, { api }, disk, telemetry, System::nanoTime, backgroundScope)
        val id = store.freshChat()
        assertTrue(store.submit(id, "Question", requestId = "request-a"))
        val deadline = System.nanoTime() + 5_000_000_000
        while (store.isAsking(id) && System.nanoTime() < deadline) { runCurrent(); Thread.yield() }
        assertFalse(store.isAsking(id))
        assertEquals("Final answer", store.chat(id)?.exchanges?.single()?.answer?.answer)
        assertEquals(listOf(mapOf("outcome" to "answered")), outcomes)
        assertEquals(listOf("gym.saveConversation"), failures)
    }

    @Test fun snapshotPersistenceFailureReportsOnceAndKeepsTheReceivedAnswerInItsChat() = runTest {
        var failSnapshot = false
        val failures = mutableListOf<String>()
        val outcomes = mutableListOf<Map<String, String>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {
                if (name == "gym_ask_outcome") outcomes += properties.filterKeys { it != "duration_ms" }
            }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        val file = File(tmp.root, "snapshot-failure")
        val disk = LocalCoach(file) { target, text ->
            if (failSnapshot) { failSnapshot = false; throw java.io.IOException("private local content") }
            AtomicDocument.write(target, text)
        }
        lateinit var store: CoachStore
        var chat = ""
        val api = object : GymRest by FakeGymRest() {
            override suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit): AskAnswer {
                val partial = AskGeneration("generation-a", requireNotNull(question.requestId), question.question,
                    "running", "Partial answer", revision = 1)
                failSnapshot = true
                onSnapshot(partial)
                assertEquals("Partial answer", store.chat(chat)?.exchanges?.single()?.generation?.answer)
                return partial.copy(status = "completed", answer = "Final answer", revision = 2).response()
            }
        }
        store = CoachStore({ "alice" }, { emptySet() }, {}, { api }, disk, telemetry, System::nanoTime, backgroundScope)
        chat = store.freshChat()
        assertTrue(store.submit(chat, "Question", requestId = "request-a"))
        val deadline = System.nanoTime() + 5_000_000_000
        while (store.isAsking(chat) && System.nanoTime() < deadline) { runCurrent(); Thread.yield() }
        assertFalse(store.isAsking(chat))
        assertEquals("Final answer", store.chat(chat)?.exchanges?.single()?.answer?.answer)
        assertEquals("Final answer", LocalCoach(file).chats("alice").single().exchanges.single().answer?.answer)
        assertEquals(listOf(mapOf("outcome" to "answered")), outcomes)
        assertEquals(listOf("gym.saveConversation"), failures)
    }

}
