package works.windmill.platform.net

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.Serializable
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

@Serializable
private data class Wire(val value: String)

class WindmillApiTest {
    private val server = MockWebServer()

    @Before
    fun start() {
        server.start()
    }

    @After
    fun stop() {
        server.shutdown()
    }

    private fun api(credential: () -> String? = { null }) = WindmillApi(server.url("/"), credential)

    @Test
    fun theBearerHeaderComesFromTheCredential() = runTest {
        server.enqueue(MockResponse().setBody("""{"value":"a"}"""))
        api { "s3cret" }.get<Wire>("/v1/echo")
        val request = server.takeRequest()
        assertEquals("Bearer s3cret", request.getHeader("Authorization"))
        assertEquals("application/json", request.getHeader("Accept"))
    }

    @Test
    fun noCredentialMeansNoBearerHeader() = runTest {
        server.enqueue(MockResponse().setBody("""{"value":"a"}"""))
        api().get<Wire>("/v1/echo")
        assertNull(server.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun aJsonBodyRoundTrips() = runTest {
        server.enqueue(MockResponse().setBody("""{"value":"pong"}"""))
        val reply = api().send<Wire>("POST", "/v1/echo", Wire("ping"))
        assertEquals(Wire("pong"), reply)
        val request = server.takeRequest()
        assertEquals("""{"value":"ping"}""", request.body.readUtf8())
        assertEquals("application/json; charset=utf-8", request.getHeader("Content-Type"))
    }

    @Test
    fun aRefusalCarriesTheServersWords() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(429)
                .setBody("""{"error":"slow down","detail":"try later","code":"rate_limited"}""")
        )
        try {
            api().get<Wire>("/v1/echo")
            fail("expected a refusal")
        } catch (refused: WindmillApiException.Refused) {
            assertEquals(429, refused.status)
            assertEquals(Refusal("slow down", "try later", "rate_limited"), refused.refusal)
            assertEquals("slow down", refused.line)
            assertFalse(refused.isUnauthorized)
        }
    }

    @Test
    fun aFourOhOneIsUnauthorized() = runTest {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"sign in to continue"}"""))
        try {
            api().get<Wire>("/v1/echo")
            fail("expected a refusal")
        } catch (refused: WindmillApiException.Refused) {
            assertTrue(refused.isUnauthorized)
            assertEquals("sign in to continue", refused.line)
        }
    }

    @Test
    fun aRefusalWithAnUnreadableBodyStillRefuses() = runTest {
        server.enqueue(MockResponse().setResponseCode(500).setBody("<html>oops</html>"))
        try {
            api().get<Wire>("/v1/echo")
            fail("expected a refusal")
        } catch (refused: WindmillApiException.Refused) {
            assertEquals(500, refused.status)
            assertEquals(Refusal(null, null, null), refused.refusal)
            assertEquals("That didn’t go through", refused.line)
        }
    }

    @Test
    fun aDeadHostIsOffline() = runTest {
        val dead = MockWebServer()
        dead.start()
        val base = dead.url("/")
        dead.shutdown()
        try {
            WindmillApi(base, { null }).get<Wire>("/v1/anything")
            fail("expected offline")
        } catch (offline: WindmillApiException.Offline) {
            assertEquals("Can’t reach windmill.works", offline.line)
        }
    }

    @Test
    fun anUndecodableSuccessIsMalformed() = runTest {
        server.enqueue(MockResponse().setBody("not json at all"))
        try {
            api().get<Wire>("/v1/echo")
            fail("expected malformed")
        } catch (broken: WindmillApiException.Malformed) {
            assertEquals("That didn’t go through", broken.line)
        }
    }

    @Test
    fun aTwoOhFourHasNoBodyToParse() = runTest {
        server.enqueue(MockResponse().setResponseCode(204))
        api().send<Unit>("DELETE", "/v1/things/th_x")
        val request = server.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals(0, request.bodySize)
    }

    @Test
    fun aBodilessPostStillGoesOut() = runTest {
        server.enqueue(MockResponse().setResponseCode(204))
        api().send<Unit>("POST", "/v1/auth/logout")
        assertEquals("POST", server.takeRequest().method)
    }

    @Test
    fun capturingLiftsTheSessionCookie() = runTest {
        server.enqueue(
            MockResponse().setBody("""{"value":"in"}""")
                .addHeader("Set-Cookie", "wm_session=abc123; Path=/; HttpOnly; SameSite=Lax")
                .addHeader("Set-Cookie", "crumb=other; Path=/")
        )
        val answer = api().sendCapturingSession<Wire>("POST", "/v1/auth/verify", Wire("tok"))
        assertEquals(Wire("in"), answer.reply)
        assertEquals("abc123", answer.session)
    }

    @Test
    fun capturingNothingIsNull() = runTest {
        server.enqueue(MockResponse().setBody("""{"value":"in"}"""))
        assertNull(api().sendCapturingSession<Wire>("POST", "/v1/auth/verify", Wire("tok")).session)
    }

    @Test
    fun theQuerySurvivesTheResolve() = runTest {
        server.enqueue(MockResponse().setBody("""{"value":"x"}"""))
        api().get<Wire>("/v1/things?filter=th_abc%20d&limit=2")
        assertEquals("/v1/things?filter=th_abc%20d&limit=2", server.takeRequest().path)
    }

    @Test
    fun blankConfigurationMeansProduction() {
        assertEquals("https://windmill.works/", WindmillApi.resolvedBaseUrl("").toString())
        assertEquals("https://windmill.works/", WindmillApi.resolvedBaseUrl("   ").toString())
        assertEquals("http://10.0.2.2:8088/", WindmillApi.resolvedBaseUrl("http://10.0.2.2:8088").toString())
        assertEquals("https://windmill.works/", WindmillApi.resolvedBaseUrl("not a url").toString())
    }
}
