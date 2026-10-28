package works.windmill.platform.ai

import java.io.IOException
import javax.crypto.KeyGenerator
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import works.windmill.platform.User
import works.windmill.platform.auth.AuthLifecycle
import works.windmill.platform.auth.KeptValues
import works.windmill.platform.auth.MemorySessions
import works.windmill.platform.auth.SecretVault
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson
import works.windmill.platform.telemetry.Telemetry
import works.windmill.platform.telemetry.TelemetryPolicy

class AiInstallationTest {
    private val credential = "A".repeat(43)
    private val allowance = AiAllowance("ok", "USD", "lifetime", "anonymous", true, "0.015000000", "0.000000000", "0.000000000", "0.015000000")
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val values = Values()
    private val telemetry = Events()
    private val api = Api()
    private fun store() = AiInstallation(values, SecretVault { key }, api, telemetry)

    @Test fun importAndInstallationEventsAcceptOnlyTheirFiniteLabels() {
        assertEquals(mapOf("outcome" to "committed"), TelemetryPolicy.eventProperties("gym_coach_import",
            mapOf("outcome" to "committed", "recordId" to "private-record", "fingerprint" to "private-fingerprint")))
        assertEquals(emptyMap<String, String>(), TelemetryPolicy.eventProperties("gym_coach_import", mapOf("outcome" to credential)))
        assertEquals(mapOf("action" to "bind", "outcome" to "refused"), TelemetryPolicy.eventProperties("ai_installation_outcome",
            mapOf("action" to "bind", "outcome" to "refused", "requestId" to "private-request")))
    }

    private class Values : KeptValues {
        val kept = mutableMapOf<String, String>()
        var fail = false
        override fun read(key: String) = kept[key]
        override fun write(values: Map<String, String?>) {
            if (fail) throw IOException("fixture-write")
            values.forEach { (key, value) -> if (value == null) kept.remove(key) else kept[key] = value }
        }
    }

    private class Events : Telemetry {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val issues = mutableListOf<String>()
        override fun event(name: String, properties: Map<String, String>) { events += name to properties }
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { issues += operation }
    }

    private inner class Api : AiInstallationApi {
        var issues = 0
        var reads = 0
        val bindings = mutableListOf<Pair<String, String>>()
        var bound = false
        var currentFailure: WindmillApiException? = null
        var bindFailure: WindmillApiException? = null
        var issueWait: CompletableDeferred<Unit>? = null
        var issueFailure: WindmillApiException? = null
        var bindWait: CompletableDeferred<Unit>? = null
        override suspend fun issue(): AiInstallationResponse {
            issues += 1
            issueWait?.await()
            issueFailure?.let { throw it }
            return AiInstallationResponse(false, allowance, credential)
        }
        override suspend fun current(credential: String): AiInstallationResponse {
            assertEquals(this@AiInstallationTest.credential, credential)
            reads += 1
            currentFailure?.let { throw it }
            return AiInstallationResponse(bound, allowance)
        }
        override suspend fun bind(credential: String, token: String): AiInstallationResponse {
            bindings += credential to token
            bindWait?.await()
            bindFailure?.let { throw it }
            bound = true
            return AiInstallationResponse(true, allowance)
        }
    }

    private suspend fun refusal(code: String, block: suspend () -> Unit) {
        try { block(); fail("expected refusal") }
        catch (failure: WindmillApiException.Refused) { assertEquals(code, failure.refusal.code) }
    }

    @Test fun credentialIsSealedAndSignOutKeepsItWhileRelaunchRefreshesUnknownBinding() = runTest {
        assertEquals(credential, store().forAnonymousSend())
        val sealed = values.kept.values.single()
        assertFalse(sealed.contains(credential))
        assertFalse(String(java.util.Base64.getDecoder().decode(sealed), Charsets.ISO_8859_1).contains(credential))
        MemorySessions("account-secret", User("account", "fixture@example.invalid")).clear()
        assertEquals(credential, store().forAnonymousSend())
        assertEquals(1, api.issues)
        assertEquals(1, api.reads)
        assertEquals(sealed, values.kept.values.single())
        assertTrue(telemetry.issues.isEmpty())
    }

    @Test fun concurrentCallsIssueOnceAndRecoverAPersistenceFailureWithoutReplacement() = runTest {
        val installation = store()
        api.issueWait = CompletableDeferred()
        val one = async { runCatching { installation.forAnonymousSend() } }
        val two = async { runCatching { installation.forAnonymousSend() } }
        runCurrent()
        assertEquals(1, api.issues)
        values.fail = true
        api.issueWait!!.complete(Unit)
        assertTrue(one.await().isFailure)
        assertTrue(two.await().isFailure)
        assertNull(values.kept["installation.sealed"])
        assertTrue(values.kept.isEmpty())
        values.fail = false
        assertEquals(credential, installation.forAnonymousSend())
        assertEquals(1, api.issues)
    }

