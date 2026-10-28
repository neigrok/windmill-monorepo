package works.windmill.gym.coach

import works.windmill.gym.domain.Ids
import works.windmill.gym.store.diskJson
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import kotlinx.serialization.Serializable
import works.windmill.platform.storage.AtomicDocument

@Serializable
data class LocalChat(
    val id: String,
    val createdAtMs: Long = System.currentTimeMillis(),
    val updatedAtMs: Long = createdAtMs,
    val exchanges: List<AskExchange> = emptyList(),
    val history: AskThread? = null,
    val scroll: Int = 0,
    val followEnd: Boolean = true,
    val cap: String? = null,
    val absent: Boolean = false,
) {
    val title: String get() = history?.title ?: exchanges.firstOrNull()?.question.orEmpty()
}

internal class CoachDraftWriteFailure(cause: Exception) : Exception(cause)

class LocalCoach internal constructor(private val file: File, private val write: (File, String) -> Unit) {
    constructor(file: File) : this(file, AtomicDocument::write)
    companion object { const val fileName = "windmill-gym-coach.json" }

    @Serializable
    private data class Document(
        val anonymousId: String = "",
        val selected: Map<String, String> = emptyMap(),
        val chats: Map<String, Map<String, LocalChat>> = emptyMap(),
        val pending: Map<String, Map<String, AskQuestion>> = emptyMap(),
        val snapshots: Map<String, Map<String, AskGeneration>> = emptyMap(),
        val drafts: Map<String, Map<String, CoachDraft>> = emptyMap(),
        val confirmations: Map<String, Map<String, CoachRoutineConfirmation>> = emptyMap(),
    )

    private val restored = runCatching {
        if (file.exists()) diskJson.decodeFromString<Document>(file.readText()) else Document()
    }
    private var document = restored.getOrDefault(Document())

    @Synchronized fun anonymousOwner(): String {
        restored.getOrThrow()
        if (document.anonymousId.isNotEmpty()) return document.anonymousId
        val next = document.copy(anonymousId = "anonymous:" + Ids.thread())
        write(file, diskJson.encodeToString(Document.serializer(), next))
        document = next
        return next.anonymousId
    }

    @Synchronized fun selected(owner: String): String? {
        restored.getOrThrow()
        return document.selected[owner]
    }

    @Synchronized fun select(owner: String, id: String) {
        restored.getOrThrow()
        require(chats(owner).any { it.id == id })
        if (document.selected[owner] == id) return
        val next = document.copy(selected = document.selected + (owner to id))
        write(file, diskJson.encodeToString(Document.serializer(), next))
        document = next
    }

    @Synchronized fun chats(owner: String): List<LocalChat> {
        restored.getOrThrow()
        val chats = document.chats[owner].orEmpty().toMutableMap()
        val legacyIds = document.drafts[owner].orEmpty().keys + document.pending[owner].orEmpty().values.map { it.thread }
        legacyIds.forEach { id ->
            if (id !in chats) {
                val requests = document.pending[owner].orEmpty().values.filter { it.thread == id }
                val exchanges = requests.map { request ->
                    document.snapshots[owner]?.get(request.requestId)?.exchange()
                        ?: AskExchange(request.question, requestId = request.requestId.orEmpty(), trouble = Ask.interrupted, again = true)
                }
                chats[id] = LocalChat(id, exchanges = exchanges)
            }
        }
        return chats.values.toList()
    }

    @Synchronized fun saveChat(owner: String, chat: LocalChat, select: Boolean = false) {
        restored.getOrThrow()
        if (document.chats[owner]?.get(chat.id) == chat && (!select || document.selected[owner] == chat.id)) return
        val next = document.copy(
            selected = if (select) document.selected + (owner to chat.id) else document.selected,
            chats = document.chats + (owner to (document.chats[owner].orEmpty() + (chat.id to chat))))
        write(file, diskJson.encodeToString(Document.serializer(), next))
        document = next
    }

    @Synchronized fun pending(owner: String): List<AskQuestion> {
        restored.getOrThrow()
        return document.pending[owner].orEmpty().values.toList()
    }

