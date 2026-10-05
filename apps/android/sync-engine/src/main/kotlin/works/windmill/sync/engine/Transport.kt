package works.windmill.sync.engine

import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.RequestBody.Companion.toRequestBody
import okio.ByteString
import works.windmill.sync.core.*

sealed interface Reply<out T> {
    data class Answer<T>(val value: T) : Reply<T>
    data class Failed(val response: SyncResponse) : Reply<Nothing>
    data object Unreachable : Reply<Nothing>
}
interface SyncTransport {
    suspend fun hello(token: String?): Reply<SyncResponse>
    suspend fun push(request: Json, token: String): Reply<SyncResponse>
    suspend fun pull(request: Json, token: String?): Reply<SyncResponse>
    suspend fun openLive(token: String): Reply<LiveConnection>
}
interface LiveConnection : AutoCloseable {
    suspend fun send(request: Json)
    suspend fun receive(): Json?
}

internal fun validateResponse(kind: String, json: Json) {
    json.member("serverTime").long(); json.member("epoch").str()
    json["as"]?.orNull()?.str()
    when (kind) {
        "hello" -> { json.member("schema").long(); json.member("minSchema").long(); json["holdsRecords"]?.obj()?.values?.forEach { it.bool() } }
        "push" -> { json.member("lastN").long(); json.member("results").arr().forEach { PushResult(it) }; json["retry"]?.let { it.member("n").long(); it.member("retryAfterMs").long() } }
        "pull" -> json.member("pages").arr().forEach { page ->
            ScopeRef(page.member("scope"))
            when (page.member("kind").str()) {
                "rows" -> { page.member("rows").arr().forEach { Row(it) }; WireCursor.decode(page.member("cursor").str()); page.member("more").bool(); page.member("seq").long(); ScopeDigest(page.member("digest").str()) }
                "reset", "gone", "not-found" -> Unit
                else -> throw JsonError("page-kind")
            }
        }
    }
}
internal fun validateFrame(frame: Json) {
    when (frame.member("op").str()) {
        "change" -> { ScopeRef(frame.member("scope")); frame.member("epoch").str(); frame.member("seq").long(); ScopeDigest(frame.member("digest").str()); frame["rows"]?.arr()?.forEach { Row(it) } }
        "gone", "not-found" -> ScopeRef(frame.member("scope"))
    }
    frame["as"]?.orNull()?.str()
}
class HTTPTransport(baseURL: String, private val schema: Int, telemetry: EngineTelemetry = NoEngineTelemetry,
    client: OkHttpClient = OkHttpClient(), private val requestTimeoutMs: Long = Constants.REQUEST_TIMEOUT_MS.toLong()) : SyncTransport, AutoCloseable {
    private val base = baseURL.toHttpUrl()
    private val client = client.newBuilder().cookieJar(CookieJar.NO_COOKIES).cache(null).followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).connectTimeout(30, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS).callTimeout(requestTimeoutMs, TimeUnit.MILLISECONDS).build()
    private val liveClient = this.client.newBuilder().callTimeout(0, TimeUnit.MILLISECONDS).build()
    private val telemetry = TelemetryQueue(telemetry)
    private val calls = java.util.concurrent.ConcurrentHashMap.newKeySet<Call>()
    private val sockets = java.util.concurrent.ConcurrentHashMap.newKeySet<LiveConnection>()
    private val closed = AtomicBoolean(false)
    override suspend fun hello(token: String?) = exchange("hello", null, token)
    override suspend fun push(request: Json, token: String) = exchange("push", request, token)
    override suspend fun pull(request: Json, token: String?) = exchange("pull", request, token)
    private fun request(kind: String, body: Json?, token: String?): Request = Request.Builder()
        .url(base.newBuilder().addPathSegments("v1/sync/$kind").build()).header("Sync-Schema", schema.toString())
        .apply { if (token != null) header("Authorization", "Bearer $token") }
        .apply { if (body == null) get() else post(body.jcs.toRequestBody("application/json".toMediaType())) }.build()
    private suspend fun exchange(kind: String, body: Json?, token: String?): Reply<SyncResponse> {
        if (closed.get()) return Reply.Unreachable
        val call = client.newCall(request(kind, body, token)); calls.add(call)
        if (closed.get()) { call.cancel(); calls.remove(call); return Reply.Unreachable }
        try {
            return suspendCancellableCoroutine { continuation ->
                continuation.invokeOnCancellation { call.cancel() }
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, failure: IOException) {
                        if (continuation.isActive) { telemetry.offer(operation(kind), EngineOutcome.failure); continuation.resume(Reply.Unreachable) { _, _, _ -> } }
                    }
                    override fun onResponse(call: Call, response: Response) {
                        val answer = response.use {
                            try {
                                val source = it.body?.source()
                                val max = if (kind == "pull") Constants.PULL_MAX_SCOPES.toLong() * Constants.PULL_PAGE_BYTES + 65_536 else 4L * 1024 * 1024
                                if (source == null || source.request(max + 1) && source.buffer.size > max) throw IOException("response-limit")
                                val json = try { Json.parse(source.readByteArray()) } catch (_: IllegalArgumentException) { null }
                                if (it.code == 200) {
                                    if (json == null) throw JsonError("response")
                                    validateResponse(kind, json)
                                } else telemetry.offer(operation(kind), EngineOutcome.failure)
                                Reply.Answer(SyncResponse(it.code, json))
                            } catch (_: Exception) { telemetry.offer(operation(kind), EngineOutcome.failure); Reply.Unreachable }
                        }
                        if (continuation.isActive) continuation.resume(answer) { _, _, _ -> }
                    }
                })
            }
        } finally { calls.remove(call) }
    }
    private fun operation(kind: String) = when (kind) { "hello" -> EngineOperation.hello; "push" -> EngineOperation.push; else -> EngineOperation.pull }
    override suspend fun openLive(token: String): Reply<LiveConnection> {
        if (closed.get()) return Reply.Unreachable
        val messages = Channel<Json>(32)
        val socketRef = java.util.concurrent.atomic.AtomicReference<WebSocket?>()
        val opening = CompletableDeferred<Reply<LiveConnection>>()
        val connection = object : LiveConnection {
            private val receiving = AtomicBoolean(false)
            override suspend fun send(request: Json) {
                val text = request.jcs
                if (text.encodeToByteArray().size > Constants.LIVE_FRAME_BYTES || socketRef.get()?.let { it.queueSize() + text.encodeToByteArray().size <= Constants.LIVE_FRAME_BYTES && it.send(text) } != true) throw IOException("live-send")
            }
            override suspend fun receive(): Json? {
                check(receiving.compareAndSet(false, true)) { "one-live-reader" }
                try { return messages.receiveCatching().let { it.exceptionOrNull()?.let { failure -> throw failure }; it.getOrNull() } }
                finally { receiving.set(false) }
            }
            override fun close() { opening.complete(Reply.Unreachable); socketRef.get()?.cancel(); messages.close(); sockets.remove(this) }
        }
        sockets.add(connection)
        if (closed.get()) { connection.close(); return Reply.Unreachable }
        val request = Request.Builder().url(base.newBuilder().addPathSegments("v1/sync/live").addQueryParameter("schema", schema.toString()).build())
            .header("Authorization", "Bearer $token").build()
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { socketRef.set(webSocket); if (closed.get() || !opening.complete(Reply.Answer(connection))) connection.close() }
            private fun message(webSocket: WebSocket, bytes: ByteArray) {
                try {
                    if (bytes.size > Constants.LIVE_FRAME_BYTES) throw IOException("frame-limit")
                    val frame = Json.parse(bytes); validateFrame(frame)
                    if (!messages.trySend(frame).isSuccess) throw IOException("live-backpressure")
                } catch (_: Exception) { telemetry.offer(EngineOperation.live, EngineOutcome.failure); messages.close(IOException("live-frame")); webSocket.cancel() }
            }
            override fun onMessage(webSocket: WebSocket, text: String) = message(webSocket, text.encodeToByteArray())
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) = message(webSocket, bytes.toByteArray())
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { messages.close(); sockets.remove(connection) }
            override fun onFailure(webSocket: WebSocket, failure: Throwable, response: Response?) {
                val status = response?.code
                response?.close(); telemetry.offer(EngineOperation.live, EngineOutcome.failure)
                opening.complete(if (status != null) Reply.Failed(SyncResponse(status)) else Reply.Unreachable); messages.close(IOException("live-failed")); sockets.remove(connection)
            }
        }
        val socket = liveClient.newWebSocket(request, listener); socketRef.compareAndSet(null, socket)
        if (closed.get()) connection.close()
        try { return withTimeout(requestTimeoutMs) { opening.await() } }
        catch (cancelled: CancellationException) { connection.close(); if (cancelled is TimeoutCancellationException) { telemetry.offer(EngineOperation.live, EngineOutcome.timeout); return Reply.Unreachable }; throw cancelled }
    }
    override fun close() {
        if (closed.compareAndSet(false, true)) { calls.forEach(Call::cancel); sockets.toList().forEach(LiveConnection::close); telemetry.close() }
    }
}
