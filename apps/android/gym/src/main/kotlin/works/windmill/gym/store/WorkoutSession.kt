package works.windmill.gym.store

import works.windmill.platform.i18n.Words
import works.windmill.gym.R
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import works.windmill.domain.kit.Id
import works.windmill.gym.domain.sync.Exercise as DomainExercise
import works.windmill.gym.domain.sync.LastTime
import works.windmill.gym.domain.sync.Prefill
import works.windmill.gym.presentation.AutoClose
import works.windmill.gym.presentation.Blocker
import works.windmill.gym.presentation.ExerciseWrite
import works.windmill.gym.presentation.GymPreferences
import works.windmill.gym.presentation.LastSet
import works.windmill.gym.presentation.LiveOrder
import works.windmill.gym.presentation.LogSetAcceptance
import works.windmill.gym.presentation.LogSetCommand
import works.windmill.gym.presentation.PlanEntry
import works.windmill.gym.presentation.PlanSnapshot
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.Session
import works.windmill.gym.presentation.SessionStart
import works.windmill.gym.presentation.SetFix
import works.windmill.gym.presentation.TrainingSet
import works.windmill.gym.presentation.WorkoutChange
import works.windmill.gym.presentation.WorkoutClock
import works.windmill.gym.presentation.WorkoutKey
import works.windmill.gym.presentation.WorkoutNotification
import works.windmill.gym.presentation.WorkoutRack
import works.windmill.gym.store.TrainingSeat.Companion.accountChange
import works.windmill.platform.telemetry.Telemetry

