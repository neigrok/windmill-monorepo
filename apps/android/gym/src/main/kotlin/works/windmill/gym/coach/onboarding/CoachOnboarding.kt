package works.windmill.gym.coach.onboarding

import kotlinx.serialization.Serializable
import works.windmill.gym.coach.CoachAttachment
import works.windmill.platform.ai.AiAllowance
import works.windmill.platform.net.WindmillJson

// The signed-out onboarding answers earlier versions kept on this phone: their shape, so an archived chat still draws them, and the routines they drafted can still be saved. Nothing here sends.

@Serializable
data class CoachOnboardingRequest(val text: String)

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
}

@Serializable
data class CoachOnboardingRecord(val owner: String, val chat: String, val replica: String, val requestId: String,
    val body: String, val createdAtMs: Long,
    val response: CoachOnboardingResponse? = null, val refusalCode: String? = null,
    val attachment: CoachAttachment? = null, val refusalMessage: String? = null) {
    fun request(): CoachOnboardingRequest = WindmillJson.decodeFromString(CoachOnboardingRequest.serializer(), body)
}
