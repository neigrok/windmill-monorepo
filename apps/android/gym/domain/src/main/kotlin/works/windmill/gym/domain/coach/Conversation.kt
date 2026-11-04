package works.windmill.gym.domain.coach

import works.windmill.domain.kit.*
import works.windmill.gym.domain.sync.GymRefusal
import works.windmill.gym.domain.sync.RoutineRules
import works.windmill.gym.domain.sync.Session
import works.windmill.gym.domain.sync.TrainingSet
import works.windmill.sync.api.RecordRef
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.JsonError
import works.windmill.sync.core.MeasureUnit
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema

// A Coach conversation as the engine holds it (Coach §9): its records, the calls a turn ran, the receipt they derive, what a turn writes around them, and the reads over its messages.

data class CoachThread(override val id: Id<CoachThread>, val title: String) : Writable<CoachThread> {
    override fun fields(): Map<String, Json> = mapOf("title" to Json.of(title))

    companion object : WritableType<CoachThread>, RemovableType<CoachThread> {
        override val type = Gym.Types.thread
        override val scope = ScopeRef(Gym.scope)
        override val heldRemoval = false
        override fun decode(f: Fields) = CoachThread(Id(f.id, this), f.string("title", ""))
        override val checks = listOf(
            Check<CoachThread>("title") { thread, _ -> thread.copy(title = CoachRules.title.apply(thread.title, Path("title"))) },
        )
    }
}

// The registry's rank: a terminal state beats running, and a writer's terminal state beats another device's interrupted.
enum class MessageState(val rank: Int) {
    running(0), interrupted(1), completed(2), declined(2), failed(2), stopped(2);

    val isTerminal: Boolean get() = this != running
    val isWritersTerminal: Boolean get() = rank == 2
}

// A picture on a message: its id on the phone that sent it when `localOnly` (Coach §9.3).
data class Picture(val id: String, val mediaType: String, val localOnly: Boolean = false) : ValueObject<Picture> {
    override val json: Json get() = Json.Obj(buildList {
        add("id" to Json.of(id))
        add("mediaType" to Json.of(mediaType))
        if (localOnly) add("localOnly" to Json.of(true))
    })

    override fun validated(at: Path) = Picture(CoachRules.pictureId.apply(id, at + "id"), CoachRules.mediaType.apply(mediaType, at + "mediaType"), localOnly)

    companion object : ValueType<Picture> {
        override fun decode(f: Fields) = Picture(f.string("id"), f.string("mediaType"), f.bool("localOnly", false))
    }
}

