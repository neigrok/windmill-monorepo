package works.windmill.gym.net

import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.ExerciseWrite
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.LastSet
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.MovementRecord
import works.windmill.gym.domain.Review
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineWrite
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SessionShare
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.SetWrite
import works.windmill.gym.domain.TrainingSet

// What the room needs of the network, and nothing more. TrainingStore depends on this rather than
// on the HTTP client so the offline and refusal paths — the two that decide whether a set somebody
// lifted survives — can be driven in a test without a server, a socket, or a stubbed transport.
// The owner-scoped doors of /v1/gym this room opens; the HTTP twin (GymHttp) lives beside this file.
//
// `GET /v1/gym/stats` is deliberately NOT here, and its absence is a UI deletion rather than an
// engine one: the statistics room was retired in W1c the wave the record page replaced it, and the
// route and the `get_stats` tool both stay — an agent asking "how has my squat moved" is the
// product's own thesis. Nothing on this phone draws that answer any more, so nothing asks for it.
interface TrainingSyncing {
    suspend fun exercises(): List<Exercise>
    suspend fun createExercise(write: ExerciseWrite): Exercise

    // A start JOINS whatever session is already open, so the session that comes back may not be
    // the one that went out — the caller has to compare the ids rather than assume.
    suspend fun startSession(start: SessionStart): Session

    // Converges on exactly one row per minted id: a replay answers 200 with the stored set and its
    // server-assigned number, whether or not the session has since been finished. THE ROW IT
    // ANSWERS WITH MAY BE OLDER THAN THE ONE THAT WENT OUT — a set that landed on an earlier pass
    // and has been corrected on this device since comes back carrying the numbers it was logged
    // with, and the caller has to compare rather than assume (ClaimReplay does).
    suspend fun appendSet(sessionId: String, write: SetWrite): TrainingSet

    // THE CORRECTION AND THE DELETE — §G18, and the only two writes in this product that MOVE a row
    // instead of adding one. Both are owner-scoped and both are idempotent: an identical fix answers
    // the same stored row, and deleting a set that is already gone — or never existed, or belongs to
    // another account — is the same 204, so a lost reply is always safe to send again.
    //
    // A FINISHED SESSION IS NOT A REFUSAL ON EITHER. A lifter reads the log after the workout, which
    // is exactly when they see the typo, so there is no `session-finished` here and no branch for one.
    // A fix that cannot land says which of two things happened by `code`: `set-not-found` (absent,
    // another account's, already deleted, or this account's set in a different workout — one answer,
    // byte-identical for all four) or `fix-unreadable`.
    suspend fun fixSet(sessionId: String, setId: String, fix: SetFix): TrainingSet

    // No 400, no 404 and no 409 at all — 401 and 500 are its only non-204 answers, which is why it
    // answers with nothing rather than with a row or a bool.
    suspend fun deleteSet(sessionId: String, setId: String)

    suspend fun finishSession(sessionId: String, finishedAtMs: Long): Session

    // Discard — the whole session, and the only place a WORKOUT can be destroyed (a single set has
    // its own door two methods down). It refuses a LIVE session 409 `session-open`, because only the
    // device holding the queue knows every set landed, so the finish screen is the only place it is
    // offered.
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

    // THE PICKER'S META, for the whole catalog in one read — the same rule `lastTime` answers for
    // one movement, and the reason there is not one request per row. It is SPARSE: a movement this
    // lifter has never trained has no entry, and that absence IS `never logged`. Nothing sends a
    // zero, so nothing here has to tell a real zero from a missing one.
    //
    // It is a PICKER-OPEN read and never a per-keystroke one: the filter runs over the list already
    // in hand.
    suspend fun lastSets(): List<LastSet>

    suspend fun routines(): List<Routine>

    // The read half of a read-modify-write. Absent and another account's are the same 404, one
    // fact, so the absence folds into the type exactly as a session's does.
    suspend fun routine(id: String): Routine?

    suspend fun createRoutine(write: RoutineWrite): Routine

    // A whole-document replace: the body is the routine as it should now stand, so a
    // read-modify-write that dropped a line would delete it.
    suspend fun replaceRoutine(id: String, write: RoutineWrite): Routine

    suspend fun deleteRoutine(id: String)

    // ONE MOVEMENT READ WHOLE — the page §H is, and the only long-window read this phone makes.
    // Absent and another account's private movement are the same 404, one fact, so the absence
    // folds into the type exactly as a session's does.
    suspend fun record(exerciseId: String): MovementRecord?

    // The rename. A movement the caller created changes in place; a seeded one gets a per-account
    // display override — either way the ID IS UNCHANGED, which is why every set, routine line and
    // frozen plan still points at the same movement afterwards. That is the whole promise the page
    // this is offered on exists to make visible.
    suspend fun renameExercise(exerciseId: String, name: String): Exercise

    // Idempotent on the SESSION and not on a client-minted id — there is no id for a client to
    // mint here, because the token is unguessable and therefore the server's to make. Tapping
    // Share twice answers with the link already live, so a lifter never sends two capabilities to
    // revoke apart.
    suspend fun share(sessionId: String): SessionShare

    // Revoked is deleted: the row IS the capability, so there is nothing to mark and nothing left
    // to describe. Nothing to revoke answers the same 404 an absent session gives.
    suspend fun revokeShare(sessionId: String)

    // §I'S FIVE ROWS, as one account-level document. The read NEVER 404s — a lifter with no row is
    // served the defaults — so it answers with a document rather than folding an absence, and the
    // absence of a row is a fact the client never has to hold.
    suspend fun preferences(): GymPreferences

    // A WHOLE-DOCUMENT REPLACE, exactly as a routine PUT is, and with the same consequence: what
    // goes out is the settings as they should now stand. The one difference is the reason it can be
    // written that way — an OMITTED field takes its DEFAULT here rather than keeping what is
    // stored, which is what makes "off" expressible at all (`restSeconds` absent IS off, and there
    // is no 0 and no false to say it with).
    //
    // The document it answers with is the STORED one and may not be the one that went out: plates
    // come back sorted heaviest-first with duplicates gone. Draw the reply, never the send.
    suspend fun savePreferences(document: GymPreferences): GymPreferences
}
