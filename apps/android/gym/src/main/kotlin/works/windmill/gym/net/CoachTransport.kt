package works.windmill.gym.net

import java.io.IOException
import kotlinx.serialization.Serializable
import okio.BufferedSource
import works.windmill.gym.domain.AskGeneration
import works.windmill.gym.domain.CoachAttachment
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson

@Serializable
internal data class CoachStreamIn(val thread: String, val question: String, val requestId: String,
    val attachmentIds: List<String>, val stream: Boolean)

@Serializable
internal data class CoachSnapshotOut(val thread: String, val generation: AskGeneration)

@Serializable
internal data class CoachErrorOut(val status: Int, val generation: AskGeneration? = null)

@Serializable
internal data class CoachPhotoOut(val attachment: CoachAttachment)

internal object CoachEvents {
    fun read(source: BufferedSource, threadId: String, requestId: String, onSnapshot: (AskGeneration) -> Unit): AskGeneration {
        var event = ""
        val data = StringBuilder()
        var current: AskGeneration? = null
        while (true) {
            val line = source.readUtf8Line() ?: break
            if (line.isNotEmpty()) {
                if (line.startsWith("event:")) event = line.substringAfter(':').trim()
                if (line.startsWith("data:")) {
                    if (data.isNotEmpty()) data.append('\n')
                    data.append(line.substringAfter(':').removePrefix(" "))
                    if (data.length > 2_000_000) throw WindmillApiException.Malformed
                }
                continue
            }
            if (data.isEmpty()) { event = ""; continue }
            val body = data.toString()
            data.clear()
            if (event == "error") {
                val refusal = WindmillJson.decodeFromString<Refusal>(body)
                val error = WindmillJson.decodeFromString<CoachErrorOut>(body)
                error.generation?.let { generation ->
                    if (generation.requestId != requestId || (current != null && generation.id != current?.id)) throw WindmillApiException.Malformed
                    if (current == null || generation.revision > requireNotNull(current).revision) {
                        current = generation
                        onSnapshot(generation)
                    }
                }
                throw WindmillApiException.Refused(error.status, refusal)
            }
            if (event != "snapshot") { event = ""; continue }
            event = ""
            val snapshot = WindmillJson.decodeFromString<CoachSnapshotOut>(body)
            val generation = snapshot.generation
            if (snapshot.thread != threadId || generation.requestId != requestId) throw WindmillApiException.Malformed
            if (generation.status !in setOf("running", "completed", "failed", "stopped") || generation.revision < 0 ||
                (current != null && generation.id != requireNotNull(current).id)) throw WindmillApiException.Malformed
            if (current != null && generation.revision <= requireNotNull(current).revision) continue
            current = generation
            onSnapshot(generation)
            if (generation.terminal) return generation
        }
        throw IOException("Coach response interrupted")
    }
}
