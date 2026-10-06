package works.windmill.gym.net

import works.windmill.gym.coach.AskAnswer
import works.windmill.gym.coach.AskGeneration
import works.windmill.gym.coach.AskQuestion
import works.windmill.gym.coach.AskThread
import works.windmill.gym.coach.CoachAttachment
import works.windmill.gym.domain.McpKey
import works.windmill.gym.domain.OAuthGrant
import works.windmill.gym.domain.SessionShare
import works.windmill.gym.coach.ThreadPage

// The gym's doors that stay on REST beside the engine: Coach conversations, session shares and the
// connected log's credential lists. Training reads and writes never pass through here.
interface GymRest {
    // Idempotent on the session, not on a client-minted id: sharing twice answers the live link.
    suspend fun share(sessionId: String): SessionShare

    suspend fun revokeShare(sessionId: String)

    // The thread id is the client's: a fresh one opens a conversation, a spent one continues it.
    suspend fun ask(question: AskQuestion): AskAnswer

    suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit): AskAnswer =
        ask(question).also { it.generation?.let { generation -> onSnapshot(generation) } }

    suspend fun stop(threadId: String, requestId: String): AskGeneration = throw UnsupportedOperationException()

    suspend fun uploadPhoto(threadId: String, photo: CoachAttachment, bytes: ByteArray, onProgress: (Float) -> Unit): CoachAttachment = throw UnsupportedOperationException()

    suspend fun photo(threadId: String, attachmentId: String): ByteArray = throw UnsupportedOperationException()

    // A page of conversations, newest question first. They carry no turns; the detail read adds them.
    suspend fun threads(cursor: String? = null): ThreadPage

    // One conversation and a page of its newest turns, older ones before `before`. Null when the log
    // holds no such conversation for this account.
    suspend fun thread(id: String, before: String? = null): AskThread?

    suspend fun deleteThread(id: String)

    // The shell's two credential lists, read here because this room draws what reaches its log: a
    // grant approved in the browser, and a static key. Every key is the account-wide grant.
    suspend fun grants(): List<OAuthGrant>
    suspend fun mcpKeys(): List<McpKey>
}
