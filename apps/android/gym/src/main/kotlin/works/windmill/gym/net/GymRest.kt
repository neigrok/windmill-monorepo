package works.windmill.gym.net

import java.io.IOException
import works.windmill.gym.domain.Ask
import works.windmill.gym.domain.AskAnswer
import works.windmill.gym.domain.AskCap
import works.windmill.gym.domain.AskGeneration
import works.windmill.gym.domain.AskQuestion
import works.windmill.gym.domain.AskThread
import works.windmill.gym.domain.CoachAttachment
import works.windmill.gym.domain.McpKey
import works.windmill.gym.domain.OAuthGrant
import works.windmill.gym.domain.SessionShare
import works.windmill.gym.domain.ThreadPage
import works.windmill.platform.net.WindmillApiException

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

    // Carries no turns; the detail read adds them. Newest question first.
    suspend fun threads(): List<AskThread>

    suspend fun thread(id: String): AskThread?

    suspend fun threadPage(id: String, before: String? = null): AskThread? = thread(id)

    suspend fun threadsPage(cursor: String? = null): ThreadPage = ThreadPage(threads())

    suspend fun deleteThread(id: String)

    // The shell's two credential lists, read here because this room draws what reaches its log: a
    // grant approved in the browser, and a static key. Every key is the account-wide grant.
    suspend fun grants(): List<OAuthGrant>
    suspend fun mcpKeys(): List<McpKey>
}

// A refusal stripped of the transport that carried it.
data class RefusalFacts(
    val status: Int? = null,
    val code: String? = null,
    val sentence: String? = null,
    val offline: Boolean = false,
    val malformed: Boolean = false,
)

// A failure that carries no reply from the log reads as no answer, never as a refusal.
fun RefusalFacts(refusing: Throwable): RefusalFacts = when (refusing) {
    is WindmillApiException.Offline -> RefusalFacts(offline = true)
    is IOException -> RefusalFacts(offline = true)
    is WindmillApiException.Malformed -> RefusalFacts(malformed = true)
    is WindmillApiException.Refused -> RefusalFacts(
        status = refusing.status, code = refusing.refusal.code, sentence = refusing.refusal.message)
    else -> RefusalFacts()
}

// Told apart by status and code, never by the English. `Absent` is a deployment with no model
// configured, and the room takes the door down for it.
sealed class AskVerdict {
    data class Said(val said: String) : AskVerdict()   // the answer is the sentence, and it will not change on a retry
    data class Capped(val said: String, val cap: AskCap) : AskVerdict() // 429 — the composer comes down: the daily bucket, or the account's 30-day ceiling
    data class Again(val said: String) : AskVerdict()  // 5xx, no reply at all — the one worth offering a retry on
    data class Fresh(val said: String) : AskVerdict()  // 409 — this conversation cannot take the question; the next one opens a new thread
    data object Absent : AskVerdict()                  // 404 — this deployment has no Ask

    companion object {
        fun refusing(facts: RefusalFacts): AskVerdict {
            val status = facts.status
            if (facts.offline || facts.malformed || status == null) return Again(noAnswer)
            if (status == 404) return Absent
            if (status >= 500) return Again(facts.sentence ?: noAnswer)
            if (facts.code == "ask-daily-limit") {
                return Capped(facts.sentence ?: AskCap.Daily.wordless, AskCap.Daily)
            }
            // The SAME state, because the one unrationed way on — the connect door — is drawn there
            // and is not drawn beside a live composer.
            if (facts.code == "ask-out-of-budget") {
                return Capped(facts.sentence ?: AskCap.Ceiling.wordless, AskCap.Ceiling)
            }
            if (facts.code == "ask-generation-active") return Again(facts.sentence ?: "Coach is answering another message. Try again when it finishes.")
            // Both are answered by opening a new thread; nothing is re-sent on its own.
            if (facts.code == "ask-thread-full" || facts.code == "ask-thread-taken") {
                return Fresh(facts.sentence ?: Ask.threadFull)
            }
            return Said(facts.sentence ?: "Coach couldn’t take that one")
        }

        private const val noAnswer = "Coach didn’t answer. Try again in a moment"
    }
}