    @Synchronized fun keep(owner: String, question: AskQuestion) {
        restored.getOrThrow()
        require(!question.requestId.isNullOrBlank())
        val original = document.pending[owner]?.get(question.requestId)
        require(original == null || original == question) { "A retry must keep the original message." }
        val next = document.copy(pending = document.pending +
            (owner to (document.pending[owner].orEmpty() + (requireNotNull(question.requestId) to question))))
        write(file, diskJson.encodeToString(Document.serializer(), next))
        document = next
    }

    @Synchronized fun snapshot(owner: String, requestId: String): AskGeneration? = document.snapshots[owner]?.get(requestId)

    @Synchronized fun record(owner: String, generation: AskGeneration) {
        restored.getOrThrow()
        val request = document.pending[owner]?.get(generation.requestId) ?: return
        val current = snapshot(owner, generation.requestId)
        if (current == generation || (current != null && current.id == generation.id && current.revision > generation.revision)) return
        val draft = document.drafts[owner]?.get(request.thread)
        val sentDraft = draft?.text == request.question && listOfNotNull(draft?.photo?.id) == request.attachmentIds
        val chat = document.chats[owner]?.get(request.thread) ?: LocalChat(request.thread)
        val previous = chat.exchanges.firstOrNull { it.requestId == generation.requestId }
        val attachments = generation.attachments.ifEmpty { previous?.attachments.orEmpty().ifEmpty { listOfNotNull(draft?.photo) } }
        val exchange = generation.exchange().copy(attachments = attachments,
            atMs = previous?.atMs?.takeIf { it > 0 } ?: generation.atMs, position = previous?.position ?: 0)
        val index = chat.exchanges.indexOfFirst { it.requestId == generation.requestId }
        val exchanges = if (index < 0) chat.exchanges + exchange else chat.exchanges.toMutableList().apply { set(index, exchange) }
        val next = document.copy(
            chats = document.chats + (owner to (document.chats[owner].orEmpty() + (chat.id to chat.copy(exchanges = exchanges)))),
            snapshots = document.snapshots + (owner to (document.snapshots[owner].orEmpty() + (generation.requestId to generation))),
            drafts = if (sentDraft) (document.drafts + (owner to (document.drafts[owner].orEmpty() - request.thread)))
                .filterValues { it.isNotEmpty() } else document.drafts,
        )
        write(file, diskJson.encodeToString(Document.serializer(), next))
        document = next
    }

    @Synchronized fun confirmed(owner: String, requestId: String): AskGeneration? = document.confirmations[owner]?.get(requestId)?.generation

    @Synchronized fun confirm(owner: String, confirmation: CoachRoutineConfirmation) {
        restored.getOrThrow()
        val generation = confirmation.generation
        val current = document.confirmations[owner]?.get(generation.requestId)
        if (current != null && current.generation.revision >= generation.revision) return
        val next = document.copy(confirmations = document.confirmations +
            (owner to (document.confirmations[owner].orEmpty() + (generation.requestId to confirmation))))
        write(file, diskJson.encodeToString(Document.serializer(), next))
        document = next
    }

    @Synchronized fun pauseRequest(owner: String, chat: LocalChat, requestId: String) {
        restored.getOrThrow()
        val next = document.copy(
            chats = document.chats + (owner to (document.chats[owner].orEmpty() + (chat.id to chat))),
            pending = document.pending + (owner to (document.pending[owner].orEmpty() - requestId)),
            snapshots = document.snapshots + (owner to (document.snapshots[owner].orEmpty() - requestId)),
        )
        write(file, diskJson.encodeToString(Document.serializer(), next))
        document = next
        discardUnusedPhotos(owner)
    }

