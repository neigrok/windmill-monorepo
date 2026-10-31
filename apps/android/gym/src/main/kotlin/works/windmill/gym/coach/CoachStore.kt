package works.windmill.gym.coach

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import works.windmill.gym.domain.Ids
import works.windmill.gym.net.GymRest
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.Seat
import works.windmill.gym.store.TrainingRefused
import works.windmill.gym.store.TrainingUnanswered
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.telemetry.Telemetry
import works.windmill.gym.coach.onboarding.AnonymousCoachAccess
import works.windmill.gym.coach.onboarding.CoachOnboardingStore
import works.windmill.gym.coach.onboarding.CoachOnboardingOutcome
import works.windmill.gym.coach.onboarding.CoachOnboardingImage
import works.windmill.gym.coach.onboarding.CoachOnboardingLimits
import works.windmill.gym.coach.onboarding.CoachOnboardingRecord
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.util.Base64
import kotlinx.coroutines.flow.collect

class CoachAdmission internal constructor(
    private val allowed: () -> Boolean = { true },
    private val commit: (() -> Unit) -> Unit = { it() },
) {
    private var admitted = true
    internal val active: Boolean @Synchronized get() = admitted && allowed()
    @Synchronized internal fun retire() { admitted = false }
    @Synchronized internal fun write(block: () -> Unit) { if (active) commit(block) }
    internal fun check() { if (!active) throw CancellationException("coach-request-ended") }
}

