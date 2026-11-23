package works.windmill.gym.domain.coach

import works.windmill.domain.kit.*
import works.windmill.gym.domain.sync.Exercise
import works.windmill.gym.domain.sync.ExerciseRules
import works.windmill.gym.domain.sync.GymRefusal
import works.windmill.gym.domain.sync.Note
import works.windmill.gym.domain.sync.NoteRules
import works.windmill.gym.domain.sync.Proposal
import works.windmill.gym.domain.sync.ProposeRoutine
import works.windmill.gym.domain.sync.ProposeWorkout
import works.windmill.gym.domain.sync.Routine
import works.windmill.gym.domain.sync.RoutineEntry
import works.windmill.gym.domain.sync.RoutineRules
import works.windmill.gym.domain.sync.Session
import works.windmill.gym.domain.sync.SessionRules
import works.windmill.gym.domain.sync.WorkoutProposal
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.JsonError
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.core.SeededId
import works.windmill.sync.core.Sha256
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema

// The replica executor (Coach engine D-6, gym Coach on the AI service §4.2): one ability call of a turn, run on this phone's replica as one gesture that re-checks the call's shape and bounds, commits the ability's writes and records the call on the Coach message, or, when the call is refused, records the refusal alone.

// One call as the model made it: its id, the ability's name and the input, in the model's own words.
data class AbilityRequest(val callId: String, val name: String, val input: Json) {
    companion object {
        // gym Coach G-7: the abilities that create a record, and the type each creates. The turn names the record, never the model (`RunAbility.ordinal`).
        val creates: Map<String, EntityType<*>> = mapOf("create_routine" to Routine, "create_exercise" to Exercise, "save_note" to Note,
            "propose_routine_change" to Proposal, "propose_routine_removal" to Proposal, "propose_workout_change" to WorkoutProposal)
    }
}

// What the phone posts for a call (Coach §6.4): the result's canonical bytes with their digest, or the code it refused with.
sealed interface AbilityOutcome {
    class Result(val jcs: ByteArray, val sha256: String) : AbilityOutcome {
        constructor(jcs: ByteArray) : this(jcs, Sha256.hex(jcs))
        override fun equals(other: Any?): Boolean = other is Result && sha256 == other.sha256
        override fun hashCode(): Int = sha256.hashCode()
    }
    data class Refused(val code: AbilityRefusal) : AbilityOutcome
}

// Any ability as a decider the run composes, erased to its load, which answers the decision left to make over what it loaded.
class AbilityRun<L>(private val decider: Decider<L, AbilityAnswer, GymRefusal>) {
    fun load(read: Reader): (IDSource) -> Decision<AbilityAnswer, GymRefusal> {
        val loaded = decider.load(read)
        return { ids -> decider.decision(loaded, ids) }
    }
}

// The call's outcome, committed with its record on the Coach message. A refusal of the action itself means the message is not this replica's Coach message while its writer answers it, so nothing was recorded and the turn is over.
class RunAbility(val request: AbilityRequest, val message: Id<CoachMessage>, seat: Seat, catalog: Catalog, private val appBaseUrl: String) : Action<RunAbility.Loaded, AbilityOutcome, GymRefusal> {
    data class Loaded(val message: CoachMessage?, val own: Boolean, val gate: Gate?, val deciding: ((IDSource) -> Decision<AbilityAnswer, GymRefusal>)?, val moment: Moment)

    // The admitted call as the ability reads it, its new record named from the turn: run, or refused before any rule reads the store, recording the input it holds unless it is nested past what a record can hold.
    sealed interface Gate {
        val request: AbilityRequest
        data class Run(override val request: AbilityRequest, val ability: AbilityRun<*>) : Gate
        data class Refuse(override val request: AbilityRequest, val code: AbilityRefusal, val recorded: Json?) : Gate
    }

    private val admission = admit(request, seat, catalog)

    override val scope = CoachMessage.scope
    override val refusals = GymRefusal

