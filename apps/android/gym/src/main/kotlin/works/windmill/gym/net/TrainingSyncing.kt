package works.windmill.gym.net

import works.windmill.gym.domain.AskAnswer
import works.windmill.gym.domain.AskQuestion
import works.windmill.gym.domain.AskThread
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.ExerciseWrite
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.LastSet
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.MovementRecord
import works.windmill.gym.domain.Note
import works.windmill.gym.domain.NoteWrite
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.ProposalDecision
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

interface TrainingSyncing {
    suspend fun exercises(): List<Exercise>
    suspend fun createExercise(write: ExerciseWrite): Exercise

    // A start joins whatever session is already open: compare the returned id with the sent one.
    suspend fun startSession(start: SessionStart): Session

    // One row per minted id; a replay answers 200 with the stored set, which may be older than the
    // one sent.
    suspend fun appendSet(sessionId: String, write: SetWrite): TrainingSet

    // Owner-scoped and idempotent: a lost reply is safe to send again.
    suspend fun fixSet(sessionId: String, setId: String, fix: SetFix): TrainingSet

    suspend fun deleteSet(sessionId: String, setId: String)

    suspend fun finishSession(sessionId: String, finishedAtMs: Long): Session

    // Refuses a live session 409.
    suspend fun discardSession(sessionId: String)

    // Newest first. The cursor needs both halves of the sort key: sessions can share an instant.
    suspend fun sessions(limit: Int, before: Long?, beforeId: String?): List<SessionSummary>

    suspend fun session(id: String): SessionDetail?

    suspend fun review(sessionId: String): Review

    suspend fun lastTime(exerciseId: String): LastTime

    // Sparse: a movement never trained has no entry, and that absence means never logged.
    suspend fun lastSets(): List<LastSet>

    suspend fun routines(): List<Routine>

    // The one read carrying a routine's history.
    suspend fun routine(id: String): Routine?

    suspend fun createRoutine(write: RoutineWrite): Routine

    // Whole-document replace: an omitted line is a deleted line.
    suspend fun replaceRoutine(id: String, write: RoutineWrite): Routine

    suspend fun deleteRoutine(id: String)

    // Owner-scoped and 401 with no session: a proposal has no anonymous story and the claim
    // replays none.
    suspend fun proposal(id: String): Proposal?

    // Atomic against the base the diff was written on; a routine that moved first is refused, never
    // merged. The routine comes back with the decision, absent when the proposal removes it.
    suspend fun applyProposal(id: String): ProposalDecision

    suspend fun dismissProposal(id: String): ProposalDecision

    suspend fun record(exerciseId: String): MovementRecord?

    // The id is unchanged.
    suspend fun renameExercise(exerciseId: String, name: String): Exercise

    // Idempotent on the session, not on a client-minted id: sharing twice answers the live link.
    suspend fun share(sessionId: String): SessionShare

    suspend fun revokeShare(sessionId: String)

    suspend fun preferences(): GymPreferences

    // Whole-document replace: an omitted field takes its default, which is how off is expressed
    // (absent `restSeconds` IS off). Draw the reply, never the send.
    suspend fun savePreferences(document: GymPreferences): GymPreferences

    // The thread id is the client's: a fresh one opens a conversation, a spent one continues it.
    suspend fun ask(question: AskQuestion): AskAnswer

    // Carries no turns; the detail read adds them. Newest question first.
    suspend fun threads(): List<AskThread>

    suspend fun thread(id: String): AskThread?

    suspend fun deleteThread(id: String)

    // In precedence order, ten at most. Account-only: nothing on this phone keeps a copy.
    suspend fun notes(): List<Note>

    // Upsert by the client-minted id: a new id lands last, a spent id edits. Past ten notes or past
    // the title and body bounds the log refuses in its own words, and the screen shows those.
    suspend fun writeNote(id: String, write: NoteWrite): Note

    // 204 for a note that is already gone.
    suspend fun deleteNote(id: String)

    // Whole-order replace, naming every note of the account exactly once.
    suspend fun reorderNotes(order: List<String>): List<Note>
}
