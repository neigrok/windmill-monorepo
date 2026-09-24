package works.windmill.gym.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
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
import works.windmill.gym.domain.Ask
import works.windmill.gym.domain.AskExchange
import works.windmill.gym.domain.AskGeneration
import works.windmill.gym.domain.CoachDraft
import works.windmill.gym.domain.CoachAttachment
import works.windmill.gym.domain.AskAnswer
import works.windmill.gym.domain.AskCap
import works.windmill.gym.domain.AskQuestion
import works.windmill.gym.domain.AskThread
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
import works.windmill.gym.domain.PlanSnapshot
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
import works.windmill.gym.domain.TheSix
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.WeighIn
import works.windmill.gym.domain.WeighInWrite
import works.windmill.gym.net.GymHttp
import works.windmill.gym.net.RefusalFacts
import works.windmill.gym.net.TrainingSyncing
import works.windmill.gym.domain.ClaimBatch
import works.windmill.gym.domain.ClaimConsent
import works.windmill.gym.domain.ClaimKind
import java.util.UUID
import works.windmill.platform.Account
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.telemetry.Telemetry

// Main-thread boundary for training reads, durable local writes, and account synchronization.
class TrainingStore(
    private val queue: SetQueue,
    private val deviceCopy: DeviceCopy,
    private val localLog: LocalLog,
    private val localPreferences: LocalPreferences,
    private val localBodyweight: LocalBodyweight,
    private val scope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
    private val mintSession: () -> String = Ids::session,
    private val mintSet: () -> String = Ids::set,
    private val mintRoutine: () -> String = Ids::routine,
    private val mintExercise: () -> String = Ids::exercise,
    private val undoWindowMs: Long = Withheld.windowMs,
    private val retryAfterMs: Long = 4_000,
    private val sync: (Account) -> TrainingSyncing? = { if (it.isSignedIn) GymHttp(it.api) else null },
    private val openConsent: () -> LocalClaimConsent = { LocalClaimConsent(localLog.claimConsentFile) },
    private val workoutClock: WorkoutClock = WorkoutClock { val at = now(); WorkoutMoment(at, at, "local") },
    private val workoutAuthority: (String?) -> Boolean = { true },
    private val telemetry: Telemetry = Telemetry.None,
    private val elapsedNanos: () -> Long = System::nanoTime,
    private val localCoach: LocalCoach? = null,
) {
    private fun reportFailure(operation: String, error: Exception) {
        if (error is WindmillApiException || error is CancellationException) return
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
            if (queue.session != null && queue.writable) queue.control(queue.workout.invalidate())
        } catch (error: Exception) {
            reportFailure("gym.revokeWorkoutAuthority", error)
            refuseWorkout()
        }
        workoutFacts.value = null
    }
    private var workoutReady = false
    private var localWorkoutAuthorized = true
    private val workoutAuthorized: Boolean get() = localWorkoutAuthorized && workoutAuthority(owner)

    fun restoreWorkout(cachedOwner: String?, authorized: Boolean, account: Account? = null) {
        if (workoutReady) return
        localWorkoutAuthorized = authorized
        owner = cachedOwner
        if (authorized && account?.user?.id == cachedOwner) { gym = account?.let(sync); seated = account }
        try {
            queue.adopt(owner)
            localLog.adopt(owner)
            localPreferences.adopt(owner)
            localBodyweight.adopt(owner)
            preferences = localPreferences.document
            val known = deviceCopy.movements(owner) + localLog.exercises
            catalog = known.distinctBy { it.id } + TheSix.missingFrom(known)
            routines = Program.overlay(deviceCopy.routines(owner), localLog.routines)
            val decision = consent?.state
            if (decision is ClaimConsent.Approved) blockedConsentSeat = Seat.of(decision.owner)
            workoutReady = true
            reconcileWorkoutTime()
            exerciseId = queue.chosenMovement
            lastTime = exerciseId?.let { LastTime.of(it, localLog.details()) }.takeIf { owner == null }
            drawFromQueue()
        } catch (error: Exception) {
            reportFailure("gym.restoreWorkout", error)
            refuseWorkout()
        }
    }

    fun reconcileWorkoutTime() {
        if (!workoutReady || !queue.writable) return
        if (!workoutAuthorized || consentRecoveryBlocked) { refreshWorkout(); return }
        val live = queue.session
        if (live != null) {
            val moment = workoutClock.now()
            val origin = queue.latestSet(moment)?.origin ?: queue.workout.started
            val overAt = if (origin?.bootId == moment.bootId) {
                origin.wallMs.takeIf { moment.elapsedMs - origin.elapsedMs >= AutoClose.AFTER_MS }
            } else AutoClose.at(live, queue.sets(live.id), moment.wallMs)
            if (overAt != null) {
                if (queue.sessionIsUnclaimed) shelve(live, overAt) else queue.close(live.id)
                drawFromQueue()
                return
            }
        }
        refreshWorkout()
    }

    fun editRack(weightKg: Double, reps: Int): WorkoutChange {
        if (isFinishing || !workoutAuthorized || !queue.writable) return WorkoutChange.Unavailable(workoutFailure ?: "The workout is not ready.")
        if (session == null || rack == null) return WorkoutChange.Stale
        return try {
            queue.control(queue.workout.edit(weightKg, reps))
            refreshWorkout()
            WorkoutChange.Saved
        } catch (error: Exception) {
            reportFailure("gym.editRack", error)
            WorkoutChange.Unavailable(refuseWorkout())
        }
    }

    fun editWorkout(open: Boolean): WorkoutChange {
        if (!workoutAuthorized || consentRecoveryBlocked) return WorkoutChange.Unavailable("The account must be restored first.")
        return try {
            queue.control(queue.workout.editor(open))
            refreshWorkout()
            WorkoutChange.Saved
        } catch (error: Exception) {
            reportFailure("gym.editWorkout", error)
            WorkoutChange.Unavailable(refuseWorkout())
        }
    }

    fun acceptSet(command: LogSetCommand, scheduleDelivery: Boolean = true): LogSetAcceptance {
        reconcileWorkoutTime()
        if (!workoutAuthorized || consentRecoveryBlocked || isFinishing || !queue.writable) {
            return LogSetAcceptance.Unavailable(workoutFailure ?: "The workout is not ready.")
        }
        return try {
            val accepted = queue.accept(command, workoutClock.now(), lastTime, mintSet)
            if (accepted is LogSetAcceptance.Accepted) {
                telemetry.event("gym_set_logged")
                drawFromQueue()
                if (scheduleDelivery) scope.launch { deliver() }
            }
            accepted
        } catch (error: Exception) {
            reportFailure("gym.acceptSet", error)
            LogSetAcceptance.Unavailable(refuseWorkout())
        }
    }

    fun showWorkout(key: WorkoutKey, hidden: Boolean): WorkoutChange {
        if (!workoutAuthorized || consentRecoveryBlocked) return WorkoutChange.Unavailable("The account must be restored first.")
        if (workoutFacts.value?.key != key) return WorkoutChange.Stale
        return try {
            queue.control(queue.workout.visibility(hidden))
            refreshWorkout()
            WorkoutChange.Saved
        } catch (error: Exception) {
            reportFailure("gym.showWorkout", error)
            WorkoutChange.Unavailable(refuseWorkout())
        }
    }

    private fun refreshWorkout() {
        if (!workoutReady) return
        if (!workoutAuthorized || consentRecoveryBlocked) { workoutFacts.value = null; return }
        val live = queue.session
        if (live == null) {
            rack = null
            workoutFacts.value = null
            return
        }
        val ready = workoutAuthorized && !consentRecoveryBlocked && !isFinishing && queue.writable
        val state = try {
            if (queue.writable && workoutAuthorized && !consentRecoveryBlocked) queue.prepare(lastTime, workoutClock.now(), ready, mintSet) else queue.workout
        } catch (error: Exception) {
            reportFailure("gym.refreshWorkout", error)
            refuseWorkout()
            return
        }
        rack = state.rack
        val movement = queue.chosenMovement
        val rows = queue.sets.filter { it.exerciseId == movement }
        workoutFacts.value = WorkoutNotification(WorkoutKey(accountKey, live.id), live,
            movement?.let { Readout.movement(it, catalog) } ?: "Choose a movement", rows, state, ready)
    }

    private fun refuseWorkout(): String {
        val reason = "The workout could not be saved safely. Restart the app to recover it."
        workoutFailure = reason
        workoutFacts.value = workoutFacts.value?.copy(offer = null)
        return reason
    }

    var consentFailure: String? by mutableStateOf(null)
        private set
    private var consent: LocalClaimConsent? = try { openConsent() } catch (failure: Exception) {
        reportFailure("gym.consent", failure)
        consentFailure = "Local data could not be read safely. Restart the app to try again."
        null
    }
    private var offeredBatch: ClaimBatch? = null
    private var blockedConsentSeat: String? = if (consent == null) "unknown" else null
    private val consentRecoveryBlocked: Boolean get() = blockedConsentSeat == "unknown" || blockedConsentSeat == Seat.of(owner)
    private var consentDecision = 0L
    var claimBusy: Boolean by mutableStateOf(false)
        private set

    val localDataBatch: ClaimBatch?
        get() {
            val journal = consent ?: return null
            val decision = try {
                journal.state
            } catch (failure: Exception) {
                reportFailure("gym.consent", failure)
                return null
            }
            if (decision is ClaimConsent.Approved) return decision.batch.takeIf { decision.owner == owner }
            if (decision is ClaimConsent.Discarding) return decision.batch
            if (decision is ClaimConsent.AwaitingSignIn) return decision.batch
            val items = localLog.claimItems() + queue.claimItems() + localBodyweight.claimItems() + localPreferences.claimItems()
            if (items.isEmpty()) return null
            val before = offeredBatch
            if (before?.items == items) return before
            return ClaimBatch(UUID.randomUUID().toString(), items).also { offeredBatch = it }
        }

    // Filled by `connect` from the copy the device holds FOR THE SEAT NOW ASKING: a name is
    // per-account the moment a rename exists.
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
    // The device's copy of the series for the seat in hand, ascending by date; the log's answer
    // replaces it on connect except for what this phone still owes.
    private var series: List<WeighIn> by mutableStateOf(emptyList())
    // A weigh-in inside its undo window is off the DRAWN series for every reader — the chart's dots
    // and the log's head reading both — so one of them can never draw a day the other has dropped.
    // Writes go to `series`, which is the whole of it.
    val bodyweight: List<WeighIn>
        get() = series.filterNot { it.dateLocal in withheldIds }
    // The whole series, a withheld weigh-in included. A window decides which ROWS are drawn and
    // never what state a screen is in, so the chart's empty stance is read from here.
    val allWeighIns: List<WeighIn> get() = series
    var bodyweightRead by mutableStateOf(false)
        private set
    var bodyweightLoading by mutableStateOf(false)
        private set
    var bodyweightFailure: WriteFailure? by mutableStateOf(null)
        private set
    private val bodyweightWrite = Mutex()
    private val preferencesWrite = Mutex()
    private var bodyweightRevision = 0L
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

    // The account's notes as the log last answered them, in the log's order. Nothing is kept between
    // runs — the read on the way in is the whole of it — but the ROOM holds them while it is open,
    // because a screen keeping a snapshot of its own would draw a note back the moment its window
    // settled. Writes go to `notebook`, which is the whole of it.
    private val notebookWrite = Mutex()
    private val conversationWrite = Mutex()
    private val proposalWrite = Mutex()
    private var notebook: List<Note> by mutableStateOf(emptyList())
    // A note inside its undo window is off the list; `noteCount` still counts it, because the log
    // refuses the eleventh whether or not this screen is drawing the tenth.
    val notes: List<Note>
        get() = notebook.filterNot { it.id in withheldIds }
    val noteCount: Int get() = notebook.size
    // The account's conversations as the log last answered them, newest first. Held by the ROOM for
    // exactly the reason the notes are: a screen keeping a snapshot of its own would draw a
    // conversation back the moment its window settled. Writes go to `conversations`.
    private var conversations: List<AskThread> by mutableStateOf(emptyList())
    // A conversation inside its undo window is off the list; `allThreads` still holds it, because the
    // account does. A window decides which ROWS are drawn and never what state a screen is in, so the
    // threads room reads its empty stance from `allThreads`.
    val threads: List<AskThread> get() = conversations.filterNot { it.id in withheldIds }
    val allThreads: List<AskThread> get() = conversations
    // Every proposal this room settled, as the log's reply said it: a card minted in a conversation
    // reads off this before the copy it was minted with, so a settled one never keeps saying waiting.
    var settledProposals: Map<String, Proposal> by mutableStateOf(emptyMap())
        private set
    // Every write to the program is also written to the device copy for the seat holding it, so a
    // connect that cannot read the log draws it back.
    private var program: List<Routine> by mutableStateOf(emptyList())
    // The whole program, a withheld routine included. The routines home reads its empty stance and
    // the position it writes a new routine at from here: a window decides which ROWS are drawn and
    // never what state a screen is in.
    val allRoutines: List<Routine> get() = program
    var routines: List<Routine>
        // A routine inside its undo window is off the program as far as every screen is concerned:
        // nothing was sent, and only Undo puts it back. Writes go to `program`, which is the whole
        // of it.
        get() = program.filterNot { it.id in withheldIds }
        private set(value) {
            program = value
            if (gym != null) deviceCopy.holdRoutines(owner, value)
        }
    // The cursor is the oldest row the LOG sent, never one of ours, or `Load older` would page from
    // a session the server has never heard of.
    var logged: List<SessionSummary> by mutableStateOf(emptyList())      // the account's pages, newest first
        private set
    private var logReadRevision = 0L
    var shelved: List<SessionSummary> by mutableStateOf(emptyList())     // the device's own, unclaimed
        private set
    // Both, merged on the clock, until the claim empties the shelf: everything the account and this
    // device hold between them, which is what the log's empty stance and the first-session line are
    // read from.
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
    // Sparse: the absence of a key is `never logged`. NULL is the map that has not landed; an EMPTY
    // map is an answer, that this lifter has trained nothing.
    private var meta: Map<String, LastSet>? by mutableStateOf(null)
    var lastSets: Map<String, LastSet>?
        get() = meta
        private set(value) {
            meta = value
            if (gym != null && value != null) deviceCopy.holdLastSets(owner, value.values.toList())
        }
    // The catalog read was asked and did not answer, so what is on screen is only `TheSix` and
    // whatever this device minted.
    var catalogUnread: Boolean by mutableStateOf(false)
        private set
    var prefill: Prefill by mutableStateOf(Prefill(Prefill.EMPTY_BAR_KG, Prefill.EMPTY_BAR_REPS))
        private set
    var refusals: List<RefusedWrite> by mutableStateOf(emptyList())      // writes that never landed
        private set
    // Nothing is told until a window closes: the log has no undelete. A LIST and not a slot — each
    // delete carries its own clock and a second one never settles the first. NOT on disk: an
    // activity recreated inside a window has told no log, so what it held survives.
    var withheld: List<WithheldDelete> by mutableStateOf(emptyList())
        private set
    // One clock per subject, so a window can be taken down as well as opened: leaving the room lets
    // go of what it was holding, and a clock still running would settle a delete nobody is holding
    // any more. Not composition state — nothing draws it.
    private val clocks = mutableMapOf<String, Job>()
    // A delete the log refused after its window closed, said once and cleared. Nothing local was
    // crossed out, so the row is back on the next read.
    var deleteRefused: String? by mutableStateOf(null)
        private set
    // One room's memory of its own writes, never a tombstone: a session read BEFORE the delete would
    // otherwise draw a row that is gone.
    var deletedSets: Set<String> by mutableStateOf(emptySet())
        private set
    var saveState: SaveState by mutableStateOf(SaveState.Idle)
        private set
    var saveTick: Int by mutableStateOf(0)                               // bumps once per write
        private set
    // Sets a walk met and could not land. A set whose first send is still in flight is not stranded.
    var strandedCount: Int by mutableStateOf(0)
        private set
    // What the last walk ended with still owed. A set logged since is on its way, not stuck.
    private var leftBehind by mutableStateOf(emptySet<String>())
    // Set by the walk from the failure it met, never inferred from a set that has not landed.
    var strandedBy: Blocker? by mutableStateOf(null)
        private set
    var isLoading: Boolean by mutableStateOf(true)
        private set
    // Finish is a round trip, and a set logged into a session that closes under it is refused forever.
    var isFinishing: Boolean by mutableStateOf(false)
        private set

    private var gym: TrainingSyncing? = null
    // Kept only so the quarantine's two verbs can redraw.
    private var seated: Account? = null
    // Whose the names on this device are: the account id, or null for the anonymous seat.
    private var owner: String? = null
    private val delivery = Mutex()
    private var setIds = emptyMap<String, String>()
    private var closedFailures by mutableStateOf<Map<String, WriteFailure>>(emptyMap())
    private var closedDetails by mutableStateOf<Map<String, SessionDetail>>(emptyMap())
    private val lastTimes = mutableMapOf<String, LastTime>()
    // A change of seat drops the map and the picker's own effect never runs again, so `connect` asks
    // again on the way out.
    private var lastSetsWanted = false
    // A routine read that missed, recorded rather than left as an empty list: "this lifter has
    // written none" is a claim only an answer can support.
    private var routinesFailed = false
    private var retryTask: Job? = null
    // While true, the boot read may not trade the phone's own workout for a different open one. It is
    // the QUEUE's persisted fact, never derived from how a claim pass ended.
    private val liveUnclaimed: Boolean get() = queue.sessionIsUnclaimed
    // Mid-replay a start may not go to the log at all: a start JOINS whatever session is open, and
    // mid-replay that is a PAST one the claim reopened. Starts compose on the device instead, and the
    // boot read stands down.
    private var claimsRunning = 0
    private val claiming: Boolean get() = claimsRunning > 0
    // Completed whenever no claim is running. Every read that SETTLES staleness on the server waits
    // on it, or it closes a session the claim just reopened and refuses every set still owed into it.
    private var claimIdle = CompletableDeferred(Unit)
    // Runners never overlap: the one running goes once more when its pass ends.
    private var claimAgain = false
    // Owed to the cadence, the same task that carries the owed sets. Only retryable stops arm it: a
    // WAIT on the account's other workout stays event-driven.
    private var claimOwed = false

    // Two independent facts, each carried by its own send: the whole walk for the shelf, one PUT for
    // the settings document.
    private val cadenceOwed: Boolean get() = gym != null && (claimOwed || localPreferences.owed)

    internal companion object {
        private const val accountChanged = "The account changed. Open this again."
        // At or under the server's ceiling of 200: a larger page comes back short and reads as the
        // bottom of the log.
        const val logPage = 50

        const val proposalsWantAnAccount = "a proposal needs your account — sign in first"

        const val askWantsAnAccount = "Coach reads your log — sign in first"

        const val notesWantAnAccount = "Notes live with your account — sign in first"

        // Absent, another account's and deleted are one sentence: three answers a stranger could tell
        // apart would say whether a conversation exists on somebody else's log.
        const val noSuchThread = "that conversation is no longer on the log"

        const val liveSlotTaken =
            "finish the workout you’re in first — the one this phone kept needs the slot"

        const val quarantineWantsAnAccount =
            "sign in first — this can only be added to an account, and only you can say it is yours"
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

    // Signed out, every drawn row owing the log something is on this device and nowhere else; signed
    // in, only the ones whose append or correction a walk could not land. A deleted row is not drawn.
    val stalled: Set<String>
        get() = queue.pending.filter { it.owes != Owed.Delete && (gym == null || it.set.id in leftBehind) }
            .mapTo(mutableSetOf()) { it.set.id }

    // A routine carries its own pending proposal, so nothing polls and nothing pushes. Newest first.
    val pendingProposals: List<Proposal>
        get() = routines.mapNotNull { it.pendingProposal }.sortedByDescending { it.createdAtMs }

    fun routine(id: String): Routine? = routines.firstOrNull { it.id == id }

    // Every id the lifter has deleted and the log has not been told about. Every list that could
    // draw one filters against it: as far as the lifter is concerned the row is gone.
    val withheldIds: Set<String> get() = withheld.mapTo(mutableSetOf()) { it.subjectId }

    // The newest window still the lifter's — what the transient offers to take back. Null the
    // instant the newest delete is committed to the wire, which is what takes the transient down.
    val holding: WithheldDelete? get() = withheld.lastOrNull { it.takeable }

    // How long the newest way back has left. The store STAMPED that instant, so the store is what
    // subtracts from it: a room reaching for a clock of its own would measure a span against an
    // instant some other clock wrote.
    val wayBackLeftMs: Long
        get() = (holding?.untilMs ?: 0L) - now()

    // Nothing has ever happened in this room. It asks whether the reads that could say otherwise
    // actually LANDED, never whether their lists came back empty: `older == End` is the log page
    // answering "there is no more". The session the lifter is IN is not counted.
    //
    // Both halves read what the ACCOUNT holds and neither reads a drawn list: a window decides which
    // rows are drawn and never what state a screen is in, and this state opens the picker with a
    // first-session title and a drawn `Build my routine`.
    val firstSession: Boolean
        get() = allSessions.isEmpty() && program.isEmpty() && !routinesFailed && older == Older.End

    // Called on launch and on every change of who is signed in. Draws from the device first.
    suspend fun connect(account: Account) {
        // Whether a lifter ARRIVED, or the room is re-reading for the seat already in hand — the
        // shelf's claim and its discard both come back through here, mid-window, for the same seat.
        if (!account.resolved) return
        if (!workoutAuthority(account.user?.id)) {
            if (!workoutAuthorized) workoutFacts.value = null
            return
        }
        localWorkoutAuthorized = account.locallyTrusted
        workoutReady = true
        val arriving = seated != account
        gym = sync(account)
        seated = account
        // Names and pending writes stay with the seat that owns them.
        if (owner != account.user?.id) {
            workoutFacts.value = null
            session = null
            rack = null
            sets = emptyList()
            exerciseId = null
        }
        owner = account.user?.id
        // A workout composed on this device is filed under the seat that composed it, so a claim can
        // never replay one lifter's training into the account that signed in after them. An
        // unverified seat draws its own room but may not take ownership of unclaimed work.
        try { queue.adopt(owner) }
        catch (error: Exception) {
            reportFailure("gym.connect", error)
            authorizeWorkout(false)
            refuseWorkout()
            isLoading = false
            return
        }
        localLog.adopt(owner)
        localPreferences.adopt(owner)
        preferences = localPreferences.document
        localBodyweight.adopt(owner)
        val selectedOwner = owner
        val selectedWriter = gym
        recoverConsent()
        if (owner != selectedOwner || gym !== selectedWriter) return
        preferences = localPreferences.document
        series = localBodyweight.entries
        bodyweightRevision += 1
        bodyweightRead = gym == null
        bodyweightLoading = false
        bodyweightFailure = null
        progressRevision += 1
        progressCache = null
        progressFailure = null
        progressLoading = false
        // The six ride with every seat and fill only ids nothing else here holds, so a name this
        // account chose is never overwritten by a constant.
        val known = deviceCopy.movements(owner).let { held ->
            held + localLog.exercises.filter { mine -> held.none { it.id == mine.id } }
        }
        catalog = known + TheSix.missingFrom(known)
        deviceCopy.hold(owner, catalog)
        // The copy this device last read for THIS account draws first; the read that follows replaces
        // it.
        routines = Program.overlay(deviceCopy.routines(owner), localLog.routines)
        // The last-time cache dies with the seat; the picker's meta goes with it.
        lastTimes.clear()
        settledProposals = emptyMap()
        lastSets = null
        // Neither read has been made for THIS seat.
        routinesFailed = false
        catalogUnread = false
        // The pages go with the seat, and this is the one place they do: `loadLog` keeps whatever walk
        // is under a thumb, which it may only do while every row belongs to the account now asking.
        logged = emptyList()
        older = Older.More
        // A withheld delete goes with the SEAT, UNSENT: settling it now would take a row off the log
        // of the account that just arrived. Its clock goes with it, or it would settle a window the
        // next seat never opened. A re-read for the seat already in hand takes nothing down: the
        // shelf's own discard runs through here while other windows are open, and dropping them
        // would leave a lifter told `Note deleted.` over a note that is never sent and never said.
        if (arriving) {
            closedDetails = emptyMap()
            setIds = emptyMap()
            closedFailures = emptyMap()
            for (clock in clocks.values) clock.cancel()
            clocks.clear()
            withheld = emptyList()
            deleteRefused = null
            deletedSets = emptySet()
            notebook = emptyList()
            conversations = emptyList()
            nextThreadCursor = null
            connectedLog = ConnectedLogState.Unknown
        }
        // A workout both finished on the shelf and live in the queue: the shelf's copy wins, after
        // its sets merge in.
        queue.session?.let { live ->
            val shelved = localLog.detail(live.id)
            if (shelved != null) {
                localLog.hold(LocalLog.FinishedSession(shelved.session, queue.sets(live.id)))
                queue.forget(live.id)
                queue.flush()
            }
        }
        reconcileWorkoutTime()
        drawFromQueue()
        isLoading = false

        val log = gym
        val seat = owner
        if (log == null) {
            // Signed out the shelf is the whole log, so the foot is already at the bottom.
            claimOwed = false
            logged = emptyList()
            shelved = localLog.summaries()
            older = Older.End
            saveState = if (queue.pending.isEmpty()) SaveState.Idle else SaveState.OnThisDevice
            resume()
            if (lastSetsWanted) loadLastSets()
            return
        }
        // The queue goes out first, before anything that can settle, and the claim's starts settle.
        shelved = localLog.summaries()
        if (!consentRecoveryBlocked) deliver()
        if (seat != owner || gym !== log) return
        if (!consentRecoveryBlocked) runClaim()
        if (seat != owner || gym !== log) return
        // The sets parked behind the live start go out once it has landed.
        deliver()
        if (seat != owner || gym !== log) return
        coroutineScope {
            launch { loadLog() }
            // Held on the device as well as in memory, so the next cold launch draws names.
            launch {
                val before = catalog.associateBy { it.id }
                val served = tried("gym.connect") { log.exercises() }
                if (seat != owner || gym !== log) return@launch
                if (served == null) {
                    // Only when the room has nothing of its own to draw.
                    catalogUnread = known.isEmpty()
                    return@launch
                }
                val changed = catalog.filter { before[it.id] != it }.associateBy { it.id }
                val fetched = served + localLog.exercises.filter { mine -> served.none { it.id == mine.id } }
                val whole = fetched.map { changed[it.id] ?: it } + changed.values.filter { fresh -> fetched.none { it.id == fresh.id } }
                catalog = whole + TheSix.missingFrom(whole)
                deviceCopy.hold(owner, catalog)
                refreshWorkout()
            }
            launch {
                val written = tried("gym.connect") { log.routines() }
                if (seat != owner || gym !== log) return@launch
                if (written == null) {
                    routinesFailed = true
                    return@launch
                }
                routines = Program.overlay(written, localLog.routines)
            }
            // May not land on top of a document this device still owes; `readBack` refuses that.
            launch {
                tried("gym.connect") { log.preferences() }?.let {
                    if (seat != owner || gym !== log) return@launch
                    localPreferences.readBack(it)
                    preferences = localPreferences.document
                    refreshWorkout()
                }
            }
            launch { loadBodyweight() }
            if (progressWanted) launch { loadProgress() }
        }
        if (seat != owner || gym !== log) return
        resume()
        if (lastSetsWanted) loadLastSets()
    }

    val unattributed: LocalLog.Unattributed?
        get() = localDataBatch?.let { batch ->
            LocalLog.Unattributed(batch.items.count { it.kind == ClaimKind.Session }, batch.routines,
                batch.movements, batch.items.filter { it.kind == ClaimKind.Session }.mapNotNull { it.atMs }.sortedDescending())
        }

    val unattributedIsLive: Boolean get() = localDataBatch?.items?.any { it.activeSession } == true

    fun requestClaimSignIn(): String? {
        return try {
            val journal = checkNotNull(consent)
            val standing = journal.state
            if (standing is ClaimConsent.AwaitingSignIn) {
                consentFailure = null
                return standing.flowId
            }
            val batch = localDataBatch ?: return null
            val flow = UUID.randomUUID().toString()
            journal.requestSignIn(batch, flow)
            consentFailure = null
            flow
        } catch (failure: Exception) {
            reportFailure("gym.requestClaimSignIn", failure)
            consentFailure = failure.message ?: "The local-data decision could not be saved."
            null
        }
    }

    fun approveSignIn(userId: String, flowId: String?) {
        if (flowId == null) return
        val journal = checkNotNull(consent) { "The local-data decision could not be read safely." }
        val standing = journal.state
        if (standing is ClaimConsent.Approved) {
            check(standing.owner == userId && standing.flowId == flowId) {
                "That sign-in request no longer owns the local-data decision."
            }
            return
        }
        val decision = standing as? ClaimConsent.AwaitingSignIn
            ?: error("That sign-in request no longer owns the local-data decision.")
        check(decision.flowId == flowId) { "That sign-in request no longer owns the local-data decision." }
        preflight(decision.batch, userId)
        journal.approve(decision.batch, userId, flowId)
    }

    fun cancelClaimSignIn(flowId: String?) {
        if (flowId == null) return
        try {
            val journal = consent ?: return
            val decision = journal.state as? ClaimConsent.AwaitingSignIn ?: return
            if (decision.flowId == flowId) journal.complete(decision.batch.id)
        } catch (failure: Exception) {
            reportFailure("gym.cancelClaimSignIn", failure)
            consentFailure = "The local-data decision could not be saved. Restart the app to try again."
        }
    }

    private fun preflight(batch: ClaimBatch, target: String?) {
        queue.preflight(batch, target)
        localLog.preflight(batch, target)
        localBodyweight.preflight(batch, target)
        localPreferences.preflight(batch, target)
    }

    private fun completeConsent(batch: ClaimBatch, target: String?) {
        preflight(batch, target)
        if (target != null) blockedConsentSeat = Seat.of(target)
        queue.complete(batch, target)
        localLog.complete(batch, target)
        localBodyweight.complete(batch, target)
        localPreferences.complete(batch, target)
        checkNotNull(consent).complete(batch.id)
        offeredBatch = null
        blockedConsentSeat = null
        consentFailure = null
    }

    private suspend fun recoverConsent() {
        val journal = consent ?: return
        val seat = owner
        val log = gym
        try {
            when (val decision = journal.state) {
                is ClaimConsent.Discarding -> completeConsent(decision.batch, null)
                is ClaimConsent.Approved -> {
                    if (decision.owner != seat) return
                    blockedConsentSeat = Seat.of(seat)
                    if (seated?.verified != true || log == null) return
                    if (decision.batch.items.any { it.kind == ClaimKind.Queue && it.activeSession }) {
                        val open = log.sessions(logPage, null, null).firstOrNull { it.session.isOpen }
                        if (owner != seat || gym !== log) return
                        check(open == null || decision.batch.items.any { it.kind == ClaimKind.Queue && it.id == open.id }) {
                            "Finish the account’s current workout before adding this training."
                        }
                    }
                    completeConsent(decision.batch, seat)
                }
                else -> Unit
            }
        } catch (failure: Exception) {
            reportFailure("gym.recoverConsent", failure)
            if (failure is CancellationException) throw failure
            if (owner != seat || gym !== log) return
            consentFailure = failure.message ?: "Local data could not be updated. Restart the app to try again."
        }
    }

    suspend fun releaseUnattributed(): String? {
        val seat = owner ?: return quarantineWantsAnAccount
        val log = gym ?: return quarantineWantsAnAccount
        if (seated?.verified != true) return "Connect to verify this account before adding local training."
        val journal = consent ?: return consentFailure
        val batch = localDataBatch ?: return null
        if (claimBusy) return null
        val decision = ++consentDecision
        claimBusy = true
        try {
            if (batch.items.any { it.kind == ClaimKind.Queue && it.activeSession }) {
                val open = log.sessions(logPage, null, null).firstOrNull { it.session.isOpen }
                if (owner != seat || gym !== log) return accountChanged
                if (decision != consentDecision) return null
                check(open == null || batch.items.any { it.kind == ClaimKind.Queue && it.id == open.id }) {
                    "Finish the account’s current workout before adding this training."
                }
            }
            if (decision != consentDecision) return null
            preflight(batch, seat)
            if (journal.state is ClaimConsent.AwaitingSignIn) journal.complete(batch.id)
            journal.approve(batch, seat)
            completeConsent(batch, seat)
            seated?.let { connect(it) }
            return consentFailure
        } catch (failure: Exception) {
            reportFailure("gym.releaseUnattributed", failure)
            if (failure is CancellationException) throw failure
            if (owner != seat || gym !== log) return accountChanged
            consentFailure = failure.message ?: "The local-data decision could not be saved."
            return consentFailure
        } finally {
            if (decision == consentDecision) claimBusy = false
        }
    }

    private fun discardUnattributed(batch: ClaimBatch) {
        val journal = checkNotNull(consent) { "The local-data decision could not be read safely." }
        journal.discard(batch)
        completeConsent(batch, null)
    }

    // Signed in the session opens on the log and the server freezes the plan snapshot off the
    // routine's own row; signed out it is composed here off the local row. No signal composes on the
    // device and the claim lands it; only a refusal WITH A REASON is repeated.
    suspend fun start(routineId: String? = null): GymResult<Session> {
        if (!workoutAuthorized || consentRecoveryBlocked || !queue.writable) return GymResult.Failed(WriteFailure.Refused(workoutFailure ?: "The account must be restored first."))
        val seat = owner
        val log = gym ?: return startOnDevice(routineId)
        // Two starts the log cannot take: mid-claim a server start would join the past session the
        // replay has open, and a routine still on the shelf is a plan the account cannot resolve.
        if (claiming || routineId?.let { localLog.routine(it) } != null) return startOnDevice(routineId)
        // A start SETTLES a stale open session on the log, so every owed set drains first.
        deliver()
        if (!workoutAuthorized || seat != owner || gym !== log) return GymResult.Failed(WriteFailure.Refused("the account changed while starting"))
        // One id collision is a coincidence; two is a device that cannot mint.
        var collision: WriteFailure = WriteFailure.NoAnswer
        repeat(2) {
            val id = mintSession()
            val startedAt = now()
            try {
                // The flag rides as an EXPLICIT false: WindmillJson omits defaulted values, and an
                // omitted flag IS the join.
                val opened = log.startSession(SessionStart(id = id, startedAt = startedAt,
                    routineId = routineId, joinOpenSession = false))
                if (!workoutAuthorized || seat != owner || gym !== log) return GymResult.Failed(WriteFailure.Refused("the account changed while starting"))
                adopt(opened, joined = opened.id != id)
                if (!workoutAuthorized || seat != owner || gym !== log) return GymResult.Failed(WriteFailure.Refused("the account changed while starting"))
                val live = session ?: return GymResult.Failed(WriteFailure.NoAnswer)
                telemetry.event("gym_session_started", mapOf("storage" to "server"))
                return GymResult.Ok(live)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: WindmillApiException) {
                if (!workoutAuthorized || seat != owner || gym !== log) return GymResult.Failed(WriteFailure.Refused("the account changed while starting"))
                val refused = refusing as? WindmillApiException.Refused
                // A workout is already open on the account: the re-read adopts it and stands the
                // lifter back where they were.
                if (refused?.status == 409 && refused.refusal.code == "session-already-open") {
                    loadLog()
                    if (!workoutAuthorized || seat != owner || gym !== log) return GymResult.Failed(WriteFailure.Refused("the account changed while starting"))
                    resume()
                    return GymResult.Failed(WriteFailure(refusing))
                }
                // No signal, or a clock the log will not take yet: the workout begins here under the
                // id that just went out, because a 5xx is not a promise that nothing was written.
                val facts = RefusalFacts(refusing)
                if (refused == null || refused.status >= 500 || facts.code == "clock-ahead") {
                    return startOnDevice(routineId, id, startedAt)
                }
                // Only a spent session id is worth a second attempt.
                val spent = refused.status == 409 && refused.refusal.code == "session-id-taken"
                if (!spent) return GymResult.Failed(WriteFailure(refusing))
                collision = WriteFailure(refusing)
            } catch (failed: Exception) {
                reportFailure("gym.start", failed)
                if (!workoutAuthorized || seat != owner || gym !== log) return GymResult.Failed(WriteFailure.Refused("the account changed while starting"))
                // The start may have landed before the reply was lost, so the same id rides.
                return startOnDevice(routineId, id, startedAt)
            }
        }
        return GymResult.Failed(collision)
    }

    // One workout is open on this device at a time: a start over a live one answers with the live
    // one. The plan freezes off the routine THIS STORE holds. Signed in the session opens UNCLAIMED.
    //
    // It runs under the id the server start went out with, when there was one: a fresh id would meet
    // the log's own row as `session-already-open` on every claim.
    private suspend fun startOnDevice(
        routineId: String?,
        id: String = mintSession(),
        startedAtMs: Long = now(),
    ): GymResult<Session> {
        if (!workoutAuthorized || consentRecoveryBlocked || !queue.writable) return GymResult.Failed(WriteFailure.Refused("The account must be restored first."))
        queue.session?.let { return GymResult.Ok(it) }
        val routine = routineId?.let { wanted -> localLog.routine(wanted) ?: routines.firstOrNull { it.id == wanted } }
        if (routineId != null && routine == null && gym == null) {
            return GymResult.Failed(WriteFailure.Refused("that routine is not on this device"))
        }
        val opened = Session(id = id, startedAtMs = startedAtMs, routineId = routineId,
            plan = routine?.let { PlanSnapshot(it) })
        queue.hold(opened, unclaimed = true)
        queue.flush()
        drawFromQueue()
        if (gym != null) {
            if (claiming) claimAgain = true
            claimOwed = true
            deliver()
        }
        telemetry.event("gym_session_started", mapOf("storage" to "device"))
        return GymResult.Ok(opened)
    }

    // The answer is kept for the life of the session: a last time is a FINISHED session, so none of
    // these answers can change mid-workout.
    suspend fun choose(movement: String) {
        if (!workoutAuthorized || consentRecoveryBlocked) return
        queue.choose(movement)
        queue.flush()
        order = queue.order
        exerciseId = movement
        lastTime = lastTimes[movement]
        redial()

        if (lastTime != null) return
        val seat = owner
        val sessionId = session?.id
        val log = gym
        val answer = if (log == null) LastTime.of(movement, localLog.details())
            else tried("gym.choose") { log.lastTime(movement) }
        if (!workoutAuthorized || consentRecoveryBlocked || owner != seat || session?.id != sessionId || gym !== log) return
        if (answer?.exerciseId != movement) return
        lastTimes[movement] = answer
        if (exerciseId != movement) return
        lastTime = answer
        redial()
    }

    // Sets are keyed by movement and never by position, so only the walk order moves.
    fun reorder(from: Int, to: Int) {
        if (!workoutAuthorized || consentRecoveryBlocked) return
        val walked = LiveOrder.moved(order, from, to)
        if (walked == order) return
        queue.hold(order = walked)
        queue.flush()
        order = walked
    }

    // False where `LiveOrder.droppable` refuses. Dropping the movement in hand returns to the picker.
    fun drop(exerciseId: String): Boolean {
        if (!workoutAuthorized || consentRecoveryBlocked) return false
        if (!LiveOrder.droppable(exerciseId, sets, session?.plan)) return false
        val walked = order.filterNot { it == exerciseId }
        if (walked == order) return false
        queue.hold(order = walked)
        queue.flush()
        order = walked
        if (this.exerciseId == exerciseId) {
            this.exerciseId = null
            lastTime = null
            redial()
        }
        return true
    }

    // Read when the picker OPENS and never on a keystroke. A read that did not land leaves the map
    // alone: `never logged` is an assertion, and half an answer would make it about every movement
    // the half did not name. The shelf is merged HERE and nowhere else in this store, because this is
    // one movement's most recent set rather than an aggregate.
    suspend fun loadLastSets() {
        lastSetsWanted = true
        val mine = LastSet.of(localLog.details())
        val log = gym
        if (log == null) {
            lastSets = mine.associateBy { it.exerciseId }
            return
        }
        // A read that missed draws the copy this device last read FOR THIS SEAT. A seat with no copy
        // is left as it was: silence, never `never logged`.
        val served = tried("gym.loadLastSets") { log.lastSets() } ?: deviceCopy.lastSets(owner) ?: return
        lastSets = (served + mine)
            .groupBy { it.exerciseId }
            .mapValues { (_, rows) -> rows.maxBy { it.atMs } }
    }

    // The row lands and the device holds it before the network is consulted at all. The kind is the
    // CALLER's and is the one thing about a set that cannot be repaired later.
    suspend fun logSet(weightKg: Double, reps: Int, kind: SetKind = SetKind.Working) {
        if (!workoutAuthorized || consentRecoveryBlocked) return
        val live = session ?: return
        val movement = exerciseId ?: return
        if (isFinishing) return
        if (kind == SetKind.Working) {
            if (editRack(weightKg, reps) !is WorkoutChange.Saved) return
            val offer = notification.value?.offer ?: return
            if (acceptSet(LogSetCommand(offer.key, offer.id), scheduleDelivery = false) !is LogSetAcceptance.Accepted) return
        } else {
            val moment = workoutClock.now()
            val set = TrainingSet(id = mintSet(), exerciseId = movement, weightKg = weightKg, reps = reps,
                kind = kind, completedAtMs = moment.wallMs)
            queue.store(set, live.id, needsPush = true, moment = moment)
            telemetry.event("gym_set_logged")
            drawFromQueue()
        }
        deliver()
    }

    // Application-owned delivery keeps running while screens are absent.
    suspend fun flushPendingSets() {
        deliver()
    }

    // Waits for everything THIS session owes the log — its appends, fixes and deletes — because a
    // session that closed before a set reached it refuses that set forever, and the closed workout is
    // drawn from what the log holds. A write owed to another session cannot stop it closing. A session
    // the log does not hold closes on the device and moves whole onto the shelf.
    suspend fun finish(): FinishOutcome {
        if (!workoutAuthorized || consentRecoveryBlocked) return FinishOutcome.Failed(WriteFailure.Refused("The account must be restored first."))
        if (isFinishing) return FinishOutcome.Failed(WriteFailure.Refused("this workout is already finishing"))
        val live = session ?: return FinishOutcome.Failed(WriteFailure.NoAnswer)
        val seat = owner
        val log = gym
        isFinishing = true
        refreshWorkout()
        try {
            if (log == null || liveUnclaimed) return finishOnDevice(live)
            deliver()
            val detail = delivery.withLock {
                if (!workoutAuthorized || seat != owner || gym !== log) return FinishOutcome.Failed(WriteFailure.Refused("the account changed while finishing"))
                val stranded = queue.owed(live.id).size
                if (stranded > 0) return FinishOutcome.Stranded(stranded)
                val closed = try {
                    log.finishSession(live.id, now())
                } catch (interrupted: CancellationException) {
                    throw interrupted
                } catch (refusing: Exception) {
                    reportFailure("gym.finish", refusing)
                    if (!workoutAuthorized || seat != owner || gym !== log) return FinishOutcome.Failed(WriteFailure.Refused("the account changed while finishing"))
                    if (RefusalFacts(refusing).status != 404) return FinishOutcome.Failed(WriteFailure(refusing))
                    null
                }
                if (!workoutAuthorized || seat != owner || gym !== log) return FinishOutcome.Failed(WriteFailure.Refused("the account changed while finishing"))
                val settled = closed?.let { SessionDetail(it, queue.sets(live.id)) }
                if (settled != null) retainClosed(settled)
                if (closed == null) queue.forget(live.id) else queue.close(live.id)
                queue.flush()
                settled
            }
            lastTimes.clear()
            exerciseId = null
            lastTime = null
            drawFromQueue()
            if (localLog.finished.isNotEmpty()) runClaim()
            if (!workoutAuthorized || seat != owner || gym !== log) return FinishOutcome.Failed(WriteFailure.Refused("the account changed while finishing"))
            if (detail == null) {
                loadLog()
                if (!workoutAuthorized || seat != owner || gym !== log) return FinishOutcome.Failed(WriteFailure.Refused("the account changed while finishing"))
                return FinishOutcome.Failed(WriteFailure.Refused("that workout is no longer on the log"))
            }
            scope.launch {
                if (workoutAuthorized && seat == owner && gym === log) loadLog()
            }
            invalidateProgress()
            telemetry.event("gym_session_finished", mapOf("storage" to "server"))
            return FinishOutcome.Closed(detail)
        } finally {
            isFinishing = false
            refreshWorkout()
        }
    }

    private suspend fun finishOnDevice(live: Session): FinishOutcome {
        val seat = owner
        val log = gym
        val closed = shelve(live, finishedAtMs = now())
        val detail = localLog.detail(closed.id) ?: return FinishOutcome.Failed(WriteFailure.NoAnswer)
        retainClosed(detail)
        drawFromQueue()
        shelved = localLog.summaries()
        redrawShelfRoutines()
        if (log != null) {
            runClaim()
            if (!workoutAuthorized || seat != owner || gym !== log) return FinishOutcome.Failed(WriteFailure.Refused("the account changed while finishing"))
            deliver()
            if (!workoutAuthorized || seat != owner || gym !== log) return FinishOutcome.Failed(WriteFailure.Refused("the account changed while finishing"))
            loadLog()
            if (!workoutAuthorized || seat != owner || gym !== log) return FinishOutcome.Failed(WriteFailure.Refused("the account changed while finishing"))
        }
        retainedSessionFailure(detail)?.let { return FinishOutcome.Failed(it) }
        invalidateProgress()
        telemetry.event("gym_session_finished", mapOf("storage" to "device"))
        return FinishOutcome.Closed(retainedSession(detail))
    }

    fun canonicalSetId(id: String): String = setIds[id] ?: id

    fun retainedSession(detail: SessionDetail): SessionDetail = closedDetails[detail.session.id]
        ?: closedDetails.values.firstOrNull { it.session.id == detail.session.id } ?: detail

    fun retainedSessionFailure(detail: SessionDetail): WriteFailure? =
        closedFailures[retainedSession(detail).session.id]

    private fun retainClosed(detail: SessionDetail) {
        closedDetails = closedDetails.mapValues { (_, old) ->
            if (old.session.id == detail.session.id) detail else old
        } + (detail.session.id to detail)
    }

    // Closed at the instant given: the finish's own, or the auto-close's last activity. The queue
    // lets go of the session and its sets in the same breath.
    private fun shelve(live: Session, finishedAtMs: Long): Session {
        val closed = live.copy(finishedAtMs = finishedAtMs)
        localLog.hold(LocalLog.FinishedSession(closed, queue.sets(live.id)))
        queue.forget(live.id)
        queue.flush()
        lastTimes.clear()
        exerciseId = null
        lastTime = null
        return closed
    }

    // The log refuses to delete a session somebody may still be logging into.
    suspend fun discard(sessionId: String): Boolean {
        if (!workoutAuthorized || consentRecoveryBlocked) return false
        if (localLog.detail(sessionId) != null) {
            localLog.forget(sessionId)
            invalidateProgress()
            queue.forget(sessionId)
            queue.flush()
            drawFromQueue()
            shelved = localLog.summaries()
            // A discarded session is one a routine was NOT trained by.
            redrawShelfRoutines()
            return true
        }
        val log = gym ?: return false
        val seat = owner
        tried("gym.discard") { log.discardSession(sessionId) } ?: return false
        if (!workoutAuthorized || seat != owner || gym !== log) return false
        invalidateProgress()
        // The settled delete leaves the READ and not only the drawn rows, and the re-read below is
        // not enough on its own: `loadLog` keeps every row DEEPER than the page it answers with, so
        // a session older than the log's head would be folded straight back in and drawn again the
        // moment the window that was hiding it closed.
        logged = logged.filterNot { it.id == sessionId }
        queue.forget(sessionId)
        queue.flush()
        drawFromQueue()
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

    // Kept on the shelf; the claim sends this same document later.
    private suspend fun keepOnDevice(write: RoutineWrite): Routine {
        val made = Routine(write)
        localLog.hold(made)
        routines = if (gym == null) localLog.routines else program.filterNot { it.id == made.id } + localLog.routine(made.id)!!
        if (gym != null) {
            claimOwed = true
            deliver()
        }
        return made
    }

    // Read the full routine, then guard its revision before replacing the targeted plan entry.
    suspend fun save(sets: List<SetTarget>, toRoutine: String, atPosition: Int,
                     forExercise: String): WriteFailure? {
        // A routine still on the shelf is the device's to move.
        localLog.routine(toRoutine)?.let { mine ->
            val moved = mine.retargeting(atPosition, forExercise, sets)
                ?: return WriteFailure.Refused("${mine.name} has changed since this session started")
            localLog.hold(moved)
            routines = if (gym == null) localLog.routines
                else program.map { if (it.id == toRoutine) localLog.routine(toRoutine)!! else it }
            return null
        }
        val log = gym ?: return WriteFailure.Refused("that routine is not on this device")
        return try {
            // Absent and another account's fold into null, so there is no sentence to repeat.
            val routine = log.routine(toRoutine)
                ?: return WriteFailure.Refused("that routine is no longer on the log")
            val moved = routine.retargeting(atPosition, forExercise, sets)
                ?: return WriteFailure.Refused("${routine.name} has changed since this session started")
            val saved = log.replaceRoutine(toRoutine, RoutineWrite(moved, routine.revision))
            routines = program.map { if (it.id == saved.id) saved else it }
            null
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (error: Exception) {
            reportFailure("gym.save", error)
            WriteFailure(error)
        }
    }

    // One day of the program, written WHOLE. A routine with an id is an edit and goes out as a PUT,
    // which moves the revision and supersedes every proposal pending on it; without one it is a
    // create and the id is minted here. Savable while incomplete but not while EMPTY.
    suspend fun saveRoutine(draft: RoutineDraft): GymResult<Routine> {
        if (Program.nameProblem(draft.name) == Program.nameTooLong) return GymResult.Failed(WriteFailure.Refused(Program.nameTooLong))
        val name = Program.named(draft.name)
            ?: return GymResult.Failed(WriteFailure.Refused("a routine needs a name"))
        if (draft.entries.isEmpty()) {
            return GymResult.Failed(WriteFailure.Refused("a routine needs at least one movement"))
        }
        val standing = draft.id
        val creationId = draft.creationId ?: mintRoutine()
        if (standing == null) {
            localLog.routine(creationId)?.let { existing ->
                val expected = RoutineWrite(creationId, name, draft.position, draft.write)
                if (RoutineWrite(existing) != expected) return GymResult.Failed(WriteFailure.Refused(
                    "this save already holds different details — reopen the saved routine to edit it"))
                return GymResult.Ok(existing)
            }
        }
        // A routine still on the shelf is the device's to write; the claim sends whatever it finds.
        if (standing != null && localLog.routine(standing) != null) {
            val held = Routine(RoutineWrite(standing, name, draft.position, draft.write))
            localLog.hold(held)
            routines = if (gym == null) localLog.routines
                else program.map { if (it.id == standing) localLog.routine(standing)!! else it }
            telemetry.event("gym_routine_saved", mapOf("action" to "update", "storage" to "device"))
            return GymResult.Ok(held)
        }
        val seat = owner
        val log = gym
        if (log == null) {
            // Signed out, a routine this shelf does not hold is the account's.
            if (standing != null) {
                return GymResult.Failed(
                    WriteFailure.Refused("that routine is on your account — sign in to change it"))
            }
            val held = keepOnDevice(RoutineWrite(creationId, name, draft.position, draft.write))
            telemetry.event("gym_routine_saved", mapOf("action" to "create", "storage" to "device"))
            return GymResult.Ok(held)
        }
        if (standing != null && draft.original?.expectedRevision == null) {
            return GymResult.Failed(WriteFailure.Refused("reopen this routine before saving — its original revision is missing"))
        }
        val write = RoutineWrite(standing ?: creationId, name, draft.position, draft.write,
            expectedRevision = draft.original?.expectedRevision)
        return try {
            val saved = if (standing == null) log.createRoutine(write)
                else log.replaceRoutine(standing, write)
            if (seat != owner || gym !== log) return GymResult.Failed(WriteFailure.Refused("the account changed while saving"))
            routines = if (standing == null) program.filterNot { it.id == saved.id } + saved
                else program.map { if (it.id == saved.id) saved else it }
            if (standing == null && RoutineWrite(saved) != write) return GymResult.Failed(WriteFailure.Refused(
                "this save already holds different details — reopen the saved routine to edit it"))
            telemetry.event("gym_routine_saved", mapOf("action" to if (standing == null) "create" else "update", "storage" to "server"))
            GymResult.Ok(saved)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.saveRoutine", refusing)
            if (seat != owner || gym !== log) return GymResult.Failed(WriteFailure.Refused("the account changed while saving"))
            // A NEW day typed with no signal is kept on the shelf. An EDIT of the account's day
            // cannot be: the shelf's create would land it as a second routine.
            if (standing != null || Verdict.refusing(RefusalFacts(refusing)) !is Verdict.Retry) {
                return GymResult.Failed(WriteFailure(refusing))
            }
            val held = keepOnDevice(write)
            if (seat != owner || gym !== log) return GymResult.Failed(WriteFailure.Refused("the account changed while saving"))
            telemetry.event("gym_routine_saved", mapOf("action" to "create", "storage" to "device"))
            GymResult.Ok(held)
        }
    }

    // The sessions that named it keep every set and their frozen plan: a snapshot is a copy, not a
    // reference. A routine still on the shelf leaves through `orphanRoutine`, which also drops the
    // dead id off the local sessions that would replay a start the log must refuse. A 404 is success.
    suspend fun dropRoutine(id: String): WriteFailure? {
        if (localLog.routine(id) != null) {
            localLog.orphanRoutine(id)
            routines = program.filterNot { it.id == id }
            return null
        }
        val log = gym
            ?: return WriteFailure.Refused("that routine is on your account — sign in to change it")
        return try {
            log.deleteRoutine(id)
            routines = program.filterNot { it.id == id }
            null
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.dropRoutine", refusing)
            if (RefusalFacts(refusing).status == 404) {
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
        val seat = owner
        val log = gym ?: return ProposalRead.Failed(WriteFailure.Refused(proposalsWantAnAccount))
        return try {
            val read = log.proposal(id)
            if (seat != owner || gym !== log) return ProposalRead.Failed(WriteFailure.Refused(accountChanged))
            (read ?: settledProposals[id])?.let { ProposalRead.Found(it) } ?: ProposalRead.Gone
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.proposal", refusing)
            if (seat != owner || gym !== log) return ProposalRead.Failed(WriteFailure.Refused(accountChanged))
            if (RefusalFacts(refusing).status == 404) {
                return settledProposals[id]?.let { ProposalRead.Found(it) } ?: ProposalRead.Gone
            }
            ProposalRead.Failed(WriteFailure(refusing))
        }
    }

    // Atomic against the base the diff was written on. Nothing here merges, retries or applies part
    // of a diff.
    suspend fun applyProposal(id: String): ProposalOutcome {
        val seat = owner
        val log = gym ?: return ProposalOutcome.Failed(WriteFailure.Refused(proposalsWantAnAccount))
        return proposalWrite.withLock {
            if (seat != owner || gym !== log) return@withLock ProposalOutcome.Failed(WriteFailure.Refused(accountChanged))
            try {
                val decision = log.applyProposal(id)
                if (seat != owner || gym !== log) return@withLock ProposalOutcome.Failed(WriteFailure.Refused(accountChanged))
                decided(decision)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure("gym.applyProposal", refusing)
                if (seat != owner || gym !== log) return@withLock ProposalOutcome.Failed(WriteFailure.Refused(accountChanged))
                val outcome = refused(refusing)
                if (seat != owner || gym !== log) return@withLock ProposalOutcome.Failed(WriteFailure.Refused(accountChanged))
                outcome
            }
        }.also { reportProposal("apply", it) }
    }

    suspend fun dismissProposal(id: String): ProposalOutcome {
        val seat = owner
        val log = gym ?: return ProposalOutcome.Failed(WriteFailure.Refused(proposalsWantAnAccount))
        return proposalWrite.withLock {
            if (seat != owner || gym !== log) return@withLock ProposalOutcome.Failed(WriteFailure.Refused(accountChanged))
            try {
                val decision = log.dismissProposal(id)
                if (seat != owner || gym !== log) return@withLock ProposalOutcome.Failed(WriteFailure.Refused(accountChanged))
                decided(decision)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure("gym.dismissProposal", refusing)
                if (seat != owner || gym !== log) return@withLock ProposalOutcome.Failed(WriteFailure.Refused(accountChanged))
                val outcome = refused(refusing)
                if (seat != owner || gym !== log) return@withLock ProposalOutcome.Failed(WriteFailure.Refused(accountChanged))
                outcome
            }
        }.also { reportProposal("dismiss", it) }
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

    // Drawn from the log's own answer and never from the send. The card is dropped BY ID rather than
    // blanked, because a newer proposal may already be standing in that slot.
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

    // None of the three is retryable, and all three mean this room's picture is stale, so the
    // routines are re-read before the sentence is said. Only a log that went quiet leaves the list
    // alone, because nothing was decided.
    private suspend fun refused(error: Throwable): ProposalOutcome =
        when (val verdict = ProposalVerdict.refusing(RefusalFacts(error))) {
            is ProposalVerdict.Superseded -> {
                reread()
                ProposalOutcome.Moved(verdict.said)
            }
            is ProposalVerdict.Gone -> {
                reread()
                ProposalOutcome.Gone(verdict.said)
            }
            is ProposalVerdict.Settled -> {
                reread()
                ProposalOutcome.Settled(verdict.said)
            }
            ProposalVerdict.Retry -> ProposalOutcome.Failed(WriteFailure(error))
        }

    // A read that misses leaves what is held.
    private suspend fun reread() {
        val seat = owner
        val log = gym ?: return
        val before = program.associateBy { it.id }
        val written = tried("gym.reread") { log.routines() } ?: return
        if (seat != owner || gym !== log) return
        val changed = program.filter { before[it.id] != it }.associateBy { it.id }
        val deleted = before.keys - program.map { it.id }.toSet()
        val fetched = Program.overlay(written, localLog.routines).filterNot { it.id in deleted }
        routines = fetched.map { changed[it.id] ?: it } + changed.values.filter { row -> fetched.none { it.id == row.id } }
    }

    // The reply is drawn as it arrived: the prose, the server's own count of the rows it served, and
    // any proposal ids. NOTHING HERE COMPOSES A NUMBER. A proposal minted in a conversation is a card
    // on home too, so the program is re-read the moment one appears.
    fun pendingQuestions(): List<AskQuestion> = try {
        owner?.let { localCoach?.pending(it) }.orEmpty()
    } catch (failure: Exception) {
        reportFailure("gym.restoreConversation", failure)
        emptyList()
    }

    private val coachDrafts = mutableMapOf<Pair<String, String>, CoachDraft>()
    var coachDraftVersion by mutableStateOf(0)
        private set

    fun coachDraft(key: String): CoachDraft = owner?.let { seat ->
        localCoach?.draft(seat, key) ?: coachDrafts[seat to key]
    } ?: CoachDraft()

    fun saveCoachDraft(key: String, draft: CoachDraft) {
        val seat = owner ?: return
        if (coachDraft(key) == draft && (coachDrafts[seat to key] ?: CoachDraft()) == draft) return
        localCoach?.saveDraft(seat, key, draft)
        coachDrafts[seat to key] = draft
        coachDraftVersion++
    }

    fun abandonCoach(threadId: String) {
        val seat = owner ?: return
        localCoach?.clear(seat, threadId)
        coachDrafts.remove(seat to threadId)
        coachDraftVersion++
    }

    suspend fun importCoachPhoto(key: String, resolver: android.content.ContentResolver, uri: android.net.Uri) {
        val seat = owner ?: error(askWantsAnAccount)
        val disk = localCoach ?: error("Photo storage is unavailable.")
        val (photo, bytes) = withContext(Dispatchers.IO) { CoachPhotos.read(resolver, uri) }
        check(seat == owner) { accountChanged }
        withContext(Dispatchers.IO) { disk.savePhoto(seat, photo.id, bytes) }
        if (seat == owner) saveCoachDraft(key, coachDraft(key).copy(photo = photo))
    }

    suspend fun coachPhoto(threadId: String, photo: CoachAttachment): ByteArray {
        val seat = owner ?: error(askWantsAnAccount)
        val log = gym ?: error(askWantsAnAccount)
        val cached = localCoach?.photoFile(seat, photo.id)
        val bytes = if (cached?.isFile == true) withContext(Dispatchers.IO) { cached.readBytes() }
            else log.photo(threadId, photo.id)
        check(seat == owner && log === gym) { accountChanged }
        return bytes
    }

    suspend fun stopAsk(threadId: String, requestId: String): AskGeneration {
        val seat = owner ?: error(askWantsAnAccount)
        val log = gym ?: error(askWantsAnAccount)
        val generation = log.stop(threadId, requestId)
        check(seat == owner && log === gym) { accountChanged }
        withContext(Dispatchers.IO) { localCoach?.record(seat, generation) }
        check(seat == owner && log === gym) { accountChanged }
        val current = localCoach?.snapshot(seat, requestId) ?: generation
        if (current.status in listOf("completed", "stopped")) withContext(Dispatchers.IO) { localCoach?.clear(seat, threadId, requestId) }
        check(seat == owner && log === gym) { accountChanged }
        return current
    }

    fun pendingExchange(question: AskQuestion): AskExchange {
        val snapshot = owner?.let { localCoach?.snapshot(it, question.requestId.orEmpty()) }
        return snapshot?.exchange() ?: AskExchange(question.question, requestId = question.requestId.orEmpty(),
            trouble = Ask.interrupted, again = true,
            attachments = question.attachmentIds.mapNotNull { id ->
                owner?.let { localCoach?.draft(it, question.thread)?.photo?.takeIf { it.id == id } }
            })
    }

    suspend fun ask(threadId: String, question: String, requestId: String = Ids.thread(),
        photo: CoachAttachment? = null, stream: Boolean = false,
        onSnapshot: (AskGeneration) -> Unit = {}, onUpload: (Float?) -> Unit = {},
    ): AskOutcome {
        val started = elapsedNanos()
        telemetry.event("gym_ask_started")
        fun complete(outcome: AskOutcome, failure: Exception? = null): AskOutcome {
            val properties = mutableMapOf("duration_ms" to ((elapsedNanos() - started) / 1_000_000).toString())
            properties["outcome"] = when (outcome) {
                is AskOutcome.Answered -> "answered"
                is AskOutcome.Refused -> "refused"
                is AskOutcome.Capped -> "capped"
                is AskOutcome.Failed -> "failed"
                is AskOutcome.Fresh -> "fresh"
                AskOutcome.Absent -> "absent"
            }
            if (outcome is AskOutcome.Capped) properties["cap"] = outcome.cap.name.lowercase()
            if (failure != null) properties["failure_kind"] = when (failure) {
                WindmillApiException.Offline -> "offline"
                is WindmillApiException.Timeout -> "timeout"
                WindmillApiException.Malformed -> "malformed"
                is WindmillApiException.Transport -> "transport"
                is WindmillApiException.Refused -> "http"
                else -> "unexpected"
            }
            if (failure is WindmillApiException.Refused) properties["status"] = failure.status.toString()
            telemetry.event("gym_ask_outcome", properties)
            return outcome
        }
        val seat = owner
        val log = gym ?: return complete(AskOutcome.Refused(askWantsAnAccount))
        var snapshot = seat?.let { localCoach?.snapshot(it, requestId) }
        var photoUpload = false
        return try {
            val saved = seat?.let { localCoach?.pending(it)?.firstOrNull { it.requestId == requestId } }
            val request = saved ?: AskQuestion(thread = threadId, question = question, requestId = requestId,
                attachmentIds = listOfNotNull(photo?.id))
            require(request.thread == threadId && request.question == question) { "A retry must keep the original message." }
            if (seat != null) withContext(Dispatchers.IO) { localCoach?.keep(seat, request) }
            if (seat != owner || gym !== log) return complete(AskOutcome.Refused(accountChanged))
            if (photo != null && seat != null && snapshot == null) {
                val file = localCoach?.photoFile(seat, photo.id)
                if (file?.isFile == true) {
                    photoUpload = true
                    onUpload(0f)
                    val bytes = withContext(Dispatchers.IO) { file.readBytes() }
                    log.uploadPhoto(threadId, photo, bytes) { if (seat == owner && gym === log) onUpload(it) }
                    if (seat != owner || gym !== log) return complete(AskOutcome.Refused(accountChanged))
                    photoUpload = false
                    onUpload(null)
                }
            }
            onUpload(null)
            val accept: suspend (AskGeneration) -> Unit = { next ->
                if (seat == owner && gym === log && snapshot != next && (snapshot == null || next.revision >= snapshot!!.revision)) {
                    if (seat != null) withContext(Dispatchers.IO) { localCoach?.record(seat, next) }
                    if (seat == owner && gym === log) {
                        snapshot = next
                        onSnapshot(next)
                    }
                }
            }
            var answered = if (stream) log.stream(request, accept) else log.ask(request)
            answered.generation?.let { accept(it) }
            var pause = 1_000L
            while (answered.generation?.status == "running") {
                if (seat != owner || gym !== log) return complete(AskOutcome.Refused(accountChanged))
                delay(pause)
                if (seat != owner || gym !== log) return complete(AskOutcome.Refused(accountChanged))
                pause = (pause * 2).coerceAtMost(10_000)
                answered = if (stream) log.stream(request, accept) else log.ask(request)
                answered.generation?.let { accept(it) }
            }
            if (seat != owner || gym !== log) return complete(AskOutcome.Refused(accountChanged))
            if (answered.proposals.isNotEmpty() || answered.results.isNotEmpty()) reread()
            if (seat != owner || gym !== log) return complete(AskOutcome.Refused(accountChanged))
            if (answered.generation?.status == "failed") return complete(AskOutcome.Failed(Ask.interrupted, snapshot))
            if (seat != null) withContext(Dispatchers.IO) { localCoach?.clear(seat, threadId, requestId) }
            if (seat != owner || gym !== log) return complete(AskOutcome.Refused(accountChanged))
            complete(AskOutcome.Answered(answered))
        } catch (interrupted: CancellationException) {
            telemetry.event("gym_ask_outcome", mapOf("outcome" to "cancelled",
                "duration_ms" to ((elapsedNanos() - started) / 1_000_000).toString()))
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.ask", refusing)
            if (seat != owner || gym !== log) return complete(AskOutcome.Refused(accountChanged), refusing)
            val authoritative = try { log.thread(threadId)?.generation?.takeIf { it.requestId == requestId } }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { null }
            if (seat != owner || gym !== log) return complete(AskOutcome.Refused(accountChanged), refusing)
            if (authoritative != null && (snapshot == null || authoritative.revision >= snapshot!!.revision)) {
                snapshot = authoritative
                if (seat != null) withContext(Dispatchers.IO) { localCoach?.record(seat, authoritative) }
                if (seat != owner || gym !== log) return complete(AskOutcome.Refused(accountChanged), refusing)
            }
            if (snapshot?.status in listOf("completed", "stopped")) {
                if (seat != null) withContext(Dispatchers.IO) { localCoach?.clear(seat, threadId, requestId) }
                if (seat != owner || gym !== log) return complete(AskOutcome.Refused(accountChanged), refusing)
                return complete(AskOutcome.Answered(requireNotNull(snapshot).response()))
            }
            if (photoUpload) return complete(AskOutcome.Failed("Photo didn’t upload. Retry to send this photo.", snapshot), refusing)
            if (snapshot == null && photo != null && refusing is WindmillApiException.Refused && refusing.refusal.code == "ask-attachment-invalid") {
                return complete(AskOutcome.Failed("Photo wasn’t available. Retry to upload it again."), refusing)
            }
            val outcome = when (val verdict = AskVerdict.refusing(RefusalFacts(refusing))) {
                is AskVerdict.Said -> AskOutcome.Refused(verdict.said, snapshot)
                is AskVerdict.Capped -> AskOutcome.Capped(verdict.said, verdict.cap, snapshot)
                is AskVerdict.Again -> AskOutcome.Failed(verdict.said, snapshot)
                is AskVerdict.Fresh -> AskOutcome.Fresh(verdict.said)
                AskVerdict.Absent -> AskOutcome.Absent
            }
            complete(outcome, refusing)
        }
    }

    // The list is the ROOM's, exactly as the notes are: a screen holding a copy of its own would draw
    // a conversation back the moment its window settled. It is re-read on the way into the screen and
    // written into `conversations` here, because the outcome is DERIVED by the server from the
    // proposals and a list nobody re-read would say `waiting` days after somebody decided. The single
    // thread below is still held nowhere at all.
    var nextThreadCursor: String? by mutableStateOf(null)
        private set

    suspend fun readThreads(cursor: String? = null): GymResult<List<AskThread>> {
        val seat = owner
        val log = gym ?: return GymResult.Failed(WriteFailure.Refused(askWantsAnAccount))
        return conversationWrite.withLock {
            if (seat != owner || gym !== log) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
            try {
                val page = log.threadsPage(cursor)
                if (seat != owner || gym !== log) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                conversations = if (cursor == null) page.threads else (conversations + page.threads).distinctBy { it.id }
                nextThreadCursor = page.nextCursor
                GymResult.Ok(conversations)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure("gym.readThreads", refusing)
                if (seat != owner || gym !== log) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                GymResult.Failed(WriteFailure(refusing))
            }
        }
    }

    // A log that refused with a sentence is not a log holding no such thread, so the absence answers
    // in words rather than as a null.
    suspend fun thread(id: String, before: String? = null): GymResult<AskThread> {
        val seat = owner
        val log = gym ?: return GymResult.Failed(WriteFailure.Refused(askWantsAnAccount))
        return try {
            val read = log.threadPage(id, before)
            if (seat != owner || gym !== log) return GymResult.Failed(WriteFailure.Refused(accountChanged))
            if (read == null) return GymResult.Failed(WriteFailure.Refused(noSuchThread))
            if (seat != null && read.generation?.status in listOf("completed", "stopped")) localCoach?.clear(seat, id, requireNotNull(read.generation).requestId)
            GymResult.Ok(read)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.thread", refusing)
            if (seat != owner || gym !== log) return GymResult.Failed(WriteFailure.Refused(accountChanged))
            GymResult.Failed(WriteFailure(refusing))
        }
    }

    // Deleting a conversation preserves every applied routine change. A 404 answers as success.
    //
    // The settled delete leaves the READ and not only the drawn rows: a list still holding it once
    // the window closed would put the row back on screen, and the room would go on calling an emptied
    // account full.
    suspend fun deleteThread(id: String): GymResult<Unit> {
        val seat = owner
        val log = gym ?: return GymResult.Failed(WriteFailure.Refused(askWantsAnAccount))
        return conversationWrite.withLock {
            if (seat != owner || gym !== log) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
            try {
                log.deleteThread(id)
                if (seat != owner || gym !== log) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                conversations = conversations.filterNot { it.id == id }
                if (seat != null) localCoach?.clear(seat, id)
                GymResult.Ok(Unit)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure("gym.deleteThread", refusing)
                if (seat != owner || gym !== log) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                if (RefusalFacts(refusing).status != 404) return@withLock GymResult.Failed(WriteFailure(refusing))
                if (seat != owner || gym !== log) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                conversations = conversations.filterNot { it.id == id }
                GymResult.Ok(Unit)
            }
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
        val log = gym
        if (log == null) {
            connectedLog = ConnectedLogState.None
            return connectedLog
        }
        val read = try {
            coroutineScope {
                val grants = async { log.grants() }
                val keys = async { log.mcpKeys() }
                ConnectedLog.state(grants.await(), keys.await())
            }
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.refreshConnectedLog", refusing)
            ConnectedLogState.Refused
        }
        if (seat != owner || gym !== log || request != connectedRead) return ConnectedLogState.Refused
        connectedLog = read
        return read
    }

    // Notes are the account's and this phone keeps none between runs: every screen reads on the way
    // in, and a refusal arrives in the log's own words — the ten cap and the two bounds are its to
    // state. Every one of these four answers the log AND writes what it answered into `notebook`, so
    // the drawn list is one list nobody holds a copy of.
    suspend fun readNotes(): GymResult<List<Note>> {
        val seat = owner
        val log = gym ?: return GymResult.Failed(WriteFailure.Refused(notesWantAnAccount))
        return notebookWrite.withLock {
            if (seat != owner || gym !== log) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
            try {
                val served = log.notes()
                if (seat != owner || gym !== log) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                notebook = served
                GymResult.Ok(served)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure("gym.readNotes", refusing)
                if (seat != owner || gym !== log) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                GymResult.Failed(WriteFailure(refusing))
            }
        }
    }

    suspend fun saveNote(id: String, write: NoteWrite): GymResult<Note> {
        val seat = owner
        val log = gym ?: return GymResult.Failed(WriteFailure.Refused(notesWantAnAccount))
        return notebookWrite.withLock {
            if (seat != owner || gym !== log) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
            try {
                val written = log.writeNote(id, write)
                if (seat != owner || gym !== log) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                notebook = if (notebook.any { it.id == id }) notebook.map { if (it.id == id) written else it }
                    else notebook + written
                GymResult.Ok(written)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure("gym.saveNote", refusing)
                if (seat != owner || gym !== log) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                GymResult.Failed(WriteFailure(refusing))
            }
        }
    }

    // A 404 answers as success: the note is gone either way, so the row goes either way.
    suspend fun deleteNote(id: String): WriteFailure? {
        val seat = owner
        val log = gym ?: return WriteFailure.Refused(notesWantAnAccount)
        return notebookWrite.withLock {
            if (seat != owner || gym !== log) return@withLock WriteFailure.Refused(accountChanged)
            try {
                log.deleteNote(id)
                if (seat != owner || gym !== log) return@withLock WriteFailure.Refused(accountChanged)
                notebook = notebook.filterNot { it.id == id }
                null
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure("gym.deleteNote", refusing)
                if (seat != owner || gym !== log) return@withLock WriteFailure.Refused(accountChanged)
                if (RefusalFacts(refusing).status != 404) return WriteFailure(refusing)
                if (seat != owner || gym !== log) return@withLock WriteFailure.Refused(accountChanged)
                notebook = notebook.filterNot { it.id == id }
                null
            }
        }
    }

    // The order is the lifter's instruction and it lands on the log before it is believed here: a
    // refusal leaves the notebook exactly as the log last said it. What arrives is the order of the
    // rows DRAWN, and a note inside its undo window is not one of them — the log refuses an order
    // that does not name every note, so the withheld one keeps the place it stands in and the drawn
    // ones fill the rest.
    suspend fun reorderNotes(drawn: List<String>): GymResult<List<Note>> {
        val seat = owner
        val log = gym ?: return GymResult.Failed(WriteFailure.Refused(notesWantAnAccount))
        return notebookWrite.withLock {
            if (seat != owner || gym !== log) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
            val visible = notes.map { it.id }
            if (drawn.size != visible.size || drawn.toSet().size != drawn.size || drawn.toSet() != visible.toSet()) {
                return@withLock GymResult.Failed(WriteFailure.Refused("The notes changed. Read them again before reordering."))
            }
            val queue = ArrayDeque(drawn)
            val order = notebook.map { if (it.id in withheldIds || queue.isEmpty()) it.id else queue.removeFirst() }
            try {
                val written = log.reorderNotes(order)
                if (seat != owner || gym !== log) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                notebook = written
                GymResult.Ok(written)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure("gym.reorderNotes", refusing)
                if (seat != owner || gym !== log) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
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
        if (localLog.exercises.any { it.id == write.id }) return createOnDevice(write)
        val seat = owner
        val log = gym ?: return createOnDevice(write)
        return try {
            val made = log.createExercise(write)
            if (seat != owner || gym !== log) return GymResult.Failed(WriteFailure.Refused("the account changed while creating"))
            catalog = catalog.filterNot { it.id == made.id } + made
            deviceCopy.hold(owner, catalog)
            if (made.id != write.id || made.name != write.name || made.equipment != write.equipment || made.pattern != write.pattern) {
                return GymResult.Failed(WriteFailure.Refused("already saved as ${made.name} (${made.equipment}) — choose it from the movement list"))
            }
            GymResult.Ok(made)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.create", refusing)
            if (seat != owner || gym !== log) return GymResult.Failed(WriteFailure.Refused("the account changed while creating"))
            if (Verdict.refusing(RefusalFacts(refusing)) !is Verdict.Retry) {
                return GymResult.Failed(WriteFailure(refusing))
            }
            val result = createOnDevice(write)
            if (seat != owner || gym !== log) return GymResult.Failed(WriteFailure.Refused("the account changed while creating"))
            result
        }
    }

    // The same identity survives an accepted write whose reply was lost; claim replays it once.
    private suspend fun createOnDevice(write: ExerciseWrite): GymResult<Exercise> {
        localLog.exercises.firstOrNull { it.id == write.id }?.let { existing ->
            if (existing.name != write.name || existing.equipment != write.equipment || existing.pattern != write.pattern) {
                return GymResult.Failed(WriteFailure.Refused("that movement identity already holds different details"))
            }
            return GymResult.Ok(existing)
        }
        val made = Exercise(id = write.id, name = write.name, pattern = write.pattern,
            equipment = write.equipment, custom = true)
        localLog.hold(made)
        catalog = catalog.filterNot { it.id == made.id } + made
        deviceCopy.hold(owner, catalog)
        if (gym != null) {
            claimOwed = true
            deliver()
        }
        return GymResult.Ok(made)
    }

    // Held on the device FIRST, so the screen obeys it on the next frame whether or not the log
    // is reachable. A whole-document PUT whose reply is the STORED document rather than the send.
    suspend fun savePreferences(document: GymPreferences): WriteFailure? {
        if (!workoutAuthorized) return WriteFailure.Refused(accountChanged)
        val seat = owner
        val log = gym
        try { localPreferences.save(document) }
        catch (error: Exception) {
            reportFailure("gym.savePreferences", error)
            return WriteFailure.Refused("The settings could not be saved safely. Restart the app to try again.")
        }
        preferences = localPreferences.document
        refreshWorkout()
        val revision = localPreferences.revision
        if (log == null) return null
        return preferencesWrite.withLock {
            if (!workoutAuthorized || seat != owner || gym !== log) return@withLock WriteFailure.Refused(accountChanged)
            if (revision != localPreferences.revision) return@withLock null
            try {
                val stored = log.savePreferences(document)
                if (!workoutAuthorized || seat != owner || gym !== log) return@withLock WriteFailure.Refused(accountChanged)
                if (revision == localPreferences.revision) {
                    localPreferences.landed(stored)
                    preferences = localPreferences.document
                    refreshWorkout()
                }
                null
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure("gym.savePreferences", refusing)
                if (!workoutAuthorized || seat != owner || gym !== log) return@withLock WriteFailure.Refused(accountChanged)
                if (revision != localPreferences.revision) return@withLock null
                deliver()
                WriteFailure(refusing)
            }
        }
    }

    fun clearRefusals() {
        refusals = emptyList()
    }

    // The newest day that has happened: a row dated past this phone's today is not a reading (B2).
    val latestWeighIn: WeighIn? get() = Bodyweight.latest(bodyweight, Bodyweight.today(now()))

    suspend fun loadBodyweight() {
        if (bodyweightLoading) return
        val seat = owner
        val log = gym
        if (log == null) {
            series = localBodyweight.entries
            bodyweightRead = true
            bodyweightFailure = null
            return
        }
        bodyweightLoading = true
        bodyweightFailure = null
        try {
            while (true) {
                val revision = bodyweightRevision
                val before = localBodyweight.entries
                val deletions = localBodyweight.deletions
                val read = log.bodyweight()
                if (seat != owner || gym !== log) return
                if (revision != bodyweightRevision || before != localBodyweight.entries || deletions != localBodyweight.deletions) continue
                localBodyweight.readBack(read)
                series = localBodyweight.entries
                bodyweightRead = true
                break
            }
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (failure: Exception) {
            reportFailure("gym.loadBodyweight", failure)
            if (seat == owner && gym === log) bodyweightFailure = WriteFailure(failure)
        } finally {
            if (seat == owner && gym === log) bodyweightLoading = false
        }
    }

    suspend fun weighIn(dateLocal: String, weightKg: Double): WriteFailure? {
        if (!weightKg.isFinite() || weightKg !in Bodyweight.minKg..Bodyweight.maxKg)
            return WriteFailure.Refused(Bodyweight.outOfRange)
        val date = runCatching { java.time.LocalDate.parse(dateLocal) }.getOrNull()
            ?: return WriteFailure.Refused("Choose a date.")
        Bodyweight.dated(date, Bodyweight.today(now()))?.let { return WriteFailure.Refused(it) }
        val seat = owner
        val log = gym
        dropWithheld(dateLocal)
        bodyweightRevision += 1
        val previous = localBodyweight.entries.firstOrNull { it.dateLocal == dateLocal }
        val previousOwed = localBodyweight.owed.any { it.dateLocal == dateLocal }
        val recorded = localBodyweight.record(WeighIn(dateLocal, weightKg,
            recordedAt = maxOf(now(), (previous?.recordedAt ?: -1) + 1)))
        series = localBodyweight.entries
        val revision = localBodyweight.revision(dateLocal)
        if (log == null) {
            bodyweightRead = true
            return null
        }
        return bodyweightWrite.withLock {
            if (seat != owner || gym !== log) return@withLock WriteFailure.Refused("The account changed while saving.")
            if (revision != localBodyweight.revision(dateLocal)) return@withLock null
            try {
                val stored = log.putBodyweight(recorded.dateLocal, WeighInWrite(recorded.weightKg, recorded.recordedAt))
                if (seat != owner || gym !== log) return@withLock WriteFailure.Refused("The account changed while saving.")
                if (stored.dateLocal != dateLocal) throw WindmillApiException.Malformed
                if (revision == localBodyweight.revision(dateLocal)) localBodyweight.landed(stored)
                series = localBodyweight.entries
                null
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure("gym.weighIn", refusing)
                if (seat != owner || gym !== log) return@withLock WriteFailure.Refused("The account changed while saving.")
                if (Verdict.refusing(RefusalFacts(refusing)) is Verdict.Retry) {
                    claimOwed = true
                    scheduleDeliver(afterMs = retryAfterMs)
                    return@withLock null
                }
                if (localBodyweight.entries.firstOrNull { it.dateLocal == recorded.dateLocal } == recorded) {
                    localBodyweight.letGo(recorded.dateLocal)
                    if (previous != null) {
                        if (previousOwed) localBodyweight.record(previous) else localBodyweight.landed(previous)
                    }
                }
                series = localBodyweight.entries
                WriteFailure(refusing)
            }
        }
    }

    suspend fun deleteWeighIn(dateLocal: String) {
        val seat = owner
        val log = gym
        bodyweightRevision += 1
        localBodyweight.delete(dateLocal)
        val revision = localBodyweight.revision(dateLocal)
        series = localBodyweight.entries
        if (log == null) return
        bodyweightWrite.withLock {
            if (seat != owner || gym !== log || revision != localBodyweight.revision(dateLocal) || dateLocal !in localBodyweight.deletions) return@withLock
            val landed = tried("gym.deleteWeighIn") { log.deleteBodyweight(dateLocal) }
            if (seat != owner || gym !== log) return@withLock
            if (landed != null) {
                if (revision == localBodyweight.revision(dateLocal)) localBodyweight.deletionLanded(dateLocal)
            }
            else {
                claimOwed = true
                scheduleDeliver(afterMs = retryAfterMs)
            }
        }
    }

    suspend fun loadProgress(force: Boolean = false): GymResult<StatsProgress> {
        progressWanted = true
        val seat = owner
        val log = gym
        return progressRead.withLock {
            if (seat != owner || gym !== log) return@withLock GymResult.Failed(WriteFailure.Refused("The account changed while reading."))
            if (!force) progressCache?.let { return@withLock GymResult.Ok(it) }
            progressLoading = true
            progressFailure = null
            try {
                if (log != null) claimIdle.await()
                if (seat != owner || gym !== log) return@withLock GymResult.Failed(WriteFailure.Refused("The account changed while reading."))
                var revision: Long
                var read: StatsProgress
                do {
                    revision = progressRevision
                    read = if (log == null) StatsProgress.of(localLog.details(), now()) else log.progress()
                    if (seat != owner || gym !== log) return@withLock GymResult.Failed(WriteFailure.Refused("The account changed while reading."))
                } while (revision != progressRevision)
                progressCache = read
                GymResult.Ok(read)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (failure: Exception) {
                reportFailure("gym.loadProgress", failure)
                val why = WriteFailure(failure)
                if (seat == owner && gym === log) progressFailure = why
                GymResult.Failed(why)
            } finally {
                if (seat == owner && gym === log) progressLoading = false
            }
        }
    }

    private fun invalidateProgress() {
        progressRevision += 1
        progressCache = null
        if (progressWanted) scope.launch { loadProgress() }
    }

    // Computed by the DOMAIN and read here, never re-derived. For a session only the shelf holds it
    // runs on the device: no record and no comparison, which need the log's whole history.
    suspend fun review(of: String): Review? {
        localLog.detail(of)?.let { return Review.of(it) }
        val log = gym ?: return null
        val seat = owner
        val result = tried("gym.review") { log.review(of) }
        return result.takeIf { seat == owner && gym === log }
    }

    // Off the shelf when only the shelf holds it, otherwise off the log.
    suspend fun sessionDetail(sessionId: String, seed: SessionDetail? = null): GymResult<SessionDetail> {
        val seat = owner
        localLog.detail(sessionId)?.let { return GymResult.Ok(it) }
        val log = gym
            ?: return GymResult.Failed(WriteFailure.Refused("that session is on your account — sign in to read it"))
        if (seed != null && seed.session.id == sessionId && !seed.session.isOpen && closedDetails[sessionId] == null) retainClosed(seed)
        val before = closedDetails[sessionId]
        return try {
            val detail = log.session(sessionId)
            if (seat != owner || gym !== log) return GymResult.Failed(WriteFailure.Refused("the account changed while reading"))
            if (detail == null) return GymResult.Failed(WriteFailure.Refused("that session is no longer on the log"))
            val current = closedDetails[sessionId]
            if (current != before && current != null) return GymResult.Ok(current)
            if (!detail.session.isOpen) retainClosed(detail)
            GymResult.Ok(detail)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.sessionDetail", refusing)
            GymResult.Failed(WriteFailure(refusing))
        }
    }

    // The branch is WHOSE ROW IT IS, not the network. A set of the live session is corrected in the
    // queue and the walk carries it: an append no send has carried yet is rewritten in place, and
    // anything else — a row the log holds, or MAY hold — is filed behind its append, so the fix
    // stands on this device at once, offline included. A session the shelf holds is corrected there;
    // a past session's row goes over the wire, waiting on `delivery` behind a send in flight. The log
    // moves and the routine does not: a fix carries three fields, none of them a target.
    suspend fun fixSet(sessionId: String, setId: String, fix: SetFix): FixOutcome {
        if (!workoutAuthorized) return FixOutcome.Failed(WriteFailure.Refused("the account changed while fixing"))
        val currentSet = setIds[setId] ?: setId
        val live = session?.takeIf { it.id == (closedDetails[sessionId]?.session?.id ?: sessionId) }
        if (live != null) {
            val corrected = sets.firstOrNull { it.id == currentSet }?.let(fix::corrected)
                ?: return FixOutcome.Gone("that set is no longer on this device")
            if (queue.isUnsent(currentSet)) queue.rewrite(corrected) else queue.fix(corrected)
            drawFromQueue()
            scope.launch { deliver() }
            return FixOutcome.Corrected(corrected)
        }
        val seat = owner
        val log = gym
        return delivery.withLock {
            if (!workoutAuthorized || seat != owner || gym !== log) return@withLock FixOutcome.Failed(
                WriteFailure.Refused("the account changed while fixing"))
            val currentSession = closedDetails[sessionId]?.session?.id ?: sessionId
            if (localLog.row(currentSession) != null) {
                val corrected = localLog.fixSet(currentSession, currentSet, fix)
                    ?: return@withLock FixOutcome.Gone("that set is no longer on this device")
                claimChanged(ClaimReplay.Change.SetChanged(currentSession, currentSet, corrected))
                shelved = localLog.summaries()
                return@withLock FixOutcome.Corrected(corrected)
            }
            if (log == null) return@withLock FixOutcome.Failed(
                WriteFailure.Refused("that set is on your account — sign in to fix it"))
            try {
                val stored = log.fixSet(currentSession, currentSet, fix)
                if (!workoutAuthorized || seat != owner || gym !== log) return@withLock FixOutcome.Failed(
                    WriteFailure.Refused("the account changed while fixing"))
                claimChanged(ClaimReplay.Change.SetChanged(currentSession, currentSet, stored))
                rereadRow(currentSession)
                if (!workoutAuthorized || seat != owner || gym !== log) return@withLock FixOutcome.Failed(
                    WriteFailure.Refused("the account changed while fixing"))
                FixOutcome.Corrected(stored)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure("gym.fixSet", refusing)
                when (val verdict = FixVerdict.refusing(RefusalFacts(refusing))) {
                    is FixVerdict.Gone -> FixOutcome.Gone(verdict.said)
                    is FixVerdict.Unwritable -> FixOutcome.Failed(WriteFailure.Refused(verdict.said))
                    FixVerdict.Retry -> FixOutcome.Failed(WriteFailure(refusing))
                }
            }
        }
    }

    // Once the window over it has closed. Same roads as the fix: a set of the live session leaves the
    // queue if no send has carried it, and is otherwise filed behind its append, so it is gone from
    // this device at once and the DELETE follows when the log answers. The wire's route has no
    // terminal refusal: already gone, never existed and another account's are all 204, so a retry
    // after a lost reply is safe. Nothing here recovers a deleted row.
    suspend fun deleteSet(sessionId: String, setId: String): WriteFailure? {
        if (!workoutAuthorized) return WriteFailure.Refused("the account changed while deleting")
        val currentSet = setIds[setId] ?: setId
        val live = session?.takeIf { it.id == (closedDetails[sessionId]?.session?.id ?: sessionId) }
        if (live != null) {
            if (queue.isUnsent(currentSet)) queue.drop(currentSet) else queue.delete(currentSet)
            drawFromQueue()
            deletedSets = deletedSets + currentSet
            claimChanged(ClaimReplay.Change.SetChanged(live.id, currentSet, null))
            scope.launch { deliver() }
            return null
        }
        val seat = owner
        val log = gym
        return delivery.withLock {
            if (!workoutAuthorized || seat != owner || gym !== log) return@withLock WriteFailure.Refused("the account changed while deleting")
            val currentSession = closedDetails[sessionId]?.session?.id ?: sessionId
            if (localLog.row(currentSession) != null) {
                if (localLog.deleteSet(currentSession, currentSet)) {
                    deletedSets = deletedSets + currentSet
                    shelved = localLog.summaries()
                    claimChanged(ClaimReplay.Change.SetChanged(currentSession, currentSet, null))
                }
                return@withLock null
            }
            if (log == null) return@withLock WriteFailure.Refused("that set is on your account — sign in to delete it")
            try {
                log.deleteSet(currentSession, currentSet)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure("gym.deleteSet", refusing)
                return@withLock WriteFailure(refusing)
            }
            if (!workoutAuthorized || seat != owner || gym !== log) return@withLock WriteFailure.Refused("the account changed while deleting")
            deletedSets = deletedSets + currentSet
            claimChanged(ClaimReplay.Change.SetChanged(currentSession, currentSet, null))
            rereadRow(currentSession)
            null
        }
    }

    // Its aggregates all moved with the set and the log is the only thing that computes them. It asks
    // for ONE row, anchored on the one above it, because a session reached with `Load older` is below
    // the head; the answer is taken only if it IS the row asked for, since the cursor is a position.
    private suspend fun rereadRow(sessionId: String) {
        val log = gym ?: return
        val seat = owner
        val at = logged.indexOfFirst { it.id == sessionId }
        if (at < 0) return
        // One row is still the log read, and the log read settles: not mid-claim.
        claimIdle.await()
        if (seat != owner || gym !== log) return
        val above = logged.getOrNull(at - 1)
        val fresh = tried("gym.rereadRow") { log.sessions(limit = 1, before = above?.startedAtMs, beforeId = above?.id) }
            ?.singleOrNull()?.takeIf { it.id == sessionId } ?: return
        if (seat != owner || gym !== log) return
        logged = logged.map { if (it.id == sessionId) fresh else it }
    }

    // The row leaves the screen and NOTHING is sent — withheld means not sent, so an Undo can never
    // arrive after the wire, for a server-only verb as much as for a set. Each delete carries its
    // own clock and settles itself; a second one never settles the first.
    //
    // The clock is KEPT, keyed by the subject it was opened for, because a second window over the
    // same row must take the first one's clock down with it: a clock left running would settle the
    // NEW window early, with its Undo still on the screen.
    fun withhold(deletion: Deletion) {
        val batch = if (deletion == Deletion.Unattributed) localDataBatch ?: return else null
        if (batch != null) {
            consentDecision += 1
            claimBusy = false
            try {
                val journal = checkNotNull(consent)
                val decision = journal.state
                check(decision !is ClaimConsent.Approved && decision !is ClaimConsent.Discarding) {
                    "This local-data decision is already being completed."
                }
                if (decision is ClaimConsent.AwaitingSignIn) journal.complete(decision.batch.id)
            } catch (failure: Exception) {
                reportFailure("gym.withhold", failure)
                consentFailure = failure.message ?: "The local-data decision could not be saved."
                return
            }
        }
        val open = WithheldDelete(deletion, untilMs = now() + undoWindowMs, claimBatch = batch)
        withheld = withheld.filterNot { it.subjectId == open.subjectId } + open
        armDelete(open)
    }

    private fun armDelete(open: WithheldDelete) {
        clocks.remove(open.subjectId)?.cancel()
        if (!open.takeable) return
        val seat = owner
        val log = gym
        clocks[open.subjectId] = scope.launch {
            delay((open.untilMs - now()).coerceAtLeast(0))
            clocks.remove(open.subjectId)
            val failed = settleWithheld(open.subjectId)
            if (seat == owner && gym === log) {
                open.deletion.stillThere?.let { tail -> failed?.let { deleteRefused = it.line(tail) } }
            }
        }
    }

    private fun changeHeldSet(sessionId: String, oldId: String, set: TrainingSet?) {
        if (set != null && set.id != oldId) {
            setIds = setIds.mapValues { (_, id) -> if (id == oldId) set.id else id } + (oldId to set.id)
            if (oldId in deletedSets) deletedSets = deletedSets - oldId + set.id
        }
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
    // Only while nothing has gone out: a delete already on the wire is nobody's to take back, and a
    // window that is not open at all is not an error — the day is simply free.
    private fun dropWithheld(subjectId: String) {
        val taking = withheld.firstOrNull { it.subjectId == subjectId && it.takeable } ?: return
        clocks.remove(subjectId)?.cancel()
        withheld = withheld - taking
    }

    // The NEWEST first, and only while nothing has gone out: there is no undelete, so a keep
    // reported over a delete already sent would be a lie. Answers with what came back, or null.
    fun keepWithheld(): WithheldDelete? {
        val taking = withheld.lastOrNull { it.takeable } ?: return null
        clocks.remove(taking.subjectId)?.cancel()
        withheld = withheld - taking
        return taking
    }

    // Leaving the ROOM — its disposal, or the app leaving the foreground. The window lives only
    // while the room is on screen in a live process, so everything still the lifter's is LET GO
    // rather than sent: the rows come back, nothing reaches the wire and nothing is said afterwards,
    // because nothing happened. Settling here instead would make `swipe · switch apps · come back`
    // destroy a row with its way back already gone, which is the one thing this whole mechanism
    // exists to prevent; deleting again costs one stroke, and nothing is written to disk to make the
    // decision outlive the process.
    //
    // One rule for every kind, a set's delete included: nothing in this list is held anywhere but
    // this process, so a delete left running past the room fires into a backgrounded app, times out
    // with nobody to read the answer, and is dropped whichever way it went — strictly worse than
    // putting the row back and saying nothing.
    //
    // One thing is left exactly where it is: a delete already committed to the wire is nobody's to
    // take back, so it stays in the list until the log answers for it.
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
    // instead. The row stops being takeable BEFORE the wire is asked and stays in the list until the
    // log answers, either way — a settle cancelled mid-flight leaves the delete still owed, and a
    // settle over the same subject re-sends it, because every one of these routes is idempotent.
    suspend fun settleWithheld(subjectId: String): WriteFailure? {
        val settling = withheld.firstOrNull { it.subjectId == subjectId } ?: return null
        clocks.remove(subjectId)?.cancel()
        withheld = withheld.map { if (it.subjectId == subjectId) it.copy(sent = true) else it }
        val seat = owner
        val log = gym
        val failed = send(settling.deletion, settling.claimBatch)
        if (seat != owner || gym !== log) return failed
        val currentId = setIds[subjectId] ?: closedDetails[subjectId]?.session?.id ?: subjectId
        withheld = withheld.filterNot { it.subjectId == currentId && it.untilMs == settling.untilMs }
        return failed
    }

    fun clearDeleteRefused() {
        deleteRefused = null
    }

    // The seven verbs behind one window, and they share no shape: a set leaves through the shelf or
    // the wire, a device-held routine through `orphanRoutine`, a conversation and a note are
    // server-only, a session's own discard answers with a bool, and the last two land on this device
    // and owe the log a claim rather than a refusal.
    private suspend fun send(deletion: Deletion, batch: ClaimBatch? = null): WriteFailure? = when (deletion) {
        is Deletion.Set -> deleteSet(deletion.sessionId, deletion.set.id)
        is Deletion.Routine -> dropRoutine(deletion.routineId)
        is Deletion.Thread -> (deleteThread(deletion.threadId) as? GymResult.Failed)?.why
        is Deletion.Session ->
            if (discard(deletion.sessionId)) null else WriteFailure.NoAnswer
        is Deletion.Note -> deleteNote(deletion.noteId)
        is Deletion.Bodyweight -> {
            deleteWeighIn(deletion.dateLocal)
            null
        }
        Deletion.Unattributed -> {
            try {
                discardUnattributed(checkNotNull(batch))
                seated?.let { connect(it) }
                null
            } catch (failure: Exception) {
                reportFailure("gym.send", failure)
                if (failure is CancellationException) throw failure
                blockedConsentSeat = "unknown"
                consentFailure = failure.message ?: "The local-data decision could not be saved."
                WriteFailure.Refused(checkNotNull(consentFailure))
            }
        }
    }

    // Doubles as the retry for a first page that failed: with no rows from the log the cursor is
    // absent, which is the top of the log. The cursor is BOTH halves of the sort key, because two
    // sessions can share an instant.
    suspend fun loadOlder() {
        if (older == Older.Loading || older == Older.End) return
        val seat = owner
        val log = gym ?: return
        older = Older.Loading
        claimIdle.await()
        if (seat != owner || gym !== log) return
        deliver()
        if (seat != owner || gym !== log) return
        val oldest = logged.lastOrNull()
        val page = tried("gym.loadOlder") { log.sessions(limit = logPage, before = oldest?.startedAtMs, beforeId = oldest?.id) }
        if (seat != owner || gym !== log) return
        if (page == null) {
            older = Older.Failed
            return
        }
        logged = logged + page.filter { fresh -> logged.none { it.id == fresh.id } }
        older = if (page.size < logPage) Older.End else Older.More
    }

    // Nothing is held: the store keeps no copy to invalidate. Signed out the domain runs over the
    // shelf's own finished sessions. Signed in the log's answer stands ALONE and the shelf is not
    // merged into it, or one aggregate would mix claimed and unclaimed rows.
    suspend fun record(exerciseId: String): GymResult<MovementRecord> {
        val seat = owner
        val log = gym
        if (log == null) {
            val movement = catalog.firstOrNull { it.id == exerciseId }
                ?: return GymResult.Failed(WriteFailure.Refused("that movement is not on this device"))
            return GymResult.Ok(MovementRecord.of(movement, localLog.details(), program))
        }
        // The record read SETTLES a stale open session: it waits for a mid-replay claim to end and
        // drains the queue first.
        claimIdle.await()
        if (seat != owner || gym !== log) return GymResult.Failed(WriteFailure.Refused("The account changed while reading."))
        deliver()
        if (seat != owner || gym !== log) return GymResult.Failed(WriteFailure.Refused("The account changed while reading."))
        return try {
            val read = log.record(exerciseId)
                ?: return GymResult.Failed(WriteFailure.Refused("that movement is no longer on the log"))
            if (seat != owner || gym !== log) return GymResult.Failed(WriteFailure.Refused("The account changed while reading."))
            GymResult.Ok(read)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.record", refusing)
            GymResult.Failed(WriteFailure(refusing))
        }
    }

    // The id never moves, so every set, routine line and frozen plan snapshot still points at the
    // same movement. It answers with the movement the log CONFIRMED and never the string that went
    // out. A movement still on the shelf is the device's to rename; anything else is the log's.
    //
    // Whether the old name keeps finding this movement: the alias is a row on the ACCOUNT, so a
    // movement this device minted and no claim has carried has no alias table.
    fun renameKeepsAnAlias(exerciseId: String): Boolean =
        gym != null && localLog.exercises.none { it.id == exerciseId }

    suspend fun rename(exerciseId: String, to: String): GymResult<Exercise> {
        val seat = owner
        val writer = gym
        val name = to.trim()
        Program.nameProblem(to)?.let { return GymResult.Failed(WriteFailure.Refused(it)) }
        val renamed = localLog.renameExercise(exerciseId, name) ?: run {
            val log = gym ?: return GymResult.Failed(
                WriteFailure.Refused("renaming a catalog movement needs your account — sign in first"))
            try {
                log.renameExercise(exerciseId, name)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure("gym.rename", refusing)
                return GymResult.Failed(WriteFailure(refusing))
            }
        }
        if (seat != owner || gym !== writer) return GymResult.Failed(WriteFailure.Refused("The account changed while renaming."))
        invalidateProgress()
        // Held under the seat that renamed it: the override belongs to this account.
        catalog = catalog.map { if (it.id == renamed.id) renamed else it } + listOfNotNull(renamed.takeIf { catalog.none { old -> old.id == it.id } })
        deviceCopy.hold(owner, catalog)
        return GymResult.Ok(renamed)
    }

    // Both answer with what went wrong: a link that was not made and one still live after a failed
    // revoke are both facts a lifter has to be told.
    suspend fun share(sessionId: String): GymResult<SessionShare> {
        val log = gym
            ?: return GymResult.Failed(WriteFailure.Refused("sharing needs your account — sign in first"))
        return try {
            GymResult.Ok(log.share(sessionId))
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.share", refusing)
            GymResult.Failed(WriteFailure(refusing))
        }
    }

    suspend fun revokeShare(sessionId: String): WriteFailure? {
        val log = gym
            ?: return WriteFailure.Refused("sharing needs your account — sign in first")
        return try {
            log.revokeShare(sessionId)
            null
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.revokeShare", refusing)
            WriteFailure(refusing)
        }
    }

    // One pass over what is owed, per (session, movement) lane, so a set that cannot land holds up
    // its own lane and nothing else.
    private suspend fun deliver() {
        if (consentRecoveryBlocked) return
        val seat = owner
        val log = gym
        var reread = false
        delivery.withLock {
            if (seat != owner || gym !== log) return@withLock
            retryTask?.cancel()
            retryTask = null
            if (queue.pending.isEmpty()) {
                // An owed claim keeps the cadence armed even with no set to walk.
                if (cadenceOwed) scheduleDeliver(afterMs = retryAfterMs)
                return@withLock
            }
            if (log == null) {
                settle(SaveState.OnThisDevice)
                return@withLock
            }

            // Sets of an UNCLAIMED session are parked, not walked: the log has never heard of their
            // session, so every send would 404.
            val parked = if (liveUnclaimed) queue.session?.id else null
            val blocked = mutableSetOf<SetQueue.Lane>()
            parked?.let { held -> blocked.addAll(queue.owed(held).map { it.lane }) }
            var refusal: String? = null
            var blockedBy: Blocker? = null
            while (true) {
                val sent = queue.sending(queue.nextOwed(skipping = blocked) ?: break)
                try {
                    when (sent.step) {
                        Owed.Append -> {
                            val stored = log.appendSet(sent.sessionId, SetWrite(sent.set))
                            if (seat != owner || gym !== log) return@withLock
                            queue.appended(stored, sent)?.let { changeHeldSet(sent.sessionId, sent.set.id, it) }
                        }
                        Owed.Fix -> {
                            val stored = log.fixSet(sent.sessionId, sent.set.id, SetFix(sent.set))
                            if (seat != owner || gym !== log) return@withLock
                            if (queue.fixed(stored, sent)) claimChanged(ClaimReplay.Change.SetChanged(sent.sessionId, sent.set.id, stored))
                        }
                        Owed.Delete -> {
                            log.deleteSet(sent.sessionId, sent.set.id)
                            if (seat != owner || gym !== log) return@withLock
                            if (queue.letGo(sent)) invalidateProgress()
                        }
                    }
                } catch (interrupted: CancellationException) {
                    throw interrupted
                } catch (refusing: Exception) {
                    reportFailure("gym.deliver", refusing)
                    if (seat != owner || gym !== log) return@withLock
                    val facts = RefusalFacts(refusing)
                    // Read off the entry as it stands: it may have been corrected or taken back while
                    // the write was on the wire, and a set taken back that never landed is no loss.
                    val lost = queue.pending.firstOrNull { it.set.id == sent.set.id } ?: sent
                    val said = lost.write != Owed.Delete
                    when (sent.step) {
                        Owed.Append -> {
                            // Every session this walk reaches is one the log once answered for, so a
                            // 404 is the workout GONE.
                            if (facts.status == 404) {
                                if (said) refusals = refusals + RefusedSet(lost.set, "that workout is no longer on the log")
                                refusal = "that workout is no longer on the log"
                                queue.sets(sent.sessionId).forEach { changeHeldSet(sent.sessionId, it.id, null) }
                                queue.forget(sent.sessionId)
                                reread = true
                                continue
                            }
                            val verdict = Verdict.refusing(facts)
                            val reason = verdict.terminalReason(afterRemints = sent.remints)
                            if (reason != null) {
                                // Removed and said: this is the only copy left of a set somebody lifted.
                                queue.drop(sent.set.id)
                                changeHeldSet(sent.sessionId, sent.set.id, null)
                                if (said) {
                                    refusals = refusals + RefusedSet(lost.set, reason)
                                    refusal = reason
                                }
                                continue
                            }
                            if (verdict is Verdict.Remint) {
                                val fresh = mintSet()
                                queue.remint(sent.set.id, fresh)
                                changeHeldSet(sent.sessionId, sent.set.id, lost.set.copy(id = fresh).takeIf { said })
                                continue
                            }
                        }
                        // The append behind it has landed, so the row is the log's. A row deleted
                        // elsewhere leaves this device too, and says so. A correction the log will
                        // never take owes nothing more: the row stays drawn as it is until the re-read
                        // replaces it with the log's numbers.
                        Owed.Fix -> when (val verdict = FixVerdict.refusing(facts)) {
                            is FixVerdict.Gone -> {
                                queue.drop(sent.set.id)
                                changeHeldSet(sent.sessionId, sent.set.id, null)
                                refusals = refusals + RefusedSet(lost.set, verdict.said)
                                continue
                            }
                            is FixVerdict.Unwritable -> {
                                if (queue.withdraw(sent)) {
                                    refusals = refusals + RefusedSet(sent.set, "the log kept the numbers this set was logged with")
                                    reread = true
                                }
                                continue
                            }
                            FixVerdict.Retry -> Unit
                        }
                        // A 404 is a row, or a whole workout, that is already not there.
                        Owed.Delete -> if (facts.status == 404) {
                            queue.letGo(sent)
                            continue
                        }
                    }
                    blocked.add(sent.lane)
                    if (blockedBy == null) blockedBy = facts.blocker
                }
            }

            queue.flush()
            // Off the failure the walk met, and off nothing else.
            strandedBy = blockedBy
            leftBehind = queue.pending.map { it.set.id }.toSet()
            drawFromQueue()
            if (seat != owner || gym !== log) return@withLock

            // The next attempt is scheduled off the queue BEFORE anything is said, or a refusal in one
            // lane takes the retry away from a set merely jammed in another. Parked sets schedule
            // nothing: the claim is their road.
            val carried = queue.pending.filter { it.sessionId != parked }
            if (carried.isNotEmpty() || cadenceOwed) scheduleDeliver(afterMs = retryAfterMs)
            if (refusal != null) {
                settle(SaveState.Refused(refusal))
                return@withLock
            }
            if (carried.isNotEmpty()) {
                settle(SaveState.Blocked(blockedBy ?: Blocker.LogFailed))
                return@withLock
            }
            settle(if (queue.pending.isEmpty()) SaveState.OnTheLog else SaveState.OnThisDevice)
        }
        if (reread && seat == owner && gym === log) loadLog()
    }

    // Carries what is still owed: the retry after a failure and the claim's own re-run, both in the
    // application scope.
    private fun scheduleDeliver(afterMs: Long) {
        retryTask?.cancel()
        retryTask = scope.launch {
            delay(afterMs)
            // Let go of the handle BEFORE the walk: `deliver` cancels whatever send is pending, and a
            // walk still holding its own task would cancel itself.
            retryTask = null
            if (reclaimed()) return@launch
            deliver()
        }
    }

    // One door for every runner, and never two abreast: a request landing mid-replay marks the claim
    // owed again and the running pass goes once more when it ends. A retryable stop leaves the claim
    // owed to the deliver task; a WAIT and a terminal refusal wait for the next connect. A pass that
    // outlived its seat settles nothing.
    private suspend fun runClaim() {
        if (consentRecoveryBlocked) return
        claimAgain = true
        if (claiming) return
        claimsRunning += 1
        val idle = CompletableDeferred<Unit>()
        claimIdle = idle
        try {
            while (claimAgain) {
                claimAgain = false
                val seat = gym ?: return
                val outcome = try { replay(seat).run() } catch (_: ClaimReplay.SeatChanged) { continue }
                if (gym !== seat) continue
                // A live start the log refuses is said again on every pass; the banner holds one copy.
                refusals = refusals + outcome.said.filter { it !in refusals }
                claimOwed = outcome.retryable
                // A landed claim answers with the STORED settings, so the room draws what the account
                // now holds rather than what it sent.
                preferences = localPreferences.document
                series = localBodyweight.entries
                drawFromQueue()
            }
        } finally {
            claimsRunning -= 1
            idle.complete(Unit)
        }
    }

    // One argument list, so the cadence's send and the sign-in's walk cannot be handed different
    // collaborators.
    private fun replay(log: TrainingSyncing): ClaimReplay {
        val seat = owner
        return ClaimReplay(log, localLog, queue, localPreferences, localBodyweight,
            mintExercise, mintRoutine, mintSession, mintSet,
            isCurrent = { seat == owner && gym === log }, onChange = ::claimChanged, bodyweightWrite = bodyweightWrite, preferencesWrite = preferencesWrite, telemetry = telemetry)
    }

    private fun claimChanged(change: ClaimReplay.Change) {
        invalidateProgress()
        when (change) {
            is ClaimReplay.Change.SessionMoved -> {
                closedDetails = closedDetails.mapValues { (_, detail) ->
                    if (detail.session.id == change.oldId) detail.copy(session = change.session) else detail
                }
                withheld.toList().forEach { held ->
                    val deletion = when (val current = held.deletion) {
                        is Deletion.Set -> current.takeIf { it.sessionId == change.oldId }
                            ?.copy(sessionId = change.session.id)
                        is Deletion.Session -> current.takeIf { it.sessionId == change.oldId }
                            ?.copy(sessionId = change.session.id)
                        else -> null
                    } ?: return@forEach
                    clocks.remove(held.subjectId)?.cancel()
                    val updated = held.copy(deletion = deletion)
                    withheld = withheld.map { if (it == held) updated else it }
                    armDelete(updated)
                }
            }
            is ClaimReplay.Change.SetChanged -> {
                changeHeldSet(change.sessionId, change.oldId, change.set)
                closedDetails = closedDetails.mapValues { (_, detail) ->
                    if (detail.session.id != change.sessionId) detail
                    else detail.copy(sets = detail.sets.mapNotNull {
                        if (it.id == change.oldId) change.set else it
                    })
                }
            }
            is ClaimReplay.Change.SessionRefused -> {
                closedFailures = closedFailures + (change.sessionId to WriteFailure.Refused(change.reason))
                withheld.filter { held ->
                    when (val deletion = held.deletion) {
                        is Deletion.Set -> deletion.sessionId == change.sessionId
                        is Deletion.Session -> deletion.sessionId == change.sessionId
                        else -> false
                    }
                }.forEach { held ->
                    clocks.remove(held.subjectId)?.cancel()
                    withheld = withheld - held
                }
            }
            is ClaimReplay.Change.Closed -> {
                if (closedDetails.values.any { it.session.id == change.detail.session.id }) retainClosed(change.detail)
            }
        }
    }

    // The walk follows the claim exactly as connect's does, the queue going out before any read, and
    // a claim that stopped being owed re-reads the log. A settings document owed on its own takes the
    // short road.
    private suspend fun reclaimed(): Boolean {
        if (claiming) return false
        val seat = gym ?: return false
        if (!claimOwed) {
            if (!localPreferences.owed) return false
            val said = try { replay(seat).runPreferences() } catch (_: ClaimReplay.SeatChanged) { return true }
            // The seat changed while the PUT was in the air: that seat's own connect owns the state.
            if (gym !== seat) return true
            refusals = refusals + said.filter { it !in refusals }
            preferences = localPreferences.document
            deliver()
            return true
        }
        runClaim()
        deliver()
        if (!claimOwed) loadLog()
        return true
    }

    private suspend fun loadLog() {
        if (!workoutAuthorized) return
        // Never mid-claim, and checked again across the await: the open session a mid-replay log
        // answers with may be a PAST one the claim just reopened, and the read would SETTLE it. It
        // stands down rather than awaiting `claimIdle`, because a local finish that calls it must not
        // block on a replay already walking the shelf.
        if (claiming) return
        val seat = owner
        val log = gym ?: return
        val live = queue.session?.id
        val read = ++logReadRevision
        val page = tried("gym.loadLog") { log.sessions(limit = logPage, before = null, beforeId = null) }
        if (!workoutAuthorized || seat != owner || gym !== log || read != logReadRevision || live != queue.session?.id) return
        if (page == null) {
            // The foot is where a quiet log is said; the rows already in hand stay.
            older = Older.Failed
            return
        }
        if (claiming) return
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
        shelved = localLog.summaries()
        // The foot is about the deepest row in hand, so it is recomputed only when this page IS the
        // whole of what is held.
        if (deeper.isEmpty()) older = if (page.size < logPage) Older.End else Older.More

        val open = page.firstOrNull { it.session.isOpen }
        if (open == null) {
            // The log holds no open session, so whatever this device was holding is over — unless the
            // log never HELD it. The session row goes; a set still owed does not.
            if (liveUnclaimed) return
            queue.session?.let { queue.close(it.id) }
            queue.flush()
            drawFromQueue()
            return
        }
        // The account's open workout elsewhere may not displace the phone's own unclaimed one.
        if (liveUnclaimed && open.session.id != queue.session?.id) return
        // Adopting the log's open workout is the log answering for it: its parked sets have a road.
        val answered = liveUnclaimed
        adopt(open.session, joined = true, readRevision = read)
        if (!workoutAuthorized || seat != owner || gym !== log || read != logReadRevision) return
        if (answered) deliver()
    }

    private suspend fun adopt(opened: Session, joined: Boolean, readRevision: Long? = null) {
        if (!workoutAuthorized || readRevision != null && readRevision != logReadRevision) return
        val seat = owner
        val log = gym
        queue.hold(opened)
        // A joined session is a list of sets this device may know nothing about, and adopting the row
        // without them would draw an empty workout over a live one.
        if (joined) {
            val detail = log?.let { tried("gym.adopt") { it.session(opened.id) } }
            if (!workoutAuthorized || seat != owner || gym !== log || queue.session?.id != opened.id ||
                readRevision != null && readRevision != logReadRevision) return
            if (detail != null) {
                queue.hold(detail.session)
                for (set in detail.sets) queue.store(set, detail.session.id, needsPush = false)
            }
        }
        queue.flush()
        drawFromQueue()
    }

    // Stands at the movement the last set went into, not in the picker. A movement already in hand is
    // re-CHOSEN rather than moved: connect cleared the last-time cache, and re-asking swaps the old
    // seat's answer for this seat's.
    private suspend fun resume() {
        val movement = queue.chosenMovement ?: exerciseId?.takeIf { it in order } ?: LiveOrder.resume(order, sets) ?: return
        choose(movement)
    }

    // Last-trained is derived off the local sessions, so a finish and a discard both change what a
    // routine says with nothing on the wire. The account's rows keep their place and the shelf's go
    // last, the order `connect` composes.
    private fun redrawShelfRoutines() {
        val mine = localLog.routines
        routines = Program.overlay(program, mine)
    }

    private fun drawFromQueue() {
        session = queue.session
        sets = queue.sets
        // Seeded from the plan and from what has already been performed, so a session joined from
        // another device walks the movements it really holds.
        val merged = LiveOrder.merged(held = queue.order, plan = session?.plan, sets = sets)
        if (merged != queue.order) {
            queue.hold(order = merged)
            queue.flush()
        }
        order = merged
        exerciseId = queue.chosenMovement ?: exerciseId?.takeIf { it in merged }
        // The stalled rows, counted off the queue and never off `saveState`. Signed out nothing is
        // stranded; a set owed to the phone's own unclaimed session is the claim's, not the logger's.
        val stalledIds = stalled
        val parked = if (liveUnclaimed) session?.id else null
        strandedCount = if (gym == null) 0 else queue.pending.count { it.set.id in stalledIds && it.sessionId != parked }
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

fun WriteFailure(refusing: Throwable): WriteFailure {
    if (refusing !is WindmillApiException.Refused) return WriteFailure.NoAnswer
    return WriteFailure.Refused(refusing.line)
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
    data class Failed(val why: WriteFailure) : ProposalRead
}

// `Answered` carries the reply whole and the screen draws it without adding to it. `Refused` is the
// log answering in its own words, which a retry cannot change; `Capped` is the one refusal that takes
// the composer down, since the next question is hours away; `Failed` is the log going quiet, which
// is worth another tap. `Absent` is the deployment having no Coach. `Fresh` is the conversation being
// full or another account's: the QUESTION is fine, so asking it again opens a new thread.
sealed interface AskOutcome {
    data class Answered(val answer: AskAnswer) : AskOutcome
    data class Refused(val said: String, val generation: works.windmill.gym.domain.AskGeneration? = null) : AskOutcome
    data class Capped(val said: String, val cap: AskCap, val generation: works.windmill.gym.domain.AskGeneration? = null) : AskOutcome
    data class Failed(val said: String, val generation: works.windmill.gym.domain.AskGeneration? = null) : AskOutcome
    data class Fresh(val said: String) : AskOutcome
    data object Absent : AskOutcome

    fun exchange(pending: AskExchange): AskExchange = when (this) {
        is Answered -> answer.generation?.exchange()?.copy(attachments = answer.generation.attachments.ifEmpty { pending.attachments })
            ?: pending.copy(answer = answer)
        is Failed -> pending.copy(trouble = said, again = true, generation = generation ?: pending.generation)
        is Refused -> pending.copy(trouble = said, again = generation != null, generation = generation ?: pending.generation)
        is Capped -> pending.copy(trouble = said, again = generation != null, generation = generation ?: pending.generation)
        is Fresh -> pending.copy(trouble = said, needsNew = true)
        Absent -> pending.copy(trouble = Ask.notHere)
    }
}

// `Failed` carries the log's answer the way every other write does, including "that workout is no
// longer on the log", after which the room is standing over no session.
sealed interface FinishOutcome {
    data class Closed(val detail: SessionDetail) : FinishOutcome {
        val session: Session get() = detail.session
    }
    data class Stranded(val count: Int) : FinishOutcome   // this session's sets that never landed — a closed one cannot take them
    data class Failed(val why: WriteFailure) : FinishOutcome
}