    @Synchronized fun clear(owner: String, threadId: String, requestId: String? = null) {
        restored.getOrThrow()
        val mine = document.pending[owner].orEmpty()
        val kept = mine.filterValues { it.thread != threadId || (requestId != null && it.requestId != requestId) }
        val hasDraft = document.drafts[owner]?.containsKey(threadId) == true
        val hasConfirmation = document.confirmations[owner].orEmpty().values.any { it.thread == threadId }
        val hasChat = document.chats[owner]?.containsKey(threadId) == true
        if (kept == mine && (requestId != null || !hasDraft && !hasConfirmation && !hasChat)) return
        val removed = mine.keys - kept.keys
        val next = document.copy(
            chats = if (requestId == null) document.chats + (owner to (document.chats[owner].orEmpty() - threadId)) else document.chats,
            selected = if (requestId == null && document.selected[owner] == threadId) document.selected - owner else document.selected,
            pending = (document.pending + (owner to kept)).filterValues { it.isNotEmpty() },
            snapshots = (document.snapshots + (owner to (document.snapshots[owner].orEmpty() - removed))).filterValues { it.isNotEmpty() },
            drafts = if (requestId == null) document.drafts + (owner to (document.drafts[owner].orEmpty() - threadId)) else document.drafts,
            confirmations = if (requestId == null) document.confirmations + (owner to document.confirmations[owner].orEmpty().filterValues { it.thread != threadId }) else document.confirmations)
        write(file, diskJson.encodeToString(Document.serializer(), next))
        document = next
        discardUnusedPhotos(owner)
    }

    @Synchronized fun draft(owner: String, key: String): CoachDraft = document.drafts[owner]?.get(key) ?: CoachDraft()

    @Synchronized fun saveDraft(owner: String, key: String, draft: CoachDraft) {
        restored.getOrThrow()
        if ((document.drafts[owner]?.get(key) ?: CoachDraft()) == draft) return
        val mine = document.drafts[owner].orEmpty() + (key to draft)
        val chat = chats(owner).firstOrNull { it.id == key } ?: LocalChat(key)
        val next = document.copy(
            chats = document.chats + (owner to (document.chats[owner].orEmpty() + (key to chat.copy(updatedAtMs = System.currentTimeMillis())))),
            drafts = document.drafts + (owner to mine.filterValues { it.text.isNotEmpty() || it.photo != null }))
        write(file, diskJson.encodeToString(Document.serializer(), next))
        document = next
        discardUnusedPhotos(owner)
    }

    @Synchronized internal fun discardUnusedPhotos(owner: String) {
        val retained = document.pending[owner].orEmpty().values.flatMap { it.attachmentIds }.toSet() +
            document.drafts[owner].orEmpty().values.mapNotNull { it.photo?.id } +
            document.chats[owner].orEmpty().values.flatMap { chat -> chat.exchanges.flatMap { it.attachments.map { photo -> photo.id } } }
        photoFile(owner, "directory-probe").parentFile?.listFiles()?.forEach { photo ->
            if (photo.name !in retained) photo.delete()
        }
    }

    fun photoFile(owner: String, id: String): File {
        require(id.matches(Regex("[A-Za-z0-9_-]{8,64}")))
        val seat = MessageDigest.getInstance("SHA-256").digest(owner.toByteArray()).joinToString("") { "%02x".format(it) }
        return File(file.parentFile, "coach-photos/$seat/$id")
    }

    @Synchronized internal fun attachPhoto(owner: String, key: String, photo: CoachAttachment, bytes: ByteArray): Boolean {
        restored.getOrThrow()
        if (document.chats[owner]?.containsKey(key) != true) return false
        savePhoto(owner, photo.id, bytes)
        try { saveDraft(owner, key, draft(owner, key).copy(photo = photo)) }
        catch (failure: Exception) { discardUnusedPhotos(owner); throw CoachDraftWriteFailure(failure) }
        return true
    }

    @Synchronized fun savePhoto(owner: String, id: String, bytes: ByteArray) {
        val target = photoFile(owner, id)
        val parent = requireNotNull(target.parentFile)
        check(parent.isDirectory || parent.mkdirs())
        val temporary = File(parent, "$id.tmp")
        FileOutputStream(temporary).use { it.write(bytes); it.fd.sync() }
        Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }
}
