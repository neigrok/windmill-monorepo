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

    @Test
    fun aRestoreTheServerCouldNotAnswerStandsOnTheLastKnownUserUnverified() = runTest {
        val ana = User("u1", "a@b.c", "Ana")
        server.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"boom"}"""))
        val sessions = MemorySessions("s3cret", ana)
        val auth = store(sessions)
        auth.restore()
        assertEquals(AuthStatus.SignedIn(ana, verified = false), auth.status)
        assertEquals("s3cret", sessions.read())
        assertEquals(ana, sessions.user())

        server.enqueue(MockResponse().setBody("""{"user":{"id":"u1","email":"a@b.c","name":"Ana"}}"""))
        auth.reverify()
        assertEquals(AuthStatus.SignedIn(ana, verified = true), auth.status)

        auth.reverify()
        assertEquals("a verified seat asks nothing more", 2, server.requestCount)
    }

    @Test
    fun aRestoreThatNeverReachedTheServerStandsOnTheLastKnownUserUnverified() = runTest {
        val ana = User("u1", "a@b.c", "Ana")
        val sessions = MemorySessions("s3cret", ana)
        val auth = store(sessions)
        server.shutdown()
        auth.restore()
        assertEquals(AuthStatus.SignedIn(ana, verified = false), auth.status)
        assertEquals("s3cret", sessions.read())
    }

    @Test
    fun aReverifyAnsweredWithA401SignsTheUnverifiedSeatOutAndClearsBoth() = runTest {
        val ana = User("u1", "a@b.c", "Ana")
        server.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"boom"}"""))
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"sign in to continue"}"""))
        val sessions = MemorySessions("s3cret", ana)
        val auth = store(sessions)
        auth.restore()
        assertEquals(AuthStatus.SignedIn(ana, verified = false), auth.status)
        auth.reverify()
        assertEquals(AuthStatus.SignedOut, auth.status)
        assertNull(sessions.read())
        assertNull(sessions.user())
    }

    @Test
    fun aSignInRemembersTheUserBesideTheSecret() = runTest {
        server.enqueue(MockResponse().setBody("""{"user":{"id":"u1","email":"a@b.c","name":"Ana"}}"""))
        val sessions = MemorySessions("s3cret")
        val auth = store(sessions)
        auth.restore()
        assertEquals(User("u1", "a@b.c", "Ana"), sessions.user())

        server.enqueue(
            MockResponse().setBody("""{"user":{"id":"u2","email":"b@b.c"}}""")
                .addHeader("Set-Cookie", "wm_session=fresh; Path=/; HttpOnly")
        )
        auth.completeCode("b@b.c", "483201")
        assertEquals(User("u2", "b@b.c", ""), sessions.user())
    }

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
