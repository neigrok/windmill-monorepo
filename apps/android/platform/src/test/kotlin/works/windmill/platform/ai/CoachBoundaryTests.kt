package works.windmill.platform.ai

import java.io.File
import java.util.Base64
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withTimeout
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import works.windmill.agent.coach.*
import works.windmill.platform.agent.CoachBackgroundLease
import works.windmill.platform.agent.CoachRuntime
import works.windmill.sync.core.Json

class CoachBoundaryTests {
    private class Reports : Telemetry {
        val turns = mutableListOf<TurnReport>()
        val failures = mutableListOf<FailureOperation>()
        override fun turn(report: TurnReport) { turns += report }
        override fun ability(report: AbilityReport) {}
        override fun failure(operation: FailureOperation) { failures += operation }
    }
    private fun fixture() = Json.parse(File(System.getProperty("windmill.contract"), "ai/wire/fixtures.json").readText())
    private fun profile() = Profile(Json.parse(File(System.getProperty("windmill.contract"), "agent/turns/text.json").readText()).member("profile"))
    private fun event(index: Int, value: Json) = Json.Obj(value.obj().toList() + ("id" to Json.of(index)))
    private fun stream(events: List<Json>) = events.mapIndexed { index, value ->
        "id: ${index + 1}\nevent: ${value.member("event").str()}\ndata: ${value.member("data").jcs}\n\n"
    }.joinToString("")

    @Test fun everySharedWireShapeAndPictureFixtureUsesTheActualClient() = runBlocking {
        val fixtures = fixture()
        fixtures.member("allowances").obj().values.forEach(AiWire::allowance)
        fixtures.member("refusals").arr().forEach { refusal ->
            val body = refusal.member("body")
            assertEquals(body, AiWire.refusal(AiResponse(refusal.member("status").long().toInt(), body)))
            assertNull(AiWire.refusal(AiResponse(502, body)))
        }
        fixtures.member("textEvents").arr().forEachIndexed { index, value -> AiWire.event(event(index + 1, value)) }
        fixtures.member("textTerminals").obj().values.forEach { AiWire.event(event(1, it)) }
        val bytes = stream(fixtures.member("textEvents").arr()).encodeToByteArray()
        val parser = AiSse()
        val parsed = bytes.flatMap { parser.consume(byteArrayOf(it)).toList() }
        parser.finish()
        assertEquals(fixtures.member("textEvents").arr().mapIndexed { i, v -> event(i + 1, v) }, parsed)
        val uploads = fixtures.member("pictureUploads").arr()
        val requests = mutableListOf<AiRequest>()
        val telemetry = Reports()
        val client = CoachAiClient(object : AiTransport {
            override suspend fun pass(body: Json) = AiResponse(200, Json.objectOf("pass" to Json.of("synthetic-pass"), "expiresIn" to Json.of(600000)))
            override suspend fun request(request: AiRequest): AiResponse {
                requests += request
                if (request.path.startsWith("/v1/pictures/")) return AiResponse(204)
                return AiResponse(200, events = flow { fixtures.member("textEvents").arr().take(4).forEachIndexed { i, e -> emit(event(i + 1, e)) } })
            }
        }, telemetry)
        val pictures = uploads.map { Picture(it.member("pictureId").str(), it.member("mediaType").str(), Base64.getDecoder().decode(it.member("data").str())) }
        val answer = client.text("abcdefghijklmnopqrstuv", fixtures.member("textPictureRequest"), pictures, "other", "vector.coach", 1, StopSignal()) {}
        assertTrue(answer is AiAnswer.Terminal)
        assertEquals(listOf("PUT", "PUT", "PUT"), requests.map { it.method })
        for (i in uploads.indices) {
            assertEquals("/v1/pictures/" + pictures[i].pictureId, requests[i].path)
            assertArrayEquals(pictures[i].bytes, requests[i].bytes)
            assertEquals(pictures[i].mediaType, requests[i].mediaType)
        }
        assertEquals(fixtures.member("textPictureRequest"), Json.parse(requests.last().body!!))
        assertEquals(emptyList<FailureOperation>(), telemetry.failures)
    }

