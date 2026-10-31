package works.windmill.platform.auth

import java.io.IOException
import javax.crypto.KeyGenerator
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import works.windmill.platform.User
import works.windmill.platform.net.WindmillJson
import works.windmill.platform.telemetry.TelemetryPolicy
import works.windmill.platform.telemetry.Telemetry

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class AuthSignOutTests {
    private val server = MockWebServer()
    private val user = User("account-a", "a@example.com")
    private val secret = "session-a"
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val vault = SecretVault { key }
    private val events = mutableListOf<String>()
    private val telemetry = object : Telemetry {
        override fun event(name: String, properties: Map<String, String>) { events += name }
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) = Unit
    }
    @Before fun start() { server.start() }
    @After fun stop() { server.shutdown() }

    private inner class Values : KeptValues {
        val kept = mutableMapOf<String, String>()
        var fail: String? = null
        var after = false
        override fun read(key: String) = kept[key]
        override fun write(values: Map<String, String?>) {
            val intent = values["wm_sign_out.sealed"]?.let(vault::open)?.let { WindmillJson.decodeFromString<SignOutIntent>(it) }
            val point = when {
                intent != null -> if (intent.engineFinished) "finished" else "initial"
                "wm_identity.sealed" in values && values["wm_identity.sealed"] == null -> "clear"
                else -> "other"
            }
            val failing = fail == point
            if (failing) fail = null
            if (failing && !after) throw IOException("fixture storage failure")
            values.forEach { (key, value) -> if (value == null) kept.remove(key) else kept[key] = value }
            if (failing) throw IOException("fixture committed storage failure")
        }
    }
    private inner class Lifecycle(var unsent: Int = 3) : AuthLifecycle {
        var active: String? = user.id
        val choices = mutableListOf<AuthSignOutChoice>()
        var recoveries = 0
        var cleanups = 0
        var cancels = 0
        var failCleanup = false
        var gate: CompletableDeferred<Unit>? = null
        override suspend fun signedIn(user: User, token: String, restoring: Boolean) = Unit
        override suspend fun signOut(): Unit = error("Prepared choices cannot use forced Keep.")
        override suspend fun prepareSignOut(account: String): AuthSignOutSession {
            gate?.await()
            check(active == account)
            return object : AuthSignOutSession {
                var ended = false
                override val account = account
                override val unsent = this@Lifecycle.unsent
                override suspend fun finish(choice: AuthSignOutChoice) {
                    check(!ended) { "An ended handle was reused." }
                    check(active == account)
                    choices += choice
                    active = null
                    ended = true
                }
                override suspend fun cancel() { check(!ended); ended = true; cancels++ }
            }
        }
        override suspend fun recoverSignOut(account: String, choice: AuthSignOutChoice) {
            recoveries++
            check(active == null || active == account)
            if (active == account) { choices += choice; active = null }
        }
        override suspend fun cleanupSignOut(account: String) {
            assertEquals(user.id, account)
            cleanups++
            if (failCleanup) { failCleanup = false; throw IOException("fixture credential cleanup failure") }
        }
    }
    private suspend fun TestScope.open(values: Values, lifecycle: Lifecycle, scope: CoroutineScope = backgroundScope): Pair<AuthStore, PrefsSessions> {
        val sessions = PrefsSessions(values, vault, telemetry)
        sessions.commit(secret, user)
        server.enqueue(MockResponse().setResponseCode(503))
        val auth = AuthStore(server.url("/"), sessions, telemetry = telemetry, lifecycle = lifecycle, handoffScope = scope)
        auth.restore()
        assertEquals(AuthStatus.SignedIn(user, false), auth.status)
        assertEquals("/v1/me", server.takeRequest().path)
        return auth to sessions
    }

    @Test fun signOutEventsContainOnlyTheFiniteChoiceAndOutcomeLabels() {
        for (action in listOf("keep", "discard", "cancel")) for (outcome in listOf("completed", "failed")) {
            assertEquals(mapOf("action" to action, "outcome" to outcome),
                TelemetryPolicy.eventProperties("gym_sign_out", mapOf("action" to action, "outcome" to outcome,
                    "account" to user.id, "email" to user.email, "secret" to secret, "unsent" to "3")))
        }
        assertEquals(mapOf("state" to "shown"), TelemetryPolicy.eventProperties("gym_sign_out", mapOf("state" to "shown")))
        assertEquals(emptyMap<String, String>(), TelemetryPolicy.eventProperties("gym_sign_out",
            mapOf("state" to user.id, "action" to secret, "outcome" to "private-content")))
    }

    @Test fun preparationAndCancelNeverWriteAChoiceOrEndTheAccount() = runTest {
        val values = Values(); val lifecycle = Lifecycle()
        val (auth, sessions) = open(values, lifecycle)
        val before = values.kept.toMap()
        auth.prepareSignOut()
        assertEquals(AuthSignOutQuestion(3), auth.signOutQuestion)
        assertTrue(auth.transitionPending)
        assertFalse(sessions.signOutPending)
        assertEquals(before, values.kept)
        auth.cancelSignOut()
        assertFalse(auth.transitionPending)
        assertNull(auth.signOutQuestion)
        assertEquals(AuthStatus.SignedIn(user, false), auth.status)
        assertEquals(before, values.kept)
        assertEquals(1, lifecycle.cancels)
        assertEquals(emptyList<AuthSignOutChoice>(), lifecycle.choices)
    }

    @Test fun allThreeStorageBoundariesReconcileBeforeAndAfterWriteFailuresWithoutReusingTheHandle() = runTest {
        for (point in listOf("initial", "finished", "clear")) for (after in listOf(false, true)) {
            val values = Values(); val lifecycle = Lifecycle()
            val (auth, sessions) = open(values, lifecycle)
            auth.prepareSignOut()
            values.fail = point; values.after = after
            auth.confirmSignOut(AuthSignOutChoice.Discard)
            assertNotNull(auth.signOutFailure)
            assertTrue(auth.transitionPending)
            server.enqueue(MockResponse().setBody("{}"))
            auth.prepareSignOut()
            runCurrent()
            val logout = server.takeRequest(2, java.util.concurrent.TimeUnit.SECONDS)
            assertEquals("/v1/auth/logout", logout?.path)
            assertEquals("Bearer $secret", logout?.getHeader("Authorization"))
            assertEquals("$point after=$after", AuthStatus.SignedOut, auth.status)
            assertFalse(auth.transitionPending)
            assertEquals(listOf(AuthSignOutChoice.Discard), lifecycle.choices)
            assertNull(sessions.read())
            assertNull(sessions.user())
            assertFalse(sessions.signOutPending)
            assertEquals(emptyMap<String, String>(), values.kept)
        }
        assertEquals(6, events.count { it == "auth_signed_out" })
    }

    @Test fun crashAfterEngineFinishBeforeFinishedMarkerRestoresTheOriginalDiscard() = runTest {
        val values = Values(); val lifecycle = Lifecycle()
        val (auth, _) = open(values, lifecycle)
        auth.prepareSignOut(); values.fail = "finished"
        auth.confirmSignOut(AuthSignOutChoice.Discard)
        assertEquals(listOf(AuthSignOutChoice.Discard), lifecycle.choices)
        val restartedSessions = PrefsSessions(values, SecretVault { key }, telemetry)
        assertEquals(SignOutIntent(user.id, AuthSignOutChoice.Discard), restartedSessions.pendingSignOut)
        val restarted = AuthStore(server.url("/"), restartedSessions, telemetry = telemetry, lifecycle = lifecycle, handoffScope = backgroundScope)
        server.enqueue(MockResponse().setBody("{}"))
        restarted.restore()
        assertEquals(AuthStatus.SignedOut, restarted.status)
        assertEquals(1, lifecycle.recoveries)
        assertEquals(listOf(AuthSignOutChoice.Discard), lifecycle.choices)
        assertEquals(1, events.count { it == "auth_signed_out" })
    }

    @Test fun anUnreadableSavedChoiceFinishesAsKeepReportsItsOneReadAndLetsSignInSendACode() = runTest {
        val values = Values(); val lifecycle = Lifecycle()
        val (auth, sessions) = open(values, lifecycle)
        auth.prepareSignOut()
        sessions.beginSignOut(SignOutIntent(user.id, AuthSignOutChoice.Discard))
        values.kept["wm_sign_out.sealed"] = "garbage"
        val reports = mutableListOf<String>()
        val reporting = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { reports += operation }
        }
        val restartedSessions = PrefsSessions(values, SecretVault(reporting) { key }, reporting)
        val restarted = AuthStore(server.url("/"), restartedSessions, telemetry = reporting, lifecycle = lifecycle, handoffScope = backgroundScope)
        server.enqueue(MockResponse().setBody("{}"))
        server.enqueue(MockResponse().setBody("{}"))
        restarted.restore()
        runCurrent()
        restarted.requestLink("b@example.com")
        assertEquals(AuthStatus.SignedOut, restarted.status)
        assertFalse(restarted.transitionPending)
        assertEquals("b@example.com", restarted.linkSentTo)
        assertEquals(listOf(AuthSignOutChoice.Keep), lifecycle.choices)
        assertEquals(listOf("session_open"), reports)
        assertEquals(emptyMap<String, String>(), values.kept)
        assertEquals(setOf("/v1/auth/logout", "/v1/auth/magic-link"),
            setOf(server.takeRequest().path, server.takeRequest().path))
    }

    @Test fun crashAfterFinishedMarkerRetriesOnlyCredentialCleanup() = runTest {
        val values = Values(); val lifecycle = Lifecycle()
        val (auth, _) = open(values, lifecycle)
        auth.prepareSignOut(); lifecycle.failCleanup = true
        auth.confirmSignOut(AuthSignOutChoice.Keep)
        val restartedSessions = PrefsSessions(values, SecretVault { key }, telemetry)
        assertEquals(SignOutIntent(user.id, AuthSignOutChoice.Keep, true), restartedSessions.pendingSignOut)
        val restarted = AuthStore(server.url("/"), restartedSessions, telemetry = telemetry, lifecycle = lifecycle, handoffScope = backgroundScope)
        server.enqueue(MockResponse().setBody("{}")); restarted.restore()
        assertEquals(AuthStatus.SignedOut, restarted.status)
        assertEquals(listOf(AuthSignOutChoice.Keep), lifecycle.choices)
        assertEquals(0, lifecycle.recoveries)
        assertEquals(2, lifecycle.cleanups)
    }

    @Test fun anAccountReplacementCannotBeClearedByCleanupRetry() = runTest {
        val values = Values(); val lifecycle = Lifecycle()
        val (auth, _) = open(values, lifecycle)
        auth.prepareSignOut(); values.fail = "finished"
        auth.confirmSignOut(AuthSignOutChoice.Discard)
        val newer = User("account-b", "b@example.com")
        PrefsSessions(values, SecretVault { key }).commit("session-b", newer)
        auth.prepareSignOut()
        val readback = PrefsSessions(values, SecretVault { key })
        assertEquals("session-b", readback.read())
        assertEquals(newer, readback.user())
        assertEquals(0, lifecycle.cleanups)
        assertEquals(listOf(AuthSignOutChoice.Discard), lifecycle.choices)
        assertTrue(auth.transitionPending)
    }

    @Test fun cancellingTheCallerDoesNotCancelTheApplicationOwnedQuestion() = runTest {
        val values = Values(); val lifecycle = Lifecycle().apply { gate = CompletableDeferred() }
        val (auth, sessions) = open(values, lifecycle)
        val caller = async { auth.prepareSignOut() }
        runCurrent(); assertTrue(auth.transitionPending)
        caller.cancel(); lifecycle.gate!!.complete(Unit); runCurrent()
        assertEquals(AuthSignOutQuestion(3), auth.signOutQuestion)
        assertFalse(sessions.signOutPending)
        auth.cancelSignOut()
        assertFalse(auth.transitionPending)
        assertEquals(1, lifecycle.cancels)
    }

    @Test fun cancellationDuringPreparationDoesNotLeaveAnInvisibleFence() = runTest {
        val owner = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        val values = Values(); val lifecycle = Lifecycle().apply { gate = CompletableDeferred() }
        val (auth, sessions) = open(values, lifecycle, owner)
        val caller = async { auth.prepareSignOut() }
        runCurrent(); owner.cancel(); runCurrent()
        assertTrue(caller.isCancelled)
        assertFalse(auth.transitionPending)
        assertFalse(sessions.signOutPending)
        assertNull(auth.signOutQuestion)
        assertEquals(AuthStatus.SignedIn(user, false), auth.status)
    }
}
