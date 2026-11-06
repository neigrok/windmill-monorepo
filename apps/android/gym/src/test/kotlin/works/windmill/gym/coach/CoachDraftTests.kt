package works.windmill.gym.coach

import java.io.File
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.coach.turn.TellingRecorder
import works.windmill.platform.net.WindmillJson
import works.windmill.platform.storage.AtomicDocument
import works.windmill.platform.telemetry.Telemetry

@OptIn(ExperimentalCoroutinesApi::class)
class CoachDraftTests {
    @get:Rule val temporary = TemporaryFolder()

    private fun chats(owner: () -> String?, local: LocalCoach, scope: CoroutineScope, storage: CoroutineDispatcher, telemetry: Telemetry = Telemetry.None) =
        CoachChats(owner, {}, null, null, local, null, { AnonymousCoachAccess.Unavailable }, telemetry, scope, storage)

    @Test fun adoptionAndSwappingKeepWholeDraftsAndPhotosAcrossOwnersAndReopen() {
        val file = File(temporary.root, "drafts.json")
        val local = LocalCoach(file)
        val phone = local.anonymousOwner()
        val source = LocalChat("phone-chat", 1, setup = true)
        val target = LocalChat("account-chat", 1)
        local.saveChat(phone, source, true); local.saveChat("alice", target, true)
        val photo = CoachAttachment("same-photo", "image/png", 1, 1, 3)
        val phoneDraft = CoachDraft("Phone text", photo)
        val accountDraft = CoachDraft("Account text", photo)
        local.savePhoto(phone, photo.id, byteArrayOf(1, 2, 3)); local.saveDraft(phone, source.id, phoneDraft)
        local.savePhoto("alice", photo.id, byteArrayOf(4, 5, 6)); local.saveDraft("alice", target.id, accountDraft)
        assertEquals(CoachDraftMove(phone, source.id, target.id), local.adoptPhoneDraft("alice") { true })
        val restored = LocalCoach(file)
        assertEquals(CoachDraft(), restored.draft(phone, source.id))
        assertEquals(accountDraft, restored.draft("alice", target.id))
        val held = restored.keptDrafts("alice", target.id).single()
        val adopted = held.draft
        assertEquals(phoneDraft.copy(photo = photo.copy(id = adopted.photo!!.id)), adopted)
        assertNotEquals(photo.id, adopted.photo.id)
        assertArrayEquals(byteArrayOf(1, 2, 3), restored.photoFile("alice", adopted.photo.id).readBytes())
        assertArrayEquals(byteArrayOf(4, 5, 6), restored.photoFile("alice", photo.id).readBytes())
        assertFalse("the phone's copy goes with the draft that named it", restored.photoFile(phone, photo.id).exists())
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
    }

    @Test fun anEmptyAccountDraftAdoptsDirectly() {
        val file = File(temporary.root, "empty.json")
        val local = LocalCoach(file)
        val phone = local.anonymousOwner()
        local.saveChat(phone, LocalChat("phone-chat", 1, setup = true), true)
        local.saveDraft(phone, "phone-chat", CoachDraft("Phone draft"))
        local.saveChat("alice", LocalChat("account-chat", 1), true)
        local.adoptPhoneDraft("alice") { true }
        val restored = LocalCoach(file)
        assertEquals(CoachDraft(), restored.draft(phone, "phone-chat"))
        assertEquals(CoachDraft("Phone draft"), restored.draft("alice", "account-chat"))
        assertEquals(emptyList<KeptCoachDraft>(), restored.keptDrafts("alice", "account-chat"))
    }

