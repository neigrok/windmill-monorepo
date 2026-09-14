package works.windmill.platform.auth

import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApiException
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

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
        assertEquals(AuthStatus.Unresolved(), auth.status)
        assertEquals("s3cret", sessions.read())
    }

    @Test
    fun aRestoreThatNeverReachedTheServerKeepsTheSecretForNextTime() = runTest {
        val sessions = MemorySessions("s3cret")
        val auth = store(sessions)
        server.shutdown()
        auth.restore()
        assertEquals(AuthStatus.Unresolved(), auth.status)
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
        val approved = mutableListOf<User>()
        try {
            auth.completeCode("a@b.c", "483201") { approved += it }
            fail("expected unreadable")
        } catch (unreadable: WindmillApiException.Refused) {
            assertEquals(400, unreadable.status)
        }
        assertNull(sessions.read())
        assertNull(sessions.user())
        assertEquals(emptyList<User>(), approved)
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
        val approved = mutableListOf<User>()
        try {
            auth.completeLink("tok123") { approved += it }
            fail("expected unreadable")
        } catch (unreadable: WindmillApiException.Refused) {
            assertEquals(400, unreadable.status)
        }
        assertNull(sessions.read())
        assertNull(sessions.user())
        assertEquals(emptyList<User>(), approved)
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

    @Test
    fun aFailedBeforeCommitLeavesThePendingEmailAndNoCredentialsForEitherParser() = runTest {
        for (useCode in listOf(true, false)) {
            val sessions = MemorySessions()
            val auth = store(sessions)
            auth.restore()
            server.enqueue(MockResponse().setBody("{}"))
            auth.requestLink(" a@b.c ")
            server.enqueue(MockResponse().setBody("""{"user":{"id":"A","email":"a@b.c","name":"Ana"}}""")
                .addHeader("Set-Cookie", "wm_session=secret-A; Path=/; HttpOnly"))
            val approved = mutableListOf<User>()
            val checkpoint: (User) -> Unit = {
                assertEquals(AuthStatus.SignedOut, auth.status)
                assertNull(sessions.read())
                assertNull(sessions.user())
                approved += it
                throw IOException("consent disk full")
            }
            val result = runCatching {
                if (useCode) auth.completeCode("a@b.c", "123456", checkpoint)
                else auth.completeLink("token-A", checkpoint)
            }
            assertEquals(IOException::class.java, result.exceptionOrNull()?.javaClass)
            assertEquals("consent disk full", result.exceptionOrNull()?.message)
            assertEquals(listOf(User("A", "a@b.c", "Ana")), approved)
            assertEquals(AuthStatus.SignedOut, auth.status)
            assertEquals("a@b.c", auth.linkSentTo)
            assertNull(sessions.read())
            assertNull(sessions.user())
        }
    }

    @Test
    fun aDelayedRestoreCannotReplaceClearOrUnverifyTheLaterAccount() = runTest {
        for (status in listOf(200, 401, 500)) {
            val arrived = CompletableDeferred<Unit>()
            val release = CountDownLatch(1)
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (request.path == "/v1/me") {
                        arrived.complete(Unit)
                        check(release.await(5, TimeUnit.SECONDS))
                        return MockResponse().setResponseCode(status).setBody(if (status == 200)
                            """{"user":{"id":"A","email":"a@b.c","name":"Ana"}}""" else """{"error":"unavailable"}""")
                    }
                    return MockResponse().setBody("""{"user":{"id":"B","email":"b@b.c","name":"Bea"}}""")
                        .addHeader("Set-Cookie", "wm_session=secret-B; Path=/; HttpOnly")
                }
            }
            val sessions = MemorySessions("secret-A", User("A", "a@b.c", "Ana"))
            val auth = store(sessions)
            val restore = async { auth.restore() }
            arrived.await()
            try { auth.completeCode("b@b.c", "222222") }
            finally { release.countDown() }
            restore.await()
            assertEquals(AuthStatus.SignedIn(User("B", "b@b.c", "Bea")), auth.status)
            assertEquals("secret-B", sessions.read())
            assertEquals(User("B", "b@b.c", "Bea"), sessions.user())
            val requests = List(2) { server.takeRequest() }
            assertEquals(listOf("/v1/me", "/v1/auth/verify-code"), requests.map { it.path })
            assertEquals(listOf("Bearer secret-A", "Bearer secret-A"), requests.map { it.getHeader("Authorization") })
        }
    }

    @Test
    fun aDelayedLogoutCannotClearTheLaterAccountEvenWhenTheLogoutFails() = runTest {
        for (status in listOf(200, 500)) {
            val arrived = CompletableDeferred<Unit>()
            val release = CountDownLatch(1)
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (request.path == "/v1/auth/logout") {
                        arrived.complete(Unit)
                        check(release.await(5, TimeUnit.SECONDS))
                        return MockResponse().setResponseCode(status).setBody("{}")
                    }
                    return MockResponse().setBody("""{"user":{"id":"B","email":"b@b.c","name":"Bea"}}""")
                        .addHeader("Set-Cookie", "wm_session=secret-B; Path=/; HttpOnly")
                }
            }
            val sessions = MemorySessions("secret-A", User("A", "a@b.c", "Ana"))
            val auth = store(sessions)
            val logout = async { auth.signOut() }
            arrived.await()
            try { auth.completeLink("token-B") }
            finally { release.countDown() }
            logout.await()
            assertEquals(AuthStatus.SignedIn(User("B", "b@b.c", "Bea")), auth.status)
            assertEquals("secret-B", sessions.read())
            assertEquals(User("B", "b@b.c", "Bea"), sessions.user())
            assertEquals(listOf("/v1/auth/logout", "/v1/auth/verify"), List(2) { server.takeRequest().path })
        }
    }

    @Test
    fun aDelayedCompletionCannotInvokeItsCheckpointOrReplaceALaterCompletion() = runTest {
        for (olderUsesCode in listOf(true, false)) {
            val arrived = CompletableDeferred<Unit>()
            val release = CountDownLatch(1)
            val olderPath = if (olderUsesCode) "/v1/auth/verify-code" else "/v1/auth/verify"
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (request.path == olderPath) {
                        arrived.complete(Unit)
                        check(release.await(5, TimeUnit.SECONDS))
                        return MockResponse().setBody("""{"user":{"id":"A","email":"a@b.c","name":"Ana"}}""")
                            .addHeader("Set-Cookie", "wm_session=secret-A; Path=/; HttpOnly")
                    }
                    return MockResponse().setBody("""{"user":{"id":"B","email":"b@b.c","name":"Bea"}}""")
                        .addHeader("Set-Cookie", "wm_session=secret-B; Path=/; HttpOnly")
                }
            }
            val sessions = MemorySessions()
            val auth = store(sessions)
            val approved = mutableListOf<User>()
            val older = async { runCatching {
                if (olderUsesCode) auth.completeCode("a@b.c", "111111") { approved += it }
                else auth.completeLink("token-A") { approved += it }
            } }
            arrived.await()
            try {
                if (olderUsesCode) auth.completeLink("token-B") { approved += it }
                else auth.completeCode("b@b.c", "222222") { approved += it }
            } finally { release.countDown() }
            assertTrue(older.await().exceptionOrNull() is CancellationException)
            assertEquals(listOf(User("B", "b@b.c", "Bea")), approved)
            assertEquals(AuthStatus.SignedIn(User("B", "b@b.c", "Bea")), auth.status)
            assertEquals("secret-B", sessions.read())
            assertEquals(User("B", "b@b.c", "Bea"), sessions.user())
        }
    }

    @Test
    fun aReplacedFlowMayCancelTheCheckpointWithoutCommittingItsVerifiedReply() = runTest {
        val arrived = CompletableDeferred<Unit>()
        val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                arrived.complete(Unit)
                check(release.await(5, TimeUnit.SECONDS))
                return MockResponse().setBody("""{"user":{"id":"A","email":"a@b.c","name":"Ana"}}""")
                    .addHeader("Set-Cookie", "wm_session=secret-A; Path=/; HttpOnly")
            }
        }
        val sessions = MemorySessions()
        val auth = store(sessions)
        auth.restore()
        var flow = "old"
        val approved = mutableListOf<User>()
        val completion = async { runCatching { auth.completeCode("a@b.c", "111111") {
            if (flow != "old") throw CancellationException("The sign-in form changed.")
            approved += it
        } } }
        arrived.await()
        flow = "new"
        release.countDown()
        assertTrue(completion.await().exceptionOrNull() is CancellationException)
        assertEquals(emptyList<User>(), approved)
        assertEquals(AuthStatus.SignedOut, auth.status)
        assertNull(sessions.read())
        assertNull(sessions.user())
    }

    @Test
    fun aNewAccountCommittedInsideTheCheckpointIsNotOverwrittenAfterItReturns() = runTest {
        server.enqueue(MockResponse().setBody("""{"user":{"id":"A","email":"a@b.c","name":"Ana"}}""")
            .addHeader("Set-Cookie", "wm_session=secret-A; Path=/; HttpOnly"))
        server.enqueue(MockResponse().setBody("""{"user":{"id":"B","email":"b@b.c","name":"Bea"}}""")
            .addHeader("Set-Cookie", "wm_session=secret-B; Path=/; HttpOnly"))
        val sessions = MemorySessions()
        val auth = store(sessions)
        val approved = mutableListOf<User>()
        val result = runCatching { auth.completeCode("a@b.c", "111111") {
            runBlocking { auth.completeLink("token-B") { approved += it } }
        } }
        assertTrue(result.exceptionOrNull() is CancellationException)
        assertEquals(listOf(User("B", "b@b.c", "Bea")), approved)
        assertEquals(AuthStatus.SignedIn(User("B", "b@b.c", "Bea")), auth.status)
        assertEquals("secret-B", sessions.read())
        assertEquals(User("B", "b@b.c", "Bea"), sessions.user())
    }

    @Test
    fun anOldCodeRequestCannotRestoreItsAddressAfterAccountCompletion() = runTest {
        val arrived = CompletableDeferred<Unit>()
        val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path == "/v1/auth/magic-link") {
                    arrived.complete(Unit)
                    check(release.await(5, TimeUnit.SECONDS))
                    return MockResponse().setBody("{}")
                }
                return MockResponse().setBody("""{"user":{"id":"B","email":"b@b.c","name":"Bea"}}""")
                    .addHeader("Set-Cookie", "wm_session=secret-B; Path=/; HttpOnly")
            }
        }
        val sessions = MemorySessions()
        val auth = store(sessions)
        val request = async { runCatching { auth.requestLink("a@b.c") } }
        arrived.await()
        try { auth.completeCode("b@b.c", "222222") }
        finally { release.countDown() }
        assertTrue(request.await().exceptionOrNull() is CancellationException)
        assertNull(auth.linkSentTo)
        assertEquals(AuthStatus.SignedIn(User("B", "b@b.c", "Bea")), auth.status)
        assertEquals("secret-B", sessions.read())
        assertEquals(User("B", "b@b.c", "Bea"), sessions.user())
    }
    @Test
    fun accountTransportNeverBorrowsTheCredentialCommittedByALaterSignIn() = runTest {
        val ana = User("A", "a@example.com")
        val sessions = MemorySessions("secret-A", ana)
        val auth = store(sessions)
        val accountA = auth.accountApi(ana)
        val arrived = CompletableDeferred<Unit>()
        val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path == "/old-read") {
                    arrived.complete(Unit)
                    check(release.await(5, TimeUnit.SECONDS))
                }
                if (request.path == "/v1/auth/verify-code") return MockResponse()
                    .setBody("""{"user":{"id":"B","email":"b@example.com"}}""")
                    .addHeader("Set-Cookie", "wm_session=secret-B; Path=/; HttpOnly")
                return MockResponse().setBody("{}")
            }
        }
        val old = async { accountA.get<Unit>("/old-read"); accountA.get<Unit>("/old-next") }
        arrived.await()
        try { auth.completeCode("b@example.com", "222222") } finally { release.countDown() }
        old.await()
        auth.accountApi(User("B", "b@example.com")).get<Unit>("/new-read")
        val requests = List(4) { server.takeRequest() }
        assertEquals(listOf("/old-read", "/v1/auth/verify-code", "/old-next", "/new-read"), requests.map { it.path })
        assertEquals(listOf("Bearer secret-A", "Bearer secret-A", null, "Bearer secret-B"),
            requests.map { it.getHeader("Authorization") })
        assertEquals(AuthStatus.SignedIn(User("B", "b@example.com")), auth.status)
        assertEquals(LocalSession.Owned(User("B", "b@example.com")), sessions.localSession)
    }

    @Test
    fun appliedThenFailedCredentialCommitCannotAuthorizeEitherAccountUntilDiskRecovery() = runTest {
        val held = mutableMapOf<String, String>()
        var fail = false
        val values = object : KeptValues {
            override fun read(key: String) = held[key]
            override fun write(values: Map<String, String?>) {
                for ((key, value) in values) if (value == null) held.remove(key) else held[key] = value
                if (fail) throw IOException("commit failed after memory changed")
            }
        }
        val key = javax.crypto.KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val vault = SecretVault { key }
        val sessions = PrefsSessions(values, vault)
        val ana = User("A", "a@example.com")
        sessions.commit("secret-A", ana)
        val auth = store(sessions)
        server.enqueue(MockResponse().setBody("""{"user":{"id":"A","email":"a@example.com"}}"""))
        auth.restore()
        val accountA = auth.accountApi(ana)
        val original = held.toMap()
        fail = true
        server.enqueue(MockResponse().setBody("""{"user":{"id":"B","email":"b@example.com"}}""")
            .addHeader("Set-Cookie", "wm_session=secret-B; Path=/; HttpOnly"))
        assertEquals(IOException::class.java, runCatching { auth.completeCode("b@example.com", "222222") }.exceptionOrNull()?.javaClass)
        assertTrue(original != held)
        assertEquals(AuthStatus.Unresolved(ana), auth.status)
        assertEquals(LocalSession.Unresolved(), sessions.localSession)
        assertNull(sessions.read())
        assertNull(sessions.user())
        server.enqueue(MockResponse().setBody("{}"))
        accountA.get<Unit>("/old-retry")
        server.enqueue(MockResponse().setBody("{}"))
        auth.accountApi(User("B", "b@example.com")).get<Unit>("/new-retry")
        assertEquals(listOf("Bearer secret-A", "Bearer secret-A", null, null),
            List(4) { server.takeRequest().getHeader("Authorization") })
        val recovered = PrefsSessions(values, vault)
        assertEquals(LocalSession.Owned(User("B", "b@example.com")), recovered.localSession)
        assertEquals("secret-B", recovered.read())
    }

    @Test
    fun legacyIdentityWaitsForTheActualMeReplyAndThenSupportsColdOfflineOwnership() = runTest {
        val held = mutableMapOf("wm_session" to "legacy-A", "wm_user" to """{"id":"A","email":"a@example.com"}""")
        val values = object : KeptValues {
            override fun read(key: String) = held[key]
            override fun write(values: Map<String, String?>) {
                for ((key, value) in values) if (value == null) held.remove(key) else held[key] = value
            }
        }
        val key = javax.crypto.KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val vault = SecretVault { key }
        val sessions = PrefsSessions(values, vault)
        val ana = User("A", "a@example.com")
        assertEquals(LocalSession.Unresolved(ana), sessions.localSession)
        val auth = store(sessions)
        server.enqueue(MockResponse().setResponseCode(503).setBody("{}"))
        auth.restore()
        assertEquals(AuthStatus.Unresolved(ana), auth.status)
        assertEquals(LocalSession.Unresolved(ana), sessions.localSession)
        assertEquals("legacy-A", sessions.read())
        server.enqueue(MockResponse().setBody("""{"user":{"id":"A","email":"a@example.com"}}"""))
        auth.restore()
        assertEquals(AuthStatus.SignedIn(ana), auth.status)
        assertEquals(setOf("wm_identity.sealed"), held.keys)
        val cold = store(PrefsSessions(values, vault))
        assertEquals(LocalSession.Owned(ana), cold.localSession)
        server.enqueue(MockResponse().setResponseCode(503).setBody("{}"))
        cold.restore()
        assertEquals(AuthStatus.SignedIn(ana, verified = false), cold.status)
        assertEquals(LocalSession.Owned(ana), cold.localSession)
        assertEquals(listOf("Bearer legacy-A", "Bearer legacy-A", "Bearer legacy-A"),
            List(3) { server.takeRequest().getHeader("Authorization") })
    }

}
