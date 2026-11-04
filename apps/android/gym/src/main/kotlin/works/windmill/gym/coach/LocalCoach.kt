package works.windmill.gym.coach

import works.windmill.gym.presentation.Ids
import works.windmill.gym.store.diskJson
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import kotlinx.serialization.Serializable
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.JsonObject
import works.windmill.platform.storage.AtomicDocument
import works.windmill.gym.coach.onboarding.CoachOnboardingRecord

// A chat as this phone keeps it beside the engine's records (Coach §9.1): the composer's home before a turn opens a thread, and the reader's place after one. `conversation` is the engine thread its first turn opened, which holds every message said in it.
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class LocalChat(
    val id: String,
    val createdAtMs: Long,
    @EncodeDefault val updatedAtMs: Long = createdAtMs,
    val conversation: String? = null,
    val scroll: Int = 0,
    val followEnd: Boolean = true,
    val setup: Boolean = false,
)

internal data class CoachDraftRecovery(val owner: String, val chat: String, val action: String,
    val source: Pair<String, String>? = null, val published: Boolean = false)

internal data class CoachDraftMove(val sourceOwner: String, val sourceChat: String, val targetChat: String)

internal class CoachDraftWriteFailure(cause: Exception) : Exception(cause)

// What this phone keeps per owner beside the engine: chats, composer drafts, kept drafts, draft photos and the onboarding answers earlier versions stored. Owner epochs stop a late write reaching an owner erased since. Messages are the engine's, and the conversations, requests and confirmations earlier versions kept here are dropped at first load.
class LocalCoach internal constructor(private val file: File, private val write: (File, String) -> Unit,
    private val writesAllowed: () -> Boolean, private val now: () -> Long,
) {
    constructor(file: File, writesAllowed: () -> Boolean = { true }, now: () -> Long = System::currentTimeMillis) : this(file, AtomicDocument::write, writesAllowed, now)
    internal constructor(file: File, write: (File, String) -> Unit) : this(file, write, { true }, System::currentTimeMillis)
    companion object {
        const val fileName = "windmill-gym-coach.json"
        private val legacyKeys = setOf("chats", "pending", "snapshots", "confirmations", "choices")
        private val fileIdPattern = Regex("[A-Za-z0-9_-]{8,64}")
    }

    @Serializable
    private data class Document(
        val anonymousId: String = "",
        val ownerEpochs: Map<String, Long> = emptyMap(),
        val deletedOwners: Set<String> = emptySet(),
        val selected: Map<String, String> = emptyMap(),
        val localChats: Map<String, Map<String, LocalChat>> = emptyMap(),
        val drafts: Map<String, Map<String, CoachDraft>> = emptyMap(),
        val keptDrafts: Map<String, Map<String, List<KeptCoachDraft>>> = emptyMap(),
        val onboarding: Map<String, Map<String, CoachOnboardingRecord>> = emptyMap(),
    )

    // A document as it reads today: one written by an earlier version keeps its drafts, kept drafts and retained answers, each under a chat stamped with the file's own time, and nothing else of what it held. The stamp holds across rereads because only a write moves it.
    private fun parsed(text: String): Document {
        val tree = diskJson.parseToJsonElement(text) as JsonObject
        val read = diskJson.decodeFromJsonElement(Document.serializer(), tree)
        if (legacyKeys.none(tree::containsKey)) return read
        val stamp = file.lastModified()
        val owners = read.drafts.keys + read.keptDrafts.keys + read.onboarding.keys
        val chats = owners.associateWith { owner ->
            val ids = read.drafts[owner].orEmpty().keys + read.keptDrafts[owner].orEmpty().keys + read.onboarding[owner].orEmpty().values.map { it.chat }
            ids.associateWith { LocalChat(it, stamp) }
        }
        return read.copy(localChats = chats, selected = read.selected.filter { (owner, id) -> chats[owner]?.containsKey(id) == true })
    }

    private fun encoded(next: Document): String = diskJson.encodeToString(Document.serializer(), next)

    private val restored = runCatching { if (file.exists()) parsed(file.readText()) else Document() }
    private var document = restored.getOrDefault(Document())
    // Whether the file on disk is still an earlier version's: every write of this document replaces it.
    private var legacyOnDisk = restored.isSuccess && file.exists() && legacyKeys.any((diskJson.parseToJsonElement(file.readText()) as JsonObject)::containsKey)

    // Rewrites a file an earlier version left, so the conversations it held leave the disk, and removes the photos only they named. Off the main thread, once at launch; any later write drops them as well.
    @Synchronized fun settle() {
        ready()
        if (!legacyOnDisk || !writesAllowed() || ownerStateUnreadable) return
        write(file, encoded(document))
        legacyOnDisk = false
        val owners = document.drafts.keys + document.keptDrafts.keys + document.onboarding.keys
        val folders = owners.associateBy { photoFolder(it).name }
        File(file.parentFile, "coach-photos").listFiles().orEmpty().forEach { folder ->
            val owner = folders[folder.name]
            if (owner == null) folder.deleteRecursively()
            else folder.listFiles().orEmpty().filter { it.name !in retainedPhotoIds(owner) }.forEach { it.delete() }
        }
    }

    class Authority internal constructor(val owner: String, internal val epoch: Long)
    private var uncertainOwnerWrite: Pair<Document, Document>? = null
    private val ownerStateUnreadable: Boolean get() = uncertainOwnerWrite != null

    @Synchronized fun admit(owner: String): Authority {
        checkWritable(owner)
        return Authority(owner, document.ownerEpochs[owner] ?: 0L)
    }

    @Synchronized fun writable(owner: String): Boolean = restored.isSuccess && !ownerStateUnreadable &&
        writesAllowed() && owner !in document.deletedOwners

    @Synchronized fun current(authority: Authority): Boolean = writable(authority.owner) &&
        authority.epoch == (document.ownerEpochs[authority.owner] ?: 0L)

    @Synchronized fun <T> withAuthority(authority: Authority, body: () -> T): T {
        if (!current(authority)) throw kotlinx.coroutines.CancellationException("coach-owner-retired")
        return body()
    }

    private fun checkWritable(owner: String) {
        ready()
        if (!writable(owner))
            throw kotlinx.coroutines.CancellationException("coach-owner-unavailable")
    }

    @Synchronized fun eraseOwner(owner: String) {
        reconcileOwnerState()
        ready()
        check(!ownerStateUnreadable)
        if (owner !in document.deletedOwners) {
            val next = document.copy(
                ownerEpochs = document.ownerEpochs + (owner to Math.addExact(document.ownerEpochs[owner] ?: 0L, 1)),
                deletedOwners = document.deletedOwners + owner,
                selected = document.selected - owner, localChats = document.localChats - owner,
                drafts = document.drafts - owner, keptDrafts = document.keptDrafts - owner,
                onboarding = document.onboarding - owner,
            )
            saveOwnerState(next)
        }
        if (draftRecovery?.owner == owner) draftRecovery = null
        val photos = photoFolder(owner)
        check(!photos.exists() || photos.deleteRecursively()) { "The account photos could not be removed." }
    }

    @Synchronized fun reopenVerifiedOwner(owner: String) {
        reconcileOwnerState()
        ready()
        check(!ownerStateUnreadable && writesAllowed())
        if (owner in document.deletedOwners) saveOwnerState(document.copy(deletedOwners = document.deletedOwners - owner))
    }

    private fun reconcileOwnerState() {
        val expected = uncertainOwnerWrite ?: return
        val retained = parsed(file.readText())
        check(retained == expected.first || retained == expected.second) { "The account archive changed." }
        document = retained
        uncertainOwnerWrite = null
    }

    private fun saveOwnerState(next: Document) {
        val before = document
        try { write(file, encoded(next)) }
        catch (failure: Exception) {
            val retained = runCatching { parsed(file.readText()) }.getOrNull()
            if (retained == null || retained != before && retained != next) {
                uncertainOwnerWrite = before to next
                throw failure
            }
            document = retained
            if (retained != next) throw failure
        }
        document = next
        legacyOnDisk = false
    }

    private var uncertainWrite: kotlinx.serialization.json.JsonElement? = null
    private var draftRecovery: CoachDraftRecovery? = null
    private var uncertainDraftRecovery: CoachDraftRecovery? = null

    private fun ready() {
        restored.getOrThrow()
        uncertainWrite?.let { intended ->
            val text = file.readText()
            val actual = diskJson.parseToJsonElement(text)
            document = parsed(text)
            uncertainDraftRecovery?.let { draftRecovery = it.copy(published = actual == intended) }
            uncertainDraftRecovery = null
            uncertainWrite = null
        }
    }

    // A plain write of the next document: what a later read of the disk would find.
    private fun publish(next: Document) {
        write(file, encoded(next))
        document = next
        legacyOnDisk = false
    }

    private fun saveChange(owner: String, next: Document, recovery: CoachDraftRecovery? = null,
        publishedFailure: (Exception) -> Unit) {
        checkWritable(owner)
        recovery?.source?.let { checkWritable(it.first) }
        val published = encoded(next)
        try { write(file, published) }
        catch (failure: Exception) {
            val text = try {
                file.readText().also { document = parsed(it) }
            } catch (_: Exception) {
                uncertainWrite = diskJson.parseToJsonElement(published)
                uncertainDraftRecovery = recovery
                if (recovery != null) draftRecovery = recovery
                throw failure
            }
            if (diskJson.parseToJsonElement(text) != diskJson.parseToJsonElement(published)) throw failure
            publishedFailure(failure)
            return
        }
        document = next
        legacyOnDisk = false
    }

    @Synchronized internal fun reconcileDraftChange(owner: String, chat: String? = null): CoachDraftRecovery? {
        if (draftRecovery?.let { it.owner == owner && (chat == null || it.chat == chat) } != true) return null
        ready()
        val result = draftRecovery
        draftRecovery = null
        return result?.takeIf { it.published }
    }

    @Synchronized fun anonymousOwner(): String {
        ready()
        if (document.anonymousId.isNotEmpty()) return document.anonymousId
        check(writesAllowed() && !ownerStateUnreadable)
        publish(document.copy(anonymousId = "anonymous:" + Ids.thread()))
        return document.anonymousId
    }

    @Synchronized fun selected(owner: String): String? {
        ready()
        return document.selected[owner]
    }

    @Synchronized fun select(owner: String, id: String) {
        checkWritable(owner)
        require(document.localChats[owner]?.containsKey(id) == true)
        if (document.selected[owner] == id) return
        publish(document.copy(selected = document.selected + (owner to id)))
    }

    @Synchronized fun chats(owner: String): List<LocalChat> {
        ready()
        return document.localChats[owner].orEmpty().values.toList()
    }

    @Synchronized fun chat(owner: String, id: String): LocalChat? {
        ready()
        return document.localChats[owner]?.get(id)
    }

    @Synchronized fun saveChat(owner: String, chat: LocalChat, select: Boolean = false) {
        checkWritable(owner)
        if (document.localChats[owner]?.get(chat.id) == chat && (!select || document.selected[owner] == chat.id)) return
        publish(document.copy(
            selected = if (select) document.selected + (owner to chat.id) else document.selected,
            localChats = document.localChats + (owner to (document.localChats[owner].orEmpty() + (chat.id to chat)))))
    }

    // The onboarding answers this chat holds from an earlier version: readable, and their drafts saveable.
    @Synchronized fun retained(owner: String, chat: String): List<CoachOnboardingRecord> {
        ready()
        return document.onboarding[owner].orEmpty().values.filter { it.chat == chat }.sortedBy { it.createdAtMs }
    }

    // A deleted chat goes whole: its draft, its kept drafts and the answers it retains, and the photos only they named.
    @Synchronized fun clear(owner: String, chat: String) {
        checkWritable(owner)
        val onboarding = document.onboarding[owner].orEmpty().filterValues { it.chat != chat }
        if (document.localChats[owner]?.containsKey(chat) != true && document.drafts[owner]?.containsKey(chat) != true &&
            onboarding == document.onboarding[owner].orEmpty()) return
        publish(document.copy(
            localChats = document.localChats + (owner to (document.localChats[owner].orEmpty() - chat)),
            selected = if (document.selected[owner] == chat) document.selected - owner else document.selected,
            drafts = document.drafts + (owner to (document.drafts[owner].orEmpty() - chat)),
            keptDrafts = document.keptDrafts + (owner to (document.keptDrafts[owner].orEmpty() - chat)),
            onboarding = (document.onboarding + (owner to onboarding)).filterValues { it.isNotEmpty() }))
        discardUnusedPhotos(owner)
    }

    // A turn opened from this chat: its question is a message now, so the draft goes and the chat holds the thread.
    @Synchronized fun turnOpened(owner: String, chat: String, thread: String) {
        checkWritable(owner)
        val held = document.localChats[owner]?.get(chat) ?: LocalChat(chat, now())
        publish(document.copy(
            localChats = document.localChats + (owner to (document.localChats[owner].orEmpty() + (chat to held.copy(conversation = thread, updatedAtMs = now())))),
            drafts = (document.drafts + (owner to (document.drafts[owner].orEmpty() - chat))).filterValues { it.isNotEmpty() }))
        discardUnusedPhotos(owner)
    }

    // A turn the server refused before its stream never happened: the draft and its photo return, and the chat holds the thread only if the thread still stands.
    @Synchronized fun turnWithdrawn(owner: String, chat: String, conversation: String?, draft: CoachDraft, photo: ByteArray?) {
        checkWritable(owner)
        val photoId = draft.photo?.id
        if (photoId != null && photo != null) savePhoto(owner, photoId, photo)
        val held = document.localChats[owner]?.get(chat) ?: LocalChat(chat, now())
        publish(document.copy(
            localChats = document.localChats + (owner to (document.localChats[owner].orEmpty() + (chat to held.copy(conversation = conversation, updatedAtMs = now())))),
            drafts = document.drafts + (owner to (document.drafts[owner].orEmpty() + (chat to draft)))))
    }

    @Synchronized fun draft(owner: String, key: String): CoachDraft = document.drafts[owner]?.get(key) ?: CoachDraft()

    @Synchronized fun keptDrafts(owner: String, chat: String): List<KeptCoachDraft> {
        return document.keptDrafts[owner]?.get(chat).orEmpty()
    }

    @Synchronized internal fun continueDraft(owner: String, chatId: String, heldId: String,
        publishedFailure: (Exception) -> Unit = {}): Boolean {
        ready()
        val chat = document.localChats[owner]?.get(chatId) ?: return false
        val held = keptDrafts(owner, chatId)
        val index = held.indexOfFirst { it.id == heldId }
        if (index < 0) return false
        val previous = draft(owner, chatId)
        val remaining = held.toMutableList().apply {
            if (previous.text.isNotEmpty() || previous.photo != null) set(index, held[index].copy(draft = previous)) else removeAt(index)
        }
        val next = document.copy(
            localChats = document.localChats + (owner to (document.localChats[owner].orEmpty() + (chatId to chat.copy(updatedAtMs = now())))),
            drafts = document.drafts + (owner to (document.drafts[owner].orEmpty() + (chatId to held[index].draft))),
            keptDrafts = document.keptDrafts + (owner to (document.keptDrafts[owner].orEmpty() + (chatId to remaining))))
        saveChange(owner, next, CoachDraftRecovery(owner, chatId, "continue_draft"), publishedFailure)
        return true
    }

    @Synchronized internal fun adoptPhoneDraft(targetOwner: String, publishedFailure: (Exception) -> Unit = {},
        current: () -> Boolean): CoachDraftMove? {
        checkWritable(targetOwner)
        if (!current()) return null
        val sourceOwner = document.anonymousId.takeIf { it.isNotEmpty() && it != targetOwner } ?: return null
        val sourceId = document.selected[sourceOwner] ?: return null
        val source = document.localChats[sourceOwner]?.get(sourceId) ?: return null
        val original = draft(sourceOwner, sourceId)
        if (original.text.isEmpty() && original.photo == null) return null
        val selected = document.selected[targetOwner]
        val target = selected?.let { document.localChats[targetOwner]?.get(it) } ?: LocalChat(Ids.thread(), now(), setup = source.setup)
        val previous = draft(targetOwner, target.id)
        var moved = original
        var copied: File? = null
        var committed = false
        try {
            original.photo?.let { photo ->
                val from = photoFile(sourceOwner, photo.id)
                require(from.length() == photo.bytes && photo.bytes in 1..CoachPhotos.maxBytes.toLong())
                var id = Ids.thread()
                while (photoFile(targetOwner, id).exists()) id = Ids.thread()
                savePhoto(targetOwner, id, from.readBytes())
                copied = photoFile(targetOwner, id)
                moved = moved.copy(photo = photo.copy(id = id))
            }
            if (!current() || document.selected[targetOwner] != selected) return null
            val occupied = previous.text.isNotEmpty() || previous.photo != null
            val kept = keptDrafts(targetOwner, target.id) + if (occupied) listOf(KeptCoachDraft(Ids.thread(), moved)) else emptyList()
            val next = document.copy(
                selected = document.selected + (targetOwner to target.id),
                localChats = document.localChats + (targetOwner to (document.localChats[targetOwner].orEmpty() +
                    (target.id to target.copy(updatedAtMs = now())))),
                drafts = document.drafts + (sourceOwner to (document.drafts[sourceOwner].orEmpty() - sourceId)) +
                    (targetOwner to (document.drafts[targetOwner].orEmpty() + (target.id to if (occupied) previous else moved))),
                keptDrafts = document.keptDrafts + (targetOwner to (document.keptDrafts[targetOwner].orEmpty() + (target.id to kept))))
            saveChange(targetOwner, next, CoachDraftRecovery(targetOwner, target.id, "adopt", source = sourceOwner to sourceId), publishedFailure)
            committed = true
            discardUnusedPhotos(sourceOwner)
            return CoachDraftMove(sourceOwner, sourceId, target.id)
        } finally {
            if (!committed && uncertainWrite == null) copied?.takeIf { it.name !in retainedPhotoIds(targetOwner) }?.delete()
        }
    }

    @Synchronized fun saveDraft(owner: String, key: String, draft: CoachDraft) {
        checkWritable(owner)
        check(draftRecovery?.let { it.owner == owner && it.chat == key } != true)
        if ((document.drafts[owner]?.get(key) ?: CoachDraft()) == draft) return
        val mine = document.drafts[owner].orEmpty() + (key to draft)
        val chat = document.localChats[owner]?.get(key) ?: LocalChat(key, now())
        publish(document.copy(
            localChats = document.localChats + (owner to (document.localChats[owner].orEmpty() + (key to chat.copy(updatedAtMs = now())))),
            drafts = document.drafts + (owner to mine.filterValues { it.text.isNotEmpty() || it.photo != null })))
        discardUnusedPhotos(owner)
    }

    private fun retainedPhotoIds(owner: String): Set<String> = (document.drafts[owner].orEmpty().values.mapNotNull { it.photo?.id } +
        document.keptDrafts[owner].orEmpty().values.flatten().mapNotNull { it.draft.photo?.id } +
        document.onboarding[owner].orEmpty().values.mapNotNull { it.attachment?.id }).toSet()

    @Synchronized internal fun discardUnusedPhotos(owner: String) {
        checkWritable(owner)
        val retained = retainedPhotoIds(owner)
        photoFolder(owner).listFiles()?.forEach { photo ->
            if (photo.name !in retained) photo.delete()
        }
    }

    private fun photoFolder(owner: String): File {
        val seat = MessageDigest.getInstance("SHA-256").digest(owner.toByteArray()).joinToString("") { "%02x".format(it) }
        return File(file.parentFile, "coach-photos/$seat")
    }

    fun photoFile(owner: String, id: String): File {
        require(id.matches(fileIdPattern))
        return File(photoFolder(owner), id)
    }

    @Synchronized internal fun attachPhoto(owner: String, key: String, photo: CoachAttachment, bytes: ByteArray): Boolean {
        checkWritable(owner)
        if (draftRecovery?.let { it.owner == owner && it.chat == key } == true) return false
        if (document.localChats[owner]?.containsKey(key) != true) return false
        savePhoto(owner, photo.id, bytes)
        try { saveDraft(owner, key, draft(owner, key).copy(photo = photo)) }
        catch (failure: Exception) { discardUnusedPhotos(owner); throw CoachDraftWriteFailure(failure) }
        return true
    }

    @Synchronized fun savePhoto(owner: String, id: String, bytes: ByteArray) {
        checkWritable(owner)
        val target = photoFile(owner, id)
        val parent = requireNotNull(target.parentFile)
        check(parent.isDirectory || parent.mkdirs())
        val temporary = File(parent, "$id.tmp")
        FileOutputStream(temporary).use { it.write(bytes); it.fd.sync() }
        Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }
}
