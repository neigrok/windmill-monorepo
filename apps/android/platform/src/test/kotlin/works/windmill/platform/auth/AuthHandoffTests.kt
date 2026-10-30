package works.windmill.platform.auth

import kotlinx.coroutines.*
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import works.windmill.platform.User
import works.windmill.platform.telemetry.Telemetry
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class AuthHandoffTests {
    private val server = MockWebServer()
    private val prior = User("A", "a@example.com")
    private val next = User("B", "b@example.com")
    private val events = mutableListOf<Pair<String, Map<String, String>>>()
    private val identities = mutableListOf<String?>()
    private val failures = mutableListOf<String>()
    private val telemetry = object : Telemetry {
        override fun event(name: String, properties: Map<String, String>) { events += name to properties }
        override fun identity(userId: String?) { identities += userId }
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
            assertEquals(emptyMap<String, String>(), properties)
            failures += operation
        }
    }
    @Before fun start() { server.start() }
    @After fun stop() { server.shutdown() }
    private fun verified(user: User, secret: String) = MockResponse()
        .setBody("""{"user":{"id":"${user.id}","email":"${user.email}"}}""")
        .addHeader("Set-Cookie", "wm_session=$secret; Path=/; HttpOnly")

    @Test fun disposalAndMultipleReattachmentsAwaitOneVerifiedHandoff() = runTest {
        val sessions = MemorySessions()
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val visits = mutableListOf<ProposedSignIn>()
        val auth = AuthStore(server.url("/"), sessions, telemetry = telemetry, handoffScope = backgroundScope,
            lifecycle = object : AuthLifecycle {
                override suspend fun signedIn(user: User, token: String, restoring: Boolean) {
                    visits += ProposedSignIn(token, user); entered.complete(Unit); release.await()
                }
                override suspend fun signOut() = Unit
            })
        server.enqueue(verified(next, "sealed-B"))
        val form = async { auth.completeCode(next.email, "123456") }
        entered.await()
        assertTrue(auth.handoffPending)
        assertEquals(ProposedSignIn("sealed-B", next), sessions.proposed)
        assertNull(sessions.read())
        form.cancelAndJoin()
        val revision = auth.handoffRevision
        val recreated = async { auth.awaitExistingHandoff(revision) }
        val modeChanged = async { auth.awaitExistingHandoff(revision) }
        runCurrent()
        assertEquals(listOf(ProposedSignIn("sealed-B", next)), visits)
        assertFalse(recreated.isCompleted); assertFalse(modeChanged.isCompleted)
        release.complete(Unit)
        assertTrue(recreated.await()); assertTrue(modeChanged.await())
        assertEquals(AuthHandoffResult.Accepted, auth.handoffResult)
        assertFalse(auth.awaitExistingHandoff(revision + 1))
        assertEquals(AuthStatus.SignedIn(next), auth.status)
        assertEquals("sealed-B", sessions.read()); assertNull(sessions.proposed)
        assertFalse(auth.handoffPending)
        assertEquals(1, server.requestCount)
        assertEquals(1, events.count { it.first == "auth_sign_in_started" })
        assertEquals(1, events.count { it.first == "auth_signed_in" })
        assertEquals(0, events.count { it.first == "auth_restore" })
        assertEquals(listOf(next.id), identities)
        assertEquals(emptyList<String>(), failures)
    }

    @Test fun explicitCancelRetiresALateReplyAndKeepsThePriorCredential() = runTest {
        val sessions = MemorySessions("sealed-A", prior)
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val retired = mutableListOf<ProposedSignIn>()
        val auth = AuthStore(server.url("/"), sessions, telemetry = telemetry, handoffScope = backgroundScope,
            lifecycle = object : AuthLifecycle {
                override suspend fun signedIn(user: User, token: String, restoring: Boolean) {
                    entered.complete(Unit); withContext(NonCancellable) { release.await() }
                }
                override suspend fun signOut() = Unit
                override suspend fun cancelSignIn(user: User, token: String): Boolean {
                    retired += ProposedSignIn(token, user); return false
                }
            })
        server.enqueue(verified(next, "sealed-B"))
        val form = async { auth.completeCode(next.email, "123456") }
        entered.await(); form.cancelAndJoin()
        val cancel = async { auth.cancelPendingSignIn() }
        runCurrent(); assertFalse(cancel.isCompleted)
        release.complete(Unit); cancel.await()
        assertEquals(listOf(ProposedSignIn("sealed-B", next)), retired)
        assertEquals(LocalSession.Owned(prior), sessions.localSession)
        assertEquals("sealed-A", sessions.read()); assertNull(sessions.proposed)
        assertEquals(AuthStatus.SignedIn(prior, verified = false), auth.status)
        assertEquals(emptyList<String?>(), identities)
        assertEquals(0, events.count { it.first == "auth_signed_in" })
        assertEquals(emptyList<String>(), failures)
    }

    @Test fun anAtoBtoAReplacementCannotPublishTheOldBProposal() = runTest {
        val sessions = MemorySessions("sealed-A", prior)
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val visits = mutableListOf<ProposedSignIn>()
        val auth = AuthStore(server.url("/"), sessions, telemetry = telemetry, handoffScope = backgroundScope,
            lifecycle = object : AuthLifecycle {
                override suspend fun signedIn(user: User, token: String, restoring: Boolean) {
                    visits += ProposedSignIn(token, user)
                    if (user == next) { entered.complete(Unit); withContext(NonCancellable) { release.await() } }
                }
                override suspend fun signOut() = Unit
            })
        server.enqueue(verified(next, "sealed-B")); server.enqueue(verified(prior, "sealed-A2"))
        val old = async { runCatching { auth.completeCode(next.email, "123456") } }
        entered.await()
        val replacement = async { auth.completeCode(prior.email, "654321") }
        runCurrent(); release.complete(Unit)
        replacement.await()
        assertTrue(old.await().exceptionOrNull() is CancellationException)
        assertEquals(listOf(ProposedSignIn("sealed-B", next), ProposedSignIn("sealed-A2", prior)), visits)
        assertEquals(AuthStatus.SignedIn(prior), auth.status)
        assertEquals("sealed-A2", sessions.read()); assertNull(sessions.proposed)
        assertEquals(listOf(prior.id), identities)
        assertEquals(1, events.count { it.first == "auth_signed_in" })
        assertEquals(2, server.requestCount)
        assertEquals(emptyList<String>(), failures)
    }

    @Test fun aDetachedFailureReportsOnceAndRetriesTheSealedProposalWithoutVerification() = runTest {
        val application = CoroutineScope(backgroundScope.coroutineContext + SupervisorJob(backgroundScope.coroutineContext[Job]))
        val sessions = MemorySessions("sealed-A", prior)
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var visits = 0
        val auth = AuthStore(server.url("/"), sessions, telemetry = telemetry, handoffScope = application,
            lifecycle = object : AuthLifecycle {
                override suspend fun signedIn(user: User, token: String, restoring: Boolean) {
                    visits++
                    if (visits == 1) { entered.complete(Unit); release.await(); throw IOException("fixture storage failure") }
                }
                override suspend fun signOut() = Unit
            })
        server.enqueue(verified(next, "sealed-B"))
        val form = async { auth.completeCode(next.email, "123456") }
        entered.await(); form.cancelAndJoin(); release.complete(Unit); runCurrent()
        assertFalse(auth.handoffPending)
        assertEquals(listOf("auth_sign_in"), failures)
        assertEquals(ProposedSignIn("sealed-B", next), sessions.proposed)
        assertEquals("sealed-A", sessions.read())
        auth.reverify()
        assertEquals(1, visits); assertEquals(1, server.requestCount)
        assertEquals(AuthHandoffResult.Failed, auth.handoffResult)
        assertFalse(auth.resumePendingSignIn(prior.email))
        assertTrue(auth.resumePendingSignIn(next.email))
        assertEquals(2, visits)
        assertEquals(1, server.requestCount)
        assertEquals(AuthStatus.SignedIn(next), auth.status)
        assertEquals(1, events.count { it.first == "auth_signed_in" })
        assertEquals(listOf("auth_sign_in"), failures)
        application.cancel()
    }

    @Test fun aRetiredAcceptedHandoffCannotCompleteTheNewerIntent() = runTest {
        val third = User("C", "c@example.com")
        val sessions = MemorySessions("sealed-A", prior)
        val enteredB = CompletableDeferred<Unit>()
        val releaseB = CompletableDeferred<Unit>()
        val enteredC = CompletableDeferred<Unit>()
        val releaseC = CompletableDeferred<Unit>()
        val auth = AuthStore(server.url("/"), sessions, telemetry = telemetry, handoffScope = backgroundScope,
            lifecycle = object : AuthLifecycle {
                override suspend fun signedIn(user: User, token: String, restoring: Boolean) {
                    if (user == next) { enteredB.complete(Unit); withContext(NonCancellable) { releaseB.await() } }
                    else { enteredC.complete(Unit); releaseC.await() }
                }
                override suspend fun cancelSignIn(user: User, token: String) = user == next
                override suspend fun signOut() = Unit
            })
        server.enqueue(verified(next, "sealed-B")); server.enqueue(verified(third, "sealed-C"))
        val old = async { runCatching { auth.completeCode(next.email, "123456") } }
        enteredB.await()
        val oldRevision = auth.handoffRevision
        val oldObserver = async { runCatching { auth.awaitExistingHandoff(oldRevision) } }
        val replacement = async { auth.completeCode(third.email, "654321") }
        runCurrent(); releaseB.complete(Unit); enteredC.await()
        assertTrue(old.await().exceptionOrNull() is CancellationException)
        assertTrue(oldObserver.await().exceptionOrNull() is CancellationException)
        assertEquals(AuthStatus.SignedIn(next), auth.status)
        assertEquals("sealed-B", sessions.read())
        assertFalse(auth.awaitExistingHandoff(oldRevision))
        val revision = auth.handoffRevision
        assertTrue(revision > oldRevision); assertTrue(auth.handoffPending); assertNull(auth.handoffResult)
        val currentObserver = async { auth.awaitExistingHandoff(revision) }
        runCurrent(); assertFalse(currentObserver.isCompleted)
        releaseC.complete(Unit); replacement.await()
        assertTrue(currentObserver.await())
        assertEquals(AuthHandoffResult.Accepted, auth.handoffResult)
        assertEquals(AuthStatus.SignedIn(third), auth.status)
        assertEquals("sealed-C", sessions.read()); assertNull(sessions.proposed)
        assertEquals(listOf(next.id, third.id), identities)
        assertEquals(1, events.count { it.first == "auth_signed_in" })
        assertEquals(2, server.requestCount)
        assertEquals(emptyList<String>(), failures)
    }
}
