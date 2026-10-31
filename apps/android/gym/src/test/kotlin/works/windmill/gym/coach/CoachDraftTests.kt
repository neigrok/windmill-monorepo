package works.windmill.gym.coach

import java.io.File
import java.io.IOException
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.net.GymRest
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson
import works.windmill.platform.storage.AtomicDocument
import works.windmill.platform.telemetry.Telemetry

@OptIn(ExperimentalCoroutinesApi::class)
class CoachDraftTests {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun adoptionAndSwappingKeepWholeDraftsPhotosAndPendingRequestsAcrossOwnersAndReopen() {
        val file = File(temporary.root, "drafts.json")
        val local = LocalCoach(file)
        val phone = local.anonymousOwner()
        val source = LocalChat("phone-chat", setup = true)
        val target = LocalChat("account-chat")
        local.saveChat(phone, source, true); local.saveChat("alice", target, true)
        val photo = CoachAttachment("same-photo", "image/png", 1, 1, 3)
        val phoneDraft = CoachDraft("Phone text", photo)
        val accountDraft = CoachDraft("Account text", photo)
        local.savePhoto(phone, photo.id, byteArrayOf(1, 2, 3)); local.saveDraft(phone, source.id, phoneDraft)
        local.savePhoto("alice", photo.id, byteArrayOf(4, 5, 6)); local.saveDraft("alice", target.id, accountDraft)
        val phoneRequest = AskQuestion(source.id, "Phone pending", "phone-request", listOf(photo.id))
        val accountRequest = AskQuestion(target.id, "Account pending", "account-request", listOf(photo.id))
        local.keep(phone, phoneRequest); local.keep("alice", accountRequest)
        assertEquals(CoachDraftMove(phone, source.id, target.id), local.adoptPhoneDraft("alice") { true })
        val restored = LocalCoach(file)
        assertEquals(CoachDraft(), restored.draft(phone, source.id))
        assertEquals(accountDraft, restored.draft("alice", target.id))
        val held = restored.keptDrafts("alice", target.id).single()
        val adopted = held.draft
        assertEquals(phoneDraft.copy(photo = photo.copy(id = adopted.photo!!.id), setup = true), adopted)
        assertNotEquals(photo.id, adopted.photo.id)
        assertArrayEquals(byteArrayOf(1, 2, 3), restored.photoFile("alice", adopted.photo.id).readBytes())
        assertArrayEquals(byteArrayOf(4, 5, 6), restored.photoFile("alice", photo.id).readBytes())
        assertArrayEquals(byteArrayOf(1, 2, 3), restored.photoFile(phone, photo.id).readBytes())
        assertEquals(listOf(phoneRequest), restored.pending(phone)); assertEquals(listOf(accountRequest), restored.pending("alice"))
        assertNull(restored.adoptPhoneDraft("bob") { true }); assertNull(restored.adoptPhoneDraft("alice") { true })
        assertEquals(listOf(held), restored.keptDrafts("alice", target.id))
        assertEquals(emptyList<LocalChat>(), restored.chats("bob"))
        assertTrue(restored.continueDraft("alice", target.id, held.id))
        assertEquals(adopted, LocalCoach(file).draft("alice", target.id))
        assertEquals(listOf(held.copy(draft = accountDraft)), LocalCoach(file).keptDrafts("alice", target.id))
        assertTrue(restored.continueDraft("alice", target.id, held.id))
        assertEquals(accountDraft, restored.draft("alice", target.id))
        assertEquals(listOf(held), restored.keptDrafts("alice", target.id))
        restored.saveDraft("alice", target.id, CoachDraft())
        assertArrayEquals(byteArrayOf(1, 2, 3), restored.photoFile("alice", adopted.photo.id).readBytes())
        restored.clear("alice", target.id)
        assertEquals(emptyList<KeptCoachDraft>(), LocalCoach(file).keptDrafts("alice", target.id))
        assertFalse(restored.photoFile("alice", adopted.photo.id).exists())
        assertArrayEquals(byteArrayOf(1, 2, 3), restored.photoFile(phone, photo.id).readBytes())
    }

