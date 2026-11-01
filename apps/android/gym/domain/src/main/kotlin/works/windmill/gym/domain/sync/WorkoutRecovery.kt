package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.JsonError
import works.windmill.sync.core.RecordID
import works.windmill.sync.schema.Gym

// A signed-out workout the account has not taken: why it is still on this phone, what a retry does and the sets it
// would move.
class WorkoutRecovery(val workout: SignedOutWorkout, val reason: Reason, val refusal: GymRefusal?, val retry: Retry,
    val noticeIds: List<String>, val strandedSets: List<TrainingSet>, val movementNames: Map<Id<Exercise>, String>) {
    // The label is the bounded one telemetry carries; copy is the surface's.
    enum class Reason(val label: String) {
        accountWorkoutOpen("session-open"), overlap("session-overlap"), identityTaken("id-taken"), badTime("bad-instant"),
        tooManySets("too-many-sets"), invalidSet("invalid-set"), unknownMovement("unknown-exercise"), strandedSets("session-finished"),
        unsent("unsent"), other("other");
        companion object {
            fun of(refusal: GymRefusal): Reason = when (refusal) {
                is GymRefusal.SessionOpen -> accountWorkoutOpen
                is GymRefusal.SessionOverlap -> overlap
                is GymRefusal.Taken, is GymRefusal.PayloadConflict -> identityTaken
                is GymRefusal.BadInstant -> badTime
                is GymRefusal.Invalid -> when (refusal.violation.rule) {
                    "session.sets" -> tooManySets
                    "session.startedAt", "session.finishedAt", "set.completedAt" -> badTime
                    else -> invalidSet
                }
                is GymRefusal.UnknownExercise -> unknownMovement
                is GymRefusal.SessionFinished -> strandedSets
                is GymRefusal.Full, is GymRefusal.Stale, is GymRefusal.Gone, is GymRefusal.Future,
                is GymRefusal.ProposalSettled, is GymRefusal.ProposalSuperseded, is GymRefusal.PlanLogged, is GymRefusal.Other -> other
            }
        }
    }
    // Which action a retry runs: the import of a finished copy, the start of an open one, or the sets a landed workout refused.
    enum class Retry { importWorkout, restartWorkout, restoreSets }

    val id: Id<Session> get() = workout.session.id
    // The copy is the phone's to correct, except that a spent identity stays spent whatever the copy says.
    val canFix: Boolean get() = reason != Reason.identityTaken

    companion object {
        // Every saved workout the account has not taken and nothing is carrying: refused by a notice it owns, refused
        // by this phone, or never sent. A retry dismisses the notices it answers, so a dismissed notice says nothing
        // here; the newest live one is the reason. A workout drawn on the log is there or on its way, and waits only
        // on its own sets the log does not draw: with none missing it is still adding, or confirmed and about to leave.
        fun review(workouts: List<SignedOutWorkout>, notices: List<DomainNotice<GymRefusal>>, log: TrainingLog, catalogue: Catalogue): List<WorkoutRecovery> {
            val sessions = log.drawnSessions
            return workouts.mapNotNull { workout ->
                val live = notices.filter { workout.owns(it) && !it.notice.isDismissed }
                val names = workout.sets.map { it.exerciseId }.distinct().mapNotNull { exercise -> catalogue.find(exercise)?.let { exercise to it.name } }.toMap()
                fun reviewed(reason: Reason, refusal: GymRefusal?, retry: Retry, stranded: List<TrainingSet>) =
                    WorkoutRecovery(workout, reason, refusal, retry, live.map { it.id }, stranded, names)
                if (sessions.any { it.id == workout.session.id }) {
                    val missing = workout.sets.filter { set -> log.sets.none { it.id == set.id } }
                    if (missing.isEmpty()) return@mapNotNull null
                    val latest = live.lastOrNull() ?: return@mapNotNull reviewed(Reason.unsent, null, Retry.restoreSets, missing)
                    return@mapNotNull reviewed(Reason.of(latest.refusal), latest.refusal, Retry.restoreSets, missing)
                }
                val retry = if (workout.session.isOpen) Retry.restartWorkout else Retry.importWorkout
                val latest = live.lastOrNull()
                if (latest != null && stands(latest.refusal, workout, log)) return@mapNotNull reviewed(Reason.of(latest.refusal), latest.refusal, retry, emptyList())
                val refusal = workout.retryRefusal(log.moment, sessions, catalogue) ?: return@mapNotNull reviewed(Reason.unsent, null, retry, emptyList())
                reviewed(Reason.of(refusal), refusal, retry, emptyList())
            }
        }

        // A notice names what held the copy back when the account answered. While the phone's log is complete it can
        // tell that the account's open workout has closed, or that the workout the copy crossed no longer crosses it;
        // then the notice no longer stands, and the copy's own state is its reason. A workout the log does not draw
        // may be one the phone has not pulled yet, so a crossing with it stands.
        fun stands(refusal: GymRefusal, against: SignedOutWorkout, on: TrainingLog): Boolean {
            if (!on.firstPullComplete) return true
            val sessions = on.drawnSessions
            return when (refusal) {
                is GymRefusal.SessionOpen -> sessions.any { it.isOpen && it.id != against.session.id }
                is GymRefusal.SessionOverlap -> {
                    val named = refusal.refused.detail?.get("sessionId") ?: return true
                    val crossed = try { RecordID(named) } catch (_: JsonError) { return true }
                    val other = sessions.firstOrNull { it.id.record == crossed } ?: return true
                    val action = against.importAction
                    SessionRules.crosses(action.startedAt, action.finishedAt, other)
                }
                else -> true
            }
        }
    }
}