    @Test fun unreadableOrInvalidCredentialsNeverMintAReplacement() = runTest {
        values.kept["installation.sealed"] = "unreadable"
        assertTrue(runCatching { store().forAnonymousSend() }.isFailure)
        assertEquals(0, api.issues)
        assertEquals(listOf("ai_installation"), telemetry.issues)
        values.kept.clear()
        store().forAnonymousSend()
        api.currentFailure = WindmillApiException.Refused(401, Refusal(code = "invalid_installation"))
        refusal("invalid_installation") { store().forAnonymousSend() }
        api.currentFailure = null
        refusal("invalid_installation") { store().forAnonymousSend() }
        refusal("invalid_installation") { store().forRecovery() }
        assertEquals(1, api.issues)
        assertEquals(1, api.reads)
    }

    @Test fun boundInstallationSurvivesSignOutAndStillRecoversPendingResults() = runTest {
        val installation = store()
        installation.forAnonymousSend()
        installation.bind("account-a", "token-a")
        installation.bind("account-a", "token-a")
        assertEquals(listOf(credential to "token-a"), api.bindings)
        val restored = store()
        refusal("device_bound") { restored.forAnonymousSend() }
        assertEquals(credential, restored.forRecovery())
        assertEquals(1, api.issues)
        assertEquals(0, api.reads)
    }

    @Test fun anotherAccountBindingMarksBoundWithoutReplacingCredential() = runTest {
        val installation = store()
        installation.forAnonymousSend()
        api.bindFailure = WindmillApiException.Refused(409, Refusal(code = "installation_bound"))
        installation.bind("account-b", "token-b")
        refusal("device_bound") { store().forAnonymousSend() }
        assertEquals(credential, store().forRecovery())
        assertEquals(1, api.issues)
        assertTrue(telemetry.issues.isEmpty())
    }

    @Test fun bindingFailureDoesNotHoldSignInOrEraseInstallationOnSignOut() = runTest {
        val installation = store()
        installation.forAnonymousSend()
        api.bindFailure = WindmillApiException.Refused(503, Refusal(code = "anonymous_ai_unavailable"))
        val calls = mutableListOf<String>()
        val lifecycle = AiInstallationLifecycle(object : AuthLifecycle {
            override suspend fun signedIn(user: User, token: String, restoring: Boolean) { calls += "signed-in" }
            override suspend fun signOut() { calls += "signed-out" }
        }, installation, backgroundScope, telemetry)
        lifecycle.signedIn(User("account", "fixture@example.invalid"), "token", false)
        assertEquals(listOf("signed-in"), calls)
        runCurrent()
        assertEquals(listOf("ai_installation_outcome" to mapOf("action" to "bind", "outcome" to "refused")), telemetry.events)
        lifecycle.signOut()
        assertEquals(listOf("signed-in", "signed-out"), calls)
        assertEquals(credential, store().forRecovery())
        refusal("device_bound") { store().forAnonymousSend() }
    }

    @Test fun acceptedSignInPersistsBindingIntentBeforeTheNetworkAnswerWithoutHoldingSignOut() = runTest {
        val installation = store()
        installation.forAnonymousSend()
        api.bindWait = CompletableDeferred()
        val calls = mutableListOf<String>()
        val lifecycle = AiInstallationLifecycle(object : AuthLifecycle {
            override suspend fun signedIn(user: User, token: String, restoring: Boolean) { calls += "signed-in" }
            override suspend fun signOut() { calls += "signed-out" }
        }, installation, backgroundScope, telemetry)
        lifecycle.signedIn(User("account", "fixture@example.invalid"), "token", false)
        assertEquals(listOf("signed-in"), calls)
        assertEquals(listOf(credential to "token"), api.bindings)
        assertEquals("{\"credential\":\"$credential\",\"bound\":true}", SecretVault { key }.open(values.kept.getValue("installation.sealed")))
        lifecycle.signOut()
        assertEquals(listOf("signed-in", "signed-out"), calls)
        api.bindWait!!.complete(Unit)
        runCurrent()
        refusal("device_bound") { store().forAnonymousSend() }
        assertEquals(credential, store().forRecovery())
        assertEquals(1, api.issues)
    }

    @Test fun firstSignInIssuesAndBindsOnceAndRestartCannotStartAnonymousWork() = runTest {
        api.issueWait = CompletableDeferred()
        val calls = mutableListOf<String>()
        val lifecycle = AiInstallationLifecycle(object : AuthLifecycle {
            override suspend fun signedIn(user: User, token: String, restoring: Boolean) { calls += "signed-in" }
            override suspend fun signOut() { calls += "signed-out" }
        }, store(), backgroundScope, telemetry)
        lifecycle.signedIn(User("account", "fixture@example.invalid"), "token", false)
        lifecycle.signOut()
        refusal("device_bound") { store().forAnonymousSend() }
        assertEquals(1, api.issues)
        assertTrue(api.bindings.isEmpty())
        api.issueWait!!.complete(Unit)
        runCurrent()
        assertEquals(listOf("signed-in", "signed-out"), calls)
        assertEquals(1, api.issues)
        assertEquals(listOf(credential to "token"), api.bindings)
        assertEquals("bound", SecretVault { key }.open(values.kept.getValue("binding.sealed")))
        refusal("device_bound") { store().forAnonymousSend() }
        assertEquals(credential, store().forRecovery())
        assertEquals(1, api.issues)
    }

