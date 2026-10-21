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
import javax.net.ssl.SSLException
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
// An HTTP answer: its status, and its JSON body when it had one.
data class SyncResponse(val status: Int, val body: Json? = null) {
    // §9.6: the server's own 426 names its cause; a bare 426, a proxy's or a captive portal's, is a failure like any other.
    val requiresUpgrade: Boolean get() = status == 426 && body?.get("error") == Json.of("upgrade-required")
    // §9.1: an answer handled as a 401: a 401, an `account-mismatch`, or a 200 or 409 served as anyone but `account`.
    internal fun unauthenticated(account: String?) = status == 401 || status == 409 && body?.get("error") == Json.of("account-mismatch") ||
        status in setOf(200, 409) && account != null && body?.get("as") != Json.of(account)
    // §7.4: a 409 served to the push's `account` whose code or envelope recovery cannot use, a transport failure though the server answered.
    internal fun malformedConflict(account: String?) = account != null && status == 409 && !unauthenticated(account) &&
        runCatching { validateResponse("push-conflict", body ?: throw JsonError("response")) }.isFailure
}
internal val Reply<SyncResponse>.answer: SyncResponse? get() = when (this) {
    is Reply.Answer -> value
    is Reply.Failed -> response
    Reply.Unreachable -> null
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
// Why a request or live socket failed, by its exception and causes; only `unreachable` (lost network) is no fault. `TelemetryPolicy.networkLoss` copies that rule, pinned by failure-kinds.tsv.
internal fun failureKind(failure: Throwable): String? {
    val causes = generateSequence(failure) { it.cause }.take(8).toList()
    return when {
        causes.any { it is CertificateException || it is SSLPeerUnverifiedException } -> "tls"
        causes.any {
            it is UnknownHostException || it is SocketException || it is InterruptedIOException || it is EOFException ||
                it is ProtocolException && it.message == "unexpected end of stream" || it is ConnectionShutdownException ||
                it is StreamResetException && it.errorCode in setOf(ErrorCode.CANCEL, ErrorCode.REFUSED_STREAM)
        } -> "unreachable"
        causes.any { it is SSLException } -> "tls"
        causes.any { it is ProtocolException || it is StreamResetException } -> "protocol"
        failure is IllegalArgumentException -> "malformed"
        failure is IOException -> "transport"
        else -> null
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
    // Every failure is a metric. A fault repeats only the fault its operation last filed, by kind and status or exception, until an answer; lost network and refusals end the run.
    private fun failed(operation: EngineOperation, outcome: EngineOutcome, kind: String?, status: Int? = null, cause: Throwable? = null) {
        val fault = EngineEvent(operation, outcome, kind, status).fault
        val key = "$kind ${status ?: cause?.javaClass?.name}"
        if (!fault) outages.remove(operation)
        telemetry.offer(operation, outcome, kind, status, fault && outages.put(operation, key) == key)
    }
    private fun failed(operation: EngineOperation, failure: Throwable) = failed(operation, EngineOutcome.failure, failureKind(failure), cause = failure)
    private fun failed(operation: EngineOperation, status: Int, expected: Set<Int>) =
        if (status in expected) failed(operation, EngineOutcome.refused, null, status) else failed(operation, EngineOutcome.failure, "http", status)
    private fun request(kind: String, body: Json?, token: String?): Request = Request.Builder()
        .url(base.newBuilder().addPathSegments("v1/sync/$kind").build()).header("Sync-Schema", schema.toString())
        .apply { if (token != null) header("Authorization", "Bearer $token") }
        .apply { if (body == null) get() else post(body.jcs.toRequestBody("application/json".toMediaType())) }.build()
    private suspend fun exchange(kind: String, body: Json?, token: String?): Reply<SyncResponse> {
        if (closed.get()) return Reply.Unreachable
        val operation = when (kind) { "hello" -> EngineOperation.hello; "push" -> EngineOperation.push; else -> EngineOperation.pull }
        val expected = if (kind == "push") ExpectedStatuses.push else ExpectedStatuses.all
        val max = if (kind == "pull") Constants.PULL_MAX_SCOPES.toLong() * Constants.PULL_PAGE_BYTES + 65_536 else 4L * 1024 * 1024
        val call = client.newCall(request(kind, body, token)); calls.add(call)
        if (closed.get()) { call.cancel(); calls.remove(call); return Reply.Unreachable }
        try {
            return suspendCancellableCoroutine { continuation ->
                continuation.invokeOnCancellation { call.cancel() }
                fun current() = continuation.isActive && !closed.get()
                fun reply(answer: Reply<SyncResponse>) { if (continuation.isActive) continuation.resume(answer) { _, _, _ -> } }
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, failure: IOException) {
                        if (current()) failed(operation, failure)
                        reply(Reply.Unreachable)
                    }
                    override fun onResponse(call: Call, response: Response) = reply(response.use {
                        if (!current()) return@use Reply.Unreachable
                        try {
                            val source = it.body?.source()
                            if (source == null || source.request(max + 1) && source.buffer.size > max) {
                                if (current()) failed(operation, EngineOutcome.failure, "limit")
                                return@use Reply.Unreachable
                            }
                            val answer = SyncResponse(it.code, try { Json.parse(source.readByteArray()) } catch (_: IllegalArgumentException) { null })
                            when {
                                it.code == 200 -> { validateResponse(kind, answer.body ?: throw JsonError("response")); outages.remove(operation) }
                                kind == "push" && answer.malformedConflict(body?.get("account")?.str()) -> if (current()) failed(operation, EngineOutcome.failure, "malformed")
                                else -> if (current()) failed(operation, it.code, expected)
                            }
                            Reply.Answer(answer)
                        } catch (failure: Exception) {
                            if (current()) failed(operation, failure)
                            Reply.Unreachable
                        }
                    })
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
            live.fail { failed(EngineOperation.live, EngineOutcome.timeout, "unreachable") }
            return Reply.Unreachable
        }
    }
    // One live socket, as OkHttp calls it and as the runtime reads it. Only its first end reports; a valid frame ends its operation's outage.
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
            if (open.queueSize() + size > Constants.LIVE_FRAME_BYTES) {
                fail { failed(EngineOperation.live, EngineOutcome.failure, "limit") }
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
            if (closed.get() || !opening.complete(Reply.Answer(this))) close()
        }
        private fun message(bytes: ByteArray) {
            if (ended.get() || closed.get()) return
            if (bytes.size > Constants.LIVE_FRAME_BYTES) return fail { failed(EngineOperation.live, EngineOutcome.failure, "limit") }
            val frame = try { Json.parse(bytes).also(::validateFrame) } catch (malformed: Exception) { return fail { failed(EngineOperation.live, malformed) } }
            if (!messages.trySend(frame).isSuccess) return fail { failed(EngineOperation.live, EngineOutcome.failure, "limit") }
            outages.remove(EngineOperation.live)
        }
        override fun onMessage(webSocket: WebSocket, text: String) = message(text.encodeToByteArray())
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) = message(bytes.toByteArray())
        // A close frame ends the socket at once: quietly on 1000 or 1001, as a refusal on the server's session-ended 1008, and as a fault on any other code or none.
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) = when (code) {
            1000, 1001 -> end(null)
            1008 -> fail { failed(EngineOperation.live, EngineOutcome.refused, null) }
            else -> fail { failed(EngineOperation.live, EngineOutcome.failure, "transport") }
        }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = end(null)
        override fun onFailure(webSocket: WebSocket, failure: Throwable, response: Response?) {
            val status = response?.code
            response?.close()
            // Cancelling an ended socket calls back here, sometimes before cancel returns.
            if (ended.get()) return
            if (status == null) fail { failed(EngineOperation.live, failure) }
            else fail(Reply.Failed(SyncResponse(status))) { failed(EngineOperation.live, status, ExpectedStatuses.all) }
        }
    }
    override fun close() {
        if (closed.compareAndSet(false, true)) { calls.forEach(Call::cancel); sockets.forEach(LiveConnection::close); telemetry.close() }
    }
}
