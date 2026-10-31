package works.windmill.gym.coach

import works.windmill.gym.domain.Ids
import works.windmill.gym.store.diskJson
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import kotlinx.serialization.Serializable
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import works.windmill.platform.storage.AtomicDocument
import works.windmill.gym.coach.onboarding.CoachOnboardingRecord

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class LocalChat(
    val id: String,
    @EncodeDefault val createdAtMs: Long = System.currentTimeMillis(),
    @EncodeDefault val updatedAtMs: Long = createdAtMs,
    val exchanges: List<AskExchange> = emptyList(),
    val history: AskThread? = null,
    val scroll: Int = 0,
    val followEnd: Boolean = true,
    val cap: String? = null,
    val absent: Boolean = false,
    val setup: Boolean = false,
) {
    val title: String get() = history?.title ?: exchanges.firstOrNull()?.question.orEmpty()

    fun refusedRequest(requestId: String): Boolean {
        val exchange = exchanges.lastOrNull { it.requestId == requestId } ?: return false
        if (exchange.generation != null || exchange.pending || exchange.again) return false
        return exchange.terminalRefusal || exchange.needsNew ||
            exchange == exchanges.lastOrNull() && (cap != null || absent)
    }
}

internal data class CoachDraftRecovery(val owner: String, val chat: String, val action: String,
    val source: Pair<String, String>? = null, val published: Boolean = false)

internal data class CoachDraftMove(val sourceOwner: String, val sourceChat: String, val targetChat: String)

internal class CoachDraftWriteFailure(cause: Exception) : Exception(cause)

