package works.windmill.gym.store

import java.io.File
import kotlinx.serialization.Serializable
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.TrainingSet

// THE SHELF — everything gym made on this device that no account has claimed yet: locally minted
// movements, local routines, and FINISHED local sessions with their sets. The live session is
// deliberately not here; that is SetQueue's file, and one fact living in one file is what keeps a
// crash from leaving two stores disagreeing about the same workout.
//
// Signed out this shelf IS the log: Today's history, the last-time prefill, statistics and the
// session revisit all read it. On sign-in the claim replay (ClaimReplay) walks it onto the
// account, and a row leaves the shelf only when the server has confirmed holding it — so the shelf
// is always exactly what the account does not yet have, and merging reads is one concatenation.
//
// Same discipline as the queue's file: one atomic JSON file, every field optional so an older
// build's file still opens, and a file this build cannot read opens EMPTY rather than taking the
// history down with it. Written on every mutation — holds and claims are rare (a finish, a keep,
// a claim), not per-tap.
class LocalLog(private val file: File) {
    @Serializable
    data class FinishedSession(val session: Session, val sets: List<TrainingSet> = emptyList())

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
    val routines: List<Routine> get() = held.routines ?: emptyList()
    val finished: List<FinishedSession> get() = held.finished ?: emptyList()

    fun routine(id: String): Routine? = routines.firstOrNull { it.id == id }

    fun detail(sessionId: String): SessionDetail? = finished
        .firstOrNull { it.session.id == sessionId }
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
            routines = routines.map { routine ->
                routine.copy(entries = routine.entries.map {
                    if (it.exerciseId == old) it.copy(exerciseId = fresh) else it
                })
            },
            finished = finished.map { past ->
                FinishedSession(
                    session = remapPlan(past.session, old, fresh),
                    sets = past.sets.map { if (it.exerciseId == old) it.copy(exerciseId = fresh) else it },
                )
            },
        )
        flush()
    }

    // Add or replace by id — the signed-out create AND the signed-out retarget come through here.
    fun hold(routine: Routine) {
        held = held.copy(routines = routines.filterNot { it.id == routine.id } + routine)
        flush()
    }

    fun claimRoutine(id: String) {
        held = held.copy(routines = routines.filterNot { it.id == id })
        flush()
    }

    fun remintRoutine(old: String, fresh: String) {
        held = held.copy(
            routines = routines.map { if (it.id == old) it.copy(id = fresh) else it },
            finished = finished.map { past ->
                if (past.session.routineId != old) past
                else FinishedSession(past.session.copy(routineId = fresh), past.sets)
            },
        )
        flush()
    }

    // Replace by session id, merging sets by id — never a second row. A crash between this hold
    // and the queue's forget leaves the same workout live again on relaunch, and its second
    // finish arrives here carrying everything the first hold did plus whatever was lifted since;
    // converging must not cost either copy a set.
    fun hold(finished: FinishedSession) {
        val standing = this.finished.firstOrNull { it.session.id == finished.session.id }
        val sets = finished.sets + (standing?.sets ?: emptyList())
            .filter { old -> finished.sets.none { it.id == old.id } }
        held = held.copy(finished = this.finished.filterNot { it.session.id == finished.session.id } +
            FinishedSession(finished.session, sets))
        flush()
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
            routines = routines.filterNot { it.id == id },
            finished = finished.map { past ->
                if (past.session.routineId != id) past
                else FinishedSession(past.session.copy(routineId = null), past.sets)
            },
        )
        flush()
    }

    fun remintSession(old: String, fresh: String) {
        held = held.copy(finished = finished.map { past ->
            if (past.session.id != old) past
            else FinishedSession(past.session.copy(id = fresh), past.sets)
        })
        flush()
    }

    fun remintSet(sessionId: String, old: String, fresh: String) {
        held = held.copy(finished = finished.map { past ->
            if (past.session.id != sessionId) past
            else FinishedSession(past.session, past.sets.map { if (it.id == old) it.copy(id = fresh) else it })
        })
        flush()
    }

    // The claim's one loss door: a set the log refused forever leaves the shelf so it is not
    // re-refused on every connect — the RefusedSet the store publishes is its last copy.
    fun dropSet(sessionId: String, setId: String) {
        held = held.copy(finished = finished.map { past ->
            if (past.session.id != sessionId) past
            else FinishedSession(past.session, past.sets.filterNot { it.id == setId })
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
