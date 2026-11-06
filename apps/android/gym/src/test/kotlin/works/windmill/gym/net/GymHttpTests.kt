package works.windmill.gym.net

import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import java.util.concurrent.TimeUnit
import works.windmill.platform.net.WindmillApi
import works.windmill.sync.schema.SyncSchema
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import works.windmill.gym.presentation.McpKey
import works.windmill.gym.presentation.OAuthGrant
import works.windmill.platform.telemetry.Telemetry
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson

class GymHttpTests {
    @Test
    fun failedRequestsIdentifyTheirActionWithoutIdsQueriesOrContent() = runBlocking {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val failures = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
                assertEquals(503, (error as WindmillApiException.Refused).status)
                failures += operation to properties
            }
        }
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                .code(503).message("Unavailable")
                .body("""{"error":"private diagnostic"}""".toResponseBody("application/json".toMediaType())).build()
        }.build()
        val gym = GymHttp(WindmillApi("https://windmill.works".toHttpUrl(), { "private-bearer" }, client, telemetry))
        val requests = listOf<suspend () -> Any?>(
            { gym.share("private-session") },
            { gym.revokeShare("private-session") },
            { gym.grants() },
            { gym.mcpKeys() },
        )
        for (request in requests) {
            try {
                request()
                fail("the server refused the request")
            } catch (error: WindmillApiException.Refused) {
                assertEquals(503, error.status)
            }
        }
        val actions = listOf(
            "gym_share" to "POST", "gym_revoke_share" to "DELETE", "gym_grants" to "GET",
            "gym_mcp_keys" to "GET",
        )
        val expected = actions.map { (operation, method) -> operation to mapOf(
            "method" to method, "route" to if (operation == "gym_grants") "/v1/oauth" else if (operation == "gym_mcp_keys") "/v1/mcp-keys" else "/v1/gym", "failure_kind" to "http", "operation" to operation, "status" to "503",
            "network_phase" to "response_body",
        ) }
        assertEquals(expected.map { "api_request_failed" to it.second }, events.map { it.first to it.second.minus("duration_ms") })
        assertEquals(expected, failures.map { it.first to it.second.minus("duration_ms") })
        assertEquals(events.map { it.second }, failures.map { it.second })
        assertTrue(failures.all { it.second.getValue("duration_ms").toLong() >= 0 })
    }

    @Test
    fun ordinaryRequestsCarryTheSchemaAndKeepTheirTimeout() = runBlocking {
        val timeouts = mutableListOf<Triple<String, Int, Long>>()
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            assertEquals(SyncSchema.version.toString(), chain.request().header("Sync-Schema"))
            timeouts += Triple(chain.request().url.encodedPath, chain.readTimeoutMillis(),
                TimeUnit.NANOSECONDS.toSeconds(chain.call().timeout().timeoutNanos()))
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                .code(200).message("OK").body("""{"grants":[]}""".toResponseBody("application/json".toMediaType())).build()
        }.build()
        val gym = GymHttp(WindmillApi("https://windmill.works".toHttpUrl(), { null }, client))
        assertEquals(emptyList<OAuthGrant>(), gym.grants())
        assertEquals(listOf(Triple("/v1/oauth/grants", 10_000, 0L)), timeouts)
    }

    // The wire's `lastUsedMs` is a last-used and is not read: a row would draw it as a last-read. A
    // blank name and a missing scope both decode, because the server sends both.
    @Test
    fun testAGrantAndAKeyDecodeWithoutTheirLastUsedInstant() {
        assertEquals(
            OAuthGrant(clientId = "c1", name = "Claude Desktop", grantedMs = 1_700L, scope = "gym:read gym:write"),
            WindmillJson.decodeFromString(OAuthGrant.serializer(),
                """{"clientId":"c1","name":"Claude Desktop","grantedMs":1700,"lastUsedMs":1900,"scope":"gym:read gym:write"}"""),
        )
        assertEquals(
            OAuthGrant(clientId = "c2", name = "", grantedMs = 1_700L, scope = ""),
            WindmillJson.decodeFromString(OAuthGrant.serializer(), """{"clientId":"c2","grantedMs":1700}"""),
        )
        assertEquals(
            McpKey(id = "k1", name = "laptop", createdMs = 1_500L),
            WindmillJson.decodeFromString(McpKey.serializer(),
                """{"id":"k1","name":"laptop","createdMs":1500,"lastUsedMs":null}"""),
        )
    }
}
