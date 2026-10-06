package works.windmill.gym.net

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
import works.windmill.gym.domain.CoachAttachment
import works.windmill.platform.net.WindmillJson
import works.windmill.gym.domain.AskAnswer
import works.windmill.gym.domain.AskQuestion
import works.windmill.gym.domain.ThreadPage
import works.windmill.gym.domain.CoachResult
import works.windmill.gym.domain.AskGeneration
import works.windmill.gym.domain.AnswerReceipt
import works.windmill.gym.domain.AskStep
import works.windmill.gym.domain.ReadTally
import works.windmill.gym.domain.AskThread
import works.windmill.gym.domain.McpKey
import works.windmill.gym.domain.OAuthGrant
import works.windmill.gym.domain.SessionShare
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
        val reply = api.send<AskReplyOut>("POST", "/v1/gym/ask", question, timeoutSeconds = 660, operation = "gym_ask")
        if (reply.generation?.status == "running") return AskAnswer("", ReadTally(), generation = reply.generation)
        if (reply.generation?.status == "stopped") return reply.generation.response()
        return AskAnswer(reply.answer ?: throw WindmillApiException.Malformed, reply.read ?: throw WindmillApiException.Malformed,
            reply.steps, reply.proposals, reply.receipt, reply.generation, reply.results)
    }

    override suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit): AskAnswer {
        val requestId = requireNotNull(question.requestId)
        val body = WindmillJson.encodeToString(CoachStreamIn.serializer(), CoachStreamIn(question.thread, question.question,
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
        api.send<CoachSnapshotOut>("POST", "/v1/gym/threads/$threadId/generations/$requestId/stop", operation = "gym_ask_stop").generation

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
            WindmillJson.decodeFromString<CoachPhotoOut>(it.body?.string().orEmpty()).attachment
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
        api.get<Grants>("/v1/oauth/grants", operation = "gym_grants").grants

    override suspend fun mcpKeys(): List<McpKey> =
        api.get<Keys>("/v1/mcp-keys", operation = "gym_mcp_keys").keys
}

@Serializable
private data class AskReplyOut(
    val answer: String? = null,
    val read: ReadTally? = null,
    val steps: List<AskStep> = emptyList(),
    val proposals: List<String> = emptyList(),
    val receipt: AnswerReceipt? = null,
    val generation: AskGeneration? = null,
    val results: List<CoachResult> = emptyList(),
)

@Serializable
private data class Grants(val grants: List<OAuthGrant> = emptyList())

@Serializable
private data class Keys(val keys: List<McpKey> = emptyList())
