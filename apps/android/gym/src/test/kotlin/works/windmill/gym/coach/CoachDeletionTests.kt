package works.windmill.gym.coach

import java.io.File
import java.io.IOException
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.net.GymRest
import works.windmill.platform.storage.AtomicDocument
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.telemetry.Telemetry

@OptIn(ExperimentalCoroutinesApi::class)
class CoachDeletionTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun deletedOwnerEpochSurvivesRestartAndReopenPreservesOtherOwnersAndAnonymousIdentity() {
        val file = File(tmp.root, "owner-epochs")
        var blocked = false
        val disk = LocalCoach(file, writesAllowed = { !blocked })
        val anonymous = disk.anonymousOwner()
        disk.saveChat("alice", LocalChat("alice-chat"))
        disk.saveDraft("alice", "alice-chat", CoachDraft("Private draft"))
        disk.saveChat("bob", LocalChat("bob-chat"))
        disk.saveChat(anonymous, LocalChat("anonymous-chat"))
        val old = disk.admit("alice")
        blocked = true
        assertFalse(disk.current(old))
        assertThrows(CancellationException::class.java) { disk.saveDraft("alice", "alice-chat", CoachDraft("late")) }
        disk.eraseOwner("alice")
        blocked = false
        assertFalse(disk.current(old))
        assertThrows(CancellationException::class.java) { disk.admit("alice") }
        assertEquals(emptyList<LocalChat>(), disk.chats("alice"))
        val restored = LocalCoach(file)
        assertThrows(CancellationException::class.java) { restored.saveChat("alice", LocalChat("late")) }
        restored.reopenVerifiedOwner("alice")
        val accepted = restored.admit("alice")
        restored.reopenVerifiedOwner("alice")
        assertTrue(restored.current(accepted))
        assertFalse(restored.current(old))
        restored.withAuthority(accepted) { restored.saveChat("alice", LocalChat("new-chat")) }
        assertEquals(listOf("new-chat"), restored.chats("alice").map { it.id })
        assertEquals(listOf("bob-chat"), restored.chats("bob").map { it.id })
        assertEquals(listOf("anonymous-chat"), restored.chats(anonymous).map { it.id })
        assertEquals(anonymous, restored.anonymousOwner())
    }

    @Test fun committedThenThrownEraseAndReopenAreIdempotentWithoutRetiringNewAdmissions() {
        val file = File(tmp.root, "uncertain-owner-write")
        var fail = false
        val disk = LocalCoach(file, { target, value ->
            AtomicDocument.write(target, value)
            if (fail) { fail = false; throw IOException("commit completed") }
        })
        disk.saveChat("alice", LocalChat("old-chat"))
        val old = disk.admit("alice")
        fail = true; disk.eraseOwner("alice")
        fail = true; disk.reopenVerifiedOwner("alice")
        val accepted = disk.admit("alice")
        disk.reopenVerifiedOwner("alice")
        assertTrue(disk.current(accepted))
        assertFalse(disk.current(old))
    }

    @Test fun unreadableOwnerPublicationReconcilesOnlyDuringExactCleanupOrReopenRetry() {
        for (reopening in listOf(false, true)) for (after in listOf(false, true)) {
            val file = File(tmp.root, "uncertain-owner-$reopening-$after")
            val retained = File(tmp.root, "retained-owner-$reopening-$after")
            var fail = false
            var intended = ""
            val disk = LocalCoach(file) { target, value ->
                if (!fail) AtomicDocument.write(target, value)
                else {
                    fail = false
                    intended = value
                    if (after) AtomicDocument.write(target, value)
                    check(target.renameTo(retained))
                    check(target.mkdir())
                    throw IOException("owner publication unreadable")
                }
            }
            disk.saveChat("alice", LocalChat("old-chat"))
            disk.saveChat("bob", LocalChat("bob-chat"))
            val old = disk.admit("alice")
            if (reopening) disk.eraseOwner("alice")
            val before = file.readText()
            fail = true
            assertThrows(IOException::class.java) {
                if (reopening) disk.reopenVerifiedOwner("alice") else disk.eraseOwner("alice")
            }
            assertFalse(disk.writable("alice"))
            assertEquals(if (after) intended else before, retained.readText())
            assertTrue(file.delete()); assertTrue(retained.renameTo(file))
            assertThrows(CancellationException::class.java) { disk.saveChat("alice", LocalChat("forbidden")) }
            if (reopening) disk.reopenVerifiedOwner("alice") else disk.eraseOwner("alice")
            assertEquals(intended, file.readText())
            disk.reopenVerifiedOwner("alice")
            val accepted = disk.admit("alice")
            disk.reopenVerifiedOwner("alice")
            assertTrue(disk.current(accepted))
            assertFalse(disk.current(old))
            assertEquals(listOf("bob-chat"), disk.chats("bob").map { it.id })
            assertEquals(emptyList<LocalChat>(), disk.chats("alice"))
        }
    }

    @Test fun pendingDeletionAllowsArchiveReadsButPositionSelectionAndSendWriteNothing() = runTest {
        var blocked = false
        val disk = LocalCoach(File(tmp.root, "read-only-pending"), writesAllowed = { !blocked })
        val store = CoachStore({ "alice" }, { emptySet() }, {}, { FakeGymRest() }, disk, Telemetry.None, System::nanoTime, backgroundScope)
        store.freshChat(id = "chat-a")
        store.saveDraft("chat-a", CoachDraft("Retained draft"))
        val retained = disk.chats("alice")
        val projected = store.chat("chat-a")
        blocked = true
        store.keepPosition("chat-a", 50, false)
        store.selectChat("missing-chat")
        store.resumeChats()
        assertFalse(store.submit("chat-a", "No new write"))
        assertEquals(retained, disk.chats("alice"))
        assertEquals(projected, store.chat("chat-a"))
        assertEquals("chat-a", disk.selected("alice"))
        assertEquals(CoachDraft("Retained draft"), store.draft("chat-a"))
    }

    @Test fun deletionRemovesKeptDraftsAndChoicesWithoutChangingOtherOwners() {
        val file = File(tmp.root, "erase-draft-choices")
        val disk = LocalCoach(file)
        val phone = disk.anonymousOwner()
        disk.saveChat(phone, LocalChat("phone-chat"), true)
        disk.saveDraft(phone, "phone-chat", CoachDraft("Phone draft"))
        disk.saveChat("alice", LocalChat("alice-chat"), true)
        disk.saveChoice("alice", "alice-chat", "question", mapOf("group" to listOf("option")), CoachDraft("Alice draft"))
        disk.adoptPhoneDraft("alice") { true }
        assertEquals(1, disk.keptDrafts("alice", "alice-chat").size)
        disk.saveChat("bob", LocalChat("bob-chat"), true)
        disk.saveChoice("bob", "bob-chat", "question", mapOf("other" to listOf("value")), CoachDraft("Bob draft"))
        disk.eraseOwner("alice")
        val restored = LocalCoach(file)
        assertEquals(emptyList<KeptCoachDraft>(), restored.keptDrafts("alice", "alice-chat"))
        assertEquals(emptyMap<String, List<String>>(), restored.choices("alice", "alice-chat", "question"))
        assertEquals(CoachDraft("Bob draft"), restored.draft("bob", "bob-chat"))
        assertEquals(mapOf("other" to listOf("value")), restored.choices("bob", "bob-chat", "question"))
        assertEquals(phone, restored.anonymousOwner())
    }

    @Test fun queuedPhoneDraftAdoptionCannotEnterADeletedThenReopenedOwner() = runTest {
        val file = File(tmp.root, "late-adoption")
        val disk = LocalCoach(file)
        val phone = disk.anonymousOwner()
        val photo = CoachAttachment("phone-photo", "image/png", 1, 1, 3)
        disk.savePhoto(phone, photo.id, byteArrayOf(1, 2, 3))
        disk.saveChat(phone, LocalChat("phone-chat"), true)
        disk.saveDraft(phone, "phone-chat", CoachDraft("Phone draft", photo))
        val store = CoachStore({ "alice" }, { emptySet() }, {}, { FakeGymRest() }, disk, Telemetry.None, System::nanoTime,
            backgroundScope, StandardTestDispatcher(testScheduler))
        val adoption = async(start = CoroutineStart.UNDISPATCHED) { runCatching { store.adoptPhoneDraft("alice") } }
        store.eraseOwner("alice")
        disk.reopenVerifiedOwner("alice")
        store.freshChat(id = "new-chat")
        store.saveDraft("new-chat", CoachDraft("New account draft"))
        assertTrue(adoption.await().exceptionOrNull() is CancellationException)
        assertEquals(CoachDraft("Phone draft", photo), disk.draft(phone, "phone-chat"))
        assertEquals(CoachDraft("New account draft"), store.draft("new-chat"))
        assertEquals(emptyList<KeptCoachDraft>(), disk.keptDrafts("alice", "new-chat"))
        assertEquals(emptyList<String>(), disk.photoFile("alice", "directory-probe").parentFile!!.listFiles().orEmpty().map { it.name })
        store.adoptPhoneDraft("alice")
        assertEquals(CoachDraft(), disk.draft(phone, "phone-chat"))
        assertEquals(1, disk.keptDrafts("alice", "new-chat").size)
    }

    @Test fun lateReplyCannotRestoreDeletedArchiveAfterCleanupAndVerifiedReopen() = runTest {
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val api = object : GymRest by FakeGymRest() {
            override suspend fun ask(question: AskQuestion): AskAnswer {
                entered.complete(Unit)
                release.await()
                return AskGeneration("generation", "request-a", question.question, "completed", "Old reply", revision = 1).response()
            }
        }
        val disk = LocalCoach(File(tmp.root, "late-reply"))
        val store = CoachStore({ "alice" }, { emptySet() }, {}, { api }, disk, Telemetry.None, System::nanoTime,
            backgroundScope, StandardTestDispatcher(testScheduler))
        store.freshChat(id = "chat-a")
        val reply = async { runCatching { store.ask("chat-a", "Question", "request-a") } }
        entered.await()
        store.eraseOwner("alice")
        disk.reopenVerifiedOwner("alice")
        store.freshChat(id = "chat-a")
        store.saveDraft("chat-a", CoachDraft("New draft"))
        release.complete(Unit)
        assertTrue(reply.await().exceptionOrNull() is CancellationException)
        assertEquals(emptyList<AskExchange>(), disk.chats("alice").single().exchanges)
        assertEquals(CoachDraft("New draft"), disk.draft("alice", "chat-a"))
        assertTrue(disk.pending("alice").isEmpty())
    }

    @Test fun latePhotoAndRoutineConfirmationCannotWriteIntoReopenedOwner() = runTest {
        val photoEntered = CompletableDeferred<Unit>()
        val photoRelease = CompletableDeferred<Unit>()
        val confirmEntered = CompletableDeferred<Unit>()
        val confirmRelease = CompletableDeferred<Unit>()
        val draft = CoachRoutineDraft("operation-a", "routine-a", "Routine", 1, emptyList(), "pending")
        val generation = AskGeneration("generation-a", "request-a", "Question", "completed", revision = 3,
            routineDrafts = listOf(draft.copy(state = "saved")))
        val api = object : GymRest by FakeGymRest() {
            override suspend fun confirmRoutine(threadId: String, requestId: String, operationId: String): CoachRoutineConfirmation {
                confirmEntered.complete(Unit); confirmRelease.await()
                return CoachRoutineConfirmation(threadId, generation)
            }
        }
        val disk = LocalCoach(File(tmp.root, "late-photo-confirm"))
        var refreshes = 0
        val store = CoachStore({ "alice" }, { emptySet() }, { refreshes++ }, { api }, disk, Telemetry.None, System::nanoTime,
            backgroundScope, StandardTestDispatcher(testScheduler))
        store.freshChat(id = "chat-a")
        val photo = CoachAttachment("attachment-a", "image/png", 1, 1, 3)
        val importing = async { store.importPhoto("chat-a") {
            photoEntered.complete(Unit); photoRelease.await(); photo to byteArrayOf(1, 2, 3)
        } }
        val confirming = async { store.confirmRoutine("chat-a", "request-a", draft) }
        photoEntered.await(); confirmEntered.await()
        store.eraseOwner("alice"); disk.reopenVerifiedOwner("alice")
        store.freshChat(id = "chat-a"); store.saveDraft("chat-a", CoachDraft("New draft"))
        photoRelease.complete(Unit); confirmRelease.complete(Unit)
        importing.await()
        assertTrue(confirming.await() is DraftOutcome.Failed)
        assertEquals(CoachDraft("New draft"), disk.draft("alice", "chat-a"))
        assertFalse(disk.photoFile("alice", photo.id).exists())
        assertNull(disk.confirmed("alice", "request-a"))
        assertNull(store.confirmedGeneration("request-a"))
        assertEquals(0, refreshes)
    }
    @Test fun queuedTerminalRetirementCannotWriteAfterDeletionAndVerifiedReopen() = runTest {
        var holdWrites = false
        val held = ArrayDeque<Pair<CoroutineContext, Runnable>>()
        val delegate = StandardTestDispatcher(testScheduler)
        val storage = object : CoroutineDispatcher() {
            override fun dispatch(context: CoroutineContext, block: Runnable) {
                if (holdWrites) held.add(context to block) else delegate.dispatch(context, block)
            }
        }
        val api = object : GymRest by FakeGymRest() {
            override suspend fun ask(question: AskQuestion): AskAnswer {
                holdWrites = true
                throw WindmillApiException.Refused(429, Refusal(code = "ask-daily-limit"))
            }
        }
        val file = File(tmp.root, "late-terminal")
        val disk = LocalCoach(file)
        val store = CoachStore({ "alice" }, { emptySet() }, {}, { api }, disk, Telemetry.None, System::nanoTime,
            backgroundScope, storage)
        store.freshChat(id = "chat-a")
        val result = async { runCatching { store.ask("chat-a", "Old question", "request-a") } }
        runCurrent()
        assertEquals(1, held.size)
        assertFalse(result.isCompleted)
        store.eraseOwner("alice")
        disk.reopenVerifiedOwner("alice")
        store.freshChat(id = "chat-a")
        store.saveDraft("chat-a", CoachDraft("New draft"))
        val before = file.readBytes()
        holdWrites = false
        while (held.isNotEmpty()) {
            val (context, block) = held.removeFirst()
            delegate.dispatch(context, block)
        }
        assertTrue(result.await().exceptionOrNull() is CancellationException)
        assertArrayEquals(before, file.readBytes())
        assertEquals(emptyList<AskExchange>(), disk.chats("alice").single().exchanges)
        assertEquals(CoachDraft("New draft"), disk.draft("alice", "chat-a"))
        assertEquals(emptyList<AskQuestion>(), disk.pending("alice"))
    }

    @Test fun legacyTerminalRetirementWaitsForWritableStandingAndNeverPosts() = runTest {
        var blocked = false
        val file = File(tmp.root, "legacy-terminal-gate")
        val disk = LocalCoach(file, writesAllowed = { !blocked })
        val request = AskQuestion("chat-a", "Question", "request-a", purpose = "conversation")
        val chat = LocalChat("chat-a", exchanges = listOf(AskExchange(request.question,
            requestId = "request-a", trouble = "Any sentence", terminalRefusal = true)))
        disk.saveChat("alice", chat)
        disk.keep("alice", request)
        val api = FakeGymRest()
        val store = CoachStore({ "alice" }, { emptySet() }, {}, { api }, disk, Telemetry.None, System::nanoTime,
            backgroundScope, StandardTestDispatcher(testScheduler))
        val before = file.readBytes()
        blocked = true
        store.resumeChats(); runCurrent()
        assertArrayEquals(before, file.readBytes())
        assertEquals(listOf(request), disk.pending("alice"))
        assertEquals(emptyList<AskQuestion>(), api.asked)
        blocked = false
        store.resumeChats(); runCurrent()
        assertEquals(emptyList<AskQuestion>(), disk.pending("alice"))
        assertEquals(chat, disk.archivedChat("alice", "chat-a"))
        assertEquals(emptyList<AskQuestion>(), api.asked)
    }

    @Test fun terminalRetirementRechecksTheFenceAtItsAtomicWrite() {
        var remainingChecks: Int? = null
        val file = File(tmp.root, "terminal-commit-gate")
        val disk = LocalCoach(file, writesAllowed = {
            remainingChecks?.let { remainingChecks = it - 1; it > 0 } ?: true
        })
        val request = AskQuestion("chat-a", "Question", "request-a")
        val chat = LocalChat("chat-a", exchanges = listOf(AskExchange(request.question,
            requestId = "request-a", trouble = "Any sentence", terminalRefusal = true)))
        disk.saveChat("alice", chat)
        disk.keep("alice", request)
        val before = file.readBytes()
        remainingChecks = 1
        assertThrows(CancellationException::class.java) { disk.pauseRequest("alice", chat, "request-a") }
        assertArrayEquals(before, file.readBytes())
        assertEquals(listOf(request), LocalCoach(file).pending("alice"))
    }

}
