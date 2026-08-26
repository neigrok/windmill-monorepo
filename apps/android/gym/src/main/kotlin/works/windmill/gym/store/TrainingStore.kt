package works.windmill.gym.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import works.windmill.gym.domain.AskAnswer
import works.windmill.gym.domain.AskQuestion
import works.windmill.gym.domain.AskThread
import works.windmill.gym.domain.AutoClose
import works.windmill.gym.domain.Blocker
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.ExerciseWrite
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.LastSet
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.LiveOrder
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
import works.windmill.gym.domain.RoutineEvent
import works.windmill.gym.domain.RoutineWrite
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.SessionShare
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.SetWrite
import works.windmill.gym.domain.TheSix
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.WeighIn
import works.windmill.gym.domain.WeighInWrite
import works.windmill.gym.net.GymHttp
import works.windmill.gym.net.RefusalFacts
import works.windmill.gym.net.TrainingSyncing
import works.windmill.platform.Account
import works.windmill.platform.net.WindmillApiException

// Where gym's pure rules meet the network, the clock and the disk. Every decision is made by asking a
// module: the ladder moves the weight, Prefill picks the number, the queue owns durability.
//
// The order of every write never varies: mint an id → store on the device → tell the log, or owe it.
// Nothing is held in memory waiting for a network call to decide whether it counts.
//
// Main-thread-confined: every verb is called from the composition scope, and TrainingSyncing does its
// own IO dispatching.
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
    private val undoWindowMs: Long = SetQueue.undoWindowMs,
    private val retryAfterMs: Long = 4_000,
    private val sync: (Account) -> TrainingSyncing? = { if (it.isSignedIn) GymHttp(it.api) else null },
) {
    // Filled by `connect` from the copy the device holds FOR THE SEAT NOW ASKING: a name is
    // per-account the moment a rename exists.
    var catalog: List<Exercise> by mutableStateOf(emptyList())
        private set
    // Published from here so the settings screen and the logger read one document.
    var preferences: GymPreferences by mutableStateOf(GymPreferences())
        private set
    // The device's copy of the series for the seat in hand, ascending by date; the log's answer
    // replaces it on connect except for what this phone still owes.
    var bodyweight: List<WeighIn> by mutableStateOf(emptyList())
        private set
    // Every proposal this room settled, as the log's reply said it: a card minted in a conversation
    // reads off this before the copy it was minted with, so a settled one never keeps saying waiting.
    var settledProposals: Map<String, Proposal> by mutableStateOf(emptyMap())
        private set
    // Every write to the program is also written to the device copy for the seat holding it, so a
    // connect that cannot read the log draws it back.
    private var program: List<Routine> by mutableStateOf(emptyList())
    var routines: List<Routine>
        get() = program
        private set(value) {
            program = value
            if (gym != null) deviceCopy.holdRoutines(owner, value)
        }
    // The cursor is the oldest row the LOG sent, never one of ours, or `Load older` would page from
    // a session the server has never heard of.
    var logged: List<SessionSummary> by mutableStateOf(emptyList())      // the account's pages, newest first
        private set
    var shelved: List<SessionSummary> by mutableStateOf(emptyList())     // the device's own, unclaimed
        private set
    // Both, merged on the clock, until the claim empties the shelf.
    val recent: List<SessionSummary>
        get() = (logged + shelved).sortedByDescending { it.startedAtMs }
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
    // Asked and came back empty-handed, which is a different fact from not having asked.
    var lastTimeFailed: Boolean by mutableStateOf(false)
        private set
    // The catalog read was asked and did not answer, so what is on screen is only `TheSix` and
    // whatever this device minted.
    var catalogUnread: Boolean by mutableStateOf(false)
        private set
    var prefill: Prefill by mutableStateOf(Prefill(Prefill.EMPTY_BAR_KG, Prefill.EMPTY_BAR_REPS))
        private set
    var refusals: List<RefusedWrite> by mutableStateOf(emptyList())      // writes that never landed
        private set
    // Nothing is told until the window closes: the log has no undelete. NOT on disk — an activity
    // recreated inside the window has told no log, so the set survives.
    var withheld: Withheld? by mutableStateOf(null)
        private set
    // One room's memory of its own writes, never a tombstone: a session read BEFORE the delete would
    // otherwise draw a row that is gone.
    var deletedSets: Set<String> by mutableStateOf(emptySet())
        private set
    var saveState: SaveState by mutableStateOf(SaveState.Idle)
        private set
    var saveTick: Int by mutableStateOf(0)                               // bumps once per write
        private set
    // Sets on this device and nowhere else after the walk has already OFFERED them.
    var strandedCount: Int by mutableStateOf(0)
        private set
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

    // Every set still in the queue is on this device and nowhere else, asked or not.
    val stalled: Set<String>
        get() = queue.pending.map { it.set.id }.toSet()

    // A routine carries its own pending proposal, so nothing polls and nothing pushes. Newest first.
    val pendingProposals: List<Proposal>
        get() = routines.mapNotNull { it.pendingProposal }.sortedByDescending { it.createdAtMs }

    fun routine(id: String): Routine? = routines.firstOrNull { it.id == id }

    // Null the instant the row lands on the log. Scoped to `exerciseId`, the only movement the logger
    // draws sets for.
    val undoable: TrainingSet?
        get() {
            val movement = exerciseId ?: return null
            return queue.withdrawable(at = now())?.set?.takeIf { it.exerciseId == movement }
        }

    // Nothing has ever happened in this room. It asks whether the reads that could say otherwise
    // actually LANDED, never whether their lists came back empty: `older == End` is the log page
    // answering "there is no more". The session the lifter is IN is not counted.
    val firstSession: Boolean
        get() = recent.isEmpty() && routines.isEmpty() && !routinesFailed && older == Older.End

    // Called on launch and on every change of who is signed in. Draws from the device first.
    suspend fun connect(account: Account) {
        gym = sync(account)
        seated = account
        // The names go with the seat: a rename is a per-account override. The shelf's own movements
        // ride with every seat, because a movement this device minted is nobody's until a claim.
        owner = account.user?.id
        // A workout composed on this device is filed under the seat that composed it, so a claim can
        // never replay one lifter's training into the account that signed in after them. An
        // unverified seat draws its own room but may not take ownership of unclaimed work.
        queue.adopt(owner, confirmed = account.verified)
        localLog.adopt(owner, confirmed = account.verified)
        // An anonymous settings document that landed nowhere rides onto the account that signed in.
        localPreferences.adopt(owner)
        preferences = localPreferences.document
        // Weigh-ins made with nobody signed in ride the same way, and every one of them is owed.
        localBodyweight.adopt(owner, confirmed = account.verified)
        bodyweight = localBodyweight.entries
        // The six ride with every seat and fill only ids nothing else here holds, so a name this
        // account chose is never overwritten by a constant.
        val known = deviceCopy.movements(owner).let { held ->
            held + localLog.exercises.filter { mine -> held.none { it.id == mine.id } }
        }
        catalog = known + TheSix.missingFrom(known)
        deviceCopy.hold(owner, catalog)
        // The copy this device last read for THIS account draws first; the read that follows replaces
        // it.
        routines = deviceCopy.routines(owner).filter { localLog.routine(it.id) == null } + localLog.routines
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
        // A withheld delete goes with the seat, UNSENT: settling it now would take a set off the log
        // of the account that just arrived.
        withheld = null
        deletedSets = emptySet()
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
        // The auto-close, run here because a session composed on this device never meets a read until
        // it claims: it is over at its last set. An UNCLAIMED session moves to the shelf whole; a
        // session the log already holds is the log's to close on the read below, so the room only
        // lets it go.
        queue.session?.let { live ->
            val overAt = AutoClose.at(live, queue.sets(live.id), now()) ?: return@let
            if (queue.sessionIsUnclaimed) {
                shelve(live, finishedAtMs = overAt)
                return@let
            }
            queue.close(live.id)
            queue.flush()
            exerciseId = null
            lastTime = null
        }
        drawFromQueue()
        isLoading = false

        val log = gym
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
        // Forced, because nothing survives a relaunch to undo.
        shelved = localLog.summaries()
        deliver(force = true)
        runClaim()
        // The sets parked behind the live session's start go out before the first read: reads settle.
        deliver(force = true)
        coroutineScope {
            launch { loadLog() }
            // Held on the device as well as in memory, so the next cold launch draws names.
            launch {
                val served = tried { log.exercises() }
                if (served == null) {
                    // Only when the room has nothing of its own to draw.
                    catalogUnread = known.isEmpty()
                    return@launch
                }
                val whole = served + localLog.exercises.filter { mine -> served.none { it.id == mine.id } }
                catalog = whole + TheSix.missingFrom(whole)
                deviceCopy.hold(owner, catalog)
            }
            launch {
                val written = tried { log.routines() }
                if (written == null) {
                    routinesFailed = true
                    return@launch
                }
                routines = written + localLog.routines
            }
            // May not land on top of a document this device still owes; `readBack` refuses that.
            launch {
                tried { log.preferences() }?.let {
                    localPreferences.readBack(it)
                    preferences = localPreferences.document
                }
            }
            // The account's whole series; an owed write and a pending delete outrank it.
            launch {
                tried { log.bodyweight() }?.let {
                    localBodyweight.readBack(it)
                    bodyweight = localBodyweight.entries
                }
            }
        }
        resume()
        if (lastSetsWanted) loadLastSets()
    }

    // Rows nothing on disk attributes, waiting for a human to say they are theirs. Answered whenever
    // EITHER half holds something: a quarantined live session can sit beside an empty shelf.
    val unattributed: LocalLog.Unattributed?
        get() {
            localLog.unattributed?.let { return it }
            // Asked as "is anything quarantined", never "is a session quarantined".
            if (!queue.hasUnattributed) return null
            return LocalLog.Unattributed(sessions = 0, routines = 0, movements = 0, days = emptyList())
        }

    val unattributedIsLive: Boolean get() = queue.unattributedSession != null

    // Everything quarantined lands on the seat in hand and the claim carries it from there. Answers
    // the one sentence that can refuse it.
    suspend fun releaseUnattributed(): String? {
        // Releasing onto the anonymous seat would hand it to the next account to sign in.
        if (owner == null) return quarantineWantsAnAccount
        // The queue answers first, because it is the half that can refuse.
        if (!queue.release() && queue.hasUnattributed) return liveSlotTaken
        localLog.release()
        seated?.let { connect(it) }
        return null
    }

    // Nothing here has landed on any log, so this is the last copy.
    suspend fun discardUnattributed() {
        localLog.discardUnattributed()
        queue.discardUnattributed()
        seated?.let { connect(it) }
    }

    // Signed in the session opens on the log and the server freezes the plan snapshot off the
    // routine's own row; signed out it is composed here off the local row. No signal composes on the
    // device and the claim lands it; only a refusal WITH A REASON is repeated.
    suspend fun start(routineId: String? = null): GymResult<Session> {
        val log = gym ?: return startOnDevice(routineId)
        // Two starts the log cannot take: mid-claim a server start would join the past session the
        // replay has open, and a routine still on the shelf is a plan the account cannot resolve.
        if (claiming || routineId?.let { localLog.routine(it) } != null) return startOnDevice(routineId)
        // A start SETTLES a stale open session on the log, so every owed set drains first.
        deliver(force = true)
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
                adopt(opened, joined = opened.id != id)
                val live = session ?: return GymResult.Failed(WriteFailure.NoAnswer)
                return GymResult.Ok(live)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: WindmillApiException) {
                val refused = refusing as? WindmillApiException.Refused
                // A workout is already open on the account: the re-read adopts it and stands the
                // lifter back where they were.
                if (refused?.status == 409 && refused.refusal.code == "session-already-open") {
                    loadLog()
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
        return GymResult.Ok(opened)
    }

    // The answer is kept for the life of the session: a last time is a FINISHED session, so none of
    // these answers can change mid-workout.
    suspend fun choose(movement: String) {
        queue.append(movement)
        queue.flush()
        order = queue.order
        exerciseId = movement
        lastTime = lastTimes[movement]
        lastTimeFailed = false
        redial()

        // Signed out the answer comes off the device's own history, where "no history" is a first
        // time and never a failed read.
        val log = gym
        if (log == null) {
            if (lastTime == null) {
                val answer = LastTime.of(movement, localLog.details())
                lastTimes[movement] = answer
                lastTime = answer
                redial()
            }
            return
        }
        if (lastTime != null) return
        val answer = tried { log.lastTime(movement) }
        if (answer == null) {
            lastTimeFailed = exerciseId == movement
            return
        }
        // A reply for a movement the lifter has already left is dropped.
        if (answer.exerciseId != movement || exerciseId != movement) return
        lastTimes[movement] = answer
        lastTime = answer
        redial()
    }

    // Sets are keyed by movement and never by position, so only the walk order moves.
    fun reorder(from: Int, to: Int) {
        val walked = LiveOrder.moved(order, from, to)
        if (walked == order) return
        queue.hold(order = walked)
        queue.flush()
        order = walked
    }

    // False where `LiveOrder.droppable` refuses. Dropping the movement in hand returns to the picker.
    fun drop(exerciseId: String): Boolean {
        if (!LiveOrder.droppable(exerciseId, sets, session?.plan)) return false
        val walked = order.filterNot { it == exerciseId }
        if (walked == order) return false
        queue.hold(order = walked)
        queue.flush()
        order = walked
        if (this.exerciseId == exerciseId) {
            this.exerciseId = null
            lastTime = null
            lastTimeFailed = false
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
        val served = tried { log.lastSets() } ?: deviceCopy.lastSets(owner) ?: return
        lastSets = (served + mine)
            .groupBy { it.exerciseId }
            .mapValues { (_, rows) -> rows.maxBy { it.atMs } }
    }

    // The row lands and the device holds it before the network is consulted at all. The kind is the
    // CALLER's and is the one thing about a set that cannot be repaired later.
    suspend fun logSet(weightKg: Double, reps: Int, kind: SetKind = SetKind.Working) {
        val live = session ?: return
        val movement = exerciseId ?: return
        if (isFinishing) return
        val set = TrainingSet(id = mintSet(), exerciseId = movement, weightKg = weightKg, reps = reps,
            kind = kind, completedAtMs = now())
        queue.store(set, live.id, needsPush = true, heldUntilMs = now() + undoWindowMs)
        queue.flush()
        drawFromQueue()
        deliver()
    }

    // Legal only while this device is the only place the set exists; false once the log holds the row.
    fun undoLast(): Boolean {
        val set = undoable ?: return false
        if (!queue.withdraw(set.id)) return false
        queue.flush()
        drawFromQueue()
        return true
    }

    // Leaving the room tears the subtree down and a pending retry never fires, so it drains here.
    suspend fun flushPendingSets(force: Boolean = false) {
        deliver(force = force)
    }

    // Waits for THIS session's sets to land, because a session that closed before a set reached it
    // refuses that set forever; a set stranded against another session cannot stop it closing. A
    // session the log does not hold closes on the device and moves whole onto the shelf.
    suspend fun finish(): FinishOutcome {
        val live = session ?: return FinishOutcome.Failed(WriteFailure.NoAnswer)
        val log = gym
        if (log == null || liveUnclaimed) return finishOnDevice(live)
        isFinishing = true
        try {
            // Forced: a set still inside its undo window would be skipped by the walk and then
            // refused forever by the close.
            deliver(force = true)

            val stranded = queue.owed(live.id).size
            if (stranded > 0) return FinishOutcome.Stranded(stranded)
            // Null is the one refusal that ends the workout anyway: a 404 is the log no longer
            // holding it.
            val closed: Session? = try {
                log.finishSession(live.id, now())
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                if (RefusalFacts(refusing).status != 404) return FinishOutcome.Failed(WriteFailure(refusing))
                null
            }

            if (closed == null) queue.forget(live.id) else queue.close(live.id)
            queue.flush()
            // The session that just closed is the next last time for every movement in it.
            lastTimes.clear()
            exerciseId = null
            lastTime = null
            drawFromQueue()
            // A shelf session parked behind this one has its road open now.
            if (localLog.finished.isNotEmpty()) runClaim()
            loadLog()
            if (closed == null) return FinishOutcome.Failed(WriteFailure.Refused("that workout is no longer on the log"))
            return FinishOutcome.Closed(closed)
        } finally {
            isFinishing = false
        }
    }

    // Session and sets move WHOLE onto the shelf and the queue lets go of both, so the shelf is the
    // single owner of a finished local session.
    private suspend fun finishOnDevice(live: Session): FinishOutcome {
        val closed = shelve(live, finishedAtMs = now())
        drawFromQueue()
        shelved = localLog.summaries()
        // The day a shelf routine was last trained is derived off the sessions that just moved.
        redrawShelfRoutines()
        if (gym != null) {
            runClaim()
            deliver()
            loadLog()
        }
        return FinishOutcome.Closed(closed)
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
        if (localLog.detail(sessionId) != null) {
            localLog.forget(sessionId)
            queue.forget(sessionId)
            queue.flush()
            drawFromQueue()
            shelved = localLog.summaries()
            // A discarded session is one a routine was NOT trained by.
            redrawShelfRoutines()
            return true
        }
        val log = gym ?: return false
        tried { log.discardSession(sessionId) } ?: return false
        queue.forget(sessionId)
        queue.flush()
        drawFromQueue()
        loadLog()
        return true
    }

    // Composed from the session's own sets, in performed order, with the weights used as targets. The
    // carrier session exists because RoutineWrite.from reads a SessionDetail; only its sets are read.
    suspend fun keep(sets: List<TrainingSet>, asRoutineNamed: String): GymResult<Routine> {
        val carrier = SessionDetail(Session(id = "ses_kept", startedAtMs = now()), sets)
        val write = RoutineWrite.from(asRoutineNamed, carrier, position = routines.size)
            ?: return GymResult.Failed(WriteFailure.Refused("a routine needs at least one working set"))
        val log = gym ?: return GymResult.Ok(keepOnDevice(write))
        return try {
            val saved = log.createRoutine(write)
            routines = routines + saved
            GymResult.Ok(saved)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            if (Verdict.refusing(RefusalFacts(refusing)) !is Verdict.Retry) {
                return GymResult.Failed(WriteFailure(refusing))
            }
            GymResult.Ok(keepOnDevice(write))
        }
    }

    // Kept on the shelf; the claim sends this same document later.
    private suspend fun keepOnDevice(write: RoutineWrite): Routine {
        val made = Routine(write)
        localLog.hold(made)
        routines = if (gym == null) localLog.routines else routines + localLog.routine(made.id)!!
        if (gym != null) {
            claimOwed = true
            deliver()
        }
        return made
    }

    // The READ is not optional: a routine PUT is a whole-document replace, so writing from a copy
    // this device last read would delete every line added since. Addressed by POSITION and refused
    // out loud when that row is gone, because a PUT of an unchanged document still moves the revision
    // and supersedes every pending proposal.
    suspend fun save(weightKg: Double, toRoutine: String, atPosition: Int,
                     forExercise: String): WriteFailure? {
        // A routine still on the shelf is the device's to move.
        localLog.routine(toRoutine)?.let { mine ->
            val moved = mine.retargeting(atPosition, forExercise, toWeightKg = weightKg)
                ?: return WriteFailure.Refused("${mine.name} has changed since this session started")
            localLog.hold(moved)
            routines = if (gym == null) localLog.routines
                else routines.map { if (it.id == toRoutine) localLog.routine(toRoutine)!! else it }
            return null
        }
        val log = gym ?: return WriteFailure.Refused("that routine is not on this device")
        return try {
            // Absent and another account's fold into null, so there is no sentence to repeat.
            val routine = log.routine(toRoutine)
                ?: return WriteFailure.Refused("that routine is no longer on the log")
            val moved = routine.retargeting(atPosition, forExercise, toWeightKg = weightKg)
                ?: return WriteFailure.Refused("${routine.name} has changed since this session started")
            val saved = log.replaceRoutine(toRoutine, RoutineWrite(moved))
            routines = routines.map { if (it.id == saved.id) saved else it }
            null
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (error: Exception) {
            WriteFailure(error)
        }
    }

    // One day of the program, written WHOLE. A routine with an id is an edit and goes out as a PUT,
    // which moves the revision and supersedes every proposal pending on it; without one it is a
    // create and the id is minted here. Savable while incomplete but not while EMPTY.
    suspend fun saveRoutine(draft: RoutineDraft): GymResult<Routine> {
        val name = Program.named(draft.name)
            ?: return GymResult.Failed(WriteFailure.Refused("a routine needs a name"))
        if (draft.entries.isEmpty()) {
            return GymResult.Failed(WriteFailure.Refused("a routine needs at least one movement"))
        }
        val standing = draft.id
        // A routine still on the shelf is the device's to write; the claim sends whatever it finds.
        if (standing != null && localLog.routine(standing) != null) {
            val held = Routine(RoutineWrite(standing, name, draft.position, draft.write))
            localLog.hold(held)
            routines = if (gym == null) localLog.routines
                else routines.map { if (it.id == standing) localLog.routine(standing)!! else it }
            return GymResult.Ok(held)
        }
        val log = gym
        if (log == null) {
            // Signed out, a routine this shelf does not hold is the account's.
            if (standing != null) {
                return GymResult.Failed(
                    WriteFailure.Refused("that routine is on your account — sign in to change it"))
            }
            return GymResult.Ok(keepOnDevice(RoutineWrite(mintRoutine(), name, draft.position, draft.write)))
        }
        val write = RoutineWrite(standing ?: mintRoutine(), name, draft.position, draft.write)
        return try {
            val saved = if (standing == null) log.createRoutine(write)
                else log.replaceRoutine(standing, write)
            routines = if (standing == null) routines + saved
                else routines.map { if (it.id == saved.id) saved else it }
            GymResult.Ok(saved)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            // A NEW day typed with no signal is kept on the shelf. An EDIT of the account's day
            // cannot be: the shelf's create would land it as a second routine.
            if (standing != null || Verdict.refusing(RefusalFacts(refusing)) !is Verdict.Retry) {
                return GymResult.Failed(WriteFailure(refusing))
            }
            GymResult.Ok(keepOnDevice(write))
        }
    }

    // The sessions that named it keep every set and their frozen plan: a snapshot is a copy, not a
    // reference. A routine still on the shelf leaves through `orphanRoutine`, which also drops the
    // dead id off the local sessions that would replay a start the log must refuse. A 404 is success.
    suspend fun dropRoutine(id: String): WriteFailure? {
        if (localLog.routine(id) != null) {
            localLog.orphanRoutine(id)
            routines = routines.filterNot { it.id == id }
            return null
        }
        val log = gym
            ?: return WriteFailure.Refused("that routine is on your account — sign in to change it")
        return try {
            log.deleteRoutine(id)
            routines = routines.filterNot { it.id == id }
            null
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            if (RefusalFacts(refusing).status == 404) {
                routines = routines.filterNot { it.id == id }
                null
            } else {
                WriteFailure(refusing)
            }
        }
    }

    // Rides on the ROUTINE read rather than a route of its own. A routine the shelf holds has no
    // history, and that is an answer rather than a failure.
    suspend fun routineHistory(routineId: String): GymResult<List<RoutineEvent>> {
        if (localLog.routine(routineId) != null) return GymResult.Ok(emptyList())
        val log = gym ?: return GymResult.Ok(emptyList())
        return try {
            val read = log.routine(routineId)
                ?: return GymResult.Failed(WriteFailure.Refused("that routine is no longer on the log"))
            GymResult.Ok(read.history)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            GymResult.Failed(WriteFailure(refusing))
        }
    }

    // Nothing is held: a second visit asks again, because a proposal moves the moment anybody decides
    // anything. Answers with a REASON and never with null.
    suspend fun proposal(id: String): GymResult<Proposal> {
        val log = gym ?: return GymResult.Failed(WriteFailure.Refused(proposalsWantAnAccount))
        return try {
            val read = log.proposal(id)
                ?: return GymResult.Failed(WriteFailure.Refused("that proposal is no longer on the log"))
            GymResult.Ok(read)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            GymResult.Failed(WriteFailure(refusing))
        }
    }

    // Atomic against the base the diff was written on. Nothing here merges, retries or applies part
    // of a diff.
    suspend fun applyProposal(id: String): ProposalOutcome {
        val log = gym ?: return ProposalOutcome.Failed(WriteFailure.Refused(proposalsWantAnAccount))
        return try {
            decided(log.applyProposal(id))
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            refused(refusing)
        }
    }

    suspend fun dismissProposal(id: String): ProposalOutcome {
        val log = gym ?: return ProposalOutcome.Failed(WriteFailure.Refused(proposalsWantAnAccount))
        return try {
            decided(log.dismissProposal(id))
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            refused(refusing)
        }
    }

    // Drawn from the log's own answer and never from the send. The card is dropped BY ID rather than
    // blanked, because a newer proposal may already be standing in that slot.
    private fun decided(decision: ProposalDecision): ProposalOutcome {
        val settled = decision.proposal
        val moved = decision.routine
        routines = when {
            moved != null -> routines.map { if (it.id == moved.id) moved else it }
            settled.state == ProposalState.Applied && settled.intent == ProposalIntent.Remove ->
                routines.filterNot { it.id == settled.routineId }
            else -> routines.map { held ->
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
        val log = gym ?: return
        val written = tried { log.routines() } ?: return
        routines = written + localLog.routines
    }

    // The reply is drawn as it arrived: the prose, the server's own count of the rows it served, and
    // any proposal ids. NOTHING HERE COMPOSES A NUMBER. A proposal minted in a conversation is a card
    // on home too, so the program is re-read the moment one appears.
    suspend fun ask(threadId: String, question: String): AskOutcome {
        val log = gym ?: return AskOutcome.Refused(askWantsAnAccount)
        return try {
            val answered = log.ask(AskQuestion(thread = threadId, question = question))
            if (answered.proposals.isNotEmpty()) reread()
            AskOutcome.Answered(answered)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            when (val verdict = AskVerdict.refusing(RefusalFacts(refusing))) {
                is AskVerdict.Said -> AskOutcome.Refused(verdict.said)
                is AskVerdict.Capped -> AskOutcome.Capped(verdict.said)
                is AskVerdict.Again -> AskOutcome.Failed(verdict.said)
                is AskVerdict.Fresh -> AskOutcome.Fresh(verdict.said)
                AskVerdict.Absent -> AskOutcome.Absent
            }
        }
    }

    // Nothing is held between the three thread reads: the outcome is DERIVED by the server from the
    // proposals, so a cached list would draw a thread as `waiting` days after it was decided.
    suspend fun threads(): GymResult<List<AskThread>> {
        val log = gym ?: return GymResult.Failed(WriteFailure.Refused(askWantsAnAccount))
        return try {
            GymResult.Ok(log.threads())
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            GymResult.Failed(WriteFailure(refusing))
        }
    }

    // A log that refused with a sentence is not a log holding no such thread, so the absence answers
    // in words rather than as a null.
    suspend fun thread(id: String): GymResult<AskThread> {
        val log = gym ?: return GymResult.Failed(WriteFailure.Refused(askWantsAnAccount))
        return try {
            val read = log.thread(id)
                ?: return GymResult.Failed(WriteFailure.Refused(noSuchThread))
            GymResult.Ok(read)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            GymResult.Failed(WriteFailure(refusing))
        }
    }

    // The routines are NOT re-read: deleting a conversation leaves every change it applied standing
    // in the routine's history. A 404 answers as success.
    suspend fun deleteThread(id: String): GymResult<Unit> {
        val log = gym ?: return GymResult.Failed(WriteFailure.Refused(askWantsAnAccount))
        return try {
            log.deleteThread(id)
            GymResult.Ok(Unit)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            if (RefusalFacts(refusing).status == 404) GymResult.Ok(Unit)
            else GymResult.Failed(WriteFailure(refusing))
        }
    }

    // Notes are the account's and this phone holds none: every screen reads on the way in, and a
    // refusal arrives in the log's own words — the ten cap and the two bounds are its to state.
    suspend fun notes(): GymResult<List<Note>> {
        val log = gym ?: return GymResult.Failed(WriteFailure.Refused(notesWantAnAccount))
        return try {
            GymResult.Ok(log.notes())
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            GymResult.Failed(WriteFailure(refusing))
        }
    }

    suspend fun saveNote(id: String, write: NoteWrite): GymResult<Note> {
        val log = gym ?: return GymResult.Failed(WriteFailure.Refused(notesWantAnAccount))
        return try {
            GymResult.Ok(log.writeNote(id, write))
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            GymResult.Failed(WriteFailure(refusing))
        }
    }

    // A 404 answers as success: the note is gone either way.
    suspend fun deleteNote(id: String): WriteFailure? {
        val log = gym ?: return WriteFailure.Refused(notesWantAnAccount)
        return try {
            log.deleteNote(id)
            null
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            if (RefusalFacts(refusing).status == 404) null else WriteFailure(refusing)
        }
    }

    suspend fun reorderNotes(order: List<String>): GymResult<List<Note>> {
        val log = gym ?: return GymResult.Failed(WriteFailure.Refused(notesWantAnAccount))
        return try {
            GymResult.Ok(log.reorderNotes(order))
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            GymResult.Failed(WriteFailure(refusing))
        }
    }

    // The equipment is the CALLER's and is never guessed. The pattern is the domain's value for "we
    // did not ask": nothing on this surface reads it, because the ladder is taken off the MAGNITUDE
    // of the load.
    suspend fun create(name: String, equipment: String): GymResult<Exercise> {
        val log = gym ?: return GymResult.Ok(createOnDevice(name, equipment))
        return try {
            val made = log.createExercise(ExerciseWrite(id = mintExercise(), name = name,
                pattern = Exercise.unclassified, equipment = equipment))
            catalog = catalog + made
            deviceCopy.hold(owner, catalog)
            GymResult.Ok(made)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            if (Verdict.refusing(RefusalFacts(refusing)) !is Verdict.Retry) {
                return GymResult.Failed(WriteFailure(refusing))
            }
            GymResult.Ok(createOnDevice(name, equipment))
        }
    }

    // The claim carries it onto the account before any set that names it.
    private suspend fun createOnDevice(name: String, equipment: String): Exercise {
        val made = Exercise(id = mintExercise(), name = name, pattern = Exercise.unclassified,
            equipment = equipment, custom = true)
        localLog.hold(made)
        catalog = catalog + made
        deviceCopy.hold(owner, catalog)
        if (gym != null) {
            claimOwed = true
            deliver()
        }
        return made
    }

    // Held on the device FIRST, so the rest clock obeys it on the next frame whether or not the log
    // is reachable. A whole-document PUT whose reply is the STORED document rather than the send.
    suspend fun savePreferences(document: GymPreferences): WriteFailure? {
        localPreferences.save(document)
        preferences = localPreferences.document
        val log = gym ?: return null
        return try {
            localPreferences.landed(log.savePreferences(localPreferences.document))
            preferences = localPreferences.document
            null
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            // Still owed: `deliver` arms itself off `localPreferences.owed` even with an empty queue
            // and sends this document alone rather than re-walking the claim.
            deliver()
            WriteFailure(refusing)
        }
    }

    fun clearRefusals() {
        refusals = emptyList()
    }

    // The newest day that has happened: a row dated past this phone's today is not a reading (B2).
    val latestWeighIn: WeighIn? get() = Bodyweight.latest(bodyweight, Bodyweight.today(now()))

    // Held on the device FIRST, keyed by the local date, then sent exactly like a set: a log that
    // went quiet leaves it owed to the claim, and only a refusal with a reason comes back as one.
    // The row that stands is the newer of the two by `recordedAt`, on this phone and on the log.
    suspend fun weighIn(dateLocal: String, weightKg: Double): WriteFailure? {
        val recorded = localBodyweight.record(WeighIn(dateLocal, weightKg, recordedAt = now()))
        bodyweight = localBodyweight.entries
        val log = gym ?: return null
        return try {
            localBodyweight.landed(log.putBodyweight(recorded.dateLocal, WeighInWrite(recorded.weightKg, recorded.recordedAt)))
            bodyweight = localBodyweight.entries
            null
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            if (Verdict.refusing(RefusalFacts(refusing)) is Verdict.Retry) {
                claimOwed = true
                deliver()
                return null
            }
            localBodyweight.letGo(recorded.dateLocal)
            bodyweight = localBodyweight.entries
            WriteFailure(refusing)
        }
    }

    // Gone from the device at once; the log's delete has no terminal refusal, so a miss is owed to
    // the claim rather than said.
    suspend fun deleteWeighIn(dateLocal: String) {
        localBodyweight.delete(dateLocal)
        bodyweight = localBodyweight.entries
        val log = gym ?: return
        val landed = tried { log.deleteBodyweight(dateLocal) }
        if (landed != null) {
            localBodyweight.deletionLanded(dateLocal)
            return
        }
        claimOwed = true
        deliver()
    }

    // Computed by the DOMAIN and read here, never re-derived. For a session only the shelf holds it
    // runs on the device: no record and no comparison, which need the log's whole history.
    suspend fun review(of: String): Review? {
        localLog.detail(of)?.let { return Review.of(it) }
        val log = gym ?: return null
        return tried { log.review(of) }
    }

    // Off the shelf when only the shelf holds it, otherwise off the log.
    suspend fun sessionDetail(sessionId: String): GymResult<SessionDetail> {
        localLog.detail(sessionId)?.let { return GymResult.Ok(it) }
        val log = gym
            ?: return GymResult.Failed(WriteFailure.Refused("that session is on your account — sign in to read it"))
        return try {
            val detail = log.session(sessionId)
                ?: return GymResult.Failed(WriteFailure.Refused("that session is no longer on the log"))
            GymResult.Ok(detail)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            GymResult.Failed(WriteFailure(refusing))
        }
    }

    // The branch is WHOSE ROW IT IS, not the network: a session the shelf holds has never been sent,
    // so the correction rewrites the row that will be sent. Anything else goes over the wire. The log
    // moves and the routine does not: a fix carries three fields, none of them a target.
    suspend fun fixSet(sessionId: String, setId: String, fix: SetFix): FixOutcome {
        // THE SESSION decides the road, not the set: falling through would PATCH an id the log has
        // never seen.
        if (localLog.row(sessionId) != null) {
            val corrected = localLog.fixSet(sessionId, setId, fix)
                ?: return FixOutcome.Gone("that set is no longer on this device")
            shelved = localLog.summaries()
            return FixOutcome.Corrected(corrected)
        }
        val log = gym
            ?: return FixOutcome.Failed(WriteFailure.Refused("that set is on your account — sign in to fix it"))
        return try {
            val stored = log.fixSet(sessionId, setId, fix)
            rereadRow(sessionId)
            FixOutcome.Corrected(stored)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            when (val verdict = FixVerdict.refusing(RefusalFacts(refusing))) {
                is FixVerdict.Gone -> FixOutcome.Gone(verdict.said)
                is FixVerdict.Unwritable -> FixOutcome.Failed(WriteFailure.Refused(verdict.said))
                FixVerdict.Retry -> FixOutcome.Failed(WriteFailure(refusing))
            }
        }
    }

    // Once the window over it has closed. Same two roads as the fix, and the wire's has no terminal
    // refusal: already gone, never existed and another account's are all 204, so a retry after a lost
    // reply is safe. Nothing here recovers a deleted row.
    suspend fun deleteSet(sessionId: String, setId: String): WriteFailure? {
        // A row the shelf's session no longer holds is the same nothing-to-do the wire answers 204
        // with, never a question to put to the account.
        if (localLog.row(sessionId) != null) {
            if (localLog.deleteSet(sessionId, setId)) {
                deletedSets = deletedSets + setId
                shelved = localLog.summaries()
            }
            return null
        }
        val log = gym ?: return WriteFailure.Refused("that set is on your account — sign in to delete it")
        return try {
            log.deleteSet(sessionId, setId)
            deletedSets = deletedSets + setId
            rereadRow(sessionId)
            null
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            WriteFailure(refusing)
        }
    }

    // Its aggregates all moved with the set and the log is the only thing that computes them. It asks
    // for ONE row, anchored on the one above it, because a session reached with `Load older` is below
    // the head; the answer is taken only if it IS the row asked for, since the cursor is a position.
    private suspend fun rereadRow(sessionId: String) {
        val log = gym ?: return
        val at = logged.indexOfFirst { it.id == sessionId }
        if (at < 0) return
        // One row is still the log read, and the log read settles: not mid-claim.
        claimIdle.await()
        val above = logged.getOrNull(at - 1)
        val fresh = tried { log.sessions(limit = 1, before = above?.startedAtMs, beforeId = above?.id) }
            ?.singleOrNull()?.takeIf { it.id == sessionId } ?: return
        logged = logged.map { if (it.id == sessionId) fresh else it }
    }

    // ONE SLOT: a second delete SETTLES the first rather than replacing it, or a destructive gesture
    // would do nothing at all.
    suspend fun withhold(sessionId: String, set: TrainingSet): WriteFailure? {
        val standing = withheld
        withheld = Withheld(sessionId, set, untilMs = now() + undoWindowMs)
        standing ?: return null
        return deleteSet(standing.sessionId, standing.set.id)
    }

    // False once the delete is on the wire: there is no undelete, so a true here would report a keep
    // the log has already lost.
    fun keepWithheld(): Boolean {
        val holding = withheld ?: return false
        if (!holding.takeable) return false
        withheld = null
        return true
    }

    // The window closing, or the room being left: leaving ENDS it, because the row is off the screen
    // the gesture belonged to. The row stops being takeable BEFORE the wire is asked and stays here
    // until the log answers, either way: a settle cancelled mid-flight leaves the delete still owed,
    // and the route is idempotent.
    suspend fun settleWithheld(): WriteFailure? {
        val holding = withheld ?: return null
        withheld = holding.copy(sent = true)
        val failed = deleteSet(holding.sessionId, holding.set.id)
        withheld = null
        return failed
    }

    // Doubles as the retry for a first page that failed: with no rows from the log the cursor is
    // absent, which is the top of the log. The cursor is BOTH halves of the sort key, because two
    // sessions can share an instant.
    suspend fun loadOlder() {
        if (older == Older.Loading || older == Older.End) return
        val log = gym ?: return
        // A page read SETTLES a stale open session, so it waits for a mid-replay claim to end and
        // drains the queue first.
        older = Older.Loading
        claimIdle.await()
        deliver()
        val oldest = logged.lastOrNull()
        val page = tried { log.sessions(limit = logPage, before = oldest?.startedAtMs, beforeId = oldest?.id) }
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
        val log = gym
        if (log == null) {
            val movement = catalog.firstOrNull { it.id == exerciseId }
                ?: return GymResult.Failed(WriteFailure.Refused("that movement is not on this device"))
            return GymResult.Ok(MovementRecord.of(movement, localLog.details(), routines))
        }
        // The record read SETTLES a stale open session: it waits for a mid-replay claim to end and
        // drains the queue first.
        claimIdle.await()
        deliver()
        return try {
            val read = log.record(exerciseId)
                ?: return GymResult.Failed(WriteFailure.Refused("that movement is no longer on the log"))
            GymResult.Ok(read)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
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
        val name = to.trim()
        if (name.isEmpty()) return GymResult.Failed(WriteFailure.Refused("a movement needs a name"))
        val renamed = localLog.renameExercise(exerciseId, name) ?: run {
            val log = gym ?: return GymResult.Failed(
                WriteFailure.Refused("renaming a catalog movement needs your account — sign in first"))
            try {
                log.renameExercise(exerciseId, name)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                return GymResult.Failed(WriteFailure(refusing))
            }
        }
        // Held under the seat that renamed it: the override belongs to this account.
        catalog = catalog.map { if (it.id == renamed.id) renamed else it }
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
            WriteFailure(refusing)
        }
    }

    // One pass over what is owed, per (session, movement) lane, so a set that cannot land holds up
    // its own lane and nothing else.
    private suspend fun deliver(force: Boolean = false) {
        retryTask?.cancel()
        retryTask = null
        if (queue.pending.isEmpty()) {
            // An owed claim keeps the cadence armed even with no set to walk.
            if (cadenceOwed) scheduleDeliver(afterMs = retryAfterMs)
            return
        }
        val log = gym
        if (log == null) {
            settle(SaveState.OnThisDevice)
            return
        }

        // Sets of an UNCLAIMED session are parked, not walked: the log has never heard of their
        // session, so every send would 404.
        val parked = if (liveUnclaimed) queue.session?.id else null
        val blocked = mutableSetOf<SetQueue.Lane>()
        parked?.let { held -> blocked.addAll(queue.owed(held).map { it.lane }) }
        var refusal: String? = null
        var blockedBy: Blocker? = null
        var gone = false
        while (true) {
            val owed = queue.nextOwed(skipping = blocked, readyAt = if (force) null else now()) ?: break
            try {
                val stored = log.appendSet(owed.sessionId, SetWrite(owed.set))
                queue.delivered(stored, owed.set.id, owed.sessionId)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                val facts = RefusalFacts(refusing)
                // Every session this walk reaches is one the log once answered for, so a 404 is the
                // workout GONE.
                if (facts.status == 404) {
                    refusals = refusals + RefusedSet(owed.set, "that workout is no longer on the log")
                    refusal = "that workout is no longer on the log"
                    queue.forget(owed.sessionId)
                    gone = true
                    continue
                }
                val verdict = Verdict.refusing(facts)
                val reason = verdict.terminalReason(afterRemints = owed.remints)
                if (reason != null) {
                    // Removed and said: this is the only copy left of a set somebody lifted.
                    queue.drop(owed.set.id)
                    refusals = refusals + RefusedSet(owed.set, reason)
                    refusal = reason
                    continue
                }
                if (verdict is Verdict.Remint) {
                    queue.remint(owed.set.id, mintSet())
                    continue
                }
                blocked.add(owed.lane)
                if (blockedBy == null) blockedBy = facts.blocker
            }
        }

        queue.flush()
        // Off the failure the walk met, and off nothing else.
        strandedBy = blockedBy
        drawFromQueue()
        if (gone) loadLog()

        // The next attempt is scheduled off the queue BEFORE anything is said, or a refusal in one
        // lane takes the retry away from a set merely jammed in another. Parked sets schedule
        // nothing: the claim is their road.
        val carried = queue.pending.filter { it.sessionId != parked }
        val earliestReady = carried.minOfOrNull { it.heldUntilMs ?: 0 }
        if (earliestReady == null) {
            if (cadenceOwed) scheduleDeliver(afterMs = retryAfterMs)
            if (refusal != null) {
                settle(SaveState.Refused(refusal))
                return
            }
            settle(if (queue.pending.isEmpty()) SaveState.OnTheLog else SaveState.OnThisDevice)
            return
        }
        // A set the walk never offered is not a set that failed: everything owed being inside its own
        // undo window means this device is holding them on purpose.
        val waiting = earliestReady - now()
        scheduleDeliver(afterMs = if (waiting > 0) waiting else retryAfterMs)
        if (refusal != null) {
            settle(SaveState.Refused(refusal))
            return
        }
        if (waiting <= 0) settle(SaveState.Blocked(blockedBy ?: Blocker.LogFailed))
    }

    // Carries what is still owed: the retry after a failure, the send after a window closes, and the
    // claim's own re-run. The task dies with the scope, which is why leaving the room flushes.
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
        claimAgain = true
        if (claiming) return
        claimsRunning += 1
        val idle = CompletableDeferred<Unit>()
        claimIdle = idle
        try {
            while (claimAgain) {
                claimAgain = false
                val seat = gym ?: return
                val outcome = replay(seat).run()
                if (gym !== seat) continue
                // A live start the log refuses is said again on every pass; the banner holds one copy.
                refusals = refusals + outcome.said.filter { it !in refusals }
                claimOwed = outcome.retryable
                // A landed claim answers with the STORED settings, so the room draws what the account
                // now holds rather than what it sent.
                preferences = localPreferences.document
                bodyweight = localBodyweight.entries
                drawFromQueue()
            }
        } finally {
            claimsRunning -= 1
            idle.complete(Unit)
        }
    }

    // One argument list, so the cadence's send and the sign-in's walk cannot be handed different
    // collaborators.
    private fun replay(seat: TrainingSyncing) =
        ClaimReplay(seat, localLog, queue, localPreferences, localBodyweight,
                    mintExercise, mintRoutine, mintSession, mintSet)

    // The walk follows the claim exactly as connect's does, the queue going out before any read, and
    // a claim that stopped being owed re-reads the log. A settings document owed on its own takes the
    // short road.
    private suspend fun reclaimed(): Boolean {
        if (claiming) return false
        val seat = gym ?: return false
        if (!claimOwed) {
            if (!localPreferences.owed) return false
            val said = replay(seat).runPreferences()
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
        // Never mid-claim, and checked again across the await: the open session a mid-replay log
        // answers with may be a PAST one the claim just reopened, and the read would SETTLE it. It
        // stands down rather than awaiting `claimIdle`, because a local finish that calls it must not
        // block on a replay already walking the shelf.
        if (claiming) return
        val log = gym ?: return
        val page = tried { log.sessions(limit = logPage, before = null, beforeId = null) }
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
        adopt(open.session, joined = true)
        if (answered) deliver()
    }

    private suspend fun adopt(opened: Session, joined: Boolean) {
        queue.hold(opened)
        // A joined session is a list of sets this device may know nothing about, and adopting the row
        // without them would draw an empty workout over a live one.
        if (joined) {
            val detail = gym?.let { tried { it.session(opened.id) } }
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
        val movement = exerciseId ?: LiveOrder.resume(order, sets) ?: return
        choose(movement)
    }

    // Last-trained is derived off the local sessions, so a finish and a discard both change what a
    // routine says with nothing on the wire. The account's rows keep their place and the shelf's go
    // last, the order `connect` composes.
    private fun redrawShelfRoutines() {
        val mine = localLog.routines
        routines = routines.filter { held -> mine.none { it.id == held.id } } + mine
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
        // Counted off the queue and never off `saveState`. A set inside its undo window is held on
        // purpose; signed out nothing is stranded; a set owed to the phone's own unclaimed session is
        // the claim's, not the strip's.
        val instant = now()
        strandedCount = if (gym == null) 0 else queue.pending.count {
            !it.isHeld(instant) && !(liveUnclaimed && it.sessionId == session?.id)
        }
        redial()
    }

    private fun redial() {
        prefill = Prefill.of(todaySets, planEntry, lastTime)
    }

    // The tick is what the note watches, so two sets landing in the same state read as two saves.
    private fun settle(state: SaveState) {
        saveState = state
        saveTick += 1
    }

    // A cancellation is not a failed read: it passes through, or a room being torn down would read as
    // a log that went quiet.
    private suspend fun <T> tried(ask: suspend () -> T): T? = try {
        ask()
    } catch (interrupted: CancellationException) {
        throw interrupted
    } catch (failed: Exception) {
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

// A delete this device has made. The set travels whole: it is the last copy while the window is open,
// and Undo has to put it back exactly. `sent` is the moment the window stops being the lifter's — the
// delete is on the wire and there is no way back — while the row stays here until the log answers, so
// a settle cancelled mid-flight is still owed and the next one re-sends it.
data class Withheld(
    val sessionId: String,
    val set: TrainingSet,
    val untilMs: Long,
    val sent: Boolean = false,
) {
    val takeable: Boolean get() = !sent
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

// `Answered` carries the reply whole and the screen draws it without adding to it. `Refused` is the
// log answering in its own words, which a retry cannot change; `Capped` is the one refusal that takes
// the composer down, since the next question is hours away; `Failed` is the log going quiet, which
// is worth another tap. `Absent` is the deployment having no Coach. `Fresh` is the conversation being
// full or another account's: the QUESTION is fine, so asking it again opens a new thread.
sealed interface AskOutcome {
    data class Answered(val answer: AskAnswer) : AskOutcome
    data class Refused(val said: String) : AskOutcome
    data class Capped(val said: String) : AskOutcome
    data class Failed(val said: String) : AskOutcome
    data class Fresh(val said: String) : AskOutcome
    data object Absent : AskOutcome
}

// `Failed` carries the log's answer the way every other write does, including "that workout is no
// longer on the log", after which the room is standing over no session.
sealed interface FinishOutcome {
    data class Closed(val session: Session) : FinishOutcome
    data class Stranded(val count: Int) : FinishOutcome   // this session's sets that never landed — a closed one cannot take them
    data class Failed(val why: WriteFailure) : FinishOutcome
}
