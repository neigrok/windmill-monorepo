package works.windmill.platform.ai

import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import works.windmill.agent.coach.*
import works.windmill.sync.core.Json

class CoachRetryTests {
    private class Reports : Telemetry {
        val failures = mutableListOf<FailureOperation>()
        override fun turn(report: TurnReport) {}
        override fun ability(report: AbilityReport) {}
        override fun failure(operation: FailureOperation) { failures += operation }
    }
    private fun fixture() = Json.parse(File(System.getProperty("windmill.contract"), "ai/wire/fixtures.json").readText())
    private fun terminal() = Json.Obj(fixture().member("textEvents").arr()[3].obj().toList() + ("id" to Json.of(2)))
    private fun refusal(code: String): AiResponse {
        val value = fixture().member("refusals").arr().single { it.member("body").member("code").str() == code }
        return AiResponse(value.member("status").long().toInt(), Json.objectOf("code" to Json.of(code), "allowance" to Json.Null))
    }

    @Test fun firstRoundWithNoReportedConnectionSendsNothingAndOnlyAFirstRoundAsks() = runBlocking {
        for (firstRound in listOf(true, false)) {
            var asked = 0
            val sent = mutableListOf<String>()
            val reports = Reports()
            val client = CoachAiClient(object : AiTransport {
                override suspend fun pass(body: Json): AiResponse {
                    sent += "pass"
                    return AiResponse(200, Json.objectOf("pass" to Json.of("pass"), "expiresIn" to Json.of(600000)))
                }
                override suspend fun request(request: AiRequest): AiResponse { sent += request.path; throw AiTransportFailure("offline") }
            }, reports, now = { 0 }, connected = { asked++; false })
            val answer = client.text("AAAAAAAAAAAAAAAAAAAAAA", Json.objectOf(), listOf(Picture("BBBBBBBBBBBBBBBBBBBBBB", "image/png", byteArrayOf(1))), "other", "vector.coach", 1, StopSignal(), firstRound) {}
            assertEquals(AiAnswer.Failure(AiFailure("transport", null, Admission.none)), answer)
            assertEquals(if (firstRound) 1 else 0, asked)
            assertEquals(if (firstRound) emptyList() else listOf("pass", "/v1/pictures/BBBBBBBBBBBBBBBBBBBBBB"), sent)
            assertEquals(emptyList<FailureOperation>(), reports.failures)
        }
    }

    @Test fun lostCallSurvivesTemporaryPassRefreshFailures() = runBlocking {
        for (failure in listOf("offline", "rate_limited", "unavailable")) {
            var now = 0L
            var passes = 0
            val requests = mutableListOf<AiRequest>()
            val waits = mutableListOf<Long>()
            val reports = Reports()
            val client = CoachAiClient(object : AiTransport {
                override suspend fun pass(body: Json): AiResponse {
                    if (++passes == 2) {
                        if (failure == "offline") throw AiTransportFailure("offline")
                        return AiResponse(if (failure == "rate_limited") 429 else 503, Json.objectOf("code" to Json.of(failure), "error" to Json.of("Refused")))
                    }
                    return AiResponse(200, Json.objectOf("pass" to Json.of("pass-$passes"), "expiresIn" to Json.of(60000)))
                }
                override suspend fun request(request: AiRequest): AiResponse {
                    requests += request
                    if (requests.size == 1) throw AiTransportFailure("lost")
                    return AiResponse(200, events = flow { emit(terminal()) })
                }
            }, reports, now = { now }, wait = { ms, _ -> waits += ms; now += ms; true })
            assertTrue(failure, client.text("AAAAAAAAAAAAAAAAAAAAAA", Json.objectOf("value" to Json.of(1)), emptyList(), "other", "vector.coach", 1, StopSignal()) {} is AiAnswer.Terminal)
            assertEquals(listOf(1000L, 2000L), waits)
            assertEquals(3, passes)
            assertEquals(listOf("PUT", "PUT"), requests.map { it.method })
            assertEquals(requests.first().body, requests.last().body)
            assertEquals(emptyList<FailureOperation>(), reports.failures)
        }
    }

