package works.windmill.gym.net

import works.windmill.gym.coach.AskQuestion
import works.windmill.gym.coach.AskGeneration
import works.windmill.gym.coach.CoachAttachment
import works.windmill.gym.coach.CoachResult
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import okio.Source
import okio.Timeout
import okio.buffer
import org.junit.Assert.*
import org.junit.Test
import works.windmill.gym.domain.*
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson

class CoachTransportTests {
    @Test
    fun utf8FragmentsHeartbeatsAndReplaysProduceFullReplacementSnapshotsInRevisionOrder() {
        val initial = AskGeneration("generation-a", "request-a", "Question", "running", "Café", revision = 1)
        val latest = initial.copy(answer = "Café — fuller answer 🏋️", revision = 3)
        val done = latest.copy(status = "completed", revision = 4)
        val input = Buffer().writeUtf8(": keepalive\r\n\r\n" + listOf(initial, latest, initial.copy(answer = "stale", revision = 2), latest, done).joinToString("") {
            "event: snapshot\r\nid: ${it.id}:${it.revision}\r\ndata: ${WindmillJson.encodeToString(CoachSnapshotResponse.serializer(), CoachSnapshotResponse("thread-a", it))}\r\n\r\n"
        })
        val source = object : Source {
            override fun read(sink: Buffer, byteCount: Long) = input.read(sink, minOf(1, byteCount))
            override fun timeout() = Timeout.NONE
            override fun close() = input.close()
        }.buffer()
        val seen = mutableListOf<AskGeneration>()
        assertEquals(done, CoachEvents.read(source, "thread-a", "request-a", seen::add))
        assertEquals(listOf(initial, latest, done), seen)
    }

    @Test
    fun eofRetainsThePartialSnapshotAndNeverInventsCompletion() {
        val partial = AskGeneration("generation-a", "request-a", "Question", "running", "Keep this", revision = 2)
        val seen = mutableListOf<AskGeneration>()
        val body = Buffer().writeUtf8("event: snapshot\ndata: ${WindmillJson.encodeToString(CoachSnapshotResponse.serializer(), CoachSnapshotResponse("thread-a", partial))}\n\n")
        assertThrows(IOException::class.java) { CoachEvents.read(body, "thread-a", "request-a", seen::add) }
        assertEquals(listOf(partial), seen)
    }

    @Test
    fun aForeignSnapshotCannotBeDisplayedAndARefusalKeepsItsCode() {
        val other = AskGeneration("generation-a", "request-other", "Question", "completed", "Private", revision = 1)
        val body = Buffer().writeUtf8("event: snapshot\ndata: ${WindmillJson.encodeToString(CoachSnapshotResponse.serializer(), CoachSnapshotResponse("thread-a", other))}\n\n")
        assertThrows(WindmillApiException.Malformed::class.java) { CoachEvents.read(body, "thread-a", "request-a") { fail("Foreign snapshot") } }
        val refusal = Buffer().writeUtf8("event: error\ndata: {\"error\":\"Later\",\"status\":429,\"code\":\"ask-daily-limit\"}\n\n")
        val error = assertThrows(WindmillApiException.Refused::class.java) { CoachEvents.read(refusal, "thread-a", "request-a") { fail("No generation") } }
        assertEquals(429, error.status)
        assertEquals("ask-daily-limit", error.refusal.code)
        assertEquals("Later", error.line)
    }

