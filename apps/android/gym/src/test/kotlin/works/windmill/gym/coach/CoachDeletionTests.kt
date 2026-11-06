package works.windmill.gym.coach

import java.io.File
import java.io.IOException
import kotlin.coroutines.ContinuationInterceptor
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Runnable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
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
import works.windmill.agent.TurnOpen
import works.windmill.agent.TurnRefusal
import works.windmill.gym.coach.onboarding.CoachOnboardingRecord
import works.windmill.gym.coach.turn.ScriptedTurns
import works.windmill.gym.coach.turn.TellingRecorder
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.net.WindmillJson
import works.windmill.platform.storage.AtomicDocument
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.core.Json

@OptIn(ExperimentalCoroutinesApi::class)
class CoachDeletionTests {
    @get:Rule val tmp = TemporaryFolder()

    private fun chats(owner: () -> String?, disk: LocalCoach, scope: CoroutineScope, storage: CoroutineDispatcher) =
        CoachChats(owner, {}, null, null, disk, null, { AnonymousCoachAccess.Unavailable }, Telemetry.None, scope, storage)

    // Virtual time, one dispatcher: the test advances it, and closing the room ends its work.
    private fun TestScope.work() = CoroutineScope(SupervisorJob() + coroutineContext[ContinuationInterceptor] as CoroutineDispatcher)

    private fun answers(text: String) = ScriptedTurns(Json.parse("""[{"event":"text","data":{"delta":"$text"}},{"event":"done","data":{"state":"completed"}}]""").arr())

    @Test fun deletedOwnerEpochSurvivesRestartAndReopenPreservesOtherOwnersAndAnonymousIdentity() {
        val file = File(tmp.root, "owner-epochs")
        var blocked = false
        val disk = LocalCoach(file, writesAllowed = { !blocked })
        val anonymous = disk.anonymousOwner()
        disk.saveChat("alice", LocalChat("alice-chat", 1))
        disk.saveDraft("alice", "alice-chat", CoachDraft("Private draft"))
        disk.saveChat("bob", LocalChat("bob-chat", 1))
        disk.saveChat(anonymous, LocalChat("anonymous-chat", 1))
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
        assertThrows(CancellationException::class.java) { restored.saveChat("alice", LocalChat("late", 1)) }
        restored.reopenVerifiedOwner("alice")
        val accepted = restored.admit("alice")
        restored.reopenVerifiedOwner("alice")
        assertTrue(restored.current(accepted))
        assertFalse(restored.current(old))
        restored.withAuthority(accepted) { restored.saveChat("alice", LocalChat("new-chat", 1)) }
        assertEquals(listOf("new-chat"), restored.chats("alice").map { it.id })
        assertEquals(listOf("bob-chat"), restored.chats("bob").map { it.id })
        assertEquals(listOf("anonymous-chat"), restored.chats(anonymous).map { it.id })
        assertEquals(anonymous, restored.anonymousOwner())
    }

    @Test fun committedThenThrownEraseAndReopenAreIdempotentWithoutRetiringNewAdmissions() {
        val file = File(tmp.root, "uncertain-owner-write")
        var fail = false
        val disk = LocalCoach(file) { target, value ->
            AtomicDocument.write(target, value)
            if (fail) { fail = false; throw IOException("commit completed") }
        }
        disk.saveChat("alice", LocalChat("old-chat", 1))
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
            disk.saveChat("alice", LocalChat("old-chat", 1))
            disk.saveChat("bob", LocalChat("bob-chat", 1))
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
            assertThrows(CancellationException::class.java) { disk.saveChat("alice", LocalChat("forbidden", 1)) }
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
        val server = answers("No new write")
        EngineRoomFixture(tmp.newFolder(), work(), localCoach = disk, coachServer = server).use { room ->
            room.select("alice")
            room.sync(EngineRoomFixture.server())
            val store = room.store.coach
            store.freshChat(id = "chat-a")
            store.saveDraft("chat-a", CoachDraft("Retained draft"))
            val retained = disk.chats("alice")
            val projected = store.chat("chat-a")
            blocked = true
            store.keepPosition("chat-a", 50, false)
            store.selectChat("missing-chat")
            assertFalse(store.send("chat-a", "No new write"))
            advanceUntilIdle()
            assertEquals(retained, disk.chats("alice"))
            assertEquals(projected, store.chat("chat-a"))
            assertEquals("chat-a", disk.selected("alice"))
            assertEquals(CoachDraft("Retained draft"), store.draft("chat-a"))
            assertEquals(emptyList<TurnOpen>(), server.opened)
        }
    }