    @Test fun temporaryPassLossAfterPossibleAdmissionUsesTheOriginalRecoveryDeadline() = runBlocking {
        for (code in listOf("busy", "accounting_unavailable")) {
            var now = 0L
            var passes = 0
            var calls = 0
            val reports = Reports()
            val client = CoachAiClient(object : AiTransport {
                override suspend fun pass(body: Json): AiResponse {
                    if (++passes > 1) throw AiTransportFailure("offline")
                    return AiResponse(200, Json.objectOf("pass" to Json.of("pass"), "expiresIn" to Json.of(60001)))
                }
                override suspend fun request(request: AiRequest): AiResponse { calls++; return refusal(code) }
            }, reports, now = { now }, wait = { ms, _ -> now += ms; true })
            assertEquals(AiAnswer.Failure(AiFailure("result", "answer-timeout", Admission.possible)), client.text("AAAAAAAAAAAAAAAAAAAAAA", Json.objectOf(), emptyList(), "other", "vector.coach", 1, StopSignal()) {})
            assertEquals(1_200_000L, now)
            assertEquals(1, calls)
            assertEquals(emptyList<FailureOperation>(), reports.failures)
        }
    }

    @Test fun stopInterruptsSuspendedRecoveryPreparationAndRetryHeaders() = runBlocking {
        for (boundary in listOf("pass", "picture", "headers")) withTimeout(3000) {
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            var now = 0L
            var passes = 0
            var uploads = 0
            var calls = 0
            val reports = Reports()
            val stop = StopSignal()
            val client = CoachAiClient(object : AiTransport {
                override suspend fun pass(body: Json): AiResponse {
                    if (++passes == 2) { entered.complete(Unit); release.await() }
                    return AiResponse(200, Json.objectOf("pass" to Json.of("pass"), "expiresIn" to Json.of(if (boundary == "pass") 60001 else 600000)))
                }
                override suspend fun request(request: AiRequest): AiResponse {
                    if (request.path.startsWith("/v1/pictures/")) {
                        if (++uploads == 2) { entered.complete(Unit); release.await() }
                        return AiResponse(204)
                    }
                    if (++calls == 1) throw AiTransportFailure("lost")
                    if (boundary == "picture") return refusal("picture_gone")
                    entered.complete(Unit); release.await()
                    return AiResponse(200, events = flow { emit(terminal()) })
                }
            }, reports, now = { now }, wait = { ms, _ -> now += ms; true })
            val pictures = if (boundary == "picture") listOf(Picture("BBBBBBBBBBBBBBBBBBBBBB", "image/png", byteArrayOf(1))) else emptyList()
            val task = async { client.text("AAAAAAAAAAAAAAAAAAAAAA", Json.objectOf(), pictures, "other", "vector.coach", 1, stop) {} }
            entered.await(); stop.stop()
            assertEquals(AiAnswer.Failure(AiFailure("result", "stopped", Admission.possible)), task.await())
            assertFalse(release.isCompleted)
            assertEquals(emptyList<FailureOperation>(), reports.failures)
        }
    }

    @Test fun stopStillDrainsTheInitialTextRequestAndItsEvents() = runBlocking {
        withTimeout(3000) {
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val stop = StopSignal()
            val reports = Reports()
            val client = CoachAiClient(object : AiTransport {
                override suspend fun pass(body: Json) = AiResponse(200, Json.objectOf("pass" to Json.of("pass"), "expiresIn" to Json.of(600000)))
                override suspend fun request(request: AiRequest): AiResponse {
                    entered.complete(Unit); release.await()
                    return AiResponse(200, events = flow { emit(terminal()) })
                }
            }, reports)
            val task = async { client.text("AAAAAAAAAAAAAAAAAAAAAA", Json.objectOf(), emptyList(), "other", "vector.coach", 1, stop) {} }
            entered.await(); stop.stop()
            assertFalse(task.isCompleted)
            release.complete(Unit)
            assertTrue(task.await() is AiAnswer.Terminal)
            assertEquals(emptyList<FailureOperation>(), reports.failures)
        }
    }

