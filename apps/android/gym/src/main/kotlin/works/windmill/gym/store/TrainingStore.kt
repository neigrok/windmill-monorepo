package works.windmill.gym.store

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import works.windmill.gym.coach.CoachStore
import works.windmill.gym.coach.LocalCoach
import works.windmill.gym.coach.onboarding.CoachOnboardingStore
import works.windmill.gym.net.GymRest
import works.windmill.gym.presentation.Ids
import works.windmill.gym.presentation.WorkoutClock
import works.windmill.gym.presentation.WorkoutMoment
import works.windmill.platform.Account
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.engine.Pulls

// The gym's training, one feature store per screen family over one seat. This is where the stores are composed and
// where they move together: a change of account, an engine refresh, a restore, a transition and an erased owner.
// Main-thread state; Coach owns its conversations, drafts and network requests.
class TrainingStore(
    private val controls: WorkoutControls,
    private val training: EngineTraining,
    private val scope: CoroutineScope,
    rest: () -> GymRest? = { null },
    now: () -> Long = System::currentTimeMillis,
    mintSession: () -> String = Ids::session,
    mintSet: () -> String = Ids::set,
    mintRoutine: () -> String = Ids::routine,
    mintExercise: () -> String = Ids::exercise,
    undoWindowMs: Long = Withheld.windowMs,
    workoutClock: WorkoutClock = WorkoutClock { val at = now(); WorkoutMoment(at, at, "local") },
    workoutAuthority: (String?) -> Boolean = { true },
    telemetry: Telemetry = Telemetry.None,
    elapsedNanos: () -> Long = System::nanoTime,
    localCoach: LocalCoach? = null,
    coachOnboarding: CoachOnboardingStore? = null,
    readDispatcher: CoroutineDispatcher = Dispatchers.Default,
    // Asks the sync runtime for the account's copy again; false when it is not pulling.
    pullAgain: suspend () -> Boolean = { false },
    pulls: StateFlow<Pulls> = MutableStateFlow(Pulls()),
) {
    val seat = TrainingSeat(controls, training, telemetry, readDispatcher, workoutAuthority)
    val held = HeldDeletes()
    val routines = RoutinesStore(seat, controls, training, scope, telemetry, mintRoutine, mintExercise)
    val notes = NotesStore(seat, controls, training, telemetry)
    val bodyweight = BodyweightStore(seat, held, controls, training, telemetry, now)
    val sharing = SharingStore(seat, training, rest)
    val recovery = RecoveryStore(seat, controls, training, scope, telemetry, readDispatcher, now, refresh = ::refreshEngine)
    val history: HistoryReads = HistoryReads(seat, controls, training, routines, recovery, scope, telemetry, pullAgain, pulls,
        followOpenWorkout = { open -> workout.follow(open) })
    val workout = WorkoutSession(seat, held, controls, training, history, routines, scope, telemetry, now, mintSession, mintSet,
        workoutClock, refresh = ::refreshEngine)
    val deletions = DeletionsStore(seat, held, controls, training, bodyweight, routines, notes, workout, scope, telemetry, now,
        undoWindowMs)
    val coach = CoachStore(
        accountOwner = { seat.owner },
        onProgramChanged = { scope.launch { seat.tried("gym.refreshWorkout") { routines.readProgram() } } },
        rest = rest, localCoach = localCoach, telemetry = telemetry, elapsedNanos = elapsedNanos, scope = scope,
        onboarding = coachOnboarding,
    )

    private var connecting = false
    private var engineObservation: Job? = null

    // Whether the seat in hand has trained nothing at all: unknown until the account and its log are read.
    val initialGymEmpty: Boolean? get() = if (seat.accountReady && history.logReadReady)
        routines.all.isEmpty() && history.allSessions.isEmpty() && workout.session == null else null

    suspend fun restoreWorkout(cachedOwner: String?, authorized: Boolean): Boolean {
        if (!authorized) { seat.localWorkoutAuthorized = false; workout.withdrawFacts(); return false }
        if (seat.workoutReady) return true
        seat.localWorkoutAuthorized = authorized
        seat.owner = cachedOwner
        try {
            controls.adopt(seat.owner)
            workout.projectEngineReplica()
            workout.preferences = training.settings()
            routines.readCatalogue()
            routines.readProgram()
            bodyweight.readSeries()
            val movement = controls.chosenMovement
            val previous = if (seat.owner == null && movement != null) seat.readTraining {
                try { training.lastTime(movement) } catch (_: TrainingRefused) { null }
            } else null
            seat.workoutReady = true
            workout.reconcileWorkoutTime()
            workout.restored(movement, previous)
        } catch (_: TrainingReadChanged) { return false }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) {
            seat.reportFailure("gym.restoreWorkout", error)
            workout.refuseWorkout()
            return false
        }
        return true
    }

    // Before the account changes, confirmed starts settle, the sets they owe follow, and the
    // workout's controls are in the replica the next account's room projects from.
    suspend fun prepareEngineTransition(transitionCurrent: () -> Boolean = { true }) {
        val owner = seat.owner
        val replica = training.engine.activeReplica()
        val controlsReplica = controls.engineReplica
        val drain = EngineTraining(training.engine, writeAuthority = {
            transitionCurrent() && owner == seat.owner && training.engine.activeReplica() == replica && controls.engineReplica == controlsReplica
        })
        drain.recoverAcceptedSets(controls)
        drain.reconcileImports()
        drain.persistControls(controls)
    }

    fun eraseDeletedOwner(account: String, replica: String) {
        controls.eraseOwner(account, replica)
        if (seat.owner == account) {
            seat.localWorkoutAuthorized = false
            seat.workoutReady = false
            seat.pendingConnection = null
            workout.erase()
        }
        coach.eraseOwner(account)
    }

    // Called on launch and on every change of who is signed in. A re-read with the same account
    // preserves open deletion windows.
    suspend fun connect(account: Account) {
        if (!account.resolved) return
        if (!seat.authorityFor(account.user?.id)) {
            if (!seat.workoutAuthorized) workout.withdrawFacts()
            return
        }
        val sameWeightSeat = seat.account?.let {
            it.origin == account.origin && it.user?.id == account.user?.id && it.identityRevision == account.identityRevision
        } == true
        val arriving = seat.account != account
        if (!sameWeightSeat) recovery.forgetSeat()
        seat.account = account
        seat.owner = account.user?.id
        seat.localWorkoutAuthorized = account.locallyTrusted
        seat.pendingConnection = account
        workout.resumePending = true
        if (arriving) {
            seat.isLoading = true
            seat.workoutReady = false
            workout.forgetSeat()
            routines.forgetSeat()
            bodyweight.forgetSeat()
            history.forgetSeat()
            deletions.forgetSeat(sameWeightSeat)
            notes.forgetSeat()
            coach.resetThreads()
            sharing.forgetSeat()
        }
        if (connecting) return
        connecting = true
        try {
            check(controls.writable) { "Restart the app to recover the saved workout." }
            controls.adopt(seat.owner)
            workout.projectEngineReplica(force = arriving || seat.isLoading)
            if (seat.account != account) return
            if (arriving && sameWeightSeat) deletions.refreshHeldWeights()
            workout.preferences = training.settings()
            routines.readCatalogue()
            routines.readProgram()
            bodyweight.readSeries()
            routines.adoptReceipts()
            seat.pendingConnection = null
            seat.workoutReady = true
            workout.reconcileWorkoutTime()
            workout.drawFromControls()
            seat.isLoading = false

            val owner = seat.owner
            history.shelved = seat.tried("gym.loadLog") { history.refusedImports() } ?: return
            seat.tried("gym.import_reconcile") { training.reconcileImports() }
            if (owner != seat.owner) return
            history.loadLog()
            if (owner != seat.owner) return
            workout.refreshWorkout()
            bodyweight.loadBodyweight()
            if (history.progressWanted) history.loadProgress()
            if (owner != seat.owner) return
            workout.resume()
            if (workout.lastSetsWanted) workout.loadLastSets()
        } catch (_: TrainingReadChanged) {
            // The observer resumes the pending connection after the superseding engine revision.
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            seat.reportFailure("gym.connect", error)
            if (seat.account == account) {
                seat.pendingConnection = null
                workout.authorizeWorkout(false)
                workout.refuseWorkout()
                seat.isLoading = false
            }
        } finally {
            connecting = false
            if (seat.pendingConnection != null) seat.askRefresh()
        }
    }

    fun observeEngine(): Job {
        engineObservation?.let { return it }
        val engine = training.engine
        val refreshes = Channel<Unit>(Channel.CONFLATED)
        seat.refreshes = refreshes
        engineObservation = scope.launch {
            for (ignored in refreshes) seat.tried("gym.refreshWorkout") { refreshEngine() }
        }
        scope.launch { engine.status.state.collect { refreshes.trySend(Unit) } }
        history.observePulls()
        scope.launch { engine.notices("gym").notices.collect { refreshes.trySend(Unit) } }
        scope.launch { engine.offers.offers.collect { refreshes.trySend(Unit) } }
        for (type in listOf("exercise", "exerciseName", "routine", "routineCreation", "session", "set", "prefs", "note", "weighin", "proposal"))
            scope.launch { engine.records(ScopeRef.product("gym"), type).state.collect { refreshes.trySend(Unit) } }
        return requireNotNull(engineObservation)
    }

    suspend fun refreshEngine() {
        if (!seat.authorityFor(seat.owner)) return
        seat.pendingConnection?.let { account ->
            if (!connecting) connect(account)
            return
        }
        if (controls.engineReplica != training.engine.activeReplica()) return
        val owner = seat.owner
        seat.tried("gym.import_reconcile") { training.reconcileImports() }
        if (training.firstPullComplete && !training.anonymous) training.imports.retireStartSources()
        if (owner != seat.owner) return
        seat.replicaReadRevision = training.engine.readRevision()
        workout.refusals = training.refusedWrites()
        history.loadLog()
        if (owner != seat.owner) return
        val details = seat.tried("gym.refreshWorkout") { seat.readTraining { training.details() } } ?: return
        // A refused delete puts its row back in the replica; an older screen must draw it again.
        held.deletedSets = held.deletedSets - details.flatMap { detail -> detail.sets.map { it.id } }.toSet()
        history.refreshRetained(details)
        routines.readCatalogue()
        if (seat.tried("gym.refreshWorkout") { routines.readProgram(); true } != true) return
        routines.readReceipts()
        workout.preferences = training.settings()
        notes.reread(owner)
        deletions.rereadWeighIns(owner)
        if (workout.lastSetsWanted) workout.loadLastSets()
        if (history.progressWanted) history.loadProgress(force = true)
        if (!controls.writable) return
        workout.drawFromControls()
        if (workout.resumePending) workout.resume() else workout.readLastTime()
    }

    fun clearRefusals() {
        if (!seat.workoutAuthorized) return
        training.dismissRefusals()
        workout.refusals = emptyList()
        notes.forgetRefusals()
    }
}