    @Test fun anEmptyAccountDraftAdoptsDirectlyButAnAcceptedRequestKeepsThePhoneDraftHeld() {
        for (pending in listOf(false, true)) {
            val file = File(temporary.root, "empty-$pending.json")
            val local = LocalCoach(file)
            val phone = local.anonymousOwner()
            local.saveChat(phone, LocalChat("phone-chat", setup = true), true)
            local.saveDraft(phone, "phone-chat", CoachDraft("Phone draft"))
            local.saveChat("alice", LocalChat("account-chat"), true)
            val request = AskQuestion("account-chat", "Already accepted", "request-id")
            if (pending) local.keep("alice", request)
            local.adoptPhoneDraft("alice") { true }
            val restored = LocalCoach(file)
            assertEquals(CoachDraft(), restored.draft(phone, "phone-chat"))
            assertEquals(if (pending) CoachDraft() else CoachDraft("Phone draft", setup = true), restored.draft("alice", "account-chat"))
            assertEquals(if (pending) listOf(CoachDraft("Phone draft", setup = true)) else emptyList<CoachDraft>(),
                restored.keptDrafts("alice", "account-chat").map { it.draft })
            assertEquals(if (pending) listOf(request) else emptyList<AskQuestion>(), restored.pending("alice"))
        }
    }

    @Test fun failedDocumentPublicationAndChangedOwnerKeepBothOriginalDraftsAndRemoveOnlyTheNewCopy() {
        val file = File(temporary.root, "failed-move.json")
        var fail = false
        val local = LocalCoach(file) { target, text -> if (fail) throw IOException("private document failure") else AtomicDocument.write(target, text) }
        val phone = local.anonymousOwner()
        local.saveChat(phone, LocalChat("phone-chat"), true); local.saveChat("alice", LocalChat("account-chat"), true)
        val photo = CoachAttachment("photo-origin", "image/png", 1, 1, 3)
        val source = CoachDraft("Phone", photo)
        val target = CoachDraft("Account")
        local.savePhoto(phone, photo.id, byteArrayOf(1, 2, 3)); local.saveDraft(phone, "phone-chat", source)
        local.saveDraft("alice", "account-chat", target)
        val bytes = file.readBytes()
        fail = true
        assertThrows(IOException::class.java) { local.adoptPhoneDraft("alice") { true } }
        assertArrayEquals(bytes, file.readBytes())
        fail = false
        assertNull(local.adoptPhoneDraft("alice") { false })
        assertArrayEquals(bytes, file.readBytes())
        assertEquals(source, local.draft(phone, "phone-chat")); assertEquals(target, local.draft("alice", "account-chat"))
        assertEquals(emptyList<KeptCoachDraft>(), local.keptDrafts("alice", "account-chat"))
        assertEquals(emptyList<String>(), local.photoFile("alice", "directory-probe").parentFile!!.listFiles().orEmpty().map { it.name })
        assertArrayEquals(byteArrayOf(1, 2, 3), local.photoFile(phone, photo.id).readBytes())
        assertNotNull(local.adoptPhoneDraft("alice") { true })
        assertEquals(1, local.keptDrafts("alice", "account-chat").size)
    }

