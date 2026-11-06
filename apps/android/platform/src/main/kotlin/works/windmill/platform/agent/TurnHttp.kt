package works.windmill.platform.agent

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import works.windmill.agent.ToolOutcome
import works.windmill.agent.TurnConnectionLost
import works.windmill.agent.TurnEvent
import works.windmill.agent.TurnOpen
import works.windmill.agent.TurnRefusal
import works.windmill.agent.TurnSeat
import works.windmill.agent.TurnSse
import works.windmill.agent.TurnTransport
import works.windmill.agent.TurnWireFault
import works.windmill.agent.json
import works.windmill.agent.turnAnswer
import works.windmill.platform.telemetry.TelemetryPolicy
import works.windmill.sync.core.Json

// The four routes of a turn over OkHttp. `connectTimeout` bounds reaching the server, so a black-holed network hands the question back in about a minute; `idleTimeout` bounds silence, so frames and heartbeats keep a stream open; `totalTimeout` bounds any one call, a stream included. Each ending is a lost connection, which the driver resumes, and so is a 2xx that is no event stream. A credential stays on the configured host, so no redirect is followed and no cookie is kept.
class TurnHttp(
    private val baseUrl: HttpUrl,
    private val route: String,
    private val schemaVersion: Int,
    client: OkHttpClient,
    idleTimeout: Duration = 60.seconds,
    totalTimeout: Duration = 3600.seconds,
    connectTimeout: Duration = 10.seconds,
) : TurnTransport {
    private val client = client.newBuilder()
        .connectTimeout(connectTimeout.inWholeMilliseconds, TimeUnit.MILLISECONDS)
        .readTimeout(idleTimeout.inWholeMilliseconds, TimeUnit.MILLISECONDS)
        .writeTimeout(idleTimeout.inWholeMilliseconds, TimeUnit.MILLISECONDS)
        .callTimeout(totalTimeout.inWholeMilliseconds, TimeUnit.MILLISECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .cookieJar(CookieJar.NO_COOKIES)
        .build()

    override fun open(open: TurnOpen, seat: TurnSeat): Flow<TurnEvent> = stream { request(route, seat, open.json) }

    override fun resume(turnId: String, seat: TurnSeat): Flow<TurnEvent> = stream { request("$route/$turnId", seat, null) }

    override suspend fun answer(turnId: String, batch: Int, results: List<ToolOutcome>, seat: TurnSeat) {
        exchange(request("$route/$turnId/results", seat, turnAnswer(batch, results)))
    }

    override suspend fun stop(turnId: String, seat: TurnSeat) {
        exchange(request("$route/$turnId/stop", seat, Json.objectOf()))
    }

    // A turn route under the configured host, and its seat's credential alone.
    private fun request(path: String, seat: TurnSeat, body: Json?): Request {
        val url = baseUrl.resolve(path)
        if (url == null || ".." in path || !url.encodedPath.startsWith(route) || url.scheme != baseUrl.scheme || url.host != baseUrl.host || url.port != baseUrl.port) {
            throw TurnWireFault(TurnWireFault.badAddress)
        }
        val builder = Request.Builder().url(url).header("Sync-Schema", schemaVersion.toString())
        when (seat) {
            is TurnSeat.Bound -> builder.header("Authorization", "Bearer ${seat.token}")
            is TurnSeat.Anon -> builder.header("X-Windmill-Installation", seat.credential)
        }
        if (body != null) builder.post(body.jcs.encodeToByteArray().toRequestBody(jsonType))
        return builder.build()
    }

    // A one-shot post: accepted, or the refusal its body names. Its answer holds nothing a phone reads.
    private suspend fun exchange(request: Request) {
        try {
            suspendCancellableCoroutine<Unit> { continuation ->
                val call = client.newCall(request)
                continuation.invokeOnCancellation { call.cancel() }
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) = continuation.resumeWithException(e)
                    override fun onResponse(call: Call, response: Response) {
                        continuation.resumeWith(runCatching { response.use { accepted(it) }; Unit })
                    }
                })
            }
        } catch (failure: IOException) {
            throw connectionFailure(failure)
        }
    }

    // The frames of one stream until its closing frame; a stream that ends before one is a lost connection. The reader never waits on its collector, so a cancel frees its thread at once. What it queues while a batch runs is bounded per frame by TurnSse, and in number by what the server sends: one turn's bounded answer, within `totalTimeout`.
    private fun stream(request: () -> Request): Flow<TurnEvent> = callbackFlow {
        val call = client.newCall(request().newBuilder().header("Accept", "text/event-stream").build())
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                close(connectionFailure(e))
            }

            override fun onResponse(call: Call, response: Response) {
                try {
                    response.use { read(it) { event -> trySend(event).isSuccess } }
                    close()
                } catch (failure: IOException) {
                    close(connectionFailure(failure))
                } catch (failure: Exception) {
                    close(failure)
                }
            }
        })
        awaitClose { call.cancel() }
    }.buffer(Channel.UNLIMITED).flowOn(Dispatchers.IO)

    private fun read(response: Response, emit: (TurnEvent) -> Boolean) {
        val body = accepted(response).body
        val type = body?.contentType()
        if (body == null || type?.type != "text" || type.subtype != "event-stream") throw TurnConnectionLost(null, notAStream = true)
        val source = body.source()
        val parser = TurnSse()
        val chunk = ByteArray(8192)
        while (true) {
            val count = source.read(chunk)
            if (count == -1) throw TurnConnectionLost(null)
            for (event in parser.consume(chunk, count)) {
                if (!emit(event) || event.closing) return
            }
        }
    }

    // A 2xx, or the refusal its body names; a redirect is one of these.
    private fun accepted(response: Response): Response {
        if (!response.isSuccessful) throw TurnRefusal.of(response.code, response.peekBody(boundBytes).bytes())
        return response
    }

    // Lost network is the rule every door shares; any other IOException, a bad certificate among them, stays itself and is reported.
    private fun connectionFailure(failure: IOException): Exception =
        if (TelemetryPolicy.networkLoss(failure)) TurnConnectionLost(failure) else failure

    private companion object {
        val jsonType = "application/json".toMediaType()
        const val boundBytes = TurnSse.maxLineBytes.toLong()
    }
}
