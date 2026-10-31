package works.windmill.gym.coach.onboarding

import android.graphics.BitmapFactory
import java.util.Base64
import kotlinx.serialization.Serializable
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import works.windmill.platform.ai.AiAllowance
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.schema.SyncSchema
import works.windmill.gym.coach.CoachAttachment

@Serializable
data class CoachOnboardingImage(val mimeType: String, val data: String)

@Serializable
data class CoachOnboardingContext(val role: String, val text: String)

@Serializable
data class CoachOnboardingRequest(val requestId: String, val mode: String, val text: String,
    val context: List<CoachOnboardingContext>, val image: CoachOnboardingImage? = null)

@Serializable
data class CoachOnboardingResponse(
    val requestId: String,
    val resultId: String,
    val status: String,
    val expiresAtMs: Long,
    val routines: List<Routine>,
    val allowance: AiAllowance,
    val errorCode: String? = null,
    val message: String = "",
) {
    @Serializable
    data class Routine(val name: String, val entries: List<Entry>)
    @Serializable
    data class Entry(val exerciseId: String, val sets: List<Target>, val restSeconds: Int? = null)
    @Serializable
    data class Target(val reps: Int? = null, val weightKg: Double? = null)

    val terminal: Boolean get() = status in setOf("completed", "failed", "expired")
}

@Serializable
data class CoachOnboardingRecord(val owner: String, val chat: String, val replica: String, val requestId: String,
    val body: String, val createdAtMs: Long, val submitted: Boolean = false,
    val response: CoachOnboardingResponse? = null, val refusalCode: String? = null,
    val attachment: CoachAttachment? = null, val refusalMessage: String? = null) {
    val pending: Boolean get() = refusalCode == null && response?.terminal != true
    fun request(): CoachOnboardingRequest = WindmillJson.decodeFromString(CoachOnboardingRequest.serializer(), body)

    companion object {
        // A request the server never answered: it never arrived, or a newer question replaced it before it was read.
        const val unanswered = "unanswered"
    }
}

enum class CoachOnboardingLimit { text, contextTurns, contextBytes, contextText, photoBytes, photoFormat, photoEdge, invalidInput }

object CoachOnboardingLimits {
    const val textBytes = 4_000
    const val contextTurns = 12
    const val contextBytes = 16_000
    const val photoBytes = 1024 * 1024
    const val photoEdge = 4096
    private val requestId = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
    fun validRequestId(value: String): Boolean = requestId.matches(value)

    fun violation(request: CoachOnboardingRequest): CoachOnboardingLimit? {
        if (!requestId.matches(request.requestId) || request.mode != "conversation" ||
            request.text.contains('\u0000') || request.text.isBlank() && request.image == null) return CoachOnboardingLimit.invalidInput
        if (request.text.toByteArray(Charsets.UTF_8).size > textBytes) return CoachOnboardingLimit.text
        if (request.context.size > contextTurns) return CoachOnboardingLimit.contextTurns
        if (request.context.any { it.role !in setOf("user", "assistant") || it.text.isBlank() || it.text.contains('\u0000') ||
                it.text.toByteArray(Charsets.UTF_8).size > textBytes }) return CoachOnboardingLimit.contextText
        if (request.context.sumOf { it.text.toByteArray(Charsets.UTF_8).size } > contextBytes) return CoachOnboardingLimit.contextBytes
        val image = request.image ?: return null
        if (image.mimeType !in setOf("image/jpeg", "image/png")) return CoachOnboardingLimit.photoFormat
        if (image.data.length > 4 * ((photoBytes + 2) / 3)) return CoachOnboardingLimit.photoBytes
        val bytes = try { Base64.getDecoder().decode(image.data) }
            catch (_: IllegalArgumentException) { return CoachOnboardingLimit.photoFormat }
        if (bytes.size > photoBytes) return CoachOnboardingLimit.photoBytes
        if (Base64.getEncoder().encodeToString(bytes) != image.data) return CoachOnboardingLimit.photoFormat
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outMimeType != image.mimeType || bounds.outWidth <= 0 || bounds.outHeight <= 0) return CoachOnboardingLimit.photoFormat
        if (bounds.outWidth > photoEdge || bounds.outHeight > photoEdge) return CoachOnboardingLimit.photoEdge
        return null
    }
}

interface CoachOnboardingApi {
    suspend fun start(body: String, credential: String): CoachOnboardingResponse
    suspend fun get(requestId: String, credential: String): CoachOnboardingResponse
}

class CoachOnboardingHttp(baseUrl: HttpUrl, telemetry: Telemetry = Telemetry.None) : CoachOnboardingApi {
    private val api = WindmillApi(baseUrl, { null }, telemetry = telemetry)
    private fun api(credential: String) = api.withHeaders(mapOf("Sync-Schema" to SyncSchema.version.toString(),
        "X-Windmill-Installation" to credential))

    override suspend fun start(body: String, credential: String): CoachOnboardingResponse =
        api(credential).consume("POST", "/v1/gym/coach/onboarding", body.toRequestBody("application/json".toMediaType()),
            operation = "gym.coachOnboarding", read = ::response)

    override suspend fun get(requestId: String, credential: String): CoachOnboardingResponse {
        require(CoachOnboardingLimits.validRequestId(requestId))
        return api(credential).consume("GET", "/v1/gym/coach/onboarding/$requestId", operation = "gym.coachOnboarding", read = ::response)
    }

    private fun response(response: Response): CoachOnboardingResponse {
        val source = response.body?.source() ?: throw WindmillApiException.Malformed
        source.request(2_000_001)
        if (source.buffer.size > 2_000_000) throw WindmillApiException.Malformed
        return WindmillJson.decodeFromString(CoachOnboardingResponse.serializer(), source.readUtf8())
    }
}