data class CoachMessage(override val id: Id<CoachMessage>, val threadId: Id<CoachThread>, val role: Role, val replica: String? = null,
    val text: String = "", val state: MessageState = MessageState.running, val truncated: Boolean = false, val receipt: Json? = null,
    val calls: List<AbilityCall> = emptyList(), val pictures: List<Picture> = emptyList(), val at: Instant) : Writable<CoachMessage> {
    enum class Role { lifter, coach }

    // A lifter message carries its thread, role, text, pictures and moment only (Coach §9.1).
    override fun fields(): Map<String, Json> = buildMap {
        put("threadId", threadId.json)
        put("role", Json.of(role.name))
        put("at", Json.of(at.ms))
        put("text", Json.of(text))
        if (pictures.isNotEmpty()) put("pictures", Json.Arr(pictures.map { it.json }))
        if (role == Role.coach) {
            replica?.let { put("replica", Json.of(it)) }
            put("state", Json.of(state.name))
            put("truncated", Json.of(truncated))
            receipt?.let { put("receipt", it) }
            put("calls", Json.Arr(calls.map { it.json }))
        }
    }

    val callsBytes: Int get() = Json.Arr(calls.map { it.json }).jcs.encodeToByteArray().size

    // The log rows the message's calls already hold by identity.
    val heldReads: ReadServed get() = calls.filter { it.outcome == AbilityCall.Outcome.Ok }.fold(ReadServed.none) { held, call ->
        (call.read as? RecordedRead.Ids)?.let { held.saw(it.served) } ?: held
    }

    // Coach §9.2: the first form the calls bound holds: whole, less the rows earlier calls hold; without input; as counts alone; refused `coach-turn-volume`; or none.
    fun recorded(call: AbilityCall): AbilityCall? {
        val fresh = when (val read = call.read) {
            is RecordedRead.Ids -> call.copy(read = RecordedRead.Ids(read.served.without(heldReads)))
            is RecordedRead.Counts -> call
        }
        val forms = buildList {
            add(fresh)
            add(fresh.copy(input = null))
            val served = (fresh.read as? RecordedRead.Ids)?.served
            if (served != null && !served.isEmpty) add(fresh.copy(input = null, read = RecordedRead.Counts(served.tally)))
            add(AbilityCall(call.callId, call.name, null, AbilityCall.Outcome.Refused(AbilityRefusal.volume)))
        }
        return forms.firstOrNull { copy(calls = calls + it).callsBytes <= CoachRules.maxCallsBytes }
    }

    companion object : WritableType<CoachMessage>, RemovableType<CoachMessage> {
        override val type = Gym.Types.message
        override val scope = ScopeRef(Gym.scope)
        override val heldRemoval = false
        override fun decode(f: Fields): CoachMessage {
            val role = Role.entries.firstOrNull { it.name == f.string("role") } ?: throw DecodeError(type, "role", "not a role")
            val state = MessageState.entries.firstOrNull { it.name == f.string("state", MessageState.running.name) } ?: MessageState.running
            val calls = f.json("calls")?.orNull()?.let { recorded ->
                (recorded as? Json.Arr)?.values?.map(AbilityCall::decode) ?: throw DecodeError(type, "calls", "not an array")
            }
            return CoachMessage(Id(f.id, this), f.ref("threadId", CoachThread), role, f.optionalString("replica"), f.string("text", ""), state,
                f.bool("truncated", false), f.json("receipt")?.orNull(), calls ?: emptyList(), f.optionalList("pictures", Picture) ?: emptyList(), f.instant("at"))
        }
        override val checks = listOf(
            Check<CoachMessage>("role") { message, _ -> CoachRules.role.apply(message.role.name, Path("role")); message },
            Check<CoachMessage>("replica") { message, _ -> CoachRules.replica.applyOptional(message.replica, Path("replica")); message },
            Check<CoachMessage>("text") { message, _ -> message.copy(text = CoachRules.text.apply(message.text, Path("text"))) },
            Check<CoachMessage>("pictures") { message, _ -> CoachRules.pictures.apply(message.pictures, Path("pictures")); message },
            Check<CoachMessage>("receipt") { message, _ ->
                CoachRules.within(message.receipt ?: Json.Null, CoachRules.maxReceiptBytes, "message.receipt", Path("receipt"))
                message
            },
            Check<CoachMessage>("calls") { message, _ ->
                CoachRules.within(Json.Arr(message.calls.map { it.json }), CoachRules.maxCallsBytes, "message.calls", Path("calls"))
                message
            },
        )
    }
}

object CoachRules {
    const val maxQuestionBytes = 8_000
    const val maxReceiptBytes = 16_384
    const val maxCallsBytes = 32_768
    const val maxResultBytes = 16_384
    const val maxInputDepth = 32
    const val question = "message.question"
    val title = TextSpec("thread.title", MeasureUnit.bytes, 1, 8_000, trim = false, nfc = false)
    val role = ChoiceSpec("message.role", listOf("lifter", "coach"))
    val replica = TextSpec("message.replica", MeasureUnit.chars, 35, 35, trim = false, nfc = false)
    val text = TextSpec("message.text", MeasureUnit.bytes, 0, 131_072, trim = false, nfc = false)
    val pictures = CountSpec("message.pictures", 0, 1)
    val pictureId = TextSpec("message.pictures.id", MeasureUnit.chars, 8, 64, trim = false, nfc = false)
    val mediaType = TextSpec("message.pictures.mediaType", MeasureUnit.bytes, 1, 255, trim = false, nfc = false)

