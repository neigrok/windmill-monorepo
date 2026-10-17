package works.windmill.app

import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.*
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.*
import org.junit.Test
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.core.Json
import works.windmill.sync.engine.*

class EngineTelemetryTests {
    private class Recorded : Telemetry {
        val events = CopyOnWriteArrayList<Pair<String, Map<String, String>>>()
        val failures = CopyOnWriteArrayList<Triple<String, String, Map<String, String>>>()
        override fun event(name: String, properties: Map<String, String>) { events += name to properties }
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
            failures += Triple(operation, error.javaClass.simpleName, properties)
        }
    }

    @Test fun lostNetworkAndRepeatsStayProductEventsWhileEachFaultFilesUnderItsOperationWithItsReason() = runBlocking {
        val telemetry = Recorded()
        val adapter = engineTelemetry(telemetry)
        for (event in listOf(
            EngineEvent(EngineOperation.push, EngineOutcome.failure, "unreachable"),
            EngineEvent(EngineOperation.live, EngineOutcome.timeout, "unreachable"),
            EngineEvent(EngineOperation.pull, EngineOutcome.failure, "http", 502),
            EngineEvent(EngineOperation.pull, EngineOutcome.failure, "http", 502, repeated = true),
            EngineEvent(EngineOperation.push, EngineOutcome.failure, "tls"),
            EngineEvent(EngineOperation.live, EngineOutcome.failure, "malformed"),
            EngineEvent(EngineOperation.hello, EngineOutcome.refused, status = 401),
            EngineEvent(EngineOperation.storage, EngineOutcome.failure, "store-failure"),
            EngineEvent(EngineOperation.sync, EngineOutcome.failure),
            EngineEvent(EngineOperation.commit, EngineOutcome.success),
        )) adapter.record(event)
        assertEquals(listOf(
            "sync_engine" to mapOf("operation" to "push", "outcome" to "failure", "failure_kind" to "unreachable"),
            "sync_engine" to mapOf("operation" to "live", "outcome" to "timeout", "failure_kind" to "unreachable"),
            "sync_engine" to mapOf("operation" to "pull", "outcome" to "failure", "failure_kind" to "http", "status" to "502"),
            "sync_engine" to mapOf("operation" to "pull", "outcome" to "failure", "failure_kind" to "http", "status" to "502"),
            "sync_engine" to mapOf("operation" to "push", "outcome" to "failure", "failure_kind" to "tls"),
            "sync_engine" to mapOf("operation" to "live", "outcome" to "failure", "failure_kind" to "malformed"),
            "sync_engine" to mapOf("operation" to "hello", "outcome" to "refused", "status" to "401"),
            "sync_engine" to mapOf("operation" to "storage", "outcome" to "failure", "failure_kind" to "store-failure"),
            "sync_engine" to mapOf("operation" to "sync", "outcome" to "failure"),
        ), telemetry.events)
        assertEquals(listOf(
            Triple("sync_pull", "SyncEngineFailure", mapOf("operation" to "pull", "outcome" to "failure", "failure_kind" to "http", "status" to "502")),
            Triple("sync_push", "SyncEngineFailure", mapOf("operation" to "push", "outcome" to "failure", "failure_kind" to "tls")),
            Triple("sync_live", "SyncEngineFailure", mapOf("operation" to "live", "outcome" to "failure", "failure_kind" to "malformed")),
            Triple("sync_storage", "SyncEngineFailure", mapOf("operation" to "storage", "outcome" to "failure", "failure_kind" to "store-failure")),
            Triple("sync_sync", "SyncEngineFailure", mapOf("operation" to "sync", "outcome" to "failure")),
        ), telemetry.failures)
    }

    @Test fun aRealDropReachesOnlyTheProductEventAndAServerFaultFilesOncePerOutageUnderItsOperation() = runBlocking {
        val telemetry = Recorded()
        MockWebServer().use { server ->
            HTTPTransport("http://127.0.0.1:${server.port}/", 1, engineTelemetry(telemetry)).use { transport ->
                server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
                assertSame(Reply.Unreachable, transport.push(Json.objectOf(), "token"))
                repeat(2) {
                    server.enqueue(MockResponse().setResponseCode(500))
                    assertEquals(500, (transport.pull(Json.objectOf(), "token") as Reply.Answer).value.status)
                }
                server.enqueue(MockResponse().setResponseCode(500))
                assertEquals(500, (transport.push(Json.objectOf(), "token") as Reply.Answer).value.status)
                val opened = CompletableDeferred<Unit>()
                server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) { opened.complete(Unit) }
                }))
                val connection = (withTimeout(2_000) { transport.openLive("token") } as Reply.Answer).value
                withTimeout(2_000) { opened.await() }
                server.shutdown()
                assertTrue(runCatching { withTimeout(2_000) { connection.receive() } }.exceptionOrNull() is LiveEnded)
                assertSame(Reply.Unreachable, transport.hello(null))
                withTimeout(2_000) { while (telemetry.events.size < 6) delay(5) }
            }
        }
        val serverFault = { operation: String -> mapOf("operation" to operation, "outcome" to "failure", "failure_kind" to "http", "status" to "500") }
        assertEquals(listOf(
            "sync_engine" to mapOf("operation" to "push", "outcome" to "failure", "failure_kind" to "unreachable"),
            "sync_engine" to serverFault("pull"),
            "sync_engine" to serverFault("pull"),
            "sync_engine" to serverFault("push"),
            "sync_engine" to mapOf("operation" to "live", "outcome" to "failure", "failure_kind" to "unreachable"),
            "sync_engine" to mapOf("operation" to "hello", "outcome" to "failure", "failure_kind" to "unreachable"),
        ), telemetry.events)
        assertEquals(listOf(
            Triple("sync_pull", "SyncEngineFailure", serverFault("pull")),
            Triple("sync_push", "SyncEngineFailure", serverFault("push")),
        ), telemetry.failures)
    }
}
