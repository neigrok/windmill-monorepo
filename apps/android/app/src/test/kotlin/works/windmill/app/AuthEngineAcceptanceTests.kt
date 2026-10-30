package works.windmill.app

import android.app.Application
import kotlinx.coroutines.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.store.GymEngineSession
import works.windmill.platform.User
import works.windmill.platform.auth.*
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.core.RecordID
import works.windmill.sync.engine.*
import works.windmill.sync.schema.SyncSchema

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class AuthEngineAcceptanceTests {
    @Test fun cancelAfterActualEngineAcceptanceKeepsTheAcceptedCredentialAndPriorWork() = acceptedRetirement(false)
    @Test fun replacementAfterActualEngineAcceptanceUsesTheAcceptedOwnerEvenWhenVerificationRefuses() = acceptedRetirement(true)

    private fun acceptedRetirement(replacing: Boolean) = runBlocking {
        val application = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val prior = User("A", "a@example.com")
        val accepted = User("B", "b@example.com")
        val scope = ScopeRef.product("gym")
        val engine = Engine.memory(SyncSchema.registry)
        fun movement(id: String) {
            engine.commit(scope) { Gesture(listOf(Change.create("exercise", NewID.Given(RecordID(id)),
                mapOf("name" to Json.of(id), "pattern" to Json.of("isolation"), "equipment" to Json.of("barbell"), "stepKg" to Json.of(2.5))))) to Unit }
            engine.releaseHeld(true)
        }
        engine.signIn("A", mapOf("gym" to false))
        movement("prior-movement")
        assertTrue(engine.signOut("keep").member("complete").bool())
        val retainedA = engine.snapshot().member("replicas").arr().single { it.member("meta")["account"] == Json.of("A") }
        movement("phone-movement")
        val tokens = object : SessionTokens {
            private val values = mutableMapOf("A" to "sealed-A")
            override fun token(account: String) = values[account]
            override fun save(account: String, token: String) { values[account] = token }
            override fun delete(account: String) { values.remove(account) }
            override fun accounts() = values.keys.toSet()
        }
        val transport = object : SyncTransport {
            override suspend fun hello(token: String?) = Reply.Answer(SyncResponse(200, Json.objectOf(
                "serverTime" to Json.of(System.currentTimeMillis()), "epoch" to Json.of("epoch"),
                "schema" to Json.of(SyncSchema.registry.version), "minSchema" to Json.of(SyncSchema.registry.minVersion),
                "as" to Json.of("B"), "holdsRecords" to Json.objectOf("gym" to Json.of(false)))))
            override suspend fun push(request: Json, token: String) = Reply.Unreachable
            override suspend fun pull(request: Json, token: String?) = Reply.Unreachable
            override suspend fun openLive(token: String) = Reply.Unreachable
        }
        GymEngineSession(engine, SyncRuntime(engine, transport, tokens, "test", products = listOf("gym"))).use { delegate ->
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val completed = mutableListOf<Boolean>()
            val identities = mutableListOf<String?>()
            val failures = mutableListOf<String>()
            val lifecycle = object : AuthLifecycle {
                override suspend fun signedIn(user: User, token: String, restoring: Boolean) {
                    delegate.signedIn(user, token, restoring)
                    entered.complete(Unit)
                    withContext(NonCancellable) { release.await() }
                }
                override suspend fun cancelSignIn(user: User, token: String): Boolean = delegate.cancelSignIn(user, token).also { completed += it }
                override suspend fun signOut() = delegate.signOut()
            }
            val sessions = MemorySessions("sealed-A", prior).apply { stage(ProposedSignIn("sealed-B", accepted)) }
            val telemetry = object : Telemetry {
                override fun identity(userId: String?) { identities += userId }
                override fun event(name: String, properties: Map<String, String>) = Unit
                override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
            }
            MockWebServer().use { server ->
                server.start()
                val auth = AuthStore(server.url("/"), sessions, telemetry = telemetry, lifecycle = lifecycle, handoffScope = application)
                val original = async { runCatching { auth.restore() } }
                try {
                    withTimeout(10_000) { entered.await() }
                    val bound = engine.snapshot().let { snapshot -> snapshot.member("replicas").arr().single { it.member("meta").member("replica") == snapshot.member("active") } }
                    assertEquals(Json.of("B"), bound.member("meta")["account"])
                    assertEquals("sealed-A", sessions.read())
                    val openingRevision = auth.handoffRevision
                    if (replacing) server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
                    val retire = async {
                        if (replacing) runCatching { auth.completeCode("c@example.com", "123456") }
                        else runCatching { auth.cancelPendingSignIn() }
                    }
                    yield()
                    assertFalse(retire.isCompleted)
                    release.complete(Unit)
                    val result = retire.await()
                    if (replacing) {
                        assertTrue(result.exceptionOrNull() is WindmillApiException)
                        val request = server.takeRequest()
                        assertEquals("/v1/auth/verify-code", request.path)
                        assertEquals("Bearer sealed-B", request.getHeader("Authorization"))
                    } else assertTrue(result.isSuccess)
                    assertTrue(original.await().exceptionOrNull() is CancellationException)
                    assertEquals(listOf(true), completed)
                    assertEquals(AuthHandoffResult.Retired, auth.handoffResult)
                    assertFalse(auth.handoffPending)
                    assertFalse(auth.awaitExistingHandoff(openingRevision))
                    assertEquals(LocalSession.Owned(accepted), sessions.localSession)
                    assertEquals("sealed-B", sessions.read()); assertNull(sessions.proposed)
                    assertEquals(AuthStatus.SignedIn(accepted), auth.status)
                    assertEquals(listOf("B"), identities)
                    assertTrue(failures.isEmpty())
                    assertEquals(retainedA, engine.snapshot().member("replicas").arr().single { it.member("meta")["account"] == Json.of("A") })
                    assertEquals(listOf("phone-movement"), engine.read(scope) { it.drawn("exercise").filter { row -> row.id == RecordID("phone-movement") }.map { row -> row.id.string } })
                    assertEquals("sealed-B", tokens.token("B"))
                } finally { release.complete(Unit); application.cancel() }
            }
        }
    }
}