    @Test fun passRefreshCannotResetTheLostCallsDeadlineAndStopWakesItsRetry() = runBlocking {
        for (stopDuringWait in listOf(false, true)) {
            var now = 0L
            var passes = 0
            var requests = 0
            val stop = StopSignal()
            val reports = Reports()
            val client = CoachAiClient(object : AiTransport {
                override suspend fun pass(body: Json): AiResponse {
                    if (++passes > 1) throw AiTransportFailure("offline")
                    return AiResponse(200, Json.objectOf("pass" to Json.of("pass"), "expiresIn" to Json.of(60000)))
                }
                override suspend fun request(request: AiRequest): AiResponse { requests++; throw AiTransportFailure("lost") }
            }, reports, now = { now }, wait = { ms, signal ->
                if (stopDuringWait && passes == 2) signal.stop()
                if (signal.stopped) false else { now += ms; true }
            })
            val answer = client.text("AAAAAAAAAAAAAAAAAAAAAA", Json.objectOf(), emptyList(), "other", "vector.coach", 1, stop) {}
            assertEquals(AiAnswer.Failure(AiFailure("result", if (stopDuringWait) "stopped" else "answer-timeout", Admission.possible)), answer)
            assertEquals(if (stopDuringWait) 1000L else 1_200_000L, now)
            assertEquals(1, requests)
            assertEquals(emptyList<FailureOperation>(), reports.failures)
        }
    }