    @Test fun httpKeepsCredentialsAtThePassDoorAndRejectsRedirects() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setHeader("Set-Cookie", "forbidden=cookie").setBody("{\"pass\":\"ai-pass\",\"expiresIn\":600000}"))
            server.enqueue(MockResponse().setResponseCode(204))
            server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(stream(fixture().member("textEvents").arr().take(4))))
            val origin = server.url("/").newBuilder().host("127.0.0.1").build()
            AiHttp(origin, { AiCredentials("account-secret", "installation-secret") }, allowLocalHttp = true).use { transport ->
                val client = CoachAiClient(transport, Reports())
                val picture = fixture().member("pictureUploads").arr().first()
                val answer = client.text("abcdefghijklmnopqrstuv", fixture().member("textPictureRequest"), listOf(Picture(picture.member("pictureId").str(), picture.member("mediaType").str(), Base64.getDecoder().decode(picture.member("data").str()))), "other", "vector.coach", 1, StopSignal()) {}
                assertTrue(answer is AiAnswer.Terminal)
                val pass = server.takeRequest()
                assertEquals("/v1/ai/passes", pass.path)
                assertEquals("Bearer account-secret", pass.getHeader("Authorization"))
                assertEquals("installation-secret", pass.getHeader("X-Windmill-Installation"))
                assertNull(pass.getHeader("Cookie"))
                repeat(2) {
                    val request = server.takeRequest()
                    assertEquals("Bearer ai-pass", request.getHeader("Authorization"))
                    assertNull(request.getHeader("X-Windmill-Installation"))
                    assertNull(request.getHeader("Cookie"))
                }
                server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", "https://example.org/capture"))
                try { transport.request(AiRequest("GET", "/v1/allowance", "ai-pass")); fail("redirect accepted") }
                catch (failure: AiTransportFailure) { assertEquals("redirect", failure.code) }
                assertEquals(4, server.requestCount)
            }
        }
    }

    @Test fun localHttpRequiresAnExplicitLiteralLoopbackAndIdsAreBounded() {
        for (origin in listOf("http://127.0.0.1", "http://localhost", "http://example.org", "https://user:secret@example.org", "https://example.org/extra")) {
            assertThrows(IllegalArgumentException::class.java) { AiHttp(origin.toHttpUrl(), { AiCredentials(null, null) }) }
        }
        assertThrows(IllegalArgumentException::class.java) { AiHttp("http://localhost".toHttpUrl(), { AiCredentials(null, null) }, allowLocalHttp = true) }
        for (id in listOf("a".repeat(21), "a".repeat(65), "a/".repeat(12))) assertThrows(IllegalArgumentException::class.java) { Picture(id, "image/png", byteArrayOf()) }
        for (count in listOf(22, 24, 64)) assertEquals(count, Picture("a".repeat(count), "image/png", byteArrayOf()).pictureId.length)
        val runtime = CoachRuntime(CoachBackgroundLease { AutoCloseable {} })
        val ids = (0 until 100).map { runtime.newId() }
        assertEquals(100, ids.distinct().size)
        assertTrue(ids.all { Regex("[A-Za-z0-9_-]{22}").matches(it) })
    }

    @Test fun malformedSseNeverBecomesModelText() {
        for (body in listOf("id: 0\nevent: text\ndata: {\"delta\":\"x\"}\n\n", "id: 1\nevent: text\ndata: {\"delta\":\"x\",\"extra\":1}\n\n", "id: 1\nevent: text\ndata: {\"delta\":\"x\",\"delta\":\"y\"}\n\n")) {
            assertThrows(AiTransportFailure::class.java) { AiSse().consume(body.encodeToByteArray()).toList() }
        }
        assertThrows(AiTransportFailure::class.java) { AiSse().consume(ByteArray(1_048_577) { 97 }).toList() }
        assertThrows(AiTransportFailure::class.java) { AiSse().consume(byteArrayOf(0xc0.toByte(), 0x80.toByte(), 10, 10)).toList() }
        val truncated = AiSse(); truncated.consume("id: 1\nevent: text".encodeToByteArray()).toList()
        assertThrows(AiTransportFailure::class.java) { truncated.finish() }
    }

    @Test fun seatBarrierReleasesTheSlotWhileOldNetworkDrainsAndOldFinallyCannotClearNewTurn() = runBlocking {
        withTimeout(3000) {
            val config = Json.objectOf("history" to Json.of(""), "context" to Json.array())
            val host = ProbeHost(config, null, mutableListOf(), mutableListOf())
            val reports = Reports()
            val entered = List(2) { CompletableDeferred<Unit>() }
            val release = List(2) { CompletableDeferred<Unit>() }
            var calls = 0
            val transport = object : AiTransport {
                override suspend fun pass(body: Json) = AiResponse(200, Json.objectOf("pass" to Json.of("pass"), "expiresIn" to Json.of(600000)))
                override suspend fun request(request: AiRequest): AiResponse {
                    val round = calls++
                    return AiResponse(200, events = flow {
                        entered[round].complete(Unit); release[round].await()
                        emit(Json.objectOf("id" to Json.of(1), "event" to Json.of("text"), "data" to Json.objectOf("delta" to Json.of(if (round == 0) "old" else "new"))))
                        emit(event(2, fixture().member("textEvents").arr()[3]))
                    })
                }
            }
            val runtime = CoachRuntime(CoachBackgroundLease { AutoCloseable {} })
            val runner = TurnRunner(host, CoachAiClient(transport, reports), reports, runtime)
            val old = async { runner.run(TurnInput("old", Seat(SeatKind.bound, "seat-old"), "", emptyList()), profile()) }
            entered[0].await()
            runner.seatWillChange()
            val next = async { runner.run(TurnInput("new", Seat(SeatKind.bound, "seat-new"), "", emptyList()), profile()) }
            entered[1].await()
            release[0].complete(Unit)
            assertEquals(TurnEnd(EndState.interrupted, ""), old.await())
            runner.stop()
            release[1].complete(Unit)
            assertEquals(TurnEnd(EndState.completed, "new"), next.await())
            assertEquals(listOf(EndState.interrupted, EndState.completed), reports.turns.map { it.state })
            assertEquals(emptyList<FailureOperation>(), reports.failures)
        }
    }

    @Test fun aRecordDeletedWhileTextAwaitsItsCommitCannotBeRecreated() = runBlocking {
        withTimeout(3000) {
            val delegate = ProbeHost(Json.objectOf(), null, mutableListOf(), mutableListOf())
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val host = object : ToolHost by delegate {
                override suspend fun text(lease: HostLease, text: String) {
                    entered.complete(Unit); release.await(); delegate.text(lease, text)
                }
            }
            val reports = Reports()
            val transport = object : AiTransport {
                override suspend fun pass(body: Json) = AiResponse(200, Json.objectOf("pass" to Json.of("pass"), "expiresIn" to Json.of(600000)))
                override suspend fun request(request: AiRequest) = AiResponse(200, events = flow {
                    emit(Json.objectOf("id" to Json.of(1), "event" to Json.of("text"), "data" to Json.objectOf("delta" to Json.of("late"))))
                    emit(event(2, fixture().member("textEvents").arr()[3]))
                })
            }
            val runner = TurnRunner(host, CoachAiClient(transport, reports), reports, CoachRuntime(CoachBackgroundLease { AutoCloseable {} }))
            val task = async { runner.run(TurnInput("turn", Seat(SeatKind.bound, "seat"), "", emptyList()), profile()) }
            entered.await(); delegate.delete(); release.complete(Unit)
            assertNull(task.await())
            assertNull(delegate.recover("turn", Seat(SeatKind.bound, "seat")))
            assertEquals(listOf(EndState.interrupted), reports.turns.map { it.state })
            assertEquals(emptyList<FailureOperation>(), reports.failures)
        }
    }

    @Test fun seatBarrierWaitsForPendingOpen() = runBlocking {
        withTimeout(3000) {
            val delegate = ProbeHost(Json.objectOf(), null, mutableListOf(), mutableListOf())
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val host = object : ToolHost by delegate {
                override suspend fun open(input: TurnInput): Opened {
                    entered.complete(Unit); release.await(); return delegate.open(input)
                }
            }
            val reports = Reports()
            var network = 0
            val transport = object : AiTransport {
                override suspend fun pass(body: Json): AiResponse { network++; error("unexpected-pass") }
                override suspend fun request(request: AiRequest): AiResponse { network++; error("unexpected-request") }
            }
            val runner = TurnRunner(host, CoachAiClient(transport, reports), reports, CoachRuntime(CoachBackgroundLease { AutoCloseable {} }))
            val task = async { runner.run(TurnInput("turn", Seat(SeatKind.bound, "seat"), "", emptyList()), profile()) }
            entered.await()
            val barrier = async { runner.seatWillChange() }
            kotlinx.coroutines.yield()
            assertFalse(barrier.isCompleted)
            release.complete(Unit); barrier.await()
            assertEquals(TurnEnd(EndState.interrupted, ""), task.await())
            assertEquals(0, network)
            assertEquals(emptyList<FailureOperation>(), reports.failures)
        }
    }

    @Test fun seatChangeAndStopAreRecheckedAfterTheExecutionAcquiresItsLock() = runBlocking {
        for (seatChange in listOf(true, false)) withTimeout(3000) {
            val abilities = mutableListOf<Json>()
            val marks = mutableListOf<Json>()
            val delegate = ProbeHost(Json.objectOf(), null, marks, abilities)
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val ends = mutableListOf<TurnEnd>()
            val host = object : ToolHost by delegate {
                override suspend fun check(lease: HostLease, rule: String, call: ToolCall): String? {
                    if (rule == "product") { entered.complete(Unit); release.await() }
                    return delegate.check(lease, rule, call)
                }
                override suspend fun end(lease: HostLease, end: TurnEnd) { delegate.end(lease, end); ends += end }
            }
            val story = Json.parse(File(System.getProperty("windmill.contract"), "agent/turns/two-rounds.json").readText())
            val reports = Reports()
            val ai = object : AiClient {
                override fun clearPass() {}
                override suspend fun result(callId: String, use: String, version: Long, stop: StopSignal, onText: suspend (String) -> Unit): AiAnswer = error("unexpected-result")
                override suspend fun text(callId: String, request: Json, pictures: List<Picture>, label: String, use: String, version: Long, stop: StopSignal, onText: suspend (String) -> Unit): AiAnswer {
                    val terminal = story.member("service").member("exchanges").arr().first().member("events").arr().last()
                    return AiAnswer.Terminal("ended", terminal.member("data"))
                }
            }
            val runner = TurnRunner(host, ai, reports, CoachRuntime(CoachBackgroundLease { AutoCloseable {} }))
            val task = async { runner.run(TurnInput("turn", Seat(SeatKind.bound, "seat"), "", emptyList()), Profile(story.member("profile"))) }
            entered.await()
            val mutex = TurnRunner::class.java.getDeclaredField("mutations").apply { isAccessible = true }.get(runner) as Mutex
            mutex.lock()
            release.complete(Unit)
            kotlinx.coroutines.yield()
            val barrier = if (seatChange) async(start = CoroutineStart.UNDISPATCHED) { runner.seatWillChange() } else null
            if (!seatChange) runner.stop()
            mutex.unlock()
            barrier?.await()
            val expected = TurnEnd(if (seatChange) EndState.interrupted else EndState.stopped, "")
            assertEquals(expected, task.await())
            assertEquals(listOf(expected), ends)
            assertEquals(Json.Null, marks.last())
            assertEquals(emptyList<Json>(), abilities)
            assertEquals(emptyList<FailureOperation>(), reports.failures)
        }
    }

    @Test fun newSeatCanFetchItsPassWhileTheOldSeatsPassDoorDrains() = runBlocking {
        withTimeout(3000) {
            val host = ProbeHost(Json.objectOf(), null, mutableListOf(), mutableListOf())
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val reports = Reports()
            var passes = 0
            val transport = object : AiTransport {
                override suspend fun pass(body: Json): AiResponse {
                    val index = ++passes
                    if (index == 1) { entered.complete(Unit); release.await() }
                    return AiResponse(200, Json.objectOf("pass" to Json.of("pass-$index"), "expiresIn" to Json.of(600000)))
                }
                override suspend fun request(request: AiRequest) = AiResponse(200, events = flow { emit(event(1, fixture().member("textEvents").arr()[3])) })
            }
            val runner = TurnRunner(host, CoachAiClient(transport, reports), reports, CoachRuntime(CoachBackgroundLease { AutoCloseable {} }))
            val old = async { runner.run(TurnInput("old", Seat(SeatKind.bound, "old"), "", emptyList()), profile()) }
            entered.await(); runner.seatWillChange()
            val next = runner.run(TurnInput("new", Seat(SeatKind.bound, "new"), "", emptyList()), profile())
            assertEquals(TurnEnd(EndState.completed, ""), next)
            release.complete(Unit)
            assertEquals(TurnEnd(EndState.interrupted, ""), old.await())
            assertEquals(2, passes)
            assertEquals(emptyList<FailureOperation>(), reports.failures)
        }
    }

    @Test fun passDoorConnectionLossIsOfflineAndLateOldPassErrorsAreQuiet() = runBlocking {
        for (code in listOf("offline", "lost")) {
            val reports = Reports()
            val client = CoachAiClient(object : AiTransport {
                override suspend fun pass(body: Json): AiResponse = throw AiTransportFailure(code)
                override suspend fun request(request: AiRequest): AiResponse = error("unexpected-request")
            }, reports)
            val result = client.allowance("vector.coach", 1)
            assertEquals(AiFailure("transport", null, Admission.none), result.second!!.failure)
            assertEquals("offline", accessState(result.second!!.failure))
            assertEquals(emptyList<FailureOperation>(), reports.failures)
        }
        withTimeout(3000) {
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val reports = Reports()
            var passes = 0
            val client = CoachAiClient(object : AiTransport {
                override suspend fun pass(body: Json): AiResponse {
                    if (++passes == 1) { entered.complete(Unit); release.await(); throw AiTransportFailure("transport") }
                    return AiResponse(200, Json.objectOf("pass" to Json.of("new-pass"), "expiresIn" to Json.of(600000)))
                }
                override suspend fun request(request: AiRequest): AiResponse = AiResponse(200, fixture().member("allowance"))
            }, reports)
            val old = async { client.allowance("vector.coach", 1) }
            entered.await(); client.clearPass()
            assertEquals(fixture().member("allowance"), client.allowance("vector.coach", 1).first)
            release.complete(Unit)
            assertEquals(AiFailure("pass", null, Admission.none), old.await().second!!.failure)
            assertEquals(emptyList<FailureOperation>(), reports.failures)
        }
    }

    @Test fun anInvalidatedTurnCannotEnterTheClientUnderTheNewSeatsCredentials() = runBlocking {
        withTimeout(3000) {
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val reports = Reports()
            val requests = mutableListOf<AiRequest>()
            val passes = mutableListOf<String>()
            var identity = "old"
            val client = CoachAiClient(object : AiTransport {
                override suspend fun pass(body: Json): AiResponse {
                    passes += identity
                    return AiResponse(200, Json.objectOf("pass" to Json.of(identity), "expiresIn" to Json.of(600000)))
                }
                override suspend fun request(request: AiRequest): AiResponse {
                    requests += request
                    return AiResponse(200, events = flow { emit(event(1, fixture().member("textEvents").arr()[3])) })
                }
            }, reports)
            val boundary = object : AiClient by client {
                override suspend fun text(callId: String, request: Json, pictures: List<Picture>, label: String, use: String, version: Long, stop: StopSignal, onText: suspend (String) -> Unit): AiAnswer {
                    entered.complete(Unit); release.await()
                    return client.text(callId, request, pictures, label, use, version, stop, onText)
                }
            }
            val host = ProbeHost(Json.objectOf(), null, mutableListOf(), mutableListOf())
            val runner = TurnRunner(host, boundary, reports, CoachRuntime(CoachBackgroundLease { AutoCloseable {} }))
            val old = async { runner.run(TurnInput("old", Seat(SeatKind.bound, "old"), "old question", emptyList()), profile()) }
            entered.await(); runner.seatWillChange(); identity = "new"; release.complete(Unit)
            assertEquals(TurnEnd(EndState.interrupted, ""), old.await())
            assertEquals(emptyList<String>(), passes)
            assertEquals(emptyList<AiRequest>(), requests)
            assertEquals(TurnEnd(EndState.completed, ""), runner.run(TurnInput("new", Seat(SeatKind.bound, "new"), "new question", emptyList()), profile()))
            assertEquals(listOf("new"), passes)
            assertEquals(listOf("new"), requests.map { it.pass })
            assertEquals(Json.parse("""[{"role":"user","parts":[{"text":"Question: new question"}]}]"""), Json.parse(requests.single().body!!).member("messages"))
            assertEquals(emptyList<FailureOperation>(), reports.failures)
        }
    }

    @Test fun malformedRefusalAllowancesAreTransportLossAtBothPreparationDoors() = runBlocking {
        for (picture in listOf(false, true)) for (code in listOf("subject_exhausted", "pass_expired")) {
            val reports = Reports()
            val paths = mutableListOf<String>()
            val client = CoachAiClient(object : AiTransport {
                override suspend fun pass(body: Json) = AiResponse(200, Json.objectOf("pass" to Json.of("pass"), "expiresIn" to Json.of(600000)))
                override suspend fun request(request: AiRequest): AiResponse {
                    paths += request.path
                    return AiResponse(429, Json.objectOf("code" to Json.of(code), "allowance" to Json.objectOf("bogus" to Json.of(true))))
                }
            }, reports)
            val answer = if (picture) client.text("AAAAAAAAAAAAAAAAAAAAAA", Json.objectOf(), listOf(Picture("BBBBBBBBBBBBBBBBBBBBBB", "image/png", byteArrayOf(1))), "other", "vector.coach", 1, StopSignal()) {}
                else client.allowance("vector.coach", 1).second
            assertEquals(AiAnswer.Failure(AiFailure("transport", null, Admission.none)), answer)
            assertEquals(emptyList<FailureOperation>(), reports.failures)
            assertEquals(listOf(if (picture) "/v1/pictures/BBBBBBBBBBBBBBBBBBBBBB" else "/v1/allowance"), paths)
        }
    }

    @Test fun passCacheExpiresAtRefreshBoundaryAndSeatChangeDropsThePass() = runBlocking {
        var now = 0L; var passes = 0
        val requests = mutableListOf<AiRequest>()
        val transport = object : AiTransport {
            override suspend fun pass(body: Json): AiResponse { passes++; return AiResponse(200, Json.objectOf("pass" to Json.of("pass-$passes"), "expiresIn" to Json.of(600000))) }
            override suspend fun request(request: AiRequest): AiResponse { requests += request; return AiResponse(200, fixture().member("allowance")) }
        }
        val client = CoachAiClient(transport, Reports(), now = { now })
        assertNotNull(client.allowance("vector.coach", 1).first)
        now = 540_000; assertNotNull(client.allowance("vector.coach", 1).first)
        assertEquals(1, passes)
        now++; assertNotNull(client.allowance("vector.coach", 1).first)
        assertEquals(2, passes)
        client.clearPass(); assertNotNull(client.allowance("vector.coach", 1).first)
        assertEquals(listOf("pass-1", "pass-1", "pass-2", "pass-3"), requests.map { it.pass })
    }
}