    override fun load(read: Reader): Loaded {
        val coach = read.repository(CoachMessage).find(message, ViewMode.drawn)
        val own = coach?.writersOwn(read.replica, Mark.read(read)) == true
        val gate = if (own && admission == null) gate(coach!!) else null
        return Loaded(coach, own, gate, (gate as? Gate.Run)?.ability?.load(read), read.moment)
    }

    override fun decide(loaded: Loaded, ids: IDSource): Decision<AbilityOutcome, GymRefusal> {
        val coach = loaded.message?.takeIf { it.role == CoachMessage.Role.coach }
            ?: return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.unknownRecord, message.ref, path = Refused.Path.predicted)))
        if (!loaded.own) return Decision.Refuse(GymRefusal.predicted(Gym.Codes.messageFinal, message.ref))
        return when (val gate = loaded.gate) {
            null -> refusing(request, checkNotNull(admission), null, coach, loaded.moment)
            is Gate.Refuse -> refusing(gate.request, gate.code, gate.recorded, coach, loaded.moment)
            is Gate.Run -> when (val decided = checkNotNull(loaded.deciding) { "an admitted call loaded nothing" }(ids)) {
                is Decision.Refuse -> refusing(gate.request, AbilityRefusal.of(decided.refusal), gate.request.input, coach, loaded.moment)
                is Decision.Unchanged -> answering(gate.request, decided.result, Plan(), coach, loaded.moment)
                is Decision.Write -> answering(gate.request, decided.result, decided.plan, coach, loaded.moment)
            }
        }
    }

    // The admitted call's input as the ability reads it: the record it mints named from the turn, then the bounds the schema cannot state, the depth a record can hold, and the ability's decider from that input.
    private fun gate(turn: CoachMessage): Gate {
        val type = AbilityRequest.creates[request.name]
        val seeded = if (type == null) request else request.copy(input = Json.Obj(request.input.obj().toList().filter { it.first != "id" } +
            ("id" to Json.of(SeededId.make(turn.id.record.string!!, ordinal(turn, request.callId).toLong(), SyncSchema.registry.type(type.type)!!).id))))
        if (seeded.input.depth > CoachRules.maxInputDepth) return Gate.Refuse(seeded, AbilityRefusal.invalidArguments, null)
        if (argumentBounds[seeded.name]?.fault(seeded.input) != null) return Gate.Refuse(seeded, AbilityRefusal.invalidArguments, seeded.input)
        return try { Gate.Run(seeded, decider(seeded, appBaseUrl)) }
        catch (_: DecodeError) { Gate.Refuse(seeded, AbilityRefusal.invalidArguments, seeded.input) }
        catch (_: JsonError) { Gate.Refuse(seeded, AbilityRefusal.invalidArguments, seeded.input) }
    }

    private fun refusing(request: AbilityRequest, code: AbilityRefusal, input: Json?, coach: CoachMessage, moment: Moment): Decision<AbilityOutcome, GymRefusal> =
        recording(AbilityCall(request.callId, request.name, input, AbilityCall.Outcome.Refused(code)), AbilityOutcome.Refused(code), Plan(), coach, moment)

    // gym Coach §4.2: the result as the model reads it, with the tally of what the call served when it served anything, measured before anything commits; past `TOOL_RESULT_BYTES` the call is refused `result-too-large`, its writes dropped, so no result the turn cannot send is ever written.
    private fun answering(request: AbilityRequest, answer: AbilityAnswer, plan: Plan, coach: CoachMessage, moment: Moment): Decision<AbilityOutcome, GymRefusal> {
        val payload = answer.payload
        val tallied = if (!answer.served.isEmpty && payload is Json.Obj) Json.Obj((payload.members + ("read" to answer.served.tally.json)).toList()) else payload
        val bytes = tallied.jcs.encodeToByteArray()
        if (bytes.size > CoachRules.maxResultBytes) return refusing(request, AbilityRefusal.resultTooLarge, request.input, coach, moment)
        val call = AbilityCall(request.callId, request.name, request.input, AbilityCall.Outcome.Ok, answer.created, RecordedRead.Ids(answer.served))
        return recording(call, AbilityOutcome.Result(bytes), plan, coach, moment)
    }

    companion object {
        // Shares are server records: the host calls the Share door for them, and never sends one here (§4.3).
        val serverRun = setOf("share_session", "share_log", "revoke_share")

        // The bounds a provider's strict mode cannot state (gym Coach on the AI service §3, R-11), held by each ability's rule and refused `invalid-arguments` before any rule reads the store: the shapes `catalog/2` stated, in its own words.
        private val argumentBounds: Map<String, JsonSchema> = run {
            val lines = """{"maxItems": 50, "items": {"properties": {"restSeconds": {"minimum": 15, "maximum": 900}, "sets": {"maxItems": 20, "items": {"properties": {"reps": {"minimum": 1, "maximum": 100}}}}}}}"""
            val ids = """{"maxItems": 50, "uniqueItems": true, "items": {"maxLength": 128}}"""
            val position = RoutineRules.position
            mapOf(
                "list_sessions" to """{"properties": {"before": {"minimum": 1, "maximum": ${SessionRules.maxInstantMs}}, "limit": {"minimum": 1, "maximum": ${LogRead.maxPage}}}}""",
                "get_sessions" to """{"properties": {"sessionIds": $ids}}""",
                "get_last_times" to """{"properties": {"exerciseIds": $ids}}""",
                "create_exercise" to """{"properties": {"name": {"maxLength": 240}}}""",
                "create_routine" to """{"properties": {"entries": $lines, "name": {"maxLength": 240}, "position": {"minimum": ${position.min!!.toLong()}, "maximum": ${position.max!!.toLong()}}}}""",
                "propose_routine_change" to """{"properties": {"entries": $lines, "name": {"maxLength": 240}, "summary": {"maxLength": 400}}}""",
                "propose_routine_removal" to """{"properties": {"summary": {"maxLength": 400}}}""",
                "propose_workout_change" to """{"properties": {"entries": $lines, "summary": {"maxLength": 400}}}""",
            ).mapValues { JsonSchema(Json.parse(it.value)) }
        }

        // gym Coach §5 on the device: G-1 offered, G-2 the seat, the server's own abilities, G-3 the shape at every depth. The code it refuses with, or null for a call the gate admits.
        fun admit(request: AbilityRequest, seat: Seat, catalog: Catalog): AbilityRefusal? {
            val ability = catalog.ability(request.name)
            if (ability == null || ability.agent == AgentRule.withheld || !ability.declared || request.name in serverRun) return AbilityRefusal.notOffered
            if (!ability.admits(seat)) return AbilityRefusal.seatRequired
            if (JsonSchema(ability.input).fault(request.input) != null) return AbilityRefusal.invalidInput
            return null
        }

        // gym Coach G-7, as the server's gate seeds: every admitted call that mints a record takes the next turn-wide ordinal, whatever its outcome, so a call refused by its rule still holds its number. A call run again under its `callId` keeps the place an admitted first run holds, and with it its ordinal; one whose first run the gate refused takes the next.
        fun ordinal(turn: CoachMessage, callId: String): Int {
            val slot = turn.calls.indexOfFirst { it.callId == callId && it.admitted }
            val before = if (slot < 0) turn.calls.filter { it.callId != callId } else turn.calls.take(slot)
            return 1 + before.count { it.name in AbilityRequest.creates && it.admitted }
        }

        private fun decider(request: AbilityRequest, appBaseUrl: String): AbilityRun<*> {
            val f = Fields(request.input)
            return when (request.name) {
                "list_routines" -> AbilityRun(ProgramRead(f.optionalRef("routineId", Routine)))
                "list_exercises" -> AbilityRun(CatalogueRead())
                "list_sessions" -> {
                    val beforeId = f.optionalString("beforeId")
                    if (beforeId != null && f.isAbsent("before")) throw DecodeError("list_sessions", "beforeId", "without before")
                    AbilityRun(LogRead(LogRead.Query.Sessions(f.optionalInstant("before") ?: Instant(SessionRules.maxInstantMs), beforeId ?: "",
                        minOf(LogRead.maxPage, f.optionalInt("limit") ?: LogRead.defaultPage))))
                }
                "get_session" -> AbilityRun(LogRead(LogRead.Query.Workout(f.ref("sessionId", Session), f.bool("review", false))))
                "get_sessions" -> AbilityRun(LogRead(LogRead.Query.Workouts(f.present("sessionIds").arr().map { Id(RecordID(it.str()), Session) }, f.bool("review", false))))
                "last_time" -> AbilityRun(LogRead(LogRead.Query.LastTimeOf(f.ref("exerciseId", Exercise))))
                "get_last_times" -> AbilityRun(LogRead(LogRead.Query.LastTimesOf(f.present("exerciseIds").arr().map { Id(RecordID(it.str()), Exercise) })))
                "get_stats" -> AbilityRun(LogRead(LogRead.Query.Stats(f.optionalRef("exerciseId", Exercise))))
                "list_notes" -> AbilityRun(NotesRead())
                "list_bodyweight" -> AbilityRun(BodyweightRead(f.optionalString("from"), f.optionalString("to")))
                "create_routine" -> AbilityRun(CreateRoutineCall(Routine(given("id", f, Routine), f.string("name"), f.int("position"), f.list("entries", RoutineEntry))))
                "create_exercise" -> {
                    val equipment = f.string("equipment")
                    AbilityRun(CreateExerciseCall(Exercise(given("id", f, Exercise), f.string("name"), f.string("pattern"), equipment,
                        f.optionalDouble("stepKg") ?: ExerciseRules.defaultStepKg(equipment))))
                }
                "save_note" -> {
                    // The server's note bounds (backend Note.cpp, its tool's `invalid-arguments`): a blank title, a title past 60 code points or a body past 500 UTF-8 bytes, both measured after the trim, the same measures NoteRules keep. What the store refuses beyond them (ten notes, a taken id) stays `refused`.
                    val note = Note(given("id", f, Note), f.string("title"), f.string("body"))
                    try {
                        NoteRules.title.apply(note.title, Path("title"))
                        NoteRules.body.apply(note.body, Path("body"))
                    } catch (violation: Violation) { throw DecodeError(Note.type, violation.path.text, "past the note's bounds") }
                    AbilityRun(SaveNoteAbility(note))
                }
                "propose_routine_change" -> AbilityRun(ProposeRoutineCall(ProposeRoutine(given("id", f, Proposal), f.ref("routineId", Routine), f.optionalString("name"),
                    f.list("entries", RoutineEntry), f.string("summary", "")), appBaseUrl))
                "propose_routine_removal" -> AbilityRun(ProposeRoutineCall(ProposeRoutine(given("id", f, Proposal), f.ref("routineId", Routine), null, emptyList(),
                    f.string("summary", ""), removing = true), appBaseUrl))
                "propose_workout_change" -> AbilityRun(ProposeWorkoutCall(ProposeWorkout(given("id", f, WorkoutProposal), f.ref("sessionId", Session),
                    f.list("entries", RoutineEntry), f.string("summary", ""))))
                else -> throw DecodeError(request.name, "name", "no replica ability")
            }
        }

        // Coach G-7, kit §4 "given": the id the turn minted for the call's new record, in the shape the registry admits.
        private fun <E : Entity<E>> given(field: String, f: Fields, type: EntityType<E>): Id<E> {
            val id = f.string(field)
            if (SyncSchema.registry.type(type.type)?.idPattern?.matches(id) != true) throw DecodeError(type.type, field, "not an id the registry admits")
            return Id(id, type)
        }
    }
}

