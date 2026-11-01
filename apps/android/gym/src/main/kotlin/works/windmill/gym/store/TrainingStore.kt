package works.windmill.gym.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
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
import works.windmill.gym.domain.LiveOrder
import works.windmill.gym.domain.StatsProgress
import works.windmill.gym.domain.MovementRecord
import works.windmill.gym.domain.Note
import works.windmill.gym.domain.NoteWrite
import works.windmill.gym.domain.PlanEntry
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.ProposalDecision
import works.windmill.gym.domain.ProposalIntent
import works.windmill.gym.domain.ProposalState
import works.windmill.gym.domain.Review
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.sharing.SessionShare
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.WeighIn
import works.windmill.domain.kit.Id
import works.windmill.gym.domain.sync.Exercise as DomainExercise
import works.windmill.gym.domain.sync.LastTime
import works.windmill.gym.domain.sync.Prefill
import works.windmill.gym.net.GymRest
import works.windmill.gym.coach.CoachStore
import works.windmill.gym.coach.LocalCoach
import works.windmill.gym.coach.onboarding.CoachOnboardingStore
import works.windmill.platform.Account
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.schema.Gym

data class RecoveryRead(val origin: String, val userId: String, val identityRevision: Long, val replica: String,
    val workouts: List<ImportRecovery>) {
    fun belongsTo(account: Account): Boolean = account.resolved && account.locallyTrusted && origin == account.origin && userId == account.user?.id && identityRevision == account.identityRevision
}

data class RecoveryDraft(val read: RecoveryRead, val row: ImportRecovery, val copy: SavedWorkout, val markFinished: Boolean = false)

