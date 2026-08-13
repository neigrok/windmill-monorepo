package works.windmill.gym.store

import java.io.File
import kotlinx.serialization.Serializable
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.TrainingSet

// THE SHELF — everything gym made on this device that no account has claimed yet: locally minted
// movements, local routines, and FINISHED local sessions with their sets. The live session is
// deliberately not here; that is SetQueue's file, and one fact living in one file is what keeps a
// crash from leaving two stores disagreeing about the same workout.
//
// Signed out this shelf IS the log: Today's history, the last-time prefill, a movement's record and
// the session revisit all read it. On sign-in the claim replay (ClaimReplay) walks it onto the
// account, and a row leaves the shelf only when the server has confirmed holding it — so the shelf
// is always exactly what the account does not yet have, and merging reads is one concatenation.
//
// It is also where §G18's correction lands for a session no account holds: the fix rewrites the row
// that will be replayed, and a delete leaves a tombstone rather than only a hole, because a claim
// that stopped half way through may already have put part of this session on the log.
//
// Same discipline as the queue's file: one atomic JSON file, every field optional so an older
// build's file still opens, and a file this build cannot read opens EMPTY rather than taking the
// history down with it. Written on every mutation — holds and claims are rare (a finish, a keep,
// a claim), not per-tap.
class LocalLog(private val file: File) {
    @Serializable
    data class FinishedSession(
        val session: Session,
        val sets: List<TrainingSet> = emptyList(),
        // THE TOMBSTONES — sets §G18 deleted off this row, kept by id until the claim has told the
        // account. A shelf session is not always wholly unclaimed: a pass that landed the start and
        // some of the sets and then stopped retryably leaves the row here with part of it already on
        // the log. Dropping a set from `sets` alone would let the next pass replay the survivors and
        // leave the deleted one standing on the account forever — the delete would silently undo
        // itself. Defaulted for the same reason every field here is: a file written before the
        // tombstones existed has no such key, and a file that fails to decode opens EMPTY.
        val deleted: List<String> = emptyList(),
    )

    @Serializable
    private data class Held(
        val exercises: List<Exercise>? = null,
        val routines: List<Routine>? = null,
        val finished: List<FinishedSession>? = null,
    )

    companion object {
        const val fileName = "windmill-gym-local.json"
    }

    private var held: Held = runCatching {
        diskJson.decodeFromString(Held.serializer(), file.readText())
    }.getOrElse { Held() }

    val exercises: List<Exercise> get() = held.exercises ?: emptyList()
    val finished: List<FinishedSession> get() = held.finished ?: emptyList()

    // THE DAY A ROUTINE WAS LAST TRAINED IS DERIVED HERE AND NEVER STORED — the shelf's own version
    // of the aggregate the log computes (`max(started_at)` over the sessions run under it), read off
    // the finished sessions two lines up. Stored, it would have two ways to lie: it would still name
    // a day after that session was discarded, and it would say `never trained` over a workout this
    // same device recorded. Which is exactly what a signed-out routine used to say — and what the
    // word `untested` would have inherited.
    val routines: List<Routine> get() = stored.map { routine ->
        routine.copy(lastTrainedAtMs = finished
            .filter { it.session.routineId == routine.id }
            .maxOfOrNull { it.session.startedAtMs })
    }

    private val stored: List<Routine> get() = held.routines ?: emptyList()

    fun routine(id: String): Routine? = routines.firstOrNull { it.id == id }

    fun row(sessionId: String): FinishedSession? = finished.firstOrNull { it.session.id == sessionId }

    fun detail(sessionId: String): SessionDetail? = row(sessionId)
        ?.let { SessionDetail(it.session, it.sets) }

    fun details(): List<SessionDetail> = finished.map { SessionDetail(it.session, it.sets) }

    // The log's own shape, newest first — what Today draws under "Looking back".
    fun summaries(): List<SessionSummary> = finished
        .sortedByDescending { it.session.startedAtMs }
        .map { SessionSummary(it.session, it.sets) }

    fun hold(exercise: Exercise) {
        held = held.copy(exercises = exercises + exercise)
        flush()
    }

    // The rename of a movement this device minted and no account holds yet. It is the whole of the
    // signed-out rename: a catalog seed's per-lifter name is a row in the ACCOUNT's override table,
    // and the claim creates movements rather than overrides — so a seed renamed here would be a
    // name that silently reverted on the next connect, which is worse than a sentence saying where
    // the door is. Answers null when the shelf does not hold it, and the caller says so.
    fun renameExercise(id: String, name: String): Exercise? {
        val mine = exercises.firstOrNull { it.id == id } ?: return null
        val renamed = mine.copy(name = name)
        held = held.copy(exercises = exercises.map { if (it.id == id) renamed else it })
        flush()
        return renamed
    }

    fun claimExercise(id: String) {
        held = held.copy(exercises = exercises.filterNot { it.id == id })
        flush()
    }

    // A spent movement id changes EVERYWHERE this shelf wrote it — the movement itself, routine
    // lines, frozen plans, and every set — or the claim would land sets against an id the catalog
    // never minted.
    fun remintExercise(old: String, fresh: String) {
        held = held.copy(
            exercises = exercises.map { if (it.id == old) it.copy(id = fresh) else it },
            routines = stored.map { routine ->
                routine.copy(entries = routine.entries.map {
                    if (it.exerciseId == old) it.copy(exerciseId = fresh) else it
                })
            },
            finished = finished.map { past ->
                past.copy(
                    session = remapPlan(past.session, old, fresh),
                    sets = past.sets.map { if (it.exerciseId == old) it.copy(exerciseId = fresh) else it },
                )
            },
        )
        flush()
    }

