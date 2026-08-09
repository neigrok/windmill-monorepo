package works.windmill.platform.auth

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApiException

class AuthStoreTest {
    private val server = MockWebServer()

    @Before
    fun start() {
        server.start()
    }

    @After
    fun stop() {
        server.shutdown()
    }

    private fun store(sessions: SessionStore) = AuthStore(server.url("/"), sessions)

    @Test
    fun restoreWithAnEmptyStoreAsksNothing() = runTest {
        val auth = store(MemorySessions())
        assertEquals(AuthStatus.Unknown, auth.status)
        auth.restore()
        assertEquals(AuthStatus.SignedOut, auth.status)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun restoreWithALiveSessionSignsIn() = runTest {
        server.enqueue(MockResponse().setBody("""{"user":{"id":"u1","email":"a@b.c","name":"Ana"}}"""))
        val auth = store(MemorySessions("s3cret"))
        auth.restore()
        assertEquals(AuthStatus.SignedIn(User("u1", "a@b.c", "Ana")), auth.status)
        val request = server.takeRequest()
        assertEquals("/v1/me", request.path)
        assertEquals("Bearer s3cret", request.getHeader("Authorization"))
    }

    @Test
    fun aLapsedSessionIsDroppedWithoutCeremony() = runTest {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"sign in to continue"}"""))
        val sessions = MemorySessions("stale")
        val auth = store(sessions)
        auth.restore()
        assertEquals(AuthStatus.SignedOut, auth.status)
        assertNull(sessions.read())
    }

    // Only the server's own 401 spends the secret. A server that failed and a host that could not
    // be reached said nothing about the session — clearing on either was silent sign-out, and the
    // queue's owed sets would have had no bearer left to replay under.
    @Test
    fun aRestoreTheServerFailedKeepsTheSecretForNextTime() = runTest {
        server.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"boom"}"""))
        val sessions = MemorySessions("s3cret")
        val auth = store(sessions)
        auth.restore()
        assertEquals(AuthStatus.SignedOut, auth.status)
        assertEquals("s3cret", sessions.read())
    }

    @Test
    fun aRestoreThatNeverReachedTheServerKeepsTheSecretForNextTime() = runTest {
        val sessions = MemorySessions("s3cret")
        val auth = store(sessions)
        server.shutdown()
        auth.restore()
        assertEquals(AuthStatus.SignedOut, auth.status)
        assertEquals("s3cret", sessions.read())
    }

    // `door: "app"` is what makes the mail carry a code rather than a link.
    @Test
    fun requestLinkTrimsRemembersTheAddressAndNamesTheAppDoor() = runTest {
        server.enqueue(MockResponse().setBody("""{"status":"sent"}"""))
        val auth = store(MemorySessions())
        auth.requestLink("  a@b.c\n")
        assertEquals("a@b.c", auth.linkSentTo)
        assertEquals("""{"email":"a@b.c","door":"app"}""", server.takeRequest().body.readUtf8())
    }

    @Test
    fun completeCodeSendsTheAddressWithTheCodeAndSignsIn() = runTest {
        server.enqueue(
            MockResponse().setBody("""{"user":{"id":"u1","email":"a@b.c"}}""")
                .addHeader("Set-Cookie", "wm_session=fresh; Path=/; HttpOnly")
        )
        val sessions = MemorySessions()
        val auth = store(sessions)
        auth.completeCode("a@b.c", "483201")
        assertEquals("fresh", sessions.read())
        assertEquals(AuthStatus.SignedIn(User("u1", "a@b.c", "")), auth.status)
        assertNull(auth.linkSentTo)
        val request = server.takeRequest()
        assertEquals("/v1/auth/verify-code", request.path)
        assertEquals("""{"email":"a@b.c","code":"483201"}""", request.body.readUtf8())
    }

    @Test
    fun completeCodeWithoutACookieRefuses() = runTest {
        server.enqueue(MockResponse().setBody("""{"user":{"id":"u1","email":"a@b.c"}}"""))
        val sessions = MemorySessions()
        val auth = store(sessions)
        try {
            auth.completeCode("a@b.c", "483201")
            fail("expected unreadable")
        } catch (unreadable: WindmillApiException.Refused) {
            assertEquals(400, unreadable.status)
        }
        assertNull(sessions.read())
        assertEquals(AuthStatus.Unknown, auth.status)
    }

    @Test
    fun completeLinkStoresTheCapturedCookieAndSignsIn() = runTest {
        server.enqueue(
            MockResponse().setBody("""{"user":{"id":"u1","email":"a@b.c"}}""")
                .addHeader("Set-Cookie", "wm_session=fresh; Path=/; HttpOnly")
        )
        val sessions = MemorySessions()
        val auth = store(sessions)
        auth.completeLink("https://windmill.works/#/auth?token=tok123")
        assertEquals("fresh", sessions.read())
        assertEquals(AuthStatus.SignedIn(User("u1", "a@b.c", "")), auth.status)
        val request = server.takeRequest()
        assertEquals("/v1/auth/verify", request.path)
        assertEquals("""{"token":"tok123"}""", request.body.readUtf8())
    }

    @Test
    fun completeLinkWithoutATokenAsksNothing() = runTest {
        val auth = store(MemorySessions())
        try {
            auth.completeLink("https://windmill.works/#/auth")
            fail("expected unreadable")
        } catch (unreadable: WindmillApiException.Refused) {
            assertEquals(400, unreadable.status)
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun completeLinkWithoutACookieRefuses() = runTest {
        server.enqueue(MockResponse().setBody("""{"user":{"id":"u1","email":"a@b.c"}}"""))
        val sessions = MemorySessions()
        val auth = store(sessions)
        try {
            auth.completeLink("tok123")
            fail("expected unreadable")
        } catch (unreadable: WindmillApiException.Refused) {
            assertEquals(400, unreadable.status)
        }
        assertNull(sessions.read())
        assertEquals(AuthStatus.Unknown, auth.status)
    }

    @Test
    fun signOutClearsEvenWhenTheServerCannotBeTold() = runTest {
        server.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"boom"}"""))
        val sessions = MemorySessions("s3cret")
        val auth = store(sessions)
        auth.signOut()
        assertNull(sessions.read())
        assertEquals(AuthStatus.SignedOut, auth.status)
        assertNull(auth.linkSentTo)
    }
}