    // A book of its own: packages/api-contract/gym/domain/rules.json pins GymRules.book, which every gym implementation shares.
    val book = RuleBook(SyncSchema.registry, listOf(CoachThread, CoachMessage), listOf(
        Rule.local(title), Rule.local(role), Rule.local(replica), Rule.local(text), Rule.local(pictures), Rule.local(pictureId), Rule.local(mediaType),
        Rule.local("message.receipt", CoachMessage.type), Rule.local("message.calls", CoachMessage.type), Rule.local(question, CoachMessage.type),
    ))

    internal fun within(json: Json, bytes: Int, rule: String, at: Path) {
        val measured = json.jcs.encodeToByteArray().size
        if (measured > bytes) throw Violation(rule, at, Violation.Reason.TooLong(bytes, MeasureUnit.bytes, measured))
    }
}

// The codes a call the phone refused carries back (Coach §5, §6.4).
enum class AbilityRefusal(val code: String) {
    notOffered("not-offered"), seatRequired("seat-required"), invalidInput("invalid-input"), invalidArguments("invalid-arguments"),
    refused("refused"), loadFloor("load-floor"), resultTooLarge("result-too-large"), volume("coach-turn-volume");

    companion object {
        // What a rule refused, in the server tool's word: `load-floor` for a target below its movement's floor, `refused` for any other.
        fun of(refusal: GymRefusal): AbilityRefusal = if ((refusal as? GymRefusal.Invalid)?.violation?.rule == RoutineRules.loadFloor) loadFloor else refused
    }
}

// How many log rows a read served, as a result states it and a receipt sums it.
data class ReadTally(val sets: Int = 0, val sessions: Int = 0, val weeks: Int = 0) {
    val json: Json get() = Json.objectOf("sets" to Json.of(sets), "sessions" to Json.of(sessions), "weeks" to Json.of(weeks))
    operator fun plus(other: ReadTally) = ReadTally(sets + other.sets, sessions + other.sessions, weeks + other.weeks)

    companion object {
        fun decode(json: Json): ReadTally {
            val f = Fields(json)
            return ReadTally(f.int("sets"), f.int("sessions"), f.int("weeks"))
        }
    }
}

// The log rows a read handed to the model, by identity, and their weeks (Monday 00:00 UTC). Each `saw` answers a new value, its lists in order without repeats.
@ConsistentCopyVisibility
data class ReadServed private constructor(val sessions: List<Id<Session>>, val sets: List<Id<TrainingSet>>, val weeks: List<Long>) {
    fun saw(session: Session): ReadServed = copy(sessions = sessions.holding(session.id)).saw(week(session.startedAt))
    fun saw(set: TrainingSet): ReadServed = copy(sets = sets.holding(set.id)).saw(week(set.completedAt))
    fun saw(week: Long): ReadServed = copy(weeks = weeks.holding(week))

    fun saw(other: ReadServed): ReadServed = ReadServed(other.sessions.fold(sessions) { held, id -> held.holding(id) },
        other.sets.fold(sets) { held, id -> held.holding(id) }, other.weeks.fold(weeks) { held, week -> held.holding(week) })

    // The rows this read served that another did not.
    fun without(held: ReadServed): ReadServed = ReadServed(sessions - held.sessions.toSet(), sets - held.sets.toSet(), weeks - held.weeks.toSet())

    val isEmpty: Boolean get() = sessions.isEmpty() && sets.isEmpty() && weeks.isEmpty()
    val tally: ReadTally get() = ReadTally(sets.size, sessions.size, weeks.size)
    val json: Json get() = Json.objectOf("sessions" to Json.Arr(sessions.map { it.json }), "sets" to Json.Arr(sets.map { it.json }), "weeks" to Json.Arr(weeks.map { Json.of(it) }))

    private fun <T : Comparable<T>> List<T>.holding(item: T): List<T> {
        val found = binarySearch(item)
        if (found >= 0) return this
        val at = -found - 1
        return take(at) + item + drop(at)
    }

