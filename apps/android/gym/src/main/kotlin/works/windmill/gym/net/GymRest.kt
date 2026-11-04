package works.windmill.gym.net

import works.windmill.gym.presentation.McpKey
import works.windmill.gym.presentation.OAuthGrant
import works.windmill.gym.sharing.SessionShare

// The gym's doors that stay on REST beside the engine: session shares and the connected log's credential lists. Training reads and writes never pass through here, and a Coach turn has its own wire.
interface GymRest {
    // Idempotent on the session, not on a client-minted id: sharing twice answers the live link.
    suspend fun share(sessionId: String): SessionShare

    suspend fun revokeShare(sessionId: String)

    // The shell's two credential lists, read here because this room draws what reaches its log: a
    // grant approved in the browser, and a static key. Every key is the account-wide grant.
    suspend fun grants(): List<OAuthGrant>
    suspend fun mcpKeys(): List<McpKey>
}
