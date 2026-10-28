package works.windmill.gym.coach.onboarding

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.schema.SyncSchema

class CoachOnboardingTransportTests {
    private val id = "11111111-1111-4111-8111-111111111111"
    private val response = """{"requestId":"$id","resultId":"result","status":"completed","expiresAtMs":1900000000000,"routines":[],"allowance":{"code":"ok","currency":"USD","period":"lifetime","tier":"anonymous","configured":true,"limit":null,"used":"0","reserved":"0","remaining":"0"},"message":"Whole answer"}"""

    @Test fun postAndRecoveryCarryGeneratedSchemaAndOnlyTheInstallationCredential() = runTest {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse().setBody(response))
            server.enqueue(MockResponse().setBody(response))
            val api = CoachOnboardingHttp(server.url("/"))
            val body = """{"requestId":"$id","mode":"conversation","text":"Whole question","context":[]}"""
            assertEquals("Whole answer", api.start(body, "installation-fixture").message)
            assertEquals("Whole answer", api.get(id, "installation-fixture").message)
            val post = server.takeRequest()
            val get = server.takeRequest()
            assertEquals("POST", post.method)
            assertEquals(body, post.body.readUtf8())
            assertEquals("GET", get.method)
            assertEquals("/v1/gym/coach/onboarding/$id", get.path)
            for (request in listOf(post, get)) {
                assertEquals(SyncSchema.version.toString(), request.getHeader("Sync-Schema"))
                assertEquals("installation-fixture", request.getHeader("X-Windmill-Installation"))
                assertNull(request.getHeader("Authorization"))
                assertNull(request.getHeader("Cookie"))
            }
        }
    }

    @Test fun unavailableIsAnEventWhileAnUnexpectedServerFailureReportsOneStaticIssue() = runTest {
        val issues = mutableListOf<String>()
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { issues += operation }
        }
        MockWebServer().use { server ->
            server.start()
            val api = CoachOnboardingHttp(server.url("/"), telemetry)
            server.enqueue(MockResponse().setResponseCode(503).setBody("{\"code\":\"anonymous_ai_unavailable\"}"))
            try { api.get(id, "private-installation"); fail() } catch (_: WindmillApiException.Refused) { }
            assertTrue(issues.isEmpty())
            server.enqueue(MockResponse().setResponseCode(500).setBody("{\"code\":\"internal_error\"}"))
            try { api.get(id, "private-installation"); fail() } catch (_: WindmillApiException.Refused) { }
            assertEquals(listOf("gym.coachOnboarding"), issues)
            assertFalse(events.toString().contains(id))
            assertFalse(events.toString().contains("private-installation"))
            assertTrue(events.all { it.second["route"] == "/v1/gym" && it.second["operation"] == "gym.coachOnboarding" })
        }
    }
}
