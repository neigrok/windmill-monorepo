package works.windmill.gym.coach

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.coroutineScope
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
import works.windmill.gym.coach.turn.CoachTurns
import works.windmill.gym.coach.turn.LiveAnswer
import works.windmill.gym.domain.coach.AbilityCall
import works.windmill.gym.domain.coach.AbilityRefusal
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.domain.coach.CoachPictureRow
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.Picture
import works.windmill.gym.domain.coach.ReadServed
import works.windmill.gym.domain.coach.ReadTally
import works.windmill.gym.domain.coach.RecordedRead
import works.windmill.gym.domain.coach.inOrder
import works.windmill.gym.domain.sync.CoachImportReceipt
import works.windmill.gym.domain.sync.Exercise
import works.windmill.gym.domain.sync.Note
import works.windmill.gym.domain.sync.Proposal
import works.windmill.gym.domain.sync.Routine
import works.windmill.gym.domain.sync.Session
import works.windmill.gym.domain.sync.WorkoutProposal
import works.windmill.gym.presentation.Readout
import works.windmill.gym.store.EngineTraining
import works.windmill.gym.store.TrainingSeat
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.api.Record
import works.windmill.sync.api.RecordRef
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.JsonError
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.Stamp
import works.windmill.sync.schema.Gym

// A picture on a message. `onThisPhone` says this phone holds its file: a picture stays on the phone that sent it (Coach §9.3).
data class SentPicture(val photo: CoachAttachment, val onThisPhone: Boolean)

// What the rows of one answer's What Coach read say beyond their titles. Each reads the records its call names, so no revision pays for them: the first row the sheet draws starts one read off the main thread, and the rows fill in when it lands. An answer holds one of these across every read of it, so a sheet left open keeps what it read.
class CoachCallDetails private constructor(private val scope: CoroutineScope?, private val read: (suspend () -> Map<String, String>?)?, said: Map<String, String>) {
    internal constructor(scope: CoroutineScope, read: suspend () -> Map<String, String>?) : this(scope, read, emptyMap())
    internal constructor(said: Map<String, String>) : this(null, null, said)

    private var asked = false
    private var said by mutableStateOf(said)

    fun of(callId: String): String? {
        if (read != null && !asked) {
            asked = true
            scope?.launch {
                val answered = read.invoke()
                if (answered != null) said = answered else asked = false
            }
        }
        return said[callId]
    }
}

// One ability call as the room says it: `phrase` is the catalog's, absent for a name this build's catalog does not hold, and `reads` says the catalog holds it as a read. `detail` is what the call served or wrote, read from the records when What Coach read first draws it.
data class CoachCall(val name: String, val phrase: String?, val outcome: AbilityCall.Outcome, val read: RecordedRead, val created: List<RecordRef>,
    val reads: Boolean = false, private val callId: String = name, private val details: CoachCallDetails? = null) {
    val detail: String? get() = details?.of(callId)
    val ran: Boolean get() = outcome == AbilityCall.Outcome.Ok
    val seatRefused: Boolean get() = (outcome as? AbilityCall.Outcome.Refused)?.code == AbilityRefusal.seatRequired
    // Its row in What Coach read: a read that served workouts says how many, every other call its phrase.
    val title: String? get() {
        val workouts = when (read) {
            is RecordedRead.Ids -> read.served.sessions.size
            is RecordedRead.Counts -> read.tally.sessions
        }
        if (workouts > 0) return "Read ${Readout.sessionCount(workouts)}"
        return phrase?.replaceFirstChar { it.uppercase() }
    }
}

// What a turn did (Coach §9.2): the log rows it read, by count, whether some were held as counts alone, and the records it created.
data class CoachReceipt(val read: ReadTally, val truncated: Boolean, val created: List<RecordRef>) {
    constructor(calls: List<AbilityCall>) : this(AbilityCall.receipt(calls))

    private constructor(json: Json) : this(ReadTally.decode(json.member("read")), json["truncated"]?.bool() == true,
        json.member("results").arr().map { RecordRef(it.member("t").str(), RecordID(it.member("id"))) })
}

data class CreatedRoutine(val id: String, val name: String, val movements: Int)

