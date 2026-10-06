package works.windmill.gym.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import works.windmill.gym.domain.WorkoutClock
import works.windmill.gym.domain.WorkoutMoment
import works.windmill.gym.domain.WorkoutRack
import works.windmill.gym.domain.WorkoutKey
import works.windmill.gym.domain.WorkoutNotification
import works.windmill.gym.domain.WorkoutChange
import works.windmill.gym.domain.LogSetCommand
import works.windmill.gym.domain.LogSetAcceptance
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.AutoClose
import works.windmill.gym.domain.Blocker
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.ConnectedLogState
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.ExerciseWrite
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.LastSet
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.LiveOrder
import works.windmill.gym.domain.StatsProgress
import works.windmill.gym.domain.MovementRecord
import works.windmill.gym.domain.Note
import works.windmill.gym.domain.NoteWrite
import works.windmill.gym.domain.PlanEntry
import works.windmill.gym.domain.Prefill
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.ProposalDecision
import works.windmill.gym.domain.ProposalIntent
import works.windmill.gym.domain.ProposalState
import works.windmill.gym.domain.Review
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.RoutineWrite
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.SessionShare
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.domain.SetWrite
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.WeighIn
import works.windmill.gym.domain.WeighInWrite
import works.windmill.gym.net.GymRest
import works.windmill.gym.coach.CoachStore
import works.windmill.gym.coach.LocalCoach
import works.windmill.platform.Account
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.schema.Gym

