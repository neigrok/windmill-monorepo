package works.windmill.gym.coach

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import works.windmill.domain.kit.Ability
import works.windmill.domain.kit.AbilityClass
import works.windmill.domain.kit.DecodeError
import works.windmill.domain.kit.Entity
import works.windmill.domain.kit.EntityType
import works.windmill.domain.kit.Fields
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Reader
import works.windmill.gym.coach.onboarding.CoachOnboardingRecord
import works.windmill.gym.coach.onboarding.CoachRoutineImports
import works.windmill.gym.coach.turn.CoachTurnRefusal
import works.windmill.gym.coach.turn.contextCallPrefix
import works.windmill.gym.domain.coach.AbilityCall
import works.windmill.gym.domain.coach.AbilityRefusal
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.domain.coach.CoachPictureRow
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.Picture
import works.windmill.gym.domain.coach.ReadTally
import works.windmill.gym.domain.coach.RecordedRead
import works.windmill.gym.domain.coach.inOrder
import works.windmill.gym.domain.sync.CoachImportReceipt
import works.windmill.gym.domain.sync.Routine
import works.windmill.gym.store.EngineTraining
import works.windmill.gym.store.TrainingSeat
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.api.Record
import works.windmill.sync.api.RecordRef
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.JsonError
import works.windmill.sync.core.RecordID
import works.windmill.sync.schema.Gym

// A picture on a message. `onThisPhone` says this phone holds its file: a picture stays on the phone that sent it (Coach §9.3).
data class SentPicture(val photo: CoachAttachment, val onThisPhone: Boolean)

// One ability call as the room says it: `phrase` and `kind` are the catalog's, absent for a name this build's catalog does not hold. `context` is a read the turn made of itself at its opening rather than one the model asked for.
data class CoachCall(val name: String, val phrase: String?, val kind: AbilityClass?, val outcome: AbilityCall.Outcome, val read: RecordedRead, val created: List<RecordRef>, val context: Boolean = false) {
    val ran: Boolean get() = outcome == AbilityCall.Outcome.Ok
    val seatRefused: Boolean get() = (outcome as? AbilityCall.Outcome.Refused)?.code == AbilityRefusal.seatRequired
}

// What a turn did (Coach §9.2): the log rows it read, by count, whether some were held as counts alone, and the records it created.
data class CoachReceipt(val read: ReadTally, val truncated: Boolean, val created: List<RecordRef>) {
    constructor(calls: List<AbilityCall>) : this(AbilityCall.receipt(calls))

    private constructor(json: Json) : this(ReadTally.decode(json.member("read")), json["truncated"]?.bool() == true,
        json.member("results").arr().map { RecordRef(it.member("t").str(), RecordID(it.member("id"))) })
}

data class CreatedRoutine(val id: String, val name: String)

// Coach's answer as its message holds it. `onThisPhone` says the replica writing it is this phone's, so a running answer that is not stands on another device (Coach §4.5). `routines` are the created routines the replica still holds, with their names read now.
data class CoachReply(
    val id: String,
    val text: String,
    val state: MessageState,
    val truncated: Boolean,
    val onThisPhone: Boolean,
    val calls: List<CoachCall>,
    val receipt: CoachReceipt,
    val routines: List<CreatedRoutine>,
) {
    val running: Boolean get() = state == MessageState.running
    // The catalog's phrases of the calls so far, in order: the step line under an answer on its way.
    val steps: List<String> get() = calls.filter { it.ran }.mapNotNull { it.phrase }
    // The routine proposals this answer minted, in the order it minted them.
    val proposals: List<String> get() = receipt.created.filter { it.type == Gym.Types.proposal }.mapNotNull { it.id.string }
    val workoutProposals: List<String> get() = receipt.created.filter { it.type == Gym.Types.workoutProposal }.mapNotNull { it.id.string }
    val notes: List<String> get() = receipt.created.filter { it.type == Gym.Types.note }.mapNotNull { it.id.string }
    val movements: List<String> get() = receipt.created.filter { it.type == Gym.Types.exercise }.mapNotNull { it.id.string }
    // The workouts this answer read by identity, in the order it read them.
    val workoutsRead: List<String> get() = calls.filter { it.ran }.flatMap { (it.read as? RecordedRead.Ids)?.served?.sessions.orEmpty() }.distinct().mapNotNull { it.record.string }
}

// An answer earlier versions kept on this phone: the line it ended on, and the drafts it holds until they are saved.
data class RetainedAnswer(val requestId: String, val line: String?, val accountRequired: Boolean, val drafts: List<CoachRoutineDraft>)

// One turn of a conversation as the room draws it: what the lifter said and how Coach answered. `id` is stable across every read of it; `sending` is a question on its way to its record, drawn before it has one.
data class CoachExchange(
    val id: String,
    val question: String,
    val atMs: Long,
    val pictures: List<SentPicture> = emptyList(),
    val answer: CoachReply? = null,
    val sending: Boolean = false,
    val retained: RetainedAnswer? = null,
) {
    val waiting: Boolean get() = sending || answer?.running == true
}