// The workout in hand: its rack, the sets logged into it, the movement walk, and how it finishes. A set or workout already on the log is corrected here too, because the live workout's controls must follow every change to it.
class WorkoutSession(
    private val seat: TrainingSeat,
    private val held: HeldDeletes,
    private val controls: WorkoutControls,
    private val training: EngineTraining,
    private val history: HistoryReads,
    private val routines: RoutinesStore,
    private val scope: CoroutineScope,
    private val telemetry: Telemetry,
    private val now: () -> Long,
    private val mintSession: () -> String,
    private val mintSet: () -> String,
    private val workoutClock: WorkoutClock,
    // The room's engine refresh, which re-reads everything after a delete the engine could not confirm.
    private val refresh: suspend () -> Unit,
) {
    private val workoutFacts = MutableStateFlow<WorkoutNotification?>(null)
    val notification = workoutFacts.asStateFlow()
    var rack: WorkoutRack? by mutableStateOf(null)
        private set
    private var hiddenLogger by mutableStateOf(false)
    val loggerHidden: Boolean get() = seat.workoutAuthorized && hiddenLogger
    var workoutRefusal: Words? by mutableStateOf(null)
        private set
    private data class AcceptedSetRecovery(val replica: String?, val workoutId: String)
    private var acceptedSetRecovery: AcceptedSetRecovery? = null
    private val acceptedSetRecoveryPending: Boolean get() = acceptedSetRecovery != null
    private val lastingRefusal: Words? get() = workoutRefusal?.takeUnless { acceptedSetRecoveryPending && controls.writable }
    var workoutOpenRequest by mutableLongStateOf(0L)
        private set
    var workoutOpenKey: WorkoutKey? by mutableStateOf(null)
        private set
    fun requestWorkout() {
        workoutOpenKey = notification.value?.key ?: return
        workoutOpenRequest += 1
    }
    fun acknowledgeWorkoutRequest() { workoutOpenRequest = 0; workoutOpenKey = null }
    var routinesOpenRequest by mutableLongStateOf(0L)
        private set
    fun requestRoutines() { routinesOpenRequest += 1 }
    fun acknowledgeRoutinesRequest() { routinesOpenRequest = 0 }
    fun authorizeWorkout(allowed: Boolean) {
        seat.localWorkoutAuthorized = allowed
        if (!allowed) workoutFacts.value = null
    }
    fun revokeWorkoutAuthority() {
        try {
            if (controls.session != null && controls.writable) controls.control(controls.workout.invalidate())
        } catch (error: Exception) {
            seat.reportFailure("gym.revokeWorkoutAuthority", error)
            workoutRefused()
        }
        workoutFacts.value = null
    }

    internal fun withdrawFacts() { workoutFacts.value = null }

    // Nothing of the last seat's workout is drawn for the next one.
    internal fun forgetSeat() {
        if (acceptedSetRecoveryPending) {
            acceptedSetRecovery = null
            workoutRefusal = null
        }
        workoutFacts.value = null
        session = null
        rack = null
        sets = emptyList()
        exerciseId = null
        preferences = GymPreferences()
        refusals = emptyList()
        enginePendingSessions = emptySet()
        lastTimes.clear()
        lastSets = null
    }

    // A deleted account's workout leaves the room with it.
    internal fun erase() {
        acceptedSetRecovery = null
        workoutRefusal = null
        workoutFacts.value = null
        session = null
        rack = null
        sets = emptyList()
        order = emptyList()
        exerciseId = null
        resumePending = false
        acknowledgeWorkoutRequest()
    }

    // A restored workout stands at the movement its controls chose, with the last time read before the seat was ready.
    internal fun restored(movement: String?, previous: LastTime?) {
        exerciseId = controls.chosenMovement
        if (movement != null && previous != null && exerciseId == movement) lastTimes[movement] = previous
        drawFromControls()
    }

    // A workout left past the auto-close is over on this phone too: the replica already draws it closed at its last activity.
    fun reconcileWorkoutTime() {
        if (!seat.workoutReady || !controls.writable) return
        if (!seat.workoutAuthorized) { refreshWorkout(); return }
        val live = controls.session
        if (live != null) {
            val moment = workoutClock.now()
            val origin = controls.latestSet(moment)?.origin ?: controls.workout.started
            val overAt = if (origin?.bootId == moment.bootId) {
                origin.wallMs.takeIf { moment.elapsedMs - origin.elapsedMs >= AutoClose.AFTER_MS }
            } else AutoClose.at(live, controls.sets(live.id), moment.wallMs)
            if (overAt != null) {
                try {
                    recoverAcceptedSets()
                    controls.close(live.id)
                    lastTimes.clear()
                    exerciseId = null
                    drawFromControls()
                } catch (error: Exception) {
                    seat.reportFailure("gym.reconcileWorkoutTime", error)
                    workoutRefused()
                    return
                }
                return
            }
        }
        refreshWorkout()
    }

    fun editRack(weightKg: Double, reps: Int): WorkoutChange {
        if (isFinishing || !seat.workoutAuthorized) return WorkoutChange.Unavailable(workoutRefusal ?: Words.Message(R.string.gym_store_workout_not_ready))
        if (session == null || rack == null) return WorkoutChange.Stale
        return writeControls("gym.editRack") {
            controls.control(controls.workout.edit(weightKg, reps))
            refreshWorkout()
            WorkoutChange.Saved
        }
    }

    fun editWorkout(open: Boolean): WorkoutChange {
        if (!seat.workoutAuthorized) return WorkoutChange.Unavailable(workoutRefusal ?: Words.Message(R.string.gym_store_account_restore_first))
        return writeControls("gym.editWorkout") {
            controls.control(controls.workout.editor(open))
            refreshWorkout()
            WorkoutChange.Saved
        }
    }

    // Persist the set and consumed offer before the engine commit, retaining both if that commit fails.
    fun acceptSet(command: LogSetCommand): LogSetAcceptance {
        reconcileWorkoutTime()
        if (!seat.workoutAuthorized || isFinishing || !controls.writable || workoutRefusal != null) {
            return LogSetAcceptance.Unavailable(workoutRefusal ?: Words.Message(R.string.gym_store_workout_not_ready))
        }
        return try {
            val accepted = controls.accept(command, workoutClock.now(), ::lastTimeOf, mintSet)
            if (accepted is LogSetAcceptance.Accepted) {
                val entry = requireNotNull(controls.entry(accepted.setId))
                val committed = try {
                    training.commitAccepted(controls, entry.set, entry.sessionId)
                } catch (failure: Exception) {
                    seat.reportFailure("gym.acceptSet", failure)
                    val reason = workoutRefused()
                    acceptedSetRecovery = AcceptedSetRecovery(controls.engineReplica, entry.sessionId)
                    return LogSetAcceptance.Unavailable(reason)
                }
                controls.store(committed, entry.sessionId)
                telemetry.event("gym_set_logged")
                drawFromControls()
            }
            accepted
        } catch (error: Exception) {
            seat.reportFailure("gym.acceptSet", error)
            LogSetAcceptance.Unavailable(workoutRefused())
        }
    }

    fun showWorkout(key: WorkoutKey, hidden: Boolean): WorkoutChange {
        if (!seat.workoutAuthorized || isFinishing) return WorkoutChange.Unavailable(Words.Message(R.string.gym_store_workout_not_ready))
        if (key.ownerKey != seat.accountKey || controls.ownerKey != seat.accountKey || controls.session?.id != key.sessionId ||
            workoutFacts.value?.key != key) return WorkoutChange.Stale
        return writeControls("gym.showWorkout") {
            controls.control(controls.workout.visibility(hidden))
            refreshWorkout()
            WorkoutChange.Saved
        }
    }

    fun setLoggerHidden(key: WorkoutKey, hidden: Boolean): WorkoutChange {
        if (!seat.workoutAuthorized || isFinishing) return WorkoutChange.Unavailable(Words.Message(R.string.gym_store_workout_not_ready))
        if (key.ownerKey != seat.accountKey || controls.ownerKey != seat.accountKey || controls.session?.id != key.sessionId ||
            workoutFacts.value?.key != key) return WorkoutChange.Stale
        return writeControls("gym.logger_visibility") {
            controls.loggerVisibility(hidden)
            hiddenLogger = controls.loggerHidden
            WorkoutChange.Saved
        }
    }

    internal fun refreshWorkout() {
        if (!seat.workoutReady || workoutRefusal != null) return
        hiddenLogger = controls.loggerHidden
        if (!seat.workoutAuthorized) { workoutFacts.value = null; return }
        val live = controls.session
        if (live == null) {
            rack = null
            workoutFacts.value = null
            return
        }
        val ready = seat.workoutAuthorized && !isFinishing && controls.writable
        val state = try {
            if (controls.writable && seat.workoutAuthorized) controls.prepare(::lastTimeOf, workoutClock.now(), ready, mintSet) else controls.workout
        } catch (error: Exception) {
            seat.reportFailure("gym.refreshWorkout", error)
            workoutRefused()
            return
        }
        try { training.persistControls(controls) }
        catch (failure: Exception) { seat.reportFailure("gym.workout_controls", failure); workoutRefused(); return }
        rack = state.rack
        val movement = controls.chosenMovement
        val rows = controls.sets.filterNot { it.id in held.deletedSets }
        workoutFacts.value = WorkoutNotification(WorkoutKey(seat.accountKey, live.id), live,
            movement?.let { Words.Plain(Readout.movement(it, routines.catalog)) } ?: Words.Message(R.string.gym_notification_choose_movement), rows, state, ready)
    }

    internal suspend fun projectEngineReplica(force: Boolean = false) {
        val replica = training.engine.activeReplica()
        recoverAcceptedSets()
        if (controls.engineReplica == replica && !force) return
        val (open, delivery) = seat.readTraining { training.openWorkout() to history.readDelivery() }
        history.deliveryRead = delivery
        controls.project(replica, open?.session, open?.sets.orEmpty())
        training.restoreControls(controls)
        controls.flush()
    }

    private fun recoverAcceptedSets() {
        val pending = acceptedSetRecovery
        val recoveringHere = controls.engineReplica == training.engine.activeReplica() && pending?.replica == controls.engineReplica
        training.recoverAcceptedSets(controls)
        if (pending != null && recoveringHere && controls.writable) {
            acceptedSetRecovery = null
            workoutRefusal = null
        }
    }

    internal fun workoutRefused(): Words {
        acceptedSetRecovery = null
        val reason = Words.Message(R.string.gym_store_workout_unsafe_restart)
        workoutRefusal = reason
        workoutFacts.value = workoutFacts.value?.copy(offer = null)
        return reason
    }

    // Published from here so the settings screen and the logger read one document.
    var preferences: GymPreferences by mutableStateOf(GymPreferences())
        internal set

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
    // Sparse: the absence of a key is `never logged`. NULL is the map that has not been read; an EMPTY map is an answer, that this lifter has trained nothing.
    var lastSets: Map<String, LastSet>? by mutableStateOf(null)
        private set
    var prefill: Prefill by mutableStateOf(Prefill())
        private set
    var refusals: List<RefusedWrite> by mutableStateOf(emptyList())      // writes the log refused
        internal set

    var saveState: SaveState by mutableStateOf(SaveState.Idle)
        private set
    var saveTick: Int by mutableIntStateOf(0)                               // bumps once per write
        private set
    // Sets the replica holds and the account has not confirmed.
    var strandedCount: Int by mutableIntStateOf(0)
        private set
    private var enginePendingSessions by mutableStateOf(emptySet<String>())
    // What is blocking delivery, read off the engine's status.
    var strandedBy: Blocker? by mutableStateOf(null)
        private set
    // A set logged into a session that closes under it belongs to no workout.
    var isFinishing: Boolean by mutableStateOf(false)
        private set


    val canFinish: Boolean get() = seat.workoutAuthorized && session != null && !isFinishing

    private val lastTimes = mutableStateMapOf<String, LastTime>()
    internal var resumePending = false
    // A change of seat drops the map and the picker's own effect never runs again, so `connect` asks again on the way out.
    internal var lastSetsWanted = false
        private set

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

    val stalled: Set<String>
        get() = history.deliveryRead.pending + sets.filter { history.deliveryRead.confirmed[it.id] != it }.map { it.id }
    val deviceOnlySessionIds: Set<String>
        get() = history.shelved.mapTo(mutableSetOf()) { it.id } + enginePendingSessions

    // The domain action freezes the routine into the session as it starts.
    suspend fun start(routineId: String): GymResult<Session> {
        lastingRefusal?.let { return GymResult.Failed(WriteFailure.Refused(it)) }
        if (!seat.workoutAuthorized || !controls.writable) return GymResult.Failed(WriteFailure.Refused(workoutRefusal ?: Words.Message(R.string.gym_store_account_restore_first)))
        val owner = seat.owner
        return try {
            recoverAcceptedSets()
            workoutRefusal?.let { return GymResult.Failed(WriteFailure.Refused(it)) }
            val opened = training.startSession(SessionStart(id = mintSession(), startedAt = now(), routineId = routineId), requireRoutine = true)
            if (!seat.workoutAuthorized || owner != seat.owner) return GymResult.Failed(WriteFailure.Refused(Words.Message(R.string.gym_store_account_changed_starting)))
            val adopted = adopt(opened, joined = false, operation = "gym.start")
            if (adopted is WorkoutChange.Unavailable) return GymResult.Failed(WriteFailure.Refused(adopted.why))
            if (!seat.workoutAuthorized || owner != seat.owner) return GymResult.Failed(WriteFailure.Refused(Words.Message(R.string.gym_store_account_changed_starting)))
            val live = session ?: return GymResult.Failed(WriteFailure.Refused(Words.Message(R.string.gym_store_workout_not_ready)))
            telemetry.event("gym_session_started")
            GymResult.Ok(live)
        } catch (failure: Exception) {
            if (!currentCoroutineContext().isActive) throw failure
            if (failure is TrainingRefused) {
                // A workout already open on the account is read again so the lifter stands where they were.
                if (failure.code == "session-already-open" && seat.workoutAuthorized && owner == seat.owner) {
                    history.loadLog()
                    if (seat.workoutAuthorized && owner == seat.owner) resume()
                }
                return GymResult.Failed(WriteFailure(failure))
            }
            seat.reportFailure("gym.start", failure)
            GymResult.Failed(WriteFailure.Refused(Words.Message(R.string.gym_store_workout_unsafe_retry)))
        }
    }

    // The answer is kept for the life of the session: a last time is a FINISHED session, so none of these answers can change mid-workout.
    suspend fun choose(movement: String): WorkoutChange {
        if (!seat.workoutAuthorized) return WorkoutChange.Unavailable(Words.Message(R.string.gym_store_workout_not_ready))
        val result = writeControls("gym.choose") {
            controls.choose(movement)
            controls.flush()
            order = controls.order
            exerciseId = movement
            WorkoutChange.Saved
        }
        if (result != WorkoutChange.Saved) return result
        redial()
        readLastTime()
        return workoutRefusal?.let { WorkoutChange.Unavailable(it) } ?: if (!controls.writable) WorkoutChange.Unavailable(workoutRefused()) else result
    }

    internal suspend fun readLastTime() {
        val movement = exerciseId ?: return
        if (!seat.workoutAuthorized || lastTimes[movement]?.isComplete == true) return
        val owner = seat.owner
        val sessionId = session?.id
        val answer = try { seat.readTraining { training.lastTime(movement) } }
        catch (failure: Exception) {
            if (!currentCoroutineContext().isActive) throw failure
            seat.reportFailure("gym.choose", failure)
            return
        }
        if (!seat.workoutAuthorized || seat.owner != owner || session?.id != sessionId) return
        lastTimes[movement] = answer
        if (exerciseId == movement) redial()
    }

    // A movement's last time as this workout has read it, unread until the movement is first chosen and its read answers.
    fun lastTimeOf(movement: String): LastTime = lastTimes[movement] ?: LastTime(Id(movement, DomainExercise), isComplete = false)

    // Sets are keyed by movement and never by position, so only the walk order moves.
    fun reorder(from: Int, to: Int): WorkoutChange {
        if (!seat.workoutAuthorized) return WorkoutChange.Unavailable(Words.Message(R.string.gym_store_workout_not_ready))
        return writeControls("gym.reorderMovements") {
            val walked = LiveOrder.moved(order, from, to)
            if (walked == order) return@writeControls WorkoutChange.Stale
            controls.hold(order = walked)
            controls.flush()
            order = walked
            WorkoutChange.Saved
        }
    }

    fun drop(exerciseId: String): WorkoutChange {
        if (!seat.workoutAuthorized) return WorkoutChange.Unavailable(Words.Message(R.string.gym_store_workout_not_ready))
        return writeControls("gym.dropMovement") {
            if (!LiveOrder.droppable(exerciseId, sets, session?.plan)) return@writeControls WorkoutChange.Stale
            val walked = order.filterNot { it == exerciseId }
            if (walked == order) return@writeControls WorkoutChange.Stale
            controls.hold(order = walked)
            controls.flush()
            order = walked
            if (this.exerciseId == exerciseId) {
                this.exerciseId = null
                redial()
            }
            WorkoutChange.Saved
        }
    }

    private fun writeControls(operation: String, write: () -> WorkoutChange): WorkoutChange {
        workoutRefusal?.let { return WorkoutChange.Unavailable(it) }
        if (!controls.writable) return WorkoutChange.Unavailable(workoutRefusal ?: Words.Message(R.string.gym_store_workout_not_ready))
        return try {
            val result = write()
            workoutRefusal?.let { WorkoutChange.Unavailable(it) } ?: if (!controls.writable) WorkoutChange.Unavailable(workoutRefused()) else result
        } catch (failure: Exception) {
            seat.reportFailure(operation, failure)
            WorkoutChange.Unavailable(workoutRefused())
        }
    }

    // Read when the picker opens; an unread replica leaves the map alone so “never logged” remains an answer.
    suspend fun loadLastSets() {
        lastSetsWanted = true
        val served = seat.tried("gym.loadLastSets") { seat.readTraining { training.lastSets() } } ?: return
        lastSets = served.associateBy { it.exerciseId }
    }

    suspend fun logSet(weightKg: Double, reps: Int) {
        if (!seat.workoutAuthorized || session == null || exerciseId == null || isFinishing) return
        if (editRack(weightKg, reps) !is WorkoutChange.Saved) return
        val offer = notification.value?.offer ?: return
        acceptSet(LogSetCommand(offer.key, offer.id))
    }

    // Finishing closes the workout in the replica, which carries the close to the account behind every set this session holds.
    suspend fun finish(): FinishOutcome {
        if (!seat.workoutAuthorized) return FinishOutcome.Failed(WriteFailure.Refused(Words.Message(R.string.gym_store_account_restore_first)))
        lastingRefusal?.let { return FinishOutcome.Failed(WriteFailure.Refused(it)) }
        if (isFinishing) return FinishOutcome.Failed(WriteFailure.Refused(Words.Message(R.string.gym_store_workout_already_finishing)))
        val live = session ?: return FinishOutcome.Failed(WriteFailure.Refused(Words.Message(R.string.gym_store_workout_not_ready)))
        val owner = seat.owner
        isFinishing = true
        var accepted = false
        try {
            recoverAcceptedSets()
            refreshWorkout()
            workoutRefusal?.let { return FinishOutcome.Failed(WriteFailure.Refused(it)) }
            val detail = try {
                training.finishSession(live.id)
                accepted = true
                checkNotNull(training.session(live.id)) { "The engine does not hold the workout it just finished." }
            } catch (failure: Exception) {
                if (!currentCoroutineContext().isActive) throw failure
                if (failure !is TrainingRefused || failure.code != "unknown-record") throw failure
                null
            }
            if (!seat.workoutAuthorized || owner != seat.owner) return FinishOutcome.Failed(WriteFailure.Refused(Words.Message(R.string.gym_store_account_changed_finishing)))
            if (detail != null) history.retainClosed(detail)
            val saved = writeControls("gym.finish") {
                controls.close(live.id)
                controls.flush()
                lastTimes.clear()
                exerciseId = null
                drawFromControls()
                WorkoutChange.Saved
            }
            if (saved is WorkoutChange.Unavailable) return FinishOutcome.Failed(WriteFailure.Refused(saved.why))
            if (detail == null) {
                history.loadLog()
                if (!seat.workoutAuthorized || owner != seat.owner) return FinishOutcome.Failed(WriteFailure.Refused(Words.Message(R.string.gym_store_account_changed_finishing)))
                return FinishOutcome.Failed(WriteFailure.Refused(Words.Message(R.string.gym_store_workout_no_longer_on_log)))
            }
            scope.launch {
                if (seat.workoutAuthorized && owner == seat.owner) seat.tried("gym.loadLog") { history.loadLog() }
            }
            history.invalidateProgress()
            telemetry.event("gym_session_finished")
            return FinishOutcome.Closed(detail)
        } catch (error: Exception) {
            if (!currentCoroutineContext().isActive) throw error
            seat.reportFailure("gym.finish", error)
            if (!seat.workoutAuthorized || owner != seat.owner) return FinishOutcome.Failed(WriteFailure.Refused(Words.Message(R.string.gym_store_account_changed_finishing)))
            return FinishOutcome.Failed(if (accepted) WriteFailure.Refused(workoutRefused()) else WriteFailure(error))
        } finally {
            isFinishing = false
            refreshWorkout()
        }
    }

    // The log refuses to delete a session somebody may still be logging into.
    suspend fun discard(sessionId: String): Boolean = discardWorkout(sessionId) == null

    private data class WorkoutDiscardKey(val account: String, val replica: String?, val anonymous: Boolean, val sessionId: String)
    private val workoutDiscards = mutableMapOf<WorkoutDiscardKey, Deferred<WriteFailure?>>()

    suspend fun discardWorkout(sessionId: String, screen: String = "session",
        expectedReplica: String? = controls.engineReplica, expectedAnonymous: Boolean = seat.owner == null): WriteFailure? {
        val key = WorkoutDiscardKey(seat.accountKey, expectedReplica, expectedAnonymous, sessionId)
        workoutDiscards[key]?.let { return it.await() }
        val owner = seat.owner
        val replica = expectedReplica
        val job = scope.async(start = CoroutineStart.UNDISPATCHED) {
            var accepted = false
            val failure = try {
                run write@{
                    if (!seat.workoutAuthorized || owner != seat.owner || replica == null || replica != controls.engineReplica || expectedAnonymous != (seat.owner == null)) return@write WriteFailure.Refused(accountChange)
                    if (history.shelfDetail(sessionId) != null) {
                        training.imports.discardRefusal(sessionId)
                        accepted = true
                        if (acceptedSetRecovery?.let { it.replica == replica && it.workoutId == sessionId } == true) {
                            acceptedSetRecovery = null
                            workoutRefusal = null
                        }
                        history.discarded(sessionId)
                        history.invalidateProgress()
                        if (controls.writable) {
                            controls.close(sessionId)
                            controls.flush()
                            drawFromControls()
                        }
                        history.shelved = history.refusedImports()
                        return@write null
                    }
                    training.discardSession(sessionId, replica, expectedAnonymous)
                    accepted = true
                    if (acceptedSetRecovery?.let { it.replica == replica && it.workoutId == sessionId } == true) {
                        acceptedSetRecovery = null
                        workoutRefusal = null
                    }
                    if (owner != seat.owner) return@write null
                    history.invalidateProgress()
                    history.discarded(sessionId)
                    if (controls.writable) {
                        controls.close(sessionId)
                        controls.flush()
                        drawFromControls()
                    }
                    history.loadLog()
                    null
                }
            } catch (failure: Exception) {
                if (!currentCoroutineContext().isActive) throw failure
                seat.reportFailure("gym.discard", failure)
                if (accepted) null else WriteFailure(failure)
            }
            if (accepted && owner == seat.owner && session?.id == sessionId) {
                session = null
                sets = emptyList()
                order = emptyList()
                exerciseId = null
                rack = null
                workoutFacts.value = null
                if (!controls.writable) workoutRefused()
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

    private data class MovementCreationKey(val account: String, val replica: String?, val workout: String, val id: String)
    private val movementCreations = mutableMapOf<MovementCreationKey,
        Pair<ExerciseWrite, Deferred<MovementCreateOutcome>>>()

    suspend fun createForWorkout(write: ExerciseWrite, workoutId: String,
        expectedAccountKey: String = seat.accountKey, expectedReplica: String? = controls.engineReplica): MovementCreateOutcome {
        val key = MovementCreationKey(expectedAccountKey, expectedReplica, workoutId, write.id)
        movementCreations[key]?.let { (submitted, pending) ->
            if (submitted != write) return MovementCreateOutcome.Failed(WriteFailure.Refused(Words.Message(R.string.gym_store_creation_in_progress)))
            return pending.await()
        }
        val owner = seat.owner
        val openingAccount = seat.account
        val job = scope.async(start = CoroutineStart.UNDISPATCHED) {
            fun current() = seat.workoutAuthorized && seat.account == openingAccount && expectedAccountKey == seat.accountKey && owner == seat.owner &&
                expectedReplica != null && expectedReplica == controls.engineReplica &&
                expectedReplica == training.engine.activeReplica() && session?.id == workoutId
            val known = routines.catalog.any { it.id == write.id }
            if (!current()) {
                telemetry.event("gym_action", mapOf("screen" to "movement_form", "action" to if (known) "add" else "create",
                    "outcome" to "refused"))
                return@async MovementCreateOutcome.Failed(WriteFailure.Refused(accountChange))
            }
            val created = routines.create(write.name, write.equipment, write.id, write.loadCount, expectedReplica, workoutId)
            if (!known) telemetry.event("gym_action", mapOf("screen" to "movement_form", "action" to "create",
                "outcome" to when (created) {
                    is GymResult.Ok -> "ok"
                    is GymResult.Failed -> if (created.why is WriteFailure.Refused) "refused" else "failed"
                }))
            if (created is GymResult.Failed) return@async MovementCreateOutcome.Failed(created.why)
            val movement = (created as GymResult.Ok).value
            var choice: WorkoutChange? = null
            val result = try {
                if (!current()) MovementCreateOutcome.Failed(WriteFailure.Refused(accountChange), movement)
                else {
                    val chosen = choose(movement.id)
                    choice = chosen
                    when (chosen) {
                        is WorkoutChange.Unavailable -> MovementCreateOutcome.Failed(WriteFailure.Refused(chosen.why), movement)
                        else -> MovementCreateOutcome.Added(movement)
                    }
                }
            } catch (failure: Exception) {
                if (!currentCoroutineContext().isActive) throw failure
                seat.reportFailure("gym.choose", failure)
                val reason = workoutRefusal ?: workoutRefused()
                choice = WorkoutChange.Unavailable(reason)
                MovementCreateOutcome.Failed(WriteFailure.Refused(reason), movement)
            }
            telemetry.event("gym_action", mapOf("screen" to "movement_form", "action" to "add",
                "outcome" to when (result) {
                    is MovementCreateOutcome.Added -> "ok"
                    is MovementCreateOutcome.Failed -> if (choice is WorkoutChange.Unavailable) "failed" else if (result.why is WriteFailure.Refused) "refused" else "failed"
                }))
            result
        }
        movementCreations[key] = write to job
        job.invokeOnCompletion { if (movementCreations[key]?.second === job) movementCreations.remove(key) }
        return job.await()
    }

    suspend fun fixSet(sessionId: String, setId: String, fix: SetFix, origin: FixOrigin? = null): FixOutcome {
        val owner = seat.owner
        val replica = controls.engineReplica
        val liveId = session?.id
        return scope.async(start = CoroutineStart.UNDISPATCHED) {
            var fromShelf = false
            val outcome = try { run correction@ {
                if (!seat.workoutAuthorized || owner != seat.owner || replica == null || replica != controls.engineReplica || liveId != session?.id)
                    return@correction FixOutcome.Failed(WriteFailure.Refused(Words.Message(R.string.gym_store_account_changed_fixing)))
                if (liveId == sessionId && sets.none { it.id == setId })
                    return@correction FixOutcome.Gone(Words.Message(R.string.gym_store_set_gone_here))
                if (liveId != sessionId) history.shelfDetail(sessionId)?.let { detail ->
                    val corrected = detail.sets.firstOrNull { it.id == setId }?.let(fix::corrected)
                        ?: return@correction FixOutcome.Gone(Words.Message(R.string.gym_store_set_gone_here))
                    val deleted = training.imports.refusals().firstOrNull { it.id == sessionId }?.deletedSetIds
                        ?: training.imports.pendingFinished().firstOrNull { it.session.id == sessionId }?.deleted.orEmpty()
                    training.imports.replaceAndRetry(sessionId, SavedWorkout(detail.session,
                        detail.sets.map { if (it.id == setId) corrected else it }, deleted),
                        expectedReplica = replica, expectedAnonymous = owner == null)
                    fromShelf = true
                    return@correction FixOutcome.Corrected(corrected)
                }
                FixOutcome.Corrected(training.fixSet(sessionId, setId, fix, replica, owner == null))
            } } catch (failure: Exception) {
                if (!currentCoroutineContext().isActive) throw failure
                seat.reportFailure("gym.fixSet", failure)
                if ((failure as? TrainingRefused)?.code == "unknown-record") FixOutcome.Gone(Words.Message(R.string.gym_store_set_gone))
                else FixOutcome.Failed(WriteFailure(failure))
            }
            origin?.let {
                telemetry.event("gym_action", mapOf("screen" to it.screen, "action" to "fix", "outcome" to when (outcome) {
                    is FixOutcome.Corrected -> "ok"
                    is FixOutcome.Gone -> "refused"
                    is FixOutcome.Failed -> if (outcome.why is WriteFailure.Refused) "refused" else "failed"
                }))
            }
            if (outcome is FixOutcome.Corrected && seat.workoutAuthorized && owner == seat.owner && replica == controls.engineReplica &&
                training.anonymous == (owner == null) && liveId == session?.id) {
                try {
                    changedSet(sessionId, setId, outcome.set)
                    if (liveId == sessionId) {
                        controls.store(outcome.set, sessionId)
                        drawFromControls()
                    } else if (fromShelf) history.shelved = history.refusedImports()
                    else history.rereadRow(sessionId, "gym.fixSet")
                } catch (failure: Exception) {
                    if (!currentCoroutineContext().isActive) throw failure
                    seat.reportFailure("gym.fixSet", failure)
                    if (!controls.writable) workoutRefused()
                }
            }
            outcome
        }.await()
    }

    // A settled delete updates the replica and every retained read of this set.
    suspend fun deleteSet(sessionId: String, setId: String, replica: String? = controls.engineReplica, anonymous: Boolean = seat.owner == null): WriteFailure? {
        if (!seat.workoutAuthorized) return WriteFailure.Refused(Words.Message(R.string.gym_store_account_changed_deleting))
        val live = session?.takeIf { it.id == sessionId }
        if (live != null && (!controls.writable || workoutRefusal != null)) return WriteFailure.Refused(workoutRefusal ?: Words.Message(R.string.gym_store_workout_not_ready))
        if (live == null) history.shelfDetail(sessionId)?.let { detail ->
            val deleted = training.imports.refusals().firstOrNull { it.id == sessionId }?.deletedSetIds
                ?: training.imports.pendingFinished().firstOrNull { it.session.id == sessionId }?.deleted.orEmpty()
            training.imports.replaceAndRetry(sessionId, SavedWorkout(detail.session,
                detail.sets.filterNot { it.id == setId }, (deleted + setId).distinct()),
                expectedReplica = replica ?: return WriteFailure.Refused(accountChange), expectedAnonymous = anonymous)
            if (detail.sets.any { it.id == setId }) {
                held.deletedSets = held.deletedSets + setId
                history.shelved = history.refusedImports()
                changedSet(sessionId, setId, null)
            }
            return null
        }
        val owner = seat.owner
        try {
            training.deleteSet(sessionId, setId, replica ?: return WriteFailure.Refused(accountChange), anonymous)
        } catch (refusing: Exception) {
            if (!currentCoroutineContext().isActive) throw refusing
            seat.reportFailure("gym.deleteSet", refusing)
            if (refusing is TrainingDeleteUnconfirmed && owner == seat.owner) refresh()
            return WriteFailure(refusing)
        }
        if (!seat.workoutAuthorized || owner != seat.owner) return WriteFailure.Refused(Words.Message(R.string.gym_store_account_changed_deleting))
        held.deletedSets = held.deletedSets + setId
        changedSet(sessionId, setId, null)
        if (live != null) {
            val result = writeControls("gym.deleteSet") {
                controls.drop(setId)
                drawFromControls()
                WorkoutChange.Saved
            }
            if (result is WorkoutChange.Unavailable) return WriteFailure.Refused(result.why)
        } else history.rereadRow(sessionId)
        return null
    }

    private fun changedSet(sessionId: String, oldId: String, set: TrainingSet?) {
        history.invalidateProgress()
        enginePendingSessions = training.pendingSessionIds()
        history.changeRetained(sessionId, oldId, set)
    }

    // At the end of every log read: with no open session in the replica, whatever this phone was holding is over.
    internal suspend fun follow(open: Session?) {
        if (open != null) {
            adopt(open, joined = true, operation = "gym.loadLog")
            return
        }
        writeControls("gym.loadLog") {
            controls.session?.let { controls.close(it.id) }
            controls.flush()
            drawFromControls()
            WorkoutChange.Saved
        }
    }

    private suspend fun adopt(opened: Session, joined: Boolean, operation: String): WorkoutChange {
        if (!seat.workoutAuthorized) return WorkoutChange.Unavailable(Words.Message(R.string.gym_store_workout_not_ready))
        val owner = seat.owner
        val live = controls.session?.id
        val detail = if (joined) seat.tried(operation) { seat.readTraining { training.session(opened.id) } } else null
        if (!seat.workoutAuthorized || owner != seat.owner || live != controls.session?.id) return WorkoutChange.Stale
        if (joined && (detail == null || !detail.session.isOpen)) return WorkoutChange.Stale
        return writeControls(operation) {
            val before = controls.session?.takeIf { it.id == opened.id }
            controls.hold(detail?.session ?: opened)
            if (detail != null) {
                val kept = detail.sets.mapTo(mutableSetOf()) { it.id }
                for (set in controls.sets(opened.id)) if (set.id !in kept) controls.drop(set.id)
                for (set in detail.sets) controls.store(set, detail.session.id)
            }
            if (before != null) followPlan(before.plan, controls.session?.plan)
            controls.flush()
            drawFromControls()
            WorkoutChange.Saved
        }
    }

    // An edit of the plan, from a proposal applied on any phone, moves the walk and stands the lifter on what replaced the movement in hand.
    private fun followPlan(before: PlanSnapshot?, after: PlanSnapshot?) {
        val walked = controls.order
        val walk = LiveOrder.replanned(walked, before, after, controls.sets)
        if (walk == walked) return
        val movement = controls.chosenMovement
        controls.hold(order = walk)
        if (movement != null && movement !in walk) LiveOrder.standing(walked, movement, walk)?.let(controls::choose)
    }

    // Stands at the movement the last set went into, not in the picker. A movement already in hand is re-CHOSEN rather than moved: connect cleared the last-time cache, and re-asking swaps the old seat's answer for this seat's.
    internal suspend fun resume() {
        val account = seat.account
        val movement = controls.chosenMovement ?: exerciseId?.takeIf { it in order } ?: LiveOrder.resume(order, sets)
        if (movement != null) choose(movement)
        if (seat.account == account) resumePending = false
    }

    internal fun drawFromControls() {
        session = controls.session
        sets = controls.sets
        // Seeded from the plan and from what has already been performed, so a session joined from another device walks the movements it really holds.
        val merged = LiveOrder.merged(held = controls.order, plan = session?.plan, sets = sets)
        if (merged != controls.order) {
            controls.hold(order = merged)
            controls.flush()
        }
        order = merged
        exerciseId = controls.chosenMovement ?: exerciseId?.takeIf { it in merged }
        // The stalled rows, counted off the replica and never off `saveState`. Signed out nothing is stranded.
        val stalledIds = stalled
        enginePendingSessions = training.pendingSessionIds()
        val blocker = training.deliveryBlocker
        strandedCount = if (training.anonymous || blocker == null) 0 else sets.count { it.id in stalledIds }
        strandedBy = if (strandedCount == 0) null else blocker
        val waiting = enginePendingSessions.isNotEmpty()
        val state = when {
            waiting && !training.anonymous && blocker != null -> SaveState.Blocked(blocker)
            waiting -> SaveState.OnThisDevice
            refusals.isNotEmpty() -> SaveState.Refused(refusals.first().why)
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
}