    @Test fun failedPhotoCopyKeepsTheOnlySourceAndDoesNotPublishAHeldReference() {
        val file = File(temporary.root, "failed-copy.json")
        val local = LocalCoach(file)
        val phone = local.anonymousOwner()
        local.saveChat(phone, LocalChat("phone-chat"), true); local.saveChat("alice", LocalChat("account-chat"), true)
        val photo = CoachAttachment("photo-origin", "image/png", 1, 1, 3)
        val source = CoachDraft(photo = photo)
        local.savePhoto(phone, photo.id, byteArrayOf(1, 2, 3)); local.saveDraft(phone, "phone-chat", source)
        val targetDirectory = local.photoFile("alice", "directory-probe").parentFile!!
        targetDirectory.parentFile!!.mkdirs(); targetDirectory.writeText("blocked")
        val before = file.readBytes()
        assertThrows(IllegalStateException::class.java) { local.adoptPhoneDraft("alice") { true } }
        assertArrayEquals(before, file.readBytes())
        assertEquals(source, LocalCoach(file).draft(phone, "phone-chat"))
        assertEquals(CoachDraft(), LocalCoach(file).draft("alice", "account-chat"))
        assertEquals(emptyList<KeptCoachDraft>(), local.keptDrafts("alice", "account-chat"))
    }

    @Test fun failedContinueKeepsBothDraftsAndPhotoOnlyDraftCanContinueWithoutAnEmptyCard() {
        val file = File(temporary.root, "continue.json")
        var fail = false
        val local = LocalCoach(file) { target, text -> if (fail) throw IOException("private save failure") else AtomicDocument.write(target, text) }
        val phone = local.anonymousOwner()
        local.saveChat(phone, LocalChat("phone-chat"), true); local.saveChat("alice", LocalChat("account-chat"), true)
        val photo = CoachAttachment("photo-origin", "image/png", 1, 1, 3)
        local.savePhoto(phone, photo.id, byteArrayOf(1, 2, 3)); local.saveDraft(phone, "phone-chat", CoachDraft(photo = photo))
        local.saveDraft("alice", "account-chat", CoachDraft("Account draft"))
        local.adoptPhoneDraft("alice") { true }
        val held = local.keptDrafts("alice", "account-chat").single()
        val before = file.readBytes()
        fail = true
        assertThrows(IOException::class.java) { local.continueDraft("alice", "account-chat", held.id) }
        assertArrayEquals(before, file.readBytes()); assertEquals(CoachDraft("Account draft"), local.draft("alice", "account-chat"))
        assertEquals(listOf(held), local.keptDrafts("alice", "account-chat"))
        fail = false
        local.saveDraft("alice", "account-chat", CoachDraft())
        assertTrue(local.continueDraft("alice", "account-chat", held.id))
        assertEquals(held.draft, LocalCoach(file).draft("alice", "account-chat"))
        assertEquals(emptyList<KeptCoachDraft>(), LocalCoach(file).keptDrafts("alice", "account-chat"))
        assertArrayEquals(byteArrayOf(1, 2, 3), local.photoFile("alice", held.draft.photo!!.id).readBytes())
    }

    @Test fun ownerChangesIncludingAReturnToTheSameAccountRetireQueuedPhotoAdoption() = runTest {
        for (returns in listOf(false, true)) {
            val file = File(temporary.root, "deferred-$returns.json")
            val local = LocalCoach(file)
            val phone = local.anonymousOwner()
            val photo = CoachAttachment("phone-photo", "image/png", 1, 1, 3)
            local.savePhoto(phone, photo.id, byteArrayOf(1, 2, 3))
            local.saveChat(phone, LocalChat("phone-chat"), true); local.saveDraft(phone, "phone-chat", CoachDraft("Phone", photo))
            var owner: String? = "alice"
            val store = CoachStore({ owner }, { emptySet() }, {}, { FakeGymRest() }, local, Telemetry.None, System::nanoTime,
                backgroundScope, StandardTestDispatcher(testScheduler))
            val adoption = async(start = CoroutineStart.UNDISPATCHED) { store.adoptPhoneDraft("alice") }
            owner = "bob"; store.resetThreads()
            if (returns) { owner = "alice"; store.resetThreads() }
            runCurrent(); adoption.await()
            assertEquals(CoachDraft("Phone", photo), LocalCoach(file).draft(phone, "phone-chat"))
            assertEquals(emptyList<LocalChat>(), local.chats("alice")); assertEquals(emptyList<LocalChat>(), local.chats("bob"))
            assertArrayEquals(byteArrayOf(1, 2, 3), local.photoFile(phone, photo.id).readBytes())
            assertEquals(emptyList<String>(), local.photoFile("alice", "directory-probe").parentFile!!.listFiles().orEmpty().map { it.name })
        }
    }