class LocalCoach internal constructor(private val file: File, private val write: (File, String) -> Unit,
    private val writesAllowed: () -> Boolean,
) {
    constructor(file: File, writesAllowed: () -> Boolean = { true }) : this(file, AtomicDocument::write, writesAllowed)
    internal constructor(file: File, write: (File, String) -> Unit) : this(file, write, { true })
    companion object { const val fileName = "windmill-gym-coach.json" }

    @Serializable
    private data class Document(
        val anonymousId: String = "",
        val ownerEpochs: Map<String, Long> = emptyMap(),
        val deletedOwners: Set<String> = emptySet(),
        val selected: Map<String, String> = emptyMap(),
        val chats: Map<String, Map<String, LocalChat>> = emptyMap(),
        val pending: Map<String, Map<String, AskQuestion>> = emptyMap(),
        val snapshots: Map<String, Map<String, AskGeneration>> = emptyMap(),
        val drafts: Map<String, Map<String, CoachDraft>> = emptyMap(),
        val keptDrafts: Map<String, Map<String, List<KeptCoachDraft>>> = emptyMap(),
        val choices: Map<String, Map<String, Map<String, Map<String, List<String>>>>> = emptyMap(),
        val confirmations: Map<String, Map<String, CoachRoutineConfirmation>> = emptyMap(),
        val onboarding: Map<String, Map<String, CoachOnboardingRecord>> = emptyMap(),
    )

    private val restored = runCatching {
        if (file.exists()) diskJson.decodeFromString<Document>(file.readText()) else Document()
    }
    private var document = restored.getOrDefault(Document())

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
                selected = document.selected - owner, chats = document.chats - owner,
                pending = document.pending - owner, snapshots = document.snapshots - owner,
                drafts = document.drafts - owner, keptDrafts = document.keptDrafts - owner,
                choices = document.choices - owner, confirmations = document.confirmations - owner,
                onboarding = document.onboarding - owner,
            )
            saveOwnerState(next)
        }
        if (draftRecovery?.owner == owner) draftRecovery = null
        val photos = photoFile(owner, "directory-probe").parentFile
        check(photos == null || !photos.exists() || photos.deleteRecursively()) { "The account photos could not be removed." }
    }

    @Synchronized fun reopenVerifiedOwner(owner: String) {
        reconcileOwnerState()
        ready()
        check(!ownerStateUnreadable && writesAllowed())
        if (owner in document.deletedOwners) saveOwnerState(document.copy(deletedOwners = document.deletedOwners - owner))
    }

    private fun reconcileOwnerState() {
        val expected = uncertainOwnerWrite ?: return
        val retained = diskJson.decodeFromString<Document>(file.readText())
        check(retained == expected.first || retained == expected.second) { "The account archive changed." }
        document = retained
        uncertainOwnerWrite = null
    }

    private fun saveOwnerState(next: Document) {
        val before = document
        try { write(file, diskJson.encodeToString(Document.serializer(), next)) }
        catch (failure: Exception) {
            val retained = runCatching { diskJson.decodeFromString<Document>(file.readText()) }.getOrNull()
            if (retained == null || retained != before && retained != next) {
                uncertainOwnerWrite = before to next
                throw failure
            }
            document = retained
            if (retained != next) throw failure
        }
        document = next
    }

    private var uncertainWrite: kotlinx.serialization.json.JsonElement? = null
    private var draftRecovery: CoachDraftRecovery? = null
    private var uncertainDraftRecovery: CoachDraftRecovery? = null

    private fun ready() {
        restored.getOrThrow()
        uncertainWrite?.let { intended ->
            val actual = diskJson.parseToJsonElement(file.readText())
            document = diskJson.decodeFromJsonElement(Document.serializer(), actual)
            uncertainDraftRecovery?.let { draftRecovery = it.copy(published = actual == intended) }
            uncertainDraftRecovery = null
            uncertainWrite = null
        }
    }

    private fun saveChange(owner: String, next: Document, recovery: CoachDraftRecovery? = null,
        publishedFailure: (Exception) -> Unit) {
        checkWritable(owner)
        recovery?.source?.let { checkWritable(it.first) }
        val encoded = diskJson.encodeToString(Document.serializer(), next)
        try { write(file, encoded) }
        catch (failure: Exception) {
            val actual = try {
                diskJson.parseToJsonElement(file.readText()).also { document = diskJson.decodeFromJsonElement(Document.serializer(), it) }
            } catch (_: Exception) {
                uncertainWrite = diskJson.parseToJsonElement(encoded)
                uncertainDraftRecovery = recovery
                if (recovery != null) draftRecovery = recovery
                throw failure
            }
            if (actual != diskJson.parseToJsonElement(encoded)) throw failure
            publishedFailure(failure)
            return
        }
        document = next
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
        val next = document.copy(anonymousId = "anonymous:" + Ids.thread())
        write(file, diskJson.encodeToString(Document.serializer(), next))
        document = next
        return next.anonymousId
    }

    @Synchronized fun selected(owner: String): String? {
        ready()
        return document.selected[owner]
    }

    @Synchronized fun select(owner: String, id: String) {
        checkWritable(owner)
        require(chats(owner).any { it.id == id })
        if (document.selected[owner] == id) return
        val next = document.copy(selected = document.selected + (owner to id))
        write(file, diskJson.encodeToString(Document.serializer(), next))
        document = next
    }

    @Synchronized fun chats(owner: String): List<LocalChat> {
        ready()
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
        checkWritable(owner)
        if (document.chats[owner]?.get(chat.id) == chat && (!select || document.selected[owner] == chat.id)) return
        val next = document.copy(
            selected = if (select) document.selected + (owner to chat.id) else document.selected,
            chats = document.chats + (owner to (document.chats[owner].orEmpty() + (chat.id to chat))))
        write(file, diskJson.encodeToString(Document.serializer(), next))
        document = next
    }

    @Synchronized fun pending(owner: String): List<AskQuestion> {
        ready()
        return document.pending[owner].orEmpty().values.toList()
    }

    @Synchronized fun onboarding(owner: String, requestId: String): CoachOnboardingRecord? {
        ready()
        return document.onboarding[owner]?.get(requestId)
    }

    @Synchronized fun archivedChat(owner: String, chat: String): LocalChat? {
        ready()
        return document.chats[owner]?.get(chat)
    }

    @Synchronized fun onboarding(): List<CoachOnboardingRecord> {
        ready()
        return document.onboarding.values.flatMap { it.values }
    }

    @Synchronized fun keepOnboarding(record: CoachOnboardingRecord): Boolean {
        checkWritable(record.owner)
        val chat = document.chats[record.owner]?.get(record.chat) ?: return false
        require(record.request().requestId == record.requestId)
        val previous = document.onboarding[record.owner]?.get(record.requestId)
        require(previous == null || previous.owner == record.owner && previous.chat == record.chat &&
            previous.replica == record.replica && previous.body == record.body && previous.attachment == record.attachment)
        if (previous?.response?.terminal == true && record.response?.terminal != true) return true
        if (previous == record) return true
        val next = document.copy(
            chats = document.chats + (record.owner to (document.chats[record.owner].orEmpty() + (record.chat to chat))),
            onboarding = document.onboarding + (record.owner to (document.onboarding[record.owner].orEmpty() + (record.requestId to record))))
        write(file, diskJson.encodeToString(Document.serializer(), next))
        document = next
        return true
    }

    @Synchronized fun keep(owner: String, question: AskQuestion) {
        checkWritable(owner)
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
        checkWritable(owner)
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
        checkWritable(owner)
        val generation = confirmation.generation
        val current = document.confirmations[owner]?.get(generation.requestId)
        if (current != null && current.generation.revision >= generation.revision) return
        val next = document.copy(confirmations = document.confirmations +
            (owner to (document.confirmations[owner].orEmpty() + (generation.requestId to confirmation))))
        write(file, diskJson.encodeToString(Document.serializer(), next))
        document = next
    }

    @Synchronized fun pauseRequest(owner: String, chat: LocalChat, requestId: String,
        publishedFailure: (Exception) -> Unit = { throw it },
    ) {
        checkWritable(owner)
        val next = document.copy(
            chats = document.chats + (owner to (document.chats[owner].orEmpty() + (chat.id to chat))),
            pending = document.pending + (owner to (document.pending[owner].orEmpty() - requestId)),
            snapshots = document.snapshots + (owner to (document.snapshots[owner].orEmpty() - requestId)),
        )
        saveChange(owner, next, publishedFailure = publishedFailure)
        discardUnusedPhotos(owner)
    }

    @Synchronized fun clear(owner: String, threadId: String, requestId: String? = null) {
        checkWritable(owner)
        val mine = document.pending[owner].orEmpty()
        val kept = mine.filterValues { it.thread != threadId || (requestId != null && it.requestId != requestId) }
        val hasDraft = document.drafts[owner]?.containsKey(threadId) == true
        val hasConfirmation = document.confirmations[owner].orEmpty().values.any { it.thread == threadId }
        val hasChat = document.chats[owner]?.containsKey(threadId) == true
        val onboarding = document.onboarding[owner].orEmpty().filterValues {
            it.chat != threadId || requestId != null && it.requestId != requestId
        }
        if (kept == mine && onboarding == document.onboarding[owner].orEmpty() && (requestId != null || !hasDraft && !hasConfirmation && !hasChat)) return
        val removed = mine.keys - kept.keys
        val next = document.copy(
            chats = if (requestId == null) document.chats + (owner to (document.chats[owner].orEmpty() - threadId)) else document.chats,
            selected = if (requestId == null && document.selected[owner] == threadId) document.selected - owner else document.selected,
            pending = (document.pending + (owner to kept)).filterValues { it.isNotEmpty() },
            snapshots = (document.snapshots + (owner to (document.snapshots[owner].orEmpty() - removed))).filterValues { it.isNotEmpty() },
            drafts = if (requestId == null) document.drafts + (owner to (document.drafts[owner].orEmpty() - threadId)) else document.drafts,
            keptDrafts = if (requestId == null) document.keptDrafts + (owner to (document.keptDrafts[owner].orEmpty() - threadId)) else document.keptDrafts,
            choices = if (requestId == null) document.choices + (owner to (document.choices[owner].orEmpty() - threadId)) else document.choices,
            confirmations = if (requestId == null) document.confirmations + (owner to document.confirmations[owner].orEmpty().filterValues { it.thread != threadId }) else document.confirmations,
            onboarding = (document.onboarding + (owner to onboarding)).filterValues { it.isNotEmpty() })
        write(file, diskJson.encodeToString(Document.serializer(), next))
        document = next
        discardUnusedPhotos(owner)
    }

    @Synchronized fun draft(owner: String, key: String): CoachDraft = document.drafts[owner]?.get(key) ?: CoachDraft()

    @Synchronized fun keptDrafts(owner: String, chat: String): List<KeptCoachDraft> {
        return document.keptDrafts[owner]?.get(chat).orEmpty()
    }

    @Synchronized fun choices(owner: String, chat: String, clarification: String): Map<String, List<String>> {
        return document.choices[owner]?.get(chat)?.get(clarification).orEmpty()
    }

    @Synchronized internal fun saveChoice(owner: String, chatId: String, clarification: String,
        selected: Map<String, List<String>>, draft: CoachDraft, publishedFailure: (Exception) -> Unit = {}) {
        ready()
        val chat = document.chats[owner]?.get(chatId) ?: return
        val next = document.copy(
            chats = document.chats + (owner to (document.chats[owner].orEmpty() + (chatId to chat.copy(updatedAtMs = System.currentTimeMillis())))),
            drafts = document.drafts + (owner to (document.drafts[owner].orEmpty() + (chatId to draft))),
            choices = document.choices + (owner to (document.choices[owner].orEmpty() +
                (chatId to (document.choices[owner]?.get(chatId).orEmpty() + (clarification to selected))))))
        saveChange(owner, next, CoachDraftRecovery(owner, chatId, "choose"), publishedFailure)
    }

    @Synchronized internal fun continueDraft(owner: String, chatId: String, heldId: String,
        publishedFailure: (Exception) -> Unit = {}): Boolean {
        ready()
        val chat = document.chats[owner]?.get(chatId) ?: return false
        val held = keptDrafts(owner, chatId)
        val index = held.indexOfFirst { it.id == heldId }
        if (index < 0) return false
        val previous = draft(owner, chatId)
        val remaining = held.toMutableList().apply {
            if (previous.text.isNotEmpty() || previous.photo != null) set(index, held[index].copy(draft = previous)) else removeAt(index)
        }
        val next = document.copy(
            chats = document.chats + (owner to (document.chats[owner].orEmpty() + (chatId to chat.copy(updatedAtMs = System.currentTimeMillis())))),
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
        val source = document.chats[sourceOwner]?.get(sourceId) ?: return null
        val original = draft(sourceOwner, sourceId)
        if (original.text.isEmpty() && original.photo == null) return null
        val selected = document.selected[targetOwner]
        val target = selected?.let { document.chats[targetOwner]?.get(it) } ?: LocalChat(Ids.thread(), setup = source.setup)
        val previous = draft(targetOwner, target.id)
        var moved = original.copy(setup = original.setup || source.setup)
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
            val occupied = previous.text.isNotEmpty() || previous.photo != null ||
                document.pending[targetOwner].orEmpty().values.any { it.thread == target.id }
            val kept = keptDrafts(targetOwner, target.id) + if (occupied) listOf(KeptCoachDraft(Ids.thread(), moved)) else emptyList()
            val next = document.copy(
                selected = document.selected + (targetOwner to target.id),
                chats = document.chats + (targetOwner to (document.chats[targetOwner].orEmpty() +
                    (target.id to target.copy(updatedAtMs = System.currentTimeMillis())))),
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
        val chat = chats(owner).firstOrNull { it.id == key } ?: LocalChat(key)
        val next = document.copy(
            chats = document.chats + (owner to (document.chats[owner].orEmpty() + (key to chat.copy(updatedAtMs = System.currentTimeMillis())))),
            drafts = document.drafts + (owner to mine.filterValues { it.text.isNotEmpty() || it.photo != null }))
        write(file, diskJson.encodeToString(Document.serializer(), next))
        document = next
        discardUnusedPhotos(owner)
    }

    private fun retainedPhotoIds(owner: String): Set<String> = (document.pending[owner].orEmpty().values.flatMap { it.attachmentIds }.toSet() +
            document.drafts[owner].orEmpty().values.mapNotNull { it.photo?.id } +
            document.keptDrafts[owner].orEmpty().values.flatten().mapNotNull { it.draft.photo?.id } +
            document.onboarding[owner].orEmpty().values.mapNotNull { it.attachment?.id } +
            document.chats[owner].orEmpty().values.flatMap { chat -> chat.exchanges.flatMap { it.attachments.map { photo -> photo.id } } }).toSet()

    @Synchronized internal fun discardUnusedPhotos(owner: String) {
        checkWritable(owner)
        val retained = retainedPhotoIds(owner)
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
        checkWritable(owner)
        if (draftRecovery?.let { it.owner == owner && it.chat == key } == true) return false
        if (document.chats[owner]?.containsKey(key) != true) return false
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
