package works.windmill.gym.net

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
            "event: snapshot\r\nid: ${it.id}:${it.revision}\r\ndata: ${WindmillJson.encodeToString(CoachSnapshotOut.serializer(), CoachSnapshotOut("thread-a", it))}\r\n\r\n"
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
        val body = Buffer().writeUtf8("event: snapshot\ndata: ${WindmillJson.encodeToString(CoachSnapshotOut.serializer(), CoachSnapshotOut("thread-a", partial))}\n\n")
        assertThrows(IOException::class.java) { CoachEvents.read(body, "thread-a", "request-a", seen::add) }
        assertEquals(listOf(partial), seen)
    }

    @Test
    fun aForeignSnapshotCannotBeDisplayedAndARefusalKeepsItsCode() {
        val other = AskGeneration("generation-a", "request-other", "Question", "completed", "Private", revision = 1)
        val body = Buffer().writeUtf8("event: snapshot\ndata: ${WindmillJson.encodeToString(CoachSnapshotOut.serializer(), CoachSnapshotOut("thread-a", other))}\n\n")
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
            val first = "event: snapshot\ndata: ${WindmillJson.encodeToString(CoachSnapshotOut.serializer(), CoachSnapshotOut("thread-a", partial))}\n\n"
            val last = "event: snapshot\ndata: ${WindmillJson.encodeToString(CoachSnapshotOut.serializer(), CoachSnapshotOut("thread-a", done))}\n\n"
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
    fun stopUsesTheOriginalRequestIdentityAndReturnsTheAuthoritativeSnapshot() = runBlocking {
        val server = MockWebServer()
        server.start()
        try {
            val stopped = AskGeneration("generation-a", "request-a", "Question", "stopped", "Partial answer", revision = 4)
            server.enqueue(MockResponse().setBody(WindmillJson.encodeToString(CoachSnapshotOut.serializer(), CoachSnapshotOut("thread-a", stopped))))
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
            server.enqueue(MockResponse().setBody(WindmillJson.encodeToString(CoachPhotoOut.serializer(), CoachPhotoOut(photo))))
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
}