    @Test fun aPublishedWriteThatThrowsReconcilesAdoptionChoiceAndSwapWithoutRepeatingTheMutation() {
        val file = File(temporary.root, "published.json")
        var failAfterPublish = false
        val reports = mutableListOf<String>()
        val local = LocalCoach(file) { target, text ->
            AtomicDocument.write(target, text)
            if (failAfterPublish) throw IOException("directory sync failed")
        }
        val phone = local.anonymousOwner()
        val photo = CoachAttachment("phone-photo", "image/png", 1, 1, 3)
        local.savePhoto(phone, photo.id, byteArrayOf(1, 2, 3))
        local.saveChat(phone, LocalChat("phone-chat"), true); local.saveDraft(phone, "phone-chat", CoachDraft("Phone", photo))
        local.saveChat("alice", LocalChat("account-chat"), true); local.saveDraft("alice", "account-chat", CoachDraft("Account"))
        failAfterPublish = true
        assertNotNull(local.adoptPhoneDraft("alice", { reports += "adopt" }) { true })
        val held = local.keptDrafts("alice", "account-chat").single()
        assertArrayEquals(byteArrayOf(1, 2, 3), local.photoFile("alice", held.draft.photo!!.id).readBytes())
        assertEquals(listOf(held), LocalCoach(file).keptDrafts("alice", "account-chat"))
        assertNull(local.adoptPhoneDraft("alice", { error("No repeated publication") }) { true })
        assertTrue(local.continueDraft("alice", "account-chat", held.id) { reports += "continue" })
        assertEquals(held.draft, local.draft("alice", "account-chat"))
        assertEquals(held.draft, LocalCoach(file).draft("alice", "account-chat"))
        assertEquals(listOf(held.copy(draft = CoachDraft("Account"))), LocalCoach(file).keptDrafts("alice", "account-chat"))
        val selected = mapOf("days" to listOf("three"))
        val draft = held.draft.copy(text = "3 days.")
        local.saveChoice("alice", "account-chat", "request:clarification", selected, draft) { reports += "choose" }
        assertEquals(selected, LocalCoach(file).choices("alice", "account-chat", "request:clarification"))
        assertEquals(draft, LocalCoach(file).draft("alice", "account-chat"))
        assertEquals(listOf("adopt", "continue", "choose"), reports)
    }

    @Test fun unreadablePublicationRetainsTheCopiedPhotoAndReloadsBeforeAnotherMutation() {
        val file = File(temporary.root, "uncertain.json")
        val published = File(temporary.root, "published-copy.json")
        var unreadable = false
        val local = LocalCoach(file) { target, text ->
            AtomicDocument.write(target, text)
            if (unreadable) {
                target.renameTo(published)
                target.mkdir()
                throw IOException("unreadable publication")
            }
        }
        val phone = local.anonymousOwner()
        val photo = CoachAttachment("phone-photo", "image/png", 1, 1, 3)
        local.savePhoto(phone, photo.id, byteArrayOf(1, 2, 3))
        local.saveChat(phone, LocalChat("phone-chat"), true); local.saveDraft(phone, "phone-chat", CoachDraft("Phone", photo))
        unreadable = true
        assertThrows(IOException::class.java) { local.adoptPhoneDraft("alice") { true } }
        val files = local.photoFile("alice", "directory-probe").parentFile!!.listFiles().orEmpty()
        assertEquals(1, files.size); assertArrayEquals(byteArrayOf(1, 2, 3), files.single().readBytes())
        assertThrows(IOException::class.java) { local.saveDraft("alice", "unrelated", CoachDraft("Must wait")) }
        assertTrue(file.delete()); assertTrue(published.renameTo(file)); unreadable = false
        assertNull(local.adoptPhoneDraft("alice") { true })
        val target = local.selected("alice")!!
        assertEquals("Phone", local.draft("alice", target).text)
        assertEquals(CoachDraft(), local.draft(phone, "phone-chat"))
        assertArrayEquals(byteArrayOf(1, 2, 3), local.photoFile("alice", local.draft("alice", target).photo!!.id).readBytes())
    }