// A call on the Coach message, in the same gesture as the ability's writes (kit §9.3), in the fullest form the message's calls hold (`CoachMessage.recorded`): refused `coach-turn-volume`, writes dropped, when only a bare record fits the bound; and refused unrecorded, as the message's own bound, when not even that fits. Calls hold no U+0000, so an input that does records without itself. A call run again under a `callId` the message already holds keeps one record: this run's, holding every id either run created, in the first's place when the gate admitted the first, and last otherwise, as its ordinal stands. A first record that answered stands when this run was refused, and one the gate admitted stands when this run's was not, so no admitted call ever gives up its ordinal.
internal fun recording(call: AbilityCall, outcome: AbilityOutcome, plan: Plan, coach: CoachMessage, moment: Moment): Decision<AbilityOutcome, GymRefusal> {
    val found = coach.calls.indexOfFirst { it.callId == call.callId }
    val prior = coach.calls.getOrNull(found)
    val answered = prior?.outcome == AbilityCall.Outcome.Ok
    if (answered && call.outcome != AbilityCall.Outcome.Ok || prior != null && prior.admitted && !call.admitted) return Decision.Unchanged(outcome)
    val first = if (prior != null && prior.admitted) found else -1
    val others = coach.calls.filterIndexed { index, _ -> index != found }
    val whole = call.copy(created = (prior?.created.orEmpty() + call.created).distinct())
    val storable = if (whole.input?.firstNul(Path("input")) == null) whole else whole.copy(input = null)
    val recorded = coach.copy(calls = others).recorded(storable)
        ?: return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.tooLarge, coach.id.ref, path = Refused.Path.predicted)))
    val fits = recorded.outcome == storable.outcome
    if (answered && !fits) return Decision.Unchanged(AbilityOutcome.Refused(AbilityRefusal.volume))
    val calls = if (first < 0) others + recorded else others.take(first) + recorded + others.drop(first)
    if (calls == coach.calls && plan.operations.isEmpty()) return Decision.Unchanged(outcome)
    val written = if (fits) plan else Plan()
    written.update(Valid(coach.copy(calls = calls), CoachMessage, listOf("calls"), moment), listOf("calls"))
    return Decision.Write(written, if (fits) outcome else AbilityOutcome.Refused(AbilityRefusal.volume))
}

