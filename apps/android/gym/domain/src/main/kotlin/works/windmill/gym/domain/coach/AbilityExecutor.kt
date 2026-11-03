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
import works.windmill.gym.domain.sync.Session
import works.windmill.gym.domain.sync.SessionRules
import works.windmill.gym.domain.sync.WorkoutProposal
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.JsonError
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.core.Sha256
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema

// The replica executor (Coach D-6, §4.3 step 2): one ability call of a turn, run on this phone's replica as one gesture that re-checks the call's shape, commits the ability's writes and records the call on the Coach message, or, when the call is refused, records the refusal alone.

data class AbilityRequest(val callId: String, val name: String, val input: Json)

// What the phone posts for a call (Coach §6.4): the result's canonical bytes with their digest, or the code it refused with.
sealed interface AbilityOutcome {
    class Result(val jcs: ByteArray, val sha256: String) : AbilityOutcome {
        constructor(jcs: ByteArray) : this(jcs, Sha256.hex(jcs))
        override fun equals(other: Any?): Boolean = other is Result && sha256 == other.sha256
        override fun hashCode(): Int = sha256.hashCode()
    }
    data class Refused(val code: AbilityRefusal) : AbilityOutcome
}

class AbilityExecutor(private val runner: ActionRunner, private val catalog: Catalog, private val appBaseUrl: String) {
    // The call's outcome, committed with its record on the Coach message; a refusal here means the message is not a running Coach message of this replica, so nothing was recorded and the turn is over.
    fun run(request: AbilityRequest, on: Id<CoachMessage>, seat: Seat): Outcome<AbilityOutcome, GymRefusal> =
        runner.run(RunAbility(request, on, seat, catalog, appBaseUrl))

    companion object {
        // Shares are server records; a phone turn's gate runs them on the server executor and never sends them here.
        val serverRun = setOf("share_session", "share_log", "revoke_share")
    }
}

// Any ability as a decider the run composes, erased to its load, which answers the decision left to make over what it loaded.
class AbilityRun<L>(private val decider: Decider<L, AbilityAnswer, GymRefusal>) {
    fun load(read: Reader): (IDSource) -> Decision<AbilityAnswer, GymRefusal> {
        val loaded = decider.load(read)
        return { ids -> decider.decision(loaded, ids) }
    }
}

class RunAbility(val request: AbilityRequest, val message: Id<CoachMessage>, seat: Seat, catalog: Catalog, appBaseUrl: String) : Action<RunAbility.Loaded, AbilityOutcome, GymRefusal> {
    data class Loaded(val message: CoachMessage?, val deciding: ((IDSource) -> Decision<AbilityAnswer, GymRefusal>)?, val moment: Moment)

    private sealed interface Gate {
        data class Run(val ability: AbilityRun<*>) : Gate
        data class Refuse(val code: AbilityRefusal) : Gate
    }

    private val gate = gate(request, seat, catalog, appBaseUrl)

    override val scope = CoachMessage.scope
    override val refusals = GymRefusal

    override fun load(read: Reader): Loaded {
        val coach = read.repository(CoachMessage).find(message, ViewMode.drawn)
        val running = coach?.role == CoachMessage.Role.coach && coach.state == MessageState.running
        return Loaded(coach, if (running && gate is Gate.Run) gate.ability.load(read) else null, read.moment)
    }