    companion object {
        private const val weekMs = 604_800_000L
        private const val epochToMonday = 259_200_000L
        val none = ReadServed(emptyList(), emptyList(), emptyList())

        // The epoch was a Thursday: the instant moves three days forward, floors to a week, and moves back.
        fun week(instant: Instant): Long {
            val shifted = instant.ms + epochToMonday
            val floored = if (shifted >= 0) shifted / weekMs else (shifted - weekMs + 1) / weekMs
            return maxOf(1L, floored * weekMs - epochToMonday)
        }

        fun decode(json: Json): ReadServed {
            val f = Fields(json)
            fun items(field: String) = (f.json(field) as? Json.Arr)?.values ?: throw DecodeError(CoachMessage.type, "calls.read.$field", "absent")
            fun ids(field: String) = items(field).map { item ->
                try { RecordID(item) } catch (_: JsonError) { throw DecodeError(CoachMessage.type, "calls.read.$field", "not an id") }
            }
            return ReadServed(ids("sessions").map { Id(it, Session) }, ids("sets").map { Id(it, TrainingSet) }, items("weeks").map { week ->
                try { week.long() } catch (_: JsonError) { throw DecodeError(CoachMessage.type, "calls.read.weeks", "not an integer") }
            })
        }
    }
}

// A call's record of the rows it served: their identities, or their counts alone when the calls had no room (`readTruncated`).
sealed interface RecordedRead {
    data class Ids(val served: ReadServed) : RecordedRead
    data class Counts(val tally: ReadTally) : RecordedRead
}

// One ability call as the Coach message records it (Coach §4.3 step 2).
data class AbilityCall(val callId: String, val name: String, val input: Json?, val outcome: Outcome, val created: List<RecordRef> = emptyList(),
    val read: RecordedRead = RecordedRead.Ids(ReadServed.none)) {
    sealed interface Outcome {
        data object Ok : Outcome
        data class Refused(val code: AbilityRefusal) : Outcome
    }

    val json: Json get() = Json.Obj(buildList {
        add("callId" to Json.of(callId))
        add("name" to Json.of(name))
        input?.let { add("input" to it) }
        add("outcome" to Json.of(when (outcome) { Outcome.Ok -> "ok"; is Outcome.Refused -> outcome.code.code }))
        add("created" to refs(created))
        when (read) {
            is RecordedRead.Ids -> add("read" to read.served.json)
            is RecordedRead.Counts -> { add("read" to read.tally.json); add("readTruncated" to Json.of(true)) }
        }
    })

    companion object {
        private fun refs(created: List<RecordRef>) = Json.Arr(created.map { Json.objectOf("t" to Json.of(it.type), "id" to it.id.json) })

        fun decode(json: Json): AbilityCall {
            val f = Fields(json)
            val outcome = f.string("outcome")
            val ended = if (outcome == "ok") Outcome.Ok else Outcome.Refused(AbilityRefusal.entries.firstOrNull { it.code == outcome } ?: AbilityRefusal.refused)
            val created = (f.json("created") as? Json.Arr)?.values ?: throw DecodeError(CoachMessage.type, "calls.created", "absent")
            val refs = created.map { item ->
                val ref = Fields(item)
                val id = try { RecordID(ref.json("id") ?: Json.Null) } catch (_: JsonError) { throw DecodeError(CoachMessage.type, "calls.created", "not an id") }
                RecordRef(ref.string("t"), id)
            }
            val read = f.json("read") ?: throw DecodeError(CoachMessage.type, "calls.read", "absent")
            val recorded = if (f.bool("readTruncated", false)) RecordedRead.Counts(ReadTally.decode(read)) else RecordedRead.Ids(ReadServed.decode(read))
            return AbilityCall(f.string("callId"), f.string("name"), f.json("input"), ended, refs, recorded)
        }

        // Coach §9.2: reads by identity across the calls, plus the calls held as counts (`truncated` then), and the ids created; a refused call counts nothing.
        fun receipt(calls: List<AbilityCall>): Json {
            var served = ReadServed.none
            var counted = ReadTally()
            var truncated = false
            val created = mutableListOf<RecordRef>()
            for (call in calls.filter { it.outcome == Outcome.Ok }) {
                when (val read = call.read) {
                    is RecordedRead.Ids -> served = served.saw(read.served)
                    is RecordedRead.Counts -> { counted += read.tally; truncated = true }
                }
                created += call.created.filter { it !in created }
            }
            return Json.Obj(buildList {
                add("read" to (served.tally + counted).json)
                add("results" to refs(created))
                if (truncated) add("truncated" to Json.of(true))
            })
        }
    }
}

