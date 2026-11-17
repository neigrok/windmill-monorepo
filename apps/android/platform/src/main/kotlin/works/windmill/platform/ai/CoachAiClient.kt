package works.windmill.platform.ai

import java.net.URLEncoder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import works.windmill.agent.coach.*
import works.windmill.sync.core.Json

class CoachAiClient(private val transport: AiTransport, private val telemetry: Telemetry,
    private val now: () -> Long = { System.nanoTime() / 1_000_000 },
    private val wait: suspend (Long, StopSignal) -> Boolean = { ms, stop -> stop.wait(ms) }) : AiClient {
    private class Pass(val value: String, val until: Long, val use: String, val version: Long)
    @Volatile private var passLock = Mutex()
    private val state = Any()
    @Volatile private var generation = 0L
    private var pass: Pass? = null
    private val uploads = mutableSetOf<String>()
    override fun clearPass() = synchronized(state) { generation++; pass = null; passLock = Mutex(); uploads.clear() }
    private fun report(operation: FailureOperation) { try { telemetry.failure(operation) } catch (_: Exception) {} }

    private suspend fun <T : Any> withStop(stop: StopSignal?, discard: (T) -> Unit = {}, dispatch: suspend () -> T): T {
        if (stop == null) return dispatch()
        if (stop.stopped) throw AiTransportFailure("stopped")
        return coroutineScope {
            var response: T? = null
            var accepted = false
            val call = async { dispatch().also { response = it } }
            val stopped = async { stop.wait(Long.MAX_VALUE) }
            try {
                select {
                    call.onAwait { accepted = true; it }
                    stopped.onAwait { throw AiTransportFailure("stopped") }
                }
            } finally {
                withContext(NonCancellable) {
                    call.cancelAndJoin()
                    stopped.cancelAndJoin()
                    if (!accepted) response?.let(discard)
                }
            }
        }
    }

    private suspend fun credential(use: String, version: Long, expectedGeneration: Long, force: Boolean, stop: StopSignal? = null): Pair<String?, AiAnswer.Failure?> = withStop(stop) { passLock.withLock {
        synchronized(state) {
            if (expectedGeneration != generation) throw AiTransportFailure("seat-changed")
            if (!force) pass?.takeIf { it.use == use && it.version == version && it.until - now() >= 60_000 }?.let { return@withLock it.value to null }
        }
        val response = try { transport.pass(Json.objectOf("client" to Json.of("android"), "use" to Json.of(use), "version" to Json.of(version))) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) {
            if (expectedGeneration != generation) throw AiTransportFailure("seat-changed")
            if (error is AiTransportFailure && error.code == "stopped") throw error
            if (error is AiTransportFailure && error.code in setOf("offline", "lost"))
                return@withLock null to AiAnswer.Failure(AiFailure("transport", null, Admission.none))
            report(FailureOperation.aiPass)
            return@withLock null to AiAnswer.Failure(AiFailure("pass", null, Admission.none))
        }
        response.use {
            synchronized(state) {
                if (expectedGeneration != generation) throw AiTransportFailure("seat-changed")
                if (response.status != 200) {
                    val code = AiWire.passRefusal(response)
                    if (code == null) {
                        if (response.status == 404) return@withLock null to AiAnswer.Failure(AiFailure("pass", "anonymous_ai_unavailable", Admission.none))
                        return@withLock null to AiAnswer.Failure(AiFailure("transport", null, Admission.none))
                    }
                    if (code in defects) report(FailureOperation.aiPass)
                    return@withLock null to AiAnswer.Failure(AiFailure("pass", code, Admission.none))
                }
                try {
                    response.body!!.expectKeys(listOf("pass", "expiresIn"))
                    val value = response.body.member("pass").str()
                    val expires = response.body.member("expiresIn").long(1)
                    require(value.isNotEmpty())
                    pass = Pass(value, now() + expires, use, version)
                    value to null
                } catch (_: Exception) {
                    report(FailureOperation.aiPass)
                    null to AiAnswer.Failure(AiFailure("pass", "invalid-answer", Admission.none))
                }
            }
        }
    } }

    override suspend fun text(callId: String, request: Json, pictures: List<Picture>, label: String, use: String, version: Long, stop: StopSignal, onText: suspend (String) -> Unit): AiAnswer {
        val currentGeneration = generation
        if (stop.invalidated) return AiAnswer.Failure(AiFailure("pass", null, Admission.none))
        val body = request.jcs
        return operation(currentGeneration, callId, body, pictures, label, use, version, stop, onText, false)
    }
    override suspend fun result(callId: String, use: String, version: Long, stop: StopSignal, onText: suspend (String) -> Unit): AiAnswer =
        operation(generation, callId, null, emptyList(), "", use, version, stop, onText, true)

    suspend fun allowance(use: String, version: Long): Pair<Json?, AiAnswer.Failure?> {
        val currentGeneration = generation
        var refreshed = false
        try {
            while (true) {
                val (pass, refusal) = credential(use, version, currentGeneration, refreshed)
                if (refusal != null) return null to refusal
                transport.request(AiRequest("GET", "/v1/allowance", pass!!)).use { response ->
                    if (currentGeneration != generation) return null to AiAnswer.Failure(AiFailure("pass", null, Admission.none))
                    if (response.status == 200) { AiWire.allowance(response.body!!); return response.body to null }
                    val refusalBody = AiWire.refusal(response) ?: return null to failedAnswer("transport", null, Admission.none)
                    val code = refusalBody.member("code").str()
                    val allowance = refusalBody.member("allowance").orNull()
                    if (code == "pass_expired" && !refreshed) refreshed = true
                    else return null to failedAnswer("text", code, Admission.none, allowance)
                }
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) {
            if (currentGeneration != generation || error is AiTransportFailure && error.code == "seat-changed")
                return null to AiAnswer.Failure(AiFailure("pass", null, Admission.none))
            val lost = error is AiTransportFailure && error.code in setOf("offline", "lost")
            return null to failedAnswer(if (error is AiTransportFailure && error.code != "invalid-answer") "transport" else "wire", if (lost) null else "invalid-answer", Admission.none)
        }
    }

    private fun failedAnswer(source: String, code: String?, admission: Admission, allowance: Json? = null): AiAnswer.Failure {
        if (code in defects || code?.startsWith("pass_") == true || code == "picture_gone" || source == "transport" && code != null) report(FailureOperation.aiCall)
        return AiAnswer.Failure(AiFailure(source, code, admission, allowance))
    }

    private suspend fun operation(currentGeneration: Long, callId: String, body: String?, pictures: List<Picture>, label: String, use: String, version: Long, stop: StopSignal, onText: suspend (String) -> Unit, recover: Boolean): AiAnswer {
        require(Regex("[A-Za-z0-9_-]{22,64}").matches(callId))
        var start: Long? = if (recover) now() else null
        var admission = if (recover) Admission.admitted else Admission.none
        var lost = recover
        var retryLostCall = recover
        var cursor = 0L
        var retry = 0
        var refresh = false
        var pictureRepair = false
        var forcePass = false
        var lastFailure: AiAnswer.Failure? = null
        var callbackFailure: Throwable? = null
        fun promote(value: Admission) { if (value > admission) admission = value }
        fun seatChanged() = AiAnswer.Failure(AiFailure("pass", null, admission))
        fun expired(): AiAnswer.Failure? {
            val firstRequest = start ?: return null
            if (now() >= firstRequest + 1_200_000) return failedAnswer("result", "answer-timeout", admission)
            if (retry > 0 && !retryLostCall && now() >= firstRequest + 30_000) return lastFailure
            return null
        }
        operation@ while (true) {
            if (currentGeneration != generation || stop.invalidated) return seatChanged()
            expired()?.let { return it }
            try {
                val (pass, refusal) = credential(use, version, currentGeneration, forcePass, stop.takeIf { start != null })
                if (currentGeneration != generation || stop.invalidated) return seatChanged()
                expired()?.let { return it }
                if (refusal != null) {
                    if (admission != Admission.none && (refusal.failure.source == "transport" || refusal.failure.code in setOf("rate_limited", "unavailable"))) {
                        forcePass = true
                        throw AiTransportFailure("lost")
                    }
                    return AiAnswer.Failure(refusal.failure.copy(admission = admission))
                }
                forcePass = false
                for (picture in pictures) {
                    if (synchronized(state) { picture.pictureId in uploads }) continue
                    if (currentGeneration != generation || stop.invalidated) return seatChanged()
                    expired()?.let { return it }
                    withStop(stop.takeIf { start != null }, AiResponse::close) { transport.request(AiRequest("PUT", "/v1/pictures/${picture.pictureId}", pass!!, bytes = picture.bytes, mediaType = picture.mediaType)) }.use { response ->
                        if (currentGeneration != generation || stop.invalidated) return seatChanged()
                        if (response.status != 204) {
                            val refusalBody = AiWire.refusal(response) ?: throw AiTransportFailure("lost")
                            val code = refusalBody.member("code").str()
                            val allowance = refusalBody.member("allowance").orNull()
                            if (code == "pass_expired" && !refresh) { refresh = true; forcePass = true }
                            else return failedAnswer("text", code, admission, allowance)
                        } else synchronized(state) { if (currentGeneration == generation) uploads += picture.pictureId }
                    }
                    if (forcePass) continue@operation
                }
                val read = recover || cursor > 0
                val path = if (read) "/v1/calls/$callId/result" + if (cursor > 0) "?after=$cursor" else "" else "/v1/calls/$callId/text?label=" + URLEncoder.encode(label, "UTF-8").replace("+", "%20")
                val retryStop = stop.takeIf { start != null }
                if (start == null) start = now()
                if (currentGeneration != generation || stop.invalidated) return seatChanged()
                expired()?.let { return it }
                val response = try { withStop(retryStop, AiResponse::close) { transport.request(AiRequest(if (read) "GET" else "PUT", path, pass!!, if (read) null else body, timeoutMs = maxOf(1, start!! + 1_200_000 - now()))) } }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    if (currentGeneration != generation || stop.invalidated) return seatChanged()
                    if (error is AiTransportFailure && error.code == "stopped") return AiAnswer.Failure(AiFailure("result", "stopped", admission))
                    promote(Admission.possible); lost = true; retryLostCall = true
                    if (error !is AiTransportFailure || error.code !in setOf("offline", "lost")) return failedAnswer("transport", "invalid-answer", admission)
                    null
                }
                var repaired = false
                response?.use {
                    if (currentGeneration != generation || stop.invalidated) return seatChanged()
                    if (response.status != 200) {
                        val refusalBody = AiWire.refusal(response)
                        if (refusalBody == null) {
                            promote(Admission.possible); lost = true; retryLostCall = true
                            return@use
                        }
                        val code = refusalBody.member("code").str()
                        val allowance = refusalBody.member("allowance").orNull()
                        if (code in setOf("busy", "accounting_unavailable")) promote(Admission.possible)
                        if (code == "pass_expired" && !refresh) { refresh = true; forcePass = true }
                        else if (code == "picture_gone" && !pictureRepair && pictures.isNotEmpty() && !read) {
                            pictureRepair = true; repaired = true
                            synchronized(state) { pictures.forEach { uploads.remove(it.pictureId) } }
                            forcePass = false
                        } else {
                            retryLostCall = lost && code in setOf("rate_limited", "busy", "accounting_unavailable")
                            val retryable = retryLostCall || !read && code in transient
                            if (!retryable) {
                                if (recover && code == "call_unknown") return AiAnswer.Failure(AiFailure("result", code, admission, allowance))
                                return failedAnswer(if (read) "result" else "text", code, admission, allowance)
                            }
                            lastFailure = AiAnswer.Failure(AiFailure(if (read) "result" else "text", code, admission, allowance))
                        }
                        if (forcePass || repaired) return@use
                    } else {
                        promote(Admission.possible)
                        try {
                            val terminal = response.events?.firstOrNull { event ->
                                if (currentGeneration != generation || stop.invalidated) throw AiTransportFailure("seat-changed")
                                AiWire.event(event)
                                val id = event.member("id").long(1)
                                if (id <= cursor) return@firstOrNull false
                                cursor = id; promote(Admission.admitted)
                                val name = event.member("event").str()
                                val data = event.member("data")
                                if (name == "started" && data.member("callId").str() != callId) throw AiTransportFailure("invalid-answer")
                                if (name == "text") try { onText(data.member("delta").str()) } catch (error: Throwable) { callbackFailure = error; throw error }
                                name == "ended" || name == "failed"
                            } ?: run { lost = true; retryLostCall = true; null }
                            if (terminal != null) {
                                val event = terminal.member("event").str()
                                val data = terminal.member("data")
                                if (event == "failed" && data.member("code").str() in defects) report(FailureOperation.aiCall)
                                return AiAnswer.Terminal(event, data)
                            }
                        } catch (error: AiTransportFailure) {
                            if (error.code !in setOf("lost", "offline")) throw error
                            lost = true; retryLostCall = true
                        }
                    }
                }
                if (forcePass || repaired) continue
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                if (callbackFailure === error || error is HostUnavailable) throw error
                if (currentGeneration != generation || stop.invalidated || error is AiTransportFailure && error.code == "seat-changed") return seatChanged()
                if (error is AiTransportFailure && error.code == "stopped") return AiAnswer.Failure(AiFailure("result", "stopped", admission))
                if (error is AiTransportFailure && error.code in setOf("offline", "lost")) {
                    if (admission == Admission.none) return failedAnswer("transport", null, admission)
                    lost = true; retryLostCall = true
                } else return failedAnswer("wire", "invalid-answer", admission)
            }
            val deadline = start!! + if (retryLostCall) 1_200_000 else 30_000
            val delay = minOf(1000L shl minOf(retry++, 3), maxOf(0, deadline - now()))
            if (delay == 0L) return if (retryLostCall) failedAnswer("result", "answer-timeout", admission) else lastFailure!!
            if (!wait(delay, stop)) return AiAnswer.Failure(AiFailure("result", "stopped", admission))
        }
    }
    private companion object {
        val transient = setOf("busy", "paused", "rate_limited", "concurrency_exhausted", "accounting_unavailable", "provider_unavailable")
        val defects = setOf("invalid_request", "too_large", "provider_rejected", "funding_required", "conflict", "call_unknown", "invalid-answer", "untrusted-origin", "unsupported-media-type")
    }
}