    @Test fun deletionRemovesKeptDraftsWithoutChangingOtherOwners() {
        val file = File(tmp.root, "erase-drafts")
        val disk = LocalCoach(file)
        val phone = disk.anonymousOwner()
        disk.saveChat(phone, LocalChat("phone-chat", 1), true)
        disk.saveDraft(phone, "phone-chat", CoachDraft("Phone draft"))
        disk.saveChat("alice", LocalChat("alice-chat", 1), true)
        disk.saveDraft("alice", "alice-chat", CoachDraft("Alice draft"))
        disk.adoptPhoneDraft("alice") { true }
        assertEquals(1, disk.keptDrafts("alice", "alice-chat").size)
        disk.saveChat("bob", LocalChat("bob-chat", 1), true)
        disk.saveDraft("bob", "bob-chat", CoachDraft("Bob draft"))
        disk.eraseOwner("alice")
        val restored = LocalCoach(file)
        assertEquals(emptyList<KeptCoachDraft>(), restored.keptDrafts("alice", "alice-chat"))
        assertEquals(CoachDraft(), restored.draft("alice", "alice-chat"))
        assertEquals(CoachDraft("Bob draft"), restored.draft("bob", "bob-chat"))
        assertEquals(phone, restored.anonymousOwner())
    }

    @Test fun retainedAnswersGoWithTheirChatOrTheirOwnerAndThePhotosOnlyTheyNamed() {
        val file = File(tmp.root, "erase-retained")
        val photo = CoachAttachment("retained-photo", "image/png", 1, 1, 3)
        val record = { owner: String, chat: String, id: String, attachment: CoachAttachment? -> WindmillJson.encodeToString(CoachOnboardingRecord.serializer(),
            CoachOnboardingRecord(owner, chat, "replica", id, "{\"text\":\"Plan me\"}", 5, attachment = attachment)) }
        file.writeText("""{"onboarding":{
            "alice":{"one":${record("alice", "chat-a", "one", photo)},"two":${record("alice", "chat-b", "two", null)}},
            "bob":{"three":${record("bob", "chat-c", "three", null)}}}}""")
        val disk = LocalCoach(file)
        disk.savePhoto("alice", photo.id, byteArrayOf(1, 2, 3))
        assertEquals(listOf("one"), disk.retained("alice", "chat-a").map { it.requestId })
        disk.saveDraft("alice", "chat-z", CoachDraft("Prune"))
        assertTrue("a save prunes only the photos nothing names", disk.photoFile("alice", photo.id).exists())

        disk.clear("alice", "chat-a")
        assertEquals(emptyList<CoachOnboardingRecord>(), LocalCoach(file).retained("alice", "chat-a"))
        assertEquals(listOf("two"), LocalCoach(file).retained("alice", "chat-b").map { it.requestId })
        assertFalse(disk.photoFile("alice", photo.id).exists())

        disk.eraseOwner("alice")
        assertEquals(emptyList<CoachOnboardingRecord>(), LocalCoach(file).retained("alice", "chat-b"))
        assertEquals(listOf("three"), LocalCoach(file).retained("bob", "chat-c").map { it.requestId })
    }

