package works.windmill.gym.net

import java.io.IOException
import kotlinx.serialization.Serializable
import okhttp3.MediaType.Companion.toMediaType
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.Job
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.channels.Channel
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import okio.BufferedSource
import works.windmill.gym.coach.CoachAttachment
import works.windmill.platform.net.WindmillJson
import works.windmill.gym.coach.AskAnswer
import works.windmill.gym.coach.AskQuestion
import works.windmill.gym.coach.ThreadPage
import works.windmill.gym.coach.CoachResult
import works.windmill.gym.coach.AskGeneration
import works.windmill.gym.coach.AnswerReceipt
import works.windmill.gym.coach.AskStep
import works.windmill.gym.coach.ReadTally
import works.windmill.gym.coach.AskThread
import works.windmill.gym.domain.McpKey
import works.windmill.gym.domain.OAuthGrant
import works.windmill.gym.domain.SessionShare
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException

// Pass every path WHOLE, query included: appending it as a path segment percent-encodes `?` and `&`.
class GymHttp(private val api: WindmillApi) : GymRest {
    override suspend fun share(sessionId: String): SessionShare =
        api.send<SessionShare>("POST", "/v1/gym/sessions/$sessionId/share", operation = "gym_share")

    override suspend fun revokeShare(sessionId: String) {
        api.send<Unit>("DELETE", "/v1/gym/sessions/$sessionId/share", operation = "gym_revoke_share")
    }

    override suspend fun ask(question: AskQuestion): AskAnswer {
        val reply = api.send<AskResponse>("POST", "/v1/gym/ask", question, timeoutSeconds = 660, operation = "gym_ask")
        if (reply.generation?.status == "running") return AskAnswer("", ReadTally(), generation = reply.generation)
        if (reply.generation?.status == "stopped") return reply.generation.response()
        return AskAnswer(reply.answer ?: throw WindmillApiException.Malformed, reply.read ?: throw WindmillApiException.Malformed,
            reply.steps, reply.proposals, reply.receipt, reply.generation, reply.results)
    }

    override suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit): AskAnswer {
        val requestId = requireNotNull(question.requestId)
        val body = WindmillJson.encodeToString(CoachStreamRequest.serializer(), CoachStreamRequest(question.thread, question.question,
            requestId, question.attachmentIds, true)).toRequestBody("application/json".toMediaType())
        return coroutineScope {
            val snapshots = Channel<AskGeneration>(Channel.CONFLATED)
            val response = async {
                try {
                    Result.success(api.consume("POST", "/v1/gym/ask", body, "text/event-stream", 660, "gym_ask") { response ->
                        if (response.header("Content-Type")?.substringBefore(';') != "text/event-stream") throw WindmillApiException.Malformed
                        CoachEvents.read(response.body?.source() ?: throw WindmillApiException.Malformed, question.thread, requestId) {
                            snapshots.trySend(it)
                        }.response()
                    })
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Exception) {
                    Result.failure(failure)
                } finally { snapshots.close() }
            }
            for (snapshot in snapshots) onSnapshot(snapshot)
            response.await().getOrThrow()
        }
    }

    override suspend fun stop(threadId: String, requestId: String): AskGeneration =
        api.send<CoachSnapshotResponse>("POST", "/v1/gym/threads/$threadId/generations/$requestId/stop", operation = "gym_ask_stop").generation

    override suspend fun uploadPhoto(threadId: String, photo: CoachAttachment, bytes: ByteArray, onProgress: (Float) -> Unit): CoachAttachment {
        val caller = currentCoroutineContext()
        val callbackContext = caller.minusKey(Job)
        val body = object : RequestBody() {
            override fun contentType() = photo.mediaType.toMediaType()
            override fun contentLength() = bytes.size.toLong()
            override fun writeTo(sink: BufferedSink) {
                var offset = 0
                while (offset < bytes.size) {
                    val count = minOf(16_384, bytes.size - offset)
                    sink.write(bytes, offset, count)
                    offset += count
                    runBlocking(callbackContext) { caller.ensureActive(); onProgress(offset.toFloat() / bytes.size) }
                }
            }
        }
        return api.consume("PUT", "/v1/gym/threads/$threadId/attachments/${photo.id}", body, operation = "gym_coach_photo_upload") {
            WindmillJson.decodeFromString<CoachPhotoResponse>(it.body?.string().orEmpty()).attachment
        }
    }

    override suspend fun photo(threadId: String, attachmentId: String): ByteArray =
        api.consume("GET", "/v1/gym/threads/$threadId/attachments/$attachmentId", accept = "image/jpeg,image/png", operation = "gym_coach_photo") {
            val body = it.body ?: throw WindmillApiException.Malformed
            if (body.contentLength() > 5L * 1024 * 1024) throw WindmillApiException.Malformed
            val source = body.source()
            val buffer = okio.Buffer()
            while (buffer.size <= 5L * 1024 * 1024 && source.read(buffer, minOf(16_384L, 5L * 1024 * 1024 + 1 - buffer.size)) != -1L) Unit
            if (buffer.size > 5L * 1024 * 1024) throw WindmillApiException.Malformed
            buffer.readByteArray()
        }

    override suspend fun threads(cursor: String?): ThreadPage {
        val url = api.baseUrl.newBuilder().addPathSegments("v1/gym/threads").addQueryParameter("limit", "50")
            .apply { cursor?.let { addQueryParameter("cursor", it) } }.build()
        return api.get("${url.encodedPath}?${url.encodedQuery}", operation = "gym_threads")
    }

    override suspend fun thread(id: String, before: String?): AskThread? = try {
        val url = api.baseUrl.newBuilder().addPathSegments("v1/gym/threads").addPathSegment(id).addQueryParameter("limit", "50")
            .apply { before?.let { addQueryParameter("before", it) } }.build()
        api.get<AskThread>("${url.encodedPath}?${url.encodedQuery}", operation = "gym_thread")
    } catch (refused: WindmillApiException.Refused) {
        if (refused.status == 404) null else throw refused
    }

    override suspend fun deleteThread(id: String) {
        api.send<Unit>("DELETE", "/v1/gym/threads/$id", operation = "gym_delete_thread")
    }

    override suspend fun grants(): List<OAuthGrant> =
        api.get<GrantsResponse>("/v1/oauth/grants", operation = "gym_grants").grants

    override suspend fun mcpKeys(): List<McpKey> =
        api.get<McpKeysResponse>("/v1/mcp-keys", operation = "gym_mcp_keys").keys
}

@Serializable
private data class AskResponse(
    val answer: String? = null,
    val read: ReadTally? = null,
    val steps: List<AskStep> = emptyList(),
    val proposals: List<String> = emptyList(),
    val receipt: AnswerReceipt? = null,
    val generation: AskGeneration? = null,
    val results: List<CoachResult> = emptyList(),
)

@Serializable
private data class GrantsResponse(val grants: List<OAuthGrant> = emptyList())

@Serializable
private data class McpKeysResponse(val keys: List<McpKey> = emptyList())

@Serializable
private data class CoachStreamRequest(val thread: String, val question: String, val requestId: String,
    val attachmentIds: List<String>, val stream: Boolean)

@Serializable
internal data class CoachSnapshotResponse(val thread: String, val generation: AskGeneration)

@Serializable
private data class CoachErrorResponse(val status: Int, val generation: AskGeneration? = null)

@Serializable
internal data class CoachPhotoResponse(val attachment: CoachAttachment)

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
                val error = WindmillJson.decodeFromString<CoachErrorResponse>(body)
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
            val snapshot = WindmillJson.decodeFromString<CoachSnapshotResponse>(body)
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
