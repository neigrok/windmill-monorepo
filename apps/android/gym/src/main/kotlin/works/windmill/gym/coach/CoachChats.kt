package works.windmill.gym.coach

import androidx.annotation.StringRes
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
import kotlinx.coroutines.withContext
import works.windmill.domain.kit.Id
import works.windmill.gym.R
import works.windmill.gym.coach.onboarding.CoachImportOutcome
import works.windmill.gym.coach.onboarding.CoachOnboardingRecord
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
import works.windmill.gym.telemetry.coachAction
import works.windmill.gym.telemetry.coachSetupStep

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
    private class StoreFailure(val chat: String?, val said: String)

    private val owner: String? get() = accountOwner()
    private val anonymousOwner by lazy {
        try { localCoach?.anonymousOwner() ?: "anonymous:" + Ids.thread() }
        catch (failure: Exception) { archiveFailed(failure); "anonymous:" + Ids.thread() }
    }
    private val archiveOwner: String get() = owner ?: anonymousOwner
    val accountKey: String get() = Seat.of(archiveOwner)
    val anonymous: Boolean get() = owner == null
    private val chats = mutableStateMapOf<Pair<String, String>, LocalChat>()
    private val selected = mutableStateMapOf<String, String>()
    private val restoredOwners = mutableSetOf<String>()
    private val chatVersions = mutableMapOf<Pair<String, String>, Long>()
    private val drafts = mutableMapOf<Pair<String, String>, CoachDraft>()
    private val unsavedDrafts = mutableSetOf<Pair<String, String>>()
    private var ownerRevision = 0L
    private var sending by mutableStateOf<Sending?>(null)
    private var sent: Sent? = null
    private var runningThread by mutableStateOf<String?>(null)
    private var refused by mutableStateOf<CoachTurnRefusal?>(null)
    // The chat the turns' answers stand on: the one whose send they answer.
    private var askedChat: String? = null
    // The seat the last send was asked under: what the turns answer of it stands on that seat alone.
    private var askedSeat: String? = null
    private var turnFault by mutableStateOf<CoachTurnFault?>(null)
    private var accessJob: Job? = null
    private var archiveReported = false
    private var retainedReported = false

    private var storeFailure by mutableStateOf<StoreFailure?>(null)
    // A send the account's change stopped, drawn apart from the band. Send waits only while the seat in hand may not write, so a seat that already may never strands the question it kept.
    val accountChanging: Boolean get() = turnFault == CoachTurnFault.accountChanging && askedSeat == archiveOwner
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
            scope.launch(start = CoroutineStart.UNDISPATCHED) { live.fault.collect { said -> turnFault = said } }
            scope.launch(start = CoroutineStart.UNDISPATCHED) { live.refusal.collect { refusal -> refused = refusal } }
        }
    }

    // A cap the server refills and a deployment without Coach stand on every chat, a cap until the moment it named; anything else on the chat that met it.
    fun refusal(chat: String): CoachTurnRefusal? {
        val refusal = refused ?: return null
        if (sending != null || askedSeat != archiveOwner || refusal.endsAtMs?.let { it <= now() } == true) return null
        return refusal.takeIf { it.capped || askedChat == chat }
    }

    // The one running turn every chat waits on stands on each; any other fault on the chat that met it. An account's change is drawn apart, by `accountChanging`.
    fun fault(chat: String): CoachTurnFault? {
        val fault = turnFault ?: return null
        if (sending != null || askedSeat != archiveOwner || fault == CoachTurnFault.accountChanging) return null
        return fault.takeIf { it == CoachTurnFault.busy || askedChat == chat }
    }

    // The lifter closed what a stop said: it does not come back with the room, and a fault said since is its own.
    fun closeFault(fault: CoachTurnFault) {
        turns?.closeFault(fault)
        if (turnFault == fault) turnFault = null
    }

    // A failure of this phone's own store, said in the room's line of the chat that met it. A draft that could not follow the account met no chat, and stands on each.
    fun failure(chat: String): String? = storeFailure?.takeIf { it.chat == null || it.chat == chat }?.said

    private fun failureOver(chat: String) {
        storeFailure = storeFailure?.takeUnless { it.chat == null || it.chat == chat }
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
                if (answered != anonymousAccess) telemetry.coachAction("access", answered.name.lowercase())
                anonymousAccess = answered
            }
        }
    }

    private fun admit(seat: String): LocalCoach.Authority? = localCoach?.admit(seat)

    // An archive this build cannot read costs what it holds, reported once: the engine's conversations still stand.
    private fun archiveFailed(failure: Exception) {
        if (!archiveReported) telemetry.unexpected("gym.restoreConversation", failure)
        archiveReported = true
    }

    // The answers a chat retains from earlier versions. One this build cannot read costs that answer, reported once by a failure that says nothing of it.
    private fun retained(seat: String, chat: String): List<CoachOnboardingRecord> = try {
        localCoach?.retained(seat, chat).orEmpty().filter { record ->
            record.readable.also { readable ->
                if (!readable && !retainedReported) telemetry.failure("gym.restoreConversation", CoachRecordUnreadable())
                retainedReported = retainedReported || !readable
            }
        }
    } catch (failure: Exception) {
        archiveFailed(failure)
        emptyList()
    }

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

    // Another seat's turn is that seat's: what the composer holds, what the room reads and what it said start over under the seat now in hand. A deployment without Coach is no seat's, and stays said.
    internal fun forgetSeat() {
        ownerRevision++
        turns?.forgetSeat()
        turnFault = null
        refused = refused.takeIf { it == CoachTurnRefusal.Absent }
        storeFailure = null
        conversations?.forgetSeat()
        if (restoredOwners.isNotEmpty()) watchSelected()
    }

    private fun restoreArchive(seat: String) {
        if (seat in restoredOwners) return
        restoredOwners += seat
        try {
            localCoach?.chats(seat).orEmpty().forEach { chats[seat to it.id] = it }
            localCoach?.selected(seat)?.let { selected[seat] = it }
        } catch (failure: Exception) {
            archiveFailed(failure)
        }
        watchSelected()
    }

    // What the conversation's read follows: the chat on screen, its thread, and the answers it retains from earlier versions.
    private fun watchSelected() {
        val seat = archiveOwner
        val chat = selected[seat]
        conversations?.watch(chat, chat?.let { chats[seat to it]?.conversation }, chat?.let { retained(seat, it) }.orEmpty())
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
        // A read can publish the question's record before its send has ended, and it is one question.
        if (said.lastOrNull()?.let { it.answer?.running == true && it.question == going.question } == true) return said
        return said + CoachExchange("sending", going.question, going.atMs, listOfNotNull(going.photo?.let { SentPicture(it, true) }), sending = true)
    }

    // An archive this build cannot read still opens a chat, kept in memory: what asks to write to it says so.
    fun freshChat(seed: String = "", id: String = Ids.thread(), setup: Boolean = false): String {
        val seat = archiveOwner
        if (localCoach?.readable != false) admit(seat)
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
        telemetry.coachAction("fresh_entry")
        return chat.id
    }

    // A row of History names a chat, or a thread this phone keeps nothing beside. What this phone may not write stays in memory, and the conversation opens all the same.
    fun selectChat(id: String, action: String = "history_open") {
        val seat = archiveOwner
        restoreArchive(seat)
        val chat = chats[seat to id] ?: LocalChat(id, now(), conversation = id).also { keepChat(seat, it) }
        select(seat, chat.id)
        telemetry.coachAction(action)
        if (draft(id).holdsSomething) telemetry.coachAction("draft_restored")
    }

    private fun select(seat: String, id: String) {
        if (localCoach?.writable(seat) != false) try {
            admit(seat)
            localCoach?.select(seat, id)
        } catch (failure: Exception) {
            conversationNotSaved(id, failure)
        }
        selected[seat] = id
        watchSelected()
    }

    private fun keepChat(seat: String, chat: LocalChat, select: Boolean = false) {
        chats[seat to chat.id] = chat
        if (localCoach?.writable(seat) == false) return
        try {
            admit(seat)
            localCoach?.saveChat(seat, chat, select)
            failureOver(chat.id)
        } catch (failure: Exception) {
            conversationNotSaved(chat.id, failure)
        }
    }

    private fun conversationNotSaved(chat: String, failure: Exception) {
        telemetry.unexpected("gym.saveConversation", failure)
        storeFailure = StoreFailure(chat, "Your conversation couldn’t be saved. Try again.")
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
        askedSeat = seat
        scope.launch {
            try {
                val bytes = try { photo?.let { withContext(storageDispatcher) { localCoach?.photoFile(seat, it.id)?.readBytes() } } }
                    catch (_: IOException) { null }
                if (photo != null && bytes == null) {
                    storeFailure = StoreFailure(id, CoachTurnFault.pictureUnavailable.sentence)
                    live.heldBack(CoachTurnFault.pictureUnavailable)
                    return@launch
                }
                val thread = chat.conversation?.takeIf { conversations?.holds(it) == true }
                // A question asked under one seat is that seat's: if the seat changed on the way here, it stays in its draft.
                if (seat != archiveOwner) {
                    live.heldBack(CoachTurnFault.accountChanging)
                    return@launch
                }
                // What the turns answer from here is this chat's, unless a turn runs: its end stays its own chat's, and this send is told Coach is busy, which stands on every chat. A send stopped before here leaves what was last said with the chat that met it.
                if (live.turn.value == null) askedChat = id
                val turn = live.send(question, photo?.let { ChosenPicture(it, requireNotNull(bytes)) }, thread?.let { Id(it, CoachThread) }, anonymous, once, on = replica) ?: return@launch
                failureOver(id)
                // The chat takes its thread first, so a withdrawal already on its way finds it there and its restore comes after.
                opened(seat, id, authority, turn)
                sent = Sent(id, authority)
                settleSent()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                telemetry.unexpected("gym.saveConversation", failure)
                live.heldBack(CoachTurnFault.unsaved)
            }
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
            conversationNotSaved(id, failure)
            false
        }
        chats[seat to id]?.let { chats[seat to id] = it.copy(conversation = thread, updatedAtMs = now()) }
        drafts.remove(seat to id)
        if (written) unsavedDrafts.remove(seat to id) else unsavedDrafts += seat to id
        draftVersion++
        if (seat == archiveOwner) watchSelected()
        conversations?.read()
    }

    // A turn that never began, refused before its stream or never reaching the server: the question and its photo return to the field. The chat keeps its thread only while the thread stands: a withdrawn first turn takes it along. What a turn still running or just ended holds is no one's to restore.
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
        // An owner erased since keeps nothing. Any other seat's question stands in the field: written, it answers an unwritten clear before it, and unwritten, it is retried with the next change while the disk still holds it.
        try {
            if (held.authority != null) withContext(storageDispatcher) {
                localCoach?.withAuthority(held.authority) { localCoach.turnWithdrawn(seat, held.chat, conversation, draft, withdrawn.picture?.original) }
            }
            unsavedDrafts -= seat to held.chat
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            unsavedDrafts += seat to held.chat
            telemetry.unexpected("gym.saveDraft", failure)
        }
        drafts[seat to held.chat] = draft
        draftVersion++
        if (seat == archiveOwner) watchSelected()
        conversations?.read()
    }

    fun stop() {
        turns?.requestStop()
    }

    // History: every thread the engine holds, under the chat this phone keeps beside it, and every chat of this phone's alone that holds something, a kept draft or a retained answer among it. A draft dates its row when it is newer than what was said.
    val history: List<ConversationRow> get() {
        val seat = archiveOwner
        restoreArchive(seat)
        val mine = chats.filterKeys { it.first == seat }.values
        val beside = mine.filter { it.conversation != null }.associateBy { it.conversation }
        val rows = conversations?.rows.orEmpty().map { row ->
            val chat = beside[row.id] ?: return@map row
            val held = draft(chat.id)
            val drafted = if (held.holdsSomething) chat.updatedAtMs else 0
            row.copy(id = chat.id, askedAtMs = maxOf(row.askedAtMs, drafted))
        }
        val listed = rows.map { it.id }.toSet()
        val local = mine.filter { it.id !in listed }.mapNotNull { chat ->
            val kept = beside(seat, chat.id) ?: return@mapNotNull null
            val title = listOfNotNull(kept.answers.firstOrNull()?.question, kept.draft.text, kept.drafts.firstOrNull()?.draft?.text).firstOrNull { it.isNotBlank() } ?: "Photo"
            ConversationRow(chat.id, title, chat.updatedAtMs, answerPreview = kept.answers.lastOrNull { it.response?.status == "completed" }?.response?.message.orEmpty())
        }
        return (rows + local).sortedByDescending { it.askedAtMs }
    }

    // What this phone keeps beside a chat and no replica holds: its draft, its retained answers and the drafts kept for it; null when it keeps nothing, which makes no row in History.
    private class Beside(val draft: CoachDraft, val answers: List<CoachOnboardingRecord>, val drafts: List<KeptCoachDraft>)

    private fun beside(seat: String, chat: String): Beside? {
        val draft = draft(seat, chat)
        val answers = retained(seat, chat)
        val drafts = localCoach?.keptDrafts(seat, chat).orEmpty().filter { it.draft.holdsSomething }
        if (!draft.holdsSomething && answers.isEmpty() && drafts.isEmpty()) return null
        return Beside(draft, answers, drafts)
    }

    // Whether History has a row to show, read without building the rows: a thread on the replica, or a chat this phone keeps something beside.
    val hasConversations: Boolean get() {
        val seat = archiveOwner
        restoreArchive(seat)
        if (conversations?.threads.orEmpty().isNotEmpty()) return true
        return chats.keys.any { (owner, id) -> owner == seat && beside(seat, id) != null }
    }

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
            if (owner == account) storeFailure = StoreFailure(null, "Your draft couldn’t be saved. Try again.")
        } finally { adoptingDraft = false }
    }

    fun draftChangeReady(key: String): Boolean {
        val seat = archiveOwner
        if (localCoach?.writable(seat) == false) return false
        val recovered = try { localCoach?.reconcileDraftChange(seat, key) }
        catch (_: Exception) { storeFailure = StoreFailure(key, "Your draft couldn’t be saved. Try again."); return false }
        if (recovered == null) return true
        publishRecovery(recovered)
        return false
    }

    private fun publishRecovery(recovered: CoachDraftRecovery) {
        recovered.source?.let { drafts.remove(it); unsavedDrafts.remove(it) }
        publishDraft(recovered.owner, recovered.chat)
        if (recovered.action != "adopt") telemetry.coachAction(recovered.action)
    }

    fun continueDraft(key: String, heldId: String): Boolean {
        val seat = archiveOwner
        if (!draftChangeReady(key)) return false
        if (isAsking(key) || !draftSaved(key)) return false
        try { if (localCoach?.continueDraft(seat, key, heldId) { telemetry.unexpected("gym.saveDraft", it) } != true) return false }
        catch (failure: Exception) { telemetry.unexpected("gym.saveDraft", failure); throw failure }
        publishDraft(seat, key)
        telemetry.coachAction("continue_draft")
        return true
    }

    private fun publishDraft(seat: String, key: String) {
        val disk = localCoach ?: return
        drafts[seat to key] = disk.draft(seat, key)
        unsavedDrafts.remove(seat to key)
        (chats[seat to key] ?: disk.chat(seat, key))?.let { chats[seat to key] = it.copy(updatedAtMs = now()) }
        draftVersion++
        failureOver(key)
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
        telemetry.coachSetupStep("photo_removed")
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
            telemetry.coachSetupStep("photo_selected")
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

    // A retained answer's drafts, in one gesture: replayed by the answer's result identity, so a second tap makes no new routines. Runs in the store's scope, so leaving Coach does not cancel it; it commits on storage, and what it asks to read goes after the commit.
    suspend fun saveRetainedDrafts(chat: String, requestId: String): DraftOutcome {
        val seat = archiveOwner
        // Its drafts are the answer's own, so a question this build cannot read does not cost them.
        val record = try { localCoach?.retained(seat, chat)?.firstOrNull { it.requestId == requestId } }
            catch (failure: Exception) { archiveFailed(failure); null } ?: return DraftOutcome.Closed(R.string.gym_coach_draft_gone)
        val saving = imports ?: return DraftOutcome.Closed(R.string.gym_coach_draft_invalid)
        return scope.async {
            when (withContext(storageDispatcher) { saving.apply(record) }) {
                is CoachImportOutcome.Committed, is CoachImportOutcome.Replayed -> {
                    onProgramChanged()
                    conversations?.read()
                    DraftOutcome.Saved
                }
                CoachImportOutcome.Refused -> DraftOutcome.Closed(R.string.gym_coach_draft_invalid)
                CoachImportOutcome.Failed -> DraftOutcome.Failed(R.string.gym_coach_draft_retry)
            }
        }.await()
    }

    // A conversation deleted from History: its thread, its messages and their pictures, then what this phone kept beside them. A conversation with a turn running stays. An archive this build cannot read holds nothing of it, and the thread is the engine's to delete all the same.
    suspend fun deleteThread(id: String): GymResult<Unit> {
        val seat = archiveOwner
        val archive = localCoach?.takeIf { it.readable }
        val admission = runCatching { archive?.admit(seat) }
        val thread = chats[seat to id]?.conversation ?: id.takeIf { conversations?.holds(it) == true }
        return scope.async {
            val result = deleted(id, seat, archive, admission, thread)
            telemetry.event("gym_action", mapOf("screen" to "threads", "action" to "delete", "outcome" to when (result) {
                is GymResult.Ok -> "ok"
                is GymResult.Failed -> if (result.why is WriteFailure.Refused) "refused" else "failed"
            }))
            result
        }.await()
    }

    private suspend fun deleted(id: String, seat: String, archive: LocalCoach?, admission: Result<LocalCoach.Authority?>, thread: String?): GymResult<Unit> {
        val authority = admission.getOrElse { refusal ->
            if (refusal !is CancellationException) telemetry.unexpected("gym.deleteThread", refusal as Exception)
            return GymResult.Failed(WriteFailure.Refused(TrainingSeat.accountChanged))
        }
        if ((authority != null && archive?.current(authority) != true) || seat != archiveOwner) return GymResult.Failed(WriteFailure.Refused(TrainingSeat.accountChanged))
        if (thread != null && thread == runningThread) return GymResult.Failed(WriteFailure.Refused(CoachTurnFault.busy.sentence))
        return try {
            if (thread != null && turns?.deleteConversation(Id(thread, CoachThread)) == false) return GymResult.Failed(WriteFailure.NoAnswer)
            // Once the thread has gone the conversation has: what this phone kept beside it is reported, and its row does not come back as "still here".
            try { archive?.clear(seat, id) }
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
    data class Closed(@StringRes val said: Int) : DraftOutcome
    data class Failed(@StringRes val said: Int) : DraftOutcome
}