// Coach §4.1 step 2: in one transaction, the lifter's message, the running Coach message, a new thread when none is named, and the `runningTurn` device row.
class OpenTurn(val thread: Id<CoachThread>? = null, val question: String, val pictures: List<Picture> = emptyList()) : Action<OpenTurn.Loaded, OpenTurn.Turn, GymRefusal> {
    data class Turn(val thread: Id<CoachThread>, val lifter: Id<CoachMessage>, val coach: Id<CoachMessage>)
    data class Loaded(val thread: CoachThread?, val replica: String, val moment: Moment)

    override val scope = CoachMessage.scope
    override val refusals = GymRefusal

    override fun load(read: Reader) = Loaded(thread?.let { read.repository(CoachThread).find(it, ViewMode.drawn) }, read.replica, read.moment)

    override fun decide(loaded: Loaded, ids: IDSource): Decision<Turn, GymRefusal> {
        if (thread != null && loaded.thread == null) return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.unknownRecord, thread.ref, path = Refused.Path.predicted)))
        val bytes = MeasureUnit.bytes.length(question)
        if (bytes > CoachRules.maxQuestionBytes) throw Violation(CoachRules.question, Path("text"), Violation.Reason.TooLong(CoachRules.maxQuestionBytes, MeasureUnit.bytes, bytes))
        val blank = TextSpec.isBlank(question)
        if (blank && pictures.isEmpty()) throw Violation(CoachRules.question, Path("text"), Violation.Reason.Blank)
        val plan = Plan()
        val threadId = thread ?: ids.mint(CoachThread)
        if (thread == null) plan.create(Valid(CoachThread(threadId, if (blank) "Photo" else question), CoachThread, at = loaded.moment))
        val turn = Turn(threadId, ids.mint(CoachMessage), ids.mint(CoachMessage))
        plan.create(Valid(CoachMessage(turn.lifter, threadId, CoachMessage.Role.lifter, text = question, pictures = pictures, at = loaded.moment.now), CoachMessage, at = loaded.moment))
        plan.create(Valid(CoachMessage(turn.coach, threadId, CoachMessage.Role.coach, replica = loaded.replica, at = loaded.moment.now), CoachMessage, at = loaded.moment))
        plan.device(EndTurn.runningTurnKey, turn.coach.json)
        return Decision.Write(plan, turn)
    }
}

// A question one gesture may ask twice, across a recreation or a process death: the finish share. Its key and the turn it opened commit in one transaction in a device row, so no death between them can open a second turn. The row remembers the newest such question; a withdrawn turn leaves no thread behind to find, and opens again.
class OpenTurnOnce(private val once: String, private val opening: OpenTurn) : Action<OpenTurnOnce.Loaded, OpenTurn.Turn, GymRefusal> {
    class Loaded(val opened: OpenTurn.Turn?, val inner: OpenTurn.Loaded)

    override val scope = opening.scope
    override val refusals = opening.refusals

    override fun load(read: Reader): Loaded {
        val row = read.device(key)?.takeIf { it["once"]?.str() == once }
        val turn = row?.let { OpenTurn.Turn(Id(RecordID(it.member("thread")), CoachThread), Id(RecordID(it.member("lifter")), CoachMessage), Id(RecordID(it.member("coach")), CoachMessage)) }
        return Loaded(turn?.takeIf { read.repository(CoachThread).find(it.thread, ViewMode.drawn) != null }, opening.load(read))
    }