    @Test fun queuedPhoneDraftAdoptionCannotEnterADeletedThenReopenedOwner() = runTest {
        val file = File(tmp.root, "late-adoption")
        val disk = LocalCoach(file)
        val phone = disk.anonymousOwner()
        val photo = CoachAttachment("phone-photo", "image/png", 1, 1, 3)
        disk.savePhoto(phone, photo.id, byteArrayOf(1, 2, 3))
        disk.saveChat(phone, LocalChat("phone-chat", 1), true)
        disk.saveDraft(phone, "phone-chat", CoachDraft("Phone draft", photo))
        val store = chats({ "alice" }, disk, backgroundScope, StandardTestDispatcher(testScheduler))
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

    @Test fun aTurnOpenedAcrossAnEraseCannotReachTheChatOfTheReopenedOwner() = runTest {
        val telling = TellingRecorder()
        val disk = LocalCoach(File(tmp.root, "late-open"))
        EngineRoomFixture(tmp.newFolder(), work(), telemetry = telling, localCoach = disk, coachServer = answers("Old reply")).use { room ->
            room.select("alice")
            room.sync(EngineRoomFixture.server())
            val store = room.store.coach
            store.freshChat(id = "chat-a")
            telling.onEvent = { name, _ ->
                if (name == "gym_ask_started") {
                    store.eraseOwner("alice")
                    disk.reopenVerifiedOwner("alice")
                    store.freshChat(id = "chat-a")
                    store.saveDraft("chat-a", CoachDraft("New draft"))
                }
            }
            assertTrue(store.send("chat-a", "Question"))
            advanceUntilIdle()
            assertNull(disk.chat("alice", "chat-a")?.conversation)
            assertNull(store.chat("chat-a")?.conversation)
            assertEquals(CoachDraft("New draft"), disk.draft("alice", "chat-a"))
            assertEquals(CoachDraft("New draft"), store.draft("chat-a"))
        }
    }

    @Test fun aLatePhotoCannotWriteIntoAReopenedOwner() = runTest {
        val photoEntered = CompletableDeferred<Unit>()
        val photoRelease = CompletableDeferred<Unit>()
        val disk = LocalCoach(File(tmp.root, "late-photo"))
        val store = chats({ "alice" }, disk, backgroundScope, StandardTestDispatcher(testScheduler))
        store.freshChat(id = "chat-a")
        val photo = CoachAttachment("attachment-a", "image/png", 1, 1, 3)
        val importing = async { store.importPhoto("chat-a") {
            photoEntered.complete(Unit); photoRelease.await(); photo to byteArrayOf(1, 2, 3)
        } }
        photoEntered.await()
        store.eraseOwner("alice"); disk.reopenVerifiedOwner("alice")
        store.freshChat(id = "chat-a"); store.saveDraft("chat-a", CoachDraft("New draft"))
        photoRelease.complete(Unit)
        importing.await()
        assertEquals(CoachDraft("New draft"), disk.draft("alice", "chat-a"))
        assertFalse(disk.photoFile("alice", photo.id).exists())
    }

    @Test fun aQueuedWithdrawalCannotWriteAfterDeletionAndVerifiedReopen() = runTest {
        var holdWrites = true
        val held = ArrayDeque<Pair<CoroutineContext, Runnable>>()
        val delegate = StandardTestDispatcher(testScheduler)
        val storage = object : CoroutineDispatcher() {
            override fun dispatch(context: CoroutineContext, block: Runnable) {
                if (holdWrites) held.add(context to block) else delegate.dispatch(context, block)
            }
        }
        val server = answers("Never said").apply { refuseOpen = TurnRefusal(429, "subject_exhausted", null) }
        val file = File(tmp.root, "late-withdrawal")
        val disk = LocalCoach(file)
        EngineRoomFixture(tmp.newFolder(), work(), coachServer = server).use { room ->
            room.select("alice")
            room.sync(EngineRoomFixture.server())
            val store = CoachChats({ "alice" }, {}, room.store.conversations, room.coachTurns, disk, null, { AnonymousCoachAccess.Unavailable }, Telemetry.None, room.scope, storage)
            store.freshChat(id = "chat-a")
            assertTrue(store.send("chat-a", "Old question"))
            advanceUntilIdle()
            assertEquals(1, held.size)
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
            advanceUntilIdle()
            assertArrayEquals(before, file.readBytes())
            assertEquals(CoachDraft("New draft"), disk.draft("alice", "chat-a"))
            assertNull(disk.chat("alice", "chat-a")?.conversation)
        }
    }

    @Test fun anEarlierVersionsFileWaitsForWritableStandingBeforeItIsRewritten() {
        var blocked = false
        val file = File(tmp.root, "legacy-gate")
        file.writeText("""{"chats":{"alice":{"chat-a":{"id":"chat-a","createdAtMs":1,"exchanges":[{"question":"Private old question"}]}}},"drafts":{"alice":{"chat-b":{"text":"Keep me"}}}}""")
        val disk = LocalCoach(file, writesAllowed = { !blocked })
        val before = file.readBytes()
        blocked = true
        disk.settle()
        assertArrayEquals(before, file.readBytes())
        blocked = false
        disk.settle()
        assertFalse(file.readText().contains("Private old question"))
        assertEquals(CoachDraft("Keep me"), LocalCoach(file).draft("alice", "chat-b"))
    }

    @Test fun aTurnOpenedOrWithdrawnWritesNothingWhileTheOwnerMayNotWrite() {
        var blocked = false
        val file = File(tmp.root, "turn-fence")
        val disk = LocalCoach(file, writesAllowed = { !blocked })
        disk.saveChat("alice", LocalChat("chat-a", 1))
        disk.saveDraft("alice", "chat-a", CoachDraft("Draft"))
        val before = file.readBytes()
        blocked = true
        assertThrows(CancellationException::class.java) { disk.turnOpened("alice", "chat-a", "thr_1") }
        assertThrows(CancellationException::class.java) { disk.turnWithdrawn("alice", "chat-a", null, CoachDraft("Returned"), null) }
        assertArrayEquals(before, file.readBytes())
        assertEquals(CoachDraft("Draft"), LocalCoach(file).draft("alice", "chat-a"))
        assertNull(LocalCoach(file).chat("alice", "chat-a")?.conversation)
    }

    @Test fun aLateDeletionCannotTouchTheChatAfterOwnerChangeOrDeletion() = runTest {
        for (deleting in listOf(false, true)) {
            val file = File(tmp.root, "late-delete-$deleting")
            val disk = LocalCoach(file)
            var owner = "alice"
            disk.saveChat("alice", LocalChat("chat-a", 1))
            disk.saveChat("bob", LocalChat("bob-chat", 1))
            val store = chats({ owner }, disk, backgroundScope, StandardTestDispatcher(testScheduler))
            store.chat("chat-a")
            val deletion = async(start = CoroutineStart.UNDISPATCHED) { store.deleteThread("chat-a") }
            if (deleting) { store.eraseOwner("alice"); disk.reopenVerifiedOwner("alice") }
            else { owner = "bob"; store.forgetSeat() }
            val before = file.readText()
            assertEquals(GymResult.Failed(WriteFailure.Refused("The account changed. Open this again.")), deletion.await())
            assertEquals(before, file.readText())
            assertEquals(listOf("bob-chat"), LocalCoach(file).chats("bob").map { it.id })
            assertEquals(if (deleting) emptyList() else listOf("chat-a"), LocalCoach(file).chats("alice").map { it.id })
        }
    }
}