    @Test
    fun theHttpStreamDeliversVisibleTextBeforeCompletionAndKeepsAuthOutOfTheUrl() = runBlocking {
        val server = MockWebServer()
        server.start()
        try {
            val partial = AskGeneration("generation-a", "request-a", "Question", "running", "First words", revision = 1)
            val done = partial.copy(status = "stopped", revision = 2)
            val first = "event: snapshot\ndata: ${WindmillJson.encodeToString(CoachSnapshotResponse.serializer(), CoachSnapshotResponse("thread-a", partial))}\n\n"
            val last = "event: snapshot\ndata: ${WindmillJson.encodeToString(CoachSnapshotResponse.serializer(), CoachSnapshotResponse("thread-a", done))}\n\n"
            server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(first + last)
                .throttleBody(first.toByteArray().size.toLong(), 1, TimeUnit.SECONDS))
            val gym = GymHttp(WindmillApi(server.url("/"), { "private-bearer" }))
            val visible = CompletableDeferred<AskGeneration>()
            val seen = mutableListOf<AskGeneration>()
            val result = async { gym.stream(AskQuestion("thread-a", "Question", "request-a")) { seen += it; visible.complete(it) } }
            assertEquals(partial, visible.await())
            assertFalse(result.isCompleted)
            assertEquals(done.response(), result.await())
            assertEquals(listOf(partial, done), seen)
            val request = server.takeRequest()
            assertEquals("/v1/gym/ask", request.path)
            assertEquals("Bearer private-bearer", request.getHeader("Authorization"))
            assertEquals("text/event-stream", request.getHeader("Accept"))
            assertEquals("""{"thread":"thread-a","question":"Question","requestId":"request-a","attachmentIds":[],"stream":true}""", request.body.readUtf8())
        } finally { server.shutdown() }
    }

    @Test
    fun malformedStreamIsReportedWithoutThePrivateJsonDecoderMessage() = runBlocking {
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream")
                .setBody("event: snapshot\ndata: {\"private\":\"training question\"}\n\n"))
            val gym = GymHttp(WindmillApi(server.url("/"), { null }))
            val error = runCatching { gym.stream(AskQuestion("thread-a", "Question", "request-a")) {} }.exceptionOrNull()
            assertEquals(WindmillApiException.Malformed, error)
            assertNull(error?.cause)
        } finally { server.shutdown() }
    }

    @Test
    fun aBurstKeepsOnlyTheNewestSnapshotWhileTheConsumerSavesAndDrainsItBeforeEofFailure() = runBlocking {
        for (terminal in listOf(true, false)) {
            val first = AskGeneration("generation-a", "request-a", "Question", "running", "First", revision = 1)
            val generations = (2..100).map { revision -> first.copy(revision = revision.toLong(),
                answer = "Café 東京 مرحبًا 🏋🏽‍♀️ e\u0301\n".repeat(revision),
                status = if (terminal && revision == 100) "completed" else "running",
                results = listOf(CoachResult("routine-created", "operation-a", "routine-a", "Routine"))) }
            fun event(value: AskGeneration) = "event: snapshot\ndata: ${WindmillJson.encodeToString(CoachSnapshotResponse.serializer(), CoachSnapshotResponse("thread-a", value))}\n\n"
            val beginning = Buffer().writeUtf8(event(first))
            val remainder = Buffer().writeUtf8(generations.joinToString("") { event(it) })
            val consumer = java.util.concurrent.CountDownLatch(1)
            val parsed = CompletableDeferred<Unit>()
            val source = object : Source {
                override fun read(sink: Buffer, byteCount: Long): Long {
                    if (beginning.size > 0) return beginning.read(sink, byteCount)
                    check(consumer.await(5, TimeUnit.SECONDS))
                    return remainder.read(sink, byteCount)
                }
                override fun timeout() = Timeout.NONE
                override fun close() { parsed.complete(Unit) }
            }.buffer()
            val client = okhttp3.OkHttpClient.Builder().addInterceptor { chain ->
                okhttp3.Response.Builder().request(chain.request()).protocol(okhttp3.Protocol.HTTP_1_1).code(200).message("OK")
                    .header("Content-Type", "text/event-stream").body(object : okhttp3.ResponseBody() {
                        override fun contentType() = null
                        override fun contentLength() = -1L
                        override fun source() = source
                    }).build()
            }.build()
            val gym = GymHttp(WindmillApi(okhttp3.HttpUrl.Builder().scheme("http").host("localhost").build(), { null }, client))
            val seen = mutableListOf<AskGeneration>()
            val result = runCatching {
                kotlinx.coroutines.withTimeout(5_000) {
                    gym.stream(AskQuestion("thread-a", "Question", "request-a")) {
                        seen += it
                        if (it.revision == 1L) { consumer.countDown(); parsed.await() }
                    }
                }
            }
            assertEquals(listOf(first, generations.last()), seen)
            if (terminal) assertEquals(generations.last().response(), result.getOrThrow())
            else assertTrue(result.exceptionOrNull() is WindmillApiException.Transport)
        }
    }

    @Test
    fun stopUsesTheOriginalRequestIdentityAndReturnsTheAuthoritativeSnapshot() = runBlocking {
        val server = MockWebServer()
        server.start()
        try {
            val stopped = AskGeneration("generation-a", "request-a", "Question", "stopped", "Partial answer", revision = 4)
            server.enqueue(MockResponse().setBody(WindmillJson.encodeToString(CoachSnapshotResponse.serializer(), CoachSnapshotResponse("thread-a", stopped))))
            val gym = GymHttp(WindmillApi(server.url("/"), { "private-bearer" }))
            assertEquals(stopped, gym.stop("thread-a", "request-a"))
            val request = server.takeRequest()
            assertEquals("POST", request.method)
            assertEquals("/v1/gym/threads/thread-a/generations/request-a/stop", request.path)
            assertEquals("", request.body.readUtf8())
            assertEquals("Bearer private-bearer", request.getHeader("Authorization"))
        } finally { server.shutdown() }
    }

    @Test
    fun photoUploadAndPrivateReloadUseTheSameAuthenticatedAttachmentIdentity() = runBlocking {
        val server = MockWebServer()
        server.start()
        try {
            val photo = CoachAttachment("attachment-a", "image/png", 2, 1, 5)
            val bytes = byteArrayOf(1, 2, 3, 4, 5)
            server.enqueue(MockResponse().setBody(WindmillJson.encodeToString(CoachPhotoResponse.serializer(), CoachPhotoResponse(photo))))
            server.enqueue(MockResponse().setHeader("Content-Type", "image/png").setBody(Buffer().write(bytes)))
            val gym = GymHttp(WindmillApi(server.url("/"), { "private-bearer" }))
            val progress = mutableListOf<Float>()
            assertEquals(photo, gym.uploadPhoto("thread-a", photo, bytes, progress::add))
            assertArrayEquals(bytes, gym.photo("thread-a", photo.id))
            assertEquals(listOf(1f), progress)
            val put = server.takeRequest()
            val get = server.takeRequest()
            assertEquals("PUT", put.method)
            assertEquals("GET", get.method)
            assertArrayEquals(bytes, put.body.readByteArray())
            assertEquals("image/png", put.getHeader("Content-Type"))
            for (request in listOf(put, get)) {
                assertEquals("/v1/gym/threads/thread-a/attachments/attachment-a", request.path)
                assertEquals("Bearer private-bearer", request.getHeader("Authorization"))
            }
        } finally { server.shutdown() }
    }
    @Test fun routineConfirmationUsesTheOriginalIdentityAndEmptyBody() = runBlocking {
        val server = MockWebServer()
        server.start()
        try {
            val draft = works.windmill.gym.coach.CoachRoutineDraft("operation-a", "routine-a", "Push", 1,
                listOf(RoutineEntry(1, "dumbbell-bench-press", listOf(SetTarget(8, 16.0)))), "saved")
            val generation = AskGeneration("generation-a", "request-a", "Question", "completed", revision = 4, routineDrafts = listOf(draft))
            val reply = works.windmill.gym.coach.CoachRoutineConfirmation("thread-a", generation)
            val pending = generation.copy(routineDrafts = listOf(draft.copy(state = "pending")))
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json")
                .setBody("""{"answer":"Review this routine.","read":{},"generation":${WindmillJson.encodeToString(AskGeneration.serializer(), pending)}}"""))
            val pendingAnswer = GymHttp(WindmillApi(server.url("/"), { "private-bearer" })).ask(AskQuestion("thread-a", "Question", "request-a"))
            assertEquals(pending.routineDrafts, pendingAnswer.routineDrafts)
            assertEquals("/v1/gym/ask", server.takeRequest().path)
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json")
                .setBody(WindmillJson.encodeToString(works.windmill.gym.coach.CoachRoutineConfirmation.serializer(), reply)))
            val events = mutableListOf<Pair<String, Map<String, String>>>()
            val failures = mutableListOf<Pair<String, Throwable>>()
            val telemetry = object : works.windmill.platform.telemetry.Telemetry {
                override fun event(name: String, properties: Map<String, String>) { events += name to properties }
                override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation to error }
            }
            val gym = GymHttp(WindmillApi(server.url("/"), { "private-bearer" }, telemetry = telemetry))
            assertEquals(reply, gym.confirmRoutine("thread-a", "request-a", "operation-a"))
            val request = server.takeRequest()
            assertEquals("POST", request.method)
            assertEquals("/v1/gym/threads/thread-a/generations/request-a/routines/operation-a/confirm", request.path)
            assertEquals("{}", request.body.readUtf8())
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json")
                .setBody(WindmillJson.encodeToString(works.windmill.gym.coach.CoachRoutineConfirmation.serializer(), reply.copy(thread = "foreign-thread"))))
            assertTrue(runCatching { gym.confirmRoutine("thread-a", "request-a", "operation-a") }.exceptionOrNull() is WindmillApiException.Malformed)
            assertEquals(listOf("gym_coach_routine_confirm" to WindmillApiException.Malformed), failures)
            assertEquals(listOf("api_request_failed" to mapOf("method" to "POST", "route" to "/v1/gym", "failure_kind" to "malformed",
                "operation" to "gym_coach_routine_confirm", "network_phase" to "response_body")), events.map { it.first to (it.second - "duration_ms") })
            assertTrue(events.single().second.getValue("duration_ms").toLong() >= 0)
        } finally { server.shutdown() }
    }

}