// A conversation's row in History. `answering` is a running message on any device; `answerPreview` the newest completed answer's opening.
data class ConversationRow(val id: String, val title: String, val askedAtMs: Long, val answering: Boolean = false, val answerPreview: String = "") {
    fun day(nowMs: Long): String? {
        if (askedAtMs <= 0) return null
        val zone = java.time.ZoneId.systemDefault()
        val day = java.time.Instant.ofEpochMilli(askedAtMs).atZone(zone).toLocalDate()
        val today = java.time.Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
        if (day == today) return "Today"
        if (day == today.minusDays(1)) return "Yesterday"
        return day.format(java.time.format.DateTimeFormatter.ofPattern("MMM d"))
    }
}

// The room's reads over the engine's `thread` and `message` records (Coach §9): the chat on screen, every thread, and History's rows while History is up. Each read runs off the main thread through the seat's guarded read, again on every revision of the engine.
class CoachConversations(
    private val seat: TrainingSeat,
    private val training: EngineTraining,
    private val telemetry: Telemetry,
    private val ability: (String) -> Ability?,
) {
    private data class Watched(val chat: String? = null, val thread: String? = null, val retained: List<CoachOnboardingRecord> = emptyList(), val history: Boolean = false)
    private data class Transcript(val chat: String, val exchanges: List<CoachExchange>)
    private class Reading(val threads: List<CoachThread>, val transcript: Transcript?, val rows: List<ConversationRow>?)

    // Nothing until the room first asks, so a seat that never opens Coach reads nothing of it.
    private val watched = MutableStateFlow<Watched?>(null)
    private var open by mutableStateOf<Transcript?>(null)
    private var undecodedReported = false

    // Every thread the seat holds, cheap enough to read on each revision of a streaming turn.
    var threads by mutableStateOf<List<CoachThread>>(emptyList())
        private set
    // History's rows; absent until a read has made them.
    var rows by mutableStateOf<List<ConversationRow>?>(null)
        private set

    fun exchanges(chat: String): List<CoachExchange> = open?.takeIf { it.chat == chat }?.exchanges.orEmpty()

    fun watch(chat: String?, thread: String?, retained: List<CoachOnboardingRecord>) {
        watched.update { (it ?: Watched()).copy(chat = chat, thread = thread, retained = retained) }
    }

    fun watchHistory(on: Boolean) {
        watched.update { (it ?: Watched()).copy(history = on) }
    }

    fun forgetSeat() {
        open = null
        threads = emptyList()
        rows = null
    }

    // Runs for the application's life: a read on every revision and on every change of what is watched; a newer one replaces a read still under way.
    suspend fun observe() {
        combine(training.engine.revisions(), watched) { revision, wanted -> revision to wanted }.collectLatest { read() }
    }

    suspend fun read() {
        val wanted = watched.value ?: return
        val held = seat.tried("gym.readConversation") { seat.readTraining { training.reading { reader -> reading(reader, wanted) } } } ?: return
        if (wanted.chat != watched.value?.chat) return
        threads = held.threads
        open = held.transcript
        if (held.rows != null) rows = held.rows
    }

    // Whether the engine holds this thread now, rather than as of the last read.
    suspend fun holds(thread: String): Boolean = seat.tried("gym.readConversation") {
        seat.readTraining { training.reading { reader -> reader.repository(CoachThread).record(Id(thread, CoachThread), ViewMode.drawn)?.isVisible == true } }
    } == true

    private fun reading(reader: Reader, wanted: Watched): Reading {
        val threads = decoded(CoachThread, reader.source.drawn(CoachThread.type))
        val replica = training.engine.activeReplica()
        val transcript = wanted.chat?.let { chat ->
            val said = wanted.thread?.let { decoded(CoachMessage, reader.source.drawn(CoachMessage.type, "threadId", Id<CoachThread>(it, CoachThread).record)) }.orEmpty()
            val retained = wanted.retained.map { record -> CoachExchange(record, record.response?.let { response -> receipt(reader, response.resultId) }) }
            Transcript(chat, (retained + exchanges(said, reader, replica)).sortedBy { it.atMs })
        }
        val rows = if (!wanted.history) null else decoded(CoachMessage, reader.source.drawn(CoachMessage.type)).groupBy { it.threadId }.let { said ->
            threads.map { thread -> ConversationRow(thread, said[thread.id].orEmpty()) }
        }
        return Reading(threads, transcript, rows)
    }

    private fun receipt(reader: Reader, resultId: String): CoachImportReceipt? = try {
        reader.device(CoachRoutineImports.receiptKey(resultId))?.let(CoachImportReceipt::decode)
    } catch (_: JsonError) {
        null
    }

    // The conversation's messages in the order they were said, each answer under its question. An answer whose question has not arrived, as a pull page can leave it, stands alone.
    private fun exchanges(messages: List<CoachMessage>, reader: Reader, replica: String): List<CoachExchange> {
        val exchanges = mutableListOf<CoachExchange>()
        for (message in messages.inOrder) {
            val id = checkNotNull(message.id.record.string) { "a message's id is a string" }
            if (message.role == CoachMessage.Role.lifter) {
                exchanges += CoachExchange(id, message.text, message.at.ms, message.pictures.map { sent(it, reader) })
                continue
            }
            val reply = reply(message, id, reader, replica)
            val last = exchanges.lastOrNull()
            if (last != null && last.answer == null) exchanges[exchanges.lastIndex] = last.copy(answer = reply)
            else exchanges += CoachExchange(id, "", message.at.ms, answer = reply)
        }
        return exchanges
    }

    private fun reply(message: CoachMessage, id: String, reader: Reader, replica: String): CoachReply {
        val receipt = CoachReceipt(message.calls)
        val routines = receipt.created.filter { it.type == Routine.type }.mapNotNull { ref ->
            val held = reader.source.drawn(Routine.type, ref.id)?.takeIf { it.isVisible } ?: return@mapNotNull null
            decoded(Routine, listOf(held)).singleOrNull()?.let { CreatedRoutine(checkNotNull(ref.id.string), it.name) }
        }
        return CoachReply(id, message.text, message.state, message.truncated, message.replica == replica,
            message.calls.map { call -> ability(call.name).let { CoachCall(call.name, it?.phrase, it?.kind, call.outcome, call.read, call.created, call.callId.startsWith(contextCallPrefix)) } }, receipt, routines)
    }

    private fun sent(picture: Picture, reader: Reader): SentPicture {
        val row = CoachPictureRow.decode(picture.id, reader.device(CoachPictureRow.key(picture.id)))
        return SentPicture(CoachAttachment(picture.id, row?.mediaType ?: picture.mediaType, row?.width ?: 0, row?.height ?: 0, row?.bytes?.toLong() ?: 0), row != null)
    }

    // A record this build cannot read costs that record and never the conversation around it; the first one in a run is reported.
    private fun <E : Entity<E>> decoded(type: EntityType<E>, records: Collection<Record>): List<E> = records.filter { it.isVisible }.mapNotNull { record ->
        try {
            type.decode(Fields(record))
        } catch (_: DecodeError) {
            undecoded()
        } catch (_: JsonError) {
            undecoded()
        }
    }

    private fun undecoded(): Nothing? {
        if (!undecodedReported) telemetry.failure("gym.readConversation", CoachRecordUnreadable())
        undecodedReported = true
        return null
    }
}