class CoachStore internal constructor(
    private val accountOwner: () -> String?,
    private val withheldIds: () -> Set<String>,
    private val onProgramChanged: () -> Unit,
    private val rest: () -> GymRest?,
    private val localCoach: LocalCoach?,
    private val telemetry: Telemetry,
    private val elapsedNanos: () -> Long,
    private val scope: CoroutineScope,
    private val storageDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val onboarding: CoachOnboardingStore? = null,
) {
    private val owner: String? get() = accountOwner()
    private val anonymousOwner by lazy {
        try { localCoach?.anonymousOwner() ?: "anonymous:" + Ids.thread() }
        catch (failure: Exception) { telemetry.failure("gym.restoreConversation", failure); "anonymous:" + Ids.thread() }
    }
    private val archiveOwner: String get() = owner ?: anonymousOwner
    val accountKey: String get() = Seat.of(archiveOwner)
    private val conversationWrite = Mutex()
    @Volatile private var ownerRevision = 0L
    private val archive = mutableStateMapOf<Pair<String, String>, LocalChat>()
    private val selected = mutableStateMapOf<String, String>()
    private val restoredOwners = mutableSetOf<String>()
    private val jobs = mutableMapOf<Pair<String, String>, Job>()
    private val uploads = mutableStateMapOf<Pair<String, String>, Float>()
    private val busy = mutableStateMapOf<Pair<String, String>, Boolean>()
    private val admissions = mutableMapOf<Pair<String, String>, CoachAdmission>()
    private val stopping = mutableMapOf<Pair<String, String>, CoachAdmission>()
    private val chatVersions = mutableMapOf<Pair<String, String>, Long>()
    var archiveFailure by mutableStateOf<String?>(null)
        private set
    private var onboardingRevision by mutableStateOf(0L)
    var anonymousAccess by mutableStateOf(AnonymousCoachAccess.Checking)
        private set
    private var accessJob: Job? = null
    val anonymous: Boolean get() = owner == null

    init {
        onboarding?.let { coordinator -> scope.launch {
            coordinator.changes.collect {
                onboardingRevision++
                try {
                    if (owner == null && localCoach?.onboarding()?.any { record -> record.owner == anonymousOwner &&
                            (record.response?.errorCode ?: record.refusalCode) in setOf("device_bound", "installation_bound") } == true)
                        anonymousAccess = AnonymousCoachAccess.Bound
                } catch (failure: Exception) { reportFailure("gym.restoreConversation", failure) }
            }
        } }
    }

    fun refreshAnonymousAccess() {
        if (owner != null) {
            accessJob?.cancel()
            accessJob = null
            anonymousAccess = AnonymousCoachAccess.Checking
            return
        }
        if (accessJob?.isActive == true) return
        accessJob = scope.launch {
            val access = onboarding?.access() ?: AnonymousCoachAccess.Unavailable
            if (owner == null) {
                if (access != anonymousAccess) telemetry.event("gym_action", mapOf("screen" to "coach", "action" to "access", "outcome" to access.name.lowercase()))
                anonymousAccess = access
            }
        }
    }

    private fun admit(seat: String): CoachAdmission {
        val disk = localCoach ?: return CoachAdmission()
        val authority = disk.admit(seat)
        return CoachAdmission({ disk.current(authority) }, { write -> disk.withAuthority(authority, write) })
    }

    fun eraseOwner(seat: String) {
        localCoach?.eraseOwner(seat)
        admissions.filterKeys { it.first == seat }.values.forEach { it.retire() }
        jobs.filterKeys { it.first == seat }.values.forEach { it.cancel() }
        (archive.keys + chatVersions.keys).filter { it.first == seat }.forEach { key ->
            chatVersions[key] = (chatVersions[key] ?: 0) + 1
        }
        archive.keys.removeAll { it.first == seat }
        admissions.keys.removeAll { it.first == seat }
        stopping.keys.removeAll { it.first == seat }
        jobs.keys.removeAll { it.first == seat }
        uploads.keys.removeAll { it.first == seat }
        busy.keys.removeAll { it.first == seat }
        drafts.keys.removeAll { it.first == seat }
        unsavedDrafts.removeAll { it.first == seat }
        confirmations = confirmations.filterKeys { it.first != seat }
        selected.remove(seat)
        restoredOwners.remove(seat)
        if (conversationsOwner == seat) resetThreads()
    }

    private fun restoreArchive(seat: String) {
        if (seat in restoredOwners) return
        try {
            localCoach?.chats(seat).orEmpty().forEach { archive[seat to it.id] = it }
            localCoach?.selected(seat)?.let { selected[seat] = it }
            restoredOwners += seat
        } catch (failure: Exception) {
            restoredOwners += seat
            reportFailure("gym.restoreConversation", failure)
        }
    }

    fun chat(id: String): LocalChat? {
        val seat = archiveOwner
        restoreArchive(seat)
        val chat = archive[seat to id] ?: return null
        if (owner != null || onboarding == null) return chat
        onboardingRevision
        val records = onboarding.records(seat, id)
        val recorded = records.map { it.requestId }.toSet()
        val exchanges = chat.exchanges.filterNot { it.requestId in recorded } + records.map { record ->
            val response = record.response
            val code = response?.errorCode ?: record.refusalCode
            val pending = record.pending && onboarding.active(seat, id)
            AskExchange(record.request().text,
                answer = response?.takeIf { it.status == "completed" }?.let { AskAnswer(it.message, ReadTally()) },
                trouble = when {
                    response?.status == "completed" || pending -> null
                    code == CoachOnboardingRecord.unanswered -> Ask.interrupted
                    code == "account_required" -> Ask.accountRequired
                    code == "subject_exhausted" -> AskCap.Allowance.wordless
                    code in setOf("free_day_exhausted", "free_month_exhausted", "concurrency_exhausted", "funding_required") ->
                        response?.message?.takeIf { it.isNotBlank() } ?: record.refusalMessage ?: "Coach couldn’t take that one"
                    code != null || response?.status == "expired" -> "Coach couldn’t take that one"
                    else -> Ask.interrupted
                },
                again = response == null && !pending && (code == null || code == CoachOnboardingRecord.unanswered),
                requestId = record.requestId, atMs = record.createdAtMs, refusalCode = code, attachments = listOfNotNull(record.attachment))
        }
        val ordered = exchanges.sortedBy { it.atMs }
        return chat.copy(exchanges = ordered,
            cap = AskCap.Allowance.name.takeIf { ordered.lastOrNull()?.refusalCode == "subject_exhausted" })
    }

    val selectedChatId: String?
        get() { restoreArchive(archiveOwner); return selected[archiveOwner] }

    fun freshChat(seed: String = "", id: String = Ids.thread(), setup: Boolean = false): String {
        val seat = archiveOwner
        admit(seat).check()
        restoreArchive(seat)
        archive[seat to id]?.let {
            if (selected[seat] != id) select(seat, id)
            return id
        }
        val chat = LocalChat(id, setup = setup)
        keepChat(seat, chat, select = true)
        selected[seat] = chat.id
        if (seed.isNotEmpty()) saveDraft(chat.id, CoachDraft(seed))
        telemetry.event("gym_action", mapOf("screen" to "coach", "action" to "fresh_entry", "outcome" to "ok"))
        return chat.id
    }

    fun selectChat(id: String, action: String = "history_open") {
        val seat = archiveOwner
        if (localCoach?.writable(seat) == false) return
        restoreArchive(seat)
        val chat = archive[seat to id] ?: LocalChat(id).also { keepChat(seat, it) }
        select(seat, chat.id)
        telemetry.event("gym_action", mapOf("screen" to "coach", "action" to action, "outcome" to "ok"))
        if (draft(id).let { it.text.isNotEmpty() || it.photo != null })
            telemetry.event("gym_action", mapOf("screen" to "coach", "action" to "draft_restored", "outcome" to "ok"))
    }

    private fun select(seat: String, id: String) {
        admit(seat).check()
        try { localCoach?.select(seat, id) }
        catch (failure: Exception) {
            reportFailure("gym.saveConversation", failure)
            archiveFailure = "Your conversation couldn’t be saved. Try again."
        }
        selected[seat] = id
    }

    private fun keepChat(seat: String, chat: LocalChat, select: Boolean = false) {
        admit(seat).check()
        archive[seat to chat.id] = chat
        try {
            localCoach?.saveChat(seat, chat, select)
            archiveFailure = null
        } catch (failure: Exception) {
            reportFailure("gym.saveConversation", failure)
            archiveFailure = "Your conversation couldn’t be saved. Try again."
        }
    }

    fun keepPosition(id: String, scroll: Int, followEnd: Boolean) {
        if (localCoach?.writable(archiveOwner) == false) return
        val chat = archive[archiveOwner to id] ?: return
        if (chat.scroll == scroll && chat.followEnd == followEnd) return
        keepChat(archiveOwner, chat.copy(scroll = scroll.coerceAtLeast(0), followEnd = followEnd))
    }

    fun isAsking(id: String): Boolean {
        onboardingRevision
        return busy[archiveOwner to id] == true || owner == null && onboarding?.active(archiveOwner, id) == true
    }
    fun upload(id: String): Float? = uploads[archiveOwner to id]
    fun pendingChat(except: String): LocalChat? {
        restoreArchive(archiveOwner)
        return archive.filterKeys { it.first == archiveOwner && it.second != except }
            .values.map { chat(it.id) ?: it }.firstOrNull { isAsking(it.id) || it.exchanges.lastOrNull()?.generation?.status == "running" }
    }

    fun submit(id: String, text: String, photo: CoachAttachment? = null, requestId: String = Ids.thread(),
        authenticatedOwner: String? = owner,
    ): Boolean {
        if (authenticatedOwner == null && owner == null) return submitAnonymous(id, text, photo, requestId)
        if (authenticatedOwner == null || authenticatedOwner != owner) return false
        val seat = authenticatedOwner
        if (localCoach?.writable(seat) == false) return false
        val chat = chat(id) ?: return false
        if (owner == null || isAsking(id) || Ask.needsNew(chat.exchanges) ||
            (!Ask.sendable(text) && (photo == null || text.toByteArray().size > Ask.maxTurnBytes))) return false
        val prior = chat.exchanges.lastOrNull()?.takeIf { it.requestId == requestId }
        val from = if (prior != null) chat.exchanges.dropLast(1) else chat.exchanges
        val attachments = prior?.attachments.orEmpty().ifEmpty { listOfNotNull(photo) }
        val pending = AskExchange(text.trim(), requestId = requestId, generation = prior?.generation, attachments = attachments,
            atMs = prior?.atMs ?: System.currentTimeMillis())
        val submittedDraft = draft(seat, id).copy(text = pending.question, photo = attachments.firstOrNull())
        try {
            saveDraft(id, submittedDraft)
            keepChat(seat, chat.copy(exchanges = from + pending, cap = null, updatedAtMs = System.currentTimeMillis()))
        } catch (_: Exception) { return false }
        val key = seat to id
        val admission = admit(seat)
        admissions[key] = admission
        busy[key] = true
        if (attachments.isNotEmpty() && prior?.generation == null) uploads[key] = 0f
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                val outcome = ask(id, pending.question, requestId, attachments.firstOrNull(), stream = true,
                    authenticatedOwner = authenticatedOwner, admission = admission,
                    onSnapshot = { snapshot ->
                        if (admissions[key] === admission && admission.active) {
                            val current = archive[key] ?: chat
                            archive[key] = current.copy(exchanges = from + snapshot.exchange().copy(attachments = snapshot.attachments.ifEmpty { attachments }, atMs = pending.atMs, position = prior?.position ?: 0))
                        }
                    }, onUpload = { progress ->
                        if (admissions[key] === admission && admission.active) {
                            if (progress == null) uploads.remove(key) else uploads[key] = progress
                        }
                    })
                if (admissions[key] !== admission || !admission.active) return@launch
                val current = archive[key] ?: chat
                keepChat(seat, current.copy(exchanges = from + outcome.exchange(pending),
                    cap = (outcome as? AskOutcome.Capped)?.cap?.name, absent = outcome is AskOutcome.Absent))
                if (outcome is AskOutcome.Answered && draft(seat, id) == submittedDraft)
                    saveDraft(seat, id, CoachDraft())
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { reportFailure("gym.saveConversation", failure) }
            finally {
                if (admissions[key] === admission) {
                    admission.retire()
                    admissions.remove(key); busy.remove(key); uploads.remove(key); jobs.remove(key)
                    if (stopping[key] === admission) stopping.remove(key)
                }
            }
        }
        jobs[key] = job
        job.start()
        return true
    }

    private fun submitAnonymous(id: String, text: String, photo: CoachAttachment?, requestId: String): Boolean {
        val coordinator = onboarding ?: return false
        if (anonymousAccess != AnonymousCoachAccess.Available || isAsking(id) || chat(id) == null) return false
        val question = text.trim()
        if (question.toByteArray().size > CoachOnboardingLimits.textBytes || question.isEmpty() && photo == null) return false
        val seat = archiveOwner
        val held = CoachDraft(text, photo)
        try { saveDraft(seat, id, held) } catch (_: Exception) { return false }
        val key = seat to id
        busy[key] = true
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                val existing = coordinator.records(seat, id).firstOrNull { it.requestId == requestId && it.request().text == question }
                val outcome = if (existing != null) coordinator.retry(seat, existing.requestId).await() else {
                    val image = photo?.let { attachment ->
                        val bytes = withContext(storageDispatcher) { localCoach?.photoFile(seat, attachment.id)?.readBytes() }
                            ?: throw java.io.IOException("The attached photo is unavailable.")
                        CoachOnboardingImage(attachment.mediaType, Base64.getEncoder().encodeToString(bytes))
                    }
                    if (owner != null || archiveOwner != seat || archive[key] == null) return@launch
                    coordinator.send(id, question, image, photo).await()
                }
                val answered = (outcome as? CoachOnboardingOutcome.Answered)?.record
                if (answered?.request()?.text == question && answered.attachment == photo && draft(seat, id) == held)
                    saveDraft(seat, id, CoachDraft())
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { reportFailure("gym.coachOnboarding", failure) }
            finally { busy.remove(key); jobs.remove(key); onboardingRevision++ }
        }
        jobs[key] = job
        job.start()
        return true
    }

    fun resumeChats() {
        val authenticatedOwner = owner ?: return
        if (localCoach?.writable(authenticatedOwner) == false) return
        val resuming = try { admit(authenticatedOwner) }
        catch (_: CancellationException) { return }
        catch (failure: Exception) {
            reportFailure("gym.restoreConversation", failure)
            archiveFailure = "Your conversation couldn’t be saved. Try again."
            return
        }
        restoreArchive(archiveOwner)
        pendingQuestions().forEach { request ->
            if (isAsking(request.thread)) return@forEach
            val chat = chat(request.thread) ?: LocalChat(request.thread)
            val requestId = requireNotNull(request.requestId)
            if (chat.refusedRequest(requestId) && localCoach?.snapshot(authenticatedOwner, requestId) == null) {
                try { resuming.write {
                    localCoach?.pauseRequest(authenticatedOwner, chat, requestId) { reportFailure("gym.saveConversation", it) }
                } }
                catch (_: CancellationException) { return }
                catch (failure: Exception) {
                    reportFailure("gym.saveConversation", failure)
                    archiveFailure = "Your conversation couldn’t be saved. Try again."
                }
                return@forEach
            }
            if (chat.exchanges.none { it.requestId == request.requestId })
                keepChat(archiveOwner, chat.copy(exchanges = chat.exchanges + pendingExchange(request)))
            submit(request.thread, request.question, draft(request.thread).photo, requireNotNull(request.requestId), authenticatedOwner)
        }
    }

    fun hasRequest(chatId: String, requestId: String): Boolean =
        chat(chatId)?.exchanges.orEmpty().any { it.requestId == requestId } ||
            pendingQuestions().any { it.thread == chatId && it.requestId == requestId }

    fun stopChat(id: String) {
        val authenticatedOwner = owner ?: return
        val seat = authenticatedOwner
        val key = seat to id
        val admission = admissions[key] ?: return
        if (!admission.active) return
        if (stopping[key] === admission) return
        val chat = chat(id) ?: return
        val last = chat.exchanges.lastOrNull() ?: return
        stopping[key] = admission
        if (uploads[key] != null) {
            val paused = chat.copy(exchanges = chat.exchanges.dropLast(1) + last.copy(trouble = "Upload cancelled. Retry to send this photo.", again = true))
            try { admission.write { localCoach?.pauseRequest(seat, paused, last.requestId); admission.retire() } }
            catch (failure: Exception) {
                reportFailure("gym.saveConversation", failure)
                archiveFailure = "Your conversation couldn’t be saved. Try again."
                stopping.remove(key)
                return
            }
            archive[key] = paused
            admissions.remove(key)
            jobs.remove(key)?.cancel()
            busy.remove(key); uploads.remove(key); stopping.remove(key)
            return
        }
        scope.launch {
            try {
                if (owner != authenticatedOwner || admissions[key] !== admission) return@launch
                val snapshot = stop(id, last.requestId, authenticatedOwner, admission)
                if (admissions[key] !== admission || !admission.active) return@launch
                val current = archive[key] ?: return@launch
                val index = current.exchanges.indexOfLast { it.requestId == last.requestId }
                if (index < 0) return@launch
                val exchanges = current.exchanges.toMutableList().apply {
                    set(index, snapshot.exchange().copy(attachments = snapshot.attachments.ifEmpty { last.attachments },
                        atMs = last.atMs, position = last.position))
                }
                keepChat(seat, current.copy(exchanges = exchanges))
                if (snapshot.terminal) {
                    admission.retire()
                    admissions.remove(key)
                    jobs.remove(key)?.cancel()
                    busy.remove(key); uploads.remove(key)
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { reportFailure("gym.ask", failure) }
            finally { if (stopping[key] === admission) stopping.remove(key) }
        }
    }

    private suspend fun retainSnapshot(seat: String, generation: AskGeneration, admission: CoachAdmission? = null) {
        try { persistRequest(admission) { localCoach?.record(seat, generation) } }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            reportFailure("gym.saveConversation", failure)
            archiveFailure = "Your conversation couldn’t be saved. Try again."
        }
    }

    private suspend fun clearRequest(seat: String, thread: String, request: String, admission: CoachAdmission? = null) {
        try { persistRequest(admission) { localCoach?.clear(seat, thread, request) } }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            reportFailure("gym.saveConversation", failure)
            archiveFailure = "Your conversation couldn’t be saved. Try again."
        }
    }

    private suspend fun persistRequest(admission: CoachAdmission?, write: () -> Unit) {
        withContext(storageDispatcher) {
            if (admission == null) write() else admission.write(write)
        }
    }

    private fun reportFailure(operation: String, error: Exception) {
        if (error is WindmillApiException || error is TrainingRefused || error is TrainingUnanswered || error is CancellationException) return
        telemetry.failure(operation, error)
    }

    internal fun resetThreads() {
        ownerRevision++
        conversations = emptyList()
        conversationsOwner = null
        confirmations = emptyMap()
        nextThreadCursor = null
    }

    private companion object {
        const val accountChanged = "The account changed. Open this again."
        const val signInFirst = "Sign in first."
        const val noSuchThread = "that conversation is no longer on the log"
    }

    // Newest first; every screen reads the same list so settled deletes stay removed.
    private var conversations: List<AskThread> by mutableStateOf(emptyList())
    private var conversationsOwner: String? = null
    // Undo hides rows; the empty stance still counts everything the account holds.
    val threads: List<AskThread> get() = allThreads.filterNot { it.id in withheldIds() }
    val allThreads: List<AskThread> get() {
        val seat = archiveOwner
        restoreArchive(seat)
        val local = archive.filterKeys { it.first == seat }.values.mapNotNull { saved ->
            val chat = chat(saved.id) ?: saved
            val draft = draft(chat.id)
            if (chat.history == null && chat.exchanges.isEmpty() && draft.text.isBlank() && draft.photo == null) return@mapNotNull null
            val summary = chat.history ?: AskThread(chat.id)
            summary.copy(id = chat.id, title = chat.title.ifEmpty { draft.text.ifEmpty { "Photo" } },
                createdAtMs = summary.createdAtMs.takeIf { it > 0 } ?: chat.createdAtMs,
                askedAtMs = maxOf(summary.askedAtMs, chat.updatedAtMs),
                turns = chat.exchanges.flatMap { exchange -> listOfNotNull(
                    AskTurn(Ask.fromLifter, exchange.question, requestId = exchange.requestId),
                    exchange.answer?.let { AskTurn("coach", it.answer, receipt = it.receipt, requestId = exchange.requestId) }) },
                generation = chat.exchanges.lastOrNull()?.generation,
                answerPreview = chat.exchanges.lastOrNull { it.answer?.answer?.isNotBlank() == true }?.answer?.answer ?: summary.answerPreview)
        }
        return (local + conversations.takeIf { conversationsOwner == seat }.orEmpty()).distinctBy { it.id }.sortedByDescending { it.askedAtMs }
    }

    fun pendingQuestions(): List<AskQuestion> = try {
        owner?.let { localCoach?.pending(it) }.orEmpty()
    } catch (failure: Exception) {
        reportFailure("gym.restoreConversation", failure)
        emptyList()
    }

    private val drafts = mutableMapOf<Pair<String, String>, CoachDraft>()
    var draftVersion by mutableStateOf(0)
        private set

    private val unsavedDrafts = mutableSetOf<Pair<String, String>>()
    fun draft(key: String): CoachDraft = draft(archiveOwner, key)

    private fun draft(seat: String, key: String): CoachDraft {
        if (seat to key in unsavedDrafts) return drafts[seat to key] ?: CoachDraft()
        return localCoach?.draft(seat, key) ?: drafts[seat to key] ?: CoachDraft()
    }

    fun draftSaved(key: String): Boolean = archiveOwner to key !in unsavedDrafts

    fun saveDraft(key: String, draft: CoachDraft) = saveDraft(archiveOwner, key, draft)

    private fun saveDraft(seat: String, key: String, draft: CoachDraft) {
        admit(seat).check()
        if (seat to key !in unsavedDrafts && draft(seat, key) == draft && (drafts[seat to key] ?: CoachDraft()) == draft) return
        val changed = drafts[seat to key] != draft
        drafts[seat to key] = draft
        if (changed) draftVersion++
        try {
            localCoach?.saveDraft(seat, key, draft)
            restoreArchive(seat)
            val chat = archive[seat to key] ?: LocalChat(key)
            archive[seat to key] = chat.copy(updatedAtMs = System.currentTimeMillis())
            unsavedDrafts.remove(seat to key)
        } catch (failure: Exception) { unsavedDrafts += seat to key; reportFailure("gym.saveDraft", failure); throw failure }
    }

    fun keptDrafts(key: String): List<KeptCoachDraft> {
        draftVersion
        return localCoach?.keptDrafts(archiveOwner, key).orEmpty()
    }

    fun choices(key: String, requestId: String, clarificationId: String): Map<String, List<String>> {
        draftVersion
        return localCoach?.choices(archiveOwner, key, "$requestId:$clarificationId").orEmpty()
    }

    suspend fun adoptPhoneDraft(account: String) {
        if (owner != account) return
        val disk = localCoach ?: return
        val revision = ownerRevision
        val unsaved = unsavedDrafts.toSet()
        try {
            val authority = disk.admit(account)
            val (moved, recovered) = withContext(storageDispatcher) {
                disk.withAuthority(authority) {
                    if (owner != account || ownerRevision != revision) return@withAuthority null to null
                    val recovery = disk.reconcileDraftChange(account)
                    if (recovery != null) return@withAuthority null to recovery
                    val source = disk.selected(anonymousOwner) ?: return@withAuthority null to null
                    if (anonymousOwner to source in unsaved) return@withAuthority null to null
                    disk.adoptPhoneDraft(account, publishedFailure = { reportFailure("gym.adoptCoachDraft", it) }) {
                        disk.current(authority) && owner == account && ownerRevision == revision
                    } to null
                }
            }
            if (!disk.current(authority)) return
            if (recovered != null) publishRecovery(recovered)
            else if (moved != null) {
                drafts.remove(moved.sourceOwner to moved.sourceChat)
                publishDraft(account, moved.targetChat)
            } else return
            val current = disk.selected(account)
            if (current == null) selected.remove(account) else selected[account] = current
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            reportFailure("gym.adoptCoachDraft", failure)
            if (owner == account) archiveFailure = "Your draft couldn’t be saved. Try again."
        }
    }

    fun draftChangeReady(key: String): Boolean {
        val seat = archiveOwner
        if (localCoach?.writable(seat) == false) return false
        val recovered = try { localCoach?.reconcileDraftChange(seat, key) }
        catch (_: Exception) { archiveFailure = "Your draft couldn’t be saved. Try again."; return false }
        if (recovered == null) return true
        publishRecovery(recovered)
        return false
    }

    private fun publishRecovery(recovered: CoachDraftRecovery) {
        recovered.source?.let { drafts.remove(it); unsavedDrafts.remove(it) }
        publishDraft(recovered.owner, recovered.chat)
        if (recovered.action != "adopt") telemetry.event("gym_action",
            mapOf("screen" to "coach", "action" to recovered.action, "outcome" to "ok"))
    }

    fun choose(key: String, requestId: String, expected: CoachClarification, group: String, option: String): Boolean {
        val seat = archiveOwner
        if (!draftChangeReady(key)) return false
        if (isAsking(key) || requestId.isEmpty()) return false
        val current = chat(key)?.exchanges?.firstOrNull { it.requestId == requestId } ?: return false
        val actual = CoachClarification.from(current.answer?.clarification ?: current.generation?.clarification)
        if (actual != expected) return false
        val selected = expected.choosing(choices(key, requestId, expected.id), group, option) ?: return false
        val next = draft(key).copy(text = expected.text(selected))
        try { localCoach?.saveChoice(seat, key, "$requestId:${expected.id}", selected, next) {
            reportFailure("gym.saveDraft", it)
        } ?: return false }
        catch (failure: Exception) { reportFailure("gym.saveDraft", failure); throw failure }
        publishDraft(seat, key)
        telemetry.event("gym_action", mapOf("screen" to "coach", "action" to "choose", "outcome" to "ok"))
        return true
    }

    fun continueDraft(key: String, heldId: String): Boolean {
        val seat = archiveOwner
        if (!draftChangeReady(key)) return false
        if (isAsking(key) || !draftSaved(key)) return false
        try { if (localCoach?.continueDraft(seat, key, heldId) { reportFailure("gym.saveDraft", it) } != true) return false }
        catch (failure: Exception) { reportFailure("gym.saveDraft", failure); throw failure }
        publishDraft(seat, key)
        telemetry.event("gym_action", mapOf("screen" to "coach", "action" to "continue_draft", "outcome" to "ok"))
        return true
    }

    private fun publishDraft(seat: String, key: String) {
        val disk = localCoach ?: return
        drafts[seat to key] = disk.draft(seat, key)
        unsavedDrafts.remove(seat to key)
        val current = archive[seat to key] ?: disk.archivedChat(seat, key)
        if (current != null) archive[seat to key] = current.copy(updatedAtMs = System.currentTimeMillis())
        draftVersion++
        archiveFailure = null
    }

    fun removePhoto(key: String) {
        if (!draftChangeReady(key)) return
        val seat = archiveOwner
        val current = draft(seat, key)
        if (current.photo == null) return
        val next = current.copy(photo = null)
        try { localCoach?.saveDraft(seat, key, next) }
        catch (failure: Exception) { reportFailure("gym.saveDraft", failure); throw failure }
        drafts[seat to key] = next
        unsavedDrafts.remove(seat to key)
        draftVersion++
        archive[seat to key]?.let { archive[seat to key] = it.copy(updatedAtMs = System.currentTimeMillis()) }
        telemetry.event("gym_setup_step", mapOf("screen" to "coach", "action" to "photo_removed"))
    }

    suspend fun importPhoto(key: String, resolver: android.content.ContentResolver, uri: android.net.Uri) {
        val maxBytes = if (owner == null) CoachOnboardingLimits.photoBytes else CoachPhotos.maxBytes
        importPhoto(key) { withContext(storageDispatcher) { CoachPhotos.read(resolver, uri, maxBytes = maxBytes) } }
    }

    internal suspend fun importPhoto(key: String, prepare: suspend () -> Pair<CoachAttachment, ByteArray>) {
        if (!draftChangeReady(key)) return
        val prepareOperation = if (owner == null) "gym.coachOnboarding" else "gym.preparePhoto"
        val seat = archiveOwner
        val origin = seat to key
        val version = chatVersions[origin] ?: 0
        val disk = localCoach ?: error("Photo storage is unavailable.")
        val authority = disk.admit(seat)
        val current = chat(key) ?: return
        keepChat(seat, current)
        scope.async {
            val prepared = try { prepare() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { reportFailure(prepareOperation, failure); throw failure }
            if (!disk.current(authority) || (chatVersions[origin] ?: 0) != version || archive[origin] == null) return@async
            val (photo, bytes) = prepared
            val attached = try { withContext(storageDispatcher) { disk.withAuthority(authority) { disk.attachPhoto(seat, key, photo, bytes) } } }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                if (failure is CoachDraftWriteFailure) reportFailure("gym.saveDraft", failure.cause as Exception)
                else reportFailure("gym.savePhoto", failure)
                throw failure
            }
            if (!attached) return@async
            if (!disk.current(authority) || (chatVersions[origin] ?: 0) != version || archive[origin] == null) {
                withContext(storageDispatcher) { if (disk.current(authority)) disk.withAuthority(authority) { disk.discardUnusedPhotos(seat) } }
                return@async
            }
            saveDraft(seat, key, draft(seat, key).copy(photo = photo))
            telemetry.event("gym_setup_step", mapOf("screen" to "coach", "action" to "photo_selected"))
        }.await()
    }

    suspend fun photo(threadId: String, photo: CoachAttachment): ByteArray {
        val seat = archiveOwner
        val authority = admit(seat)
        val cached = localCoach?.photoFile(seat, photo.id)
        val bytes = if (cached?.isFile == true) withContext(storageDispatcher) { cached.readBytes() }
            else (rest() ?: error(signInFirst)).photo(threadId, photo.id)
        authority.check()
        check(seat == archiveOwner) { accountChanged }
        return bytes
    }

    suspend fun stop(threadId: String, requestId: String, authenticatedOwner: String? = owner, admission: CoachAdmission? = null): AskGeneration {
        val seat = authenticatedOwner ?: error(signInFirst)
        val requestAdmission = admission ?: admit(seat)
        if (seat != owner) throw CancellationException("coach-owner-changed")
        val coach = rest() ?: error(signInFirst)
        if (seat != owner) throw CancellationException("coach-owner-changed")
        requestAdmission.check()
        val generation = coach.stop(threadId, requestId)
        if (seat != owner) throw CancellationException("coach-owner-changed")
        requestAdmission.check()
        retainSnapshot(seat, generation, requestAdmission)
        requestAdmission.check()
        if (seat != owner) throw CancellationException("coach-owner-changed")
        val current = listOfNotNull(localCoach?.snapshot(seat, requestId), generation).maxBy { it.revision }
        if (current.status in listOf("completed", "stopped")) clearRequest(seat, threadId, requestId, requestAdmission)
        requestAdmission.check()
        if (seat != owner) throw CancellationException("coach-owner-changed")
        return current
    }

    private var confirmations by mutableStateOf<Map<Pair<String, String>, CoachRoutineConfirmation>>(emptyMap())
    private val routineConfirmation = Mutex()

    fun confirmedGeneration(requestId: String): AskGeneration? = owner?.let { seat ->
        confirmations[seat to requestId]?.generation ?: localCoach?.confirmed(seat, requestId)
    }

    // Runs in the store's scope, so leaving Coach mid-save still lands the routine, its refresh and its outcome.
    // A save the log confirmed stands even when this phone fails to keep its copy.
    suspend fun confirmRoutine(threadId: String, requestId: String, draft: CoachRoutineDraft): DraftOutcome {
        val seat = owner ?: return DraftOutcome.Failed(Ask.draftSignIn)
        val authority = admit(requireNotNull(seat))
        val coach = rest() ?: return DraftOutcome.Failed(Ask.draftSignIn)
        return scope.async {
            routineConfirmation.withLock {
                if (!authority.active || seat != owner) return@withLock DraftOutcome.Failed(accountChanged)
                confirmedGeneration(requestId)?.takeIf { generation -> generation.routineDrafts.any { it.operationId == draft.operationId && it.state == "saved" } }
                    ?.let { return@withLock DraftOutcome.Saved(it) }
                telemetry.event("gym_coach_routine_confirm", mapOf("outcome" to "started"))
                val reply = try {
                    coach.confirmRoutine(threadId, requestId, draft.operationId).also { reply ->
                        if (reply.thread != threadId || reply.generation.requestId != requestId ||
                            reply.generation.routineDrafts.none { it.operationId == draft.operationId && it.routineId == draft.routineId && it.state == "saved" }) error("routine-confirmation-mismatch")
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Exception) {
                    reportFailure("gym.coachRoutineConfirm", failure)
                    val refused = failure is WindmillApiException.Refused && failure.status in 400..499
                    telemetry.event("gym_coach_routine_confirm", mapOf("outcome" to if (refused) "refused" else "failed"))
                    return@withLock DraftOutcome.of(failure)
                }
                telemetry.event("gym_coach_routine_confirm", mapOf("outcome" to "saved"))
                if (!authority.active || seat != owner) return@withLock DraftOutcome.Failed(accountChanged)
                try {
                    withContext(storageDispatcher) { authority.write { localCoach?.confirm(seat, reply) } }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Exception) {
                    reportFailure("gym.coachRoutineConfirm", failure)
                }
                if (!authority.active || seat != owner) return@withLock DraftOutcome.Failed(accountChanged)
                confirmations = confirmations + ((seat to requestId) to reply)
                onProgramChanged()
                DraftOutcome.Saved(reply.generation)
            }
        }.await()
    }

    fun pendingExchange(question: AskQuestion): AskExchange {
        val snapshot = owner?.let { localCoach?.snapshot(it, question.requestId.orEmpty()) }
        return snapshot?.exchange() ?: AskExchange(question.question, requestId = question.requestId.orEmpty(),
            trouble = Ask.interrupted, again = true,
            attachments = question.attachmentIds.mapNotNull { id ->
                owner?.let { localCoach?.draft(it, question.thread)?.photo?.takeIf { it.id == id } }
            })
    }

    suspend fun ask(threadId: String, question: String, requestId: String = Ids.thread(),
        photo: CoachAttachment? = null, stream: Boolean = false,
        onSnapshot: (AskGeneration) -> Unit = {}, onUpload: (Float?) -> Unit = {},
        authenticatedOwner: String? = owner, admission: CoachAdmission? = null,
    ): AskOutcome {
        val started = elapsedNanos()
        telemetry.event("gym_ask_started")
        fun complete(outcome: AskOutcome, failure: Exception? = null): AskOutcome {
            val properties = mutableMapOf("duration_ms" to ((elapsedNanos() - started) / 1_000_000).toString())
            properties["outcome"] = when (outcome) {
                is AskOutcome.Answered -> "answered"
                is AskOutcome.Refused -> "refused"
                is AskOutcome.Capped -> "capped"
                is AskOutcome.Failed -> "failed"
                is AskOutcome.Fresh -> "fresh"
                AskOutcome.Absent -> "absent"
            }
            if (outcome is AskOutcome.Capped) properties["cap"] = outcome.cap.name.lowercase()
            if (failure != null) properties["failure_kind"] = when (failure) {
                WindmillApiException.Offline -> "offline"
                is WindmillApiException.Timeout -> "timeout"
                WindmillApiException.Malformed -> "malformed"
                is WindmillApiException.Transport -> "transport"
                is WindmillApiException.Refused -> "http"
                else -> "unexpected"
            }
            if (failure is WindmillApiException.Refused) properties["status"] = failure.status.toString()
            telemetry.event("gym_ask_outcome", properties)
            return outcome
        }
        fun cancelled(error: CancellationException): Nothing {
            telemetry.event("gym_ask_outcome", mapOf("outcome" to "cancelled",
                "duration_ms" to ((elapsedNanos() - started) / 1_000_000).toString()))
            throw error
        }
        val seat = authenticatedOwner
        if (seat == null) return complete(AskOutcome.Refused(signInFirst))
        val requestAdmission = admission ?: admit(seat)
        if (seat != owner) return complete(AskOutcome.Refused(accountChanged))
        val coach = rest() ?: return complete(AskOutcome.Refused(signInFirst))
        if (seat != owner) return complete(AskOutcome.Refused(accountChanged))
        var snapshot = seat?.let { localCoach?.snapshot(it, requestId) }
        var photoUpload = false
        return try {
            val saved = seat?.let { localCoach?.pending(it)?.firstOrNull { it.requestId == requestId } }
            val request = saved ?: AskQuestion(thread = threadId, question = question, requestId = requestId,
                attachmentIds = listOfNotNull(photo?.id),
                purpose = if (draft(seat, threadId).setup || archive[seat to threadId]?.setup == true) "routine_setup" else "conversation")
            require(request.thread == threadId && request.question == question) { "A retry must keep the original message." }
            requestAdmission.check()
            if (seat != null) persistRequest(requestAdmission) { localCoach?.keep(seat, request) }
            requestAdmission.check()
            if (seat != owner) return complete(AskOutcome.Refused(accountChanged))
            if (photo != null && seat != null && snapshot == null) {
                val file = localCoach?.photoFile(seat, photo.id)
                if (file?.isFile == true) {
                    photoUpload = true
                    onUpload(0f)
                    val bytes = withContext(storageDispatcher) { file.readBytes() }
                    requestAdmission.check()
                    coach.uploadPhoto(threadId, photo, bytes) { if (seat == owner && requestAdmission.active != false) onUpload(it) }
                    requestAdmission.check()
                    if (seat != owner) return complete(AskOutcome.Refused(accountChanged))
                    photoUpload = false
                    onUpload(null)
                }
            }
            onUpload(null)
            val accept: suspend (AskGeneration) -> Unit = { next ->
                if (seat == owner && requestAdmission.active != false && snapshot != next && (snapshot == null || next.revision >= snapshot!!.revision)) {
                    if (seat != null) retainSnapshot(seat, next, requestAdmission)
                    requestAdmission.check()
                    if (seat == owner) {
                        snapshot = next
                        onSnapshot(next)
                    }
                }
            }
            requestAdmission.check()
            var answered = if (stream) coach.stream(request, accept) else coach.ask(request)
            answered.generation?.let { accept(it) }
            var pause = 1_000L
            while (answered.generation?.status == "running") {
                if (seat != owner) return complete(AskOutcome.Refused(accountChanged))
                requestAdmission.check()
                delay(pause)
                requestAdmission.check()
                if (seat != owner) return complete(AskOutcome.Refused(accountChanged))
                pause = (pause * 2).coerceAtMost(10_000)
                answered = if (stream) coach.stream(request, accept) else coach.ask(request)
                answered.generation?.let { accept(it) }
            }
            if (seat != owner) return complete(AskOutcome.Refused(accountChanged))
            requestAdmission.check()
            if (answered.proposals.isNotEmpty() || answered.results.isNotEmpty()) onProgramChanged()
            if (answered.generation?.status == "failed") return complete(AskOutcome.Failed(Ask.interrupted, snapshot))
            if (seat != null) clearRequest(seat, threadId, requestId, requestAdmission)
            requestAdmission.check()
            if (seat != owner) return complete(AskOutcome.Refused(accountChanged))
            complete(AskOutcome.Answered(answered))
        } catch (interrupted: CancellationException) {
            cancelled(interrupted)
        } catch (refusing: Exception) {
            try {
                requestAdmission.check()
                reportFailure("gym.ask", refusing)
                if (seat != owner) return complete(AskOutcome.Refused(accountChanged), refusing)
                val authoritative = try { coach.thread(threadId)?.generation?.takeIf { it.requestId == requestId } }
                catch (interrupted: CancellationException) { throw interrupted }
                catch (_: Exception) { null }
                if (seat != owner) return complete(AskOutcome.Refused(accountChanged), refusing)
                requestAdmission.check()
                if (authoritative != null && (snapshot == null || authoritative.revision >= snapshot!!.revision)) {
                    snapshot = authoritative
                    if (seat != null) retainSnapshot(seat, authoritative, requestAdmission)
                    requestAdmission.check()
                    if (seat != owner) return complete(AskOutcome.Refused(accountChanged), refusing)
                }
                if (snapshot?.status in listOf("completed", "stopped")) {
                    if (seat != null) clearRequest(seat, threadId, requestId, requestAdmission)
                    requestAdmission.check()
                    if (seat != owner) return complete(AskOutcome.Refused(accountChanged), refusing)
                    return complete(AskOutcome.Answered(requireNotNull(snapshot).response()))
                }
                if (photoUpload) return complete(AskOutcome.Failed("Photo didn’t upload. Retry to send this photo.", snapshot), refusing)
                if (snapshot == null && photo != null && refusing is WindmillApiException.Refused && refusing.refusal.code == "ask-attachment-invalid") {
                    return complete(AskOutcome.Failed("Photo wasn’t available. Retry to upload it again."), refusing)
                }
                val outcome = AskOutcome.refusing(refusing, snapshot)
                if (snapshot == null && outcome.terminalRefusal) {
                    try {
                        val current = chat(threadId) ?: LocalChat(threadId)
                        val index = current.exchanges.indexOfLast { it.requestId == requestId }
                        val original = current.exchanges.getOrNull(index)
                            ?: AskExchange(question, requestId = requestId, attachments = listOfNotNull(photo))
                        val exchange = outcome.exchange(original)
                        val exchanges = if (index < 0) current.exchanges + exchange
                            else current.exchanges.toMutableList().apply { set(index, exchange) }
                        val settled = current.copy(exchanges = exchanges, cap = (outcome as? AskOutcome.Capped)?.cap?.name,
                            absent = outcome is AskOutcome.Absent)
                        archive[seat to threadId] = settled
                        persistRequest(requestAdmission) {
                            localCoach?.pauseRequest(seat, settled, requestId) { reportFailure("gym.saveConversation", it) }
                        }
                    } catch (interrupted: CancellationException) { throw interrupted }
                    catch (failure: Exception) {
                        reportFailure("gym.saveConversation", failure)
                        archiveFailure = "Your conversation couldn’t be saved. Try again."
                    }
                    requestAdmission.check()
                    if (seat != owner) return complete(AskOutcome.Refused(accountChanged), refusing)
                }
                complete(outcome, refusing)
            } catch (interrupted: CancellationException) { cancelled(interrupted) }
        }
    }

    // One thread list for every screen; reads and deletes serialize under the same lock.
    var nextThreadCursor: String? by mutableStateOf(null)
        private set

    suspend fun readThreads(cursor: String? = null): GymResult<List<AskThread>> {
        val seat = owner
        if (seat == null) return GymResult.Ok(allThreads)
        val coach = rest() ?: return GymResult.Failed(WriteFailure.Refused(signInFirst))
        val authority = admit(requireNotNull(seat))
        return conversationWrite.withLock {
            if (!authority.active || seat != owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
            try {
                val page = coach.threads(cursor)
                if (!authority.active || seat != owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                conversations = if (cursor == null || conversationsOwner != seat) page.threads else (conversations + page.threads).distinctBy { it.id }
                conversationsOwner = seat
                page.threads.forEach { thread ->
                    val prior = chat(thread.id) ?: LocalChat(thread.id, createdAtMs = thread.createdAtMs, updatedAtMs = thread.askedAtMs)
                    keepChat(seat, prior.copy(history = thread.copy(turns = emptyList(), generation = null)))
                }
                nextThreadCursor = page.nextCursor
                GymResult.Ok(allThreads)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure("gym.readThreads", refusing)
                if (!authority.active || seat != owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                GymResult.Failed(WriteFailure(refusing))
            }
        }
    }

    // A log that refused with a sentence is not a log holding no such thread, so the absence answers
    // in words rather than as a null.
    suspend fun thread(id: String, before: String? = null): GymResult<AskThread> {
        val seat = owner
        val retained = chat(id)
        if (seat == null || (retained != null && retained.history == null && retained.exchanges.isEmpty() &&
            draft(id).let { it.text.isNotBlank() || it.photo != null })) {
            val local = allThreads.firstOrNull { it.id == id }
                ?: return GymResult.Failed(WriteFailure.Refused(noSuchThread))
            return GymResult.Ok(local)
        }
        val coach = rest() ?: return GymResult.Failed(WriteFailure.Refused(signInFirst))
        val authority = admit(requireNotNull(seat))
        return try {
            val read = coach.thread(id, before)
            if (!authority.active || seat != owner) return GymResult.Failed(WriteFailure.Refused(accountChanged))
            if (read == null) {
                val local = chat(id)
                if (before == null && local != null && local.history == null && local.exchanges.isNotEmpty() &&
                    !isAsking(id) && localCoach?.pending(seat).orEmpty().none { it.thread == id } &&
                    local.exchanges.all { it.requestId.isNotEmpty() && it.answer == null &&
                        local.refusedRequest(it.requestId) && localCoach?.snapshot(seat, it.requestId) == null }) {
                    allThreads.firstOrNull { it.id == id }?.let { return GymResult.Ok(it) }
                }
                return GymResult.Failed(WriteFailure.Refused(noSuchThread))
            }
            if (before == null && seat != null) {
                val prior = chat(id) ?: LocalChat(id, createdAtMs = read.createdAtMs, updatedAtMs = read.askedAtMs)
                val turns = read.exchanges()
                val acceptedRefusal = prior.exchanges.lastOrNull()?.let { last ->
                    last.requestId.isNotEmpty() && prior.refusedRequest(last.requestId) &&
                        turns.any { it.requestId == last.requestId }
                } == true
                val retained = withoutOverlaps(prior.exchanges, turns)
                val (local, archived) = retained.partition { it.pending || it.again || prior.refusedRequest(it.requestId) }
                val older = archived.takeIf { read.nextCursor != null }.orEmpty()
                val oldestCursor = if (older.isNotEmpty() && prior.history != null) prior.history.nextCursor else read.nextCursor
                if (!isAsking(id)) keepChat(seat, prior.copy(exchanges = older + turns + local,
                    cap = prior.cap.takeUnless { acceptedRefusal }, absent = prior.absent && !acceptedRefusal,
                    history = read.copy(turns = emptyList(), generation = null, nextCursor = oldestCursor)))
            }
            if (seat != null && !isAsking(id) && read.generation?.status in listOf("completed", "stopped")) {
                try { authority.write { localCoach?.clear(seat, id, requireNotNull(read.generation).requestId) } }
                catch (failure: Exception) {
                    reportFailure("gym.saveConversation", failure)
                    archiveFailure = "Your conversation couldn’t be saved. Try again."
                }
            }
            GymResult.Ok(read)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.thread", refusing)
            if (!authority.active || seat != owner) return GymResult.Failed(WriteFailure.Refused(accountChanged))
            GymResult.Failed(WriteFailure(refusing))
        }
    }

    suspend fun readOlderChat(id: String, cursor: String): GymResult<Unit> {
        val seat = archiveOwner
        val authority = admit(requireNotNull(seat))
        val selected = chat(id) ?: return GymResult.Failed(WriteFailure.Refused(noSuchThread))
        if (selected.history?.nextCursor != cursor) return GymResult.Ok(Unit)
        return when (val read = thread(id, cursor)) {
            is GymResult.Failed -> read
            is GymResult.Ok -> {
                if (!authority.active || seat != archiveOwner) return GymResult.Failed(WriteFailure.Refused(accountChanged))
                val current = chat(id) ?: return GymResult.Failed(WriteFailure.Refused(noSuchThread))
                if (current.history?.nextCursor != cursor) return GymResult.Ok(Unit)
                val older = withoutOverlaps(read.value.copy(generation = null).exchanges(), current.exchanges)
                keepChat(seat, current.copy(exchanges = older + current.exchanges,
                    history = (current.history ?: read.value).copy(nextCursor = read.value.nextCursor)))
                GymResult.Ok(Unit)
            }
        }
    }

    private fun withoutOverlaps(exchanges: List<AskExchange>, retained: List<AskExchange>): List<AskExchange> {
        val requests = retained.map { it.requestId }.filter { it.isNotEmpty() }.toSet()
        val positions = retained.map { it.position }.filter { it > 0 }.toSet()
        val generations = retained.mapNotNull { it.generation?.id?.takeIf { id -> id.isNotEmpty() } }.toSet()
        return exchanges.filter { exchange ->
            (exchange.requestId.isEmpty() || exchange.requestId !in requests) &&
                (exchange.position <= 0 || exchange.position !in positions) &&
                (exchange.generation?.id.isNullOrEmpty() || exchange.generation?.id !in generations)
        }
    }

    suspend fun deleteThread(id: String): GymResult<Unit> {
        val seat = archiveOwner
        val authority = admit(requireNotNull(seat))
        val authenticated = owner
        val chat = chat(id)
        return scope.async {
        val result = conversationWrite.withLock {
            if (!authority.active || seat != archiveOwner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
            try {
                if (authenticated != null && (chat == null || chat.history != null || chat.exchanges.isNotEmpty())) {
                    val coach = rest() ?: return@withLock GymResult.Failed(WriteFailure.Refused(signInFirst))
                    try { coach.deleteThread(id) }
                    catch (failure: WindmillApiException.Refused) { if (failure.status != 404) throw failure }
                }
                if (!authority.active || seat != archiveOwner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                val admission = admissions[seat to id]
                authority.write {
                    if (admission == null) localCoach?.clear(seat, id)
                    else admission.write { localCoach?.clear(seat, id); admission.retire() }
                }
                archive.remove(seat to id)
                chatVersions[seat to id] = (chatVersions[seat to id] ?: 0) + 1
                admissions.remove(seat to id)
                stopping.remove(seat to id)
                drafts.remove(seat to id)
                unsavedDrafts.remove(seat to id)
                if (selected[seat] == id) selected.remove(seat)
                jobs.remove(seat to id)?.cancel()
                busy.remove(seat to id)
                uploads.remove(seat to id)
                conversations = conversations.filterNot { it.id == id }
                confirmations = confirmations.filter { (key, value) -> key.first != authenticated || value.thread != id }
                GymResult.Ok(Unit)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                reportFailure("gym.deleteThread", failure)
                GymResult.Failed(WriteFailure(failure))
            }
        }
        telemetry.event("gym_action", mapOf("screen" to "threads", "action" to "delete", "outcome" to when (result) {
            is GymResult.Ok -> "ok"
            is GymResult.Failed -> if (result.why is WriteFailure.Refused) "refused" else "failed"
        }))
        result
        }.await()
    }

}

// `Saved` is the log's word, also for a draft an earlier tap saved. `Closed` is a draft no retry can save,
// so the card takes Save away; `Failed` keeps Save for another tap.
sealed interface DraftOutcome {
    data class Saved(val generation: AskGeneration) : DraftOutcome
    data class Closed(val said: String) : DraftOutcome
    data class Failed(val said: String) : DraftOutcome

    companion object {
        // Told apart by status, never by the English.
        fun of(failure: Exception): DraftOutcome {
            val refused = failure as? WindmillApiException.Refused ?: return Failed(Ask.draftRetry)
            return when (refused.status) {
                401 -> Failed(Ask.draftSignIn)
                404 -> Closed(Ask.draftGone)
                400, 422 -> Closed(Ask.draftInvalid)
                else -> Failed(Ask.draftRetry)
            }
        }
    }
}

// `Answered` carries the reply whole and the screen draws it without adding to it. `Refused` is the
// log answering in its own words; `Capped` retains its actual retry deadline; `Failed` is the log going quiet, which
// is worth another tap. `Absent` is the deployment having no Coach. `Fresh` is the conversation being
// full or another account's: the QUESTION is fine, so asking it again opens a new thread.
sealed interface AskOutcome {
    data class Answered(val answer: AskAnswer) : AskOutcome
    data class Refused(val said: String, val generation: AskGeneration? = null, val terminal: Boolean = false) : AskOutcome
    data class Capped(val said: String, val cap: AskCap, val generation: AskGeneration? = null, val retryAtMs: Long? = null) : AskOutcome
    data class Failed(val said: String, val generation: AskGeneration? = null) : AskOutcome
    data class Fresh(val said: String) : AskOutcome
    data object Absent : AskOutcome

    companion object {
        // Told apart by status and code, never by the English. Only a log that went quiet, or one
        // that failed, is worth another tap; a bare 404 is a deployment with no Coach.
        fun refusing(error: Throwable, generation: AskGeneration?): AskOutcome {
            val refused = error as? WindmillApiException.Refused ?: return Failed(noAnswer, generation)
            val said = refused.refusal.message
            return when {
                refused.status == 404 -> Absent
                refused.status >= 500 -> Failed(said ?: noAnswer, generation)
                refused.status == 429 && refused.refusal.code == "subject_exhausted" -> Capped(AskCap.Allowance.wordless, AskCap.Allowance, generation,
                    ((refused.refusal.allowance as? JsonObject)?.get("resetsAtMs") as? JsonPrimitive)
                        ?.takeUnless { it.isString }?.longOrNull?.takeIf { it > 0 })
                refused.refusal.code == "ask-daily-limit" -> Capped(AskCap.Daily.wordless, AskCap.Daily, generation,
                    (refused.refusal.retryAtMs as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull?.takeIf { it > 0 }
                        ?: refused.retryAfterAtMs?.takeIf { it > 0 })
                refused.refusal.code == "ask-out-of-budget" -> Capped(said ?: AskCap.Ceiling.wordless, AskCap.Ceiling, generation)
                refused.refusal.code == "ask-generation-active" ->
                    Failed(said ?: "Coach is answering another message. Try again when it finishes.", generation)
                // Both are answered by opening a new thread; nothing is re-sent on its own.
                refused.refusal.code == "ask-thread-full" || refused.refusal.code == "ask-thread-taken" -> Fresh(said ?: Ask.threadFull)
                else -> Refused(said ?: "Coach couldn’t take that one", generation, terminal = true)
            }
        }

        private const val noAnswer = "Coach didn’t answer. Try again in a moment"
    }

    val terminalRefusal: Boolean get() = when (this) {
        is Refused -> terminal && generation == null
        is Capped -> generation == null
        is Fresh, Absent -> true
        else -> false
    }

    fun exchange(pending: AskExchange): AskExchange = (when (this) {
        is Answered -> answer.generation?.exchange()?.copy(attachments = answer.generation.attachments.ifEmpty { pending.attachments },
            atMs = pending.atMs.takeIf { it > 0 } ?: answer.generation.atMs, position = pending.position)
            ?: pending.copy(answer = answer)
        is Failed -> pending.copy(trouble = said, again = true, generation = generation ?: pending.generation)
        is Refused -> pending.copy(trouble = said, again = generation != null, generation = generation ?: pending.generation)
        is Capped -> pending.copy(trouble = said, again = generation != null, generation = generation ?: pending.generation,
            retryAtMs = retryAtMs)
        is Fresh -> pending.copy(trouble = said, needsNew = true)
        Absent -> pending.copy(trouble = Ask.notHere)
    }).let { it.copy(terminalRefusal = terminalRefusal && it.generation == null) }
}
