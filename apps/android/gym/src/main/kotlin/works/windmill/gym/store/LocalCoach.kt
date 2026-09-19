package works.windmill.gym.store

import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import kotlinx.serialization.Serializable
import works.windmill.gym.domain.AskQuestion
import works.windmill.gym.domain.AskGeneration
import works.windmill.gym.domain.CoachDraft
import works.windmill.platform.storage.AtomicDocument

class LocalCoach(private val file: File) {
    companion object { const val fileName = "windmill-gym-coach.json" }

    @Serializable
    private data class Document(
        val pending: Map<String, Map<String, AskQuestion>> = emptyMap(),
        val snapshots: Map<String, Map<String, AskGeneration>> = emptyMap(),
        val drafts: Map<String, Map<String, CoachDraft>> = emptyMap(),
    )

    private val restored = runCatching {
        if (file.exists()) diskJson.decodeFromString<Document>(file.readText()) else Document()
    }
    private var document = restored.getOrDefault(Document())

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
        AtomicDocument.write(file, diskJson.encodeToString(Document.serializer(), next))
        document = next
    }

    @Synchronized fun snapshot(owner: String, requestId: String): AskGeneration? = document.snapshots[owner]?.get(requestId)

    @Synchronized fun record(owner: String, generation: AskGeneration) {
        restored.getOrThrow()
        val current = snapshot(owner, generation.requestId)
        if (current == generation || (current != null && current.id == generation.id && current.revision > generation.revision)) return
        val next = document.copy(snapshots = document.snapshots +
            (owner to (document.snapshots[owner].orEmpty() + (generation.requestId to generation))))
        AtomicDocument.write(file, diskJson.encodeToString(Document.serializer(), next))
        document = next
    }

    @Synchronized fun clear(owner: String, threadId: String, requestId: String? = null) {
        restored.getOrThrow()
        val mine = document.pending[owner].orEmpty()
        val kept = mine.filterValues { it.thread != threadId || (requestId != null && it.requestId != requestId) }
        if (kept == mine && (requestId != null || document.drafts[owner]?.containsKey(threadId) != true)) return
        val removed = mine.keys - kept.keys
        val next = document.copy(pending = (document.pending + (owner to kept)).filterValues { it.isNotEmpty() },
            snapshots = (document.snapshots + (owner to (document.snapshots[owner].orEmpty() - removed))).filterValues { it.isNotEmpty() },
            drafts = if (requestId == null) document.drafts + (owner to (document.drafts[owner].orEmpty() - threadId)) else document.drafts)
        AtomicDocument.write(file, diskJson.encodeToString(Document.serializer(), next))
        document = next
        discardUnusedPhotos(owner)
    }

    @Synchronized fun draft(owner: String, key: String): CoachDraft = document.drafts[owner]?.get(key) ?: CoachDraft()

    @Synchronized fun saveDraft(owner: String, key: String, draft: CoachDraft) {
        restored.getOrThrow()
        val mine = document.drafts[owner].orEmpty() + (key to draft)
        val next = document.copy(drafts = document.drafts + (owner to mine.filterValues { it.text.isNotEmpty() || it.photo != null }))
        AtomicDocument.write(file, diskJson.encodeToString(Document.serializer(), next))
        document = next
        discardUnusedPhotos(owner)
    }

    private fun discardUnusedPhotos(owner: String) {
        val retained = document.pending[owner].orEmpty().values.flatMap { it.attachmentIds }.toSet() +
            document.drafts[owner].orEmpty().values.mapNotNull { it.photo?.id }
        photoFile(owner, "directory-probe").parentFile?.listFiles()?.forEach { photo ->
            if (photo.name !in retained) photo.delete()
        }
    }

    fun photoFile(owner: String, id: String): File {
        require(id.matches(Regex("[A-Za-z0-9_-]{8,64}")))
        val seat = MessageDigest.getInstance("SHA-256").digest(owner.toByteArray()).joinToString("") { "%02x".format(it) }
        return File(file.parentFile, "coach-photos/$seat/$id")
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