    override fun decide(loaded: Loaded, ids: IDSource): Decision<OpenTurn.Turn, GymRefusal> {
        loaded.opened?.let { return Decision.Unchanged(it) }
        val decided = opening.decide(loaded.inner, ids)
        if (decided is Decision.Write) decided.plan.device(key, Json.objectOf("once" to Json.of(once), "thread" to decided.result.thread.json,
            "lifter" to decided.result.lifter.json, "coach" to decided.result.coach.json))
        return decided
    }

    companion object {
        const val key = "rack:coachOnceTurn"
    }
}

// Coach §4.4, §4.5: the terminal state, the answer and the receipt in one transaction, and `runningTurn` cleared unless it names another turn, as a merge's row can. A turn a writer already ended is final.
class EndTurn(val message: Id<CoachMessage>, val state: MessageState, val text: String? = null, val truncated: Boolean = false) : Action<EndTurn.Loaded, Unit, GymRefusal> {
    data class Loaded(val message: CoachMessage?, val moment: Moment, val named: Json?)

    init { require(state.isTerminal) { "a turn ends in a terminal state" } }

    override val scope = CoachMessage.scope
    override val refusals = GymRefusal

    override fun load(read: Reader) = Loaded(read.repository(CoachMessage).find(message, ViewMode.drawn), read.moment, read.device(runningTurnKey))

    override fun decide(loaded: Loaded, ids: IDSource): Decision<Unit, GymRefusal> {
        val running = loaded.message?.takeIf { it.role == CoachMessage.Role.coach }
            ?: return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.unknownRecord, message.ref, path = Refused.Path.predicted)))
        if (running.state.isWritersTerminal) return Decision.Unchanged(Unit)
        val ended = running.copy(state = state, text = text ?: running.text, truncated = truncated, receipt = AbilityCall.receipt(running.calls))
        val written = listOf("state", "text", "receipt", "truncated")
        val plan = Plan()
        plan.update(Valid(ended, CoachMessage, written, loaded.moment), written)
        if (loaded.named == null || loaded.named == message.json) plan.device(runningTurnKey, null)
        return Decision.Write(plan, Unit)
    }

    companion object {
        const val runningTurnKey = "runningTurn"
    }
}

// A turn whose message is gone, as a conversation deleted on another phone takes it: `runningTurn` lets go of it, and of no other.
class ForgetRunningTurn(val message: Id<CoachMessage>) : Action<Json?, Unit, GymRefusal> {
    override val scope = CoachMessage.scope
    override val refusals = GymRefusal

    override fun load(read: Reader) = read.device(EndTurn.runningTurnKey)

    override fun decide(loaded: Json?, ids: IDSource): Decision<Unit, GymRefusal> {
        if (loaded != message.json) return Decision.Unchanged(Unit)
        val plan = Plan()
        plan.device(EndTurn.runningTurnKey, null)
        return Decision.Write(plan, Unit)
    }
}

// A picture as this phone keeps it, in the `picture:<id>` device row: its metadata alone, the bytes in the app's files.
data class CoachPictureRow(val id: String, val mediaType: String, val width: Int, val height: Int, val bytes: Int) {
    val json: Json get() = Json.objectOf("mediaType" to Json.of(mediaType), "width" to Json.of(width), "height" to Json.of(height), "bytes" to Json.of(bytes))

    companion object {
        private const val prefix = "picture:"
        fun key(id: String): String = prefix + id

        fun decode(id: String, json: Json?): CoachPictureRow? {
            if (json == null) return null
            return try {
                val f = Fields(json)
                CoachPictureRow(id, f.string("mediaType"), f.int("width"), f.int("height"), f.int("bytes"))
            } catch (_: DecodeError) { null }
        }
    }
}

class KeepPicture(val picture: CoachPictureRow) : Action<Unit, Unit, GymRefusal> {
    override val scope = CoachMessage.scope
    override val refusals = GymRefusal

    override fun load(read: Reader) = Unit

    override fun decide(loaded: Unit, ids: IDSource): Decision<Unit, GymRefusal> {
        val plan = Plan()
        plan.device(CoachPictureRow.key(picture.id), picture.json)
        return Decision.Write(plan, Unit)
    }
}

