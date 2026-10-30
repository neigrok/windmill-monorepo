package works.windmill.gym.coach

import java.io.File
import java.util.concurrent.ConcurrentLinkedDeque
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.ExperimentalCoroutinesApi
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.net.GymRest
import works.windmill.gym.store.GymResult
import works.windmill.platform.telemetry.Telemetry

@OptIn(ExperimentalCoroutinesApi::class)
class CoachRequestLifecycleTests {
    @get:Rule val tmp = TemporaryFolder()

    private fun TestScope.until(condition: () -> Boolean) {
        val deadline = System.nanoTime() + 5_000_000_000
        while (!condition() && System.nanoTime() < deadline) { runCurrent(); Thread.yield() }
        assertTrue("The controlled request reached its checkpoint", condition())
    }

    @Test fun aDelayedStopCannotRewriteOrCancelTheNextRequestOrItsSameIdRetry() = runTest {
        for (retry in listOf(false, true)) {
            val firstEntered = CompletableDeferred<Unit>()
            val releaseFirst = CompletableDeferred<Unit>()
            val stopEntered = CompletableDeferred<Unit>()
            val releaseStop = CompletableDeferred<Unit>()
            val secondEntered = CompletableDeferred<Unit>()
            val releaseSecond = CompletableDeferred<Unit>()
            var streams = 0
            val api = object : GymRest by FakeGymRest() {
                override suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit): AskAnswer {
                    streams++
                    if (streams == 1) {
                        firstEntered.complete(Unit)
                        releaseFirst.await()
                        return AskGeneration("generation-a", "request-a", question.question,
                            if (retry) "failed" else "completed", "First answer", revision = 1).response()
                    }
                    onSnapshot(AskGeneration("generation-b", requireNotNull(question.requestId), question.question,
                        "running", "Second partial", revision = 3))
                    secondEntered.complete(Unit)
                    releaseSecond.await()
                    return AskGeneration("generation-b", requireNotNull(question.requestId), question.question,
                        "completed", "Second answer", revision = 4).response()
                }
                override suspend fun stop(threadId: String, requestId: String): AskGeneration {
                    stopEntered.complete(Unit)
                    releaseStop.await()
                    return AskGeneration("generation-a", requestId, "Question A", "stopped", "Old stopped text", revision = 2)
                }
            }
            val file = File(tmp.root, "stop-$retry")
            val store = CoachStore({ "alice" }, { emptySet() }, {}, { api }, LocalCoach(file), Telemetry.None, System::nanoTime, backgroundScope)
            val chat = store.freshChat()
            assertTrue(store.submit(chat, "Question A", requestId = "request-a"))
            until { firstEntered.isCompleted }
            store.stopChat(chat)
            until { stopEntered.isCompleted }
            releaseFirst.complete(Unit)
            until { !store.isAsking(chat) }
            val nextRequest = if (retry) "request-a" else "request-b"
            val nextQuestion = if (retry) "Question A" else "Question B"
            assertTrue(store.submit(chat, nextQuestion, requestId = nextRequest))
            until { secondEntered.isCompleted }
            releaseStop.complete(Unit)
            runCurrent()
            assertTrue(store.isAsking(chat))
            assertEquals(nextRequest, store.chat(chat)?.exchanges?.last()?.requestId)
            assertEquals("Second partial", store.chat(chat)?.exchanges?.last()?.generation?.answer)
            releaseSecond.complete(Unit)
            until { !store.isAsking(chat) }
            assertEquals(if (retry) listOf("request-a") else listOf("request-a", "request-b"), store.chat(chat)?.exchanges?.map { it.requestId })
            assertEquals("Second answer", store.chat(chat)?.exchanges?.last()?.answer?.answer)
            assertEquals("Second answer", LocalCoach(file).chats("alice").single().exchanges.last().answer?.answer)
        }
    }

    @Test fun aSameIdRetrySurvivesAnOldStopQueuedBeforeSnapshotStorageOrBeforePendingClear() = runTest {
        for (beforeClear in listOf(false, true)) {
            val io = RequestQueue()
            val releaseFirst = CompletableDeferred<Unit>()
            val releaseSecond = CompletableDeferred<Unit>()
            val firstEntered = CompletableDeferred<Unit>()
            val secondEntered = CompletableDeferred<Unit>()
            var streams = 0
            val api = object : GymRest by FakeGymRest() {
                override suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit): AskAnswer {
                    streams++
                    if (streams == 1) {
                        firstEntered.complete(Unit)
                        releaseFirst.await()
                        return AskGeneration("generation-a", "request-a", question.question, "failed", "Failed attempt", revision = 3).response()
                    }
                    secondEntered.complete(Unit)
                    releaseSecond.await()
                    return AskGeneration("generation-a", "request-a", question.question, "completed", "Retry answer", revision = 4).response()
                }
                override suspend fun stop(threadId: String, requestId: String) =
                    AskGeneration("generation-a", requestId, "Question", "stopped", "Earlier stopped text", revision = 2)
            }
            val file = File(tmp.root, "stop-io-$beforeClear")
            val store = CoachStore({ "alice" }, { emptySet() }, {}, { api }, LocalCoach(file), Telemetry.None,
                System::nanoTime, backgroundScope, storageDispatcher = io)
            val chat = store.freshChat()
            assertTrue(store.submit(chat, "Question", requestId = "request-a"))
            runCurrent(); io.next(); runCurrent()
            assertTrue(firstEntered.isCompleted)
            store.stopChat(chat)
            runCurrent()
            assertTrue(io.ready)
            if (beforeClear) { io.next(); runCurrent(); assertTrue(io.ready) }
            releaseFirst.complete(Unit)
            runCurrent(); io.last(); runCurrent()
            assertFalse(store.isAsking(chat))
            assertTrue(store.submit(chat, "Question", requestId = "request-a"))
            runCurrent(); io.last(); runCurrent()
            assertTrue(secondEntered.isCompleted)
            val request = AskQuestion(chat, "Question", "request-a")
            assertEquals(listOf(request), LocalCoach(file).pending("alice"))
            io.next(); runCurrent()
            assertTrue(store.isAsking(chat))
            assertEquals(listOf(request), LocalCoach(file).pending("alice"))
            assertEquals("request-a", store.chat(chat)?.exchanges?.single()?.requestId)
            releaseSecond.complete(Unit)
            runCurrent(); io.next(); runCurrent(); io.next(); runCurrent()
            assertFalse(store.isAsking(chat))
            assertEquals("Retry answer", store.chat(chat)?.exchanges?.single()?.answer?.answer)
            assertEquals(emptyList<AskQuestion>(), LocalCoach(file).pending("alice"))
        }
    }

    @Test fun cancellingAnUploadRetainsRetryWithoutAutoResumeAndOldCleanupCannotEraseTheRetry() = runTest {
        val firstUpload = CompletableDeferred<Unit>()
        val secondUpload = CompletableDeferred<Unit>()
        val releaseSecond = CompletableDeferred<Unit>()
        var uploads = 0
        var sends = 0
        val api = object : GymRest by FakeGymRest() {
            override suspend fun uploadPhoto(threadId: String, photo: CoachAttachment, bytes: ByteArray, onProgress: (Float) -> Unit): CoachAttachment {
                uploads++
                if (uploads == 1) { firstUpload.complete(Unit); CompletableDeferred<Unit>().await() }
                secondUpload.complete(Unit)
                releaseSecond.await()
                return photo
            }
            override suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit): AskAnswer {
                sends++
                return AskGeneration("generation-a", requireNotNull(question.requestId), question.question, "completed", "Answer").response()
            }
        }
        val file = File(tmp.root, "cancel-upload")
        val disk = LocalCoach(file)
        val photo = CoachAttachment("attachment-a", "image/png", 1, 1, 3)
        disk.savePhoto("alice", photo.id, byteArrayOf(1, 2, 3))
        val store = CoachStore({ "alice" }, { emptySet() }, {}, { api }, disk, Telemetry.None, System::nanoTime, backgroundScope)
        val chat = store.freshChat()
        store.saveDraft(chat, CoachDraft("Question", photo))
        assertTrue(store.submit(chat, "Question", photo, "request-a"))
        until { firstUpload.isCompleted }
        store.stopChat(chat)
        assertFalse(store.isAsking(chat))
        val restored = CoachStore({ "alice" }, { emptySet() }, {}, { api }, LocalCoach(file), Telemetry.None, System::nanoTime, backgroundScope)
        assertEquals(emptyList<AskQuestion>(), restored.pendingQuestions())
        assertEquals(CoachDraft("Question", photo), restored.draft(chat))
        assertEquals("Upload cancelled. Retry to send this photo.", restored.chat(chat)?.exchanges?.single()?.trouble)
        assertEquals(true, restored.chat(chat)?.exchanges?.single()?.again)
        restored.resumeChats()
        assertEquals(1, uploads)
        assertEquals(0, sends)
        assertTrue(store.submit(chat, "Question", photo, "request-a"))
        until { secondUpload.isCompleted }
        assertTrue(store.isAsking(chat))
        assertEquals(0f, store.upload(chat))
        releaseSecond.complete(Unit)
        until { !store.isAsking(chat) }
        assertEquals(2, uploads)
        assertEquals(1, sends)
        assertEquals("Answer", store.chat(chat)?.exchanges?.single()?.answer?.answer)
    }

    @Test fun aCompletedHistoryRefreshCannotClearTheAdmittedSameIdRetry() = runTest {
        val releaseHistory = CompletableDeferred<Unit>()
        val releaseRetry = CompletableDeferred<Unit>()
        val io = RequestQueue()
        val api = object : GymRest by FakeGymRest() {
            override suspend fun thread(id: String, before: String?): AskThread {
                releaseHistory.await()
                return AskThread(id, "Question", generation = AskGeneration("generation-a", "request-a", "Question", "completed", "Old answer", revision = 2))
            }
            override suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit): AskAnswer {
                releaseRetry.await()
                return AskGeneration("generation-a", "request-a", "Question", "completed", "Retry answer", revision = 4).response()
            }
        }
        val file = File(tmp.root, "history-during-retry")
        val disk = LocalCoach(file)
        val request = AskQuestion("thread-a", "Question", "request-a")
        disk.saveChat("alice", LocalChat(request.thread))
        disk.keep("alice", request)
        disk.record("alice", AskGeneration("generation-a", "request-a", "Question", "failed", "Partial", revision = 3))
        val store = CoachStore({ "alice" }, { emptySet() }, {}, { api }, disk, Telemetry.None,
            System::nanoTime, backgroundScope, storageDispatcher = io)
        val reading = async { store.thread("thread-a") }
        runCurrent()
        assertTrue(store.submit("thread-a", "Question", requestId = "request-a"))
        runCurrent(); io.next(); runCurrent()
        releaseHistory.complete(Unit)
        runCurrent()
        assertTrue(reading.await() is GymResult.Ok)
        assertTrue(store.isAsking("thread-a"))
        assertEquals(listOf(request), LocalCoach(file).pending("alice"))
        releaseRetry.complete(Unit)
        runCurrent(); io.next(); runCurrent(); io.next(); runCurrent()
        assertFalse(store.isAsking("thread-a"))
        assertEquals("Retry answer", store.chat("thread-a")?.exchanges?.single()?.answer?.answer)
    }

    @Test fun photoRemovalPublishesOnlyAfterPersistenceAndKeepsAcceptedRequestAttachments() = runTest {
        val file = File(tmp.root, "photo-removal")
        var failWrites = false
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val failures = mutableListOf<String>()
        val disk = LocalCoach(file) { target, text ->
            if (failWrites) throw java.io.IOException("private storage detail")
            works.windmill.platform.storage.AtomicDocument.write(target, text)
        }
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        val store = CoachStore({ "alice" }, { emptySet() }, {}, { FakeGymRest() }, disk, telemetry,
            System::nanoTime, backgroundScope)
        val chat = store.freshChat("Retained caption")
        events.clear()
        val photo = CoachAttachment("attachment-one", "image/png", 1, 1, 3)
        val bytes = byteArrayOf(1, 2, 3)
        store.importPhoto(chat) { photo to bytes }
        assertEquals(listOf("gym_setup_step" to mapOf("screen" to "coach", "action" to "photo_selected")), events)
        val accepted = AskQuestion(chat, "Accepted question", "request-kept", listOf(photo.id))
        disk.keep("alice", accepted)
        events.clear()
        failWrites = true
        assertThrows(java.io.IOException::class.java) { store.removePhoto(chat) }
        val original = CoachDraft("Retained caption", photo)
        assertEquals(original, store.draft(chat))
        assertEquals(original, LocalCoach(file).draft("alice", chat))
        assertArrayEquals(bytes, disk.photoFile("alice", photo.id).readBytes())
        assertEquals(emptyList<Pair<String, Map<String, String>>>(), events)
        assertEquals(listOf("gym.saveDraft"), failures)
        failWrites = false
        store.removePhoto(chat)
        assertEquals(CoachDraft("Retained caption"), store.draft(chat))
        assertEquals(CoachDraft("Retained caption"), LocalCoach(file).draft("alice", chat))
        assertEquals(listOf(accepted), LocalCoach(file).pending("alice"))
        assertArrayEquals(bytes, disk.photoFile("alice", photo.id).readBytes())
        assertEquals(listOf("gym_setup_step" to mapOf("screen" to "coach", "action" to "photo_removed")), events)
        store.removePhoto(chat)
        assertEquals(1, events.size)
    }

    @Test fun photoPreparationFailureKeepsItsOriginalAccountBoundaryAndDraft() = runTest {
        val scope = CoroutineScope(SupervisorJob() + kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
        for (initialOwner in listOf(null, "alice")) {
            var owner = initialOwner
            val failures = mutableListOf<String>()
            val events = mutableListOf<String>()
            val telemetry = object : Telemetry {
                override fun event(name: String, properties: Map<String, String>) { events += name }
                override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
            }
            val disk = LocalCoach(File(tmp.root, "prepare-" + (initialOwner ?: "anonymous")))
            val store = CoachStore({ owner }, { emptySet() }, {}, { FakeGymRest() }, disk, telemetry,
                System::nanoTime, scope)
            val chat = store.freshChat("Keep this text")
            events.clear()
            val gate = CompletableDeferred<Unit>()
            val importing = async(start = CoroutineStart.UNDISPATCHED) {
                try { store.importPhoto(chat) { gate.await(); throw java.io.IOException("private photo detail") } }
                catch (_: java.io.IOException) { }
            }
            runCurrent()
            owner = if (initialOwner == null) "alice" else null
            gate.complete(Unit)
            importing.await()
            assertEquals(listOf(if (initialOwner == null) "gym.coachOnboarding" else "gym.preparePhoto"), failures)
            assertEquals(emptyList<String>(), events)
            owner = initialOwner
            assertEquals(CoachDraft("Keep this text"), store.draft(chat))
        }
        } finally { scope.cancel() }
    }

    @Test fun twoStoredImportsKeepBothDraftReferencesBeforeEitherMainPublication() = runTest {
        val main = RequestQueue()
        val io = RequestQueue()
        val scope = CoroutineScope(SupervisorJob() + main)
        try {
            val file = File(tmp.root, "two-imports")
            val disk = LocalCoach(file)
            val store = CoachStore({ "alice" }, { emptySet() }, {}, { FakeGymRest() }, disk, Telemetry.None,
                System::nanoTime, scope, storageDispatcher = io)
            val first = store.freshChat("First draft")
            val second = store.freshChat("Second draft")
            val firstPhoto = CoachAttachment("attachment-one", "image/png", 1, 1, 3)
            val secondPhoto = CoachAttachment("attachment-two", "image/png", 1, 1, 3)
            val one = async(start = CoroutineStart.UNDISPATCHED) { store.importPhoto(first) { firstPhoto to byteArrayOf(1, 2, 3) } }
            val two = async(start = CoroutineStart.UNDISPATCHED) { store.importPhoto(second) { secondPhoto to byteArrayOf(4, 5, 6) } }
            main.next(); main.next()
            io.next(); io.next()
            assertFalse(one.isCompleted)
            assertFalse(two.isCompleted)
            val restored = LocalCoach(file)
            assertEquals(CoachDraft("First draft", firstPhoto), restored.draft("alice", first))
            assertEquals(CoachDraft("Second draft", secondPhoto), restored.draft("alice", second))
            assertArrayEquals(byteArrayOf(1, 2, 3), disk.photoFile("alice", firstPhoto.id).readBytes())
            assertArrayEquals(byteArrayOf(4, 5, 6), disk.photoFile("alice", secondPhoto.id).readBytes())
            main.next(); main.next(); runCurrent()
            one.await(); two.await()
            val deletion = async(start = CoroutineStart.UNDISPATCHED) { store.deleteThread(first) }
            main.next()
            assertEquals(GymResult.Ok(Unit), deletion.await())
            assertFalse(disk.photoFile("alice", firstPhoto.id).exists())
            assertArrayEquals(byteArrayOf(4, 5, 6), disk.photoFile("alice", secondPhoto.id).readBytes())
            assertEquals(CoachDraft("Second draft", secondPhoto), LocalCoach(file).draft("alice", second))
        } finally { scope.cancel() }
    }

    @Test fun photoImportRecoversAnInitiallyUnpersistedChatBeforePublishingItsReference() = runTest {
        val file = File(tmp.root, "initial-chat-failure")
        var failNext = true
        val failures = mutableListOf<String>()
        val disk = LocalCoach(file) { target, text ->
            if (failNext) { failNext = false; throw java.io.IOException("private storage failure") }
            works.windmill.platform.storage.AtomicDocument.write(target, text)
        }
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {}
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        val store = CoachStore({ "alice" }, { emptySet() }, {}, { FakeGymRest() }, disk, telemetry, System::nanoTime, backgroundScope)
        val chat = store.freshChat()
        assertFalse(file.exists())
        val photo = CoachAttachment("attachment-one", "image/png", 1, 1, 3)
        store.importPhoto(chat) { photo to byteArrayOf(1, 2, 3) }
        assertEquals(CoachDraft(photo = photo), store.draft(chat))
        val restored = LocalCoach(file)
        assertEquals(listOf(chat), restored.chats("alice").map { it.id })
        assertEquals(CoachDraft(photo = photo), restored.draft("alice", chat))
        assertArrayEquals(byteArrayOf(1, 2, 3), restored.photoFile("alice", photo.id).readBytes())
        assertEquals(listOf("gym.saveConversation"), failures)
    }

    @Test fun deletingDuringPhotoPreparationNeverRecreatesTheOrigin() = runTest {
        val prepared = CompletableDeferred<Pair<CoachAttachment, ByteArray>>()
        val file = File(tmp.root, "deleted-preparing")
        val disk = LocalCoach(file)
        val store = CoachStore({ "alice" }, { emptySet() }, {}, { FakeGymRest() }, disk, Telemetry.None, System::nanoTime, backgroundScope)
        val chat = store.freshChat("Draft")
        val importing = async(start = CoroutineStart.UNDISPATCHED) { store.importPhoto(chat) { prepared.await() } }
        runCurrent()
        assertEquals(GymResult.Ok(Unit), store.deleteThread(chat))
        val photo = CoachAttachment("attachment-late", "image/png", 1, 1, 3)
        prepared.complete(photo to byteArrayOf(1, 2, 3))
        importing.await()
        assertNull(store.chat(chat))
        assertEquals(CoachDraft(), store.draft(chat))
        assertEquals(emptyList<LocalChat>(), LocalCoach(file).chats("alice"))
        assertFalse(disk.photoFile("alice", photo.id).exists())
    }

    @Test fun deletingAfterPhotoStoragePrunesTheLateFileAndKeepsAnotherChatsReferencedPhoto() = runTest {
        val dispatcher = RequestQueue()
        val scope = CoroutineScope(SupervisorJob() + dispatcher)
        try {
            val file = File(tmp.root, "deleted-stored")
            val disk = LocalCoach(file)
            val store = CoachStore({ "alice" }, { emptySet() }, {}, { FakeGymRest() }, disk, Telemetry.None, System::nanoTime, scope)
            val origin = store.freshChat("Delete this draft")
            val other = store.freshChat("Keep this draft")
            val kept = CoachAttachment("attachment-kept", "image/png", 1, 1, 3)
            disk.savePhoto("alice", kept.id, byteArrayOf(4, 5, 6))
            store.saveDraft(other, CoachDraft("Keep this draft", kept))
            val late = CoachAttachment("attachment-late", "image/png", 1, 1, 3)
            val importing = async(start = CoroutineStart.UNDISPATCHED) { store.importPhoto(origin) { late to byteArrayOf(1, 2, 3) } }
            dispatcher.next()
            val deadline = System.nanoTime() + 5_000_000_000
            while ((!disk.photoFile("alice", late.id).isFile || !dispatcher.ready) && System.nanoTime() < deadline) Thread.yield()
            assertTrue(disk.photoFile("alice", late.id).isFile)
            assertTrue(dispatcher.ready)
            val deleting = async(start = CoroutineStart.UNDISPATCHED) { store.deleteThread(origin) }
            dispatcher.last()
            assertEquals(GymResult.Ok(Unit), deleting.await())
            dispatcher.next()
            while (!importing.isCompleted && System.nanoTime() < deadline) { dispatcher.next(); runCurrent(); Thread.yield() }
            assertTrue(importing.isCompleted)
            importing.await()
            assertNull(store.chat(origin))
            assertEquals(CoachDraft(), store.draft(origin))
            assertFalse(disk.photoFile("alice", late.id).exists())
            assertArrayEquals(byteArrayOf(4, 5, 6), disk.photoFile("alice", kept.id).readBytes())
            assertEquals(listOf(other), LocalCoach(file).chats("alice").map { it.id })
            assertEquals(CoachDraft("Keep this draft", kept), LocalCoach(file).draft("alice", other))
        } finally { scope.cancel() }
    }
}

private class RequestQueue : CoroutineDispatcher() {
    private val queued = ConcurrentLinkedDeque<Runnable>()
    val ready: Boolean get() = queued.isNotEmpty()
    override fun dispatch(context: CoroutineContext, block: Runnable) { queued.addLast(block) }
    fun next() { queued.pollFirst()?.run() }
    fun last() { queued.pollLast()?.run() }
}