// The editor over a saved workout the account refused: its times, its routine link and each set, or, once the
// workout is on the log, its stranded sets alone, since its times and routine are the log's. `workout` is the
// corrected copy a retry submits; a set is removed by taking it out of `sets`.
data class WorkoutFix(val original: SignedOutWorkout, val landed: Boolean, val startedAt: Instant, val finishedAt: Instant?,
    val keepsRoutine: Boolean, val sets: List<SetFix>, val edited: Set<Id<TrainingSet>>) {
    data class SetFix(val id: Id<TrainingSet>, val exerciseId: Id<Exercise>, val weightKg: Double, val reps: Int,
        val rpe: Double?, val note: String, val completedAt: Instant) {
        constructor(set: TrainingSet) : this(set.id, set.exerciseId, set.weightKg, set.reps, set.rpe, set.note, set.completedAt)
        fun set(session: Id<Session>) = TrainingSet(id, session, exerciseId, weightKg, reps, rpe, note, completedAt)
    }

    constructor(workout: SignedOutWorkout) : this(workout, workout.sets, false)
    constructor(recovery: WorkoutRecovery) : this(recovery.workout,
        if (recovery.retry == WorkoutRecovery.Retry.restoreSets) recovery.strandedSets else recovery.workout.sets,
        recovery.retry == WorkoutRecovery.Retry.restoreSets)
    private constructor(workout: SignedOutWorkout, editing: List<TrainingSet>, landed: Boolean) : this(workout, landed,
        workout.session.startedAt, workout.session.finishedAt, workout.session.routineId != null, editing.map { SetFix(it) }, editing.map { it.id }.toSet())

    val hasRoutine: Boolean get() = original.session.routineId != null
    val isOpen: Boolean get() = finishedAt == null
    val isChanged: Boolean get() = workout != original

    // Finished at its last set, or at its start when it has none.
    fun markFinished(): WorkoutFix = copy(finishedAt = maxOf(startedAt, sets.maxOfOrNull { it.completedAt } ?: startedAt))

    val workout: SignedOutWorkout get() {
        val saved = original.session
        val closedBy = if (finishedAt == null) null else if (finishedAt == saved.finishedAt) saved.closedBy else "finish"
        val session = Session(saved.id, startedAt, finishedAt, closedBy, if (keepsRoutine) saved.routineId else null,
            if (keepsRoutine) saved.historyRoutineId else null, if (keepsRoutine) saved.plan else null, saved.displayName,
            if (keepsRoutine) saved.unreadablePlan else null)
        return SignedOutWorkout(session, original.sets.filter { it.id !in edited } + sets.map { it.set(session.id) })
    }

    // The editor's live line: what this phone would refuse before asking the account. A load the person changed meets
    // its floor; a landed workout's sets must be valid and on known movements; a whole copy passes what its retry would meet.
    fun refusal(at: Moment, among: List<Session>, catalogue: Catalogue): GymRefusal? {
        workout.floorRefusal(original, catalogue)?.let { return it }
        if (!landed) return workout.retryRefusal(at, among, catalogue)
        for (set in sets) {
            try { Valid(set.set(original.session.id), TrainingSet, at = at) } catch (violation: Violation) { return GymRefusal.Invalid(violation) }
            if (catalogue.find(set.exerciseId) == null) return GymRefusal.predicted(Gym.Codes.unknownExercise, set.id.ref)
        }
        return null
    }
}

// Drops a saved copy the account has not taken, with every set it holds.
class DiscardSignedOutWorkout(val id: Id<Session>) : Action<List<SignedOutWorkout>, Unit, GymRefusal> {
    override val scope = Session.scope
    override val refusals = GymRefusal
    override fun load(read: Reader): List<SignedOutWorkout> = SignedOutWorkout.read(read)
    override fun decide(loaded: List<SignedOutWorkout>, ids: IDSource): Decision<Unit, GymRefusal> {
        if (loaded.none { it.session.id == id }) return Decision.Unchanged(Unit)
        val plan = Plan()
        plan.device(SignedOutWorkout.key, SignedOutWorkout.saved(loaded, emptyList(), dropping = listOf(id)))
        return Decision.Write(plan, Unit)
    }
}