// The row of a picture kept for a turn that did not open; the caller deletes its files.
class ForgetPicture(val id: String) : Action<Unit, Unit, GymRefusal> {
    override val scope = CoachMessage.scope
    override val refusals = GymRefusal

    override fun load(read: Reader) = Unit

    override fun decide(loaded: Unit, ids: IDSource): Decision<Unit, GymRefusal> {
        val plan = Plan()
        plan.device(CoachPictureRow.key(id), null)
        return Decision.Write(plan, Unit)
    }
}

// The rows no message claims: a conversation deleted on another phone, or a process that died between `KeepPicture` and `OpenTurn`. A replica behind its log cannot tell a message gone from one not yet arrived, so it forgets nothing.
class ForgetUnclaimedPictures : Action<ForgetUnclaimedPictures.Loaded, Unit, GymRefusal> {
    data class Loaded(val rows: Set<String>, val claimed: Set<String>)

    override val scope = CoachMessage.scope
    override val refusals = GymRefusal

    override fun load(read: Reader): Loaded {
        val rows = read.devices(CoachPictureRow.key("")).keys
        if (rows.isEmpty() || !read.caughtUpWithItsLog) return Loaded(emptySet(), emptySet())
        return Loaded(rows, read.repository(CoachMessage).all(ViewMode.drawn).flatMap { it.pictures }.map { CoachPictureRow.key(it.id) }.toSet())
    }

    override fun decide(loaded: Loaded, ids: IDSource): Decision<Unit, GymRefusal> {
        val unclaimed = loaded.rows - loaded.claimed
        if (unclaimed.isEmpty()) return Decision.Unchanged(Unit)
        val plan = Plan()
        unclaimed.forEach { plan.device(it, null) }
        return Decision.Write(plan, Unit)
    }
}

// Whether a record this replica lacks is truly gone, rather than not yet arrived.
val Reader.caughtUpWithItsLog: Boolean get() = isAnonymous || firstPullComplete() && checkpoint().cleanSeq != null

// The answer as it streams: this replica's running Coach message takes the text so far; a message that ended, or another replica's, takes nothing.
class StreamTurnText(val message: Id<CoachMessage>, val text: String) : Action<StreamTurnText.Loaded, Unit, GymRefusal> {
    data class Loaded(val message: CoachMessage?, val replica: String, val moment: Moment)

    override val scope = CoachMessage.scope
    override val refusals = GymRefusal

    override fun load(read: Reader) = Loaded(read.repository(CoachMessage).find(message, ViewMode.drawn), read.replica, read.moment)

    override fun decide(loaded: Loaded, ids: IDSource): Decision<Unit, GymRefusal> {
        val streaming = loaded.message?.takeIf { it.role == CoachMessage.Role.coach }
            ?: return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.unknownRecord, message.ref, path = Refused.Path.predicted)))
        if (streaming.state != MessageState.running || streaming.replica != loaded.replica || streaming.text == text) return Decision.Unchanged(Unit)
        val written = listOf("text")
        val plan = Plan()
        plan.update(Valid(streaming.copy(text = text), CoachMessage, written, loaded.moment), written)
        return Decision.Write(plan, Unit)
    }
}

// A turn the server refused before its stream never happened: its messages, its pictures, the thread when it stands and held nothing else, and `runningTurn` go. It answers the picture ids removed, for the caller to delete their files.
class WithdrawTurn(val turn: OpenTurn.Turn) : Action<WithdrawTurn.Loaded, List<String>, GymRefusal> {
    data class Loaded(val thread: CoachThread?, val messages: List<CoachMessage>)

    override val scope = CoachMessage.scope
    override val refusals = GymRefusal

    override fun load(read: Reader) = Loaded(read.repository(CoachThread).find(turn.thread, ViewMode.drawn),
        read.repository(CoachMessage).children(turn.thread, "threadId", ViewMode.stored))