enum class RecoveryAction(val wire: String) { Keep("keep"), Retry("retry"), Fix("fix"), Discard("discard") }
sealed interface RecoveryResult {
    data object Accepted : RecoveryResult
    data class Refused(val line: String) : RecoveryResult
    data object Failed : RecoveryResult
}

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
    undoWindowMs: Long = Withheld.windowMs,
    private val workoutClock: WorkoutClock = WorkoutClock { val at = now(); WorkoutMoment(at, at, "local") },
    private val workoutAuthority: (String?) -> Boolean = { true },
    private val telemetry: Telemetry = Telemetry.None,
    elapsedNanos: () -> Long = System::nanoTime,
    localCoach: LocalCoach? = null,
    coachOnboarding: CoachOnboardingStore? = null,
    private val readDispatcher: CoroutineDispatcher = Dispatchers.Default,
) {
    val coach = CoachStore(
        accountOwner = { owner }, withheldIds = { withheldIds },
        onProgramChanged = { scope.launch { tried("gym.refreshWorkout") { readProgram() } } },
        rest = rest, localCoach = localCoach, telemetry = telemetry, elapsedNanos = elapsedNanos, scope = scope,
        onboarding = coachOnboarding,
    )

    // A refusal is an answer the screen says, never a failure to report.
    private fun reportFailure(operation: String, error: Exception) {
        if (error !is TrainingReadChanged) telemetry.unexpected(operation, error)
    }

    private class TrainingReadChanged : Exception()
    private var engineRefreshes: Channel<Unit>? = null

    private suspend fun <T> readTraining(body: () -> T): T {
        val replica = training.engine.activeReplica()
        val seat = seated
        val holder = owner
        fun changed(): Nothing {
            engineRefreshes?.trySend(Unit)
            throw TrainingReadChanged()
        }
        repeat(3) {
            val (revision, value) = withContext(readDispatcher) {
                training.engine.read(works.windmill.sync.core.ScopeRef.product("gym")) {
                    if (replica != training.engine.activeReplica()) changed()
                    training.engine.readRevision() to body()
                }
            }
            if (replica != training.engine.activeReplica() || seated != seat || owner != holder) changed()
            if (revision == training.engine.readRevision()) return value
        }
        changed()
    }

    private val workoutFacts = MutableStateFlow<WorkoutNotification?>(null)
    val notification = workoutFacts.asStateFlow()
    var rack: WorkoutRack? by mutableStateOf(null)
        private set
    private var hiddenLogger by mutableStateOf(false)
    val loggerHidden: Boolean get() = workoutAuthorized && hiddenLogger
    var workoutFailure: String? by mutableStateOf(null)
        private set
    var workoutOpenRequest by mutableStateOf(0L)
        private set
    var workoutOpenKey: WorkoutKey? by mutableStateOf(null)
        private set
    fun requestWorkout() {
        workoutOpenKey = notification.value?.key ?: return
        workoutOpenRequest += 1
    }
    fun acknowledgeWorkoutRequest() { workoutOpenRequest = 0; workoutOpenKey = null }
    var routinesOpenRequest by mutableStateOf(0L)
        private set
    fun requestRoutines() { routinesOpenRequest += 1 }
    fun acknowledgeRoutinesRequest() { routinesOpenRequest = 0 }
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
    private var workoutReady by mutableStateOf(false)
    private var localWorkoutAuthorized by mutableStateOf(true)
    private val workoutAuthorized: Boolean get() = workoutReady && pendingConnection == null && localWorkoutAuthorized && workoutAuthority(owner) &&
        controls.engineReplica == training.engine.activeReplica()

    suspend fun restoreWorkout(cachedOwner: String?, authorized: Boolean): Boolean {
        if (!authorized) { localWorkoutAuthorized = false; workoutFacts.value = null; return false }
        if (workoutReady) return true
        localWorkoutAuthorized = authorized
        owner = cachedOwner
        try {
            controls.adopt(owner)
            projectEngineReplica()
            preferences = training.settings()
            catalog = training.catalogue()
            readProgram()
            series = training.weighins()
            val movement = controls.chosenMovement
            val previous = if (owner == null && movement != null) readTraining {
                try { training.lastTime(movement) } catch (_: TrainingRefused) { null }
            } else null
            workoutReady = true
            reconcileWorkoutTime()
            exerciseId = controls.chosenMovement
            if (movement != null && previous != null && exerciseId == movement) lastTimes[movement] = previous
            drawFromControls()
        } catch (_: TrainingReadChanged) { return false }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) {
            reportFailure("gym.restoreWorkout", error)
            refuseWorkout()
            return false
        }
        return true
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
                try {
                    training.recoverAcceptedSets(controls)
                    controls.close(live.id)
                } catch (error: Exception) {
                    reportFailure("gym.reconcileWorkoutTime", error)
                    refuseWorkout()
                    return
                }
                lastTimes.clear()
                exerciseId = null
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
        if (!workoutAuthorized || !controls.writable) return WorkoutChange.Unavailable(workoutFailure ?: "The account must be restored first.")
        return try {
            controls.control(controls.workout.editor(open))
            refreshWorkout()
            WorkoutChange.Saved
        } catch (error: Exception) {
            reportFailure("gym.editWorkout", error)
            WorkoutChange.Unavailable(refuseWorkout())
        }
    }

    // Persist the set and consumed offer before the engine commit, retaining both if that commit fails.
    fun acceptSet(command: LogSetCommand): LogSetAcceptance {
        reconcileWorkoutTime()
        if (!workoutAuthorized || isFinishing || !controls.writable) {
            return LogSetAcceptance.Unavailable(workoutFailure ?: "The workout is not ready.")
        }
        return try {
            val accepted = controls.accept(command, workoutClock.now(), ::lastTimeOf, mintSet)
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
        if (!workoutAuthorized || !controls.writable || isFinishing) return WorkoutChange.Unavailable("The workout is not ready.")
        if (key.ownerKey != accountKey || controls.ownerKey != accountKey || controls.session?.id != key.sessionId ||
            workoutFacts.value?.key != key) return WorkoutChange.Stale
        return try {
            controls.control(controls.workout.visibility(hidden))
            refreshWorkout()
            WorkoutChange.Saved
        } catch (error: Exception) {
            reportFailure("gym.showWorkout", error)
            WorkoutChange.Unavailable(refuseWorkout())
        }
    }

    fun setLoggerHidden(key: WorkoutKey, hidden: Boolean): WorkoutChange {
        if (!workoutAuthorized || !controls.writable || isFinishing) return WorkoutChange.Unavailable("The workout is not ready.")
        if (key.ownerKey != accountKey || controls.ownerKey != accountKey || controls.session?.id != key.sessionId ||
            workoutFacts.value?.key != key) return WorkoutChange.Stale
        return try {
            controls.loggerVisibility(hidden)
            hiddenLogger = controls.loggerHidden
            WorkoutChange.Saved
        } catch (error: Exception) {
            reportFailure("gym.logger_visibility", error)
            WorkoutChange.Unavailable(refuseWorkout())
        }
    }

    private fun refreshWorkout() {
        if (!workoutReady) return
        hiddenLogger = controls.loggerHidden
        if (!workoutAuthorized) { workoutFacts.value = null; return }
        val live = controls.session
        if (live == null) {
            rack = null
            workoutFacts.value = null
            return
        }
        val ready = workoutAuthorized && !isFinishing && controls.writable
        val state = try {
            if (controls.writable && workoutAuthorized) controls.prepare(::lastTimeOf, workoutClock.now(), ready, mintSet) else controls.workout
        } catch (error: Exception) {
            reportFailure("gym.refreshWorkout", error)
            refuseWorkout()
            return
        }
        try { training.persistControls(controls) }
        catch (failure: Exception) { reportFailure("gym.workout_controls", failure); refuseWorkout(); return }
        rack = state.rack
        val movement = controls.chosenMovement
        val rows = controls.sets.filterNot { it.id in withheldIds || it.id in deletedSets }
        workoutFacts.value = WorkoutNotification(WorkoutKey(accountKey, live.id), live,
            movement?.let { Readout.movement(it, catalog) } ?: "Choose a movement", rows, state, ready)
    }

    private suspend fun projectEngineReplica(force: Boolean = false) {
        val replica = training.engine.activeReplica()
        training.recoverAcceptedSets(controls)
        if (controls.engineReplica == replica && !force) return
        val (open, delivery) = readTraining { training.openWorkout() to readDelivery() }
        deliveryRead = delivery
        controls.project(replica, open?.session, open?.sets.orEmpty())
        training.restoreControls(controls)
        controls.flush()
    }

    // Before the account changes, confirmed starts settle, the sets they owe follow, and the
    // workout's controls are in the replica the next account's room projects from.
    suspend fun prepareEngineTransition(transitionCurrent: () -> Boolean = { true }) {
        val seat = owner
        val replica = training.engine.activeReplica()
        val controlsReplica = controls.engineReplica
        val drain = EngineTraining(training.engine, writeAuthority = {
            transitionCurrent() && owner == seat && training.engine.activeReplica() == replica && controls.engineReplica == controlsReplica
        })
        drain.recoverAcceptedSets(controls)
        drain.reconcileImports()
        drain.persistControls(controls)
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
    var connectedLogGeneration by mutableStateOf(0L)
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
    // A held last row keeps the chart's existing stance while Undo remains available.
    val allWeighIns: List<WeighIn> get() = (series + withheld.mapNotNull { it.receipt?.weighIn })
        .distinctBy { it.dateLocal }.sortedBy { it.dateLocal }
    // An unread account replica is not an empty series.
    var bodyweightRead by mutableStateOf(false)
        private set
    private val bodyweightWrite = Mutex()
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
            return read.without(heldSessions)
        }
    val accountKey: String get() = Seat.of(owner)

    // The first pull distinguishes an unread notebook from an empty one.
    private val notebookWrite = Mutex()
    private val proposalWrite = Mutex()
    private var notebook: List<Note> by mutableStateOf(emptyList())
    var notesRead by mutableStateOf(false)
        private set
    var noteRefusals: List<RefusedWrite> by mutableStateOf(emptyList())
        private set
    val notes: List<Note> get() = notebook
    val noteCount: Int get() = notebook.size
    // Every proposal this room settled, as the log's receipt said it: a card minted in a conversation
    // reads off this before the copy it was minted with, so a settled one never keeps saying waiting.
    var settledProposals: Map<String, Proposal> by mutableStateOf(emptyMap())
        private set
    private var removalProposals: Map<String, Proposal> by mutableStateOf(emptyMap())
    val unseenRemovalReceipts: Map<String, Proposal> get() = removalProposals.filterValues { !it.isPending }
    private var program: List<Routine> by mutableStateOf(emptyList())
    val allRoutines: List<Routine> get() = program
    var routines: List<Routine>
        get() = program
        private set(value) { program = value }
    // The proposals the log would refuse to apply: the domain's rule over the routine as the engine holds and
    // confirms it, read with the program so the two never disagree.
    var outOfDateProposals: Set<String> by mutableStateOf(emptySet())
        private set
    private suspend fun readProgram() {
        val (program, outdated) = readTraining { training.program() to training.outOfDateProposals() }
        routines = program
        outOfDateProposals = outdated
    }
    var logged: List<SessionSummary> by mutableStateOf(emptyList())      // the account's pages, newest first
        private set
    private val logRead = Mutex()
    var recovery: RecoveryRead? by mutableStateOf(null)
        private set
    var recoveryDraft: RecoveryDraft? by mutableStateOf(null)
        private set
    var recoveryBusy: Boolean by mutableStateOf(false)
        private set
    @Volatile private var recoveryOwnerVersion = 0L
    private var recoveryAction: Any? = null

    private fun resetRecovery() {
        recoveryOwnerVersion += 1
        recovery = null
        recoveryDraft = null
        recoveryAction = null
        recoveryBusy = false
    }

    private suspend fun readRecovery() {
        val account = seated ?: return
        val user = account.user ?: return
        val read = readTraining { RecoveryRead(account.origin, user.id, account.identityRevision,
            training.engine.activeReplica(), training.imports.reviewWorkouts()) }
        if (seated?.let(read::belongsTo) == true) recovery = read
    }

    private fun recoverySeat(read: RecoveryRead): Boolean = workoutReady && pendingConnection == null && localWorkoutAuthorized &&
        seated?.let(read::belongsTo) == true && controls.engineReplica == read.replica

    fun beginRecoveryFix(read: RecoveryRead, row: ImportRecovery): Boolean {
        if (recoveryBusy || !recoverySeat(read)) return false
        val copy = row.workout ?: return false
        recoveryDraft = RecoveryDraft(read, row, copy)
        return true
    }

    fun changeRecoveryFix(opening: RecoveryDraft, copy: SavedWorkout, markFinished: Boolean = opening.markFinished) {
        if (recoveryBusy || recoveryDraft !== opening) return
        recoveryDraft = opening.copy(copy = copy, markFinished = markFinished)
    }

    fun closeRecoveryFix() { if (!recoveryBusy) recoveryDraft = null }

    suspend fun recoveryFixRefusal(draft: RecoveryDraft): String? = try {
        readTraining { training.imports.preview(draft.row.openings.single(), draft.copy, draft.markFinished, now()) }
    } catch (_: TrainingReadChanged) { "account-changed" }
    catch (refused: TrainingRefused) { refused.code }
    catch (cancelled: CancellationException) { throw cancelled }
    catch (failure: Exception) {
        reportFailure("gym_import_fix", failure)
        "recovery-unavailable"
    }

    suspend fun recover(read: RecoveryRead, row: ImportRecovery, action: RecoveryAction,
        draft: RecoveryDraft? = null, currentOwner: () -> Boolean = { true }): RecoveryResult? {
        if (recoveryBusy || row.adding) return null
        if (action == RecoveryAction.Discard && (row.operationsOnly || row.workout == null || row.refusals.any { it.code in setOf("source-unreadable", "source-needs-update") })) return RecoveryResult.Refused("This copy cannot be discarded here.")
        val version = recoveryOwnerVersion
        fun owns(): Boolean = recoveryOwnerVersion == version && currentOwner() && recoverySeat(read)
        fun allowed(): Boolean = owns() && workoutAuthority(owner)
        if (!owns()) return null
        val token = Any()
        recoveryAction = token
        recoveryBusy = true
        return scope.async {
            try {
                if (!allowed()) return@async null
                withContext(readDispatcher) {
                    when (action) {
                        RecoveryAction.Discard -> row.openings.single().let { training.imports.discardRefusal(it.id, it, ::allowed) }
                        RecoveryAction.Retry -> row.openings.forEach { if (row.operationsOnly) training.imports.retryOperation(it, ::allowed) else training.imports.retry(it.id, it, ::allowed) }
                        RecoveryAction.Keep -> training.imports.keepWorkout(row.id, row.openings.single(), ::allowed)
                        RecoveryAction.Fix -> {
                            val fixed = requireNotNull(draft)
                            check(fixed.read == read && fixed.row == row)
                            val opening = row.openings.single()
                            val refused = training.imports.preview(opening, fixed.copy, fixed.markFinished, now())
                            if (refused != null) throw TrainingRefused(refused, WorkoutImports.reason(refused))
                            if (row.workout?.session?.isOpen == true) {
                                if (fixed.copy.session.isOpen) training.imports.replaceOpenAndRetry(row.id, fixed.copy, opening, ::allowed)
                                else training.imports.keepWorkout(row.id, opening, ::allowed, fixed.copy)
                            } else training.imports.replaceAndRetry(row.id, fixed.copy, fixed.markFinished, opening = opening, allowed = ::allowed)
                        }
                    }
                    if (action != RecoveryAction.Discard) training.imports.refusals().firstOrNull { failure ->
                        row.openings.any { it.id == failure.id }
                    }?.let { throw TrainingRefused(it.code, it.reason) }
                }
                if (!owns()) return@async null
                telemetry.event("gym_import_recovery", mapOf("action" to action.wire, "outcome" to if (action == RecoveryAction.Discard) "ok" else "completed"))
                if (action == RecoveryAction.Fix) recoveryDraft = null
                tried("gym.loadLog") { refreshEngine() }
                if (!owns()) return@async null
                RecoveryResult.Accepted
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (refused: TrainingRefused) {
                if (!owns()) return@async null
                telemetry.event("gym_import_recovery", mapOf("action" to action.wire, "outcome" to "refused"))
                RecoveryResult.Refused(refused.line)
            } catch (failure: Exception) {
                reportFailure("gym_import_${action.wire}", failure)
                if (!owns()) return@async null
                telemetry.event("gym_import_recovery", mapOf("action" to action.wire, "outcome" to "failed"))
                RecoveryResult.Failed
            } finally {
                if (recoveryAction === token) { recoveryAction = null; recoveryBusy = false }
            }
        }.await()
    }

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
    // The movement in hand's last time, as `lastTimeOf` answers it.
    val lastTime: LastTime? get() = exerciseId?.let(::lastTimeOf)
    // Sparse: the absence of a key is `never logged`. NULL is the map that has not been read; an
    // EMPTY map is an answer, that this lifter has trained nothing.
    var lastSets: Map<String, LastSet>? by mutableStateOf(null)
        private set
    var prefill: Prefill by mutableStateOf(Prefill())
        private set
    var refusals: List<RefusedWrite> by mutableStateOf(emptyList())      // writes the log refused
        private set
    // Weight receipts project engine holds; workout recovery remains room-owned.
    var withheld: List<WithheldDelete> by mutableStateOf(emptyList())
        private set
    private val clocks = mutableMapOf<String, Job>()
    // How long a delete stays takeable. The room that shows the Undo sets it to the system's
    // accessibility timeout; the store stamps every instant from its own clock.
    var undoWindowMs: Long = undoWindowMs
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

    var replicaReadRevision by mutableStateOf(-1L)
        private set
    val workoutReplica: String? get() = controls.engineReplica
    val accountReady: Boolean get() = workoutAuthorized && !isLoading
    private var logReadReady by mutableStateOf(false)
    val initialGymEmpty: Boolean? get() = if (accountReady && logReadReady)
        program.isEmpty() && allSessions.isEmpty() && session == null else null
    val canFinish: Boolean get() = workoutAuthorized && session != null && !isFinishing

    private var seated: Account? = null
    private var pendingConnection: Account? by mutableStateOf(null)
    private var connecting = false
    // Whose the replica in hand is: the account id, or null for the signed-out seat.
    private var owner: String? = null
    private var closedDetails by mutableStateOf<Map<String, SessionDetail>>(emptyMap())
    private val lastTimes = mutableStateMapOf<String, LastTime>()
    private var resumePending = false
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
    private data class DeliveryRead(val pending: Set<String> = emptySet(), val confirmed: Map<String, TrainingSet> = emptyMap())
    private var deliveryRead by mutableStateOf(DeliveryRead())
    private fun readDelivery(): DeliveryRead {
        val pending = training.pendingSetIds()
        return DeliveryRead(pending, training.details().flatMap { it.sets }.filterNot { it.id in pending }.associateBy { it.id })
    }
    val stalled: Set<String>
        get() = deliveryRead.pending + sets.filter { deliveryRead.confirmed[it.id] != it }.map { it.id }
    val deviceOnlySessionIds: Set<String>
        get() = shelved.mapTo(mutableSetOf()) { it.id } + enginePendingSessions

    // A pending removal remains reviewable even when pull gets ahead of its command receipt.
    val pendingProposals: List<Proposal>
        get() = (routines.mapNotNull { it.pendingProposal } + removalProposals.values.filter { it.isPending })
            .distinctBy { it.id }.sortedByDescending { it.createdAtMs }

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

    fun eraseDeletedOwner(account: String, replica: String) {
        controls.eraseOwner(account, replica)
        if (owner == account) {
            localWorkoutAuthorized = false
            workoutReady = false
            workoutFacts.value = null
            session = null
            rack = null
            sets = emptyList()
            order = emptyList()
            exerciseId = null
            pendingConnection = null
            resumePending = false
            acknowledgeWorkoutRequest()
        }
        coach.eraseOwner(account)
    }

    // Called on launch and on every change of who is signed in. A re-read with the same account
    // preserves open deletion windows.
    suspend fun connect(account: Account) {
        if (!account.resolved) return
        if (!workoutAuthority(account.user?.id)) {
            if (!workoutAuthorized) workoutFacts.value = null
            return
        }
        val sameWeightSeat = seated?.let {
            it.origin == account.origin && it.user?.id == account.user?.id && it.identityRevision == account.identityRevision
        } == true
        val arriving = seated != account
        if (!sameWeightSeat) resetRecovery()
        seated = account
        owner = account.user?.id
        localWorkoutAuthorized = account.locallyTrusted
        pendingConnection = account
        resumePending = true
        if (arriving) {
            logReadReady = false
            isLoading = true
            workoutReady = false
            workoutFacts.value = null
            session = null
            rack = null
            sets = emptyList()
            exerciseId = null
            catalog = emptyList()
            program = emptyList()
            preferences = GymPreferences()
            series = emptyList()
            removalProposals = emptyMap()
            settledProposals = emptyMap()
            refusals = emptyList()
            logged = emptyList()
            shelved = emptyList()
            older = Older.More
            deliveryRead = DeliveryRead()
            enginePendingSessions = emptySet()
            bodyweightRead = false
            progressRevision += 1
            progressCache = null
            progressFailure = null
            progressLoading = false
            lastTimes.clear()
            lastSets = null
            closedDetails = emptyMap()
            for (clock in clocks.values) clock.cancel()
            clocks.clear()
            withheld = if (sameWeightSeat) withheld.filter { it.receipt != null } else emptyList()
            deleteRefused = null
            deletedSets = emptySet()
            notebook = emptyList()
            notesRead = false
            noteRefusals = emptyList()
            coach.resetThreads()
            connectedLog = ConnectedLogState.Unknown
            connectedRead += 1
            connectedLogGeneration += 1
        }
        if (connecting) return
        connecting = true
        try {
            check(controls.writable) { "Restart the app to recover the saved workout." }
            controls.adopt(owner)
            projectEngineReplica(force = arriving || isLoading)
            if (seated != account) return
            if (arriving && sameWeightSeat) refreshHeldWeights()
            preferences = training.settings()
            catalog = training.catalogue()
            readProgram()
            series = training.weighins()
            removalProposals = training.removalProposals()
            settledProposals = unseenRemovalReceipts
            pendingConnection = null
            workoutReady = true
            reconcileWorkoutTime()
            drawFromControls()
            isLoading = false

            val seat = owner
            shelved = tried("gym.loadLog") { refusedImports() } ?: return
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
        } catch (_: TrainingReadChanged) {
            // The observer resumes the pending connection after the superseding engine revision.
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            reportFailure("gym.connect", error)
            if (seated == account) {
                pendingConnection = null
                authorizeWorkout(false)
                refuseWorkout()
                isLoading = false
            }
        } finally {
            connecting = false
            if (pendingConnection != null) engineRefreshes?.trySend(Unit)
        }
    }

    private fun shelfDetail(id: String): SessionDetail? =
        training.imports.refusals().firstOrNull { it.id == id }?.let { refused ->
            refused.session?.let { SessionDetail(it, refused.sets) }
        } ?: training.imports.pendingFinished().firstOrNull { it.session.id == id }?.let { row ->
            SessionDetail(row.session, row.sets.filterNot { it.id in row.deleted })
        }

    private suspend fun refusedImports(): List<SessionSummary> = readTraining {
        val drawn = training.details().mapTo(mutableSetOf()) { it.session.id }
        training.imports.refusals().mapNotNull { refused -> refused.session?.let { session ->
            SessionSummary(session, refused.sets, catalog)
        } }.filterNot { it.id in drawn }
    }

    private var engineObservation: Job? = null

    fun observeEngine(): Job {
        engineObservation?.let { return it }
        val engine = training.engine
        val refreshes = Channel<Unit>(Channel.CONFLATED)
        engineRefreshes = refreshes
        engineObservation = scope.launch {
            for (ignored in refreshes) tried("gym.refreshWorkout") { refreshEngine() }
        }
        scope.launch { engine.status.state.collect { refreshes.trySend(Unit) } }
        scope.launch { engine.notices("gym").notices.collect { refreshes.trySend(Unit) } }
        scope.launch { engine.offers.offers.collect { refreshes.trySend(Unit) } }
        for (type in listOf("exercise", "exerciseName", "routine", "routineCreation", "session", "set", "prefs", "note", "weighin", "proposal"))
            scope.launch { engine.records(works.windmill.sync.core.ScopeRef.product("gym"), type).state.collect { refreshes.trySend(Unit) } }
        return requireNotNull(engineObservation)
    }

    suspend fun retryImport(id: String) {
        training.imports.retry(id)
        training.reconcileImports()
    }

    suspend fun refreshEngine() {
        if (!workoutAuthority(owner)) return
        pendingConnection?.let { account ->
            if (!connecting) connect(account)
            return
        }
        if (controls.engineReplica != training.engine.activeReplica()) return
        val seat = owner
        tried("gym.import_reconcile") { training.reconcileImports() }
        if (training.firstPullComplete && !training.anonymous) training.imports.retireStartSources()
        if (seat != owner) return
        replicaReadRevision = training.engine.readRevision()
        refusals = training.refusedWrites()
        loadLog()
        if (seat != owner) return
        val details = tried("gym.refreshWorkout") { readTraining { training.details() } } ?: return
        for (detail in details) {
            // A refused delete puts its row back in the replica; an older screen must draw it again.
            deletedSets = deletedSets - detail.sets.map { it.id }.toSet()
            if (!detail.session.isOpen && detail.session.id in closedDetails) retainClosed(detail)
        }
        catalog = training.catalogue()
        if (tried("gym.refreshWorkout") { readProgram(); true } != true) return
        removalProposals = training.removalProposals()
        settledProposals = settledProposals + unseenRemovalReceipts
        preferences = training.settings()
        notebookWrite.withLock {
            if (seat != owner) return@withLock
            notebook = training.notes()
            notesRead = training.notesReady
            noteRefusals = training.refusedNotes()
        }
        bodyweightWrite.withLock {
            if (seat != owner) return@withLock
            loadBodyweight()
            refreshHeldWeights()
        }
        if (lastSetsWanted) loadLastSets()
        if (progressWanted) loadProgress(force = true)
        if (!controls.writable) return
        drawFromControls()
        if (resumePending) resume() else readLastTime()
    }

    // The domain action freezes the routine into the session as it starts.
    suspend fun start(routineId: String): GymResult<Session> {
        if (!workoutAuthorized || !controls.writable) return GymResult.Failed(WriteFailure.Refused(workoutFailure ?: "The account must be restored first."))
        val seat = owner
        return try {
            training.recoverAcceptedSets(controls)
            val opened = training.startSession(SessionStart(id = mintSession(), startedAt = now(), routineId = routineId), requireRoutine = true)
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
        redial()

        readLastTime()
    }

    private suspend fun readLastTime() {
        val movement = exerciseId ?: return
        if (!workoutAuthorized || lastTimes[movement]?.isComplete == true) return
        val seat = owner
        val sessionId = session?.id
        val answer = try { readTraining { training.lastTime(movement) } }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { reportFailure("gym.choose", failure); return }
        if (!workoutAuthorized || owner != seat || session?.id != sessionId) return
        lastTimes[movement] = answer
        if (exerciseId == movement) redial()
    }

    // A movement's last time as this workout has read it, unread until the movement is first chosen and its read answers.
    fun lastTimeOf(movement: String): LastTime = lastTimes[movement] ?: LastTime(Id(movement, DomainExercise), isComplete = false)

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
            redial()
        }
        return true
    }

    // Read when the picker OPENS and never on a keystroke. A replica that has not been read for the
    // account leaves the map alone: `never logged` is an assertion, and half an answer would make it
    // about every movement the half did not name.
    suspend fun loadLastSets() {
        lastSetsWanted = true
        val served = tried("gym.loadLastSets") { readTraining { training.lastSets() } } ?: return
        lastSets = served.associateBy { it.exerciseId }
    }

    suspend fun logSet(weightKg: Double, reps: Int) {
        if (!workoutAuthorized || session == null || exerciseId == null || isFinishing) return
        if (editRack(weightKg, reps) !is WorkoutChange.Saved) return
        val offer = notification.value?.offer ?: return
        acceptSet(LogSetCommand(offer.key, offer.id))
    }

    // Finishing closes the workout in the replica, which carries the close to the account behind
    // every set this session holds.
    suspend fun finish(): FinishOutcome {
        if (!workoutAuthorized) return FinishOutcome.Failed(WriteFailure.Refused("The account must be restored first."))
        if (isFinishing) return FinishOutcome.Failed(WriteFailure.Refused("this workout is already finishing"))
        val live = session ?: return FinishOutcome.Failed(WriteFailure.NoAnswer)
        val seat = owner
        isFinishing = true
        try {
            training.recoverAcceptedSets(controls)
            refreshWorkout()
            val detail = try {
                training.finishSession(live.id, now())
                checkNotNull(training.session(live.id)) { "The engine does not hold the workout it just finished." }
            } catch (refused: TrainingRefused) {
                if (refused.code != "unknown-record") throw refused
                null
            }
            if (!workoutAuthorized || seat != owner) return FinishOutcome.Failed(WriteFailure.Refused("the account changed while finishing"))
            if (detail != null) retainClosed(detail)
            controls.close(live.id)
            controls.flush()
            lastTimes.clear()
            exerciseId = null
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
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (error: Exception) {
            reportFailure("gym.finish", error)
            if (!workoutAuthorized || seat != owner) return FinishOutcome.Failed(WriteFailure.Refused("the account changed while finishing"))
            return FinishOutcome.Failed(WriteFailure(error))
        } finally {
            isFinishing = false
            refreshWorkout()
        }
    }

    fun retainedSession(detail: SessionDetail): SessionDetail = closedDetails[detail.session.id] ?: detail

    suspend fun finishedSession(sessionId: String): GymResult<SessionDetail?> {
        val seat = owner
        val replica = controls.engineReplica
        if (!accountReady || replica == null || replica != training.engine.activeReplica() || (seat == null) != training.anonymous)
            return GymResult.Failed(WriteFailure.Refused(accountChanged))
        val detail = try { readTraining { shelfDetail(sessionId) ?: training.restoredSession(sessionId) } }
        catch (_: TrainingReadChanged) { return GymResult.Failed(WriteFailure.Refused(accountChanged)) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            reportFailure("gym.loadLog", failure)
            return GymResult.Failed(WriteFailure.NoAnswer)
        }
        if (!accountReady || seat != owner || replica != controls.engineReplica || replica != training.engine.activeReplica() ||
            (seat == null) != training.anonymous) return GymResult.Failed(WriteFailure.Refused(accountChanged))
        if (detail == null) closedDetails = closedDetails - sessionId
        else if (!detail.session.isOpen) retainClosed(detail)
        return GymResult.Ok(detail)
    }

    private fun retainClosed(detail: SessionDetail) {
        closedDetails = closedDetails + (detail.session.id to detail)
    }

    // The log refuses to delete a session somebody may still be logging into.
    suspend fun discard(sessionId: String): Boolean = discardWorkout(sessionId) == null

    private data class WorkoutDiscardKey(val account: String, val replica: String?, val anonymous: Boolean, val sessionId: String)
    private val workoutDiscards = mutableMapOf<WorkoutDiscardKey, kotlinx.coroutines.Deferred<WriteFailure?>>()

    suspend fun discardWorkout(sessionId: String, screen: String = "session",
        expectedReplica: String? = controls.engineReplica, expectedAnonymous: Boolean = owner == null): WriteFailure? {
        val key = WorkoutDiscardKey(accountKey, expectedReplica, expectedAnonymous, sessionId)
        workoutDiscards[key]?.let { return it.await() }
        val seat = owner
        val replica = expectedReplica
        val job = scope.async(start = CoroutineStart.UNDISPATCHED) {
            var accepted = false
            val failure = try {
                run write@{
                    if (!workoutAuthorized || seat != owner || replica == null || replica != controls.engineReplica || expectedAnonymous != (owner == null)) return@write WriteFailure.Refused(accountChanged)
                    if (shelfDetail(sessionId) != null) {
                        training.imports.discardRefusal(sessionId)
                        accepted = true
                        invalidateProgress()
                        if (controls.writable) {
                            controls.close(sessionId)
                            controls.flush()
                            drawFromControls()
                        }
                        shelved = refusedImports()
                        return@write null
                    }
                    training.discardSession(sessionId, replica, expectedAnonymous)
                    accepted = true
                    if (seat != owner) return@write null
                    invalidateProgress()
                    logged = logged.filterNot { it.id == sessionId }
                    closedDetails = closedDetails - sessionId
                    if (controls.writable) {
                        controls.close(sessionId)
                        controls.flush()
                        drawFromControls()
                    }
                    loadLog()
                    null
                }
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (failure: Exception) {
                reportFailure("gym.discard", failure)
                if (accepted) null else WriteFailure(failure)
            }
            if (accepted && seat == owner && session?.id == sessionId) {
                session = null
                sets = emptyList()
                order = emptyList()
                exerciseId = null
                rack = null
                workoutFacts.value = null
                if (!controls.writable) refuseWorkout()
            }
            telemetry.event("gym_action", mapOf("screen" to screen, "action" to "discard", "outcome" to when (failure) {
                null -> "ok"
                is WriteFailure.Refused -> "refused"
                else -> "failed"
            }))
            failure
        }
        workoutDiscards[key] = job
        job.invokeOnCompletion { if (workoutDiscards[key] === job) workoutDiscards.remove(key) }
        return job.await()
    }

    suspend fun saveRoutine(draft: RoutineDraft, expectedAccountKey: String = accountKey,
        expectedReplica: String? = editReplica): GymResult<Routine> {
        val seat = owner
        val replica = expectedReplica
        return scope.async(start = CoroutineStart.UNDISPATCHED) {
            val result = try {
                if (!workoutAuthorized) throw TrainingRefused("account-changed", accountChanged)
                if (Program.nameProblem(draft.name) == Program.nameTooLong) throw TrainingRefused("invalid", Program.nameTooLong)
                if (Program.named(draft.name) == null) throw TrainingRefused("invalid", "a routine needs a name")
                if (draft.entries.isEmpty()) throw TrainingRefused("invalid", "a routine needs at least one movement")
                if (draft.id != null && draft.original?.expectedRevision == null)
                    throw TrainingRefused("stale", "reopen this routine before saving — its original revision is missing")
                if (expectedAccountKey != accountKey || seat != owner || replica == null || replica != controls.engineReplica)
                    throw TrainingRefused("account-changed", accountChanged)
                val prepared = if (draft.id == null && draft.creationId == null) draft.copy(creationId = mintRoutine()) else draft
                GymResult.Ok(training.saveRoutinePlan(prepared, replica, seat == null))
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (failure: Exception) {
                reportFailure("gym.saveRoutine", failure)
                GymResult.Failed(WriteFailure(failure))
            }
            val outcome = when (result) {
                is GymResult.Ok -> "ok"
                is GymResult.Failed -> if (result.why is WriteFailure.Refused) "refused" else "failed"
            }
            telemetry.event("gym_action", mapOf("screen" to "routine_editor", "action" to "save", "outcome" to outcome))
            when (result) {
                is GymResult.Failed -> result
                is GymResult.Ok -> {
                    val accepted = result.value
                    telemetry.event("gym_routine_saved", mapOf("action" to if (draft.id == null) "create" else "update"))
                    if (seat == owner && replica == controls.engineReplica && replica == training.engine.activeReplica() &&
                        training.anonymous == (seat == null)) {
                        routines = program.filterNot { it.id == accepted.routine.id } + accepted.routine
                        catalog = (catalog.filterNot { existing -> accepted.movements.any { it.id == existing.id } } + accepted.movements)
                            .sortedWith(compareBy({ it.pattern }, { it.name }, { it.id }))
                    }
                    GymResult.Ok(accepted.routine)
                }
            }
        }.await()
    }

    // The sessions that named it keep every set and their frozen plan: a snapshot is a copy, not a
    // reference. A routine already gone is a deletion that succeeded.
    suspend fun dropRoutine(id: String, replica: String? = controls.engineReplica, anonymous: Boolean = owner == null): WriteFailure? {
        if (!workoutAuthorized) return WriteFailure.Refused(accountChanged)
        val seat = owner
        return try {
            training.deleteRoutine(id, replica ?: return WriteFailure.Refused(accountChanged), anonymous)
            if (seat != owner) return WriteFailure.Refused(accountChanged)
            routines = program.filterNot { it.id == id }
            null
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.dropRoutine", refusing)
            if (seat != owner) return WriteFailure.Refused(accountChanged)
            if (refusing is TrainingDeleteUnconfirmed) tried("gym.readProgram") { readProgram() }
            if ((refusing as? TrainingRefused)?.code == "unknown-record") {
                routines = program.filterNot { it.id == id }
                null
            } else {
                WriteFailure(refusing)
            }
        }
    }

    // Pending removals and unshown receipts remain readable after their synced rows disappear.
    suspend fun proposal(id: String): ProposalRead {
        return (training.proposal(id) ?: training.removalReceipts()[id] ?: settledProposals[id])?.let { ProposalRead.Found(it) } ?: ProposalRead.Gone
    }

    fun removalPending(id: String): Boolean = training.removalPending(id)

    fun proposalReceiptShown(proposal: Proposal, seat: String) {
        if (seat != accountKey) return
        try {
            if (training.removalReceiptShown(proposal, controls.engineReplica ?: return)) {
                settledProposals = settledProposals + (proposal.id to proposal)
                telemetry.event("gym_proposal_receipt_shown", mapOf("outcome" to "applied"))
            }
            removalProposals = training.removalProposals()
        } catch (failure: Exception) {
            reportFailure("gym.proposal_receipt_shown", failure)
        }
    }

    // Atomic against the base the diff was written on. Nothing here merges, retries or applies part
    // of a diff; the decision is drawn only from the log's receipt.
    suspend fun applyProposal(id: String): ProposalOutcome = decide(id, applying = true)

    suspend fun dismissProposal(id: String): ProposalOutcome = decide(id, applying = false)

    private suspend fun decide(id: String, applying: Boolean): ProposalOutcome {
        if (!workoutAuthorized) return ProposalOutcome.Failed(WriteFailure.Refused(accountChanged))
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
        removalProposals = training.removalProposals()
        return ProposalOutcome.Decided(settled)
    }

    // A refusal means this room's picture is stale, so the routines are re-read before the sentence
    // is said. A decision the log did not answer, or one that needs a fresh sign-in, leaves the list
    // alone, because nothing was decided.
    private suspend fun refused(error: Throwable): ProposalOutcome {
        val refusal = error as? TrainingRefused
        if (refusal == null || refusal.code == "sign-in") return ProposalOutcome.Failed(WriteFailure(error))
        if (tried("gym.refreshWorkout") { readProgram(); true } != true) return ProposalOutcome.Failed(WriteFailure.NoAnswer)
        return when (refusal.code) {
            Gym.Codes.proposalSuperseded -> ProposalOutcome.Moved(refusal.line)
            "unknown-record" -> ProposalOutcome.Gone("that proposal is no longer on the log")
            else -> ProposalOutcome.Settled(refusal.line)
        }
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
        val replica = training.engine.activeReplica()
        val credentials = rest()
        if (seat == null) {
            connectedLog = ConnectedLogState.None
            return connectedLog
        }
        if (credentials == null) {
            connectedLog = ConnectedLogState.Refused
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
            if (refusing == WindmillApiException.Offline) ConnectedLogState.Offline else ConnectedLogState.Refused
        }
        if (seat != owner || replica != training.engine.activeReplica() || request != connectedRead) return ConnectedLogState.Refused
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
        if (!workoutAuthorized) return GymResult.Failed(WriteFailure.Refused(accountChanged))
        val seat = owner
        val result: GymResult<Note> = notebookWrite.withLock {
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
        telemetry.event("gym_action", mapOf("screen" to "note_editor", "action" to "save",
            "outcome" to when (result) {
                is GymResult.Ok -> "ok"
                is GymResult.Failed -> if (result.why is WriteFailure.Refused) "refused" else "failed"
            }))
        return result
    }

    // A note already gone answers as success: the row goes either way.
    suspend fun deleteNote(id: String, replica: String? = controls.engineReplica, anonymous: Boolean = owner == null): WriteFailure? {
        if (!workoutAuthorized) return WriteFailure.Refused(accountChanged)
        val seat = owner
        return notebookWrite.withLock {
            if (seat != owner) return@withLock WriteFailure.Refused(accountChanged)
            try {
                training.deleteNote(id, replica ?: return@withLock WriteFailure.Refused(accountChanged), anonymous)
                if (seat != owner) return@withLock WriteFailure.Refused(accountChanged)
                notebook = notebook.filterNot { it.id == id }
                null
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure("gym.deleteNote", refusing)
                if (seat != owner) return@withLock WriteFailure.Refused(accountChanged)
                if (refusing is TrainingDeleteUnconfirmed) tried("gym.readNotes") { notebook = training.notes() }
                if ((refusing as? TrainingRefused)?.code != "unknown-record") return@withLock WriteFailure(refusing)
                notebook = notebook.filterNot { it.id == id }
                null
            }
        }
    }

    // A drop moves its one note below the drawn neighbor.
    suspend fun reorderNotes(moved: String, drawn: List<String>): GymResult<List<Note>> {
        if (!workoutAuthorized) return GymResult.Failed(WriteFailure.Refused(accountChanged))
        val seat = owner
        return notebookWrite.withLock {
            if (seat != owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
            try {
                val changed = training.moveNote(moved, drawn, withheldIds)
                if (seat != owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                val written = training.notes()
                notebook = written
                if (changed) telemetry.event("gym_note_moved")
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
    suspend fun create(name: String, equipment: String, id: String = mintExercise(), loadCount: Int? = null,
        expectedReplica: String? = controls.engineReplica, expectedSession: String? = null): GymResult<Exercise> {
        if (!workoutAuthorized) return GymResult.Failed(WriteFailure.Refused(accountChanged))
        val named = Program.named(name)
            ?: return GymResult.Failed(WriteFailure.Refused("a movement needs a name"))
        if (Program.length(named) > Program.maxNameLength || equipment !in Exercise.loadings + "other" ||
            loadCount != null && (loadCount !in 1..2 || equipment != "dumbbell" && loadCount != 1)) {
            return GymResult.Failed(WriteFailure.Refused("check the movement name and equipment"))
        }
        val write = ExerciseWrite(id, named, Exercise.unclassified, equipment, loadCount = loadCount)
        val seat = owner
        return try {
            val made = training.createExercise(write, expectedReplica ?: return GymResult.Failed(WriteFailure.Refused(accountChanged)),
                seat == null, expectedSession)
            if (seat != owner || expectedReplica != controls.engineReplica || expectedReplica != training.engine.activeReplica()) return GymResult.Failed(WriteFailure.Refused("the account changed while creating"))
            catalog = catalog.filterNot { it.id == made.id } + made
            if (made.id != write.id || made.name != works.windmill.gym.domain.sync.ExerciseRules.name.apply(write.name, works.windmill.domain.kit.Path("name")) || made.equipment != write.equipment || made.pattern != write.pattern ||
                write.loadCount != null && made.loadCount != write.loadCount) {
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

    private data class MovementCreationKey(val account: String, val replica: String?, val workout: String, val id: String)
    private val movementCreations = mutableMapOf<MovementCreationKey,
        Pair<ExerciseWrite, kotlinx.coroutines.Deferred<MovementCreateOutcome>>>()

    suspend fun createForWorkout(write: ExerciseWrite, workoutId: String,
        expectedAccountKey: String = accountKey, expectedReplica: String? = controls.engineReplica): MovementCreateOutcome {
        val key = MovementCreationKey(expectedAccountKey, expectedReplica, workoutId, write.id)
        movementCreations[key]?.let { (submitted, pending) ->
            if (submitted != write) return MovementCreateOutcome.Failed(WriteFailure.Refused("Creation is already in progress."))
            return pending.await()
        }
        val seat = owner
        val openingAccount = seated
        val job = scope.async(start = CoroutineStart.UNDISPATCHED) {
            fun current() = workoutAuthorized && seated == openingAccount && expectedAccountKey == accountKey && seat == owner &&
                expectedReplica != null && expectedReplica == controls.engineReplica &&
                expectedReplica == training.engine.activeReplica() && session?.id == workoutId
            val known = catalog.any { it.id == write.id }
            if (!current()) {
                telemetry.event("gym_action", mapOf("screen" to "movement_form", "action" to if (known) "add" else "create",
                    "outcome" to "refused"))
                return@async MovementCreateOutcome.Failed(WriteFailure.Refused(accountChanged))
            }
            val created = create(write.name, write.equipment, write.id, write.loadCount, expectedReplica, workoutId)
            if (!known) telemetry.event("gym_action", mapOf("screen" to "movement_form", "action" to "create",
                "outcome" to when (created) {
                    is GymResult.Ok -> "ok"
                    is GymResult.Failed -> if (created.why is WriteFailure.Refused) "refused" else "failed"
                }))
            if (created is GymResult.Failed) return@async MovementCreateOutcome.Failed(created.why)
            val movement = (created as GymResult.Ok).value
            val result = try {
                if (!current()) MovementCreateOutcome.Failed(WriteFailure.Refused(accountChanged), movement)
                else {
                    choose(movement.id)
                    MovementCreateOutcome.Added(movement)
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                reportFailure("gym.choose", failure)
                if (!controls.writable) refuseWorkout()
                MovementCreateOutcome.Failed(WriteFailure(failure), movement)
            }
            telemetry.event("gym_action", mapOf("screen" to "movement_form", "action" to "add",
                "outcome" to when (result) {
                    is MovementCreateOutcome.Added -> "ok"
                    is MovementCreateOutcome.Failed -> if (result.why is WriteFailure.Refused) "refused" else "failed"
                }))
            result
        }
        movementCreations[key] = write to job
        job.invokeOnCompletion { if (movementCreations[key]?.second === job) movementCreations.remove(key) }
        return job.await()
    }

    fun clearRefusals() {
        if (!workoutAuthorized) return
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
        if (!workoutAuthorized) return WriteFailure.Refused(accountChanged)
        if (!weightKg.isFinite() || weightKg !in Bodyweight.minKg..Bodyweight.maxKg)
            return WriteFailure.Refused(Bodyweight.outOfRange)
        val date = runCatching { java.time.LocalDate.parse(dateLocal) }.getOrNull()
            ?: return WriteFailure.Refused("Choose a date.")
        Bodyweight.dated(date, Bodyweight.today(now()))?.let { return WriteFailure.Refused(it) }
        val seat = owner
        val replica = controls.engineReplica
        val anonymous = seat == null
        return bodyweightWrite.withLock {
            if (!workoutAuthorized || seat != owner || replica == null) return@withLock WriteFailure.Refused(accountChanged)
            try {
                val saved = training.putBodyweight(dateLocal, weightKg, replica, anonymous)
                if (seat != owner) return@withLock WriteFailure.Refused(accountChanged)
                dropWithheld(dateLocal)
                series = (series.filterNot { it.dateLocal == dateLocal } + saved).sortedBy { it.dateLocal }
                bodyweightRead = true
                telemetry.event("gym_bodyweight_saved")
                null
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { reportFailure("gym.weighIn", failure); WriteFailure(failure) }
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
                repeat(3) {
                    val revision = progressRevision
                    val read = readTraining { training.progress() }
                    if (seat != owner) return@withLock GymResult.Failed(WriteFailure.Refused("The account changed while reading."))
                    if (revision == progressRevision) {
                        progressCache = read
                        return@withLock GymResult.Ok(read)
                    }
                }
                engineRefreshes?.trySend(Unit)
                GymResult.Failed(WriteFailure.NoAnswer)
            } catch (_: TrainingReadChanged) {
                GymResult.Failed(WriteFailure.NoAnswer)
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
    // has nothing to say: a record and a comparison need the account's whole history.
    suspend fun review(of: String): Review? {
        shelfDetail(of)?.let { return Review() }
        val seat = owner
        val result = tried("gym.review") { readTraining { training.review(of) } }
        return result.takeIf { seat == owner }
    }

    suspend fun sessionDetail(sessionId: String, seed: SessionDetail? = null): GymResult<SessionDetail> {
        shelfDetail(sessionId)?.let { return GymResult.Ok(it) }
        if (seed != null && seed.session.id == sessionId && !seed.session.isOpen && closedDetails[sessionId] == null) retainClosed(seed)
        val before = closedDetails[sessionId]
        val detail = try { readTraining { training.session(sessionId) } }
        catch (_: TrainingReadChanged) { return GymResult.Failed(WriteFailure.NoAnswer) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            reportFailure("gym.loadLog", failure)
            return GymResult.Failed(WriteFailure.NoAnswer)
        } ?: return GymResult.Failed(WriteFailure.Refused("that session is no longer on the log"))
        val current = closedDetails[sessionId]
        if (current != before && current != null) return GymResult.Ok(current)
        if (!detail.session.isOpen) retainClosed(detail)
        return GymResult.Ok(detail)
    }

    suspend fun fixSet(sessionId: String, setId: String, fix: SetFix, origin: FixOrigin? = null): FixOutcome {
        val seat = owner
        val replica = controls.engineReplica
        val liveId = session?.id
        return scope.async(start = CoroutineStart.UNDISPATCHED) {
            var fromShelf = false
            val outcome = try { run correction@ {
                if (!workoutAuthorized || seat != owner || replica == null || replica != controls.engineReplica || liveId != session?.id)
                    return@correction FixOutcome.Failed(WriteFailure.Refused("the account changed while fixing"))
                if (liveId == sessionId && sets.none { it.id == setId })
                    return@correction FixOutcome.Gone("that set is no longer on this device")
                if (liveId != sessionId) shelfDetail(sessionId)?.let { detail ->
                    val corrected = detail.sets.firstOrNull { it.id == setId }?.let(fix::corrected)
                        ?: return@correction FixOutcome.Gone("that set is no longer on this device")
                    val deleted = training.imports.refusals().firstOrNull { it.id == sessionId }?.deletedSetIds
                        ?: training.imports.pendingFinished().firstOrNull { it.session.id == sessionId }?.deleted.orEmpty()
                    training.imports.replaceAndRetry(sessionId, SavedWorkout(detail.session,
                        detail.sets.map { if (it.id == setId) corrected else it }, deleted),
                        expectedReplica = replica, expectedAnonymous = seat == null)
                    fromShelf = true
                    return@correction FixOutcome.Corrected(corrected)
                }
                FixOutcome.Corrected(training.fixSet(sessionId, setId, fix, replica, seat == null))
            } } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                reportFailure("gym.fixSet", failure)
                if ((failure as? TrainingRefused)?.code == "unknown-record") FixOutcome.Gone("that set is no longer on the log")
                else FixOutcome.Failed(WriteFailure(failure))
            }
            origin?.let {
                telemetry.event("gym_action", mapOf("screen" to it.screen, "action" to "fix", "outcome" to when (outcome) {
                    is FixOutcome.Corrected -> "ok"
                    is FixOutcome.Gone -> "refused"
                    is FixOutcome.Failed -> if (outcome.why is WriteFailure.Refused) "refused" else "failed"
                }))
            }
            if (outcome is FixOutcome.Corrected && workoutAuthorized && seat == owner && replica == controls.engineReplica &&
                training.anonymous == (seat == null) && liveId == session?.id) {
                try {
                    changedSet(sessionId, setId, outcome.set)
                    if (liveId == sessionId) {
                        controls.store(outcome.set, sessionId)
                        drawFromControls()
                    } else if (fromShelf) shelved = refusedImports()
                    else rereadRow(sessionId, "gym.fixSet")
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Exception) {
                    reportFailure("gym.fixSet", failure)
                    if (!controls.writable) refuseWorkout()
                }
            }
            outcome
        }.await()
    }

    // A settled delete updates the replica and every retained read of this set.
    suspend fun deleteSet(sessionId: String, setId: String, replica: String? = controls.engineReplica, anonymous: Boolean = owner == null): WriteFailure? {
        if (!workoutAuthorized) return WriteFailure.Refused("the account changed while deleting")
        val live = session?.takeIf { it.id == sessionId }
        if (live == null) shelfDetail(sessionId)?.let { detail ->
            val deleted = training.imports.refusals().firstOrNull { it.id == sessionId }?.deletedSetIds
                ?: training.imports.pendingFinished().firstOrNull { it.session.id == sessionId }?.deleted.orEmpty()
            training.imports.replaceAndRetry(sessionId, SavedWorkout(detail.session,
                detail.sets.filterNot { it.id == setId }, (deleted + setId).distinct()),
                expectedReplica = replica ?: return WriteFailure.Refused(accountChanged), expectedAnonymous = anonymous)
            if (detail.sets.any { it.id == setId }) {
                deletedSets = deletedSets + setId
                shelved = refusedImports()
                changedSet(sessionId, setId, null)
            }
            return null
        }
        val seat = owner
        try {
            training.deleteSet(sessionId, setId, replica ?: return WriteFailure.Refused(accountChanged), anonymous)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.deleteSet", refusing)
            if (refusing is TrainingDeleteUnconfirmed && seat == owner) refreshEngine()
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
    private suspend fun rereadRow(sessionId: String, operation: String = "gym.rereadRow") {
        val seat = owner
        val at = logged.indexOfFirst { it.id == sessionId }
        if (at < 0) return
        val above = logged.getOrNull(at - 1)
        val fresh = tried(operation) { readTraining { training.sessions(limit = 1, before = above?.startedAtMs, beforeId = above?.id) } }
            ?.singleOrNull()?.takeIf { it.id == sessionId } ?: return
        if (seat != owner) return
        logged = logged.map { if (it.id == sessionId) fresh else it }
    }

    suspend fun delete(deletion: Deletion): WriteFailure? {
        val screen = when (deletion) {
            is Deletion.Routine -> "routines"
            is Deletion.Set -> "session"
            is Deletion.Note -> deletion.origin.screen
            else -> error("this resource requires its recovery flow")
        }
        val seat = owner
        val replica = controls.engineReplica
        val anonymous = seat == null
        return scope.async(start = CoroutineStart.UNDISPATCHED) {
            val failure = try {
                if (seat != owner || replica == null) WriteFailure.Refused(accountChanged)
                else when (deletion) {
                    is Deletion.Routine -> dropRoutine(deletion.routineId, replica, anonymous)
                    is Deletion.Set -> deleteSet(deletion.sessionId, deletion.set.id, replica, anonymous)
                    is Deletion.Note -> deleteNote(deletion.noteId, replica, anonymous)
                    else -> error("this resource requires its recovery flow")
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                reportFailure(when (deletion) {
                    is Deletion.Routine -> "gym.dropRoutine"
                    is Deletion.Set -> "gym.deleteSet"
                    else -> "gym.deleteNote"
                }, error)
                WriteFailure(error)
            }
            telemetry.event("gym_action", mapOf("screen" to screen, "action" to "delete",
                "outcome" to when (failure) {
                    null -> "ok"
                    is WriteFailure.Refused -> "refused"
                    else -> "failed"
                }))
            failure
        }.await()
    }

    // Weigh-ins are durable engine holds; workout recovery stays room-owned.
    fun withhold(deletion: Deletion.Recoverable) {
        if (!workoutAuthorized) return
        if (deletion is Deletion.Bodyweight) {
            val seat = owner
            val replica = controls.engineReplica ?: return
            val anonymous = seat == null
            val window = undoWindowMs
            scope.launch {
                bodyweightWrite.withLock {
                    if (!workoutAuthorized || seat != owner || replica != training.engine.activeReplica()) return@withLock
                    try {
                        val weight = training.weighins(deletion.dateLocal, deletion.dateLocal).singleOrNull()
                            ?: return@withLock
                        val receipt = training.holdBodyweight(deletion.dateLocal, window, replica, anonymous) ?: return@withLock
                        if (!workoutAuthorized || seat != owner || replica != training.engine.activeReplica()) return@withLock
                        val offer = training.engine.undoOffers().firstOrNull { it.id == receipt.gestureId }
                        if (offer != null) {
                            withheld = withheld.filterNot { it.subjectId == deletion.subjectId } +
                                WithheldDelete(deletion, offer.releaseAt, receipt = HeldWeightReceipt(replica, anonymous, offer.id, receipt.localIds, weight))
                            weightAction("delete", "held")
                        } else weightAction("delete", "closed")
                        series = series.filterNot { it.dateLocal == deletion.dateLocal }
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (failure: Exception) {
                        reportFailure("gym.deleteWeighIn", failure)
                        if (seat == owner && replica == training.engine.activeReplica()) {
                            weightAction("delete", if (WriteFailure(failure) is WriteFailure.Refused) "refused" else "failed")
                            deleteRefused = WriteFailure(failure).line("that weigh-in is still on the log")
                        }
                    }
                }
            }
            return
        }
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

    // A successful whole-record rewrite retires this day's receipt projection.
    private fun dropWithheld(subjectId: String) {
        val taking = withheld.firstOrNull { it.subjectId == subjectId && it.takeable } ?: return
        clocks.remove(subjectId)?.cancel()
        withheld = withheld - taking
        if (taking.receipt != null) weightAction("cancel", "rewritten")
    }

    // Undo takes the newest available offer and reports only an actual restoration.
    fun keepWithheld(): WithheldDelete? {
        if (!workoutAuthorized) return null
        val taking = withheld.lastOrNull { it.takeable } ?: return null
        taking.receipt?.let { receipt ->
            if (receipt.replica != training.engine.activeReplica() || receipt.anonymous != training.anonymous) {
                withheld = withheld - taking
                return null
            }
            val gesture = receipt.gestureId
            try {
                if (training.engine.undoOffers().none { it.id == gesture } || !training.engine.undo(gesture)) {
                    weightAction("undo", "closed")
                    refreshHeldWeights()
                    return null
                }
                series = (series.filterNot { it.dateLocal == receipt.weighIn.dateLocal } + receipt.weighIn).sortedBy { it.dateLocal }
                withheld = withheld - taking
                weightAction("undo", "ok")
            } catch (failure: Exception) {
                weightAction("undo", "failed")
                reportFailure("gym.deleteWeighIn", failure)
                deleteRefused = WriteFailure(failure).line("Undo could not restore that weigh-in")
                return null
            }
        }
        clocks.remove(taking.subjectId)?.cancel()
        withheld = withheld - taking
        return taking
    }

    // Navigation and recreation never abandon an engine-backed weight hold.
    fun abandonWithheld(): Boolean {
        val letting = withheld.filter { it.takeable && it.receipt == null }
        if (letting.isEmpty()) return false
        for (going in letting) clocks.remove(going.subjectId)?.cancel()
        withheld = withheld - letting.toSet()
        return true
    }

    // Explicit settlement releases only this receipt; background release belongs to the engine.
    suspend fun settleWithheld(subjectId: String): WriteFailure? {
        if (!workoutAuthorized) return WriteFailure.Refused(accountChanged)
        val settling = withheld.firstOrNull { it.subjectId == subjectId } ?: return null
        settling.receipt?.let { receipt ->
            return bodyweightWrite.withLock {
                if (!workoutAuthorized) return@withLock WriteFailure.Refused(accountChanged)
                if (receipt.replica != training.engine.activeReplica() || receipt.anonymous != training.anonymous) {
                    withheld = withheld - settling
                    return@withLock WriteFailure.Refused(accountChanged)
                }
                try {
                    receipt.localIds.forEach(training.engine::release)
                    refreshHeldWeights()
                    loadBodyweight()
                    null
                } catch (failure: Exception) {
                    weightAction("delete", "failed")
                    reportFailure("gym.deleteWeighIn", failure)
                    WriteFailure(failure)
                }
            }
        }
        clocks.remove(subjectId)?.cancel()
        withheld = withheld.map { if (it.subjectId == subjectId) it.copy(sent = true) else it }
        val seat = owner
        val failed = send(settling.deletion)
        if (seat != owner) return failed
        withheld = withheld.filterNot { it.subjectId == subjectId && it.untilMs == settling.untilMs }
        return failed
    }

    private fun refreshHeldWeights() {
        val replica = training.engine.activeReplica()
        val offers = training.engine.undoOffers().associateBy { it.id }
        withheld = withheld.mapNotNull { held ->
            val receipt = held.receipt ?: return@mapNotNull held
            if (receipt.replica != replica || receipt.anonymous != training.anonymous) return@mapNotNull null
            val offer = offers[receipt.gestureId]
            if (offer == null) weightAction("delete", "closed")
            offer?.let { held.copy(untilMs = it.releaseAt) }
        }
    }

    private fun weightAction(action: String, outcome: String) {
        telemetry.event("gym_action", mapOf("screen" to "bodyweight", "action" to action, "outcome" to outcome))
    }

    fun clearDeleteRefused() {
        deleteRefused = null
    }

    // Workout recovery retains its settlement path.
    private suspend fun send(deletion: Deletion.Recoverable): WriteFailure? = when (deletion) {
        is Deletion.Session -> if (discard(deletion.sessionId)) null else WriteFailure.NoAnswer
        is Deletion.Bodyweight -> error("weigh-in deletion requires its engine receipt")
    }

    // Doubles as the retry for a first page the replica could not answer: with no rows the cursor is
    // absent, which is the top of the log. The cursor is BOTH halves of the sort key, because two
    // sessions can share an instant.
    suspend fun loadOlder(): Unit = logRead.withLock {
        if (older == Older.Loading || older == Older.End) return
        val seat = owner
        older = Older.Loading
        val oldest = logged.lastOrNull()
        val page = tried("gym.loadOlder") { readTraining { training.sessions(limit = logPage, before = oldest?.startedAtMs, beforeId = oldest?.id) } }
        if (seat != owner) return
        if (page == null) {
            older = Older.Failed
            return
        }
        logged = logged + page.filter { fresh -> logged.none { it.id == fresh.id } }
        older = if (page.size < logPage) Older.End else Older.More
    }

    suspend fun routineHistory(routineId: String): GymResult<List<SessionSummary>> {
        if (!accountReady) return GymResult.Failed(WriteFailure.Refused(accountChanged))
        return try {
            GymResult.Ok(readTraining { training.routineHistory(routineId, withheldIds) })
        } catch (_: TrainingReadChanged) {
            GymResult.Failed(WriteFailure.Refused(accountChanged))
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            reportFailure("gym.routineHistory", failure)
            GymResult.Failed(WriteFailure.NoAnswer)
        }
    }

    // Nothing is held: the store keeps no copy to invalidate. The replica's answer stands ALONE and
    // a refused import kept on this phone is not merged into it, so a strict refusal cannot change
    // aggregate history.
    suspend fun record(exerciseId: String): GymResult<MovementRecord> {
        val read = training.record(exerciseId)
            ?: return GymResult.Failed(WriteFailure.Refused("that movement is no longer on the log"))
        return GymResult.Ok(read)
    }

    val editReplica: String? get() = controls.engineReplica

    suspend fun edit(exerciseId: String, name: String, equipment: String? = null, loadCount: Int? = null,
        base: Exercise? = null, expectedAccountKey: String = accountKey, expectedReplica: String? = editReplica): GymResult<Exercise> {
        val seat = owner
        val result = try {
            if (!workoutAuthorized || expectedAccountKey != accountKey || expectedReplica == null)
                throw TrainingRefused("account-changed", accountChanged)
            Program.nameProblem(name)?.let { throw TrainingRefused("invalid", it) }
            val edited = training.editExercise(exerciseId, name, equipment, loadCount, base, expectedReplica, seat == null)
            if (seat == owner) invalidateProgress()
            GymResult.Ok(edited)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (failure: Exception) {
            reportFailure("gym.editExercise", failure)
            GymResult.Failed(WriteFailure(failure))
        }
        val outcome = when (result) {
            is GymResult.Ok -> "ok"
            is GymResult.Failed -> if (result.why is WriteFailure.Refused) "refused" else "failed"
        }
        telemetry.event("gym_action", mapOf("screen" to "record", "action" to "edit", "outcome" to outcome))
        return result
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
        closedDetails = closedDetails.mapValues { (_, detail) ->
            if (detail.session.id != sessionId) detail
            else detail.copy(sets = detail.sets.mapNotNull { if (it.id == oldId) set else it })
        }
    }

    private suspend fun loadLog(): Unit = logRead.withLock {
        if (!workoutAuthorized) return
        // The owner and live session still have to match after every suspended read.
        val seat = owner
        val live = controls.session?.id
        val page = tried("gym.loadLog") {
            if (controls.writable) training.recoverAcceptedSets(controls)
            readTraining {
                if (training.planUnreadable) telemetry.failure("gym.loadLog", IllegalStateException("unreadable-frozen-plan"))
                training.sessions(limit = logPage, before = null, beforeId = null) to readDelivery()
            }
        }
        if (!workoutAuthorized || seat != owner || live != controls.session?.id) return
        if (page == null) {
            // The foot is where an unread log is said; the rows already in hand stay.
            older = Older.Failed
            return
        }
        // A re-read is of the HEAD and does not undo a walk: it can land while a thumb is halfway down
        // the log. The fresh page is authoritative over the span it covers, and every row OLDER than
        // its last one survives, keyed on both halves of the cursor.
        deliveryRead = page.second
        val rows = page.first
        val edge = rows.lastOrNull()
        val deeper = logged.filter { held ->
            edge != null && (held.startedAtMs < edge.startedAtMs ||
                (held.startedAtMs == edge.startedAtMs && held.id < edge.id))
        }
        logged = rows + deeper
        invalidateProgress()
        val refused = tried("gym.loadLog") { refusedImports() } ?: return
        if (!workoutAuthorized || seat != owner || live != controls.session?.id) return
        shelved = refused
        tried("gym.loadLog") { readRecovery() }
        if (!workoutAuthorized || seat != owner || live != controls.session?.id) return
        // The foot is about the deepest row in hand, so it is recomputed only when this page IS the
        // whole of what is held.
        if (deeper.isEmpty()) older = if (rows.size < logPage) Older.End else Older.More

        val open = try { readTraining { training.openWorkout() } }
        catch (_: TrainingReadChanged) { return }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            reportFailure("gym.loadLog", failure)
            older = Older.Failed
            return
        }
        if (!workoutAuthorized || seat != owner || live != controls.session?.id || !controls.writable) return
        logReadReady = training.anonymous || training.firstPullComplete
        if (open == null) {
            // The replica holds no open session, so whatever this phone was holding is over.
            controls.session?.let { controls.close(it.id) }
            controls.flush()
            drawFromControls()
            return
        }
        adopt(open.session, joined = true)
    }

    private suspend fun adopt(opened: Session, joined: Boolean) {
        if (!workoutAuthorized) return
        val seat = owner
        val live = controls.session?.id
        val detail = if (joined) tried("gym.loadLog") { readTraining { training.session(opened.id) } } else null
        if (!workoutAuthorized || seat != owner || live != controls.session?.id || !controls.writable) return
        if (joined && (detail == null || !detail.session.isOpen)) return
        controls.hold(detail?.session ?: opened)
        if (detail != null) {
            val kept = detail.sets.mapTo(mutableSetOf()) { it.id }
            for (set in controls.sets(opened.id)) if (set.id !in kept) controls.drop(set.id)
            for (set in detail.sets) controls.store(set, detail.session.id)
        }
        controls.flush()
        drawFromControls()
    }

    // Stands at the movement the last set went into, not in the picker. A movement already in hand is
    // re-CHOSEN rather than moved: connect cleared the last-time cache, and re-asking swaps the old
    // seat's answer for this seat's.
    private suspend fun resume() {
        val seat = seated
        val movement = controls.chosenMovement ?: exerciseId?.takeIf { it in order } ?: LiveOrder.resume(order, sets)
        if (movement != null) choose(movement)
        if (seated == seat) resumePending = false
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
        val status = training.engine.status.state.value
        val blocker = when {
            status.authPaused -> Blocker.SignInLapsed
            !status.online -> Blocker.Offline
            else -> training.deliveryBlocker
        }
        strandedCount = if (training.anonymous || blocker == null) 0 else sets.count { it.id in stalledIds }
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
        prefill = Prefill.of(session?.let { live -> todaySets.map { it.domain(live.id) } }.orEmpty(), planEntry?.domain, lastTime)
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

sealed interface MovementCreateOutcome {
    data class Added(val movement: Exercise) : MovementCreateOutcome
    data class Failed(val why: WriteFailure, val created: Exercise? = null) : MovementCreateOutcome
}

sealed interface GymResult<out T> {
    data class Ok<T>(val value: T) : GymResult<T>
    data class Failed(val why: WriteFailure) : GymResult<Nothing>
}

// A log that answered with a REASON is not a log that went quiet: the lifter can act on the first and
// can only wait out the second.
sealed interface WriteFailure {
    data class Refused(val said: String) : WriteFailure   // the log answered, in its own words
    data object NoAnswer : WriteFailure                   // no reply, or one this build couldn't read
    data object UnconfirmedDelete : WriteFailure

    // `subject` is read only when there is no sentence from the log to say instead.
    fun line(subject: String): String = when (this) {
        is Refused -> said
        NoAnswer -> "the log didn’t answer — $subject"
        UnconfirmedDelete -> "The delete could not be confirmed. Reopen this screen to check."
    }
}

fun WriteFailure(refusing: Throwable): WriteFailure = when (refusing) {
    is TrainingDeleteUnconfirmed -> WriteFailure.UnconfirmedDelete
    is TrainingRefused -> WriteFailure.Refused(refusing.line)
    is WindmillApiException.Refused -> WriteFailure.Refused(refusing.line)
    else -> WriteFailure.NoAnswer
}

enum class FixOrigin(val screen: String) { Workout("workout"), Session("session") }

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
data class RefusedWorkout(override val id: String, val startedAtMs: Long?, override val reason: String) : RefusedWrite

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
