package works.windmill.gym.coach.onboarding

import kotlinx.serialization.Serializable
import works.windmill.gym.coach.CoachAttachment
import works.windmill.platform.net.WindmillJson

// The signed-out onboarding answers earlier versions kept on this phone: their shape, so an archived chat still draws them, and the routines they drafted can still be saved. Nothing here sends.

@Serializable
private class AskedInBody(val text: String)

@Serializable
data class CoachOnboardingResponse(
    val requestId: String,
    val resultId: String,
    val status: String,
    val routines: List<Routine>,
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
    val question: String get() = WindmillJson.decodeFromString(AskedInBody.serializer(), body).text

    // Whether `question` can be read: an answer with a body this build cannot is lost to the room, and stays on disk.
    val readable: Boolean get() = try { question; true } catch (_: IllegalArgumentException) { false }
}