    @Test fun retryingTheSameVisibleChoiceOrContinueReconcilesAnUnreadablePublicationBeforeFlushingOrTogglingAgain() = runTest {
        for (action in listOf("choose", "continue_draft")) {
            val file = File(temporary.root, "$action-retry.json")
            val published = File(temporary.root, "$action-published.json")
            var unreadable = false
            val local = LocalCoach(file) { target, text ->
                AtomicDocument.write(target, text)
                if (unreadable) {
                    check(target.renameTo(published)); check(target.mkdir())
                    throw IOException("unreadable publication")
                }
            }
            val phone = local.anonymousOwner()
            local.saveChat(phone, LocalChat("phone-chat"), true); local.saveDraft(phone, "phone-chat", CoachDraft("Phone"))
            val clarification = CoachClarification("choice-123", "Days?", listOf(CoachClarification.Group("days", "Days", false,
                listOf(CoachClarification.Option("three", "3 days")))))
            val raw = WindmillJson.encodeToJsonElement(CoachClarification.serializer(), clarification)
            val exchange = AskExchange("Question", answer = AskAnswer("Days?", ReadTally(), clarification = raw), requestId = "request-123")
            local.saveChat("alice", LocalChat("account-chat", exchanges = listOf(exchange)), true)
            local.saveDraft("alice", "account-chat", CoachDraft("Account"))
            local.adoptPhoneDraft("alice") { true }
            val held = local.keptDrafts("alice", "account-chat").single()
            val events = mutableListOf<Pair<String, Map<String, String>>>()
            val failures = mutableListOf<String>()
            val telemetry = object : Telemetry {
                override fun event(name: String, properties: Map<String, String>) { events += name to properties }
                override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
            }
            val store = CoachStore({ "alice" }, { emptySet() }, {}, { FakeGymRest() }, local, telemetry, System::nanoTime,
                backgroundScope, StandardTestDispatcher(testScheduler))
            store.chat("account-chat")
            var flushes = 0
            val visibleCallback = {
                if (store.draftChangeReady("account-chat")) {
                    flushes++
                    if (action == "choose") store.choose("account-chat", "request-123", clarification, "days", "three")
                    else store.continueDraft("account-chat", held.id)
                } else false
            }
            unreadable = true
            assertThrows(IOException::class.java) { visibleCallback() }
            assertFalse(visibleCallback())
            assertEquals(1, flushes)
            assertEquals(CoachDraft("Account"), store.draft("account-chat"))
            assertTrue(file.delete()); assertTrue(published.renameTo(file)); unreadable = false
            assertFalse(visibleCallback())
            assertEquals(1, flushes)
            val intended = if (action == "choose") CoachDraft("3 days.") else held.draft
            assertEquals(intended, store.draft("account-chat"))
            assertEquals(intended, LocalCoach(file).draft("alice", "account-chat"))
            assertEquals(listOf("gym.saveDraft"), failures)
            assertEquals(listOf("gym_action" to mapOf("screen" to "coach", "action" to action, "outcome" to "ok")), events)
            assertTrue(visibleCallback())
            assertEquals(2, flushes)
            assertEquals(if (action == "choose") CoachDraft("") else CoachDraft("Account"), store.draft("account-chat"))
        }
    }

