package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.api.QueuedCommand
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.schema.Gym

// A workout logged signed out and saved on this phone for the account, under the device key `rack:adoption`: its
// session and the sets it holds, in the order performed.
class SignedOutWorkout(session: Session, sets: List<TrainingSet>) {
    val session: Session = session
    val sets: List<TrainingSet> = sets.filter { it.sessionId == session.id }.sortedWith(compareBy({ it.completedAt }, { it.id }))

    val json: Json get() {
        fun row(id: Id<*>, fields: Map<String, Json>) = Json.Obj(listOf("id" to id.json) + fields.toList())
        return Json.objectOf("session" to row(session.id, session.fields()), "sets" to Json.Arr(sets.map { row(it.id, it.fields()) }))
    }
    val importAction: ImportSession get() = ImportSession(session.id, session.startedAt, session.finishedAt ?: SessionRules.lastActivity(session, sets),
        sets.map { ImportedSet(it.id, it.exerciseId, it.weightKg, it.reps, it.completedAt, it.kind, it.rpe, it.note, rpeNamed = true) }, session.routineId)

    // What this phone refuses before asking the account: the import's own checks, a window reaching past now, a
    // movement the catalogue lacks, then a crossing with a finished workout on the log.
    fun importRefusal(at: Moment, among: List<Session>, catalogue: Catalogue): GymRefusal? {
        val action = importAction
        try { action.refusal(at)?.let { return it } } catch (violation: Violation) { return GymRefusal.Invalid(violation) }
        if (action.finishedAt > at.now) return GymRefusal.predicted(Gym.Codes.badInstant, session.id.ref)
        sets.firstOrNull { catalogue.find(it.exerciseId) == null }?.let { return GymRefusal.predicted(Gym.Codes.unknownExercise, it.id.ref) }
        val crossed = among.filter { it.id != session.id && SessionRules.crosses(action.startedAt, action.finishedAt, it) }
            .minWithOrNull(compareBy({ it.startedAt }, { it.id })) ?: return null
        return GymRefusal.predicted(Gym.Codes.sessionOverlap, session.id.ref, Json.objectOf("sessionId" to crossed.id.json))
    }

    // What this phone refuses before a retry asks the account. A finished copy is an import, with the import's checks.
    // An open copy restarts as a start that does not join, with its sets appended: the log refuses that while it
    // holds an open workout of its own, and never for crossing a finished one.
    fun retryRefusal(at: Moment, among: List<Session>, catalogue: Catalogue): GymRefusal? {
        if (!session.isOpen) return importRefusal(at, among, catalogue)
        if (among.any { it.isOpen && it.id != session.id }) return GymRefusal.predicted(Gym.Codes.sessionOpen, session.id.ref)
        try {
            SessionRules.instant(session.startedAt, "session.startedAt", Path("startedAt"))
            if (session.startedAt > at.now) return GymRefusal.predicted(Gym.Codes.badInstant, session.id.ref)
            for (set in sets) {
                Valid(set, TrainingSet, at = at)
                if (catalogue.find(set.exerciseId) == null) return GymRefusal.predicted(Gym.Codes.unknownExercise, set.id.ref)
            }
        } catch (violation: Violation) { return GymRefusal.Invalid(violation) }
        return null
    }

    // A notice this copy owns: a refusal of the gestures recovery queues for it, its import, its start with its sets,
    // a correction of its session or the creation of one of its sets. A later edit of a set that landed is the room's.
    fun owns(notice: DomainNotice<GymRefusal>): Boolean {
        val content = notice.notice.content
        val command = content.command
        if (command != null) when (command.name) {
            Gym.Commands.importSession, Gym.Commands.start -> if (command.args["id"] == session.id.json) return true
            Gym.Commands.correctSession -> if (command.args["sessionId"] == session.id.json) return true
        }
        return content.deltas.any { delta -> delta.creates && delta.key.type == TrainingSet.type && sets.any { it.id.record == delta.key.id } }
    }

    override fun equals(other: Any?): Boolean = other is SignedOutWorkout && session == other.session && sets == other.sets
    override fun hashCode(): Int = 31 * session.hashCode() + sets.hashCode()

