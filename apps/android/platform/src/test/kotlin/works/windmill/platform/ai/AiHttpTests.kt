package works.windmill.platform.ai

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertTrue
import org.junit.Test

class AiHttpTests {
    // A stream that sent its first event and then holds the socket open: cancelling the collector cancels the call, so the blocked read ends at once rather than when the socket next speaks.
    @Test fun cancellingTheCollectorUnderABlockedReadEndsPromptly() = runBlocking {
        val server = MockWebServer()
        val event = "id: 1\nevent: text\ndata: {\"delta\":\"x\"}\n\n"
        server.enqueue(MockResponse().setResponseCode(200).setHeader("Content-Type", "text/event-stream")
            .setBody(event + " ".repeat(64)).throttleBody(event.length.toLong(), 20, TimeUnit.SECONDS))
        server.start()
        try {
            AiHttp(server.url("/").newBuilder().host("127.0.0.1").build(), { AiCredentials(null, null) }, allowLocalHttp = true).use { transport ->
                val response = transport.request(AiRequest("GET", "/v1/calls/abc/result", "pass", null))
                val first = CompletableDeferred<Unit>()
                val collector = launch(Dispatchers.Default) { response.events!!.collect { first.complete(Unit) } }
                assertTrue("the first event arrives", withTimeoutOrNull(5_000) { first.await() } != null)
                val started = System.nanoTime()
                collector.cancelAndJoin()
                val ms = (System.nanoTime() - started) / 1_000_000
                assertTrue("cancelAndJoin took $ms ms", ms < 2_000)
            }
        } finally {
            // The server's own writer is still asleep in its throttle, which shutdown gives up waiting on.
            runCatching { server.shutdown() }
        }
    }
}