// A note a turn saved, as its record holds it.
data class SavedNote(val id: String, val text: String)

// A movement a turn made, as its record holds it.
data class MadeMovement(val id: String, val name: String, val equipment: String, val stepKg: Double)

// Coach's answer as its message holds it. `onThisPhone` says the replica writing it is this phone's. `routines`, `savedNotes` and `madeMovements` are what the turn created and the replica still holds, read now.
data class CoachReply(
    val id: String,
    val text: String,
    val state: MessageState,
    val truncated: Boolean,
    val onThisPhone: Boolean,
    val calls: List<CoachCall>,
    val receipt: CoachReceipt,
    val routines: List<CreatedRoutine>,
    val savedNotes: List<SavedNote> = emptyList(),
    val madeMovements: List<MadeMovement> = emptyList(),
) {
    val running: Boolean get() = state == MessageState.running
    // A running answer another device writes: this phone never writes it (Coach §4.5).
    val elsewhere: Boolean get() = running && !onThisPhone
    // The catalog's phrases of the calls so far, in order.
    val steps: List<String> get() = calls.filter { it.ran }.mapNotNull { it.phrase }
    // What the turn has done so far, under an answer on its way.
    val stepLine: String? get() = steps.takeIf { it.isNotEmpty() }?.joinToString(" · ")
    // The rows of What Coach read.
    val readRows: List<CoachCall> get() = calls.filter { it.ran && it.title != null }
    // The receipt under an ended answer, by the first that holds: the workouts it read by identity, its movement history, the catalog's phrases of the other reads it ran, or that it read nothing, when no read ran at all.
    val readLine: String? get() {
        val reads = calls.filter { it.ran && it.reads }
        return when {
            receipt.read.sessions > 0 -> "Read ${Readout.sessionCount(receipt.read.sessions)} · ${Readout.weekCount(receipt.read.weeks)}"
            reads.any { it.name == "get_stats" } -> Ask.readMovementHistory
            reads.isEmpty() -> Ask.readNothing
            else -> reads.mapNotNull { it.phrase }.joinToString(" · ").ifEmpty { null }
        }
    }
    // The routine proposals this answer minted, in the order it minted them.
    val proposals: List<String> get() = receipt.created.filter { it.type == Gym.Types.proposal }.mapNotNull { it.id.string }
    val workoutProposals: List<String> get() = receipt.created.filter { it.type == Gym.Types.workoutProposal }.mapNotNull { it.id.string }
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

// The room's reads over the engine's `thread` and `message` records (Coach §9): the chat on screen, every thread, and History's rows while History is up. Each read runs off the main thread through the seat's guarded read, again on every revision of the engine, and only while a screen of Coach stands.
class CoachConversations(
    private val seat: TrainingSeat,
    private val training: EngineTraining,
    private val telemetry: Telemetry,
    private val turns: CoachTurns?,
    private val scope: CoroutineScope,
) {
    private data class Watched(val chat: String? = null, val thread: String? = null, val retained: List<CoachOnboardingRecord> = emptyList(), val screens: Int = 0, val history: Boolean = false) {
        val shown: Boolean get() = screens > 0 || history
    }
    private data class Transcript(val chat: String, val exchanges: List<CoachExchange>)
    private class Reading(val threads: List<CoachThread>, val transcript: Transcript?, val rows: List<ConversationRow>?)

    // What the reads follow. With no screen of Coach standing nothing is read, and a turn running meanwhile asks for no read: its words follow `live`, and the screen that returns reads what it wrote.
    private val watched = MutableStateFlow(Watched())
    private var open by mutableStateOf<Transcript?>(null)
    private var undecodedReported = false
    private var live by mutableStateOf<LiveAnswer?>(null)
    private val details = ConcurrentHashMap<Pair<String, Int>, CoachCallDetails>()

    // Whether this phone's turn has lost its stream and is finding it again.
    var reconnecting by mutableStateOf(false)
        private set
    // Every thread the seat holds, cheap enough to read on each revision of a streaming turn.
    var threads by mutableStateOf<List<CoachThread>>(emptyList())
        private set
    // History's rows; absent until a read has made them.
    var rows by mutableStateOf<List<ConversationRow>?>(null)
        private set

    fun exchanges(chat: String): List<CoachExchange> = open?.takeIf { it.chat == chat }?.exchanges.orEmpty()

    fun watch(chat: String?, thread: String?, retained: List<CoachOnboardingRecord>) {
        watched.update { it.copy(chat = chat, thread = thread, retained = retained) }
    }

    // Counted, since a frame sliding away and the one taking its place both stand for a moment.
    fun showing(on: Boolean) {
        watched.update { it.copy(screens = it.screens + if (on) 1 else -1) }
    }

    fun watchHistory(on: Boolean) {
        watched.update { it.copy(history = on) }
    }

    // An answer as it stands this moment. A running message this phone writes carries the words so far, which its record takes only every few seconds. An ended message is its record's alone.
    fun standing(reply: CoachReply): CoachReply {
        val words = live?.takeIf { reply.running && it.message.record.string == reply.id } ?: return reply
        return reply.copy(text = words.text)
    }

    fun forgetSeat() {
        live = null
        reconnecting = false
        details.clear()
        open = null
        threads = emptyList()
        rows = null
    }

    // Runs for the application's life: a read on every revision and on every change of what is watched, while a screen stands; a newer one replaces a read still under way.
    suspend fun observe() = coroutineScope {
        turns?.let { running ->
            launch { running.liveAnswer.collect { answer -> follow(answer) } }
            launch { running.activity.collect { reconnecting = it?.reconnecting == true } }
        }
        combine(training.engine.revisions(), watched) { revision, wanted -> revision to wanted }.collectLatest { read() }
    }

    // A turn's end has committed by the time its words go, so what it left is read first and the answer never shows an older commit on its way to the final text.
    private suspend fun follow(answer: LiveAnswer?) {
        if (answer == null && live != null) read()
        live = answer
    }

    suspend fun read() {
        val wanted = watched.value.takeIf { it.shown } ?: return
        val held = seat.tried("gym.readConversation") { seat.readTraining { training.reading { reader -> reading(reader, wanted) } } } ?: return
        if (wanted.chat != watched.value.chat) return
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
        val rows = if (!wanted.history) null else decoded(reader.source.drawn(CoachMessage.type), ::MessageLine).groupBy { it.thread }.let { said ->
            threads.map { thread -> ConversationRow(thread, said[thread.id].orEmpty()) }
        }
        return Reading(threads, transcript, rows)
    }

    private fun receipt(reader: Reader, resultId: String): CoachImportReceipt? = try {
        reader.device(CoachRoutineImports.receiptKey(resultId))?.let(CoachImportReceipt::decode)
    } catch (_: JsonError) {
        null
    } catch (_: DecodeError) {
        null
    }

    // The conversation's messages in the order they were said, each answer under its question. An answer whose question has not arrived, as a pull page can leave it, stands alone.
    private fun exchanges(messages: List<CoachMessage>, reader: Reader, replica: String): List<CoachExchange> {
        val exchanges = mutableListOf<CoachExchange>()
        val named = Named(reader)
        for (message in messages.inOrder) {
            val id = checkNotNull(message.id.record.string) { "a message's id is a string" }
            if (message.role == CoachMessage.Role.lifter) {
                exchanges += CoachExchange(id, message.text, message.at.ms, message.pictures.map { sent(it, reader) })
                continue
            }
            val reply = reply(message, id, replica, named)
            val last = exchanges.lastOrNull()
            if (last != null && last.answer == null) exchanges[exchanges.lastIndex] = last.copy(answer = reply)
            else exchanges += CoachExchange(id, "", message.at.ms, answer = reply)
        }
        return exchanges
    }

    // An answer holds its details for as long as its calls stand as they are.
    private fun details(message: CoachMessage, id: String): CoachCallDetails = details.getOrPut(id to message.calls.size) {
        CoachCallDetails(scope) { seat.tried("gym.readConversation") { seat.readTraining { training.reading { reader -> Named(reader).details(message) } } } }
    }

    private fun reply(message: CoachMessage, id: String, replica: String, named: Named): CoachReply {
        val receipt = CoachReceipt(message.calls)
        val routines = receipt.created.mapNotNull { ref -> named.routine(ref)?.let { CreatedRoutine(checkNotNull(ref.id.string), it.name, it.entries.size) } }
        val notes = receipt.created.mapNotNull { ref -> named.note(ref)?.let { SavedNote(checkNotNull(ref.id.string), it.body.ifBlank { it.title }) } }
        val movements = receipt.created.mapNotNull { ref -> named.movement(ref)?.let { MadeMovement(checkNotNull(ref.id.string), it.name, Readout.equipment(it.equipment, it.loadCount), it.stepKg) } }
        val rows = details(message, id)
        val calls = message.calls.map { call -> CoachCall(call.name, phrase(call.name), call.outcome, call.read, call.created, reads(call.name), call.callId, rows) }
        return CoachReply(id, message.text, message.state, message.truncated, message.replica == replica, calls, receipt, routines, notes, movements)
    }

    private fun phrase(name: String): String? = turns?.catalog?.value?.ability(name)?.phrase

    private fun reads(name: String): Boolean = turns?.catalog?.value?.ability(name)?.kind == AbilityClass.read

    // What an answer's calls name, read from the records now, as What Coach read says it.
    private inner class Named(private val reader: Reader) {
        fun routine(ref: RecordRef): Routine? = held(Routine, ref)
        fun note(ref: RecordRef): Note? = held(Note, ref)
        fun movement(ref: RecordRef): Exercise? = held(Exercise, ref)

        private fun <E : Entity<E>> held(type: EntityType<E>, ref: RecordRef): E? {
            if (ref.type != type.type) return null
            return reader.source.drawn(type.type, ref.id)?.let { decoded(type, listOf(it)).singleOrNull() }
        }

        // What each call of this message says, by its id.
        fun details(message: CoachMessage): Map<String, String> {
            val born = reader.source.drawn(CoachMessage.type, message.id.record)?.born
            return message.calls.withIndex().mapNotNull { (at, call) ->
                detail(call, born, message.calls.take(at).flatMap { it.created })?.let { call.callId to it }
            }.toMap()
        }

        // A read that served workouts says over which weeks and days, and the weeks are that call's own: §9.2 records a later call less what earlier calls hold. Every other call says what the records it read or wrote hold now.
        private fun detail(call: AbilityCall, born: Stamp?, madeBefore: List<RecordRef>): String? {
            val served = (call.read as? RecordedRead.Ids)?.served
            val counted = (call.read as? RecordedRead.Counts)?.tally
            if ((served?.sessions?.size ?: counted?.sessions ?: 0) > 0) {
                val sessions = served?.sessions.orEmpty().mapNotNull { held(Session, RecordRef(Session.type, it.record)) }
                val days = sessions.map { it.startedAt.ms }.sorted().map(::dayLabel)
                val span = if (days.firstOrNull() != days.lastOrNull()) listOf("${days.first()} – ${days.last()}") else days.take(1)
                val weeks = if (sessions.isEmpty()) served?.weeks?.size ?: counted?.weeks ?: 0 else sessions.map { ReadServed.week(it.startedAt) }.toSet().size
                return (listOfNotNull(weeks.takeIf { it > 0 }?.let(Readout::weekCount)) + span).joinToString(" · ").ifEmpty { null }
            }
            return when (call.name) {
                "list_notes" -> listed(Note, born, madeBefore).size.takeIf { it > 0 }?.let(Readout::noteCount)
                "list_routines" -> Routine.ordered(listed(Routine, born, madeBefore)).takeIf { it.isNotEmpty() }?.joinToString(" · ") { it.name }
                else -> call.created.mapNotNull(::named).filter { it.isNotBlank() }.takeIf { it.isNotEmpty() }?.joinToString(" · ")
            }
        }

        // What a list call read, as near as the records can say until `calls` records it: those born by its message's moment, and those its earlier calls made. A record deleted since drops out of the row, and a name reads as it stands now.
        private fun <E : Entity<E>> listed(type: EntityType<E>, born: Stamp?, madeBefore: List<RecordRef>): List<E> = decoded(type, reader.source.drawn(type.type).filter { record ->
            born == null || record.born.let { it == null || it <= born } || RecordRef(type.type, record.id) in madeBefore
        })

        private fun named(ref: RecordRef): String? = when (ref.type) {
            Routine.type -> routine(ref)?.name
            Note.type -> note(ref)?.title
            Exercise.type -> movement(ref)?.name
            Proposal.type -> held(Proposal, ref)?.let(::proposalTitle)
            WorkoutProposal.type -> held(WorkoutProposal, ref)?.let { "This workout · ${Readout.changeCount(it.changes.size)}" }
            else -> null
        }

        private fun proposalTitle(proposal: Proposal): String {
            val routine = held(Routine, RecordRef(Routine.type, proposal.routineId.record))
            val what = if (proposal.intent == "remove") "a removal" else Readout.changeCount(routine?.let { proposal.changeCount(it) } ?: proposal.changeCount ?: proposal.changes.size)
            return listOfNotNull(proposal.baseName ?: routine?.name, what).joinToString(" · ")
        }
    }

    private fun sent(picture: Picture, reader: Reader): SentPicture {
        val row = CoachPictureRow.decode(picture.id, reader.device(CoachPictureRow.key(picture.id)))
        return SentPicture(CoachAttachment(picture.id, row?.mediaType ?: picture.mediaType, row?.width ?: 0, row?.height ?: 0, row?.bytes?.toLong() ?: 0), row != null)
    }

    private fun <E : Entity<E>> decoded(type: EntityType<E>, records: Collection<Record>): List<E> = decoded(records, type::decode)

    // A record this build cannot read costs that record and never the conversation around it; the first one in a run is reported.
    private fun <T> decoded(records: Collection<Record>, decode: (Fields) -> T): List<T> = records.filter { it.isVisible }.mapNotNull { record ->
        try {
            decode(Fields(record))
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
internal class CoachRecordUnreadable : Exception("coach-record-unreadable")

private const val previewCodePoints = 240

private val dayFormat = DateTimeFormatter.ofPattern("MMM d")

private fun dayLabel(ms: Long): String = dayFormat.format(Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()))

// What a History row says of a message, off its record: a message's calls, receipt and pictures stay undecoded, since History reads every message on every revision.
private class MessageLine(f: Fields) {
    val id = Id(f.id, CoachMessage)
    val thread = f.ref("threadId", CoachThread)
    val coach = when (f.string("role")) {
        CoachMessage.Role.coach.name -> true
        CoachMessage.Role.lifter.name -> false
        else -> throw f.failure("role", "not a role")
    }
    val state = MessageState.entries.firstOrNull { it.name == f.string("state", MessageState.running.name) } ?: MessageState.running
    val at = f.instant("at")
    val text = f.string("text", "")
}

// The order `inOrder` gives the messages they stand for.
private val lineOrder = compareBy<MessageLine>({ it.at }, { it.coach }, { it.id })

private fun ConversationRow(thread: CoachThread, messages: List<MessageLine>): ConversationRow {
    val newest = messages.maxWithOrNull(lineOrder)
    val answer = messages.filter { it.coach && it.state == MessageState.completed && it.text.isNotBlank() }.maxWithOrNull(lineOrder)?.text.orEmpty()
    return ConversationRow(checkNotNull(thread.id.record.string) { "a thread's id is a string" }, thread.title, newest?.at?.ms ?: 0,
        answering = newest?.coach == true && newest.state == MessageState.running,
        answerPreview = answer.substring(0, answer.offsetByCodePoints(0, minOf(previewCodePoints, answer.codePointCount(0, answer.length)))))
}

// An answer earlier versions kept, as one exchange of its chat. Its saved routines come from the import's receipt, its drafts from the answer until then.
private fun CoachExchange(record: CoachOnboardingRecord, saved: CoachImportReceipt?): CoachExchange {
    val response = record.response
    val code = response?.errorCode ?: record.refusalCode
    val answered = response?.status == "completed"
    val routines = if (saved == null) emptyList() else saved.routines.zip(response?.routines.orEmpty()).mapNotNull { (id, routine) ->
        id.record.string?.let { CreatedRoutine(it, routine.name, routine.entries.size) }
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