    companion object {
        const val key = "rack:adoption"

        fun decode(value: Json): SignedOutWorkout {
            val saved = value["session"] ?: throw DecodeError(Session.type, "adoption", "missing session")
            val rows = (value["sets"] as? Json.Arr)?.values ?: throw DecodeError(Session.type, "adoption", "invalid saved workout")
            val id = Fields(saved, Session.type, "adoption").ref("id", Session)
            val session = Session.decode(Fields(Session.type, id.record, saved.obj() - "id"))
            return SignedOutWorkout(session, rows.map { row ->
                val setId = Fields(row, TrainingSet.type, "adoption").ref("id", TrainingSet)
                TrainingSet.decode(Fields(TrainingSet.type, setId.record, row.obj() - "id"))
            })
        }
        fun read(read: Reader): List<SignedOutWorkout> {
            val rows = (read.device(key) as? Json.Obj)?.members ?: return emptyList()
            return rows.values.map(::decode).sortedBy { it.session.id }
        }
        // The device key's rows with these copies replacing their own and these dropped, or null when none is left.
        fun saved(backup: List<SignedOutWorkout>, replacing: List<SignedOutWorkout>, dropping: List<Id<Session>> = emptyList()): Json? {
            val rows = LinkedHashMap<String, Json>()
            for (copy in backup) rows[copy.session.id.toString()] = copy.json
            for (id in dropping) rows.remove(id.toString())
            for (copy in replacing) rows[copy.session.id.toString()] = copy.json
            return if (rows.isEmpty()) null else Json.Obj(rows.toList())
        }
    }
}

// A start that does not join the account's open workout: the saved copy keeps its own identity.
fun nonJoiningStart(session: Session): ServerCommand = GymCommand(Gym.Commands.start, buildMap {
    put("id", session.id.json); put("startedAt", Json.of(session.startedAt.ms)); put("joinOpenSession", Json.of(false))
    session.routineId?.let { put("routineId", it.json) }
})

// `prepare` turns a signed-out workout into one import, or a non-joining start, before the replica changes hands.
// `keep` imports the saved copy as finished at its last set; `restart` resubmits an open one's start with every set
// it holds, in one plan, or refuses the whole retry. Both take a revised copy, which replaces the saved one only
// when the retry is queued.
class AdoptWorkout(val id: Id<Session>, val mode: Mode, val revised: SignedOutWorkout? = null) : Action<AdoptWorkout.Loaded, Unit, GymRefusal> {
    enum class Mode { prepare, keep, restart }
    data class Loaded(val anonymous: Boolean, val commands: List<QueuedCommand>, val backup: List<SignedOutWorkout>,
        val workout: SignedOutWorkout?, val imported: ImportSession.Loaded?, val confirmed: Boolean, val firstPullComplete: Boolean)
    init { require(revised == null || (mode != Mode.prepare && revised.session.id == id)) { "a revision keeps the saved workout's identity" } }
    override val scope = Session.scope
    override val refusals = GymRefusal
    override fun load(read: Reader): Loaded {
        val backup = SignedOutWorkout.read(read)
        val saved = backup.firstOrNull { it.session.id == id }
        val workout = when (mode) {
            Mode.prepare -> read.repository(Session).find(id, ViewMode.drawn)?.let { session ->
                val drawn = read.repository(TrainingSet).children(id, "sessionId", ViewMode.drawn)
                val kept = saved?.sets.orEmpty().filter { set -> drawn.none { it.id == set.id } && read.repository(TrainingSet).record(set.id, ViewMode.stored) == null }
                SignedOutWorkout(SessionRules.drawn(session, drawn + kept, read.moment.now), drawn + kept)
            }
            Mode.keep, Mode.restart -> saved?.let { revised ?: it }
        }
        return Loaded(read.isAnonymous, read.commands(), backup, workout, workout?.importAction?.load(read),
            read.confirmed(Session, id) != null, read.firstPullComplete())
    }
    override fun decide(loaded: Loaded, ids: IDSource): Decision<Unit, GymRefusal> {
        val workout = loaded.workout ?: return Decision.Unchanged(Unit)
        val commands = loaded.commands.filter { it.command.args["id"] == id.json }
        if (commands.any { it.command.name == Gym.Commands.importSession }) return Decision.Unchanged(Unit)
        val plan = when (mode) {
            Mode.prepare -> {
                val start = commands.firstOrNull { it.command.name == Gym.Commands.start && it.canSupersede }
                if (!loaded.anonymous || start == null) return Decision.Unchanged(Unit)
                val imported = loaded.imported
                if (!workout.session.isOpen && imported != null) when (val decision = workout.importAction.decision(imported, ids)) {
                    is Decision.Write -> decision.plan.also { it.supersede(listOf(start.gestureId)) }
                    is Decision.Refuse -> return Decision.Refuse(decision.refusal)
                    is Decision.Unchanged -> return Decision.Unchanged(Unit)
                } else if (start.command.args["joinOpenSession"] != Json.of(false)) {
                    Plan(nonJoiningStart(workout.session), listOf(Prediction.create(Session, id, workout.session.fields()))).also { it.supersede(listOf(start.gestureId)) }
                } else Plan()
            }
            Mode.keep, Mode.restart -> {
                if (loaded.anonymous || !loaded.firstPullComplete || commands.any { it.command.name == Gym.Commands.start })
                    return Decision.Refuse(GymRefusal.predicted(Gym.Codes.sessionOpen, id.ref))
                if (loaded.confirmed) return Decision.Refuse(GymRefusal.Taken(id.ref, Refused.Path.predicted))
                val imported = loaded.imported ?: return Decision.Unchanged(Unit)
                val decision = if (mode == Mode.restart) restart(workout, imported.state) else {
                    workout.importRefusal(imported.state.moment, imported.state.stored, imported.state.catalogue)?.let { return Decision.Refuse(it) }
                    workout.importAction.decision(imported, ids)
                }
                when (decision) {
                    is Decision.Write -> decision.plan
                    is Decision.Refuse -> return Decision.Refuse(decision.refusal)
                    is Decision.Unchanged -> return Decision.Unchanged(Unit)
                }
            }
        }
        plan.device(SignedOutWorkout.key, SignedOutWorkout.saved(loaded.backup, listOf(workout)))
        return Decision.Write(plan, Unit)
    }