    @Test fun failedDocumentPublicationAndChangedOwnerKeepBothOriginalDraftsAndRemoveOnlyTheNewCopy() {
        val file = File(temporary.root, "failed-move.json")
        var fail = false
        val local = LocalCoach(file) { target, text -> if (fail) throw IOException("private document failure") else AtomicDocument.write(target, text) }
        val phone = local.anonymousOwner()
        local.saveChat(phone, LocalChat("phone-chat", 1), true); local.saveChat("alice", LocalChat("account-chat", 1), true)
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
        local.saveChat(phone, LocalChat("phone-chat", 1), true); local.saveChat("alice", LocalChat("account-chat", 1), true)
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
        local.saveChat(phone, LocalChat("phone-chat", 1), true); local.saveChat("alice", LocalChat("account-chat", 1), true)
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
            local.saveChat(phone, LocalChat("phone-chat", 1), true); local.saveDraft(phone, "phone-chat", CoachDraft("Phone", photo))
            var owner: String? = "alice"
            val store = chats({ owner }, local, backgroundScope, StandardTestDispatcher(testScheduler))
            val adoption = async(start = CoroutineStart.UNDISPATCHED) { store.adoptPhoneDraft("alice") }
            owner = "bob"; store.forgetSeat()
            if (returns) { owner = "alice"; store.forgetSeat() }
            runCurrent(); adoption.await()
            assertEquals(CoachDraft("Phone", photo), LocalCoach(file).draft(phone, "phone-chat"))
            assertEquals(emptyList<LocalChat>(), local.chats("alice")); assertEquals(emptyList<LocalChat>(), local.chats("bob"))
            assertArrayEquals(byteArrayOf(1, 2, 3), local.photoFile(phone, photo.id).readBytes())
            assertEquals(emptyList<String>(), local.photoFile("alice", "directory-probe").parentFile!!.listFiles().orEmpty().map { it.name })
        }
    }

    @Test fun aPublishedWriteThatThrowsReconcilesAdoptionAndSwapWithoutRepeatingTheMutation() {
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
        local.saveChat(phone, LocalChat("phone-chat", 1), true); local.saveDraft(phone, "phone-chat", CoachDraft("Phone", photo))
        local.saveChat("alice", LocalChat("account-chat", 1), true); local.saveDraft("alice", "account-chat", CoachDraft("Account"))
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
        assertEquals(listOf("adopt", "continue"), reports)
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
        local.saveChat(phone, LocalChat("phone-chat", 1), true); local.saveDraft(phone, "phone-chat", CoachDraft("Phone", photo))
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

    @Test fun retryingTheSameVisibleContinueReconcilesAnUnreadablePublicationBeforeFlushingOrTogglingAgain() = runTest {
        val file = File(temporary.root, "continue-retry.json")
        val published = File(temporary.root, "continue-published.json")
        var unreadable = false
        val local = LocalCoach(file) { target, text ->
            AtomicDocument.write(target, text)
            if (unreadable) {
                check(target.renameTo(published)); check(target.mkdir())
                throw IOException("unreadable publication")
            }
        }
        val phone = local.anonymousOwner()
        local.saveChat(phone, LocalChat("phone-chat", 1), true); local.saveDraft(phone, "phone-chat", CoachDraft("Phone"))
        local.saveChat("alice", LocalChat("account-chat", 1), true)
        local.saveDraft("alice", "account-chat", CoachDraft("Account"))
        local.adoptPhoneDraft("alice") { true }
        val held = local.keptDrafts("alice", "account-chat").single()
        val telling = TellingRecorder()
        val store = chats({ "alice" }, local, backgroundScope, StandardTestDispatcher(testScheduler), telling)
        store.chat("account-chat")
        var flushes = 0
        val visibleCallback = {
            if (store.draftChangeReady("account-chat")) {
                flushes++
                store.continueDraft("account-chat", held.id)
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
        assertEquals(held.draft, store.draft("account-chat"))
        assertEquals(held.draft, LocalCoach(file).draft("alice", "account-chat"))
        assertEquals(listOf(mapOf("operation" to "gym.saveDraft")), telling.failures.toList())
        assertEquals(listOf("gym_action" to mapOf("screen" to "coach", "action" to "continue_draft", "outcome" to "ok")), telling.events.toList())
        assertTrue(visibleCallback())
        assertEquals(2, flushes)
        assertEquals(CoachDraft("Account"), store.draft("account-chat"))
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
        local.saveChat(phone, LocalChat("phone-chat", 1), true); local.saveDraft(phone, "phone-chat", CoachDraft("Phone", photo))
        local.saveChat("alice", LocalChat("account-chat", 1), true); local.saveDraft("alice", "account-chat", CoachDraft("Account"))
        local.adoptPhoneDraft("alice") { true }
        val held = local.keptDrafts("alice", "account-chat").single()
        val telling = TellingRecorder()
        val store = chats({ "alice" }, local, backgroundScope, StandardTestDispatcher(testScheduler), telling)
        val prepared = CompletableDeferred<Pair<CoachAttachment, ByteArray>>()
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
        assertEquals(listOf("gym_action" to mapOf("screen" to "coach", "action" to "continue_draft", "outcome" to "ok")), telling.events.toList())
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
        local.saveChat(phone, LocalChat("phone-chat", 1, setup = true), true); local.saveDraft(phone, "phone-chat", CoachDraft("Phone", photo))
        val telling = TellingRecorder()
        var owner: String? = null
        val store = chats({ owner }, local, backgroundScope, StandardTestDispatcher(testScheduler), telling)
        store.saveDraft("phone-chat", CoachDraft("Phone", photo))
        owner = "alice"; store.forgetSeat()
        assertNull(store.selectedChatId)
        unreadable = true
        store.adoptPhoneDraft("alice")
        assertTrue(file.delete()); assertTrue(published.renameTo(file)); unreadable = false
        store.adoptPhoneDraft("alice")
        val selected = requireNotNull(store.selectedChatId)
        assertEquals(selected, LocalCoach(file).selected("alice"))
        assertTrue(store.chat(selected)!!.setup)
        val adopted = store.draft(selected)
        assertEquals(CoachDraft("Phone", photo.copy(id = adopted.photo!!.id)), adopted)
        assertArrayEquals(byteArrayOf(1, 2, 3), local.photoFile("alice", adopted.photo.id).readBytes())
        assertEquals(CoachDraft(), local.draft(phone, "phone-chat"))
        store.adoptPhoneDraft("alice")
        assertEquals(listOf(selected), local.chats("alice").map { it.id })
        assertEquals(1, local.photoFile("alice", "directory-probe").parentFile!!.listFiles()!!.size)
        owner = null; store.forgetSeat()
        assertEquals(CoachDraft(), store.draft("phone-chat"))
        store.saveDraft("phone-chat", store.draft("phone-chat"))
        owner = "bob"; store.forgetSeat(); store.adoptPhoneDraft("bob")
        assertEquals(emptyList<LocalChat>(), local.chats("bob"))
        assertEquals(CoachDraft(), local.draft(phone, "phone-chat"))
        assertEquals(listOf(selected), local.chats("alice").map { it.id })
        assertEquals(listOf(mapOf("operation" to "gym.adoptCoachDraft")), telling.failures.toList())
    }

    @Test fun newChatBirthAndOrderingTimestampsAreAlwaysPublishedAndSurviveReopen() {
        val file = File(temporary.root, "timestamps.json")
        val local = LocalCoach(file)
        val chat = LocalChat("new-chat", 1_800_000_000_000)
        local.saveChat("alice", chat, true)
        val encoded = WindmillJson.parseToJsonElement(file.readText()).jsonObject["localChats"]!!.jsonObject["alice"]!!.jsonObject[chat.id]!!.jsonObject
        assertEquals(chat.createdAtMs, encoded["createdAtMs"]!!.jsonPrimitive.long)
        assertEquals(chat.updatedAtMs, encoded["updatedAtMs"]!!.jsonPrimitive.long)
        assertEquals(chat, LocalCoach(file).chat("alice", chat.id))
    }
}