// The one static failure of a read; it carries no message of anything said.
private class CoachRecordUnreadable : Exception("coach-record-unreadable")

private const val previewCodePoints = 240

private fun ConversationRow(thread: CoachThread, messages: List<CoachMessage>): ConversationRow {
    val said = messages.inOrder
    val newest = said.lastOrNull()
    val answer = said.lastOrNull { it.role == CoachMessage.Role.coach && it.state == MessageState.completed && it.text.isNotBlank() }?.text.orEmpty()
    return ConversationRow(checkNotNull(thread.id.record.string) { "a thread's id is a string" }, thread.title, newest?.at?.ms ?: 0,
        answering = newest?.role == CoachMessage.Role.coach && newest.state == MessageState.running,
        answerPreview = answer.substring(0, answer.offsetByCodePoints(0, minOf(previewCodePoints, answer.codePointCount(0, answer.length)))))
}

// An answer earlier versions kept, as one exchange of its chat. Its saved routines come from the import's receipt, its drafts from the answer until then.
private fun CoachExchange(record: CoachOnboardingRecord, saved: CoachImportReceipt?): CoachExchange {
    val response = record.response
    val code = response?.errorCode ?: record.refusalCode
    val answered = response?.status == "completed"
    val routines = if (saved == null) emptyList() else saved.routines.zip(response?.routines.orEmpty()).mapNotNull { (id, routine) ->
        id.record.string?.let { CreatedRoutine(it, routine.name) }
    }
    val line = when {
        answered || code == "account_required" -> null
        code == "subject_exhausted" -> CoachTurnRefusal.of(code).sentence
        code in setOf("free_day_exhausted", "free_month_exhausted", "concurrency_exhausted", "funding_required") ->
            response?.message?.takeIf { it.isNotBlank() } ?: record.refusalMessage ?: Ask.couldNotTake
        else -> Ask.couldNotTake
    }
    val drafts = if (saved != null || !answered) emptyList() else response?.routines.orEmpty().mapIndexed { index, routine -> CoachRoutineDraft("${record.requestId}-$index", routine) }
    val reply = response?.takeIf { answered }?.let {
        CoachReply(record.requestId, it.message, MessageState.completed, truncated = false, onThisPhone = true, calls = emptyList(), receipt = CoachReceipt(emptyList()), routines = routines)
    }
    return CoachExchange(record.requestId, record.request().text, record.createdAtMs, listOfNotNull(record.attachment?.let { SentPicture(it, true) }), reply,
        retained = RetainedAnswer(record.requestId, line, code == "account_required", drafts))
}
