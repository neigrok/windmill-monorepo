package works.windmill.gym.coach

import java.io.File
import java.util.concurrent.ConcurrentLinkedDeque
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Runnable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.coach.turn.TellingRecorder
import works.windmill.gym.store.GymResult
import works.windmill.platform.storage.AtomicDocument
import works.windmill.platform.telemetry.Telemetry

@OptIn(ExperimentalCoroutinesApi::class)
class CoachDraftPhotoTests {
    @get:Rule val tmp = TemporaryFolder()

    private fun chats(owner: () -> String?, disk: LocalCoach, scope: CoroutineScope, storage: CoroutineDispatcher = Dispatchers.IO, telemetry: Telemetry = Telemetry.None) =
        CoachChats(owner, {}, null, null, disk, null, { AnonymousCoachAccess.Unavailable }, telemetry, scope, storage)

    @Test fun photoRemovalPublishesOnlyAfterPersistenceAndItsFileGoesWithTheLastReference() = runTest {
        val file = File(tmp.root, "photo-removal")
        var failWrites = false
        val telling = TellingRecorder()
        val disk = LocalCoach(file) { target, text ->
            if (failWrites) throw java.io.IOException("private storage detail")
            AtomicDocument.write(target, text)
        }
        val store = chats({ "alice" }, disk, backgroundScope, telemetry = telling)
        val chat = store.freshChat("Retained caption")
        telling.events.clear()
        val photo = CoachAttachment("attachment-one", "image/png", 1, 1, 3)
        val bytes = byteArrayOf(1, 2, 3)
        store.importPhoto(chat) { photo to bytes }
        assertEquals(listOf("gym_setup_step" to mapOf("screen" to "coach", "action" to "photo_selected")), telling.events.toList())
        telling.events.clear()
        failWrites = true
        assertThrows(java.io.IOException::class.java) { store.removePhoto(chat) }
        val original = CoachDraft("Retained caption", photo)
        assertEquals(original, store.draft(chat))
        assertEquals(original, LocalCoach(file).draft("alice", chat))
        assertArrayEquals(bytes, disk.photoFile("alice", photo.id).readBytes())
        assertEquals(emptyList<Pair<String, Map<String, String>>>(), telling.events.toList())
        assertEquals(listOf(mapOf("operation" to "gym.saveDraft")), telling.failures.toList())
        failWrites = false
        store.removePhoto(chat)
        assertEquals(CoachDraft("Retained caption"), store.draft(chat))
        assertEquals(CoachDraft("Retained caption"), LocalCoach(file).draft("alice", chat))
        assertFalse(disk.photoFile("alice", photo.id).exists())
        assertEquals(listOf("gym_setup_step" to mapOf("screen" to "coach", "action" to "photo_removed")), telling.events.toList())
        store.removePhoto(chat)
        assertEquals(1, telling.events.size)
    }

    @Test fun photoPreparationFailureKeepsItsOriginalAccountBoundaryAndDraft() = runTest {
        val scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        try {
            for (initialOwner in listOf(null, "alice")) {
                var owner = initialOwner
                val telling = TellingRecorder()
                val disk = LocalCoach(File(tmp.root, "prepare-" + (initialOwner ?: "anonymous")))
                val store = chats({ owner }, disk, scope, telemetry = telling)
                val chat = store.freshChat("Keep this text")
                telling.events.clear()
                val gate = CompletableDeferred<Unit>()
                val importing = async(start = CoroutineStart.UNDISPATCHED) {
                    try { store.importPhoto(chat) { gate.await(); throw java.io.IOException("private photo detail") } }
                    catch (_: java.io.IOException) { }
                }
                runCurrent()
                owner = if (initialOwner == null) "alice" else null
                gate.complete(Unit)
                importing.await()
                assertEquals(listOf(mapOf("operation" to "gym.preparePhoto")), telling.failures.toList())
                assertEquals(emptyList<Pair<String, Map<String, String>>>(), telling.events.toList())
                owner = initialOwner
                assertEquals(CoachDraft("Keep this text"), store.draft(chat))
            }
        } finally { scope.cancel() }
    }

    @Test fun twoStoredImportsKeepBothDraftReferencesBeforeEitherMainPublication() = runTest {
        val main = PhotoQueue()
        val io = PhotoQueue()
        val scope = CoroutineScope(SupervisorJob() + main)
        try {
            val file = File(tmp.root, "two-imports")
            val disk = LocalCoach(file)
            val store = chats({ "alice" }, disk, scope, storage = io)
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
        val telling = TellingRecorder()
        val disk = LocalCoach(file) { target, text ->
            if (failNext) { failNext = false; throw java.io.IOException("private storage failure") }
            AtomicDocument.write(target, text)
        }
        val store = chats({ "alice" }, disk, backgroundScope, telemetry = telling)
        val chat = store.freshChat()
        assertFalse(file.exists())
        val photo = CoachAttachment("attachment-one", "image/png", 1, 1, 3)
        store.importPhoto(chat) { photo to byteArrayOf(1, 2, 3) }
        assertEquals(CoachDraft(photo = photo), store.draft(chat))
        val restored = LocalCoach(file)
        assertEquals(listOf(chat), restored.chats("alice").map { it.id })
        assertEquals(CoachDraft(photo = photo), restored.draft("alice", chat))
        assertArrayEquals(byteArrayOf(1, 2, 3), restored.photoFile("alice", photo.id).readBytes())
        assertEquals(listOf(mapOf("operation" to "gym.saveConversation")), telling.failures.toList())
    }

    @Test fun deletingDuringPhotoPreparationNeverRecreatesTheOrigin() = runTest {
        val prepared = CompletableDeferred<Pair<CoachAttachment, ByteArray>>()
        val file = File(tmp.root, "deleted-preparing")
        val disk = LocalCoach(file)
        val store = chats({ "alice" }, disk, backgroundScope)
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
        val dispatcher = PhotoQueue()
        val scope = CoroutineScope(SupervisorJob() + dispatcher)
        try {
            val file = File(tmp.root, "deleted-stored")
            val disk = LocalCoach(file)
            val store = chats({ "alice" }, disk, scope)
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
            val deletion = async(start = CoroutineStart.UNDISPATCHED) { store.deleteThread(origin) }
            dispatcher.last()
            assertEquals(GymResult.Ok(Unit), deletion.await())
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

private class PhotoQueue : CoroutineDispatcher() {
    private val queued = ConcurrentLinkedDeque<Runnable>()
    val ready: Boolean get() = queued.isNotEmpty()
    override fun dispatch(context: CoroutineContext, block: Runnable) { queued.addLast(block) }
    fun next() { queued.pollFirst()?.run() }
    fun last() { queued.pollLast()?.run() }
}