    // An open copy's start, not joining, and every set it holds appended in the order performed: the account takes
    // the workout whole, or the phone refuses the retry whole, naming the first set it would refuse.
    fun restart(workout: SignedOutWorkout, state: TrainingState): Decision<Unit, GymRefusal> {
        val session = workout.session
        if (!session.isOpen) return Decision.Refuse(GymRefusal.predicted(Gym.Codes.sessionFinished, id.ref))
        if (state.stored.any { SessionRules.drawn(it, state.sets, state.moment.now).isOpen }) return Decision.Refuse(GymRefusal.predicted(Gym.Codes.sessionOpen, id.ref))
        SessionRules.instant(session.startedAt, "session.startedAt", Path("startedAt"))
        if (session.startedAt > state.moment.now) return Decision.Refuse(GymRefusal.predicted(Gym.Codes.badInstant, id.ref))
        val plan = Plan(nonJoiningStart(session), listOf(Prediction.create(Session, id, session.fields())))
        AppendSet.appended(workout.sets, session, state, plan)?.let { return Decision.Refuse(it) }
        return Decision.Write(plan, Unit)
    }
}

// Drops every saved copy the account has taken whole: its session and each of its sets confirmed.
class ReconcileAdoptedWorkouts : Action<ReconcileAdoptedWorkouts.Loaded, Unit, GymRefusal> {
    data class Loaded(val all: List<SignedOutWorkout>, val remaining: List<SignedOutWorkout>)
    override val scope = Session.scope
    override val refusals = GymRefusal
    override fun load(read: Reader): Loaded {
        val all = SignedOutWorkout.read(read)
        return Loaded(all, all.filter { workout ->
            read.confirmed(Session, workout.session.id) == null || workout.sets.any { read.confirmed(TrainingSet, it.id) == null }
        })
    }
    override fun decide(loaded: Loaded, ids: IDSource): Decision<Unit, GymRefusal> {
        if (loaded.all == loaded.remaining) return Decision.Unchanged(Unit)
        val plan = Plan()
        plan.device(SignedOutWorkout.key, SignedOutWorkout.saved(loaded.remaining, emptyList()))
        return Decision.Write(plan, Unit)
    }
}
