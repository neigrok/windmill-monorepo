package works.windmill.platform.ai

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import works.windmill.platform.telemetry.TelemetryPolicy
import works.windmill.sync.core.Json

class AiCredentials(val session: String?, val installation: String?) {
    override fun toString() = "AiCredentials"
}

class AiHttp(private val origin: HttpUrl, private val credentials: suspend () -> AiCredentials,
    allowLocalHttp: Boolean = false, private val requestObserved: (String, String) -> Unit = { _, _ -> }) : AiTransport, AutoCloseable {
    init {
        require(origin.username.isEmpty() && origin.password.isEmpty() && origin.encodedPath == "/" && origin.query == null && origin.fragment == null)
        require(origin.isHttps || allowLocalHttp && origin.scheme == "http" && origin.host in setOf("127.0.0.1", "::1"))
    }
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .cookieJar(CookieJar.NO_COOKIES).cache(null).connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS).writeTimeout(30, TimeUnit.SECONDS).retryOnConnectionFailure(false).build()

    override suspend fun pass(body: Json): AiResponse {
        val identity = credentials()
        val request = Request.Builder().url(origin.resolve("/v1/ai/passes")!!)
            .header("Cache-Control", "no-store").post(body.jcs.toRequestBody("application/json".toMediaType()))
        identity.session?.let { request.header("Authorization", "Bearer $it") }
        identity.installation?.let { request.header("X-Windmill-Installation", it) }
        return exchange(request.build(), 30_000, false)
    }

    override suspend fun request(request: AiRequest): AiResponse {
        val url = origin.resolve(request.path) ?: throw AiTransportFailure("address")
        if (!request.path.startsWith("/v1/") || ".." in request.path || url.scheme != origin.scheme || url.host != origin.host || url.port != origin.port || url.username.isNotEmpty() || url.password.isNotEmpty()) throw AiTransportFailure("address")
        val builder = Request.Builder().url(url).header("Authorization", "Bearer ${request.pass}").header("Cache-Control", "no-store")
        val body = request.body?.toRequestBody("application/json".toMediaType()) ?: request.bytes?.toRequestBody((request.mediaType ?: throw AiTransportFailure("media-type")).toMediaType())
        builder.method(request.method, body)
        val stream = url.encodedPath.startsWith("/v1/calls/")
        if (stream) builder.header("Accept", "text/event-stream")
        return exchange(builder.build(), request.timeoutMs, stream)
    }

    private suspend fun exchange(request: Request, timeoutMs: Long, stream: Boolean): AiResponse {
        requestObserved(request.method, request.url.encodedPath)
        val call = client.newCall(request)
        call.timeout().timeout(timeoutMs.coerceAtLeast(1), TimeUnit.MILLISECONDS)
        val response = try {
            suspendCancellableCoroutine<Response> { continuation ->
                continuation.invokeOnCancellation { call.cancel() }
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        if (continuation.isActive) continuation.resumeWithException(connectionFailure(e))
                    }
                    override fun onResponse(call: Call, response: Response) {
                        continuation.resume(response) { _, value, _ -> value.close() }
                    }
                })
            }
        } catch (error: IOException) { throw connectionFailure(error) }
        try {
            if (response.code in 300..399) throw AiTransportFailure("redirect")
            if (response.code == 204) { response.close(); return AiResponse(204) }
            if (response.code == 200 && stream) {
                val body = response.body ?: throw AiTransportFailure("invalid-answer")
                val type = body.contentType()
                if (type?.type != "text" || type.subtype != "event-stream") throw AiTransportFailure("invalid-answer")
                val events = flow {
                    try {
                        response.use {
                            val parser = AiSse()
                            val bytes = ByteArray(8192)
                            while (true) {
                                val count = body.source().read(bytes)
                                if (count == -1) { parser.finish(); break }
                                for (event in parser.consume(bytes, count)) {
                                    emit(event)
                                    if (event.member("event").str() in setOf("ended", "failed")) return@flow
                                }
                            }
                        }
                    } catch (error: IOException) { throw connectionFailure(error) }
                }.flowOn(Dispatchers.IO)
                return AiResponse(response.code, events = events) { call.cancel(); response.close() }
            }
            return withContext(Dispatchers.IO) { response.use {
                val source = it.body?.source() ?: return@use AiResponse(it.code)
                source.request(1_048_577)
                if (source.buffer.size > 1_048_576) {
                    if (it.code != 200) return@use AiResponse(it.code)
                    throw AiTransportFailure("invalid-answer")
                }
                val bytes = source.readByteArray()
                val body = try { Json.parse(bytes) } catch (_: Exception) {
                    if (it.code != 200) return@use AiResponse(it.code)
                    throw AiTransportFailure("invalid-answer")
                }
                AiResponse(it.code, body)
            } }
        } catch (failure: Exception) {
            response.close()
            if (failure is IOException) throw connectionFailure(failure)
            if (failure is AiTransportFailure) throw failure
            throw AiTransportFailure("invalid-answer")
        }
    }
    override fun close() { client.dispatcher.cancelAll(); client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll() }
    private fun connectionFailure(failure: IOException) = AiTransportFailure(if (TelemetryPolicy.networkLoss(failure)) "lost" else "transport")
}
