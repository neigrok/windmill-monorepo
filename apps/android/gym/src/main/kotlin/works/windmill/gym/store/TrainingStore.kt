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
import works.windmill.gym.domain.PlanEntry
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
import works.windmill.gym.domain.TrainingStatistics
import works.windmill.gym.net.GymHttp
import works.windmill.gym.net.RefusalFacts
import works.windmill.gym.net.TrainingSyncing
import works.windmill.platform.Account
import works.windmill.platform.net.WindmillApiException

// The live session, wired — the native twin of web/src/products/gym/logger/useLiveSession.js and of
// the iOS TrainingStore, and the one place in gym where the pure rules meet the network, the clock
// and the disk. Everything it decides it decides by asking a module: the ladder moves the weight,
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
    private val scope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
    private val mintSession: () -> String = Ids::session,
    private val mintSet: () -> String = Ids::set,
    private val undoWindowMs: Long = SetQueue.undoWindowMs,
    private val retryAfterMs: Long = 4_000,
    private val sync: (Account) -> TrainingSyncing? = { if (it.isSignedIn) GymHttp(it.api) else null },
) {
    // The names before the first frame. A movement is a stable id everywhere except on screen, so a
    // store that waited for the catalog read would draw `bench-press` at 28sp in the meantime — in
    // a basement, for a whole session.
    var catalog: List<Exercise> by mutableStateOf(deviceCatalog.movements)
        private set
    var routines: List<Routine> by mutableStateOf(emptyList())
        private set
    var recent: List<SessionSummary> by mutableStateOf(emptyList())      // the log, newest first
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
    var refusals: List<RefusedSet> by mutableStateOf(emptyList())        // sets that never landed
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
    private val lastTimes = mutableMapOf<String, LastTime>()
    private var retryTask: Job? = null

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
        drawFromQueue()
        isLoading = false

        val log = gym
        if (log == null) {
            saveState = if (queue.pending.isEmpty()) SaveState.Idle else SaveState.OnThisDevice
            resume()
            return
        }
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
            // the slug.
            launch {
                tried { log.exercises() }?.let {
                    catalog = it
                    deviceCatalog.hold(it)
                }
            }
            launch { tried { log.routines() }?.let { routines = it } }
        }
        resume()
    }

    // Start. A session cannot be opened without the log, because the plan snapshot is FROZEN BY THE
    // SERVER off the routine's own row — a client-composed copy would freeze whatever that client
    // last read, which is exactly the staleness the snapshot exists to prevent.
    suspend fun start(routineId: String? = null): GymResult<Session> {
        val log = gym ?: return GymResult.Failed(WriteFailure.NoAnswer)
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

        // Signed out there is no log to answer, so the read is not pending — it is over. A card
        // left saying "reading your log…" would be waiting on a request nobody made.
        val log = gym
        if (log == null) {
            lastTimeFailed = lastTime == null
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
    suspend fun finish(): FinishOutcome {
        val log = gym ?: return FinishOutcome.NoAnswer
        val live = session ?: return FinishOutcome.NoAnswer
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

    // The one destructive action in the product, and it is offered only at the finish screen: the
    // log refuses to delete a session somebody may still be logging into, because only the device
    // holding the queue knows every set landed.
    suspend fun discard(sessionId: String): Boolean {
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
        val log = gym ?: return null
        val carrier = SessionDetail(Session(id = "ses_kept", startedAtMs = now()), sets)
        val write = RoutineWrite.from(asRoutineNamed, carrier, position = routines.size) ?: return null
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
        val log = gym ?: return WriteFailure.NoAnswer
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
        val log = gym ?: return GymResult.Failed(WriteFailure.NoAnswer)
        return try {
            val made = log.createExercise(ExerciseWrite(
                id = Ids.exercise(), name = name, pattern = "isolation", equipment = "barbell"))
            catalog = catalog + made
            deviceCatalog.hold(catalog)
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
    // DOMAIN and read here, never re-derived. A second opinion drawn on the phone would be the
    // product arguing with itself in its own loudest pixel.
    suspend fun review(of: String): Review? {
        val log = gym ?: return null
        return tried { log.review(of) }
    }

    // One finished session and its sets, read back. Absent and another account's are the same 404,
    // folded into the type by GymHttp — so there is no sentence from the log to repeat, and this is
    // the plain fact instead, exactly as the routine read one screen down says it.
    suspend fun sessionDetail(sessionId: String): GymResult<SessionDetail> {
        val log = gym ?: return GymResult.Failed(WriteFailure.NoAnswer)
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

    // The statistics read. Nothing is held: the store keeps no copy to invalidate, so there is no
    // cache key here to get wrong — the banked lesson from Lift's progress tab, whose cache was
    // keyed on the number of sessions and went stale the day one was edited rather than added.
    //
    // It answers with a REASON and not with null, for the reason every write in this store does: a
    // log that refused with a sentence is not a log that went quiet, and a screen collapsing the
    // two points the lifter at their signal when the answer was on the server.
    suspend fun statistics(): GymResult<TrainingStatistics> {
        val log = gym ?: return GymResult.Failed(WriteFailure.NoAnswer)
        return try {
            GymResult.Ok(log.statistics())
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            GymResult.Failed(WriteFailure(refusing))
        }
    }

    // The coach share, minted and revoked. Both answer with WHAT WENT WRONG rather than with a bool
    // nobody can act on: a link that was not made and a link that is still live after a failed
    // revoke are the two facts a lifter has to be told, in the log's own words where it sent any.
    suspend fun share(sessionId: String): GymResult<SessionShare> {
        val log = gym ?: return GymResult.Failed(WriteFailure.NoAnswer)
        return try {
            GymResult.Ok(log.share(sessionId))
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            GymResult.Failed(WriteFailure(refusing))
        }
    }

    suspend fun revokeShare(sessionId: String): WriteFailure? {
        val log = gym ?: return WriteFailure.NoAnswer
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
        if (queue.pending.isEmpty()) return
        val log = gym
        if (log == null) {
            settle(SaveState.OnThisDevice)
            return
        }

        val blocked = mutableSetOf<SetQueue.Lane>()
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
        // the refusal left it on the device with no task at all until the next tap.
        val earliestReady = queue.pending.minOfOrNull { it.heldUntilMs ?: 0 }
        if (earliestReady == null) {
            settle(refusal?.let { SaveState.Refused(it) } ?: SaveState.OnTheLog)
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
    // it: the retry after a failure, and the send after a window closes. The task dies with the
    // scope, which is why leaving the room flushes rather than trusting it.
    private fun scheduleDeliver(afterMs: Long) {
        retryTask?.cancel()
        retryTask = scope.launch {
            delay(afterMs)
            // Let go of the handle BEFORE the walk. `deliver` cancels whatever send is pending,
            // and a walk still holding its own task would cancel itself — so every send inside it
            // would fail as a cancellation and schedule another walk that did exactly the same
            // thing.
            retryTask = null
            deliver()
        }
    }

    private suspend fun loadLog() {
        val log = gym ?: return
        val page = tried { log.sessions(limit = logPage, before = null, beforeId = null) } ?: return
        recent = page

        val open = page.firstOrNull { it.session.isOpen }
        if (open == null) {
            // The log holds no open session, so whatever this device was holding is over — a
            // finish from another surface, or the four-hour auto-close. The session row goes; a
            // set that is still OWED does not, because a set nobody has answered for has not been
            // refused.
            queue.session?.let { queue.close(it.id) }
            queue.flush()
            drawFromQueue()
            return
        }
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
    // already in hand is never moved out from under a thumb.
    private suspend fun resume() {
        if (exerciseId != null) return
        val movement = LiveOrder.resume(order, sets) ?: return
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
        // fact and has its own word.
        val instant = now()
        strandedCount = if (gym == null) 0 else queue.pending.count { !it.isHeld(instant) }
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
