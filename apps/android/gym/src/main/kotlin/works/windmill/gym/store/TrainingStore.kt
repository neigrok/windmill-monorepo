package works.windmill.gym.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.ExerciseWrite
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.LiveOrder
import works.windmill.gym.domain.MovementRecord
import works.windmill.gym.domain.PlanEntry
import works.windmill.gym.domain.PlanSnapshot
import works.windmill.gym.domain.Prefill
import works.windmill.gym.domain.Review
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineWrite
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.SessionShare
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.SetWrite
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.net.GymHttp
import works.windmill.gym.net.RefusalFacts
import works.windmill.gym.net.TrainingSyncing
import works.windmill.platform.Account
import works.windmill.platform.net.WindmillApiException

// The live session, wired — the Kotlin twin of the iOS TrainingStore (the web's useLiveSession.js
// was the reference implementation until 2026-08-09, when the web demoted to mirror + backfill;
// the contract's pinned home is backend/products/gym/ARCHITECTURE.md §11), and the one place in
// gym where the pure rules meet the network, the clock and the disk. Everything it decides it decides by asking a module: the ladder moves the weight,
// Prefill picks the number, the queue owns durability. This file is the plumbing and none of the
// meaning.
//
// The order of every write is the same and never varies: mint an id → store on the device → tell
// the log, or owe it. Nothing is ever held in memory waiting for a network call to decide whether
// it counts, and nothing about logging changes offline.
//
// Named for what it holds — the training, beside `TrainingSyncing` — and not for the session,
// because `WindmillPlatform`'s SessionStore is the secret store behind AuthStore. Two unrelated
// things wearing one name in one app is the shape that hides a bug.
//
// Main-thread-confined exactly as the Swift one is @MainActor: every verb is called from the
// composition scope, and TrainingSyncing does its own IO dispatching.
class TrainingStore(
    private val queue: SetQueue,
    private val deviceCatalog: DeviceCatalog,
    private val localLog: LocalLog,
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
    // The names before the read. A movement is a stable id everywhere except on screen, so a store
    // that waited for the catalog read would draw `bench-press` at 28sp in the meantime — in a
    // basement, for a whole session. It is filled by `connect`, from the copy the device holds FOR
    // THE SEAT NOW ASKING, because a name is per-account the moment a rename exists: one lifter's
    // `Low-bar Squat` is nobody else's, and the frame before an account is known is no place to
    // guess. `connect` runs from the room's first effect, so that frame is the one the effect
    // completes in.
    var catalog: List<Exercise> by mutableStateOf(emptyList())
        private set
    var routines: List<Routine> by mutableStateOf(emptyList())
        private set
    // THE LOG IN ITS TWO HALVES, kept apart rather than merged into one list because two questions
    // need the seam. Which rows are saved on THIS DEVICE ONLY — the log's hollow ring, and every row
    // a signed-out lifter has. And where the next page starts: the cursor is the oldest row the LOG
    // sent, never one of ours, or `Load older` would ask the server to page from a session it has
    // never heard of.
    var logged: List<SessionSummary> by mutableStateOf(emptyList())      // the account's pages, newest first
        private set
    var shelved: List<SessionSummary> by mutableStateOf(emptyList())     // the device's own, unclaimed
        private set
    // The reader sees both, merged on the clock, until the claim empties the shelf.
    val recent: List<SessionSummary>
        get() = (logged + shelved).sortedByDescending { it.startedAtMs }
    // The foot of the log, and it is four states rather than a spinner: there is more, it is being
    // fetched, there is nothing older, or the read failed. Paging is a TAP and never a scroll, so
    // the request is always the lifter's own.
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
    // Whether the read was ASKED and came back empty-handed, which is a different fact from not
    // having asked yet. Without it the card says "reading your log…" forever after a failure, and a
    // movement the lifter has trained for a year reads as one they never have.
    var lastTimeFailed: Boolean by mutableStateOf(false)
        private set
    var prefill: Prefill by mutableStateOf(Prefill(Prefill.EMPTY_BAR_KG, Prefill.EMPTY_BAR_REPS))
        private set
    var refusals: List<RefusedWrite> by mutableStateOf(emptyList())      // writes that never landed
        private set
    var saveState: SaveState by mutableStateOf(SaveState.Idle)
        private set
    var saveTick: Int by mutableStateOf(0)                               // bumps once per write
        private set
    // How many sets are on this device and nowhere else after the walk has already OFFERED them —
    // the strip's own fact, kept apart from `saveState` because they are two facts and one word
    // cannot say both. A set refused outright in one lane and a set merely jammed behind a 500 in
    // another happen in the same walk, and the second one is what the strip exists to name.
    var strandedCount: Int by mutableStateOf(0)
        private set
    var isLoading: Boolean by mutableStateOf(true)
        private set
    // Finish is a round trip, and a set logged into a session that closes under it is refused
    // forever. Published rather than private so the room can say where that set can still go —
    // silently dropping the tap and silently taking it are both ways of losing a lift.
    var isFinishing: Boolean by mutableStateOf(false)
        private set

    private var gym: TrainingSyncing? = null
    // Who the names on this device belong to — the account id, or none for the anonymous seat. The
    // device catalog is keyed on it, so every hold has to say whose copy it is writing.
    private var owner: String? = null
    private val lastTimes = mutableMapOf<String, LastTime>()
    private var retryTask: Job? = null
    // The open session could not be claimed yet — the account's other workout is still running, or
    // the claim never reached the log. While this is true the boot read may not trade the phone's
    // own workout for a different open one, and its owed sets are "saved on this device", not
    // "offline": nothing is wrong with the signal, the log is just not theirs to take yet.
    private var liveUnclaimed = false
    // The claim is mid-replay. While this is true an ordinary start may not go to the log at all:
    // a start JOINS whatever session is open, and mid-replay the open session is a PAST one the
    // claim just reopened — today's first set filed into yesterday's workout, finished at the
    // shelf's stale instant. Starts compose on the device instead, and the claim lands them. The
    // boot read stands down for the same reason: a log read mid-replay would ADOPT that reopened
    // past session as the phone's live workout (see `loadLog`).
    private var claimsRunning = 0
    private val claiming: Boolean get() = claimsRunning > 0
    // A claim was requested while one was already mid-replay — a local finish shelving a fresh
    // session, a connect on a seat change. Runners never overlap: the one running goes once more
    // when its pass ends, over whatever the shelf holds by then, instead of a second replay
    // walking the same shelf and holding a reopened session open under the first one's reads.
    private var claimAgain = false
    // The last claim stopped on a retryable failure and the backlog is still owed. While this is
    // true the deliver cadence re-runs the claim — the same 4s task that carries the owed sets,
    // never a second timer. Only the retryable stops arm it: a WAIT (the account's other workout
    // is open) stays event-driven, because polling a remote human's live session every four
    // seconds is noise and the parked lanes already say "saved on this device".
    private var claimOwed = false

    private companion object {
        // At or under the server's own ceiling: the handler clamps `limit` to 200, and a larger
        // page here would come back short of what was asked for and read as the bottom of the log.
        const val logPage = 50
    }

    // This movement's sets in this session, performed order, warmups included — the whole record of
    // it, which is what the today list draws. What CARRIES FORWARD is narrower: `Prefill` follows
    // the working sets only, because a ramp-up is not what the next set is aimed at.
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

    // Every set still in the queue is saved on this device and nowhere else, whether or not the log
    // has been asked yet. A retry counter cannot decide this — a set that has been attempted zero
    // times is exactly as undelivered as one behind a jam.
    val stalled: Set<String>
        get() = queue.pending.map { it.set.id }.toSet()

    // The mistake seconds ago. The log is append-only and has no route that takes a set back, so
    // this is null the instant the row lands — Undo is offered exactly while it is true, and never
    // as a button that would have to apologise.
    val undoable: TrainingSet?
        get() = queue.withdrawable(at = now())?.set

    // Called on launch and on every change of who is signed in. Draws from the device first and
    // always — a room that waited for a round trip would be a workout that waits.
    suspend fun connect(account: Account) {
        gym = sync(account)
        // THE NAMES GO WITH THE SEAT, and this is where they change hands. A rename is a per-account
        // override, so the copy on this device belongs to the account it was read for: drawing it
        // for the next lifter to hold the phone would put one person's private name on another
        // person's screen — on the first frame, and then indefinitely offline, where this room is
        // built to live. A seat with no copy here draws slugs until its own read lands, which is the
        // honest state: this phone does not know those names yet.
        //
        // The shelf's own movements ride with every seat, because a movement this device minted is
        // nobody's until a claim lands it: signed out it is the whole catalog there is, and signed
        // in offline it is what keeps the logger from drawing a slug at 28sp over the lifter's own
        // lift. Held straight back, which wipes the last seat's names off the disk as well as off
        // the screen — for the same seat it is the no-op it looks like.
        owner = account.user?.id
        catalog = deviceCatalog.movements(owner).let { held ->
            held + localLog.exercises.filter { mine -> held.none { it.id == mine.id } }
        }
        deviceCatalog.hold(owner, catalog)
        // Who is signed in decides which shelf answers "what did I do last time", so the cache
        // dies with the seat — the movement in hand is re-asked at the end of connect, and the
        // log's answer replaces the one the nobody pass computed off the device.
        lastTimes.clear()
        // The pages go with the seat, and this is the ONE place they do: `loadLog` keeps whatever
        // walk is under a thumb, which it may only do while every row it keeps belongs to the
        // account now asking. Rows read for somebody else are not this lifter's log.
        logged = emptyList()
        older = Older.More
        // A crash between finishOnDevice's hold and the queue's forget leaves one workout both
        // finished on the shelf and live in the queue. The shelf's copy is the finish that
        // happened, so the queue lets go — after its sets, which are the same lift, merge into
        // the shelf's row so converging costs nothing.
        queue.session?.let { live ->
            val shelved = localLog.detail(live.id)
            if (shelved != null) {
                localLog.hold(LocalLog.FinishedSession(shelved.session, queue.sets(live.id)))
                queue.forget(live.id)
                queue.flush()
            }
        }
        drawFromQueue()
        isLoading = false

        val log = gym
        if (log == null) {
            // Signed out the shelf is the log: routines and history are the device's own, and
            // nothing here is pending against a server nobody named. It is also the WHOLE log, so
            // the foot is already at the bottom — there is no page behind it to ask for.
            liveUnclaimed = false
            claimOwed = false
            routines = localLog.routines
            logged = emptyList()
            shelved = localLog.summaries()
            older = Older.End
            saveState = if (queue.pending.isEmpty()) SaveState.Idle else SaveState.OnThisDevice
            resume()
            return
        }
        // THE CLAIM, before anything else touches the wire: movements → routines → finished local
        // sessions oldest-first (start → sets → finish, each) → the live session's own start. What
        // was made signed out becomes the account's, and a loss is SAID through the same banner a
        // refused set uses. Local history is drawn immediately so an offline boot still shows it.
        shelved = localLog.summaries()
        runClaim()
        // The queue goes out BEFORE the first read, and it is not an optimisation: reading the log
        // SETTLES a stale open session, and a set that arrives after that close is refused forever.
        // Logged in a basement last night, opened in the morning — the app's own boot read is what
        // would destroy them.
        //
        // Forced, because nothing survives a relaunch to undo: the row is gone from the screen and
        // the window would be protecting a gesture nobody can still make.
        deliver(force = true)
        coroutineScope {
            launch { loadLog() }
            // Held on the device as well as in memory: the ids are the truth and the names are
            // display strings, so the next cold launch draws `Bench Press` from here rather than
            // the slug. What the claim could not land yet rides along so no name goes missing.
            launch {
                tried { log.exercises() }?.let { known ->
                    catalog = known + localLog.exercises.filter { mine -> known.none { it.id == mine.id } }
                    deviceCatalog.hold(owner, catalog)
                }
            }
            launch { tried { log.routines() }?.let { routines = it + localLog.routines } }
        }
        resume()
    }

    // Start. Signed in the session opens on the log — the plan snapshot is FROZEN BY THE SERVER
    // off the routine's own row, because a client-composed copy would freeze whatever that client
    // last read. Signed out the same rule runs against the only shelf there is: the session is
    // composed here, its plan frozen off the LOCAL routine's row at this instant.
    suspend fun start(routineId: String? = null): GymResult<Session> {
        val log = gym ?: return startOnDevice(routineId)
        // Two starts the log cannot honestly take, even signed in. Mid-claim, a server start
        // would default-JOIN the past session the replay has open — so it may never go out. And a
        // routine still on the shelf is a plan the account cannot resolve — a start naming it is
        // a deterministic 404, while the plan itself is right here. Both compose on the device:
        // the session opens liveUnclaimed and the claim carries it exactly as a signed-out one.
        if (claiming || routineId?.let { localLog.routine(it) } != null) return startOnDevice(routineId)
        // One id collision is a coincidence and a fresh id lands. Two is a device that cannot mint,
        // and looping on it would hammer the log rather than say so.
        var collision: WriteFailure = WriteFailure.NoAnswer
        repeat(2) {
            val id = mintSession()
            try {
                val opened = log.startSession(SessionStart(id = id, startedAt = now(), routineId = routineId))
                // A start JOINS whatever session is already open, so the id that comes back is the
                // truth and may not be the one that went out. Pressing Start cannot re-plan a
                // workout that is already running: the snapshot that comes back is that session's
                // own.
                adopt(opened, joined = opened.id != id)
                val live = session ?: return GymResult.Failed(WriteFailure.NoAnswer)
                return GymResult.Ok(live)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: WindmillApiException) {
                // Only a spent session id is worth a second attempt. Every other refusal is a fact
                // about the routine or the account and it is REPEATED rather than swallowed: a 404
                // for a routine deleted from the web must not read as a phone with no signal.
                val spent = refusing is WindmillApiException.Refused && refusing.status == 409 &&
                    refusing.refusal.code == "session-id-taken"
                if (!spent) return GymResult.Failed(WriteFailure(refusing))
                collision = WriteFailure(refusing)
            } catch (failed: Exception) {
                return GymResult.Failed(WriteFailure.NoAnswer)
            }
        }
        return GymResult.Failed(collision)
    }

    // The on-device start — signed out always, and signed in whenever the log cannot honestly
    // take a start. One workout is open on this device at a time, exactly as one is open per
    // account — starting over a live one joins it, which is what the log would answer too.
    // Signed in the plan freezes off the shelf routine if it is here; a mid-claim start naming a
    // server routine keeps the id and lands its plan when the claim's start does.
    private suspend fun startOnDevice(routineId: String?): GymResult<Session> {
        queue.session?.let { return GymResult.Ok(it) }
        val routine = routineId?.let { localLog.routine(it) }
        if (routineId != null && routine == null && gym == null) {
            return GymResult.Failed(WriteFailure.Refused("that routine is not on this device"))
        }
        val opened = Session(id = mintSession(), startedAtMs = now(), routineId = routineId,
            plan = routine?.let { PlanSnapshot(it) })
        queue.hold(opened)
        queue.flush()
        // Not the log's yet, by definition — signed in, the claim is what lands it, and until
        // then its sets are parked with it on purpose.
        liveUnclaimed = true
        drawFromQueue()
        return GymResult.Ok(opened)
    }

    // The movement in hand, and the number in front of the lifter before they touch anything. The
    // answer is kept for as long as the session lasts: within one workout the same three or four
    // movements are walked repeatedly and none of their answers can change, because a last time is
    // a FINISHED session and today's is not one yet.
    suspend fun choose(movement: String) {
        // Choosing a movement is what puts it in the session — appending is a rest-time action, and
        // the row it makes reads "no sets yet — logging one starts it" until the first one lands.
        queue.append(movement)
        queue.flush()
        order = queue.order
        exerciseId = movement
        lastTime = lastTimes[movement]
        lastTimeFailed = false
        redial()

        // Signed out the answer comes off the device's own history — the same question against a
        // different shelf, and "no history" is a first time here, never a failed read.
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
        // The movement is echoed back for exactly this: a reply for a movement the lifter has
        // already left is dropped, which leaves the card still reading rather than claiming a
        // history the log never denied.
        if (answer.exerciseId != movement || exerciseId != movement) return
        lastTimes[movement] = answer
        lastTime = answer
        redial()
    }

    // Local-first: the row lands and the device holds it before the network is consulted at all.
    //
    // THE KIND IS THE CALLER'S, and it is the one thing about a set that cannot be repaired later:
    // the record rules read `kind == working` and the prefill read exists precisely to exclude
    // warmups, so a ramp-up filed as working becomes the mark to beat and answers "what did I do
    // last time" with a lie, in the product's single highest-value pixel.
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

    // Taking back the set just logged, while this device is still the only place it exists. It
    // answers false rather than pretending once the log holds the row, because the wire has no
    // route that deletes a set and a screen that removed it anyway would be showing a workout the
    // account disagrees with.
    fun undoLast(): Boolean {
        val set = undoable ?: return false
        if (!queue.withdraw(set.id)) return false
        queue.flush()
        drawFromQueue()
        return true
    }

    // Drain on the way out. This is called on leaving the room AS WELL AS on a lifecycle change,
    // and the second door is the one journal does not have: leaving a room tears its subtree down
    // and lets go of the store, so a retry that was still pending never fires. Journal pays for
    // that with a dropped keystroke; gym would pay for it with a set that is refused forever once
    // the session finishes.
    //
    // Pocketing the phone is not a reason to break the undo window — the row is still on screen
    // when it comes back out. LEAVING the room is: the affordance goes with the subtree, so the
    // window is over whether or not its nine seconds are.
    suspend fun flushPendingSets(force: Boolean = false) {
        deliver(force = force)
    }

    // Finishing waits for THIS session's sets to land: a session that closed before a set reached
    // it refuses that set forever, so Finish only completes when there is nothing left to lose. A
    // set stranded against some other session — one that closed under it, one from a sign-in that
    // has since ended — is not this session's business and can never stop it closing.
    //
    // A session the log does not hold — signed out, or opened locally and not yet claimed — closes
    // on the device instead: it moves whole onto the shelf, and the claim carries it later.
    suspend fun finish(): FinishOutcome {
        val live = session ?: return FinishOutcome.NoAnswer
        val log = gym
        if (log == null || liveUnclaimed) return finishOnDevice(live)
        isFinishing = true
        try {
            // Forced: finishing is this device's statement that everything the session holds is
            // already delivered, and a set still inside its window would be left behind by a walk
            // that skipped it and then refused forever by the close.
            deliver(force = true)

            val stranded = queue.owed(live.id).size
            if (stranded > 0) return FinishOutcome.Stranded(stranded)
            val closed = tried { log.finishSession(live.id, now()) } ?: return FinishOutcome.NoAnswer

            queue.close(live.id)
            queue.flush()
            // The session that just closed is the next last time for every movement in it, so
            // nothing that was true a minute ago is true now.
            lastTimes.clear()
            exerciseId = null
            lastTime = null
            drawFromQueue()
            loadLog()
            return FinishOutcome.Closed(closed)
        } finally {
            isFinishing = false
        }
    }

    // The close with no round trip in it: every set the session holds is already on the device, so
    // the session and its sets move WHOLE onto the shelf and the queue lets go of both — the shelf
    // is the single owner of a finished local session, or the claim would send its sets twice.
    private suspend fun finishOnDevice(live: Session): FinishOutcome {
        val performed = queue.sets(live.id)
        val closed = live.copy(finishedAtMs = now())
        localLog.hold(LocalLog.FinishedSession(closed, performed))
        queue.forget(live.id)
        queue.flush()
        liveUnclaimed = false
        lastTimes.clear()
        exerciseId = null
        lastTime = null
        drawFromQueue()
        shelved = localLog.summaries()
        // Signed in, the shelf does not wait for a relaunch: the claim runs now — or, if a replay
        // is already mid-flight, is marked to run again the moment that pass ends — and once the
        // log is ready the session lands. A start tapped while it runs composes on the device
        // (see `claiming`), and the unclaimed flag is recomputed off the outcome exactly as
        // connect's is.
        if (gym != null) {
            runClaim()
            deliver()
            loadLog()
        }
        return FinishOutcome.Closed(closed)
    }

    // The one destructive action in the product, and it is offered only at the finish screen: the
    // log refuses to delete a session somebody may still be logging into, because only the device
    // holding the queue knows every set landed. A session only the shelf holds is the device's to
    // delete without asking anyone.
    suspend fun discard(sessionId: String): Boolean {
        if (localLog.detail(sessionId) != null) {
            localLog.forget(sessionId)
            queue.forget(sessionId)
            queue.flush()
            drawFromQueue()
            shelved = localLog.summaries()
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

    // "Keep this as a routine" (screen 3) — composed from the session's own sets, in the order they
    // were performed, with the weights actually used as next week's targets. Nothing is created
    // until the tap; declining costs nothing and the offer returns next session. The carrier
    // session exists because RoutineWrite.from reads a SessionDetail; only the sets are read, and
    // nothing of the carrier is sent or shown.
    suspend fun keep(sets: List<TrainingSet>, asRoutineNamed: String): Routine? {
        val carrier = SessionDetail(Session(id = "ses_kept", startedAtMs = now()), sets)
        val write = RoutineWrite.from(asRoutineNamed, carrier, position = routines.size) ?: return null
        val log = gym
        if (log == null) {
            // Kept on the shelf under its rt_ id — the claim sends this same document later, so
            // what the lifter named today is what the account receives.
            val made = Routine(write)
            localLog.hold(made)
            routines = localLog.routines
            return made
        }
        val saved = tried { log.createRoutine(write) } ?: return null
        routines = routines + saved
        return saved
    }

    // The mid-session change offer, applied (screen 8). The server never infers this, never
    // auto-writes it and never asks — and the READ is not optional: a routine PUT is a
    // whole-document replace, so writing from a copy this device last read would delete every line
    // added since.
    //
    // It answers with WHAT WENT WRONG rather than with a bool nobody reads. This is the write that
    // moves next week's target, and a sheet that closed identically either way would leave the
    // lifter believing their program had changed.
    suspend fun save(weightKg: Double, toRoutine: String, forExercise: String): WriteFailure? {
        // A routine still on the shelf is the device's to move — signed out always, and signed in
        // while its claim has not landed yet. The claim carries the retargeted document.
        localLog.routine(toRoutine)?.let { mine ->
            localLog.hold(mine.retargeting(forExercise, toWeightKg = weightKg))
            routines = if (gym == null) localLog.routines
                else routines.map { if (it.id == toRoutine) localLog.routine(toRoutine)!! else it }
            return null
        }
        val log = gym ?: return WriteFailure.Refused("that routine is not on this device")
        return try {
            // Absent and another account's are the same 404, folded into null by GymHttp — so
            // there is no sentence from the log to repeat, and this is the plain fact instead.
            val routine = log.routine(toRoutine)
                ?: return WriteFailure.Refused("that routine is no longer on the log")
            val write = RoutineWrite(routine.retargeting(forExercise, toWeightKg = weightKg))
            val saved = log.replaceRoutine(toRoutine, write)
            routines = routines.map { if (it.id == saved.id) saved else it }
            null
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (error: Exception) {
            WriteFailure(error)
        }
    }

    // A movement the catalog has never heard of, minted from the picker's `Create "{query}"`. The
    // picker asks for a name and nothing else, so the classification is the domain's own value for
    // "unknown" rather than a guess dressed as a fact — and nothing on this surface reads it,
    // because the ladder is taken off the MAGNITUDE of the load and never off the equipment.
    suspend fun create(name: String): GymResult<Exercise> {
        val log = gym
        if (log == null) {
            // Minted on the device — a fresh install signed out has an empty catalog, and a picker
            // that could not create would be a logger that cannot log. The claim carries it onto
            // the account before any set that names it.
            val made = Exercise(id = mintExercise(), name = name, custom = true)
            localLog.hold(made)
            catalog = catalog + made
            deviceCatalog.hold(owner, catalog)
            return GymResult.Ok(made)
        }
        return try {
            val made = log.createExercise(ExerciseWrite(
                id = mintExercise(), name = name, pattern = "isolation", equipment = "barbell"))
            catalog = catalog + made
            deviceCatalog.hold(owner, catalog)
            GymResult.Ok(made)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            GymResult.Failed(WriteFailure(refusing))
        }
    }

    fun clearRefusals() {
        refusals = emptyList()
    }

    // The finish screen's three facts, its one record line and its comparison — computed by the
    // DOMAIN and read here, never re-derived. For a session only the shelf holds the domain runs
    // on the device (Review.of): the three facts and the slight rule, never a record and never a
    // comparison — those need the log's whole history and arrive once the session is claimed.
    suspend fun review(of: String): Review? {
        localLog.detail(of)?.let { return Review.of(it) }
        val log = gym ?: return null
        return tried { log.review(of) }
    }

    // One finished session and its sets, read back — off the shelf when only the shelf holds it,
    // otherwise off the log. Absent and another account's are the same 404, folded into the type
    // by GymHttp — so there is no sentence from the log to repeat, and this is the plain fact
    // instead, exactly as the routine read one screen down says it. Signed out, a session the
    // shelf does not hold is the account's — the sentence says so rather than blaming a signal
    // nobody used.
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

    // ONE PAGE DEEPER, and the foot's only move. It doubles as the retry for a first page that
    // failed: the cursor is the oldest row the LOG sent, and with no rows from the log at all that
    // cursor is absent, which is the top of the log — so a retry after a failed boot read asks the
    // same question the boot read asked rather than needing a second verb.
    //
    // The cursor is BOTH halves of the sort key: two sessions can share an instant, and an instant
    // alone would repeat one across the page edge or skip it. Signed out there is nothing to ask —
    // the shelf is the whole log and connect has already said so.
    suspend fun loadOlder() {
        if (older == Older.Loading || older == Older.End) return
        val log = gym ?: return
        val oldest = logged.lastOrNull()
        older = Older.Loading
        val page = tried { log.sessions(limit = logPage, before = oldest?.startedAtMs, beforeId = oldest?.id) }
        if (page == null) {
            older = Older.Failed
            return
        }
        logged = logged + page.filter { fresh -> logged.none { it.id == fresh.id } }
        older = if (page.size < logPage) Older.End else Older.More
    }

    // ONE MOVEMENT READ WHOLE. Nothing is held: the store keeps no copy to invalidate, so there is
    // no cache key here to get wrong — the banked lesson from Lift's progress tab, whose cache was
    // keyed on the number of sessions and went stale the day one was edited rather than added.
    //
    // It answers with a REASON and not with null, for the reason every write in this store does: a
    // log that refused with a sentence is not a log that went quiet, and a screen collapsing the
    // two points the lifter at their signal when the answer was on the server. Signed out the
    // domain runs over the shelf's own finished sessions instead — same rules, no estimator.
    //
    // SIGNED IN, THE LOG'S ANSWER STANDS ALONE and the shelf is not merged into it, exactly as the
    // account's log page is not: a count that included unclaimed sessions beside a best e1RM that
    // could not would be one aggregate telling two stories. The claim empties the shelf, and the
    // log's hollow ring is where a device-only row is named.
    suspend fun record(exerciseId: String): GymResult<MovementRecord> {
        val log = gym
        if (log == null) {
            val movement = catalog.firstOrNull { it.id == exerciseId }
                ?: return GymResult.Failed(WriteFailure.Refused("that movement is not on this device"))
            return GymResult.Ok(MovementRecord.of(movement, localLog.details(), routines))
        }
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

    // THE RENAME, and the identity it exists to prove: the id never moves, so every set, routine
    // line and frozen plan snapshot still points at the same movement afterwards. It answers with
    // THE MOVEMENT AS IT NOW STANDS, or with what went wrong — never with a bool nobody can act on.
    // This is the write that changes a name on every screen at once, and a field that closed
    // identically either way would leave the lifter believing the catalog had changed.
    //
    // The movement it answers with is the one the log CONFIRMED and never the string that went out,
    // so a page drawing it is drawing what was stored rather than what was typed.
    //
    // A movement still on the shelf is the device's to rename — signed out always, and signed in
    // while its claim has not landed — because the claim sends the name it finds. Anything else is
    // the log's: a movement the caller created renames in place, a seeded one gets a per-account
    // override, and neither is a shelf this phone could hold.
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
        // Into the catalog every other screen reads and onto the disk the next cold launch draws
        // from — or the record page would be right and the routine card behind it would still be
        // printing the old name until the next connect. Held under the seat that renamed it: the
        // override belongs to this account and to no other lifter holding this phone.
        catalog = catalog.map { if (it.id == renamed.id) renamed else it }
        deviceCatalog.hold(owner, catalog)
        return GymResult.Ok(renamed)
    }

    // The coach share, minted and revoked. Both answer with WHAT WENT WRONG rather than with a bool
    // nobody can act on: a link that was not made and a link that is still live after a failed
    // revoke are the two facts a lifter has to be told, in the log's own words where it sent any.
    // Signed out the sentence is about the account, not the signal — the share is one of the
    // things signing in ADDS, and "the log didn't answer" would point at the wrong thing.
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

    // THE WALK. One pass over what is owed, per (session, movement) lane, so a set that cannot land
    // holds up its own lane and nothing else — a jam that stopped the whole queue would stop a
    // whole workout, silently.
    private suspend fun deliver(force: Boolean = false) {
        retryTask?.cancel()
        retryTask = null
        if (queue.pending.isEmpty()) {
            // An owed claim keeps the cadence armed even with no set to walk: the shelf's
            // finished sessions are backlog too, and nothing else would carry them before the
            // next connect.
            if (claimOwed) scheduleDeliver(afterMs = retryAfterMs)
            return
        }
        val log = gym
        if (log == null) {
            settle(SaveState.OnThisDevice)
            return
        }

        // Sets of an UNCLAIMED session are parked, not walked: the log has never heard of their
        // session, so every send would 404 — the claim's start is what opens their road, and
        // until it lands they are saved on this device on purpose.
        val parked = if (liveUnclaimed) queue.session?.id else null
        val blocked = mutableSetOf<SetQueue.Lane>()
        parked?.let { held -> blocked.addAll(queue.owed(held).map { it.lane }) }
        var refusal: String? = null
        while (true) {
            val owed = queue.nextOwed(skipping = blocked, readyAt = if (force) null else now()) ?: break
            try {
                val stored = log.appendSet(owed.sessionId, SetWrite(owed.set))
                queue.delivered(stored, owed.set.id, owed.sessionId)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                val verdict = Verdict.refusing(RefusalFacts(refusing))
                val reason = verdict.terminalReason(afterRemints = owed.remints)
                if (reason != null) {
                    // Removed and SAID, never swallowed. This is the only copy left of a set
                    // somebody lifted, and a queue that dropped it quietly would count the loss as
                    // intended.
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
            }
        }

        queue.flush()
        drawFromQueue()

        // WHAT IS STILL OWED IS OWED WHATEVER ELSE THE WALK MET. The next attempt is scheduled off
        // the queue before anything is said, because a refusal in one lane must not take the retry
        // away from a set merely jammed in another: nothing else carries that one, and returning at
        // the refusal left it on the device with no task at all until the next tap. Parked sets
        // are not carried by the WALK at all — the claim is their road — so they schedule
        // nothing and read "saved on this device", which is exactly where they are; while the
        // claim itself is still owed retryably, the same task stays armed to re-run it.
        val carried = queue.pending.filter { it.sessionId != parked }
        val earliestReady = carried.minOfOrNull { it.heldUntilMs ?: 0 }
        if (earliestReady == null) {
            if (claimOwed) scheduleDeliver(afterMs = retryAfterMs)
            if (refusal != null) {
                settle(SaveState.Refused(refusal))
                return
            }
            settle(if (queue.pending.isEmpty()) SaveState.OnTheLog else SaveState.OnThisDevice)
            return
        }
        // A set the walk never offered is not a set that failed. Everything owed being inside its
        // own undo window means this device is holding them ON PURPOSE, so the next walk is the one
        // that opens — and saying "offline" over a send nobody has attempted would put the wrong
        // word under a healthy connection.
        val waiting = earliestReady - now()
        scheduleDeliver(afterMs = if (waiting > 0) waiting else retryAfterMs)
        if (refusal != null) {
            settle(SaveState.Refused(refusal))
            return
        }
        if (waiting <= 0) settle(SaveState.Offline)
    }

    // A set that did not land is not a lost set — it is on the device, still owed, and this carries
    // it: the retry after a failure, the send after a window closes, and the claim's own re-run
    // when its last pass stopped retryably. The task dies with the scope, which is why leaving
    // the room flushes rather than trusting it.
    private fun scheduleDeliver(afterMs: Long) {
        retryTask?.cancel()
        retryTask = scope.launch {
            delay(afterMs)
            // Let go of the handle BEFORE the walk. `deliver` cancels whatever send is pending,
            // and a walk still holding its own task would cancel itself — so every send inside it
            // would fail as a cancellation and schedule another walk that did exactly the same
            // thing.
            retryTask = null
            if (reclaimed()) return@launch
            deliver()
        }
    }

    // THE CLAIM, one door for every runner — sign-in, a local finish, the cadence's retry — and
    // never two abreast: a request landing while a replay is mid-flight marks the claim owed
    // again, and the running pass goes once more when it ends. Overlapped runners walked the same
    // shelf twice, and one's ending fired the boot read while the other still held a reopened
    // past session open on the log. What a pass said is repeated out loud, and how it ended
    // decides what carries the rest: a retryable stop leaves the claim owed to the deliver task,
    // a WAIT and a terminal refusal wait for the next connect. A pass that outlived its seat —
    // the account changed while it was parked on a slow call — settles nothing: that seat's own
    // connect owns the state now, and the marked re-run picks up the fresh seat.
    private suspend fun runClaim() {
        claimAgain = true
        if (claiming) return
        claimsRunning += 1
        try {
            while (claimAgain) {
                claimAgain = false
                val seat = gym ?: return
                val outcome = ClaimReplay(seat, localLog, queue, mintExercise, mintRoutine, mintSession, mintSet).run()
                if (gym !== seat) continue
                refusals = refusals + outcome.said
                liveUnclaimed = queue.session != null && !outcome.liveLanded
                claimOwed = outcome.retryable
            }
        } finally {
            claimsRunning -= 1
        }
    }

    // The cadence's half of the claim. `claiming` holds while it runs, so a start tapped during a
    // scheduled re-claim still composes on the device; the walk follows the claim exactly as
    // connect's does — the queue goes out before any read — and a claim that stopped being owed
    // re-reads the log, so what landed reaches Today without a remount.
    private suspend fun reclaimed(): Boolean {
        if (!claimOwed || claiming || gym == null) return false
        runClaim()
        deliver()
        if (!claimOwed) loadLog()
        return true
    }

    private suspend fun loadLog() {
        // Never mid-claim, and checked again across the await: the open session a mid-replay log
        // answers with may be a PAST one the claim just reopened, and adopting it would resurrect
        // a finished workout as the phone's live one. Whoever ends the claim reads again
        // (`reclaimed`, `finishOnDevice`, connect), so a skipped read still lands.
        if (claiming) return
        val log = gym ?: return
        val page = tried { log.sessions(limit = logPage, before = null, beforeId = null) }
        if (page == null) {
            // The log went quiet, and the foot is where that is said — the rows already in hand
            // stay, because they are real sessions and worth reading.
            older = Older.Failed
            return
        }
        if (claiming) return
        // A RE-READ IS OF THE HEAD, AND IT DOES NOT UNDO A WALK. Not every caller is a moment the
        // lifter is somewhere else: `reclaimed` runs off the delivery cadence's TIMER, so this
        // lands while a thumb is halfway down the log, and a list that replaced itself there would
        // collapse sixty rows back to fifty under it — the foot flipping from `first session · 6
        // May 2026` back to `Load older`, and the row being read sliding behind a page the lifter
        // has to walk for a second time.
        //
        // So the fresh page is authoritative over the span it covers — a session finished, claimed
        // or discarded is inside it — and every row OLDER than its last one survives. The key is
        // the cursor's own, both halves of it, for the reason `loadOlder` states. A change of seat
        // is the one re-read that keeps nothing, and `connect` empties the log itself before it
        // asks, because those rows are another account's.
        val edge = page.lastOrNull()
        val deeper = logged.filter { held ->
            edge != null && (held.startedAtMs < edge.startedAtMs ||
                (held.startedAtMs == edge.startedAtMs && held.id < edge.id))
        }
        logged = page + deeper
        shelved = localLog.summaries()
        // The foot is about the deepest row in hand, so it is recomputed only when this page IS the
        // whole of what is held. Below a walked page the answer is the one that walk arrived at.
        if (deeper.isEmpty()) older = if (page.size < logPage) Older.End else Older.More

        val open = page.firstOrNull { it.session.isOpen }
        if (open == null) {
            // The log holds no open session, so whatever this device was holding is over — a
            // finish from another surface, or the four-hour auto-close. Unless the log never HELD
            // it: a live session the claim has not landed is not the log's to end. The session row
            // goes; a set that is still OWED does not, because a set nobody has answered for has
            // not been refused.
            if (liveUnclaimed) return
            queue.session?.let { queue.close(it.id) }
            queue.flush()
            drawFromQueue()
            return
        }
        // The account's open workout elsewhere may not displace the phone's own unclaimed one —
        // this device's workout is what this device is for, and the claim lands when that closes.
        if (liveUnclaimed && open.session.id != queue.session?.id) return
        adopt(open.session, joined = true)
    }

    private suspend fun adopt(opened: Session, joined: Boolean) {
        queue.hold(opened)
        // A joined session is a list of sets this device may know nothing about — its own from
        // before a relaunch, or a second phone's — and adopting the row without them would draw an
        // empty workout over a live one.
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

    // Landing back inside a workout that never stopped stands where the lifter was — at the
    // movement the last set went into — not in the picker over a session of sets. A movement
    // already in hand is never moved out from under a thumb: it is re-CHOSEN, because connect
    // cleared the last-time cache and re-asking is what swaps the old seat's answer — the shelf's
    // "first time" — for the one this seat's log gives.
    private suspend fun resume() {
        val movement = exerciseId ?: LiveOrder.resume(order, sets) ?: return
        choose(movement)
    }

    private fun drawFromQueue() {
        session = queue.session
        sets = queue.sets
        // The order is seeded from the plan and from what has already been performed, so a session
        // joined from another device — or reopened after a relaunch — walks the movements it really
        // holds rather than the ones this device happened to watch being logged.
        val merged = LiveOrder.merged(held = queue.order, plan = session?.plan, sets = sets)
        if (merged != queue.order) {
            queue.hold(order = merged)
            queue.flush()
        }
        order = merged
        // Counted off the queue and never off `saveState`, so no single word can silence it. A set
        // still inside its own undo window is not stranded — it is being held on purpose, and the
        // strip would otherwise flash for nine seconds after every set on a healthy connection.
        // Signed out nothing is stranded either: there is no log to reach, which is a different
        // fact and has its own word. And a set owed to the phone's own unclaimed session is with
        // that session on purpose too — the claim carries it, not the strip.
        val instant = now()
        strandedCount = if (gym == null) 0 else queue.pending.count {
            !it.isHeld(instant) && !(liveUnclaimed && it.sessionId == session?.id)
        }
        redial()
    }

    private fun redial() {
        prefill = Prefill.of(todaySets, planEntry, lastTime)
    }

    // One write, one beat. The tick is what the note watches, so two sets landing in the same
    // state still read as two saves rather than as one that never faded.
    private fun settle(state: SaveState) {
        saveState = state
        saveTick += 1
    }

    // Kotlin's `try?`, with the one distinction Swift gets for free: a cancellation is not a failed
    // read — it passes through, or a room being torn down would read as a log that went quiet.
    private suspend fun <T> tried(ask: suspend () -> T): T? = try {
        ask()
    } catch (interrupted: CancellationException) {
        throw interrupted
    } catch (failed: Exception) {
        null
    }
}

// The foot of the log, drawn from the paging arithmetic and nothing else. `More` is the offer,
// `End` is a real arrival — the date of the first session ever logged — and `Failed` says what
// failed and offers the one move. There is no fifth state for "empty": a log with no rows has no
// foot, because there is nothing for a foot to sit under.
enum class Older { More, Loading, End, Failed }

sealed interface GymResult<out T> {
    data class Ok<T>(val value: T) : GymResult<T>
    data class Failed(val why: WriteFailure) : GymResult<Nothing>
}

// What a write that did not land can say, and the one distinction that matters: A LOG THAT
// ANSWERED WITH A REASON IS NOT A LOG THAT WENT QUIET. The lifter can act on the first — the
// routine was deleted from the web, the movement id is spent, the session is already over — and
// can only wait out the second. Collapsing both into null pointed them at their signal instead.
sealed interface WriteFailure {
    data class Refused(val said: String) : WriteFailure   // the log answered, in its own words
    data object NoAnswer : WriteFailure                   // no reply, or one this build couldn't read

    // `subject` is what did not happen, in the room's own voice — read only when there is no
    // sentence from the log to say instead.
    fun line(subject: String): String = when (this) {
        is Refused -> said
        NoAnswer -> "the log didn’t answer — $subject"
    }
}

fun WriteFailure(refusing: Throwable): WriteFailure {
    if (refusing !is WindmillApiException.Refused) return WriteFailure.NoAnswer
    return WriteFailure.Refused(refusing.line)
}

sealed interface FinishOutcome {
    data class Closed(val session: Session) : FinishOutcome
    data class Stranded(val count: Int) : FinishOutcome   // this session's sets that never landed — a closed one cannot take them
    data object NoAnswer : FinishOutcome
}
