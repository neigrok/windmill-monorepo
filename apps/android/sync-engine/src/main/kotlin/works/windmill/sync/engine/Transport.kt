package works.windmill.sync.engine

import java.io.EOFException
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ProtocolException
import java.net.SocketException
import java.net.UnknownHostException
import java.security.cert.CertificateException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.SSLPeerUnverifiedException
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.internal.http2.ConnectionShutdownException
import okhttp3.internal.http2.ErrorCode
import okhttp3.internal.http2.StreamResetException
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
// A live connection fails its reads and sends with this once it has ended; the end was reported where it happened, or was deliberate.
class LiveEnded internal constructor(reason: String) : IOException(reason)

internal fun validateResponse(kind: String, json: Json) {
    json.member("serverTime").long(0)
    if (json.member("epoch").str().isEmpty()) throw JsonError("epoch")
    json["as"]?.orNull()?.str()
    when (kind) {
        "hello" -> { json.member("schema").long(); json.member("minSchema").long(); json["holdsRecords"]?.obj()?.values?.forEach { it.bool() } }
        "push" -> { json.member("lastN").long(); json.member("results").arr().forEach { PushResult(it) }; json["retry"]?.let { it.member("n").long(); it.member("retryAfterMs").long() } }
        "push-conflict" -> if (json["error"] !in listOf(Json.of("gap"), Json.of("replica-forked"), Json.of("replica-foreign"))) throw JsonError("push-conflict")
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
// The statuses the server answers on purpose: a refusal each, never a fault. A push also expects 413, which §7.4 halves or refuses too-large.
internal object ExpectedStatuses {
    val all = setOf(400, 401, 403, 404, 409, 410, 422, 426, 429)
    val push = all + 413
}
// The network went away or stopped answering before a whole reply: no address, no connection, a reset or cut exchange, a timeout.
internal fun unreachable(failure: Throwable): Boolean {
    val causes = generateSequence(failure) { it.cause }.take(8).toList()
    if (causes.any { it is CertificateException || it is SSLPeerUnverifiedException }) return false
    return causes.any {
        it is UnknownHostException || it is SocketException || it is InterruptedIOException || it is EOFException ||
            it is ProtocolException && it.message == "unexpected end of stream" ||
            it is ConnectionShutdownException || it is StreamResetException && it.errorCode == ErrorCode.CANCEL
    }
}
class HTTPTransport(baseURL: String, private val schema: Int, telemetry: EngineTelemetry = NoEngineTelemetry,
    client: OkHttpClient = OkHttpClient(), private val requestTimeoutMs: Long = Constants.REQUEST_TIMEOUT_MS.toLong(),
    webSocketFactory: WebSocket.Factory? = null) : SyncTransport, AutoCloseable {
    private val base = baseURL.toHttpUrl()
    private val client = client.newBuilder().cookieJar(CookieJar.NO_COOKIES).cache(null).followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).connectTimeout(30, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS).callTimeout(requestTimeoutMs, TimeUnit.MILLISECONDS).build()
    private val liveClient = webSocketFactory ?: this.client.newBuilder().callTimeout(0, TimeUnit.MILLISECONDS).build()
    private val telemetry = TelemetryQueue(telemetry)
    private val outages = ConcurrentHashMap<EngineOperation, String>()
    private val calls = ConcurrentHashMap.newKeySet<Call>()
    private val sockets = ConcurrentHashMap.newKeySet<LiveConnection>()
    private val closed = AtomicBoolean(false)
    override suspend fun hello(token: String?) = exchange("hello", null, token)
    override suspend fun push(request: Json, token: String) = exchange("push", request, token)
    override suspend fun pull(request: Json, token: String?) = exchange("pull", request, token)
    // Every failure is a metric; a fault like its operation's last failure (same status, same error) repeats it until the operation is answered.
    private fun failed(operation: EngineOperation, outcome: EngineOutcome, code: String?, like: String) {
        val repeated = outages.put(operation, like) == like
        telemetry.offer(operation, outcome, code, repeated && EngineEvent(operation, outcome, code).fault)
    }
    private fun failed(operation: EngineOperation, failure: Throwable) =
        failed(operation, EngineOutcome.failure, "unreachable".takeIf { unreachable(failure) }, failure.javaClass.name)
    private fun request(kind: String, body: Json?, token: String?): Request = Request.Builder()
        .url(base.newBuilder().addPathSegments("v1/sync/$kind").build()).header("Sync-Schema", schema.toString())
        .apply { if (token != null) header("Authorization", "Bearer $token") }
        .apply { if (body == null) get() else post(body.jcs.toRequestBody("application/json".toMediaType())) }.build()
    private suspend fun exchange(kind: String, body: Json?, token: String?): Reply<SyncResponse> {
        if (closed.get()) return Reply.Unreachable
        val operation = when (kind) { "hello" -> EngineOperation.hello; "push" -> EngineOperation.push; else -> EngineOperation.pull }
        val expected = if (kind == "push") ExpectedStatuses.push else ExpectedStatuses.all
        val call = client.newCall(request(kind, body, token)); calls.add(call)
        if (closed.get()) { call.cancel(); calls.remove(call); return Reply.Unreachable }
        try {
            return suspendCancellableCoroutine { continuation ->
                continuation.invokeOnCancellation { call.cancel() }
                fun current() = continuation.isActive && !closed.get()
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, failure: IOException) {
                        if (continuation.isActive) {
                            if (current()) failed(operation, failure)
                            continuation.resume(Reply.Unreachable) { _, _, _ -> }
                        }
                    }
                    override fun onResponse(call: Call, response: Response) {
                        if (!current()) {
                            response.close()
                            if (continuation.isActive) continuation.resume(Reply.Unreachable) { _, _, _ -> }
                            return
                        }
                        val answer = response.use {
                            try {
                                val source = it.body?.source()
                                val max = if (kind == "pull") Constants.PULL_MAX_SCOPES.toLong() * Constants.PULL_PAGE_BYTES + 65_536 else 4L * 1024 * 1024
                                if (source == null || source.request(max + 1) && source.buffer.size > max) error("response-limit")
                                val json = try { Json.parse(source.readByteArray()) } catch (_: IllegalArgumentException) { null }
                                if (it.code == 200) {
                                    if (json == null) throw JsonError("response")
                                    validateResponse(kind, json)
                                    outages.remove(operation)
                                } else {
                                    if (kind == "push" && it.code == 409 && body?.get("account") != null &&
                                        json?.get("as") == body["account"] && json?.get("error") != Json.of("account-mismatch"))
                                        validateResponse("push-conflict", json!!)
                                    if (current()) failed(operation, if (it.code in expected) EngineOutcome.refused else EngineOutcome.failure, null, "${it.code}")
                                }
                                Reply.Answer(SyncResponse(it.code, json))
                            } catch (failure: Exception) {
                                if (current()) failed(operation, failure)
                                Reply.Unreachable
                            }
                        }
                        if (continuation.isActive) continuation.resume(answer) { _, _, _ -> }
                    }
                })
            }
        } finally { calls.remove(call) }
    }
    override suspend fun openLive(token: String): Reply<LiveConnection> {
        if (closed.get()) return Reply.Unreachable
        val live = Live()
        sockets.add(live)
        if (closed.get()) { live.close(); return Reply.Unreachable }
        val request = Request.Builder().url(base.newBuilder().addPathSegments("v1/sync/live").addQueryParameter("schema", schema.toString()).build())
            .header("Authorization", "Bearer $token").build()
        live.socket.compareAndSet(null, liveClient.newWebSocket(request, live))
        if (closed.get()) live.close()
        try { return withTimeout(requestTimeoutMs) { live.opening.await() } }
        catch (cancelled: CancellationException) {
            if (cancelled !is TimeoutCancellationException) { live.close(); throw cancelled }
            live.fail { failed(EngineOperation.live, EngineOutcome.timeout, "unreachable", "timeout") }
            return Reply.Unreachable
        }
    }
    // One live socket, as OkHttp calls it and as the runtime reads it. Only its first end reports.
    private inner class Live : WebSocketListener(), LiveConnection {
        val socket = AtomicReference<WebSocket?>()
        val opening = CompletableDeferred<Reply<LiveConnection>>()
        private val messages = Channel<Json>(32)
        private val ended = AtomicBoolean(false)
        private val receiving = AtomicBoolean(false)
        override suspend fun send(request: Json) {
            val text = request.jcs
            val size = text.encodeToByteArray().size
            val open = socket.get()?.takeUnless { ended.get() } ?: throw LiveEnded("live-send")
            if (size > Constants.LIVE_FRAME_BYTES || open.queueSize() + size > Constants.LIVE_FRAME_BYTES) {
                fail { failed(EngineOperation.live, EngineOutcome.failure, null, "live-send") }
                throw LiveEnded("live-send")
            }
            if (!open.send(text)) throw LiveEnded("live-send")
        }
        override suspend fun receive(): Json? {
            check(receiving.compareAndSet(false, true)) { "one-live-reader" }
            try { return messages.receiveCatching().let { it.exceptionOrNull()?.let { failure -> throw failure }; it.getOrNull() } }
            finally { receiving.set(false) }
        }
        override fun close() = end(null)
        // A failure reports on the connection's first end only; its reader then fails rather than reading null.
        fun fail(opened: Reply<LiveConnection> = Reply.Unreachable, report: () -> Unit) {
            if (closed.get()) return close()
            if (ended.compareAndSet(false, true)) report()
            end(LiveEnded("live-failed"), opened)
        }
        private fun end(failure: LiveEnded?, opened: Reply<LiveConnection> = Reply.Unreachable) {
            ended.set(true)
            opening.complete(opened); messages.close(failure)
            socket.get()?.cancel(); sockets.remove(this)
        }
        override fun onOpen(webSocket: WebSocket, response: Response) {
            socket.set(webSocket)
            if (closed.get() || !opening.complete(Reply.Answer(this))) close() else outages.remove(EngineOperation.live)
        }
        private fun message(bytes: ByteArray) {
            if (ended.get() || closed.get()) return
            try {
                if (bytes.size > Constants.LIVE_FRAME_BYTES) error("frame-limit")
                val frame = Json.parse(bytes); validateFrame(frame)
                if (!messages.trySend(frame).isSuccess) error("live-backpressure")
            } catch (fault: Exception) { fail { failed(EngineOperation.live, fault) } }
        }
        override fun onMessage(webSocket: WebSocket, text: String) = message(text.encodeToByteArray())
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) = message(bytes.toByteArray())
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = end(null)
        override fun onFailure(webSocket: WebSocket, failure: Throwable, response: Response?) {
            val status = response?.code
            response?.close()
            // Cancelling an ended socket calls back here, sometimes before cancel returns.
            if (ended.get()) return
            if (status == null) fail { failed(EngineOperation.live, failure) }
            else fail(Reply.Failed(SyncResponse(status))) {
                failed(EngineOperation.live, if (status in ExpectedStatuses.all) EngineOutcome.refused else EngineOutcome.failure, null, "$status")
            }
        }
    }
    override fun close() {
        if (closed.compareAndSet(false, true)) { calls.forEach(Call::cancel); sockets.forEach(LiveConnection::close); telemetry.close() }
    }
}
