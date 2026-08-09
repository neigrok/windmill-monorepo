package works.windmill.gym.net

import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.ExerciseWrite
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.Review
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineWrite
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SessionShare
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.SetWrite
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.TrainingStatistics

// What the room needs of the network, and nothing more. TrainingStore depends on this rather than
// on the HTTP client so the offline and refusal paths — the two that decide whether a set somebody
// lifted survives — can be driven in a test without a server, a socket, or a stubbed transport.
// The eighteen owner-scoped doors of /v1/gym; the HTTP twin (GymHttp) lives beside this file.
interface TrainingSyncing {
    suspend fun exercises(): List<Exercise>
    suspend fun createExercise(write: ExerciseWrite): Exercise

    // A start JOINS whatever session is already open, so the session that comes back may not be
    // the one that went out — the caller has to compare the ids rather than assume.
    suspend fun startSession(start: SessionStart): Session

    // Converges on exactly one row per minted id: a replay answers 200 with the stored set and its
    // server-assigned number, whether or not the session has since been finished.
    suspend fun appendSet(sessionId: String, write: SetWrite): TrainingSet

    suspend fun finishSession(sessionId: String, finishedAtMs: Long): Session

    // Discard — the one destructive action in the product. It refuses a LIVE session 409
    // `session-open`, because only the device holding the queue knows every set landed, so the
    // finish screen is the only place it is offered.
    suspend fun discardSession(sessionId: String)

    // A page of the log, newest first. The cursor is BOTH halves of the sort key: two sessions can
    // share an instant, and an instant alone would repeat one across the page edge or skip it.
    suspend fun sessions(limit: Int, before: Long?, beforeId: String?): List<SessionSummary>

    // One session and its sets. Absent and another account's are the same 404, and that is not an
    // error — the caller draws nothing — so the absence is folded into the type rather than thrown.
    suspend fun session(id: String): SessionDetail?

    suspend fun review(sessionId: String): Review

    // The prefill. A movement trained for the first time is answered 200 with the movement and
    // nothing else, so this never folds a 404 — a 404 here would mean the movement does not exist,
    // which is a different and false thing.
    suspend fun lastTime(exerciseId: String): LastTime

    suspend fun routines(): List<Routine>

    // The read half of a read-modify-write. Absent and another account's are the same 404, one
    // fact, so the absence folds into the type exactly as a session's does.
    suspend fun routine(id: String): Routine?

    suspend fun createRoutine(write: RoutineWrite): Routine

    // A whole-document replace: the body is the routine as it should now stand, so a
    // read-modify-write that dropped a line would delete it.
    suspend fun replaceRoutine(id: String, write: RoutineWrite): Routine

    suspend fun deleteRoutine(id: String)

    suspend fun statistics(): TrainingStatistics

    // Idempotent on the SESSION and not on a client-minted id — there is no id for a client to
    // mint here, because the token is unguessable and therefore the server's to make. Tapping
    // Share twice answers with the link already live, so a lifter never sends two capabilities to
    // revoke apart.
    suspend fun share(sessionId: String): SessionShare

    // Revoked is deleted: the row IS the capability, so there is nothing to mark and nothing left
    // to describe. Nothing to revoke answers the same 404 an absent session gives.
    suspend fun revokeShare(sessionId: String)
}