// A share the host ran through the Share door (gym Coach on the AI service §4.3), recorded on the Coach message as the executor records a call: the door made the server's record, so the call creates none here.
class RecordShareCall(val request: AbilityRequest, val message: Id<CoachMessage>, val outcome: AbilityOutcome) : Action<RecordShareCall.Loaded, AbilityOutcome, GymRefusal> {
    data class Loaded(val message: CoachMessage?, val replica: String, val moment: Moment, val mark: Mark)

    init { require(request.name in RunAbility.serverRun) { "only a share runs through the door" } }

    override val scope = CoachMessage.scope
    override val refusals = GymRefusal

    override fun load(read: Reader) = Loaded(read.repository(CoachMessage).find(message, ViewMode.drawn), read.replica, read.moment, Mark.read(read))

    override fun decide(loaded: Loaded, ids: IDSource): Decision<AbilityOutcome, GymRefusal> {
        val coach = loaded.message?.takeIf { it.role == CoachMessage.Role.coach }
            ?: return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.unknownRecord, message.ref, path = Refused.Path.predicted)))
        if (!coach.writersOwn(loaded.replica, loaded.mark)) return Decision.Refuse(GymRefusal.predicted(Gym.Codes.messageFinal, message.ref))
        val ended = when (outcome) {
            is AbilityOutcome.Result -> AbilityCall.Outcome.Ok
            is AbilityOutcome.Refused -> AbilityCall.Outcome.Refused(outcome.code)
        }
        return recording(AbilityCall(request.callId, request.name, request.input, ended), outcome, Plan(), coach, loaded.moment)
    }
}