    @Test fun firstSignInWithUnavailableOrLostIssuanceRetainsTheBoundIntentAcrossSignOutAndRestart() = runTest {
        for (failure in listOf(WindmillApiException.Refused(503, Refusal(code = "anonymous_ai_unavailable")),
            WindmillApiException.Timeout(IOException("fixture")))) {
            values.kept.clear(); api.issues = 0; api.bindings.clear(); api.issueFailure = failure
            val calls = mutableListOf<String>()
            val lifecycle = AiInstallationLifecycle(object : AuthLifecycle {
                override suspend fun signedIn(user: User, token: String, restoring: Boolean) { calls += "signed-in" }
                override suspend fun signOut() { calls += "signed-out" }
            }, store(), backgroundScope, telemetry)
            lifecycle.signedIn(User("account", "fixture@example.invalid"), "token", false)
            lifecycle.signOut()
            runCurrent()
            assertEquals(listOf("signed-in", "signed-out"), calls)
            assertEquals("bound", SecretVault { key }.open(values.kept.getValue("binding.sealed")))
            assertNull(values.kept["installation.sealed"])
            refusal("device_bound") { store().forAnonymousSend() }
            assertEquals(1, api.issues)
            assertTrue(api.bindings.isEmpty())
            api.issueFailure = null
            store().bind("account", "token")
            assertEquals(2, api.issues)
            assertEquals(listOf(credential to "token"), api.bindings)
        }
    }

    @Test fun processDeathDuringFreshBindingKeepsAnonymousAccessBlockedAndCanRetryUnusedIssuance() = runTest {
        api.issueWait = CompletableDeferred()
        val process = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        val lifecycle = AiInstallationLifecycle(AuthLifecycle.None, store(), process, telemetry)
        lifecycle.signedIn(User("account", "fixture@example.invalid"), "token", false)
        lifecycle.signOut()
        assertEquals(1, api.issues)
        process.cancel()
        runCurrent()
        refusal("device_bound") { store().forAnonymousSend() }
        assertEquals(1, api.issues)
        assertTrue(api.bindings.isEmpty())
        assertNull(values.kept["installation.sealed"])
        assertEquals("bound", SecretVault { key }.open(values.kept.getValue("binding.sealed")))
        api.issueWait = null
        store().bind("account", "token")
        assertEquals(2, api.issues)
        assertEquals(listOf(credential to "token"), api.bindings)
        assertEquals(credential, store().forRecovery())
    }

    @Test fun transportSeparatesInstallationAndAccountCredentialsAndExpectedRefusalsHaveNoIssues() = runTest {
        MockWebServer().use { server ->
            server.start()
            val http = AiInstallationHttp(server.url("/"), telemetry)
            for (reply in listOf(AiInstallationResponse(false, allowance, credential), AiInstallationResponse(false, allowance), AiInstallationResponse(true, allowance)))
                server.enqueue(MockResponse().setBody(WindmillJson.encodeToString(AiInstallationResponse.serializer(), reply)))
            assertEquals(AiInstallationResponse(false, allowance, credential), http.issue())
            assertEquals(AiInstallationResponse(false, allowance), http.current(credential))
            assertEquals(AiInstallationResponse(true, allowance), http.bind(credential, "account-token"))
            val issue = server.takeRequest()
            assertEquals("POST", issue.method)
            assertEquals("/v1/ai/installations", issue.path)
            assertEquals("{}", issue.body.readUtf8())
            assertNull(issue.getHeader("Authorization"))
            assertNull(issue.getHeader("X-Windmill-Installation"))
            val current = server.takeRequest()
            assertEquals("/v1/ai/installations/current", current.path)
            assertEquals(credential, current.getHeader("X-Windmill-Installation"))
            assertNull(current.getHeader("Authorization"))
            val bind = server.takeRequest()
            assertEquals("/v1/ai/installations/bind", bind.path)
            assertEquals("{}", bind.body.readUtf8())
            assertEquals(credential, bind.getHeader("X-Windmill-Installation"))
            assertEquals("Bearer account-token", bind.getHeader("Authorization"))
            server.enqueue(MockResponse().setResponseCode(503).setBody("{\"code\":\"anonymous_ai_unavailable\"}"))
            refusal("anonymous_ai_unavailable") { http.current(credential) }
            assertTrue(telemetry.issues.isEmpty())
            server.enqueue(MockResponse().setResponseCode(503).setBody("{\"code\":\"ai_accounting_unavailable\"}"))
            refusal("ai_accounting_unavailable") { http.current(credential) }
            assertEquals(listOf("ai_installation"), telemetry.issues)
            assertFalse(telemetry.events.toString().contains(credential))
            assertFalse(telemetry.events.toString().contains("account-token"))
        }
    }
}