// A set the account refused after its workout had landed lives only in its notice; the saved copy still holds it.
// `intoWorkout` puts the sets inside the workout's window back into it: appended while it is open, else corrected
// in, numbered after the ones it kept, its times left alone. `separately` makes the sets outside the window a saved
// copy of their own, from the first to the last, and queues its import, so a refusal of it is that copy's to fix.
// Either replays what the copy recorded and takes a revised copy, whose changed loads meet their floors and which
// replaces the saved one only when the retry is queued.
class RecoverStrandedSets(val id: Id<Session>, val placement: Placement, val revised: SignedOutWorkout? = null) : Action<RecoverStrandedSets.Loaded, Unit, GymRefusal> {
    enum class Placement { intoWorkout, separately }
    data class Loaded(val backup: List<SignedOutWorkout>, val workout: SignedOutWorkout?, val session: Session?, val stranded: List<TrainingSet>, val state: TrainingState)
    init { require(revised == null || revised.session.id == id) { "a revision keeps the saved workout's identity" } }
    override val scope = Session.scope
    override val refusals = GymRefusal
    override fun load(read: Reader): Loaded {
        val state = TrainingState(read)
        val backup = SignedOutWorkout.read(read)
        val workout = backup.firstOrNull { it.session.id == id }?.let { revised ?: it }
        val stranded = workout?.sets.orEmpty().filter { set -> read.confirmed(TrainingSet, set.id) == null && state.drawnSets.none { it.id == set.id } }
        return Loaded(backup, workout, read.repository(Session).find(id, ViewMode.stored), stranded, state)
    }
    override fun decide(loaded: Loaded, ids: IDSource): Decision<Unit, GymRefusal> {
        val workout = loaded.workout ?: return Decision.Unchanged(Unit)
        if (loaded.stranded.isEmpty()) return Decision.Unchanged(Unit)
        val session = loaded.session ?: return Decision.Refuse(GymRefusal.Gone(id.ref, Refused.Path.predicted))
        workout.floorRefusal(loaded.backup.firstOrNull { it.session.id == id }, loaded.state.catalogue)?.let { return Decision.Refuse(it) }
        val inside = loaded.stranded.filter { set -> set.completedAt >= session.startedAt && (session.finishedAt?.let { set.completedAt <= it } ?: true) }
        when (placement) {
            Placement.intoWorkout -> {
                if (inside.isEmpty()) return Decision.Unchanged(Unit)
                val plan = when (val placed = placed(inside, session, loaded.state, ids)) {
                    is Decision.Write -> placed.plan
                    is Decision.Refuse -> return Decision.Refuse(placed.refusal)
                    is Decision.Unchanged -> return Decision.Unchanged(Unit)
                }
                plan.device(SignedOutWorkout.key, SignedOutWorkout.saved(loaded.backup, listOf(workout)))
                return Decision.Write(plan, Unit)
            }
            Placement.separately -> {
                val outside = loaded.stranded.filter { set -> inside.none { it.id == set.id } }
                val first = outside.firstOrNull() ?: return Decision.Unchanged(Unit)
                val separate = Session(ids.mint(Session), first.completedAt, outside.last().completedAt, "finish")
                val copy = SignedOutWorkout(separate, outside.map { it.copy(sessionId = separate.id) })
                copy.importRefusal(loaded.state.moment, loaded.state.stored, loaded.state.catalogue)?.let { return Decision.Refuse(it) }
                val plan = when (val imported = copy.importAction.recorded.decision(ImportSession.Loaded(loaded.state, null), ids)) {
                    is Decision.Write -> imported.plan
                    is Decision.Refuse -> return Decision.Refuse(imported.refusal)
                    is Decision.Unchanged -> return Decision.Unchanged(Unit)
                }
                val kept = SignedOutWorkout(workout.session, workout.sets.filter { set -> outside.none { it.id == set.id } })
                plan.device(SignedOutWorkout.key, SignedOutWorkout.saved(loaded.backup, listOf(kept, copy)))
                return Decision.Write(plan, Unit)
            }
        }
    }

    // The sets inside the window, appended to an open workout in one plan, or corrected into a finished one after the
    // sets it kept, by one additive correction.
    fun placed(sets: List<TrainingSet>, session: Session, state: TrainingState, ids: IDSource): Decision<Unit, GymRefusal> {
        val finish = session.finishedAt
        if (finish == null) {
            val plan = Plan()
            AppendSet.appended(sets, session, state, plan)?.let { return Decision.Refuse(it) }
            return Decision.Write(plan, Unit)
        }
        val numbers = LinkedHashMap<Id<Exercise>, Long>()
        val corrected = sets.map { set ->
            val next = numbers[set.exerciseId] ?: SetRules.nextNumber(state.sets, id, set.exerciseId)?.toLong()
            if (next == null || next > Int.MAX_VALUE) throw Violation("set.setNumber", Path("setNumber"), Violation.Reason.Above(Int.MAX_VALUE.toDouble()))
            numbers[set.exerciseId] = next + 1
            CorrectedSet(set.id, set.exerciseId, next, set.weightKg, set.reps, set.completedAt, set.rpe, set.note, rpeNamed = true)
        }
        val correction = CorrectSession(id, ids.opaqueID(), session.startedAt, finish, session.displayName, corrected, preserveOtherSets = true)
        return correction.recorded.decision(state, ids)
    }
}
