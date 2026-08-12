package works.windmill.gym.store

import kotlinx.coroutines.CancellationException
import works.windmill.gym.domain.ExerciseWrite
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.Instants
import works.windmill.gym.domain.RoutineWrite
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.SetWrite
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.net.RefusalFacts
import works.windmill.gym.net.TrainingSyncing

// THE CLAIM — how what was made signed out becomes the account's. Runs on sign-in, on every
// connect while the shelf holds a backlog, and again on the deliver loop's own cadence while the
// last pass stopped on a retryable failure; the order is the whole contract (the three-surface
// client convention; the server stays surface-blind):
//
//   movements → routines → finished sessions SEQUENTIALLY, oldest first → the live session's start.
//
// Per finished session, strictly: `start` under the client-minted id with the TRUE startedAt, its
// routineId only if that routine landed, and joinOpenSession FALSE — never default — because a
// replayed past session that silently joined a live workout would file yesterday's sets into
// today's; then ALL its sets in performed order (the server numbers per lane in arrival order, and
// performed order per lane IS that order); then `finish` at the true finishedAt. No log or stats
// read interleaves a session's replay: reading settles a stale open session, and a set arriving
// after that close is refused forever.
//
// Verdicts are by machine code only, exactly as the queue's are: an id another account spent is
// re-minted (and every reference re-pointed); `session-already-open` WAITS — the account's live
// workout closes first, and a later connect resumes; 401/5xx/offline leave everything on the
// shelf and the deliver cadence retries, never dropped. A movement or routine the server refuses outright
// is SAID and let go — the sessions keep their frozen plans and replay ad-hoc — because a
// terminal write re-sent on every connect jams the claim forever behind an answer that cannot
// change; `session-finished` is the set-level loss, and it is SAID. The one 404 a claimed start
// can meet names a routine deleted from another surface since it was claimed: the id is orphaned
// (the plan is a frozen snapshot, not a reference) and the start retries rather than aborting
// the run on a deterministic refusal. Every instant is repaired into the server's
// (0, 253402300799000] bound before it rides.
//
// A row leaves the shelf only when the server confirms holding it — or refuses it forever, and
// then the loss is SAID — and every write is idempotent by its minted id, so a claim that dies
// anywhere resumes from the top and converges: replays answer 200 with the stored row, and only
// what never landed goes out again.
//
// WHAT §G18 CHANGED, and it is the one place mutation reaches this file. A pass that landed the
// start and some sets and then stopped retryably leaves the session on the shelf with part of it
// already on the log — and the lifter can correct or delete those sets before the next pass runs,
// or WHILE it runs, since the shelf's rows are on screen for the whole walk. An append is
// idempotent by id, so a replay of a corrected set answers with the row AS IT WAS LOGGED and the
// correction would silently lose to it. So convergence is no longer "one row per id"; it is THE
// ACCOUNT MATCHES THE SHELF, and it takes two more verbs to say: a reply that disagrees with the
// shelf is corrected, and a set the shelf tombstoned is deleted. Neither costs a round trip in the
// ordinary case — a first append answers with exactly what went out, and a session with nothing
// deleted has nothing to delete.
//
// And it is the SHELF, never a snapshot of it: a finished session is walked in passes that re-read
// the row, and the row is forgotten only by a pass that found nothing left to do. A correction made
// mid-walk is therefore carried by the next pass instead of being thrown away with the row that
// held it.
class ClaimReplay(
    private val log: TrainingSyncing,
    private val localLog: LocalLog,
    private val queue: SetQueue,
    private val mintExercise: () -> String = Ids::exercise,
    private val mintRoutine: () -> String = Ids::routine,
    private val mintSession: () -> String = Ids::session,
    private val mintSet: () -> String = Ids::set,
) {
    // What landed, what was lost, and how the run ended — the store repeats the losses out loud,
    // and `retryable` is true exactly when the stop is one a later pass can change: the store arms
    // the deliver cadence off it, while a WAIT stays event-driven and a terminal refusal was
    // already said and let go.
    data class Outcome(val said: List<RefusedWrite>, val liveLanded: Boolean, val retryable: Boolean)

    // Why a run stopped short of landing everything. WAIT parks the claim until an event frees it
    // — the account's other workout closing, the next connect; RETRY hands it to the deliver
    // cadence; REFUSED is the live start's answer that cannot change, left where it always was.
    private enum class Halt { Wait, Retry, Refused }

    suspend fun run(): Outcome {
        val said = mutableListOf<RefusedWrite>()
        if (!claimExercises(said)) return Outcome(said, liveLanded = false, retryable = true)
        if (!claimRoutines(said)) return Outcome(said, liveLanded = false, retryable = true)
        for (past in localLog.finished.sortedBy { it.session.startedAtMs }) {
            val halted = claimFinished(past, said) ?: continue
            return Outcome(said, liveLanded = false, retryable = halted == Halt.Retry)
        }
        val halted = claimLive() ?: return Outcome(said, liveLanded = true, retryable = false)
        return Outcome(said, liveLanded = false, retryable = halted == Halt.Retry)
    }

    private suspend fun claimExercises(said: MutableList<RefusedWrite>): Boolean {
        for (held in localLog.exercises.toList()) {
            var movement = held
            var remints = 0
            while (true) {
                try {
                    log.createExercise(ExerciseWrite(id = movement.id, name = movement.name,
                        pattern = movement.pattern, equipment = movement.equipment, stepKg = movement.stepKg))
                    localLog.claimExercise(movement.id)
                    break
                } catch (interrupted: CancellationException) {
                    throw interrupted
                } catch (refusing: Exception) {
                    val facts = RefusalFacts(refusing)
                    if (facts.code == "exercise-id-taken" && remints < SetQueue.maxRemints) {
                        val fresh = mintExercise()
                        localLog.remintExercise(movement.id, fresh)
                        queue.remapExercise(movement.id, fresh)
                        queue.flush()
                        movement = movement.copy(id = fresh)
                        remints += 1
                        continue
                    }
                    if (Verdict.refusing(facts) is Verdict.Retry) return false
                    // Refused outright and it never will land as written: SAID and let go, so no
                    // later connect is jammed behind — or re-sends — the same terminal write. Its
                    // sets keep the id and are refused by name when they replay.
                    said += RefusedClaim(movement.name, facts.sentence ?: "the log refused this movement")
                    localLog.claimExercise(movement.id)
                    break
                }
            }
        }
        return true
    }

    private suspend fun claimRoutines(said: MutableList<RefusedWrite>): Boolean {
        for (held in localLog.routines.toList()) {
            var routine = held
            var remints = 0
            while (true) {
                try {
                    log.createRoutine(RoutineWrite(routine))
                    localLog.claimRoutine(routine.id)
                    break
                } catch (interrupted: CancellationException) {
                    throw interrupted
                } catch (refusing: Exception) {
                    val facts = RefusalFacts(refusing)
                    if (facts.code == "routine-id-taken" && remints < SetQueue.maxRemints) {
                        val fresh = mintRoutine()
                        localLog.remintRoutine(routine.id, fresh)
                        queue.session?.takeIf { it.routineId == routine.id }?.let {
                            queue.hold(it.copy(routineId = fresh))
                            queue.flush()
                        }
                        routine = routine.copy(id = fresh)
                        remints += 1
                        continue
                    }
                    if (Verdict.refusing(facts) is Verdict.Retry) return false
                    // The document can never land as written: SAID, then orphaned — the sessions
                    // that named it keep their frozen plan and replay ad-hoc.
                    said += RefusedClaim(routine.name, facts.sentence ?: "the log refused this routine")
                    localLog.orphanRoutine(routine.id)
                    break
                }
            }
        }
        return true
    }

    private suspend fun claimFinished(shelved: LocalLog.FinishedSession, said: MutableList<RefusedWrite>): Halt? {
        // Off the shelf's CURRENT row rather than the loop's snapshot: an earlier session's 404
        // repair may already have orphaned this one's routine id, and a §G18 fix made while the
        // claim was walking an older session is the version this one has to replay.
        var session = (localLog.row(shelved.session.id) ?: shelved).session
        var remints = 0
        while (true) {
            try {
                log.startSession(SessionStart(
                    id = session.id,
                    startedAt = Instants.repaired(session.startedAtMs),
                    routineId = landed(session.routineId),
                    joinOpenSession = false,
                ))
                break
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                val facts = RefusalFacts(refusing)
                if (facts.code == "session-id-taken" && remints < SetQueue.maxRemints) {
                    val fresh = mintSession()
                    localLog.remintSession(session.id, fresh)
                    session = session.copy(id = fresh)
                    remints += 1
                    continue
                }
                // The one 404 a claimed start can meet is a routine the account deleted from
                // another surface since it was claimed. The plan is frozen on the session already
                // — a snapshot, not a reference — so the id that will never resolve is orphaned
                // everywhere the shelf wrote it, and the start retries plain.
                val gone = landed(session.routineId)
                if (facts.status == 404 && gone != null) {
                    localLog.orphanRoutine(gone)
                    session = session.copy(routineId = null)
                    continue
                }
                // `session-already-open` is the WAIT: the account's live workout closes first, and
                // the next connect resumes exactly here — event-driven, never polled. Every other
                // retryable failure goes to the deliver cadence instead.
                if (facts.code == "session-already-open") return Halt.Wait
                if (Verdict.refusing(facts) is Verdict.Retry) return Halt.Retry
                return null
            }
        }

        // THE SESSION IS WALKED UNTIL THE ACCOUNT MATCHES THE SHELF, and this loop is where §G18
        // meets the claim. The shelf's rows are on screen for the WHOLE walk — `connect` publishes
        // them before it starts, and the deliver cadence re-runs this every few seconds while a
        // backlog is owed — so a lifter browsing an offline log can fix or delete one of these sets
        // while the walk is out on the wire. A snapshot taken at the top would send the version
        // they corrected away from and then forget the row that held the repair: the correction
        // would be lost with nothing said, which is the one failure this wave exists to prevent.
        //
        // So every pass RE-READS the row, and the pass that finds nothing left to do is the one
        // that read the shelf after the last gesture. The row is forgotten in the same breath as
        // that read — every write in this room lands on the main dispatcher, and there is no await
        // between the read and the forget for a gesture to slip into.
        //
        // IT ENDS BECAUSE EVERY KIND OF WORK IS SPENT BY DOING IT ONCE: a set moves into `landed`
        // or off the shelf, a tombstone into `toldOf`, a repair the log will never take into
        // `letGo`. Only a new gesture can put work back, and a lifter's thumb is finite. Anything
        // added here that can be found again by the next pass would spin this loop forever.
        val landed = mutableMapOf<String, TrainingSet>()   // what the log is holding, by set id
        val toldOf = mutableSetOf<String>()                // tombstones the log has taken
        val letGo = mutableSetOf<String>()                 // repairs that can never land, already said
        var closed = false
        while (true) {
            val past = localLog.row(session.id) ?: return null   // discarded under us; nothing is owed
            var moved = false

            // The sets, in performed order — the server numbers per lane in arrival order, and
            // performed order per lane IS that order. What the log answers with is kept beside the
            // id, because after a correction the two disagree and the disagreement is the only way
            // this device can find out.
            for (performed in past.sets.sortedBy { it.completedAtMs }) {
                if (performed.id in landed) continue
                var set = performed.copy(completedAtMs = Instants.repaired(performed.completedAtMs))
                var repairs = 0
                moved = true
                while (true) {
                    try {
                        landed[set.id] = log.appendSet(session.id, SetWrite(set))
                        break
                    } catch (interrupted: CancellationException) {
                        throw interrupted
                    } catch (refusing: Exception) {
                        val facts = RefusalFacts(refusing)
                        if (facts.code == "set-id-taken" && repairs < SetQueue.maxRemints) {
                            val fresh = mintSet()
                            localLog.remintSet(session.id, set.id, fresh)
                            set = set.copy(id = fresh)
                            repairs += 1
                            continue
                        }
                        val reason = Verdict.refusing(facts).terminalReason(afterRemints = SetQueue.maxRemints)
                        if (reason == null) return Halt.Retry
                        // Removed and SAID, never swallowed — the banner is the last copy of it.
                        localLog.dropSet(session.id, set.id)
                        said += RefusedSet(set, reason)
                        break
                    }
                }
            }

            // THE CORRECTIONS THIS DEVICE MADE AFTER THE SET HAD ALREADY LANDED — on an earlier
            // pass that stopped short, or on this one while the walk was out on the wire. A first
            // append answers with exactly what went out, so on an ordinary claim this finds nothing
            // and makes no call at all. When it does find one the SHELF wins: it is what the lifter
            // fixed the row to, and the log is holding the version they fixed away from.
            for (mine in past.sets) {
                if (mine.id in letGo) continue
                val stored = landed[mine.id] ?: continue
                val fix = SetFix(mine)
                if (!fix.moves(stored)) continue
                moved = true
                try {
                    val corrected = log.fixSet(session.id, mine.id, fix)
                    landed[mine.id] = corrected
                    // A log that answered with a row still disagreeing with the shelf has taken
                    // this repair as far as it ever will; re-sending it every pass would spin here
                    // forever rather than converge.
                    if (fix.moves(corrected)) letGo += mine.id
                } catch (interrupted: CancellationException) {
                    throw interrupted
                } catch (refusing: Exception) {
                    val verdict = FixVerdict.refusing(RefusalFacts(refusing))
                    if (verdict is FixVerdict.Retry) return Halt.Retry
                    // Neither answer can change, so the repair is let go rather than re-sent on
                    // every pass. `Gone` is nothing to say: another surface deleted the row this
                    // correction was aimed at, and there is no longer anything to correct.
                    // `Unwritable` leaves the account holding the numbers the set was logged with —
                    // so it is SAID, because this is its last copy.
                    letGo += mine.id
                    if (verdict is FixVerdict.Unwritable) {
                        said += RefusedSet(mine, "the log kept the numbers this set was logged with")
                    }
                }
            }

            // ...and the sets it deleted, off the CURRENT row for the same reason. A DELETE is 204
            // for a set that never existed, so a tombstone for one that never reached the log costs
            // a call and nothing else — and the one that DID reach it is the whole reason the
            // tombstone is kept. The route has no terminal refusal at all, so anything that is not
            // a 204 is worth another pass rather than a loss.
            for (gone in past.deleted) {
                if (gone in toldOf) continue
                moved = true
                try {
                    log.deleteSet(session.id, gone)
                    toldOf += gone
                } catch (interrupted: CancellationException) {
                    throw interrupted
                } catch (refusing: Exception) {
                    return Halt.Retry
                }
            }

            // Anything at all happened on the wire: read the shelf again before believing it is
            // settled, because the gesture that arrived during those calls is on the row now.
            if (moved) continue

            if (!closed) {
                val startedAt = Instants.repaired(session.startedAtMs)
                val finishedAt = maxOf(Instants.repaired(session.finishedAtMs ?: startedAt), startedAt)
                try {
                    log.finishSession(session.id, finishedAt)
                } catch (interrupted: CancellationException) {
                    throw interrupted
                } catch (refusing: Exception) {
                    // Refused outright: the sets are on the log and the session stands open there;
                    // the shelf keeps its copy and a later pass closes it (an auto-close on the
                    // server ends the same way — finishing a closed session is the server's own
                    // no-op).
                    if (Verdict.refusing(RefusalFacts(refusing)) is Verdict.Retry) return Halt.Retry
                    return null
                }
                // The close is a round trip too, and a fix made inside it is a fix on a session the
                // account has now closed — which neither route refuses, because a lifter reads the
                // log AFTER the workout, which is when they see the typo.
                closed = true
                continue
            }

            localLog.forget(session.id)
            return null
        }
    }

    // The live session claims the same way minus finish; the queue then owns its sets as today.
    private suspend fun claimLive(): Halt? {
        var live = queue.session ?: return null
        var remints = 0
        while (true) {
            try {
                log.startSession(SessionStart(
                    id = live.id,
                    startedAt = Instants.repaired(live.startedAtMs),
                    routineId = landed(live.routineId),
                    joinOpenSession = false,
                ))
                return null
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                val facts = RefusalFacts(refusing)
                if (facts.code == "session-id-taken" && remints < SetQueue.maxRemints) {
                    val fresh = mintSession()
                    queue.remapSession(live.id, fresh)
                    queue.flush()
                    live = live.copy(id = fresh)
                    remints += 1
                    continue
                }
                // The same deleted-routine 404 the finished starts repair, against the queue's
                // copy: the plan snapshot stays, the id goes, and the start retries plain.
                val gone = landed(live.routineId)
                if (facts.status == 404 && gone != null) {
                    queue.hold(live.copy(routineId = null))
                    queue.flush()
                    live = live.copy(routineId = null)
                    continue
                }
                // Wait, retry and refusal all leave the queue holding the workout — the cadence
                // carries the retry, and the wait and the refusal wait for the next connect.
                if (facts.code == "session-already-open") return Halt.Wait
                if (Verdict.refusing(facts) is Verdict.Retry) return Halt.Retry
                return Halt.Refused
            }
        }
    }

    // A routine still on the shelf is one the account does not have, so a start may not name it —
    // the session lands plain rather than being refused for a reference the log cannot resolve.
    private fun landed(routineId: String?): String? =
        routineId?.takeUnless { id -> localLog.routines.any { it.id == id } }
}
