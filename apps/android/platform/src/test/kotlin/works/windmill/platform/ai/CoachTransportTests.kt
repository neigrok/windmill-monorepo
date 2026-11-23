package works.windmill.platform.ai

import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.flow.flow
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import works.windmill.agent.coach.*
import works.windmill.sync.core.Json

class CoachTransportTests {
    private class Reports : Telemetry {
        override fun turn(report: TurnReport) {}
        override fun ability(report: AbilityReport) {}
        val failures = mutableListOf<FailureOperation>()
        override fun failure(operation: FailureOperation, cause: Throwable?, code: String?) { failures += operation }
    }
    private fun fixture() = Json.parse(File(System.getProperty("windmill.contract"), "ai/wire/fixtures.json").readText())
    private fun terminal() = Json.Obj(fixture().member("textEvents").arr()[3].obj().toList() + ("id" to Json.of(2)))

    @Test fun stopDuringRecoveryWaitForConcurrentPassCompletesPromptly() = runBlocking {
        withTimeout(5000) {
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val reports = Reports()
            val client = CoachAiClient(object : AiTransport {
                override suspend fun pass(body: Json): AiResponse {
                    entered.complete(Unit)
                    release.await()
                    return AiResponse(200, Json.objectOf("pass" to Json.of("pass"), "expiresIn" to Json.of(600000)))
                }
                override suspend fun request(request: AiRequest) = AiResponse(200, fixture().member("allowance"))
            }, reports)
            val allowance = async { client.allowance("vector.coach", 1) }
            entered.await()
            val stop = StopSignal()
            val recovery = async(start = CoroutineStart.UNDISPATCHED) { client.result("AAAAAAAAAAAAAAAAAAAAAA", "vector.coach", 1, stop) {} }
            stop.stop()
            val prompt = withTimeoutOrNull(500) { recovery.await() }
            release.complete(Unit)
            assertEquals(fixture().member("allowance"), allowance.await().first)
            val result = recovery.await()
            assertEquals(AiAnswer.Failure(AiFailure("result", "stopped", Admission.admitted)), result)
            assertNotNull("Stop waited for the unrelated allowance pass request to release passLock", prompt)
            assertEquals(emptyList<FailureOperation>(), reports.failures)
        }
    }

    @Test fun stopDuringRetryErrorBodyCompletesPromptly() = runBlocking {
        withTimeout(10000) {
            MockWebServer().use { server ->
                server.enqueue(MockResponse().setBody("{\"pass\":\"pass\",\"expiresIn\":600000}"))
                server.enqueue(MockResponse().setResponseCode(502).setBody("<html>Bad gateway</html>"))
                server.enqueue(MockResponse().setResponseCode(502).setBody("<html>Still bad</html>").setBodyDelay(4, TimeUnit.SECONDS))
                val transport = AiHttp(server.url("/").newBuilder().host("127.0.0.1").build(), { AiCredentials(null, null) }, allowLocalHttp = true)
                try {
                    val stop = StopSignal()
                    val reports = Reports()
                    val client = CoachAiClient(transport, reports, wait = { _, _ -> true })
                    val call = async { client.text("AAAAAAAAAAAAAAAAAAAAAA", Json.objectOf(), emptyList(), "other", "vector.coach", 1, stop) {} }
                    while (server.requestCount < 3) delay(10)
                    delay(100)
                    stop.stop()
                    val prompt = withTimeoutOrNull(500) { call.await() }
                    transport.close()
                    val result = call.await()
                    assertEquals(AiAnswer.Failure(AiFailure("result", "stopped", Admission.possible)), result)
                    assertNotNull("Stop waited for the non-200 HTTP body instead of cancelling its socket", prompt)
                    assertEquals(emptyList<FailureOperation>(), reports.failures)
                } finally { transport.close() }
            }
        }
    }

    @Test fun refreshLossAfterTheTransientDeadlineReturnsThePriorRefusal() = runBlocking {
        var now = 0L
        var passes = 0
        var calls = 0
        val reports = Reports()
        val client = CoachAiClient(object : AiTransport {
            override suspend fun pass(body: Json): AiResponse {
                passes++
                if (passes == 2) { now = 31_000; throw AiTransportFailure("offline") }
                return AiResponse(200, Json.objectOf("pass" to Json.of("pass"), "expiresIn" to Json.of(if (passes == 1) 60001 else 600000)))
            }
            override suspend fun request(request: AiRequest): AiResponse {
                calls++
                if (calls == 1) return AiResponse(503, Json.objectOf("code" to Json.of("busy"), "allowance" to Json.Null))
                return AiResponse(200, events = flow { emit(terminal()) })
            }
        }, reports, now = { now }, wait = { ms, _ -> now += ms; true })
        val result = client.text("AAAAAAAAAAAAAAAAAAAAAA", Json.objectOf(), emptyList(), "other", "vector.coach", 1, StopSignal()) {}
        assertEquals(AiAnswer.Failure(AiFailure("text", "busy", Admission.possible)), result)
        assertEquals(2, passes)
        assertEquals(1, calls)
        assertEquals(emptyList<FailureOperation>(), reports.failures)
    }