    // Add or replace by id — the signed-out create, the signed-out retarget and the builder's own
    // save all come through here. The last-trained instant is stripped on the way in for the reason
    // the getter derives it: a derived value written to disk is a second answer waiting to go stale.
    fun hold(routine: Routine) {
        held = held.copy(routines = stored.filterNot { it.id == routine.id } +
            routine.copy(lastTrainedAtMs = null))
        flush()
    }

    fun claimRoutine(id: String) {
        held = held.copy(routines = stored.filterNot { it.id == id })
        flush()
    }

    fun remintRoutine(old: String, fresh: String) {
        held = held.copy(
            routines = stored.map { if (it.id == old) it.copy(id = fresh) else it },
            finished = finished.map { past ->
                if (past.session.routineId != old) past
                else past.copy(session = past.session.copy(routineId = fresh))
            },
        )
        flush()
    }

    // Replace by session id, merging sets by id — never a second row. A crash between this hold
    // and the queue's forget leaves the same workout live again on relaunch, and its second
    // finish arrives here carrying everything the first hold did plus whatever was lifted since;
    // converging must not cost either copy a set.
    fun hold(finished: FinishedSession) {
        val standing = row(finished.session.id)
        // The tombstones survive every re-hold and they filter the merge: the queue's copy of the
        // same workout still carries a set §G18 deleted off this row, and a merge that took it back
        // would resurrect a set the lifter removed.
        val gone = ((standing?.deleted ?: emptyList()) + finished.deleted).distinct()
        val sets = (finished.sets + (standing?.sets ?: emptyList())
            .filter { old -> finished.sets.none { it.id == old.id } })
            .filterNot { it.id in gone }
        held = held.copy(finished = this.finished.filterNot { it.session.id == finished.session.id } +
            FinishedSession(finished.session, sets, gone))
        flush()
    }

    // THE SHELF'S OWN §G18, and the reason a fix on an unclaimed session never touches the wire: the
    // row has not been sent, so a correction rewrites what WILL be sent — no PATCH goes out for an id
    // the log has never seen, and the claim replays the CORRECTED set, never the original and never
    // both. Answers null where the shelf does not hold that set, which is how the caller tells the
    // device's rows from the account's.
    fun fixSet(sessionId: String, setId: String, fix: SetFix): TrainingSet? {
        val standing = row(sessionId)?.sets?.firstOrNull { it.id == setId } ?: return null
        if (!fix.moves(standing)) return standing
        val corrected = fix.corrected(standing)
        held = held.copy(finished = finished.map { past ->
            if (past.session.id != sessionId) past
            else past.copy(sets = past.sets.map { if (it.id == setId) corrected else it })
        })
        flush()
        return corrected
    }

    // The delete's shelf half. The set leaves the row AND is remembered as gone, because part of
    // this session may already be on the account: a claim that landed the start and some of the
    // sets and then stopped retryably leaves the row here with the log already holding it.
    fun deleteSet(sessionId: String, setId: String): Boolean {
        val standing = row(sessionId) ?: return false
        if (standing.sets.none { it.id == setId }) return false
        held = held.copy(finished = finished.map { past ->
            if (past.session.id != sessionId) past
            else past.copy(sets = past.sets.filterNot { it.id == setId },
                           deleted = past.deleted + setId)
        })
        flush()
        return true
    }

    // The row leaves the shelf for both reasons a row can leave a log: claimed onto the account
    // (the server holds it now), or discarded (nobody does).
    fun forget(sessionId: String) {
        held = held.copy(finished = finished.filterNot { it.session.id == sessionId })
        flush()
    }

    // The claim's other let-go: a routine id the log will never resolve — refused outright, or
    // deleted from another surface after it was claimed. The document leaves the shelf if it is
    // still here, and the sessions that named it keep their frozen plan — a snapshot, not a
    // reference — dropping only the id, so they replay ad-hoc rather than being refused.
    fun orphanRoutine(id: String) {
        held = held.copy(
            routines = stored.filterNot { it.id == id },
            finished = finished.map { past ->
                if (past.session.routineId != id) past
                else past.copy(session = past.session.copy(routineId = null))
            },
        )
        flush()
    }

    fun remintSession(old: String, fresh: String) {
        held = held.copy(finished = finished.map { past ->
            if (past.session.id != old) past
            else past.copy(session = past.session.copy(id = fresh))
        })
        flush()
    }

    fun remintSet(sessionId: String, old: String, fresh: String) {
        held = held.copy(finished = finished.map { past ->
            if (past.session.id != sessionId) past
            else past.copy(sets = past.sets.map { if (it.id == old) it.copy(id = fresh) else it })
        })
        flush()
    }

    // The claim's one loss door: a set the log refused forever leaves the shelf so it is not
    // re-refused on every connect — the RefusedSet the store publishes is its last copy. It leaves
    // no tombstone, and that is the difference from `deleteSet`: a set the log never took needs
    // nothing said to the account about it.
    fun dropSet(sessionId: String, setId: String) {
        held = held.copy(finished = finished.map { past ->
            if (past.session.id != sessionId) past
            else past.copy(sets = past.sets.filterNot { it.id == setId })
        })
        flush()
    }

    private fun remapPlan(session: Session, old: String, fresh: String): Session {
        val plan = session.plan ?: return session
        return session.copy(plan = plan.copy(entries = plan.entries.map {
            if (it.exerciseId == old) it.copy(exerciseId = fresh) else it
        }))
    }

    private fun flush() {
        val text = runCatching { diskJson.encodeToString(Held.serializer(), held) }.getOrNull() ?: return
        writeAtomically(file, text)
    }
}
