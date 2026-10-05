package works.windmill.gym.net

import works.windmill.gym.domain.AskAnswer
import works.windmill.gym.domain.AskGeneration
import works.windmill.gym.domain.CoachAttachment
import works.windmill.gym.domain.AskQuestion
import works.windmill.gym.domain.ThreadPage
import works.windmill.gym.domain.AskThread
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.ExerciseWrite
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.LastSet
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.McpKey
import works.windmill.gym.domain.StatsProgress
import works.windmill.gym.domain.MovementRecord
import works.windmill.gym.domain.Note
import works.windmill.gym.domain.OAuthGrant
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
import works.windmill.gym.domain.WeighIn
import works.windmill.gym.domain.WeighInWrite

interface TrainingSyncing {
    private fun <T> engineRequired(): T = throw IllegalStateException("Gym data requires the sync engine.")
    suspend fun exercises(): List<Exercise> = engineRequired()
    suspend fun createExercise(write: ExerciseWrite): Exercise = engineRequired()

    // Explicit starts refuse an open workout; migration starts join and retain the identity map.
    suspend fun startSession(start: SessionStart): Session = engineRequired()

    // One row per minted id; retrying preserves the stored identity.
    suspend fun appendSet(sessionId: String, write: SetWrite): TrainingSet = engineRequired()

    // Owner-scoped and idempotent: a lost reply is safe to send again.
    suspend fun fixSet(sessionId: String, setId: String, fix: SetFix): TrainingSet = engineRequired()

    suspend fun deleteSet(sessionId: String, setId: String): Unit = engineRequired()

    suspend fun finishSession(sessionId: String, finishedAtMs: Long): Session = engineRequired()

    // Refuses a live session.
    suspend fun discardSession(sessionId: String): Unit = engineRequired()

    // Newest first. The cursor needs both halves of the sort key: sessions can share an instant.
    suspend fun sessions(limit: Int, before: Long?, beforeId: String?): List<SessionSummary> = engineRequired()

    suspend fun session(id: String): SessionDetail? = engineRequired()

    suspend fun review(sessionId: String): Review = engineRequired()

    suspend fun lastTime(exerciseId: String): LastTime = engineRequired()

    // Sparse: a movement never trained has no entry, and that absence means never logged.
    suspend fun lastSets(): List<LastSet> = engineRequired()

    suspend fun routines(): List<Routine> = engineRequired()

    suspend fun routine(id: String): Routine? = engineRequired()

    suspend fun createRoutine(write: RoutineWrite): Routine = engineRequired()

    // Replace owned fields through a guarded domain draft; omitted lines are deleted.
    suspend fun replaceRoutine(id: String, write: RoutineWrite): Routine = engineRequired()

    suspend fun deleteRoutine(id: String): Unit = engineRequired()

    // Proposals belong to the signed-in account.
    suspend fun proposal(id: String): Proposal? = engineRequired()

    // Atomic against the base the diff was written on; a routine that moved first is refused, never
    // merged. The routine comes back with the decision, absent when the proposal removes it.
    suspend fun applyProposal(id: String): ProposalDecision = engineRequired()

    suspend fun dismissProposal(id: String): ProposalDecision = engineRequired()

    suspend fun progress(): StatsProgress = engineRequired()

    suspend fun record(exerciseId: String): MovementRecord? = engineRequired()

    // The id is unchanged.
    suspend fun renameExercise(exerciseId: String, name: String): Exercise = engineRequired()

    // Idempotent on the session, not on a client-minted id: sharing twice answers the live link.
    suspend fun share(sessionId: String): SessionShare

    suspend fun revokeShare(sessionId: String)

    suspend fun preferences(): GymPreferences = engineRequired()

    // Preserve preferences owned by other surfaces when replacing the server document.
    suspend fun savePreferences(document: GymPreferences): GymPreferences = engineRequired()

    // The thread id is the client's: a fresh one opens a conversation, a spent one continues it.
    suspend fun ask(question: AskQuestion): AskAnswer

    suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit): AskAnswer =
        ask(question).also { it.generation?.let { generation -> onSnapshot(generation) } }

    suspend fun stop(threadId: String, requestId: String): AskGeneration = throw UnsupportedOperationException()

    suspend fun uploadPhoto(threadId: String, photo: CoachAttachment, bytes: ByteArray, onProgress: (Float) -> Unit): CoachAttachment = throw UnsupportedOperationException()

    suspend fun photo(threadId: String, attachmentId: String): ByteArray = throw UnsupportedOperationException()

    // Carries no turns; the detail read adds them. Newest question first.
    suspend fun threads(): List<AskThread>

    suspend fun thread(id: String): AskThread?

    suspend fun threadPage(id: String, before: String? = null): AskThread? = thread(id)

    suspend fun threadsPage(cursor: String? = null): ThreadPage =
        ThreadPage(threads())

    suspend fun deleteThread(id: String)

    // In precedence order, ten at most; read from the selected account replica.
    suspend fun notes(): List<Note> = engineRequired()

    // Upsert by the client-minted id: a new id lands last, a spent id edits. Past ten notes or past
    // the title and body bounds the log refuses in its own words, and the screen shows those.
    suspend fun writeNote(id: String, write: NoteWrite): Note = engineRequired()

    // Removing an absent note succeeds.
    suspend fun deleteNote(id: String): Unit = engineRequired()

    // Whole-order replace, naming every note of the account exactly once.
    suspend fun reorderNotes(order: List<String>): List<Note> = engineRequired()

    // Ascending by date; both bounds inclusive and optional, absent meaning the whole series.
    suspend fun bodyweight(from: String? = null, to: String? = null): List<WeighIn> = engineRequired()

    // Idempotent by the local date. The reply is the row that STANDS — the newer of the two by
    // `recordedAt` — so a replayed stale write answers with the correction it could not overtake.
    suspend fun putBodyweight(dateLocal: String, write: WeighInWrite): WeighIn = engineRequired()

    // Removing an absent date succeeds.
    suspend fun deleteBodyweight(dateLocal: String): Unit = engineRequired()

    // The shell's two credential lists, read here because this room draws what reaches its log: a
    // grant approved in the browser, and a static key. Every key is the account-wide grant.
    suspend fun grants(): List<OAuthGrant>
    suspend fun mcpKeys(): List<McpKey>
}