    @Test fun malformedPassRefusalsCannotEndAnUncertainCall() = runBlocking {
        for (badResponse in listOf(
            AiResponse(401, Json.objectOf("code" to Json.of("unauthenticated"))),
            AiResponse(503, Json.objectOf("code" to Json.of("unauthenticated"), "error" to Json.of("Refused")))
        )) {
            var now = 0L
            var passes = 0
            var calls = 0
            val reports = Reports()
            val client = CoachAiClient(object : AiTransport {
                override suspend fun pass(body: Json): AiResponse {
                    passes++
                    if (passes == 2) return badResponse
                    return AiResponse(200, Json.objectOf("pass" to Json.of("pass"), "expiresIn" to Json.of(if (passes == 1) 60001 else 600000)))
                }
                override suspend fun request(request: AiRequest): AiResponse {
                    calls++
                    if (calls == 1) throw AiTransportFailure("lost")
                    return AiResponse(200, events = flow { emit(terminal()) })
                }
            }, reports, now = { now }, wait = { ms, _ -> now += ms; true })
            val result = client.text("AAAAAAAAAAAAAAAAAAAAAA", Json.objectOf(), emptyList(), "other", "vector.coach", 1, StopSignal()) {}
            assertTrue("Malformed pass refusal ended an uncertain call: $result", result is AiAnswer.Terminal)
            assertEquals("a 5xx that names no refusal is the door failing, and reported", if (badResponse.status >= 500) listOf(FailureOperation.aiPass) else emptyList(), reports.failures)
        }
    }

    @Test fun malformedRefusalStatusCannotProveNoAdmission() = runBlocking {
        var count = 0
        val reports = Reports()
        val client = CoachAiClient(object : AiTransport {
            override suspend fun pass(body: Json) = AiResponse(200, Json.objectOf("pass" to Json.of("pass"), "expiresIn" to Json.of(600000)))
            override suspend fun request(request: AiRequest): AiResponse {
                count++
                if (count == 1) return AiResponse(502, Json.objectOf("code" to Json.of("subject_exhausted"), "allowance" to Json.Null))
                return AiResponse(200, events = flow { emit(terminal()) })
            }
        }, reports, wait = { _, _ -> true })
        val result = client.text("AAAAAAAAAAAAAAAAAAAAAA", Json.objectOf(), emptyList(), "other", "vector.coach", 1, StopSignal()) {}
        assertTrue("Expected retry after invalid code/status pair, got $result", result is AiAnswer.Terminal)
        assertEquals(2, count)
        assertEquals(emptyList<FailureOperation>(), reports.failures)
    }

    @Test fun aRetryDispatchedBeforeTheRefusalDeadlineCanBecomeUncertainAfterIt() = runBlocking {
        var now = 0L
        var calls = 0
        val waits = mutableListOf<Long>()
        val reports = Reports()
        val client = CoachAiClient(object : AiTransport {
            override suspend fun pass(body: Json) = AiResponse(200, Json.objectOf("pass" to Json.of("pass"), "expiresIn" to Json.of(600000)))
            override suspend fun request(request: AiRequest): AiResponse {
                if (++calls == 1) return AiResponse(503, Json.objectOf("code" to Json.of("busy"), "allowance" to Json.Null))
                if (calls == 2) { now = 31_000; throw AiTransportFailure("lost") }
                return AiResponse(200, events = flow { emit(terminal()) })
            }
        }, reports, now = { now }, wait = { ms, _ -> waits += ms; now += ms; true })
        assertTrue(client.text("AAAAAAAAAAAAAAAAAAAAAA", Json.objectOf(), emptyList(), "other", "vector.coach", 1, StopSignal()) {} is AiAnswer.Terminal)
        assertEquals(3, calls)
        assertEquals(listOf(1000L, 2000L), waits)
        assertEquals(33_000L, now)
        assertEquals(emptyList<FailureOperation>(), reports.failures)
    }

    @Test fun aCompletePassRefusalRetainsTheCallsAdmissionEvidence() = runBlocking {
        var now = 0L
        var passes = 0
        var calls = 0
        val reports = Reports()
        val client = CoachAiClient(object : AiTransport {
            override suspend fun pass(body: Json): AiResponse {
                if (++passes == 2) return AiResponse(401, Json.objectOf("code" to Json.of("unauthenticated"), "error" to Json.of("Refused")))
                return AiResponse(200, Json.objectOf("pass" to Json.of("pass"), "expiresIn" to Json.of(60001)))
            }
            override suspend fun request(request: AiRequest): AiResponse { calls++; throw AiTransportFailure("lost") }
        }, reports, now = { now }, wait = { ms, _ -> now += ms; true })
        assertEquals(AiAnswer.Failure(AiFailure("pass", "unauthenticated", Admission.possible)), client.text("AAAAAAAAAAAAAAAAAAAAAA", Json.objectOf(), emptyList(), "other", "vector.coach", 1, StopSignal()) {})
        assertEquals(2, passes)
        assertEquals(1, calls)
        assertEquals(emptyList<FailureOperation>(), reports.failures)
    }
}