    override fun decide(loaded: Loaded, ids: IDSource): Decision<List<String>, GymRefusal> {
        val withdrawn = loaded.messages.filter { it.id == turn.lifter || it.id == turn.coach }
        val plan = Plan()
        withdrawn.forEach { plan.remove(it.id) }
        val pictures = plan.forgetPictures(withdrawn)
        if (loaded.thread != null && withdrawn.size == loaded.messages.size) plan.remove(turn.thread)
        plan.device(EndTurn.runningTurnKey, null)
        return Decision.Write(plan, pictures)
    }
}

// A conversation deleted from History: the thread, its messages, their pictures, and `runningTurn` when it names one of them. It answers the picture ids removed, for the caller to delete their files.
class DeleteConversation(val thread: Id<CoachThread>) : Action<DeleteConversation.Loaded, List<String>, GymRefusal> {
    data class Loaded(val thread: CoachThread?, val messages: List<CoachMessage>, val running: Json?)

    override val scope = CoachMessage.scope
    override val refusals = GymRefusal

    override fun load(read: Reader) = Loaded(read.repository(CoachThread).find(thread, ViewMode.drawn),
        read.repository(CoachMessage).children(thread, "threadId", ViewMode.stored), read.device(EndTurn.runningTurnKey))

    override fun decide(loaded: Loaded, ids: IDSource): Decision<List<String>, GymRefusal> {
        if (loaded.thread == null) return Decision.Unchanged(emptyList())
        val plan = Plan()
        plan.remove(thread)
        loaded.messages.forEach { plan.remove(it.id) }
        val pictures = plan.forgetPictures(loaded.messages)
        if (loaded.messages.any { it.id.json == loaded.running }) plan.device(EndTurn.runningTurnKey, null)
        return Decision.Write(plan, pictures)
    }
}

private fun Plan.forgetPictures(messages: List<CoachMessage>): List<String> {
    val pictures = messages.flatMap { it.pictures }.filter { it.localOnly }.map { it.id }
    pictures.forEach { device(CoachPictureRow.key(it), null) }
    return pictures
}

// A conversation's messages in the order they were said: by moment, the lifter before the Coach, then by id.
val List<CoachMessage>.inOrder: List<CoachMessage>
    get() = sortedWith(compareBy({ it.at }, { it.role == CoachMessage.Role.coach }, { it.id }))

// Coach §4.1 step 4: the messages of the newest completed turns within the bounds, oldest first; the turn being opened is not among them.
fun List<CoachMessage>.history(before: Id<CoachMessage>, turns: Int = CoachTurnBounds.contextTurns, bytes: Int = CoachTurnBounds.contextBytes): List<CoachMessage> {
    val ordered = inOrder
    val newestFirst = mutableListOf<List<CoachMessage>>()
    var used = 0
    for (index in ordered.indices.reversed()) {
        val answer = ordered[index]
        if (answer.role != CoachMessage.Role.coach || answer.id == before || answer.state != MessageState.completed || index == 0) continue
        val question = ordered[index - 1]
        if (question.role != CoachMessage.Role.lifter) continue
        val cost = MeasureUnit.bytes.length(question.text) + MeasureUnit.bytes.length(answer.text)
        if (newestFirst.size >= turns || used + cost > bytes) break
        newestFirst.add(listOf(question, answer))
        used += cost
    }
    return newestFirst.reversed().flatten()
}

// Coach §4.1 step 5: the pictures of the lifter message being sent and of the one before it, newest first.
fun List<CoachMessage>.contextPictures(sending: Id<CoachMessage>, limit: Int = CoachTurnBounds.contextPictures): List<Picture> {
    val questions = inOrder.filter { it.role == CoachMessage.Role.lifter }
    val at = questions.indexOfLast { it.id == sending }
    if (at < 0) return emptyList()
    return listOfNotNull(questions[at], questions.getOrNull(at - 1)).flatMap { it.pictures }.take(limit)
}

object CoachTurnBounds {
    const val contextTurns = 24
    const val contextBytes = 24_000
    const val contextPictures = 2
    const val contextReadBytes = 64 * 1024
    const val modelPictureEdge = 1568
    const val modelPictureBytes = 1024 * 1024
    val contextReads = listOf("list_sessions", "list_notes", "list_exercises", "list_routines")
}