    @Test fun proxyErrorsAndUnvalidatedRefusalsRetryTheSamePutWithoutAnIssue() = runBlocking {
        for (body in listOf("<html>Bad gateway</html>", "{\"code\":\"subject_exhausted\"}", "{\"code\":\"unknown\",\"allowance\":null}", "{\"code\":\"subject_exhausted\",\"allowance\":{}}")) {
            MockWebServer().use { server ->
                server.enqueue(MockResponse().setBody("{\"pass\":\"pass\",\"expiresIn\":600000}"))
                server.enqueue(MockResponse().setResponseCode(502).setHeader("Content-Type", "text/html").setBody(body))
                val event = terminal()
                server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody("id: 2\nevent: ended\ndata: ${event.member("data").jcs}\n\n"))
                var now = 0L
                val reports = Reports()
                val waits = mutableListOf<Long>()
                AiHttp(server.url("/").newBuilder().host("127.0.0.1").build(), { AiCredentials(null, null) }, allowLocalHttp = true).use { transport ->
                    val client = CoachAiClient(transport, reports, now = { now }, wait = { ms, _ -> waits += ms; now += ms; true })
                    assertTrue(body, client.text("AAAAAAAAAAAAAAAAAAAAAA", Json.objectOf("value" to Json.of(1)), emptyList(), "other", "vector.coach", 1, StopSignal()) {} is AiAnswer.Terminal)
                }
                assertEquals(3, server.requestCount)
                server.takeRequest()
                val first = server.takeRequest()
                val second = server.takeRequest()
                assertEquals("PUT", second.method)
                assertEquals(first.path, second.path)
                assertEquals(first.body.readUtf8(), second.body.readUtf8())
                assertEquals(listOf(1000L), waits)
                assertEquals(emptyList<FailureOperation>(), reports.failures)
            }
        }
    }

    @Test fun proxyPassErrorsFailPreparationButKeepAnUncertainCallAlive() = runBlocking {
        for (dispatched in listOf(false, true)) MockWebServer().use { server ->
            if (dispatched) {
                server.enqueue(MockResponse().setBody("{\"pass\":\"pass\",\"expiresIn\":60000}"))
                server.enqueue(MockResponse().setResponseCode(502).setBody("<html>Bad gateway</html>"))
            }
            server.enqueue(MockResponse().setResponseCode(503).setBody("<html>Unavailable</html>"))
            if (dispatched) {
                server.enqueue(MockResponse().setBody("{\"pass\":\"new-pass\",\"expiresIn\":600000}"))
                server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody("id: 2\nevent: ended\ndata: ${terminal().member("data").jcs}\n\n"))
            }
            var now = 0L
            val reports = Reports()
            val waits = mutableListOf<Long>()
            AiHttp(server.url("/").newBuilder().host("127.0.0.1").build(), { AiCredentials(null, null) }, allowLocalHttp = true).use { transport ->
                val client = CoachAiClient(transport, reports, now = { now }, wait = { ms, _ -> waits += ms; now += ms; true })
                val answer = client.text("AAAAAAAAAAAAAAAAAAAAAA", Json.objectOf(), emptyList(), "other", "vector.coach", 1, StopSignal()) {}
                if (dispatched) assertTrue(answer is AiAnswer.Terminal)
                else assertEquals(AiAnswer.Failure(AiFailure("transport", null, Admission.none)), answer)
            }
            assertEquals(if (dispatched) listOf(1000L, 2000L) else emptyList(), waits)
            assertEquals(if (dispatched) 5 else 1, server.requestCount)
            assertEquals(emptyList<FailureOperation>(), reports.failures)
        }
    }

    @Test fun resentPutTransientRefusalsKeepTheirOriginalThirtySecondWindow() = runBlocking {
        for (code in listOf("paused", "concurrency_exhausted", "provider_unavailable")) {
            var now = 0L
            val requests = mutableListOf<AiRequest>()
            val reports = Reports()
            val client = CoachAiClient(object : AiTransport {
                override suspend fun pass(body: Json) = AiResponse(200, Json.objectOf("pass" to Json.of("pass"), "expiresIn" to Json.of(600000)))
                override suspend fun request(request: AiRequest): AiResponse {
                    requests += request
                    if (requests.size == 1) throw AiTransportFailure("lost")
                    return refusal(code)
                }
            }, reports, now = { now }, wait = { ms, _ -> now += ms; true })
            assertEquals(AiAnswer.Failure(AiFailure("text", code, Admission.possible)), client.text("AAAAAAAAAAAAAAAAAAAAAA", Json.objectOf(), emptyList(), "other", "vector.coach", 1, StopSignal()) {})
            assertEquals(30000L, now)
            assertEquals(6, requests.size)
            assertEquals(listOf("PUT"), requests.map { it.method }.distinct())
            assertEquals(emptyList<FailureOperation>(), reports.failures)
        }
    }

    @Test fun recoveryCallUnknownIsQuietWhileLiveCallUnknownIsADefect() = runBlocking {
        for (recover in listOf(false, true)) {
            val reports = Reports()
            val requests = mutableListOf<String>()
            val client = CoachAiClient(object : AiTransport {
                override suspend fun pass(body: Json) = AiResponse(200, Json.objectOf("pass" to Json.of("pass"), "expiresIn" to Json.of(600000)))
                override suspend fun request(request: AiRequest): AiResponse { requests += request.method; return refusal("call_unknown") }
            }, reports)
            val answer = if (recover) client.result("AAAAAAAAAAAAAAAAAAAAAA", "vector.coach", 1, StopSignal()) {}
                else client.text("AAAAAAAAAAAAAAAAAAAAAA", Json.objectOf(), emptyList(), "other", "vector.coach", 1, StopSignal()) {}
            assertEquals(AiAnswer.Failure(AiFailure(if (recover) "result" else "text", "call_unknown", if (recover) Admission.admitted else Admission.none)), answer)
            assertEquals(listOf(if (recover) "GET" else "PUT"), requests)
            assertEquals(if (recover) emptyList() else listOf(FailureOperation.aiCall), reports.failures)
        }
    }

    @Test fun nonServicePictureRepairResponseKeepsTheUncertainCallAndItsDeadline() = runBlocking {
        var now = 0L
        var uploads = 0
        val requests = mutableListOf<AiRequest>()
        val waits = mutableListOf<Long>()
        val reports = Reports()
        val client = CoachAiClient(object : AiTransport {
            override suspend fun pass(body: Json) = AiResponse(200, Json.objectOf("pass" to Json.of("pass"), "expiresIn" to Json.of(600000)))
            override suspend fun request(request: AiRequest): AiResponse {
                if (request.path.startsWith("/v1/pictures/")) return if (++uploads == 2) AiResponse(503) else AiResponse(204)
                requests += request
                if (requests.size == 1) throw AiTransportFailure("lost")
                if (requests.size == 2) return refusal("picture_gone")
                return AiResponse(200, events = flow { emit(terminal()) })
            }
        }, reports, now = { now }, wait = { ms, _ -> waits += ms; now += ms; true })
        assertTrue(client.text("AAAAAAAAAAAAAAAAAAAAAA", Json.objectOf("value" to Json.of(1)), listOf(Picture("BBBBBBBBBBBBBBBBBBBBBB", "image/png", byteArrayOf(1))), "other", "vector.coach", 1, StopSignal()) {} is AiAnswer.Terminal)
        assertEquals(3, uploads)
        assertEquals(listOf("PUT", "PUT", "PUT"), requests.map { it.method })
        assertEquals(listOf(Json.objectOf("value" to Json.of(1)).jcs), requests.map { it.body }.distinct())
        assertEquals(listOf(1000L, 2000L), waits)
        assertEquals(emptyList<FailureOperation>(), reports.failures)
    }

    @Test fun malformedSuccessfulAllowanceAndEventRemainWireDefects() = runBlocking {
        for (allowance in listOf(true, false)) {
            val reports = Reports()
            val client = CoachAiClient(object : AiTransport {
                override suspend fun pass(body: Json) = AiResponse(200, Json.objectOf("pass" to Json.of("pass"), "expiresIn" to Json.of(600000)))
                override suspend fun request(request: AiRequest) = if (allowance) AiResponse(200, Json.objectOf()) else AiResponse(200, events = flow { emit(Json.objectOf()) })
            }, reports)
            val answer = if (allowance) client.allowance("vector.coach", 1).second else client.text("AAAAAAAAAAAAAAAAAAAAAA", Json.objectOf(), emptyList(), "other", "vector.coach", 1, StopSignal()) {}
            assertEquals(AiAnswer.Failure(AiFailure("wire", "invalid-answer", if (allowance) Admission.none else Admission.possible)), answer)
            assertEquals(listOf(FailureOperation.aiCall), reports.failures)
        }
    }

    @Test fun slowCredentialRefreshAndPictureRepairCannotDispatchPastTheLostCallsDeadline() = runBlocking {
        for (boundary in listOf("pass", "picture")) {
            var now = 0L
            var passes = 0
            var uploads = 0
            var calls = 0
            val reports = Reports()
            val client = CoachAiClient(object : AiTransport {
                override suspend fun pass(body: Json): AiResponse {
                    if (++passes == 2) now = 1_200_000L
                    return AiResponse(200, Json.objectOf("pass" to Json.of("pass"), "expiresIn" to Json.of(if (boundary == "pass") 60000 else 600000)))
                }
                override suspend fun request(request: AiRequest): AiResponse {
                    if (request.path.startsWith("/v1/pictures/")) {
                        if (++uploads == 2) now = 1_200_000L
                        return AiResponse(204)
                    }
                    if (++calls == 1) throw AiTransportFailure("lost")
                    if (boundary == "picture" && calls == 2) return refusal("picture_gone")
                    return AiResponse(200, events = flow { emit(terminal()) })
                }
            }, reports, now = { now }, wait = { ms, _ -> now += ms; true })
            val pictures = if (boundary == "picture") listOf(Picture("BBBBBBBBBBBBBBBBBBBBBB", "image/png", byteArrayOf(1))) else emptyList()
            assertEquals(AiAnswer.Failure(AiFailure("result", "answer-timeout", Admission.possible)), client.text("AAAAAAAAAAAAAAAAAAAAAA", Json.objectOf(), pictures, "other", "vector.coach", 1, StopSignal()) {})
            assertEquals(if (boundary == "pass") 1 else 2, calls)
            assertEquals(1_200_000L, now)
            assertEquals(emptyList<FailureOperation>(), reports.failures)
        }
    }

    @Test fun offlinePreparationHasNoAdmissionButCachedPassTextDispatchIsUncertain() = runBlocking {
        for (boundary in listOf("pass", "picture", "text")) {
            var now = 0L
            val reports = Reports()
            val requests = mutableListOf<String>()
            val client = CoachAiClient(object : AiTransport {
                override suspend fun pass(body: Json): AiResponse {
                    if (boundary == "pass") throw AiTransportFailure("offline")
                    return AiResponse(200, Json.objectOf("pass" to Json.of("pass"), "expiresIn" to Json.of(600000)))
                }
                override suspend fun request(request: AiRequest): AiResponse {
                    requests += request.path
                    if (request.path == "/v1/allowance") return AiResponse(200, fixture().member("allowance"))
                    throw AiTransportFailure("offline")
                }
            }, reports, now = { now }, wait = { ms, _ -> now += ms; false })
            if (boundary == "text") assertNotNull(client.allowance("vector.coach", 1).first)
            val pictures = if (boundary == "picture") listOf(Picture("BBBBBBBBBBBBBBBBBBBBBB", "image/png", byteArrayOf(1))) else emptyList()
            val answer = client.text("AAAAAAAAAAAAAAAAAAAAAA", Json.objectOf(), pictures, "other", "vector.coach", 1, StopSignal()) {}
            assertEquals(if (boundary == "text") AiAnswer.Failure(AiFailure("result", "stopped", Admission.possible)) else AiAnswer.Failure(AiFailure("transport", null, Admission.none)), answer)
            assertEquals(if (boundary == "text") 1000L else 0L, now)
            assertEquals(emptyList<FailureOperation>(), reports.failures)
        }
    }
}
