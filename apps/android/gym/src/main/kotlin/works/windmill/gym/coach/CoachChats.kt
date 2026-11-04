package works.windmill.gym.coach

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import works.windmill.domain.kit.Id
import works.windmill.gym.coach.onboarding.CoachImportOutcome
import works.windmill.gym.coach.onboarding.CoachRoutineImports
import works.windmill.gym.coach.turn.ChosenPicture
import works.windmill.gym.coach.turn.CoachTurnFault
import works.windmill.gym.coach.turn.CoachTurnRefusal
import works.windmill.gym.coach.turn.CoachTurns
import works.windmill.gym.coach.turn.WithdrawnTurn
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.OpenTurn
import works.windmill.gym.presentation.Ids
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.Seat
import works.windmill.gym.store.TrainingSeat
import works.windmill.gym.store.WriteFailure
import works.windmill.gym.store.unexpected
import works.windmill.platform.telemetry.Telemetry

// The chats of the seat in hand: which one is on screen, what its composer holds, and the send that turns a draft into a turn. Messages are read from `conversations`; a turn runs in `turns`, which outlives every screen; this holds what the composer needs and what the seat's chats keep on this phone.
class CoachChats internal constructor(
    private val accountOwner: () -> String?,
    private val onProgramChanged: () -> Unit,
    val conversations: CoachConversations?,
    private val turns: CoachTurns?,
    private val localCoach: LocalCoach?,
    private val imports: CoachRoutineImports?,
    private val access: suspend () -> AnonymousCoachAccess,
    private val telemetry: Telemetry,
    private val scope: CoroutineScope,
    private val storageDispatcher: CoroutineDispatcher = Dispatchers.IO,
    val now: () -> Long = System::currentTimeMillis,
    private val seatReplica: () -> String? = { null },
    private val seatReady: () -> Boolean = { true },
) {
    private class Sending(val chat: String, val owner: String, val question: String, val photo: CoachAttachment?, val atMs: Long)
    private class Sent(val chat: String, val authority: LocalCoach.Authority?)

    private val owner: String? get() = accountOwner()
    private val anonymousOwner by lazy {
        try { localCoach?.anonymousOwner() ?: "anonymous:" + Ids.thread() }
        catch (failure: Exception) { telemetry.failure("gym.restoreConversation", failure); "anonymous:" + Ids.thread() }
    }
    private val archiveOwner: String get() = owner ?: anonymousOwner
    val accountKey: String get() = Seat.of(archiveOwner)
    val anonymous: Boolean get() = owner == null
    private val chats = mutableStateMapOf<Pair<String, String>, LocalChat>()
    private val selected = mutableStateMapOf<String, String>()
    private val restoredOwners = mutableSetOf<String>()
    private val chatVersions = mutableMapOf<Pair<String, String>, Long>()
    private val conversationWrite = Mutex()
    private val drafts = mutableMapOf<Pair<String, String>, CoachDraft>()
    private val unsavedDrafts = mutableSetOf<Pair<String, String>>()
    private var ownerRevision = 0L
    private var sending by mutableStateOf<Sending?>(null)
    private var sent: Sent? = null
    private var runningThread by mutableStateOf<String?>(null)
    private var refused by mutableStateOf<CoachTurnRefusal?>(null)
    private var refusedChat: String? = null
    private var refusedSeat: String? = null
    private var accessJob: Job? = null

    // A failure of this phone's own store, said in the room's line.
    var failure by mutableStateOf<String?>(null)
        private set
    var fault by mutableStateOf<CoachTurnFault?>(null)
        private set
    // A send the account's change stopped, drawn apart from the band. Send waits only while the seat has not settled, so a seat already settled never strands the question it kept.
    var accountChanging by mutableStateOf(false)
        private set
    val sendHeld: Boolean get() = accountChanging && !seatReady()
    var anonymousAccess by mutableStateOf(AnonymousCoachAccess.Checking)
        private set
    var draftVersion by mutableIntStateOf(0)
        private set
    var adoptingDraft by mutableStateOf(false)
        private set

    init {
        turns?.let { live ->
            scope.launch(start = CoroutineStart.UNDISPATCHED) { live.turn.collect { running ->
                runningThread = running?.thread?.record?.string
                settleSent()
            } }
            scope.launch(start = CoroutineStart.UNDISPATCHED) { live.withdrawn.collect { settleSent() } }
            scope.launch(start = CoroutineStart.UNDISPATCHED) { live.fault.collect { said ->
                accountChanging = said == CoachTurnFault.accountChanging
                fault = said.takeUnless { accountChanging }
            } }
            scope.launch(start = CoroutineStart.UNDISPATCHED) { live.refusal.collect { refusal ->
                refused = refusal
                if (refusal != null) refusedSeat = archiveOwner
            } }
        }
    }

    // A cap the server refills and a deployment without Coach stand on every chat; anything else on the chat that met it.
    fun refusal(chat: String): CoachTurnRefusal? {
        val refusal = refused ?: return null
        if (refusedSeat != archiveOwner) return null
        return refusal.takeIf { it.capped || refusedChat == chat }
    }

    val absent: Boolean get() = refused == CoachTurnRefusal.Absent

    // A question past its bound as it is typed; the draft follows the field.
    fun tooLong(key: String): CoachTurnRefusal.TooLong? {
        draftVersion
        return CoachTurnRefusal.TooLong.of(draft(key).text)
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
            val answered = access()
            if (owner == null) {
                if (answered != anonymousAccess) telemetry.event("gym_action", mapOf("screen" to "coach", "action" to "access", "outcome" to answered.name.lowercase()))
                anonymousAccess = answered
            }
        }
    }

    private fun admit(seat: String): LocalCoach.Authority? = localCoach?.admit(seat)

    fun eraseOwner(seat: String) {
        localCoach?.eraseOwner(seat)
        (chats.keys + chatVersions.keys).filter { it.first == seat }.forEach { key ->
            chatVersions[key] = (chatVersions[key] ?: 0) + 1
        }
        chats.keys.removeAll { it.first == seat }
        drafts.keys.removeAll { it.first == seat }
        unsavedDrafts.removeAll { it.first == seat }
        selected.remove(seat)
        restoredOwners.remove(seat)
    }

    // Another seat's turn is that seat's: what the composer holds and what the room reads start over under the seat now in hand.
    internal fun forgetSeat() {
        ownerRevision++
        conversations?.forgetSeat()
        if (restoredOwners.isNotEmpty()) watchSelected()
    }

    private fun restoreArchive(seat: String) {
        if (seat in restoredOwners) return
        try {
            localCoach?.chats(seat).orEmpty().forEach { chats[seat to it.id] = it }
            localCoach?.selected(seat)?.let { selected[seat] = it }
            restoredOwners += seat
            watchSelected()
        } catch (failure: Exception) {
            restoredOwners += seat
            telemetry.unexpected("gym.restoreConversation", failure)
        }
    }

    // What the conversation's read follows: the chat on screen, its thread, and the answers it retains from earlier versions.
    private fun watchSelected() {
        val seat = archiveOwner
        val chat = selected[seat]
        val retained = try { chat?.let { localCoach?.retained(seat, it) }.orEmpty() }
            catch (failure: Exception) { telemetry.unexpected("gym.restoreConversation", failure); emptyList() }
        conversations?.watch(chat, chat?.let { chats[seat to it]?.conversation }, retained)
    }

    fun chat(id: String): LocalChat? {
        val seat = archiveOwner
        restoreArchive(seat)
        return chats[seat to id]
    }

    val selectedChatId: String?
        get() { restoreArchive(archiveOwner); return selected[archiveOwner] }

    // What the room draws of a chat: the transcript the engine holds, and a question still on its way to its record.
    fun exchanges(id: String): List<CoachExchange> {
        restoreArchive(archiveOwner)
        val said = conversations?.exchanges(id).orEmpty()
        val going = sending?.takeIf { it.chat == id && it.owner == archiveOwner } ?: return said
        return said + CoachExchange("sending", going.question, going.atMs, listOfNotNull(going.photo?.let { SentPicture(it, true) }), sending = true)
    }

    fun freshChat(seed: String = "", id: String = Ids.thread(), setup: Boolean = false): String {
        val seat = archiveOwner
        admit(seat)
        restoreArchive(seat)
        chats[seat to id]?.let {
            if (selected[seat] != id) select(seat, id)
            return id
        }
        val chat = LocalChat(id, now(), setup = setup)
        keepChat(seat, chat, select = true)
        selected[seat] = chat.id
        watchSelected()
        if (seed.isNotEmpty()) saveDraft(chat.id, CoachDraft(seed))
        telemetry.event("gym_action", mapOf("screen" to "coach", "action" to "fresh_entry", "outcome" to "ok"))
        return chat.id
    }

    // A row of History names a chat, or a thread this phone keeps nothing beside.
    fun selectChat(id: String, action: String = "history_open") {
        val seat = archiveOwner
        if (localCoach?.writable(seat) == false) return
        restoreArchive(seat)
        val chat = chats[seat to id] ?: LocalChat(id, now(), conversation = id).also { keepChat(seat, it) }
        select(seat, chat.id)
        telemetry.event("gym_action", mapOf("screen" to "coach", "action" to action, "outcome" to "ok"))
        if (draft(id).let { it.text.isNotEmpty() || it.photo != null })
            telemetry.event("gym_action", mapOf("screen" to "coach", "action" to "draft_restored", "outcome" to "ok"))
    }

    private fun select(seat: String, id: String) {
        admit(seat)
        try { localCoach?.select(seat, id) }
        catch (failure: Exception) {
            telemetry.unexpected("gym.saveConversation", failure)
            this.failure = "Your conversation couldn’t be saved. Try again."
        }
        selected[seat] = id
        watchSelected()
    }

    private fun keepChat(seat: String, chat: LocalChat, select: Boolean = false) {
        admit(seat)
        chats[seat to chat.id] = chat
        try {
            localCoach?.saveChat(seat, chat, select)
            failure = null
        } catch (failure: Exception) {
            telemetry.unexpected("gym.saveConversation", failure)
            this.failure = "Your conversation couldn’t be saved. Try again."
        }
    }

    fun keepPosition(id: String, scroll: Int, followEnd: Boolean) {
        if (localCoach?.writable(archiveOwner) == false) return
        val chat = chats[archiveOwner to id] ?: return
        if (chat.scroll == scroll && chat.followEnd == followEnd) return
        keepChat(archiveOwner, chat.copy(scroll = scroll.coerceAtLeast(0), followEnd = followEnd))
    }

    fun isAsking(id: String): Boolean {
        if (sending?.chat == id) return true
        val thread = chats[archiveOwner to id]?.conversation ?: return false
        return thread == runningThread
    }

    // The one running turn, when it belongs to another chat of this seat.
    fun pendingChat(except: String): ConversationRow? {
        val thread = runningThread ?: return null
        restoreArchive(archiveOwner)
        if (chats[archiveOwner to except]?.conversation == thread) return null
        val held = conversations?.threads.orEmpty().firstOrNull { it.id.record.string == thread } ?: return null
        val chat = chats.filterKeys { it.first == archiveOwner }.values.firstOrNull { it.conversation == thread }?.id ?: thread
        return ConversationRow(chat, held.title, 0, answering = true)
    }

    // Coach §4.1 through `turns`: the draft stays until the turn is recorded. `once` keys a question one gesture may ask twice, so it opens one turn however often it comes back.
    fun send(id: String, text: String, photo: CoachAttachment? = null, once: String? = null): Boolean {
        val live = turns ?: return false
        val seat = archiveOwner
        if (sending != null || localCoach?.writable(seat) == false) return false
        restoreArchive(seat)
        val chat = chats[seat to id] ?: return false
        if (once != null && chat.conversation != null) return true
        val question = asked(text)
        if (question.encodeToByteArray().size > Ask.maxQuestionBytes || question.isEmpty() && photo == null) return false
        val atMs = now()
        val authority = admit(seat)
        val replica = seatReplica()
        sending = Sending(id, seat, question, photo, atMs)
        refusedChat = id
        scope.launch {
            try {
                val bytes = try { photo?.let { withContext(storageDispatcher) { localCoach?.photoFile(seat, it.id)?.readBytes() } } }
                    catch (_: IOException) { failure = CoachTurnFault.pictureUnavailable.sentence; return@launch }
                if (photo != null && bytes == null) { failure = CoachTurnFault.pictureUnavailable.sentence; return@launch }
                val thread = chat.conversation?.takeIf { conversations?.holds(it) == true }
                // A question asked under one seat is that seat's: if the seat changed on the way here, it stays in its draft.
                if (seat != archiveOwner) return@launch
                val turn = live.send(question, photo?.let { ChosenPicture(it, requireNotNull(bytes)) }, thread?.let { Id(it, CoachThread) }, anonymous, once, on = replica) ?: return@launch
                failure = null
                // The chat takes its thread first, so a withdrawal already on its way finds it there and its restore comes after.
                opened(seat, id, authority, turn)
                sent = Sent(id, authority)
                settleSent()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { telemetry.unexpected("gym.saveConversation", failure) }
            finally { sending = null }
        }
        return true
    }

    // An owner erased since the send keeps nothing of it: the authority it was asked under stops here, before the chat or the draft hears of it.
    private suspend fun opened(seat: String, id: String, authority: LocalCoach.Authority?, turn: OpenTurn.Turn) {
        val thread = checkNotNull(turn.thread.record.string) { "a thread's id is a string" }
        // The question is a message now, so the field clears even where the disk would not: the unwritten clear is an unsaved draft, retried with the next one.
        val written = try {
            withContext(storageDispatcher) { if (authority != null) localCoach?.withAuthority(authority) { localCoach.turnOpened(seat, id, thread) } }
            true
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            telemetry.unexpected("gym.saveConversation", failure)
            this.failure = "Your conversation couldn’t be saved. Try again."
            false
        }
        chats[seat to id]?.let { chats[seat to id] = it.copy(conversation = thread, updatedAtMs = now()) }
        drafts.remove(seat to id)
        if (written) unsavedDrafts.remove(seat to id) else unsavedDrafts += seat to id
        draftVersion++
        if (seat == archiveOwner) watchSelected()
        conversations?.read()
    }

    // A send the server refused before its stream: the question and its photo return to the field. The chat keeps its thread only while the thread stands: a withdrawn first turn takes it along. What a turn still running or just ended holds is no one's to restore.
    private fun settleSent() {
        val held = sent ?: return
        val live = turns ?: return
        val withdrawn = live.withdrawn.value
        if (withdrawn != null) {
            sent = null
            scope.launch { restoreWithdrawn(held, withdrawn) }
        } else if (live.turn.value == null) sent = null
    }

    private suspend fun restoreWithdrawn(held: Sent, withdrawn: WithdrawnTurn) {
        val conversation = withdrawn.thread?.record?.string
        val draft = CoachDraft(withdrawn.question, withdrawn.picture?.attachment)
        val seat = held.authority?.owner ?: archiveOwner
        chats[seat to held.chat]?.let { chats[seat to held.chat] = it.copy(conversation = conversation) }
        try {
            if (held.authority == null) drafts[seat to held.chat] = draft
            else withContext(storageDispatcher) {
                localCoach?.withAuthority(held.authority) { localCoach.turnWithdrawn(seat, held.chat, conversation, draft, withdrawn.picture?.original) }
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            drafts[seat to held.chat] = draft
            unsavedDrafts += seat to held.chat
            telemetry.unexpected("gym.saveDraft", failure)
        }
        draftVersion++
        if (seat == archiveOwner) watchSelected()
        conversations?.read()
    }

    fun stop() {
        turns?.requestStop()
    }

    // History: every thread the engine holds, under the chat this phone keeps beside it, and every chat of this phone's alone that holds something. A draft dates its row when it is newer than what was said.
    val history: List<ConversationRow> get() {
        val seat = archiveOwner
        restoreArchive(seat)
        val mine = chats.filterKeys { it.first == seat }.values
        val beside = mine.filter { it.conversation != null }.associateBy { it.conversation }
        val rows = conversations?.rows.orEmpty().map { row ->
            val chat = beside[row.id] ?: return@map row
            val held = draft(chat.id)
            val drafted = if (held.text.isNotEmpty() || held.photo != null) chat.updatedAtMs else 0
            row.copy(id = chat.id, askedAtMs = maxOf(row.askedAtMs, drafted))
        }
        val listed = rows.map { it.id }.toSet()
        val local = mine.filter { it.id !in listed }.mapNotNull { chat ->
            val held = draft(chat.id)
            val retained = try { localCoach?.retained(seat, chat.id).orEmpty() } catch (_: Exception) { emptyList() }
            if (held.text.isEmpty() && held.photo == null && retained.isEmpty()) return@mapNotNull null
            ConversationRow(chat.id, retained.firstOrNull()?.request()?.text.orEmpty().ifEmpty { held.text.ifEmpty { "Photo" } }, chat.updatedAtMs,
                answerPreview = retained.lastOrNull { it.response?.status == "completed" }?.response?.message.orEmpty())
        }
        return (rows + local).sortedByDescending { it.askedAtMs }
    }

    val hasConversations: Boolean get() = conversations?.threads.orEmpty().isNotEmpty() || history.isNotEmpty()

    fun draft(key: String): CoachDraft = draft(archiveOwner, key)

    private fun draft(seat: String, key: String): CoachDraft {
        if (seat to key in unsavedDrafts) return drafts[seat to key] ?: CoachDraft()
        return localCoach?.draft(seat, key) ?: drafts[seat to key] ?: CoachDraft()
    }

    fun draftSaved(key: String): Boolean = archiveOwner to key !in unsavedDrafts

    fun saveDraft(key: String, draft: CoachDraft) = saveDraft(archiveOwner, key, draft)

    private fun saveDraft(seat: String, key: String, draft: CoachDraft) {
        admit(seat)
        if (seat to key !in unsavedDrafts && draft(seat, key) == draft && (drafts[seat to key] ?: CoachDraft()) == draft) return
        val changed = drafts[seat to key] != draft
        drafts[seat to key] = draft
        if (changed) draftVersion++
        try {
            localCoach?.saveDraft(seat, key, draft)
            restoreArchive(seat)
            val chat = chats[seat to key] ?: LocalChat(key, now())
            chats[seat to key] = chat.copy(updatedAtMs = now())
            unsavedDrafts.remove(seat to key)
        } catch (failure: Exception) { unsavedDrafts += seat to key; telemetry.unexpected("gym.saveDraft", failure); throw failure }
    }

    fun keptDrafts(key: String): List<KeptCoachDraft> {
        draftVersion
        return localCoach?.keptDrafts(archiveOwner, key).orEmpty()
    }

    suspend fun adoptPhoneDraft(account: String) {
        if (owner != account) return
        val disk = localCoach ?: return
        val revision = ownerRevision
        val unsaved = unsavedDrafts.toSet()
        adoptingDraft = true
        try {
            val authority = disk.admit(account)
            val (moved, recovered) = withContext(storageDispatcher) {
                disk.withAuthority(authority) {
                    if (owner != account || ownerRevision != revision) return@withAuthority null to null
                    val recovery = disk.reconcileDraftChange(account)
                    if (recovery != null) return@withAuthority null to recovery
                    val source = disk.selected(anonymousOwner) ?: return@withAuthority null to null
                    if (anonymousOwner to source in unsaved) return@withAuthority null to null
                    disk.adoptPhoneDraft(account, publishedFailure = { telemetry.unexpected("gym.adoptCoachDraft", it) }) {
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
            watchSelected()
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            telemetry.unexpected("gym.adoptCoachDraft", failure)
            if (owner == account) this.failure = "Your draft couldn’t be saved. Try again."
        } finally { adoptingDraft = false }
    }

    fun draftChangeReady(key: String): Boolean {
        val seat = archiveOwner
        if (localCoach?.writable(seat) == false) return false
        val recovered = try { localCoach?.reconcileDraftChange(seat, key) }
        catch (_: Exception) { failure = "Your draft couldn’t be saved. Try again."; return false }
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

    fun continueDraft(key: String, heldId: String): Boolean {
        val seat = archiveOwner
        if (!draftChangeReady(key)) return false
        if (isAsking(key) || !draftSaved(key)) return false
        try { if (localCoach?.continueDraft(seat, key, heldId) { telemetry.unexpected("gym.saveDraft", it) } != true) return false }
        catch (failure: Exception) { telemetry.unexpected("gym.saveDraft", failure); throw failure }
        publishDraft(seat, key)
        telemetry.event("gym_action", mapOf("screen" to "coach", "action" to "continue_draft", "outcome" to "ok"))
        return true
    }

    private fun publishDraft(seat: String, key: String) {
        val disk = localCoach ?: return
        drafts[seat to key] = disk.draft(seat, key)
        unsavedDrafts.remove(seat to key)
        val current = chats[seat to key] ?: disk.chat(seat, key)
        if (current != null) chats[seat to key] = current.copy(updatedAtMs = now())
        draftVersion++
        failure = null
    }

    fun removePhoto(key: String) {
        if (!draftChangeReady(key)) return
        val seat = archiveOwner
        val current = draft(seat, key)
        if (current.photo == null) return
        val next = current.copy(photo = null)
        try { localCoach?.saveDraft(seat, key, next) }
        catch (failure: Exception) { telemetry.unexpected("gym.saveDraft", failure); throw failure }
        drafts[seat to key] = next
        unsavedDrafts.remove(seat to key)
        draftVersion++
        chats[seat to key]?.let { chats[seat to key] = it.copy(updatedAtMs = now()) }
        telemetry.event("gym_setup_step", mapOf("screen" to "coach", "action" to "photo_removed"))
    }

    suspend fun importPhoto(key: String, resolver: android.content.ContentResolver, uri: android.net.Uri) {
        importPhoto(key) { withContext(storageDispatcher) { CoachPhotos.read(resolver, uri) } }
    }

    internal suspend fun importPhoto(key: String, prepare: suspend () -> Pair<CoachAttachment, ByteArray>) {
        if (!draftChangeReady(key)) return
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
            catch (failure: Exception) { telemetry.unexpected("gym.preparePhoto", failure); throw failure }
            if (!disk.current(authority) || (chatVersions[origin] ?: 0) != version || chats[origin] == null) return@async
            val (photo, bytes) = prepared
            val attached = try { withContext(storageDispatcher) { disk.withAuthority(authority) { disk.attachPhoto(seat, key, photo, bytes) } } }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                if (failure is CoachDraftWriteFailure) telemetry.unexpected("gym.saveDraft", failure.cause as Exception)
                else telemetry.unexpected("gym.savePhoto", failure)
                throw failure
            }
            if (!attached) return@async
            if (!disk.current(authority) || (chatVersions[origin] ?: 0) != version || chats[origin] == null) {
                withContext(storageDispatcher) { if (disk.current(authority)) disk.withAuthority(authority) { disk.discardUnusedPhotos(seat) } }
                return@async
            }
            saveDraft(seat, key, draft(seat, key).copy(photo = photo))
            telemetry.event("gym_setup_step", mapOf("screen" to "coach", "action" to "photo_selected"))
        }.await()
    }

    // A photo on this phone: a turn's original, or the composer's draft.
    suspend fun photo(id: String): ByteArray {
        val seat = archiveOwner
        val authority = admit(seat)
        val file = turns?.pictures?.original(id) ?: localCoach?.photoFile(seat, id)
        val bytes = withContext(storageDispatcher) { file?.takeIf { it.isFile }?.readBytes() } ?: throw IOException("The photo is on another phone.")
        if (authority != null && localCoach?.current(authority) != true || seat != archiveOwner) throw CancellationException("coach-owner-changed")
        return bytes
    }

    // A retained answer's drafts, in one gesture: replayed by the answer's result identity, so a second tap makes no new routines. Runs in the store's scope, so leaving Coach does not cancel it.
    suspend fun saveRetainedDrafts(chat: String, requestId: String): DraftOutcome {
        val seat = archiveOwner
        val record = try { localCoach?.retained(seat, chat)?.firstOrNull { it.requestId == requestId } } catch (_: Exception) { null }
            ?: return DraftOutcome.Closed(Ask.draftGone)
        val saving = imports ?: return DraftOutcome.Closed(Ask.draftInvalid)
        return scope.async {
            when (saving.apply(record)) {
                is CoachImportOutcome.Committed, is CoachImportOutcome.Replayed -> {
                    onProgramChanged()
                    conversations?.read()
                    DraftOutcome.Saved
                }
                is CoachImportOutcome.Refused -> DraftOutcome.Closed(Ask.draftInvalid)
                CoachImportOutcome.Failed -> DraftOutcome.Failed(Ask.draftRetry)
            }
        }.await()
    }

    // A conversation deleted from History: its thread, its messages and their pictures, then what this phone kept beside them. A conversation with a turn running stays.
    suspend fun deleteThread(id: String): GymResult<Unit> {
        val seat = archiveOwner
        val authority = admit(seat)
        val thread = chats[seat to id]?.conversation ?: id.takeIf { conversations?.holds(it) == true }
        return scope.async {
            val result = conversationWrite.withLock {
                if ((authority != null && localCoach?.current(authority) != true) || seat != archiveOwner)
                    return@withLock GymResult.Failed(WriteFailure.Refused(TrainingSeat.accountChanged))
                if (thread != null && thread == runningThread) return@withLock GymResult.Failed(WriteFailure.Refused(CoachTurnFault.busy.sentence))
                try {
                    if (thread != null && turns?.deleteConversation(Id(thread, CoachThread)) == false)
                        return@withLock GymResult.Failed(WriteFailure.NoAnswer)
                    // Once the thread has gone the conversation has: what this phone kept beside it is reported, and its row does not come back as "still here".
                    try { localCoach?.clear(seat, id) }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (failure: Exception) {
                        if (thread == null) throw failure
                        telemetry.unexpected("gym.deleteThread", failure)
                    }
                    chats.remove(seat to id)
                    chatVersions[seat to id] = (chatVersions[seat to id] ?: 0) + 1
                    drafts.remove(seat to id)
                    unsavedDrafts.remove(seat to id)
                    if (selected[seat] == id) selected.remove(seat)
                    if (seat == archiveOwner) watchSelected()
                    conversations?.read()
                    GymResult.Ok(Unit)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Exception) {
                    telemetry.unexpected("gym.deleteThread", failure)
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

// A typed question as it is asked: trimmed, with the replacement character for each lone surrogate a paste left, since the engine's JSON cannot hold one.
internal fun asked(typed: String): String {
    val trimmed = typed.trim()
    return buildString(trimmed.length) {
        var at = 0
        while (at < trimmed.length) {
            val point = trimmed.codePointAt(at)
            appendCodePoint(if (point in Char.MIN_SURROGATE.code..Char.MAX_SURROGATE.code) 0xFFFD else point)
            at += Character.charCount(point)
        }
    }
}

// A retained draft's Save: `Saved` also for a draft an earlier tap saved. `Closed` is a draft no retry can save, so the card takes Save away; `Failed` keeps Save for another tap.
sealed interface DraftOutcome {
    data object Saved : DraftOutcome
    data class Closed(val said: String) : DraftOutcome
    data class Failed(val said: String) : DraftOutcome
}
