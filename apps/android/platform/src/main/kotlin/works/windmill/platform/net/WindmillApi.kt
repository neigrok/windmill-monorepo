package works.windmill.platform.net

import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.serializer
import okhttp3.Cookie
import okhttp3.Headers
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

// The one place the native app talks to the backend it was built against — the mirror of
// web/src/shell/apiBase.js and of the iOS WindmillApi. On the web the session is an HttpOnly cookie
// and the browser carries it; a native app holds the same secret in its own store and sends it as
// `Authorization: Bearer`, which the backend has accepted since AUTH.md.
//
// Where the backend lives is read from :app's BuildConfig.WM_API_BASE_URL (the native
// VITE_API_BASE_URL), so a debug build points at the local windmill_server without a code change.

// Every wire read and write in the app goes through this one Json: an unknown key is a future
// server's business, and an absent optional is OMITTED on the way out, never null.
val WindmillJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
}

class WindmillApi(
    val baseUrl: HttpUrl,
    private val credential: () -> String?,
    private val client: OkHttpClient = OkHttpClient(),
) {
    suspend inline fun <reified Reply> get(path: String): Reply = send("GET", path)

    suspend inline fun <reified Reply> send(method: String, path: String, body: Any? = null): Reply =
        decode(perform(method, path, encode(body)).body)

    // The one call that reads a header instead of a body: POST /v1/auth/verify answers with the
    // user and mints the session as a Set-Cookie, and only as a cookie — deliberately, because
    // putting a 90-day secret in a body would hand it to any XSS on the web. Native is not a
    // browser, so it lifts the same value out of the header and puts it in the session store.
    suspend inline fun <reified Reply> sendCapturingSession(
        method: String,
        path: String,
        body: Any? = null,
    ): Captured<Reply> {
        val answer = perform(method, path, encode(body))
        return Captured(decode(answer.body), sessionCookie(answer.headers))
    }

    @PublishedApi
    internal suspend fun perform(method: String, path: String, json: String?): Answer {
        // Resolved as a WHOLE relative reference, never by appending path segments: a segment
        // append percent-encodes `?` and `&` into the path, so every endpoint carrying a query
        // silently becomes a 404. It cost nothing at the call site and broke half the journal's
        // reads on iOS — the same trap, closed the same way.
        val url = baseUrl.resolve(path) ?: throw WindmillApiException.Malformed
        val request = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .apply { credential()?.let { header("Authorization", "Bearer $it") } }
            // OkHttp refuses to build a bodiless POST, and /v1/auth/logout is exactly that — so a
            // write with no JSON carries an empty body rather than a crash.
            .method(
                method,
                when {
                    json != null -> json.toRequestBody("application/json".toMediaType())
                    method == "POST" || method == "PUT" || method == "PATCH" -> ByteArray(0).toRequestBody()
                    else -> null
                },
            )
            .build()
        val answer = try {
            withContext(Dispatchers.IO) {
                client.newCall(request).execute().use { response ->
                    Answer(response.code, response.body?.string().orEmpty(), response.headers)
                }
            }
        } catch (transport: IOException) {
            // No reachable host. Callers that own writing turn this into "offline · saved here"
            // rather than an error — a device with no signal has not lost anything.
            throw WindmillApiException.Offline
        }
        if (answer.code !in 200..299) {
            throw WindmillApiException.Refused(
                answer.code,
                runCatching { WindmillJson.decodeFromString<Refusal>(answer.body) }.getOrDefault(Refusal()),
            )
        }
        return answer
    }

    @Suppress("UNCHECKED_CAST")
    @PublishedApi
    internal inline fun <reified Reply> decode(body: String): Reply {
        // The caller that asked for nothing gets nothing: a 204 carries no JSON, and a reply
        // nobody reads never earns a parse — the iOS Empty special case, spelled Unit.
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
        // Empty means production — the same rule iOS reads WMApiBaseURL by, so a release build
        // configures nothing and a debug build points at the local stack (http://10.0.2.2:8088).
        fun resolvedBaseUrl(configured: String): HttpUrl {
            if (configured.isBlank()) return "https://windmill.works".toHttpUrl()
            return configured.toHttpUrlOrNull() ?: "https://windmill.works".toHttpUrl()
        }
    }
}

data class Captured<Reply>(val reply: Reply, val session: String?)

// What the backend said when it refused. The house copy is written on the server (AUTH.md: "copy is
// verbatim from auth.md §7"), so the app shows these words rather than inventing its own — one
// sentence lives in one place and the surfaces cannot drift apart in tone.
@Serializable
data class Refusal(
    @SerialName("error") val message: String? = null,
    val detail: String? = null,
    val code: String? = null,
)

sealed class WindmillApiException : Exception() {
    data object Offline : WindmillApiException()
    data class Refused(val status: Int, val refusal: Refusal) : WindmillApiException()
    data object Malformed : WindmillApiException()

    val isUnauthorized: Boolean
        get() = this is Refused && status == 401

    // What to show a person. The server's own sentence when it sent one; otherwise the app's, and
    // never a status code — a number is not a thing anyone can act on.
    val line: String
        get() = when (this) {
            is Offline -> "Can't reach windmill.works"
            is Refused -> refusal.message ?: "That didn't go through"
            is Malformed -> "That didn't go through"
        }
}