// Main-thread training state; Coach owns its conversations, drafts and network requests.
class TrainingStore(
    private val controls: WorkoutControls,
    private val training: EngineTraining,
    private val scope: CoroutineScope,
    private val rest: () -> GymRest? = { null },
    private val now: () -> Long = System::currentTimeMillis,
    private val mintSession: () -> String = Ids::session,
    private val mintSet: () -> String = Ids::set,
    private val mintRoutine: () -> String = Ids::routine,
    private val mintExercise: () -> String = Ids::exercise,
    private val undoWindowMs: Long = Withheld.windowMs,
    private val workoutClock: WorkoutClock = WorkoutClock { val at = now(); WorkoutMoment(at, at, "local") },
    private val workoutAuthority: (String?) -> Boolean = { true },
    private val telemetry: Telemetry = Telemetry.None,
    elapsedNanos: () -> Long = System::nanoTime,
    localCoach: LocalCoach? = null,
) {
    val coach = CoachStore(
        accountOwner = { owner }, withheldIds = { withheldIds }, onProgramChanged = ::reread,
        rest = rest, localCoach = localCoach, telemetry = telemetry, elapsedNanos = elapsedNanos,
    )

    // A refusal is an answer the screen says, never a failure to report.
    private fun reportFailure(operation: String, error: Exception) {
        if (error is WindmillApiException || error is TrainingRefused || error is TrainingUnanswered || error is CancellationException) return
        telemetry.failure(operation, error)
    }

    private val workoutFacts = MutableStateFlow<WorkoutNotification?>(null)
    val notification = workoutFacts.asStateFlow()
    var rack: WorkoutRack? by mutableStateOf(null)
        private set
    var workoutFailure: String? by mutableStateOf(null)
        private set
    var workoutOpenRequest by mutableStateOf(0L)
        private set
    fun requestWorkout() { workoutOpenRequest += 1 }
    fun authorizeWorkout(allowed: Boolean) {
        localWorkoutAuthorized = allowed
        if (!allowed) workoutFacts.value = null
    }
    fun revokeWorkoutAuthority() {
        try {
            if (controls.session != null && controls.writable) controls.control(controls.workout.invalidate())
        } catch (error: Exception) {
            reportFailure("gym.revokeWorkoutAuthority", error)
            refuseWorkout()
        }
        workoutFacts.value = null
    }
    private var workoutReady = false
    private var localWorkoutAuthorized = true
    private val workoutAuthorized: Boolean get() = localWorkoutAuthorized && workoutAuthority(owner) &&
        controls.engineReplica == training.engine.activeReplica()

    fun restoreWorkout(cachedOwner: String?, authorized: Boolean) {
        if (workoutReady) return
        localWorkoutAuthorized = authorized
        owner = cachedOwner
        try {
            controls.adopt(owner)
            projectEngineReplica()
            preferences = training.settings()
            catalog = training.catalogue()
            routines = training.program()
            series = training.weighins()
            workoutReady = true
            reconcileWorkoutTime()
            exerciseId = controls.chosenMovement
            lastTime = exerciseId?.let { LastTime.of(it, training.details()) }.takeIf { owner == null }
            drawFromControls()
        } catch (error: Exception) {
            reportFailure("gym.restoreWorkout", error)
            refuseWorkout()
        }
    }

    // A workout left past the auto-close is over on this phone too: the replica already draws it
    // closed at its last activity.
    fun reconcileWorkoutTime() {
        if (!workoutReady || !controls.writable) return
        if (!workoutAuthorized) { refreshWorkout(); return }
        val live = controls.session
        if (live != null) {
            val moment = workoutClock.now()
            val origin = controls.latestSet(moment)?.origin ?: controls.workout.started
            val overAt = if (origin?.bootId == moment.bootId) {
                origin.wallMs.takeIf { moment.elapsedMs - origin.elapsedMs >= AutoClose.AFTER_MS }
            } else AutoClose.at(live, controls.sets(live.id), moment.wallMs)
            if (overAt != null) {
                controls.close(live.id)
                lastTimes.clear()
                exerciseId = null
                lastTime = null
                drawFromControls()
                return
            }
        }
        refreshWorkout()
    }

    fun editRack(weightKg: Double, reps: Int): WorkoutChange {
        if (isFinishing || !workoutAuthorized || !controls.writable) return WorkoutChange.Unavailable(workoutFailure ?: "The workout is not ready.")
        if (session == null || rack == null) return WorkoutChange.Stale
        return try {
            controls.control(controls.workout.edit(weightKg, reps))
            refreshWorkout()
            WorkoutChange.Saved
        } catch (error: Exception) {
            reportFailure("gym.editRack", error)
            WorkoutChange.Unavailable(refuseWorkout())
        }
    }

    fun editWorkout(open: Boolean): WorkoutChange {
        if (!workoutAuthorized) return WorkoutChange.Unavailable("The account must be restored first.")
        return try {
            controls.control(controls.workout.editor(open))
            refreshWorkout()
            WorkoutChange.Saved
        } catch (error: Exception) {
            reportFailure("gym.editWorkout", error)
            WorkoutChange.Unavailable(refuseWorkout())
        }
    }

    // The offered set and the offer it consumes are one engine commit: a repeated tap or a
    // redelivered command meets a consumed offer and logs nothing.
    fun acceptSet(command: LogSetCommand): LogSetAcceptance {
        reconcileWorkoutTime()
        if (!workoutAuthorized || isFinishing || !controls.writable) {
            return LogSetAcceptance.Unavailable(workoutFailure ?: "The workout is not ready.")
        }
        return try {
            val accepted = controls.accept(command, workoutClock.now(), lastTime, mintSet)
            if (accepted is LogSetAcceptance.Accepted) {
                val entry = requireNotNull(controls.entry(accepted.setId))
                controls.store(training.commitAccepted(controls, entry.set, entry.sessionId), entry.sessionId)
                telemetry.event("gym_set_logged")
                drawFromControls()
            }
            accepted
        } catch (error: Exception) {
            reportFailure("gym.acceptSet", error)
            LogSetAcceptance.Unavailable(refuseWorkout())
        }
    }

    fun showWorkout(key: WorkoutKey, hidden: Boolean): WorkoutChange {
        if (!workoutAuthorized) return WorkoutChange.Unavailable("The account must be restored first.")
        if (workoutFacts.value?.key != key) return WorkoutChange.Stale
        return try {
            controls.control(controls.workout.visibility(hidden))
            refreshWorkout()
            WorkoutChange.Saved
        } catch (error: Exception) {
            reportFailure("gym.showWorkout", error)
            WorkoutChange.Unavailable(refuseWorkout())
        }
    }

    private fun refreshWorkout() {
        if (!workoutReady) return
        if (!workoutAuthorized) { workoutFacts.value = null; return }
        val live = controls.session
        if (live == null) {
            rack = null
            workoutFacts.value = null
            return
        }
        val ready = workoutAuthorized && !isFinishing && controls.writable
        val state = try {
            if (controls.writable && workoutAuthorized) controls.prepare(lastTime, workoutClock.now(), ready, mintSet) else controls.workout
        } catch (error: Exception) {
            reportFailure("gym.refreshWorkout", error)
            refuseWorkout()
            return
        }
        try { training.persistControls(controls) }
        catch (failure: Exception) { reportFailure("gym.workout_controls", failure); refuseWorkout(); return }
        rack = state.rack
        val movement = controls.chosenMovement
        val rows = controls.sets.filter { it.exerciseId == movement }
        workoutFacts.value = WorkoutNotification(WorkoutKey(accountKey, live.id), live,
            movement?.let { Readout.movement(it, catalog) } ?: "Choose a movement", rows, state, ready)
    }

    private fun projectEngineReplica(force: Boolean = false) {
        val replica = training.engine.activeReplica()
        if (controls.engineReplica == replica && !force) return
        val open = training.openWorkout()
        controls.project(replica, open?.session, open?.sets.orEmpty())
        training.restoreControls(controls)
        controls.flush()
    }

    // Before the account changes, confirmed starts settle, the sets they owe follow, and the
    // workout's controls are in the replica the next account's room projects from.
    suspend fun prepareEngineTransition() {
        training.reconcileImports()
        training.persistControls(controls)
    }

    private fun refuseWorkout(): String {
        val reason = "The workout could not be saved safely. Restart the app to recover it."
        workoutFailure = reason
        workoutFacts.value = workoutFacts.value?.copy(offer = null)
        return reason
    }

    // Read from the replica of the seat now asking: a name is per-account the moment a rename exists.
    var catalog: List<Exercise> by mutableStateOf(emptyList())
        private set
    // What reaches this account's log, as the shell last answered for the seat in hand. Held by the
    // ROOM so the settings row and the connected-log screen read one answer, and read once per
    // seat: `connect` drops it on arrival and `readConnectedLog` asks only while nothing is held.
    var connectedLog: ConnectedLogState by mutableStateOf(ConnectedLogState.Unknown)
        private set
    // Published from here so the settings screen and the logger read one document.
    var preferences: GymPreferences by mutableStateOf(GymPreferences())
        private set
    // The replica's series for the seat in hand, ascending by date.
    private var series: List<WeighIn> by mutableStateOf(emptyList())
    // A weigh-in inside its undo window is off the DRAWN series for every reader — the chart's dots
    // and the log's head reading both — so one of them can never draw a day the other has dropped.
    // Writes go to `series`, which is the whole of it.
    val bodyweight: List<WeighIn>
        get() = series.filterNot { it.dateLocal in withheldIds }
    // The whole series, a withheld weigh-in included. A window decides which ROWS are drawn and
    // never what state a screen is in, so the chart's empty stance is read from here.
    val allWeighIns: List<WeighIn> get() = series
    // An unread account replica is not an empty series.
    var bodyweightRead by mutableStateOf(false)
        private set
    private val bodyweightWrite = Mutex()
    private val preferencesWrite = Mutex()
    private val progressRead = Mutex()
    private var progressRevision = 0L
    private var progressWanted = false
    private var progressCache: StatsProgress? by mutableStateOf(null)
    var progressLoading by mutableStateOf(false)
        private set
    var progressFailure: WriteFailure? by mutableStateOf(null)
        private set
    val progress: StatsProgress?
        get() {
            val read = progressCache ?: return null
            val heldSessions = withheld.mapNotNull { (it.deletion as? Deletion.Session)?.sessionId }.toSet()
            return read.copy(sessions = read.sessions.filterNot { it.sessionId in heldSessions })
        }
    val accountKey: String get() = Seat.of(owner)

    // The account replica's notes in precedence order. The first pull distinguishes an unread
    // notebook from an empty one; the room keeps one projection so an undo window stays hidden.
    private val notebookWrite = Mutex()
    private val proposalWrite = Mutex()
    private var notebook: List<Note> by mutableStateOf(emptyList())
    var notesRead by mutableStateOf(false)
        private set
    var noteRefusals: List<RefusedWrite> by mutableStateOf(emptyList())
        private set
    // A note inside its undo window is off the list; `noteCount` still counts it, because the log
    // refuses the eleventh whether or not this screen is drawing the tenth.
    val notes: List<Note>
        get() = notebook.filterNot { it.id in withheldIds }
    val noteCount: Int get() = notebook.size
    // Every proposal this room settled, as the log's receipt said it: a card minted in a conversation
    // reads off this before the copy it was minted with, so a settled one never keeps saying waiting.
    var settledProposals: Map<String, Proposal> by mutableStateOf(emptyMap())
        private set
    private var program: List<Routine> by mutableStateOf(emptyList())
    // The whole program, a withheld routine included. The routines home reads its empty stance and
    // the position it writes a new routine at from here: a window decides which ROWS are drawn and
    // never what state a screen is in.
    val allRoutines: List<Routine> get() = program
    var routines: List<Routine>
        // A routine inside its undo window is off the program as far as every screen is concerned:
        // nothing was written, and only Undo puts it back. Writes go to `program`, which is the whole
        // of it.
        get() = program.filterNot { it.id in withheldIds }
        private set(value) { program = value }
    var logged: List<SessionSummary> by mutableStateOf(emptyList())      // the account's pages, newest first
        private set
    private var logReadRevision = 0L
    var shelved: List<SessionSummary> by mutableStateOf(emptyList())     // refused imports kept on this phone
        private set
    // Both, merged on the clock: everything the account and this device hold between them, which is
    // what the log's empty stance and the first-session line are read from.
    val allSessions: List<SessionSummary>
        get() = (logged + shelved).sortedByDescending { it.startedAtMs }
    // A session inside its undo window is off the log as far as every screen is concerned; only Undo
    // puts it back.
    val recent: List<SessionSummary>
        get() = allSessions.filterNot { it.id in withheldIds }
    var older: Older by mutableStateOf(Older.More)
        private set
    var session: Session? by mutableStateOf(null)                        // the open one, or none
        private set
    var sets: List<TrainingSet> by mutableStateOf(emptyList())           // its sets, performed order
        private set
    var order: List<String> by mutableStateOf(emptyList())               // its movements, walk order
        private set
    var exerciseId: String? by mutableStateOf(null)                      // the movement in hand
        private set
    var lastTime: LastTime? by mutableStateOf(null)
        private set
    // Sparse: the absence of a key is `never logged`. NULL is the map that has not been read; an
    // EMPTY map is an answer, that this lifter has trained nothing.
    var lastSets: Map<String, LastSet>? by mutableStateOf(null)
        private set
    var prefill: Prefill by mutableStateOf(Prefill(Prefill.EMPTY_BAR_KG, Prefill.EMPTY_BAR_REPS))
        private set
    var refusals: List<RefusedWrite> by mutableStateOf(emptyList())      // writes the log refused
        private set
    // Nothing is written until a window closes. A LIST and not a slot — each delete carries its own
    // clock and a second one never settles the first. NOT on disk: an activity recreated inside a
    // window has written nothing, so what it held survives.
    var withheld: List<WithheldDelete> by mutableStateOf(emptyList())
        private set
    // One clock per subject, so a window can be taken down as well as opened: leaving the room lets
    // go of what it was holding, and a clock still running would settle a delete nobody is holding
    // any more. Not composition state — nothing draws it.
    private val clocks = mutableMapOf<String, Job>()
    // A delete that could not be written after its window closed, said once and cleared. Nothing
    // local was crossed out, so the row is back on the next read.
    var deleteRefused: String? by mutableStateOf(null)
        private set
    // One room's memory of its own deletes, never a tombstone: a session read BEFORE the delete would
    // otherwise draw a row that is gone.
    var deletedSets: Set<String> by mutableStateOf(emptySet())
        private set
    var saveState: SaveState by mutableStateOf(SaveState.Idle)
        private set
    var saveTick: Int by mutableStateOf(0)                               // bumps once per write
        private set
    // Sets the replica holds and the account has not confirmed.
    var strandedCount: Int by mutableStateOf(0)
        private set
    private var enginePendingSessions by mutableStateOf(emptySet<String>())
    // What is blocking delivery, read off the engine's status and its last reply.
    var strandedBy: Blocker? by mutableStateOf(null)
        private set
    var isLoading: Boolean by mutableStateOf(true)
        private set
    // A set logged into a session that closes under it belongs to no workout.
    var isFinishing: Boolean by mutableStateOf(false)
        private set

    private var seated: Account? = null
    // Whose the replica in hand is: the account id, or null for the signed-out seat.
    private var owner: String? = null
    private var closedDetails by mutableStateOf<Map<String, SessionDetail>>(emptyMap())
    private val lastTimes = mutableMapOf<String, LastTime>()
    // A change of seat drops the map and the picker's own effect never runs again, so `connect` asks
    // again on the way out.
    private var lastSetsWanted = false

    internal companion object {
        private const val accountChanged = "The account changed. Open this again."
        // The log's page: a shorter page is the bottom of the log.
        const val logPage = 50

        // Coach, shares and connected-log credentials are the account's: signed out, nothing is asked.
        const val signInFirst = "Sign in first."

    }

    // Warmups included; `Prefill` is narrower and follows the working sets only.
    val todaySets: List<TrainingSet>
        get() {
            val movement = exerciseId ?: return emptyList()
            return sets.filter { it.exerciseId == movement }
        }

    val planEntry: PlanEntry?
        get() {
            val movement = exerciseId ?: return null
            return session?.plan?.entry(movement)
        }

    // Signed out, every drawn row is on this device and nowhere else; signed in, only the ones the
    // account has not confirmed. A deleted row is not drawn.
    val stalled: Set<String> get() = training.pendingSetIds()
    val deviceOnlySessionIds: Set<String>
        get() = shelved.mapTo(mutableSetOf()) { it.id } + enginePendingSessions

    // A routine carries its own pending proposal, so nothing polls and nothing pushes. Newest first.
    val pendingProposals: List<Proposal>
        get() = routines.mapNotNull { it.pendingProposal }.sortedByDescending { it.createdAtMs }

    fun routine(id: String): Routine? = routines.firstOrNull { it.id == id }

    // Every id the lifter has deleted inside a window still open. Every list that could draw one
    // filters against it: as far as the lifter is concerned the row is gone.
    val withheldIds: Set<String> get() = withheld.mapTo(mutableSetOf()) { it.subjectId }

    // The newest window still the lifter's — what the transient offers to take back. Null the
    // instant the newest delete is being written, which is what takes the transient down.
    val holding: WithheldDelete? get() = withheld.lastOrNull { it.takeable }

    // How long the newest way back has left. The store STAMPED that instant, so the store is what
    // subtracts from it: a room reaching for a clock of its own would measure a span against an
    // instant some other clock wrote.
    val wayBackLeftMs: Long
        get() = (holding?.untilMs ?: 0L) - now()

    // Nothing has ever happened in this room. It asks whether the log's head was read, never whether
    // its lists came back empty: `older == End` is the log answering "there is no more". The session
    // the lifter is IN is not counted.
    //
    // Both halves read what the ACCOUNT holds and neither reads a drawn list: a window decides which
    // rows are drawn and never what state a screen is in, and this state opens the picker with a
    // first-session title and a drawn `Build my routine`.
    val firstSession: Boolean
        get() = allSessions.isEmpty() && program.isEmpty() && older == Older.End

    // Called on launch and on every change of who is signed in. A re-read with the same account
    // preserves open deletion windows.
    suspend fun connect(account: Account) {
        if (!account.resolved) return
        if (!workoutAuthority(account.user?.id)) {
            if (!workoutAuthorized) workoutFacts.value = null
            return
        }
        localWorkoutAuthorized = account.locallyTrusted
        workoutReady = true
        val arriving = seated != account
        seated = account
        // Names and the workout stay with the seat that owns them.
        if (owner != account.user?.id) {
            workoutFacts.value = null
            session = null
            rack = null
            sets = emptyList()
            exerciseId = null
        }
        owner = account.user?.id
        // The workout's controls are rebuilt from the active engine replica before they can accept work.
        try {
            check(controls.writable) { "Restart the app to recover the saved workout." }
            controls.adopt(owner)
            projectEngineReplica(force = arriving)
        }
        catch (error: Exception) {
            reportFailure("gym.connect", error)
            authorizeWorkout(false)
            refuseWorkout()
            isLoading = false
            return
        }
        preferences = training.settings()
        catalog = training.catalogue()
        routines = training.program()
        series = training.weighins()
        bodyweightRead = false
        progressRevision += 1
        progressCache = null
        progressFailure = null
        progressLoading = false
        // The last-time cache dies with the seat; the picker's meta goes with it.
        lastTimes.clear()
        settledProposals = emptyMap()
        lastSets = null
        // The pages go with the seat, and this is the one place they do: `loadLog` keeps whatever walk
        // is under a thumb, which it may only do while every row belongs to the account now asking.
        logged = emptyList()
        older = Older.More
        // A withheld delete goes with the SEAT, UNWRITTEN: settling it now would take a row off the
        // log of the account that just arrived. Its clock goes with it, or it would settle a window
        // the next seat never opened. A re-read with the account already in hand takes nothing down:
        // dropping its open windows would leave a lifter told `Note deleted.` over a note that is
        // never deleted.
        if (arriving) {
            closedDetails = emptyMap()
            for (clock in clocks.values) clock.cancel()
            clocks.clear()
            withheld = emptyList()
            deleteRefused = null
            deletedSets = emptySet()
            notebook = emptyList()
            notesRead = false
            noteRefusals = emptyList()
            coach.resetThreads()
            connectedLog = ConnectedLogState.Unknown
        }
        reconcileWorkoutTime()
        drawFromControls()
        isLoading = false

        val seat = owner
        shelved = refusedImports()
        tried("gym.import_reconcile") { training.reconcileImports() }
        if (seat != owner) return
        loadLog()
        if (seat != owner) return
        refreshWorkout()
        loadBodyweight()
        if (progressWanted) loadProgress()
        if (seat != owner) return
        resume()
        if (lastSetsWanted) loadLastSets()
    }

    private fun shelfDetail(id: String): SessionDetail? =
        training.imports.refusals().firstOrNull { it.id == id }?.let { refused ->
            refused.session?.let { SessionDetail(it, refused.sets) }
        } ?: training.imports.pendingFinished().firstOrNull { it.session.id == id }?.let { row ->
            SessionDetail(row.session, row.sets.filterNot { it.id in row.deleted })
        }

    private fun refusedImports(): List<SessionSummary> {
        val drawn = training.details().mapTo(mutableSetOf()) { it.session.id }
        return training.imports.refusals().mapNotNull { refused -> refused.session?.let { session ->
            SessionSummary(session, refused.sets)
        } }.filterNot { it.id in drawn }
    }

    fun observeEngine() {
        val engine = training.engine
        scope.launch { engine.status.state.collect { refreshEngine() } }
        scope.launch { engine.notices("gym").notices.collect { refreshEngine() } }
        for (type in listOf("exercise", "exerciseName", "routine", "routineCreation", "session", "set", "prefs", "note", "weighin", "proposal"))
            scope.launch { engine.records(works.windmill.sync.core.ScopeRef.product("gym"), type).state.collect { refreshEngine() } }
    }

    suspend fun refreshEngine() {
        if (controls.engineReplica != training.engine.activeReplica()) return
        val seat = owner
        tried("gym.import_reconcile") { training.reconcileImports() }
        if (training.firstPullComplete && !training.anonymous) training.imports.retireStartSources()
        if (seat != owner) return
        refusals = training.refusedWrites()
        loadLog()
        if (seat != owner) return
        for (detail in training.details()) {
            if (!detail.session.isOpen && detail.session.id in closedDetails) retainClosed(detail)
            for (set in detail.sets) if (withheld.any { held ->
                val deletion = held.deletion as? Deletion.Set
                deletion?.sessionId == detail.session.id && deletion.set.id == set.id && deletion.set != set
            }) changeHeldSet(detail.session.id, set.id, set)
        }
        catalog = training.catalogue()
        routines = training.program()
        preferences = training.settings()
        notebookWrite.withLock {
            if (seat != owner) return@withLock
            notebook = training.notes()
            notesRead = training.notesReady
            noteRefusals = training.refusedNotes()
        }
        loadBodyweight()
        if (lastSetsWanted) loadLastSets()
        if (progressWanted) loadProgress(force = true)
        drawFromControls()
    }

    // The domain action freezes the routine into the session as it starts.
    suspend fun start(routineId: String? = null): GymResult<Session> {
        if (!workoutAuthorized || !controls.writable) return GymResult.Failed(WriteFailure.Refused(workoutFailure ?: "The account must be restored first."))
        val seat = owner
        return try {
            val opened = training.startSession(SessionStart(id = mintSession(), startedAt = now(), routineId = routineId))
            if (!workoutAuthorized || seat != owner) return GymResult.Failed(WriteFailure.Refused("the account changed while starting"))
            adopt(opened, joined = false)
            if (!workoutAuthorized || seat != owner) return GymResult.Failed(WriteFailure.Refused("the account changed while starting"))
            val live = session ?: return GymResult.Failed(WriteFailure.NoAnswer)
            telemetry.event("gym_session_started")
            GymResult.Ok(live)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refused: TrainingRefused) {
            // A workout is already open on the account: the re-read adopts it and stands the lifter
            // back where they were.
            if (refused.code == "session-already-open" && workoutAuthorized && seat == owner) {
                loadLog()
                if (workoutAuthorized && seat == owner) resume()
            }
            GymResult.Failed(WriteFailure(refused))
        } catch (failed: Exception) {
            reportFailure("gym.start", failed)
            GymResult.Failed(WriteFailure.Refused("The workout could not be saved safely. Restart and retry."))
        }
    }

    // The answer is kept for the life of the session: a last time is a FINISHED session, so none of
    // these answers can change mid-workout.
    suspend fun choose(movement: String) {
        if (!workoutAuthorized) return
        controls.choose(movement)
        controls.flush()
        order = controls.order
        exerciseId = movement
        lastTime = lastTimes[movement]
        redial()

        if (lastTime != null) return
        val seat = owner
        val sessionId = session?.id
        val answer = tried("gym.choose") { training.lastTime(movement) }
        if (!workoutAuthorized || owner != seat || session?.id != sessionId) return
        if (answer?.exerciseId != movement) return
        lastTimes[movement] = answer
        if (exerciseId != movement) return
        lastTime = answer
        redial()
    }

    // Sets are keyed by movement and never by position, so only the walk order moves.
    fun reorder(from: Int, to: Int) {
        if (!workoutAuthorized) return
        val walked = LiveOrder.moved(order, from, to)
        if (walked == order) return
        controls.hold(order = walked)
        controls.flush()
        order = walked
    }

    // False where `LiveOrder.droppable` refuses. Dropping the movement in hand returns to the picker.
    fun drop(exerciseId: String): Boolean {
        if (!workoutAuthorized) return false
        if (!LiveOrder.droppable(exerciseId, sets, session?.plan)) return false
        val walked = order.filterNot { it == exerciseId }
        if (walked == order) return false
        controls.hold(order = walked)
        controls.flush()
        order = walked
        if (this.exerciseId == exerciseId) {
            this.exerciseId = null
            lastTime = null
            redial()
        }
        return true
    }

    // Read when the picker OPENS and never on a keystroke. A replica that has not been read for the
    // account leaves the map alone: `never logged` is an assertion, and half an answer would make it
    // about every movement the half did not name.
    suspend fun loadLastSets() {
        lastSetsWanted = true
        val served = tried("gym.loadLastSets") { training.lastSets() } ?: return
        lastSets = served.associateBy { it.exerciseId }
    }

    // The row lands in the replica before the network is consulted at all. The kind is the CALLER's
    // and is the one thing about a set that cannot be repaired later.
    suspend fun logSet(weightKg: Double, reps: Int, kind: SetKind = SetKind.Working) {
        if (!workoutAuthorized) return
        val live = session ?: return
        val movement = exerciseId ?: return
        if (isFinishing) return
        if (kind == SetKind.Working) {
            if (editRack(weightKg, reps) !is WorkoutChange.Saved) return
            val offer = notification.value?.offer ?: return
            acceptSet(LogSetCommand(offer.key, offer.id))
            return
        }
        val moment = workoutClock.now()
        val set = TrainingSet(id = mintSet(), exerciseId = movement, weightKg = weightKg, reps = reps,
            kind = kind, completedAtMs = moment.wallMs)
        try {
            controls.store(training.appendSet(live.id, SetWrite(set)), live.id, moment)
            telemetry.event("gym_set_logged")
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refused: TrainingRefused) {
            refusals = refusals + RefusedSet(set, if (refused.code == Gym.Codes.unknownExercise) "that movement is not in the catalog" else refused.line)
        } catch (failure: Exception) {
            reportFailure("gym.logSet", failure)
            refuseWorkout()
        }
        drawFromControls()
    }

    // Finishing closes the workout in the replica, which carries the close to the account behind
    // every set this session holds.
    suspend fun finish(): FinishOutcome {
        if (!workoutAuthorized) return FinishOutcome.Failed(WriteFailure.Refused("The account must be restored first."))
        if (isFinishing) return FinishOutcome.Failed(WriteFailure.Refused("this workout is already finishing"))
        val live = session ?: return FinishOutcome.Failed(WriteFailure.NoAnswer)
        val seat = owner
        isFinishing = true
        refreshWorkout()
        try {
            val closed = try {
                training.finishSession(live.id, now())
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure("gym.finish", refusing)
                if (!workoutAuthorized || seat != owner) return FinishOutcome.Failed(WriteFailure.Refused("the account changed while finishing"))
                if ((refusing as? TrainingRefused)?.code != "unknown-record") return FinishOutcome.Failed(WriteFailure(refusing))
                null
            }
            if (!workoutAuthorized || seat != owner) return FinishOutcome.Failed(WriteFailure.Refused("the account changed while finishing"))
            val detail = closed?.let { SessionDetail(it, controls.sets(live.id)) }
            if (detail != null) retainClosed(detail)
            controls.close(live.id)
            controls.flush()
            lastTimes.clear()
            exerciseId = null
            lastTime = null
            drawFromControls()
            if (detail == null) {
                loadLog()
                if (!workoutAuthorized || seat != owner) return FinishOutcome.Failed(WriteFailure.Refused("the account changed while finishing"))
                return FinishOutcome.Failed(WriteFailure.Refused("that workout is no longer on the log"))
            }
            scope.launch {
                if (workoutAuthorized && seat == owner) loadLog()
            }
            invalidateProgress()
            telemetry.event("gym_session_finished")
            return FinishOutcome.Closed(detail)
        } finally {
            isFinishing = false
            refreshWorkout()
        }
    }

    fun retainedSession(detail: SessionDetail): SessionDetail = closedDetails[detail.session.id] ?: detail

    private fun retainClosed(detail: SessionDetail) {
        closedDetails = closedDetails + (detail.session.id to detail)
    }

    // The log refuses to delete a session somebody may still be logging into.
    suspend fun discard(sessionId: String): Boolean {
        if (!workoutAuthorized) return false
        if (shelfDetail(sessionId) != null) {
            training.imports.discardRefusal(sessionId)
            invalidateProgress()
            controls.close(sessionId)
            controls.flush()
            drawFromControls()
            shelved = refusedImports()
            return true
        }
        val seat = owner
        tried("gym.discard") { training.discardSession(sessionId) } ?: return false
        if (!workoutAuthorized || seat != owner) return false
        invalidateProgress()
        // The discard leaves the READ and not only the drawn rows, and the re-read below is not
        // enough on its own: `loadLog` keeps every row DEEPER than the page it answers with, so a
        // session older than the log's head would be folded straight back in and drawn again the
        // moment the window that was hiding it closed.
        logged = logged.filterNot { it.id == sessionId }
        controls.close(sessionId)
        controls.flush()
        drawFromControls()
        loadLog()
        return true
    }

    // Composed from the session's own sets, in performed order, with the weights used as targets. The
    // carrier session exists because RoutineWrite.from reads a SessionDetail; only its sets are read.
    suspend fun keep(sets: List<TrainingSet>, asRoutineNamed: String, creationId: String = mintRoutine(),
                     position: Int = program.size): GymResult<Routine> {
        val carrier = SessionDetail(Session(id = "ses_kept", startedAtMs = now()), sets)
        val write = RoutineWrite.from(asRoutineNamed, carrier, position = position)
            ?: return GymResult.Failed(WriteFailure.Refused("a routine needs at least one working set"))
        return saveRoutine(RoutineDraft(name = write.name, position = write.position,
            entries = Routine(write).entries, creationId = creationId))
    }

    // Read the full routine, then guard its revision before replacing the targeted plan entry.
    suspend fun save(sets: List<SetTarget>, toRoutine: String, atPosition: Int,
                     forExercise: String): WriteFailure? {
        return try {
            // Absent and another account's fold into null, so there is no sentence to repeat.
            val routine = training.routine(toRoutine)
                ?: return WriteFailure.Refused("that routine is no longer on the log")
            val moved = routine.retargeting(atPosition, forExercise, sets)
                ?: return WriteFailure.Refused("${routine.name} has changed since this session started")
            val saved = training.replaceRoutine(toRoutine, RoutineWrite(moved, routine.revision))
            routines = program.map { if (it.id == saved.id) saved else it }
            null
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (error: Exception) {
            reportFailure("gym.save", error)
            WriteFailure(error)
        }
    }

    // One day of the program, written WHOLE. A routine with an id is an edit, which moves the
    // revision and supersedes every proposal pending on it; without one it is a create and the id is
    // minted here. Savable while incomplete but not while EMPTY.
    suspend fun saveRoutine(draft: RoutineDraft): GymResult<Routine> {
        if (Program.nameProblem(draft.name) == Program.nameTooLong) return GymResult.Failed(WriteFailure.Refused(Program.nameTooLong))
        val name = Program.named(draft.name)
            ?: return GymResult.Failed(WriteFailure.Refused("a routine needs a name"))
        if (draft.entries.isEmpty()) {
            return GymResult.Failed(WriteFailure.Refused("a routine needs at least one movement"))
        }
        val standing = draft.id
        val creationId = draft.creationId ?: mintRoutine()
        if (standing != null && draft.original?.expectedRevision == null) {
            return GymResult.Failed(WriteFailure.Refused("reopen this routine before saving — its original revision is missing"))
        }
        val seat = owner
        val write = RoutineWrite(standing ?: creationId, name, draft.position, draft.write,
            expectedRevision = draft.original?.expectedRevision)
        return try {
            val saved = if (standing == null) training.createRoutine(write)
                else training.replaceRoutine(standing, write)
            if (seat != owner) return GymResult.Failed(WriteFailure.Refused("the account changed while saving"))
            routines = if (standing == null) program.filterNot { it.id == saved.id } + saved
                else program.map { if (it.id == saved.id) saved else it }
            if (standing == null && RoutineWrite(saved) != write) return GymResult.Failed(WriteFailure.Refused(
                "this save already holds different details — reopen the saved routine to edit it"))
            telemetry.event("gym_routine_saved", mapOf("action" to if (standing == null) "create" else "update"))
            GymResult.Ok(saved)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.saveRoutine", refusing)
            if (seat != owner) return GymResult.Failed(WriteFailure.Refused("the account changed while saving"))
            GymResult.Failed(WriteFailure(refusing))
        }
    }

    // The sessions that named it keep every set and their frozen plan: a snapshot is a copy, not a
    // reference. A routine already gone is a deletion that succeeded.
    suspend fun dropRoutine(id: String): WriteFailure? {
        return try {
            training.deleteRoutine(id)
            routines = program.filterNot { it.id == id }
            null
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.dropRoutine", refusing)
            if ((refusing as? TrainingRefused)?.code == "unknown-record") {
                routines = program.filterNot { it.id == id }
                null
            } else {
                WriteFailure(refusing)
            }
        }
    }

    // Nothing is held: a second visit asks again, because a proposal moves the moment anybody decides
    // anything. Answers with a REASON and never with null.
    suspend fun proposal(id: String): ProposalRead {
        return (training.proposal(id) ?: settledProposals[id])?.let { ProposalRead.Found(it) } ?: ProposalRead.Gone
    }

    // Atomic against the base the diff was written on. Nothing here merges, retries or applies part
    // of a diff; the decision is drawn only from the log's receipt.
    suspend fun applyProposal(id: String): ProposalOutcome = decide(id, applying = true)

    suspend fun dismissProposal(id: String): ProposalOutcome = decide(id, applying = false)

    private suspend fun decide(id: String, applying: Boolean): ProposalOutcome {
        val seat = owner
        return proposalWrite.withLock {
            if (seat != owner) return@withLock ProposalOutcome.Failed(WriteFailure.Refused(accountChanged))
            try {
                val decision = if (applying) training.applyProposal(id) else training.dismissProposal(id)
                if (seat != owner) return@withLock ProposalOutcome.Failed(WriteFailure.Refused(accountChanged))
                decided(decision)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure(if (applying) "gym.applyProposal" else "gym.dismissProposal", refusing)
                if (seat != owner) return@withLock ProposalOutcome.Failed(WriteFailure.Refused(accountChanged))
                refused(refusing)
            }
        }.also { reportProposal(if (applying) "apply" else "dismiss", it) }
    }

    private fun reportProposal(action: String, outcome: ProposalOutcome) {
        val result = when (outcome) {
            is ProposalOutcome.Decided -> "decided"
            is ProposalOutcome.Moved -> "moved"
            is ProposalOutcome.Gone -> "gone"
            is ProposalOutcome.Settled -> "settled"
            is ProposalOutcome.Failed -> "failed"
        }
        telemetry.event("gym_proposal_outcome", mapOf("action" to action, "outcome" to result))
    }

    // Drawn from the log's own receipt and never from the request. The card is dropped BY ID rather
    // than blanked, because a newer proposal may already be standing in that slot.
    private fun decided(decision: ProposalDecision): ProposalOutcome {
        val settled = decision.proposal
        val moved = decision.routine
        routines = when {
            moved != null -> program.map { if (it.id == moved.id) moved else it }
            settled.state == ProposalState.Applied && settled.intent == ProposalIntent.Remove ->
                program.filterNot { it.id == settled.routineId }
            else -> program.map { held ->
                if (held.id != settled.routineId) held
                else held.copy(pendingProposal = held.pendingProposal?.takeIf { it.id != settled.id })
            }
        }
        settledProposals = settledProposals + (settled.id to settled)
        return ProposalOutcome.Decided(settled)
    }

    // A refusal means this room's picture is stale, so the routines are re-read before the sentence
    // is said. A decision the log did not answer, or one that needs a fresh sign-in, leaves the list
    // alone, because nothing was decided.
    private fun refused(error: Throwable): ProposalOutcome {
        val refusal = error as? TrainingRefused
        if (refusal == null || refusal.code == "sign-in") return ProposalOutcome.Failed(WriteFailure(error))
        reread()
        return when (refusal.code) {
            Gym.Codes.proposalSuperseded -> ProposalOutcome.Moved(refusal.line)
            "unknown-record" -> ProposalOutcome.Gone("that proposal is no longer on the log")
            else -> ProposalOutcome.Settled(refusal.line)
        }
    }

    // A re-read keeps what this room changed and dropped since the last one.
    private fun reread() {
        val before = program.associateBy { it.id }
        val written = training.program()
        val changed = program.filter { before[it.id] != it }.associateBy { it.id }
        val deleted = before.keys - program.map { it.id }.toSet()
        val fetched = written.filterNot { it.id in deleted }
        routines = fetched.map { changed[it.id] ?: it } + changed.values.filter { row -> fetched.none { it.id == row.id } }
    }

    // What a screen asks on the way in: the answer already held for this seat, or the read that
    // gets one. A refused read is not an answer, so the next screen in asks again.
    suspend fun readConnectedLog(): ConnectedLogState {
        if (connectedLog.answered) return connectedLog
        return refreshConnectedLog()
    }

    // The forced read — pull-to-refresh. Both lists or neither: a static key reaches the same tools
    // and never appears among the grants, so either read failing makes the answer a refusal rather
    // than an undercount. Signed out the log is this device's and nothing reaches it.
    private var connectedRead = 0L

    suspend fun refreshConnectedLog(): ConnectedLogState {
        val request = ++connectedRead
        val seat = owner
        val credentials = rest()
        if (seat == null || credentials == null) {
            connectedLog = ConnectedLogState.None
            return connectedLog
        }
        val read = try {
            coroutineScope {
                val grants = async { credentials.grants() }
                val keys = async { credentials.mcpKeys() }
                ConnectedLog.state(grants.await(), keys.await())
            }
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.refreshConnectedLog", refusing)
            ConnectedLogState.Refused
        }
        if (seat != owner || request != connectedRead) return ConnectedLogState.Refused
        connectedLog = read
        return read
    }

    // Notes are read from the replica of the seat in hand. A refused save keeps its receipt and its
    // submitted words.
    suspend fun readNotes(): GymResult<List<Note>> {
        val seat = owner
        return notebookWrite.withLock {
            if (seat != owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
            val served = training.notes()
            notebook = served
            notesRead = training.notesReady
            noteRefusals = training.refusedNotes()
            GymResult.Ok(served)
        }
    }

    suspend fun saveNote(id: String, write: NoteWrite): GymResult<Note> {
        val seat = owner
        return notebookWrite.withLock {
            if (seat != owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
            try {
                val written = training.writeNote(id, write)
                if (seat != owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                notebook = if (notebook.any { it.id == id }) notebook.map { if (it.id == id) written else it }
                    else notebook + written
                GymResult.Ok(written)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure("gym.saveNote", refusing)
                if (seat != owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                GymResult.Failed(WriteFailure(refusing))
            }
        }
    }

    // A note already gone answers as success: the row goes either way.
    suspend fun deleteNote(id: String): WriteFailure? {
        val seat = owner
        return notebookWrite.withLock {
            if (seat != owner) return@withLock WriteFailure.Refused(accountChanged)
            try {
                training.deleteNote(id)
                if (seat != owner) return@withLock WriteFailure.Refused(accountChanged)
                notebook = notebook.filterNot { it.id == id }
                null
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure("gym.deleteNote", refusing)
                if (seat != owner) return@withLock WriteFailure.Refused(accountChanged)
                if ((refusing as? TrainingRefused)?.code != "unknown-record") return@withLock WriteFailure(refusing)
                notebook = notebook.filterNot { it.id == id }
                null
            }
        }
    }

    // The order is the lifter's instruction and it is written before it is believed here: a refusal
    // leaves the notebook exactly as the replica holds it. What arrives is the order of the rows
    // DRAWN, and a note inside its undo window is not one of them — the withheld one keeps the place
    // it stands in and the drawn ones fill the rest.
    suspend fun reorderNotes(drawn: List<String>): GymResult<List<Note>> {
        val seat = owner
        return notebookWrite.withLock {
            if (seat != owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
            val visible = notes.map { it.id }
            if (drawn.size != visible.size || drawn.toSet().size != drawn.size || drawn.toSet() != visible.toSet()) {
                return@withLock GymResult.Failed(WriteFailure.Refused("The notes changed. Read them again before reordering."))
            }
            val queue = ArrayDeque(drawn)
            val order = notebook.map { if (it.id in withheldIds || queue.isEmpty()) it.id else queue.removeFirst() }
            try {
                val written = training.reorderNotes(order)
                if (seat != owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                notebook = written
                GymResult.Ok(written)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure("gym.reorderNotes", refusing)
                if (seat != owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                GymResult.Failed(WriteFailure(refusing))
            }
        }
    }

    // The equipment is the CALLER's and is never guessed. The pattern is the domain's value for "we
    // did not ask": nothing on this surface reads it, because the ladder is taken off the MAGNITUDE
    // of the load.
    suspend fun create(name: String, equipment: String, id: String = mintExercise()): GymResult<Exercise> {
        val named = Program.named(name)
            ?: return GymResult.Failed(WriteFailure.Refused("a movement needs a name"))
        if (Program.length(named) > Program.maxNameLength || equipment !in Exercise.loadings) {
            return GymResult.Failed(WriteFailure.Refused("check the movement name and equipment"))
        }
        val write = ExerciseWrite(id, named, Exercise.unclassified, equipment)
        val seat = owner
        return try {
            val made = training.createExercise(write)
            if (seat != owner) return GymResult.Failed(WriteFailure.Refused("the account changed while creating"))
            catalog = catalog.filterNot { it.id == made.id } + made
            if (made.id != write.id || made.name != write.name || made.equipment != write.equipment || made.pattern != write.pattern) {
                return GymResult.Failed(WriteFailure.Refused("already saved as ${made.name} (${made.equipment}) — choose it from the movement list"))
            }
            GymResult.Ok(made)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.create", refusing)
            if (seat != owner) return GymResult.Failed(WriteFailure.Refused("the account changed while creating"))
            GymResult.Failed(WriteFailure(refusing))
        }
    }

    // The local commit controls the next frame; domain drafts preserve fields owned by other surfaces.
    suspend fun savePreferences(document: GymPreferences): WriteFailure? {
        if (!workoutAuthorized) return WriteFailure.Refused(accountChanged)
        val seat = owner
        return preferencesWrite.withLock {
            try {
                val saved = training.savePreferences(document)
                if (!workoutAuthorized || seat != owner) return@withLock WriteFailure.Refused(accountChanged)
                preferences = saved
                refreshWorkout()
                null
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { reportFailure("gym.savePreferences", failure); WriteFailure(failure) }
        }
    }

    fun clearRefusals() {
        training.dismissRefusals()
        refusals = emptyList()
        noteRefusals = emptyList()
    }

    // The newest day that has happened: a row dated past this phone's today is not a reading (B2).
    val latestWeighIn: WeighIn? get() = Bodyweight.latest(bodyweight, Bodyweight.today(now()))

    fun loadBodyweight() {
        series = training.weighins()
        bodyweightRead = training.anonymous || training.firstPullComplete || series.isNotEmpty()
    }

    suspend fun weighIn(dateLocal: String, weightKg: Double): WriteFailure? {
        if (!weightKg.isFinite() || weightKg !in Bodyweight.minKg..Bodyweight.maxKg)
            return WriteFailure.Refused(Bodyweight.outOfRange)
        val date = runCatching { java.time.LocalDate.parse(dateLocal) }.getOrNull()
            ?: return WriteFailure.Refused("Choose a date.")
        Bodyweight.dated(date, Bodyweight.today(now()))?.let { return WriteFailure.Refused(it) }
        val seat = owner
        dropWithheld(dateLocal)
        return bodyweightWrite.withLock {
            try {
                val previous = series.firstOrNull { it.dateLocal == dateLocal }
                training.putBodyweight(dateLocal, WeighInWrite(weightKg, maxOf(now(), (previous?.recordedAt ?: -1) + 1)))
                if (seat != owner) return@withLock WriteFailure.Refused(accountChanged)
                series = training.weighins()
                bodyweightRead = true
                null
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { reportFailure("gym.weighIn", failure); WriteFailure(failure) }
        }
    }

    suspend fun deleteWeighIn(dateLocal: String) {
        val seat = owner
        bodyweightWrite.withLock {
            tried("gym.deleteWeighIn") { training.deleteBodyweight(dateLocal) }
            if (seat == owner) series = training.weighins()
        }
    }

    suspend fun loadProgress(force: Boolean = false): GymResult<StatsProgress> {
        progressWanted = true
        val seat = owner
        return progressRead.withLock {
            if (seat != owner) return@withLock GymResult.Failed(WriteFailure.Refused("The account changed while reading."))
            if (!force) progressCache?.let { return@withLock GymResult.Ok(it) }
            progressLoading = true
            progressFailure = null
            try {
                var revision: Long
                var read: StatsProgress
                do {
                    revision = progressRevision
                    read = training.progress()
                    if (seat != owner) return@withLock GymResult.Failed(WriteFailure.Refused("The account changed while reading."))
                } while (revision != progressRevision)
                progressCache = read
                GymResult.Ok(read)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (failure: Exception) {
                reportFailure("gym.loadProgress", failure)
                val why = WriteFailure(failure)
                if (seat == owner) progressFailure = why
                GymResult.Failed(why)
            } finally {
                if (seat == owner) progressLoading = false
            }
        }
    }

    private fun invalidateProgress() {
        progressRevision += 1
        progressCache = null
        if (progressWanted) scope.launch { loadProgress() }
    }

    // Computed by the DOMAIN and read here, never re-derived. A refused import kept on this phone
    // reviews against itself: no record and no comparison, which need the account's whole history.
    suspend fun review(of: String): Review? {
        shelfDetail(of)?.let { return Review.of(it) }
        val seat = owner
        val result = tried("gym.review") { training.review(of) }
        return result.takeIf { seat == owner }
    }

    fun sessionDetail(sessionId: String, seed: SessionDetail? = null): GymResult<SessionDetail> {
        shelfDetail(sessionId)?.let { return GymResult.Ok(it) }
        if (seed != null && seed.session.id == sessionId && !seed.session.isOpen && closedDetails[sessionId] == null) retainClosed(seed)
        val before = closedDetails[sessionId]
        val detail = training.session(sessionId)
            ?: return GymResult.Failed(WriteFailure.Refused("that session is no longer on the log"))
        val current = closedDetails[sessionId]
        if (current != before && current != null) return GymResult.Ok(current)
        if (!detail.session.isOpen) retainClosed(detail)
        return GymResult.Ok(detail)
    }

    // The branch is WHOSE ROW IT IS. A refused import kept on this phone is corrected there and
    // retried; every other row is corrected in the replica, the live workout's included, and stands
    // at once, offline too. The log moves and the routine does not: a fix carries no target.
    suspend fun fixSet(sessionId: String, setId: String, fix: SetFix): FixOutcome {
        if (!workoutAuthorized) return FixOutcome.Failed(WriteFailure.Refused("the account changed while fixing"))
        val live = session?.takeIf { it.id == sessionId }
        if (live != null && sets.none { it.id == setId }) return FixOutcome.Gone("that set is no longer on this device")
        if (live == null) shelfDetail(sessionId)?.let { detail ->
            val corrected = detail.sets.firstOrNull { it.id == setId }?.let(fix::corrected)
                ?: return FixOutcome.Gone("that set is no longer on this device")
            val deleted = training.imports.refusals().firstOrNull { it.id == sessionId }?.deletedSetIds
                ?: training.imports.pendingFinished().firstOrNull { it.session.id == sessionId }?.deleted.orEmpty()
            training.imports.replaceAndRetry(sessionId, SavedWorkout(detail.session,
                detail.sets.map { if (it.id == setId) corrected else it }, deleted),
                correctedKinds = if (fix.kind != null) setOf(setId) else emptySet())
            changedSet(sessionId, setId, corrected)
            shelved = refusedImports()
            return FixOutcome.Corrected(corrected)
        }
        val seat = owner
        return try {
            val stored = training.fixSet(sessionId, setId, fix)
            if (!workoutAuthorized || seat != owner) return FixOutcome.Failed(WriteFailure.Refused("the account changed while fixing"))
            changedSet(sessionId, setId, stored)
            if (live != null) {
                controls.store(stored, live.id)
                drawFromControls()
            } else rereadRow(sessionId)
            FixOutcome.Corrected(stored)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.fixSet", refusing)
            if ((refusing as? TrainingRefused)?.code == "unknown-record") FixOutcome.Gone("that set is no longer on the log")
            else FixOutcome.Failed(WriteFailure(refusing))
        }
    }

    // Once the window over it has closed, the same roads as the fix: the row is gone from this
    // device at once and the replica carries the delete to the account. Nothing here recovers a
    // deleted row.
    suspend fun deleteSet(sessionId: String, setId: String): WriteFailure? {
        if (!workoutAuthorized) return WriteFailure.Refused("the account changed while deleting")
        val live = session?.takeIf { it.id == sessionId }
        if (live == null) shelfDetail(sessionId)?.let { detail ->
            val deleted = training.imports.refusals().firstOrNull { it.id == sessionId }?.deletedSetIds
                ?: training.imports.pendingFinished().firstOrNull { it.session.id == sessionId }?.deleted.orEmpty()
            training.imports.replaceAndRetry(sessionId, SavedWorkout(detail.session,
                detail.sets.filterNot { it.id == setId }, (deleted + setId).distinct()))
            if (detail.sets.any { it.id == setId }) {
                deletedSets = deletedSets + setId
                shelved = refusedImports()
                changedSet(sessionId, setId, null)
            }
            return null
        }
        val seat = owner
        try {
            training.deleteSet(sessionId, setId)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.deleteSet", refusing)
            return WriteFailure(refusing)
        }
        if (!workoutAuthorized || seat != owner) return WriteFailure.Refused("the account changed while deleting")
        deletedSets = deletedSets + setId
        changedSet(sessionId, setId, null)
        if (live != null) {
            controls.drop(setId)
            drawFromControls()
        } else rereadRow(sessionId)
        return null
    }

    // Its aggregates all moved with the set and the replica is the only thing that computes them. It
    // asks for ONE row, anchored on the one above it, because a session reached with `Load older` is
    // below the head; the answer is taken only if it IS the row asked for, since the cursor is a
    // position.
    private suspend fun rereadRow(sessionId: String) {
        val seat = owner
        val at = logged.indexOfFirst { it.id == sessionId }
        if (at < 0) return
        val above = logged.getOrNull(at - 1)
        val fresh = tried("gym.rereadRow") { training.sessions(limit = 1, before = above?.startedAtMs, beforeId = above?.id) }
            ?.singleOrNull()?.takeIf { it.id == sessionId } ?: return
        if (seat != owner) return
        logged = logged.map { if (it.id == sessionId) fresh else it }
    }

    // The row leaves the screen and NOTHING is written — withheld means not written, so an Undo can
    // never arrive after the delete. Each delete carries its own clock and settles itself; a second
    // one never settles the first.
    //
    // The clock is KEPT, keyed by the subject it was opened for, because a second window over the
    // same row must take the first one's clock down with it: a clock left running would settle the
    // NEW window early, with its Undo still on the screen.
    fun withhold(deletion: Deletion) {
        val open = WithheldDelete(deletion, untilMs = now() + undoWindowMs)
        withheld = withheld.filterNot { it.subjectId == open.subjectId } + open
        armDelete(open)
    }

    private fun armDelete(open: WithheldDelete) {
        clocks.remove(open.subjectId)?.cancel()
        if (!open.takeable) return
        val seat = owner
        clocks[open.subjectId] = scope.launch {
            delay((open.untilMs - now()).coerceAtLeast(0))
            clocks.remove(open.subjectId)
            val failed = settleWithheld(open.subjectId)
            if (seat == owner) {
                open.deletion.stillThere?.let { tail -> failed?.let { deleteRefused = it.line(tail) } }
            }
        }
    }

    private fun changeHeldSet(sessionId: String, oldId: String, set: TrainingSet?) {
        val held = withheld.firstOrNull {
            val deletion = it.deletion as? Deletion.Set
            deletion?.sessionId == sessionId && deletion.set.id == oldId
        } ?: return
        clocks.remove(oldId)?.cancel()
        if (set == null) {
            withheld = withheld - held
            return
        }
        val updated = held.copy(deletion = Deletion.Set(sessionId, set))
        withheld = withheld.map { if (it == held) updated else it }
        armDelete(updated)
    }

    // One named window, taken back by the WRITE that names its subject again rather than by a tap.
    // Only while nothing has been written: a delete already written is nobody's to take back, and a
    // window that is not open at all is not an error — the day is simply free.
    private fun dropWithheld(subjectId: String) {
        val taking = withheld.firstOrNull { it.subjectId == subjectId && it.takeable } ?: return
        clocks.remove(subjectId)?.cancel()
        withheld = withheld - taking
    }

    // The NEWEST first, and only while nothing has been written: a keep reported over a delete
    // already written would be a lie. Answers with what came back, or null.
    fun keepWithheld(): WithheldDelete? {
        val taking = withheld.lastOrNull { it.takeable } ?: return null
        clocks.remove(taking.subjectId)?.cancel()
        withheld = withheld - taking
        return taking
    }

    // Leaving the ROOM — its disposal, or the app leaving the foreground. The window lives only
    // while the room is on screen in a live process, so everything still the lifter's is LET GO
    // rather than written: the rows come back, nothing is deleted and nothing is said afterwards,
    // because nothing happened. Settling here instead would make `swipe · switch apps · come back`
    // destroy a row with its way back already gone, which is the one thing this whole mechanism
    // exists to prevent; deleting again costs one stroke, and nothing is written to disk to make the
    // decision outlive the process.
    //
    // One thing is left exactly where it is: a delete already being written is nobody's to take
    // back, so it stays in the list until it is answered.
    //
    // Answers whether anything was let go, which is what takes the transient down with it.
    fun abandonWithheld(): Boolean {
        val letting = withheld.filter { it.takeable }
        if (letting.isEmpty()) return false
        for (going in letting) clocks.remove(going.subjectId)?.cancel()
        withheld = withheld - letting.toSet()
        return true
    }

    // One window closing, and the room's clock is the only thing that closes one: leaving abandons
    // instead. The row stops being takeable BEFORE the delete is written and stays in the list until
    // it is answered, either way — a settle cancelled mid-flight leaves the delete still owed, and a
    // settle over the same subject writes it again, because every one of these deletes is idempotent.
    suspend fun settleWithheld(subjectId: String): WriteFailure? {
        val settling = withheld.firstOrNull { it.subjectId == subjectId } ?: return null
        clocks.remove(subjectId)?.cancel()
        withheld = withheld.map { if (it.subjectId == subjectId) it.copy(sent = true) else it }
        val seat = owner
        val failed = send(settling.deletion)
        if (seat != owner) return failed
        withheld = withheld.filterNot { it.subjectId == subjectId && it.untilMs == settling.untilMs }
        return failed
    }

    fun clearDeleteRefused() {
        deleteRefused = null
    }

    // The six deletes behind one window, and they share no shape: a set leaves the replica or a
    // refused import, a routine, a note and a weigh-in leave the replica, a conversation leaves over
    // REST, and a session's discard answers with a bool.
    private suspend fun send(deletion: Deletion): WriteFailure? = when (deletion) {
        is Deletion.Set -> deleteSet(deletion.sessionId, deletion.set.id)
        is Deletion.Routine -> dropRoutine(deletion.routineId)
        is Deletion.Thread -> (coach.deleteThread(deletion.threadId) as? GymResult.Failed)?.why
        is Deletion.Session ->
            if (discard(deletion.sessionId)) null else WriteFailure.NoAnswer
        is Deletion.Note -> deleteNote(deletion.noteId)
        is Deletion.Bodyweight -> {
            deleteWeighIn(deletion.dateLocal)
            null
        }
    }

    // Doubles as the retry for a first page the replica could not answer: with no rows the cursor is
    // absent, which is the top of the log. The cursor is BOTH halves of the sort key, because two
    // sessions can share an instant.
    suspend fun loadOlder() {
        if (older == Older.Loading || older == Older.End) return
        val seat = owner
        older = Older.Loading
        val oldest = logged.lastOrNull()
        val page = tried("gym.loadOlder") { training.sessions(limit = logPage, before = oldest?.startedAtMs, beforeId = oldest?.id) }
        if (seat != owner) return
        if (page == null) {
            older = Older.Failed
            return
        }
        logged = logged + page.filter { fresh -> logged.none { it.id == fresh.id } }
        older = if (page.size < logPage) Older.End else Older.More
    }

    // Nothing is held: the store keeps no copy to invalidate. The replica's answer stands ALONE and
    // a refused import kept on this phone is not merged into it, so a strict refusal cannot change
    // aggregate history.
    suspend fun record(exerciseId: String): GymResult<MovementRecord> {
        val read = training.record(exerciseId)
            ?: return GymResult.Failed(WriteFailure.Refused("that movement is no longer on the log"))
        return GymResult.Ok(read)
    }

    // Whether the old name keeps finding this movement: the alias is a row on the ACCOUNT, so a
    // signed-out movement keeps the signed-out naming promise.
    fun renameKeepsAnAlias(exerciseId: String): Boolean = owner != null

    // The id never moves, so every set, routine line and frozen plan snapshot still points at the
    // same movement. It answers with the movement the replica holds and never the string typed.
    suspend fun rename(exerciseId: String, to: String): GymResult<Exercise> {
        val seat = owner
        val name = to.trim()
        Program.nameProblem(to)?.let { return GymResult.Failed(WriteFailure.Refused(it)) }
        val renamed = try {
            training.renameExercise(exerciseId, name)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.rename", refusing)
            return GymResult.Failed(WriteFailure(refusing))
        }
        if (seat != owner) return GymResult.Failed(WriteFailure.Refused("The account changed while renaming."))
        invalidateProgress()
        catalog = catalog.map { if (it.id == renamed.id) renamed else it } + listOfNotNull(renamed.takeIf { catalog.none { old -> old.id == it.id } })
        return GymResult.Ok(renamed)
    }

    // Both answer with what went wrong: a link that was not made and one still live after a failed
    // revoke are both facts a lifter has to be told.
    suspend fun share(sessionId: String): GymResult<SessionShare> {
        val links = rest() ?: return GymResult.Failed(WriteFailure.Refused(signInFirst))
        return try {
            GymResult.Ok(links.share(sessionId))
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.share", refusing)
            GymResult.Failed(WriteFailure(refusing))
        }
    }

    suspend fun revokeShare(sessionId: String): WriteFailure? {
        val links = rest() ?: return WriteFailure.Refused(signInFirst)
        return try {
            links.revokeShare(sessionId)
            null
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.revokeShare", refusing)
            WriteFailure(refusing)
        }
    }

    private fun changedSet(sessionId: String, oldId: String, set: TrainingSet?) {
        invalidateProgress()
        enginePendingSessions = training.pendingSessionIds()
        changeHeldSet(sessionId, oldId, set)
        closedDetails = closedDetails.mapValues { (_, detail) ->
            if (detail.session.id != sessionId) detail
            else detail.copy(sets = detail.sets.mapNotNull { if (it.id == oldId) set else it })
        }
    }

    private suspend fun loadLog() {
        if (!workoutAuthorized) return
        // Owner and read revision checks prevent an older refresh from replacing current work.
        val seat = owner
        val live = controls.session?.id
        val read = ++logReadRevision
        val page = tried("gym.loadLog") { training.sessions(limit = logPage, before = null, beforeId = null) }
        if (!workoutAuthorized || seat != owner || read != logReadRevision || live != controls.session?.id) return
        if (page == null) {
            // The foot is where an unread log is said; the rows already in hand stay.
            older = Older.Failed
            return
        }
        // A re-read is of the HEAD and does not undo a walk: it can land while a thumb is halfway down
        // the log. The fresh page is authoritative over the span it covers, and every row OLDER than
        // its last one survives, keyed on both halves of the cursor.
        val edge = page.lastOrNull()
        val deeper = logged.filter { held ->
            edge != null && (held.startedAtMs < edge.startedAtMs ||
                (held.startedAtMs == edge.startedAtMs && held.id < edge.id))
        }
        logged = page + deeper
        invalidateProgress()
        shelved = refusedImports()
        // The foot is about the deepest row in hand, so it is recomputed only when this page IS the
        // whole of what is held.
        if (deeper.isEmpty()) older = if (page.size < logPage) Older.End else Older.More

        val open = training.openWorkout()
        if (open == null) {
            // The replica holds no open session, so whatever this phone was holding is over.
            controls.session?.let { controls.close(it.id) }
            controls.flush()
            drawFromControls()
            return
        }
        adopt(open.session, joined = true, readRevision = read)
    }

    private fun adopt(opened: Session, joined: Boolean, readRevision: Long? = null) {
        if (!workoutAuthorized || readRevision != null && readRevision != logReadRevision) return
        controls.hold(opened)
        // A joined session is a list of sets this device may know nothing about, and adopting the row
        // without them would draw an empty workout over a live one.
        if (joined) training.session(opened.id)?.let { detail ->
            val kept = detail.sets.mapTo(mutableSetOf()) { it.id }
            for (set in controls.sets(opened.id)) if (set.id !in kept) controls.drop(set.id)
            controls.hold(detail.session)
            for (set in detail.sets) controls.store(set, detail.session.id)
        }
        controls.flush()
        drawFromControls()
    }

    // Stands at the movement the last set went into, not in the picker. A movement already in hand is
    // re-CHOSEN rather than moved: connect cleared the last-time cache, and re-asking swaps the old
    // seat's answer for this seat's.
    private suspend fun resume() {
        val movement = controls.chosenMovement ?: exerciseId?.takeIf { it in order } ?: LiveOrder.resume(order, sets) ?: return
        choose(movement)
    }

    private fun drawFromControls() {
        session = controls.session
        sets = controls.sets
        // Seeded from the plan and from what has already been performed, so a session joined from
        // another device walks the movements it really holds.
        val merged = LiveOrder.merged(held = controls.order, plan = session?.plan, sets = sets)
        if (merged != controls.order) {
            controls.hold(order = merged)
            controls.flush()
        }
        order = merged
        exerciseId = controls.chosenMovement ?: exerciseId?.takeIf { it in merged }
        // The stalled rows, counted off the replica and never off `saveState`. Signed out nothing is
        // stranded.
        val stalledIds = stalled
        enginePendingSessions = training.pendingSessionIds()
        strandedCount = if (training.anonymous) 0 else sets.count { it.id in stalledIds }
        val status = training.engine.status.state.value
        val blocker = when {
            status.authPaused -> Blocker.SignInLapsed
            !status.online -> Blocker.Offline
            else -> training.deliveryBlocker
        }
        strandedBy = if (strandedCount == 0) null else blocker
        val waiting = enginePendingSessions.isNotEmpty()
        val state = when {
            waiting && !training.anonymous && blocker != null -> SaveState.Blocked(blocker)
            waiting -> SaveState.OnThisDevice
            refusals.isNotEmpty() -> SaveState.Refused(refusals.first().reason)
            training.anonymous -> SaveState.Idle
            else -> SaveState.OnTheLog
        }
        if (state != saveState) settle(state)
        redial()
    }

    private fun redial() {
        prefill = Prefill.of(todaySets, planEntry, lastTime)
        refreshWorkout()
    }

    // The tick is what the note watches, so two sets landing in the same state read as two saves.
    private fun settle(state: SaveState) {
        saveState = state
        saveTick += 1
    }

    // A cancellation is not a failed read: it passes through, or a room being torn down would read as
    // a log that went quiet.
    private suspend fun <T> tried(operation: String, ask: suspend () -> T): T? = try {
        ask()
    } catch (interrupted: CancellationException) {
        throw interrupted
    } catch (failed: Exception) {
        reportFailure(operation, failed)
        null
    }
}

// There is no state for "empty": a log with no rows has no foot.
enum class Older { More, Loading, End, Failed }

sealed interface GymResult<out T> {
    data class Ok<T>(val value: T) : GymResult<T>
    data class Failed(val why: WriteFailure) : GymResult<Nothing>
}

// A log that answered with a REASON is not a log that went quiet: the lifter can act on the first and
// can only wait out the second.
sealed interface WriteFailure {
    data class Refused(val said: String) : WriteFailure   // the log answered, in its own words
    data object NoAnswer : WriteFailure                   // no reply, or one this build couldn't read

    // `subject` is read only when there is no sentence from the log to say instead.
    fun line(subject: String): String = when (this) {
        is Refused -> said
        NoAnswer -> "the log didn’t answer — $subject"
    }
}

fun WriteFailure(refusing: Throwable): WriteFailure = when (refusing) {
    is TrainingRefused -> WriteFailure.Refused(refusing.line)
    is WindmillApiException.Refused -> WriteFailure.Refused(refusing.line)
    else -> WriteFailure.NoAnswer
}

// A row the log no longer holds is not a fix that can be tried again: the row leaves the screen,
// where a `Failed` leaves it standing with the sentence beside it.
sealed interface FixOutcome {
    data class Corrected(val set: TrainingSet) : FixOutcome
    data class Gone(val said: String) : FixOutcome
    data class Failed(val why: WriteFailure) : FixOutcome
}

// `Decided` is the answer either tap gets, including the REPLAY of a decision already taken. `Moved`
// is the routine having changed under the diff; `Settled` is the other decision having been taken
// first; `Gone` leaves nothing to draw. Only `Failed` is worth another tap.
sealed interface ProposalOutcome {
    data class Decided(val proposal: Proposal) : ProposalOutcome
    data class Moved(val said: String) : ProposalOutcome
    data class Settled(val said: String) : ProposalOutcome
    data class Gone(val said: String) : ProposalOutcome
    data class Failed(val why: WriteFailure) : ProposalOutcome
}

sealed interface ProposalRead {
    data class Found(val proposal: Proposal) : ProposalRead
    data object Gone : ProposalRead {
        const val line = "This proposal is no longer available."
    }
}

// `Failed` carries the log's answer the way every other write does, including "that workout is no
// longer on the log", after which the room is standing over no session.
sealed interface FinishOutcome {
    data class Closed(val detail: SessionDetail) : FinishOutcome {
        val session: Session get() = detail.session
    }
    data class Failed(val why: WriteFailure) : FinishOutcome
}

// What is said when a write is refused for good.
sealed interface RefusedWrite {
    // The id of the thing that was refused, so a list can key by it: a row keyed by its POSITION
    // hands the next row its predecessor's swipe state, and a dismissed one never comes back.
    val id: String
    val reason: String
}

// The last copy of the set, so the movement and numbers travel with the reason.
data class RefusedSet(
    override val id: String,
    val exerciseId: String,
    val weightKg: Double,
    val reps: Int,
    override val reason: String,
) : RefusedWrite {
    constructor(set: TrainingSet, reason: String) :
        this(set.id, set.exerciseId, set.weightKg, set.reps, reason)
}

// Any other refused write, named for the banner. The id is the engine notice's, so a dismissal
// sticks and two passes over the same refusal are one loss on the banner.
data class RefusedChange(override val id: String, val name: String, override val reason: String) : RefusedWrite

// How a write reports itself. Silence is a state: a room that has just opened says nothing.
sealed class SaveState {
    data object Idle : SaveState()
    data object OnTheLog : SaveState()          // the account has it
    data object OnThisDevice : SaveState()      // held on purpose: nobody signed in, or the account has not confirmed it yet
    data class Blocked(val by: Blocker) : SaveState()   // signed in, and this is what stops it landing
    data class Refused(val reason: String) : SaveState()

    // "offline" is said only when the transport failed; a 500 and a lapsed session get their own words.
    val line: String?
        get() = when (this) {
            Idle -> null
            OnTheLog -> "on the log"
            OnThisDevice -> "saved on this device"
            is Blocked -> when (by) {
                Blocker.Offline -> "offline · saved here"
                Blocker.LogFailed -> "the log didn’t answer · saved here"
                Blocker.SignInLapsed -> "sign in again · saved here"
            }
            is Refused -> reason
        }
}