    override fun decide(loaded: Loaded, ids: IDSource): Decision<AbilityOutcome, GymRefusal> {
        val coach = loaded.message?.takeIf { it.role == CoachMessage.Role.coach }
            ?: return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.unknownRecord, message.ref, path = Refused.Path.predicted)))
        if (coach.state != MessageState.running) return Decision.Refuse(GymRefusal.predicted(Gym.Codes.messageFinal, message.ref))
        return when (gate) {
            is Gate.Refuse -> refusing(gate.code, null, coach, loaded.moment)
            is Gate.Run -> {
                val deciding = checkNotNull(loaded.deciding) { "an admitted call loaded nothing" }
                when (val decided = deciding(ids)) {
                    is Decision.Refuse -> refusing(AbilityRefusal.refused, request.input, coach, loaded.moment)
                    is Decision.Unchanged -> answering(decided.result, Plan(), coach, loaded.moment)
                    is Decision.Write -> answering(decided.result, decided.plan, coach, loaded.moment)
                }
            }
        }
    }

    private fun refusing(code: AbilityRefusal, input: Json?, coach: CoachMessage, moment: Moment): Decision<AbilityOutcome, GymRefusal> =
        recording(AbilityCall(request.callId, request.name, input, AbilityCall.Outcome.Refused(code)), AbilityOutcome.Refused(code), Plan(), coach, moment)

    // Coach §4.3 step 2, §6.4: the result as the server answers it, with the tally of what the call served when it served anything, measured before anything commits; past `TOOL_RESULT_BYTES` the call is refused `result-too-large`, its writes dropped, so no result the phone cannot send is ever written.
    private fun answering(answer: AbilityAnswer, plan: Plan, coach: CoachMessage, moment: Moment): Decision<AbilityOutcome, GymRefusal> {
        val payload = answer.payload
        val tallied = if (!answer.served.isEmpty && payload is Json.Obj) Json.Obj((payload.members + ("read" to answer.served.tally.json)).toList()) else payload
        val bytes = tallied.jcs.encodeToByteArray()
        if (bytes.size > CoachRules.maxResultBytes) return refusing(AbilityRefusal.resultTooLarge, request.input, coach, moment)
        val call = AbilityCall(request.callId, request.name, request.input, AbilityCall.Outcome.Ok, answer.created, RecordedRead.Ids(answer.served))
        return recording(call, AbilityOutcome.Result(bytes), plan, coach, moment)
    }

    // The call on the Coach message, in the same gesture as the ability's writes (kit §9.3), in the fullest form the message's calls hold (`CoachMessage.recorded`): refused `coach-turn-volume`, writes dropped, when only a bare record fits the bound; and refused unrecorded, as the message's own bound, when not even that fits. Calls hold no U+0000, so an input that does records without itself.
    // A call re-run under a `callId` the message already holds keeps one record: a first record that answered stands, whatever this run still writes landing under it, and a refused one gives way to this one in its place.
    private fun recording(call: AbilityCall, outcome: AbilityOutcome, plan: Plan, coach: CoachMessage, moment: Moment): Decision<AbilityOutcome, GymRefusal> {
        val first = coach.calls.indexOfFirst { it.callId == call.callId }
        if (coach.calls.getOrNull(first)?.outcome == AbilityCall.Outcome.Ok) return if (plan.operations.isEmpty()) Decision.Unchanged(outcome) else Decision.Write(plan, outcome)
        val others = coach.calls.filterIndexed { index, _ -> index != first }
        val storable = if (call.input?.firstNul(Path("input")) == null) call else call.copy(input = null)
        val recorded = coach.copy(calls = others).recorded(storable)
            ?: return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.tooLarge, coach.id.ref, path = Refused.Path.predicted)))
        val fits = recorded.outcome == storable.outcome
        val written = if (fits) plan else Plan()
        val calls = if (first < 0) others + recorded else others.take(first) + recorded + others.drop(first)
        written.update(Valid(coach.copy(calls = calls), CoachMessage, listOf("calls"), moment), listOf("calls"))
        return Decision.Write(written, if (fits) outcome else AbilityOutcome.Refused(AbilityRefusal.volume))
    }

    private companion object {
        // Coach §5 on the phone: G-1 offered, G-2 the seat, the server's own abilities, G-3 the shape at every depth, then the ability's decider from its input. Three codes for a call its input sinks, the server's own: the gate's G-3 shape check refuses `invalid-input`; an input past a bound the schema does not state, which the server's tool refuses as malformed, is `invalid-arguments`; what a rule refuses in deciding is `refused`.
        fun gate(request: AbilityRequest, seat: Seat, catalog: Catalog, appBaseUrl: String): Gate {
            val ability = catalog.ability(request.name)
            if (ability == null || ability.agent == AgentRule.withheld || !ability.declared || request.name in AbilityExecutor.serverRun) return Gate.Refuse(AbilityRefusal.notOffered)
            if (!ability.admits(seat)) return Gate.Refuse(AbilityRefusal.seatRequired)
            if (JsonSchema(ability.input).fault(request.input) != null) return Gate.Refuse(AbilityRefusal.invalidInput)
            return try { Gate.Run(decider(request, appBaseUrl)) }
            catch (_: DecodeError) { Gate.Refuse(AbilityRefusal.invalidArguments) }
            catch (_: JsonError) { Gate.Refuse(AbilityRefusal.invalidArguments) }
        }

        fun decider(request: AbilityRequest, appBaseUrl: String): AbilityRun<*> {
            val f = Fields(request.input)
            return when (request.name) {
                "list_routines" -> AbilityRun(ProgramRead(f.optionalRef("routineId", Routine)))
                "list_exercises" -> AbilityRun(CatalogueRead())
                "list_sessions" -> {
                    val beforeId = f.optionalString("beforeId")
                    if (beforeId != null && f.json("before") == null) throw DecodeError("list_sessions", "beforeId", "without before")
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
        fun <E : Entity<E>> given(field: String, f: Fields, type: EntityType<E>): Id<E> {
            val id = f.string(field)
            if (SyncSchema.registry.type(type.type)?.idPattern?.matches(id) != true) throw DecodeError(type.type, field, "not an id the registry admits")
            return Id(id, type)
        }
    }
}
