package works.windmill.gym.store

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import works.windmill.platform.net.WindmillApiException
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.ExerciseWrite
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.Instants
import works.windmill.gym.domain.RoutineWrite
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.SetWrite
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.WeighInWrite
import works.windmill.gym.net.RefusalFacts
import works.windmill.gym.net.TrainingSyncing

// Turns what was made signed out into the account's. Runs on sign-in, on every connect while the
// shelf holds a backlog, and on the deliver cadence while the last pass stopped retryably.
//
// Order: preferences → movements → routines → finished sessions oldest first → the live session's
// start → the weigh-ins, last, once every session has landed. Preferences halt nothing behind them
// and re-arm nothing, so `retryable` means "another pass of the SHELF could change this".
//
// Per finished session, strictly: `start` under the client-minted id with the true startedAt, its
// routineId only if that routine landed, and joinOpenSession FALSE; then its sets in performed
// order; then `finish` at the true finishedAt. No log or stats read may interleave a session's
// replay — a read settles the session stale-closed at its last activity, and from there only a set
// within four hours of that close still lands (the server's `lateSetLands`, which drags the finish
// forward with it); anything past that window is refused for good. The `finish` that follows still
// upgrades the stale close, but it too may only move the end within those four hours, so a session
// stale-closed mid-replay can keep an end earlier than the one this device sent. Every instant is
// repaired into the server's bound before it rides.
//
// A row leaves the shelf only when the server confirms holding it or refuses it forever. Every write
// is idempotent by its minted id, so a claim that dies anywhere resumes from the top, and every pass
// re-reads the shelf row rather than a snapshot.
class ClaimReplay(
    private val log: TrainingSyncing,
    private val localLog: LocalLog,
    private val queue: SetQueue,
    private val preferences: LocalPreferences,
    private val bodyweight: LocalBodyweight,
    private val mintExercise: () -> String = Ids::exercise,
    private val mintRoutine: () -> String = Ids::routine,
    private val mintSession: () -> String = Ids::session,
    private val mintSet: () -> String = Ids::set,
    private val isCurrent: () -> Boolean = { true },
    private val onChange: (Change) -> Unit = {},
    private val bodyweightWrite: Mutex = Mutex(),
    private val preferencesWrite: Mutex = Mutex(),
) {
    sealed interface Change {
        data class SessionMoved(val oldId: String, val session: Session) : Change
        data class SetChanged(val sessionId: String, val oldId: String, val set: TrainingSet?) : Change
        data class Closed(val detail: SessionDetail) : Change
        data class SessionRefused(val sessionId: String, val reason: String) : Change
    }

    class SeatChanged : CancellationException("the account changed during replay")

    private suspend fun <T> exchange(write: suspend () -> T): T {
        if (!isCurrent()) throw SeatChanged()
        try {
            val result = write()
            if (!isCurrent()) throw SeatChanged()
            return result
        } catch (failure: Exception) {
            if (!isCurrent()) throw SeatChanged()
            throw failure
        }
    }

    // `retryable` is true exactly when a later pass could change the stop; the store arms the
    // deliver cadence off it, while a wait stays event-driven. `liveLanded` is a report only.
    data class Outcome(val said: List<RefusedWrite>, val liveLanded: Boolean, val retryable: Boolean)

    // Wait parks the claim until an event frees it; Retry hands it to the deliver cadence; Refused
    // is the live start's answer that cannot change.
    private enum class Halt { Wait, Retry, Refused }

    suspend fun run(): Outcome {
        val said = mutableListOf<RefusedWrite>()
        claimPreferences(said)
        if (!claimExercises(said)) return Outcome(said, liveLanded = false, retryable = true)
        if (!claimRoutines(said)) return Outcome(said, liveLanded = false, retryable = true)
        for (past in localLog.finished.sortedBy { it.session.startedAtMs }) {
            val halted = claimFinished(past, said) ?: continue
            return Outcome(said, liveLanded = false, retryable = halted == Halt.Retry)
        }
        val halted = claimLive(said)
        if (halted != null) return Outcome(said, liveLanded = false, retryable = halted == Halt.Retry)
        return Outcome(said, liveLanded = true, retryable = !claimBodyweight(said))
    }

    // The one step that retries by itself, without the shelf behind it.
    suspend fun runPreferences(): List<RefusedWrite> {
        val said = mutableListOf<RefusedWrite>()
        claimPreferences(said)
        return said
    }

    // A send that could still land leaves the document owed; a refusal that never will is said and
    // let go, or a terminal write re-sent on every connect jams the claim forever.
    private suspend fun claimPreferences(said: MutableList<RefusedWrite>) = preferencesWrite.withLock {
        if (!isCurrent()) throw SeatChanged()
        if (!preferences.owed) return@withLock
        val document = preferences.document
        val revision = preferences.revision
        try {
            val stored = exchange { log.savePreferences(document) }
            if (revision == preferences.revision) preferences.landed(stored)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            if (revision != preferences.revision) return@withLock
            val facts = RefusalFacts(refusing)
            if (Verdict.refusing(facts) is Verdict.Retry) return@withLock
            said += RefusedClaim("preferences", "your gym settings", facts.sentence ?: "the log refused these settings")
            preferences.letGo()
        }
    }

    private suspend fun claimExercises(said: MutableList<RefusedWrite>): Boolean {
        for (held in localLog.exercises.toList()) {
            var movement = held
            var remints = 0
            while (true) {
                try {
                    exchange { log.createExercise(ExerciseWrite(id = movement.id, name = movement.name,
                        pattern = movement.pattern, equipment = movement.equipment, stepKg = movement.stepKg)) }
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
                    // Let go, so no later connect re-sends the same terminal write.
                    said += RefusedClaim(movement.id, movement.name, facts.sentence ?: "the log refused this movement")
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
                    exchange { log.createRoutine(RoutineWrite(routine)) }
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
                    // Orphaned: the sessions that named it keep their frozen plan and replay ad-hoc.
                    said += RefusedClaim(routine.id, routine.name, facts.sentence ?: "the log refused this routine")
                    localLog.orphanRoutine(routine.id)
                    break
                }
            }
        }
        return true
    }

    private fun moveSession(oldId: String, freshId: String): Session? {
        queue.remapSession(oldId, freshId)
        localLog.remintSession(oldId, freshId)
        queue.flush()
        val current = localLog.row(freshId)?.session ?: queue.session?.takeIf { it.id == freshId }
        if (current != null) onChange(Change.SessionMoved(oldId, current))
        return current
    }

    private suspend fun claimFinished(shelved: LocalLog.FinishedSession, said: MutableList<RefusedWrite>): Halt? {
        // Off the shelf's current row, never the loop's snapshot: a fix made mid-walk must replay.
        var session = (localLog.row(shelved.session.id) ?: shelved).session
        var remints = 0
        while (true) {
            try {
                exchange { log.startSession(SessionStart(
                    id = session.id,
                    startedAt = Instants.repaired(session.startedAtMs),
                    routineId = landed(session.routineId),
                    joinOpenSession = false,
                )) }
                break
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                val facts = RefusalFacts(refusing)
                if (facts.code == "session-id-taken" && remints < SetQueue.maxRemints) {
                    val fresh = mintSession()
                    session = moveSession(session.id, fresh) ?: return null
                    remints += 1
                    continue
                }
                // A 404 here is a routine deleted elsewhere: the plan is already frozen on the
                // session, so the unresolvable id is orphaned and the start retries plain.
                val gone = landed(session.routineId)
                if (facts.status == 404 && gone != null) {
                    localLog.orphanRoutine(gone)
                    session = session.copy(routineId = null)
                    continue
                }
                // When the queue holds a session the log has answered for, the account's one open
                // workout is this phone's own: skip this shelf session rather than park behind it.
                if (facts.code == "session-already-open") {
                    if (queue.session != null && !queue.sessionIsUnclaimed) return null
                    return Halt.Wait
                }
                // `clock-ahead` is transient by construction: the instant ages into the past.
                if (facts.code == "clock-ahead") return Halt.Retry
                if (Verdict.refusing(facts) is Verdict.Retry) return Halt.Retry
                val reason = facts.sentence ?: "the log refused this workout"
                said += RefusedClaim(session, reason)
                onChange(Change.SessionRefused(session.id, reason))
                localLog.forget(session.id)
                return null
            }
        }

        // Walked until the account matches the shelf, re-reading the row every pass because a set
        // can be fixed or deleted while the walk is out on the wire.
        //
        // It terminates only because every kind of work is spent by doing it once: a set moves into
        // `landed` or off the shelf, a tombstone into `toldOf`, an unlandable repair into `letGo`.
        // Anything added here that the next pass can find again spins this loop forever.
        val landed = mutableMapOf<String, TrainingSet>()   // what the log is holding, by set id
        val toldOf = mutableSetOf<String>()                // tombstones the log has taken
        val letGo = mutableSetOf<String>()                 // repairs that can never land, already said
        var closed: Session? = null
        while (true) {
            val past = localLog.row(session.id) ?: return null   // discarded under us; nothing is owed
            var moved = false

            // Performed order, because the server numbers per lane in arrival order. What the log
            // answers with is kept beside the id; a disagreement is how this device finds out.
            for (performed in past.sets.sortedBy { it.completedAtMs }) {
                if (performed.id in landed) continue
                var set = performed.copy(completedAtMs = Instants.repaired(performed.completedAtMs))
                var repairs = 0
                moved = true
                while (true) {
                    try {
                        val stored = exchange { log.appendSet(session.id, SetWrite(set)) }
                        localLog.acceptSet(session.id, set, stored)
                        landed[stored.id] = stored
                        onChange(Change.SetChanged(session.id, set.id, stored))
                        break
                    } catch (interrupted: CancellationException) {
                        throw interrupted
                    } catch (refusing: Exception) {
                        val facts = RefusalFacts(refusing)
                        if (facts.code == "set-id-taken" && repairs < SetQueue.maxRemints) {
                            if (localLog.row(session.id)?.sets?.none { it.id == set.id } != false) {
                                onChange(Change.SetChanged(session.id, set.id, null))
                                break
                            }
                            val fresh = mintSet()
                            localLog.remintSet(session.id, set.id, fresh)
                            val old = set.id
                            set = set.copy(id = fresh)
                            onChange(Change.SetChanged(session.id, old, set))
                            repairs += 1
                            continue
                        }
                        // The start answered, so a 404 here is the workout gone from the log.
                        if (facts.status == 404) {
                            said += RefusedClaim(session, "that workout is no longer on the log")
                            onChange(Change.SessionRefused(session.id, "that workout is no longer on the log"))
                            localLog.forget(session.id)
                            return null
                        }
                        val reason = Verdict.refusing(facts).terminalReason(afterRemints = SetQueue.maxRemints)
                        if (reason == null) return Halt.Retry
                        localLog.dropSet(session.id, set.id)
                        onChange(Change.SetChanged(session.id, set.id, null))
                        said += RefusedSet(set, reason)
                        break
                    }
                }
            }

            // Corrections made after the set had already landed. Where one is found the shelf wins.
            for (mine in localLog.row(session.id)?.sets.orEmpty()) {
                if (mine.id in letGo) continue
                val stored = landed[mine.id] ?: continue
                val fix = SetFix(mine)
                if (!fix.moves(stored)) continue
                moved = true
                try {
                    val corrected = exchange { log.fixSet(session.id, mine.id, fix) }
                    landed[mine.id] = corrected
                    localLog.acceptSet(session.id, mine, corrected)
                    onChange(Change.SetChanged(session.id, mine.id, corrected))
                    // A row still disagreeing after the fix has gone as far as it ever will.
                    if (fix.moves(corrected)) letGo += mine.id
                } catch (interrupted: CancellationException) {
                    throw interrupted
                } catch (refusing: Exception) {
                    val verdict = FixVerdict.refusing(RefusalFacts(refusing))
                    if (verdict is FixVerdict.Retry) return Halt.Retry
                    if (verdict is FixVerdict.Gone) {
                        landed.remove(mine.id)
                        localLog.dropSet(session.id, mine.id)
                        onChange(Change.SetChanged(session.id, mine.id, null))
                        continue
                    }
                    letGo += mine.id
                    if (verdict is FixVerdict.Unwritable) {
                        said += RefusedSet(mine, "the log kept the numbers this set was logged with")
                    }
                }
            }

            // DELETE is 204 for a set that never existed, and the route has no terminal refusal, so
            // anything that is not a 204 is worth another pass rather than a loss.
            for (gone in past.deleted) {
                if (gone in toldOf) continue
                moved = true
                try {
                    exchange { log.deleteSet(session.id, gone) }
                    toldOf += gone
                    landed.remove(gone)
                    onChange(Change.SetChanged(session.id, gone, null))
                } catch (interrupted: CancellationException) {
                    throw interrupted
                } catch (refusing: Exception) {
                    return Halt.Retry
                }
            }

            // Anything happened on the wire: read the shelf again before believing it is settled.
            if (moved) continue

            if (closed == null) {
                val startedAt = Instants.repaired(session.startedAtMs)
                val finishedAt = maxOf(Instants.repaired(session.finishedAtMs ?: startedAt), startedAt)
                try {
                    closed = exchange { log.finishSession(session.id, finishedAt) }
                } catch (interrupted: CancellationException) {
                    throw interrupted
                } catch (refusing: Exception) {
                    val facts = RefusalFacts(refusing)
                    if (Verdict.refusing(facts) is Verdict.Retry) return Halt.Retry
                    // A 404 is the workout gone; anything else leaves the session standing open for
                    // the log's own auto-close. Either way the shelf lets go.
                    val reason = if (facts.status == 404) "that workout is no longer on the log"
                        else facts.sentence ?: "the log refused to close this workout"
                    said += RefusedClaim(session, reason)
                    onChange(Change.SessionRefused(session.id, reason))
                    localLog.forget(session.id)
                    return null
                }
                // The close is a round trip too: a fix made inside it targets a now-closed session,
                // which neither correction route refuses.
                continue
            }

            onChange(Change.Closed(SessionDetail(closed, landed.values.sortedBy { it.completedAtMs })))
            localLog.forget(session.id)
            return null
        }
    }

    // The live session claims the same way minus finish; the queue then owns its sets. A session the
    // log already holds is never re-started: a start replay can auto-close it out from under the queue.
    private suspend fun claimLive(said: MutableList<RefusedWrite>): Halt? {
        if (!queue.sessionIsUnclaimed) return null
        var live = queue.session ?: return null
        var remints = 0
        while (true) {
            if (queue.session?.id != live.id && localLog.row(live.id) == null) return null
            try {
                val stored = exchange { log.startSession(SessionStart(
                    id = live.id,
                    startedAt = Instants.repaired(live.startedAtMs),
                    routineId = landed(live.routineId),
                    joinOpenSession = false,
                )) }
                val oldId = live.id
                if (stored.id != oldId) moveSession(oldId, stored.id)
                val shelved = localLog.row(stored.id)
                if (shelved != null) {
                    localLog.acceptSession(stored.id, stored)
                    onChange(Change.SessionMoved(oldId, localLog.row(stored.id)!!.session))
                    return null
                }
                if (queue.session?.id != stored.id) return null
                queue.hold(stored)
                queue.claimed(stored.id)
                queue.flush()
                return null
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                val facts = RefusalFacts(refusing)
                if (facts.code == "session-id-taken" && remints < SetQueue.maxRemints) {
                    live = moveSession(live.id, mintSession()) ?: return null
                    remints += 1
                    continue
                }
                val gone = landed(live.routineId)
                if (facts.status == 404 && gone != null) {
                    localLog.orphanRoutine(gone)
                    live = live.copy(routineId = null)
                    if (queue.session?.id == live.id) queue.hold(live, unclaimed = true)
                    queue.flush()
                    continue
                }
                if (facts.code == "session-already-open") return Halt.Wait
                if (facts.code == "clock-ahead") return Halt.Retry
                if (Verdict.refusing(facts) is Verdict.Retry) return Halt.Retry
                said += RefusedClaim(live, facts.sentence ?: "the log refused to open this workout")
                return Halt.Refused
            }
        }
    }

    // Every write is idempotent by its date and the server keeps the newer of two by `recordedAt`, so
    // a replayed stale write answers with the correction it could not overtake, and `landed` keeps
    // that. A 400 is the one answer that cannot change: said, and the row let go. A delete has no
    // terminal refusal, so anything but a 204 waits for another pass.
    private suspend fun claimBodyweight(said: MutableList<RefusedWrite>): Boolean {
        for (date in bodyweight.owed.map { it.dateLocal }) bodyweightWrite.withLock {
            if (!isCurrent()) throw SeatChanged()
            val owed = bodyweight.owed.firstOrNull { it.dateLocal == date } ?: return@withLock
            val revision = bodyweight.revision(date)
            try {
                val stored = exchange { log.putBodyweight(date, WeighInWrite(owed.weightKg, owed.recordedAt)) }
                if (stored.dateLocal != date) throw WindmillApiException.Malformed
                if (bodyweight.revision(date) == revision) bodyweight.landed(stored)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                if (!isCurrent()) throw SeatChanged()
                val facts = RefusalFacts(refusing)
                if (Verdict.refusing(facts) is Verdict.Retry) return false
                if (bodyweight.revision(date) != revision) return@withLock
                said += RefusedClaim(date, "weigh-in · ${Bodyweight.shortDay(owed.date)}",
                    facts.sentence ?: "the log refused this weigh-in")
                bodyweight.letGo(date)
            }
        }
        for (date in bodyweight.deletions) bodyweightWrite.withLock {
            if (!isCurrent()) throw SeatChanged()
            if (date !in bodyweight.deletions) return@withLock
            val revision = bodyweight.revision(date)
            try {
                exchange { log.deleteBodyweight(date) }
                if (bodyweight.revision(date) == revision) bodyweight.deletionLanded(date)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                if (!isCurrent()) throw SeatChanged()
                return false
            }
        }
        return bodyweight.owed.isEmpty() && bodyweight.deletions.isEmpty()
    }

    // A routine still on the shelf is one the account does not have, so a start may not name it.
    private fun landed(routineId: String?): String? =
        routineId?.takeUnless { id -> localLog.routines.any { it.id == id } }
}
