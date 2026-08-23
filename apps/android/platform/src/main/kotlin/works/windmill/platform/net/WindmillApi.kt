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
    private val client: OkHttpClient = OkHttpClient(),
) {
    suspend inline fun <reified Reply> get(path: String): Reply = send("GET", path)

    suspend inline fun <reified Reply> send(method: String, path: String, body: Any? = null): Reply =
        decode(perform(method, path, encode(body)).body)

    // The session is minted only as a Set-Cookie.
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
        // Resolve as a whole relative reference: appending segments percent-encodes `?` and `&`.
        val url = baseUrl.resolve(path) ?: throw WindmillApiException.Malformed
        val request = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .apply { credential()?.let { header("Authorization", "Bearer $it") } }
            // OkHttp refuses to build a bodiless POST, so a write with no JSON carries an empty body.
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

sealed class WindmillApiException : Exception() {
    data object Offline : WindmillApiException()
    data class Refused(val status: Int, val refusal: Refusal) : WindmillApiException()
    data object Malformed : WindmillApiException()

    val isUnauthorized: Boolean
        get() = this is Refused && status == 401

    // What to show a person — never a status code.
    val line: String
        get() = when (this) {
            is Offline -> "Can't reach windmill.works"
            is Refused -> refusal.message ?: "That didn't go through"
            is Malformed -> "That didn't go through"
        }
}