    @Test fun aDelayedPhotoCompletionAndRemovalCannotReplaceTheUnseenRecoveredPhoto() = runTest {
        val file = File(temporary.root, "uncertain-photo.json")
        val published = File(temporary.root, "published-photo.json")
        var unreadable = false
        val local = LocalCoach(file) { target, text ->
            AtomicDocument.write(target, text)
            if (unreadable) { check(target.renameTo(published)); check(target.mkdir()); throw IOException("unreadable publication") }
        }
        val phone = local.anonymousOwner()
        val photo = CoachAttachment("phone-photo", "image/png", 1, 1, 3)
        local.savePhoto(phone, photo.id, byteArrayOf(1, 2, 3))
        local.saveChat(phone, LocalChat("phone-chat"), true); local.saveDraft(phone, "phone-chat", CoachDraft("Phone", photo))
        local.saveChat("alice", LocalChat("account-chat"), true); local.saveDraft("alice", "account-chat", CoachDraft("Account"))
        local.adoptPhoneDraft("alice") { true }
        val held = local.keptDrafts("alice", "account-chat").single()
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {}
        }
        val store = CoachStore({ "alice" }, { emptySet() }, {}, { FakeGymRest() }, local, telemetry, System::nanoTime,
            backgroundScope, StandardTestDispatcher(testScheduler))
        val prepared = kotlinx.coroutines.CompletableDeferred<Pair<CoachAttachment, ByteArray>>()
        val importing = async { store.importPhoto("account-chat") { prepared.await() } }
        runCurrent()
        unreadable = true
        assertThrows(IOException::class.java) { store.continueDraft("account-chat", held.id) }
        assertTrue(file.delete()); assertTrue(published.renameTo(file)); unreadable = false
        val later = photo.copy(id = "later-photo")
        prepared.complete(later to byteArrayOf(4, 5, 6)); runCurrent(); importing.await()
        assertFalse(local.photoFile("alice", later.id).exists())
        store.removePhoto("account-chat")
        assertEquals(held.draft, store.draft("account-chat"))
        assertEquals(held.draft, LocalCoach(file).draft("alice", "account-chat"))
        assertArrayEquals(byteArrayOf(1, 2, 3), local.photoFile("alice", held.draft.photo!!.id).readBytes())
        assertEquals(listOf("gym_action" to mapOf("screen" to "coach", "action" to "continue_draft", "outcome" to "ok")), events)
    }

    @Test fun adoptionRecoveryPublishesTheNewSelectedChatWithoutRestartOrAnotherCopy() = runTest {
        val file = File(temporary.root, "new-target.json")
        val published = File(temporary.root, "new-target-published.json")
        var unreadable = false
        val local = LocalCoach(file) { target, text ->
            AtomicDocument.write(target, text)
            if (unreadable) { check(target.renameTo(published)); check(target.mkdir()); throw IOException("unreadable publication") }
        }
        val phone = local.anonymousOwner()
        val photo = CoachAttachment("phone-photo", "image/png", 1, 1, 3)
        local.savePhoto(phone, photo.id, byteArrayOf(1, 2, 3))
        local.saveChat(phone, LocalChat("phone-chat", setup = true), true); local.saveDraft(phone, "phone-chat", CoachDraft("Phone", photo))
        val failures = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {}
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        var owner: String? = null
        val store = CoachStore({ owner }, { emptySet() }, {}, { FakeGymRest() }, local, telemetry, System::nanoTime,
            backgroundScope, StandardTestDispatcher(testScheduler))
        store.saveDraft("phone-chat", CoachDraft("Phone", photo))
        owner = "alice"; store.resetThreads()
        assertNull(store.selectedChatId)
        unreadable = true
        store.adoptPhoneDraft("alice")
        assertTrue(file.delete()); assertTrue(published.renameTo(file)); unreadable = false
        store.adoptPhoneDraft("alice")
        val selected = requireNotNull(store.selectedChatId)
        assertEquals(selected, LocalCoach(file).selected("alice"))
        assertTrue(store.chat(selected)!!.setup)
        val adopted = store.draft(selected)
        assertEquals(CoachDraft("Phone", photo.copy(id = adopted.photo!!.id), setup = true), adopted)
        assertArrayEquals(byteArrayOf(1, 2, 3), local.photoFile("alice", adopted.photo.id).readBytes())
        assertEquals(CoachDraft(), local.draft(phone, "phone-chat"))
        store.adoptPhoneDraft("alice")
        assertEquals(listOf(selected), local.chats("alice").map { it.id })
        assertEquals(1, local.photoFile("alice", "directory-probe").parentFile!!.listFiles()!!.size)
        owner = null; store.resetThreads()
        assertEquals(CoachDraft(), store.draft("phone-chat"))
        store.saveDraft("phone-chat", store.draft("phone-chat"))
        owner = "bob"; store.resetThreads(); store.adoptPhoneDraft("bob")
        assertEquals(emptyList<LocalChat>(), local.chats("bob"))
        assertEquals(CoachDraft(), local.draft(phone, "phone-chat"))
        assertEquals(listOf(selected), local.chats("alice").map { it.id })
        assertEquals(listOf("gym.adoptCoachDraft"), failures)
    }

    @Test fun newChatBirthAndOrderingTimestampsAreAlwaysPublishedAndSurviveReopen() {
        val file = File(temporary.root, "timestamps.json")
        val local = LocalCoach(file)
        val chat = LocalChat("new-chat")
        local.saveChat("alice", chat, true)
        val encoded = WindmillJson.parseToJsonElement(file.readText()).jsonObject["chats"]!!.jsonObject["alice"]!!.jsonObject[chat.id]!!.jsonObject
        assertEquals(chat.createdAtMs, encoded["createdAtMs"]!!.jsonPrimitive.long)
        assertEquals(chat.updatedAtMs, encoded["updatedAtMs"]!!.jsonPrimitive.long)
        assertEquals(chat, LocalCoach(file).archivedChat("alice", chat.id))
    }

    @Test fun newSetupPurposeFollowsItsDraftAndAnOlderPendingBodyRemainsExact() = runTest {
        val file = File(temporary.root, "purpose.json")
        val local = LocalCoach(file)
        val calls = mutableListOf<AskQuestion>()
        val api = object : GymRest by FakeGymRest() {
            override suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit): AskAnswer {
                calls += question
                throw WindmillApiException.Offline
            }
        }
        val scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        try {
            val store = CoachStore({ "alice" }, { emptySet() }, {}, { api }, local, Telemetry.None, System::nanoTime, scope,
                StandardTestDispatcher(testScheduler))
            val ordinary = store.freshChat()
            assertTrue(store.submit(ordinary, "Ordinary")); runCurrent()
            assertEquals("conversation", calls.last().purpose)
            val setup = store.freshChat(setup = true)
            assertTrue(store.submit(setup, "Setup")); runCurrent()
            assertEquals("routine_setup", calls.last().purpose)
            val continued = store.freshChat()
            store.saveDraft(continued, CoachDraft("Continued", setup = true))
            assertTrue(store.submit(continued, "Continued")); runCurrent()
            assertEquals("routine_setup", calls.last().purpose)
            val older = store.freshChat(setup = true)
            val request = AskQuestion(older, "Original bytes", "old-request")
            local.keep("alice", request)
            val body = WindmillJson.encodeToString(AskQuestion.serializer(), request)
            store.ask(older, request.question, request.requestId!!, stream = true)
            assertEquals(request, calls.last())
            assertEquals(body, WindmillJson.encodeToString(AskQuestion.serializer(), local.pending("alice").single { it.requestId == request.requestId }))
        } finally { scope.cancel() }
    }
}
