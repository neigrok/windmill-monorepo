package works.windmill.gym.net

import java.io.IOException
import works.windmill.gym.domain.AskAnswer
import works.windmill.gym.domain.AskQuestion
import works.windmill.gym.domain.AskThread
import works.windmill.gym.domain.McpKey
import works.windmill.gym.domain.OAuthGrant
import works.windmill.gym.domain.ReadTally
import works.windmill.gym.domain.SessionShare
import works.windmill.gym.domain.ThreadPage

// The REST doors the gym keeps beside the engine: Coach conversations, session shares and the
// connected-log credential lists. Every training read and write goes through the engine instead.
internal class FakeGymRest : GymRest {
    var online = true
    val calls = mutableListOf<String>()

    val shares = mutableMapOf<String, SessionShare>()
    var refuseShare: Exception? = null
    var refuseRevoke: Exception? = null

    val answers = mutableListOf<AskAnswer>()
    val asked = mutableListOf<AskQuestion>()
    var refuseAsk: Exception? = null
    // Held open to keep an ask IN FLIGHT while the exchange is read waiting.
    var onAsk: suspend () -> Unit = {}

    val conversations = mutableMapOf<String, AskThread>()
    var refuseThreads: Exception? = null

    val grants = mutableListOf<OAuthGrant>()
    val keys = mutableListOf<McpKey>()
    var refuseGrants: Exception? = null
    var refuseKeys: Exception? = null

    private fun reachable() {
        if (!online) throw IOException("offline")
    }

    override suspend fun share(sessionId: String): SessionShare {
        calls.add("share")
        reachable()
        refuseShare?.let { throw it }
        shares[sessionId]?.let { return it }
        val minted = SessionShare(token = "tok_$sessionId", expiresAtMs = 2_592_000_000)
        shares[sessionId] = minted
        return minted
    }

    override suspend fun revokeShare(sessionId: String) {
        calls.add("revokeShare")
        reachable()
        refuseRevoke?.let { throw it }
        shares.remove(sessionId) ?: throw IllegalStateException("404")
    }

    override suspend fun ask(question: AskQuestion): AskAnswer {
        calls.add("ask")
        asked.add(question)
        onAsk()
        reachable()
        refuseAsk?.let { throw it }
        if (answers.isEmpty()) {
            return AskAnswer(answer = "nothing has moved in three weeks.", read = ReadTally(sets = 12))
        }
        return answers.removeAt(0)
    }

    // One page holds every conversation.
    override suspend fun threads(cursor: String?): ThreadPage {
        calls.add("threads")
        reachable()
        refuseThreads?.let { throw it }
        return ThreadPage(conversations.values.sortedByDescending { it.askedAtMs }.map { it.copy(turns = emptyList()) })
    }

    override suspend fun thread(id: String, before: String?): AskThread? {
        calls.add("thread")
        reachable()
        refuseThreads?.let { throw it }
        return conversations[id]
    }

    override suspend fun deleteThread(id: String) {
        calls.add("deleteThread")
        reachable()
        refuseThreads?.let { throw it }
        conversations.remove(id)
    }

    override suspend fun grants(): List<OAuthGrant> {
        calls.add("grants")
        reachable()
        refuseGrants?.let { throw it }
        return grants.toList()
    }

    override suspend fun mcpKeys(): List<McpKey> {
        calls.add("mcpKeys")
        reachable()
        refuseKeys?.let { throw it }
        return keys.toList()
    }
}
