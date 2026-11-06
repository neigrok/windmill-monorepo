package works.windmill.gym.net

import kotlinx.serialization.Serializable
import works.windmill.gym.presentation.McpKey
import works.windmill.gym.presentation.OAuthGrant
import works.windmill.gym.sharing.SessionShare
import works.windmill.platform.net.WindmillApi
import works.windmill.sync.schema.SyncSchema

// Pass every path WHOLE, query included: appending it as a path segment percent-encodes `?` and `&`.
class GymHttp(api: WindmillApi) : GymRest {
    private val api = api.withHeaders(mapOf("Sync-Schema" to SyncSchema.version.toString()))

    override suspend fun share(sessionId: String): SessionShare =
        api.send<SessionShare>("POST", "/v1/gym/sessions/$sessionId/share", operation = "gym_share")

    override suspend fun revokeShare(sessionId: String) {
        api.send<Unit>("DELETE", "/v1/gym/sessions/$sessionId/share", operation = "gym_revoke_share")
    }

    override suspend fun grants(): List<OAuthGrant> =
        api.get<GrantsResponse>("/v1/oauth/grants", operation = "gym_grants").grants

    override suspend fun mcpKeys(): List<McpKey> =
        api.get<McpKeysResponse>("/v1/mcp-keys", operation = "gym_mcp_keys").keys
}

@Serializable
private data class GrantsResponse(val grants: List<OAuthGrant> = emptyList())

@Serializable
private data class McpKeysResponse(val keys: List<McpKey> = emptyList())
