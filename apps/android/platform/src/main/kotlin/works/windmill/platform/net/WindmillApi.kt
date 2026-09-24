package works.windmill.platform.net

import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.serializer
import okhttp3.Cookie
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Headers
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import works.windmill.platform.telemetry.Telemetry
import works.windmill.platform.telemetry.TelemetryPolicy

// An absent optional is omitted on the wire, never null. Leave `encodeDefaults` off: request DTOs
// across the products declare no default on a field the server reads as "leave what is stored",
// because a value equal to its declared default is dropped from the body entirely.
val WindmillJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
}

class WindmillApi(
    val baseUrl: HttpUrl,
    private val credential: () -> String?,
    client: OkHttpClient = OkHttpClient(),
    @PublishedApi internal val telemetry: Telemetry = Telemetry.None,
) {
    private val transport = RequestDiagnostics.attachTo(client)

    suspend inline fun <reified Reply> get(path: String, operation: String = "http_request"): Reply = send("GET", path, operation = operation)

    suspend inline fun <reified Reply> send(method: String, path: String, body: Any? = null, timeoutSeconds: Long? = null, operation: String = "http_request"): Reply =
        exchange<Reply>(method, path, body, timeoutSeconds, operation).reply

    // The session is minted only as a Set-Cookie.
    suspend inline fun <reified Reply> sendCapturingSession(
        method: String,
        path: String,
        body: Any? = null,
    ): Captured<Reply> = exchange(method, path, body, null, "auth_request")

    @PublishedApi
    internal suspend inline fun <reified Reply> exchange(method: String, path: String, body: Any?, timeoutSeconds: Long?, operation: String): Captured<Reply> {
        val diagnostics = RequestDiagnostics()
        return try {
            val answer = perform(method, path, encode(body), timeoutSeconds, diagnostics)
            diagnostics.phase = NetworkPhase.Decode
            Captured(decode(answer.body), sessionCookie(answer.headers))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            val failure = error as? WindmillApiException ?: WindmillApiException.Unexpected(error)
            report(method, path, operation, failure, diagnostics)
            throw failure
        }
    }

    @PublishedApi
    internal fun report(method: String, path: String, operation: String, error: Throwable, diagnostics: RequestDiagnostics) {
        val properties = mutableMapOf(
            "method" to method,
            "route" to path.substringBefore('?').substringBefore('#').split('/').take(3).joinToString("/"),
            "failure_kind" to TelemetryPolicy.failureKind(error),
            "operation" to TelemetryPolicy.operation(operation),
        )
        properties.putAll(diagnostics.properties())
        if (error is WindmillApiException.Refused) properties["status"] = error.status.toString()
        telemetry.event("api_request_failed", properties)
        if (TelemetryPolicy.report(error)) telemetry.failure(operation, error, properties)
    }

    suspend fun <Reply> consume(
        method: String,
        path: String,
        body: RequestBody? = null,
        accept: String = "application/json",
        timeoutSeconds: Long? = null,
        operation: String = "http_request",
        read: (Response) -> Reply,
    ): Reply {
        val diagnostics = RequestDiagnostics()
        return try {
            execute(method, path, body, accept, timeoutSeconds, diagnostics, read)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            val failure = when (error) {
                is WindmillApiException -> error
                is SerializationException -> {
                    diagnostics.phase = NetworkPhase.Decode
                    WindmillApiException.Malformed
                }
                else -> WindmillApiException.Unexpected(error)
            }
            report(method, path, operation, failure, diagnostics)
            throw failure
        }
    }

    @PublishedApi
    internal suspend fun perform(method: String, path: String, json: String?, timeoutSeconds: Long?, diagnostics: RequestDiagnostics): Answer =
        execute(method, path, json?.toRequestBody("application/json".toMediaType()), "application/json", timeoutSeconds, diagnostics) {
            Answer(it.code, it.body?.string().orEmpty(), it.headers)
        }

    private suspend fun <Reply> execute(
        method: String,
        path: String,
        body: RequestBody?,
        accept: String,
        timeoutSeconds: Long?,
        diagnostics: RequestDiagnostics,
        read: (Response) -> Reply,
    ): Reply {
        val url = baseUrl.resolve(path) ?: throw WindmillApiException.Malformed
        val request = Request.Builder().url(url).header("Accept", accept).tag(RequestDiagnostics::class.java, diagnostics)
            .apply { credential()?.let { header("Authorization", "Bearer $it") } }
            .method(method, body ?: if (method == "POST" || method == "PUT" || method == "PATCH") ByteArray(0).toRequestBody() else null)
            .build()
        return try {
            val requestClient = if (timeoutSeconds == null) transport else transport.newBuilder()
                .readTimeout(timeoutSeconds, TimeUnit.SECONDS).callTimeout(timeoutSeconds, TimeUnit.SECONDS).build()
            suspendCancellableCoroutine { continuation ->
                val call = requestClient.newCall(request)
                continuation.invokeOnCancellation { call.cancel() }
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, error: IOException) {
                        continuation.resumeWith(Result.failure(error))
                    }
                    override fun onResponse(call: Call, response: Response) {
                        diagnostics.phase = NetworkPhase.ResponseBody
                        continuation.resumeWith(runCatching {
                            response.use {
                                if (!it.isSuccessful) throw WindmillApiException.Refused(it.code,
                                    runCatching { WindmillJson.decodeFromString<Refusal>(it.body?.string().orEmpty()) }.getOrDefault(Refusal()))
                                read(it)
                            }
                        })
                    }
                })
            }
        } catch (transport: InterruptedIOException) {
            throw WindmillApiException.Timeout(transport)
        } catch (transport: UnknownHostException) {
            throw WindmillApiException.Offline
        } catch (transport: ConnectException) {
            throw WindmillApiException.Offline
        } catch (transport: IOException) {
            throw WindmillApiException.Transport(transport)
        }
    }

    @Suppress("UNCHECKED_CAST")
    @PublishedApi
    internal inline fun <reified Reply> decode(body: String): Reply {
        // A Unit reply is never parsed: a 204 carries no JSON.
        if (Reply::class == Unit::class) return Unit as Reply
        return try {
            WindmillJson.decodeFromString(body)
        } catch (undecodable: SerializationException) {
            throw WindmillApiException.Malformed
        } catch (undecodable: IllegalArgumentException) {
            throw WindmillApiException.Malformed
        }
    }

    @PublishedApi
    internal fun encode(body: Any?): String? {
        if (body == null) return null
        return WindmillJson.encodeToString(serializer(body.javaClass), body)
    }

    @PublishedApi
    internal fun sessionCookie(headers: Headers): String? =
        headers.values("Set-Cookie")
            .mapNotNull { Cookie.parse(baseUrl, it) }
            .firstOrNull { it.name == "wm_session" }
            ?.value

    @PublishedApi
    internal class Answer(val code: Int, val body: String, val headers: Headers)

    companion object {
        // Empty or unparseable means production.
        fun resolvedBaseUrl(configured: String): HttpUrl {
            if (configured.isBlank()) return "https://windmill.works".toHttpUrl()
            return configured.toHttpUrlOrNull() ?: "https://windmill.works".toHttpUrl()
        }
    }
}

data class Captured<Reply>(val reply: Reply, val session: String?)

@Serializable
data class Refusal(
    @SerialName("error") val message: String? = null,
    val detail: String? = null,
    val code: String? = null,
)

sealed class WindmillApiException(cause: Throwable? = null) : Exception(cause) {
    data object Offline : WindmillApiException()
    class Timeout(cause: IOException) : WindmillApiException(cause)
    class Transport(cause: IOException) : WindmillApiException(cause)
    class Unexpected(cause: Throwable) : WindmillApiException(cause)
    data class Refused(val status: Int, val refusal: Refusal) : WindmillApiException()
    data object Malformed : WindmillApiException()

    val isUnauthorized: Boolean
        get() = this is Refused && status == 401

    // What to show a person — never a status code.
    val line: String
        get() = when (this) {
            is Offline -> "Can’t reach windmill.works"
            is Timeout -> "That took too long. Try again."
            is Transport -> "That connection was interrupted. Try again."
            is Unexpected -> "That didn’t go through"
            is Refused -> refusal.message ?: "That didn’t go through"
            is Malformed -> "That didn’t go through"
        }
}
