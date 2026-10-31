package works.windmill.gym.coach.onboarding

import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import works.windmill.gym.coach.LocalCoach
import works.windmill.gym.coach.LocalChat
import works.windmill.gym.coach.CoachAttachment
import works.windmill.platform.ai.AiInstallation
import works.windmill.platform.ai.AiInstallationStorageFailure
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson
import works.windmill.platform.telemetry.Telemetry

data class CoachOnboardingSeat(val owner: String, val replica: String)
enum class AnonymousCoachAccess { Checking, Available, Bound, Unavailable }

private class OnboardingStorageFailure : IOException("The Coach request could not be retained.")

sealed interface CoachOnboardingOutcome {
    data class Answered(val record: CoachOnboardingRecord) : CoachOnboardingOutcome
    data class Refused(val code: String, val record: CoachOnboardingRecord?) : CoachOnboardingOutcome
    data class Limited(val limit: CoachOnboardingLimit, val record: CoachOnboardingRecord) : CoachOnboardingOutcome
    data class Unanswered(val record: CoachOnboardingRecord) : CoachOnboardingOutcome
    data class Failed(val record: CoachOnboardingRecord?) : CoachOnboardingOutcome
}

class CoachOnboardingStore(
    private val local: LocalCoach,
    private val installation: AiInstallation,
    private val api: CoachOnboardingApi,
    private val seat: () -> CoachOnboardingSeat?,
    private val scope: CoroutineScope,
    private val telemetry: Telemetry = Telemetry.None,
    private val storageDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val requestId: () -> String = { UUID.randomUUID().toString() },
    private val now: () -> Long = System::currentTimeMillis,
    private val elapsedNanos: () -> Long = System::nanoTime,
) {
    private enum class Attempt { Send, Recover, Retry }
    private data class ContextTurn(val id: String, val at: Long, val messages: List<CoachOnboardingContext>)
    private data class Active(val record: CoachOnboardingRecord, val job: Deferred<CoachOnboardingOutcome>)
    private val jobs = mutableMapOf<Pair<String, String>, Active>()
    private val revision = MutableStateFlow(0L)
    val changes = revision.asStateFlow()

    suspend fun access(): AnonymousCoachAccess {
        val origin = seat() ?: return AnonymousCoachAccess.Unavailable
        return try {
            installation.forAnonymousSend()
            if (seat() == origin) AnonymousCoachAccess.Available else AnonymousCoachAccess.Unavailable
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: WindmillApiException.Refused) {
            if (seat() == origin && failure.refusal.code in setOf("device_bound", "installation_bound")) AnonymousCoachAccess.Bound
            else AnonymousCoachAccess.Unavailable
        } catch (_: WindmillApiException) { AnonymousCoachAccess.Unavailable }
        catch (failure: Exception) {
            reportUnexpected(failure)
            AnonymousCoachAccess.Unavailable
        }
    }

    fun active(owner: String, chat: String): Boolean = synchronized(jobs) {
        jobs.values.any { it.record.owner == owner && it.record.chat == chat }
    }

    fun send(chat: String, text: String, image: CoachOnboardingImage? = null, attachment: CoachAttachment? = null): Deferred<CoachOnboardingOutcome> {
        try {
            val origin = seat() ?: return CompletableDeferred(CoachOnboardingOutcome.Refused("seat_changed", null))
            val captured = local.archivedChat(origin.owner, chat)
                ?: return CompletableDeferred(CoachOnboardingOutcome.Refused("not_found", null))
            synchronized(jobs) {
                jobs.values.firstOrNull { it.record.owner == origin.owner && it.record.chat == chat }?.let { return it.job }
                val held = local.onboarding().firstOrNull { it.owner == origin.owner && it.chat == chat && it.pending }
                if (held != null && held.request().text == text && held.attachment == attachment) return start(held, Attempt.Recover)
                val id = requestId()
                val request = CoachOnboardingRequest(id, "conversation", text, context(origin.owner, captured), image)
                val record = CoachOnboardingRecord(origin.owner, chat, origin.replica, id,
                    WindmillJson.encodeToString(CoachOnboardingRequest.serializer(), request), now(), attachment = attachment)
                return start(record, Attempt.Send, replaces = held)
            }
        } catch (failure: Exception) {
            reportUnexpected(failure)
            return CompletableDeferred(CoachOnboardingOutcome.Failed(null))
        }
    }

    private fun context(owner: String, chat: LocalChat): List<CoachOnboardingContext> {
        val records = local.onboarding().filter { it.owner == owner && it.chat == chat.id && it.response?.status == "completed" }
        val recorded = records.map { it.requestId }.toSet()
        val turns = chat.exchanges.mapIndexedNotNull { index, exchange ->
            if (exchange.requestId in recorded) return@mapIndexedNotNull null
            val answer = exchange.answer?.answer ?: exchange.generation?.takeIf { it.status == "completed" }?.answer
                ?: return@mapIndexedNotNull null
            ContextTurn(exchange.requestId.ifEmpty { "archive-$index" }, exchange.atMs, buildList {
                if (exchange.question.isNotBlank()) add(CoachOnboardingContext("user", exchange.question))
                if (answer.isNotBlank()) add(CoachOnboardingContext("assistant", answer))
            })
        } + records.map { record -> ContextTurn(record.requestId, record.createdAtMs, buildList {
            val question = record.request().text
            if (question.isNotBlank()) add(CoachOnboardingContext("user", question))
            record.response?.message?.takeIf { it.isNotBlank() }?.let { add(CoachOnboardingContext("assistant", it)) }
        }) }
        val window = mutableListOf<CoachOnboardingContext>()
        var bytes = 0
        for (turn in turns.sortedWith(compareBy({ it.at }, { it.id })).asReversed()) {
            val sizes = turn.messages.map { it.text.toByteArray(Charsets.UTF_8).size }
            if (sizes.any { it > CoachOnboardingLimits.textBytes } || window.size + turn.messages.size > CoachOnboardingLimits.contextTurns ||
                bytes + sizes.sum() > CoachOnboardingLimits.contextBytes) break
            window.addAll(0, turn.messages)
            bytes += sizes.sum()
        }
        return window
    }

    fun retry(owner: String, requestId: String): Deferred<CoachOnboardingOutcome> {
        try {
            val record = local.onboarding(owner, requestId)
                ?: return CompletableDeferred(CoachOnboardingOutcome.Refused("not_found", null))
            return start(record, Attempt.Retry)
        } catch (failure: Exception) {
            reportUnexpected(failure)
            return CompletableDeferred(CoachOnboardingOutcome.Failed(null))
        }
    }

    fun resume(): List<Deferred<CoachOnboardingOutcome>> = try {
        local.onboarding().filter { it.pending }.map { start(it, Attempt.Recover) }
    } catch (failure: Exception) {
        reportUnexpected(failure)
        listOf(CompletableDeferred(CoachOnboardingOutcome.Failed(null)))
    }

    fun records(owner: String, chat: String): List<CoachOnboardingRecord> =
        local.onboarding().filter { it.owner == owner && it.chat == chat }.sortedBy { it.createdAtMs }

    private fun start(record: CoachOnboardingRecord, attempt: Attempt, replaces: CoachOnboardingRecord? = null): Deferred<CoachOnboardingOutcome> = synchronized(jobs) {
        val key = record.owner to record.requestId
        jobs[key]?.let { return@synchronized it.job }
        val authority = local.admit(record.owner)
        val job = scope.async(start = CoroutineStart.LAZY) { execute(record, attempt, authority, replaces) }
        jobs[key] = Active(record, job)
        revision.update { it + 1 }
        job.invokeOnCompletion { synchronized(jobs) {
            if (jobs[key]?.job === job) { jobs.remove(key); revision.update { it + 1 } }
        } }
        job.start()
        job
    }

    private suspend fun execute(original: CoachOnboardingRecord, attempt: Attempt, authority: LocalCoach.Authority,
        replaces: CoachOnboardingRecord?): CoachOnboardingOutcome {
        val began = elapsedNanos()
        var record = original
        telemetry.event("gym_ask_started", mapOf("state" to "anonymous"))
        var outcome = "failed"
        var cap: String? = null
        try {
            replaces?.let { local.onboarding(it.owner, it.requestId) }?.takeIf { it.pending }
                ?.let { keep(it.copy(refusalCode = CoachOnboardingRecord.unanswered), authority) }
            val violation = withContext(storageDispatcher) { CoachOnboardingLimits.violation(record.request()) }
            if (violation != null) {
                record = record.copy(refusalCode = "input_limit")
                keep(record, authority)
                outcome = "refused"
                return CoachOnboardingOutcome.Limited(violation, record)
            }
            keep(record, authority)
            var response = if (attempt == Attempt.Send) {
                try { post(record, authority).also { record = local.onboarding(record.owner, record.requestId) ?: record } }
                catch (failure: WindmillApiException) {
                    if (failure !is WindmillApiException.Timeout && failure !is WindmillApiException.Transport &&
                        failure !is WindmillApiException.Offline) throw failure
                    record = local.onboarding(record.owner, record.requestId) ?: record
                    get(record, authority)
                }
            } else {
                try { get(record, authority) }
                catch (failure: WindmillApiException.Refused) {
                    if (failure.status != 404 || attempt != Attempt.Retry) throw failure
                    post(record, authority)
                }
            }
            while (true) {
                if (response.requestId != record.requestId || response.status !in setOf("pending", "completed", "failed", "expired") ||
                    record.response?.resultId?.let { it != response.resultId } == true) {
                    telemetry.failure("gym.coachOnboarding", WindmillApiException.Malformed)
                    throw WindmillApiException.Malformed
                }
                record = record.copy(response = response, refusalCode = null, refusalMessage = null)
                keep(record, authority)
                if (response.terminal) {
                    if (response.status == "completed") {
                        outcome = "answered"
                        return CoachOnboardingOutcome.Answered(record)
                    }
                    if (response.errorCode in setOf("device_bound", "installation_bound")) installation.markBound()
                    if (response.errorCode == "invalid_installation") installation.markInvalid()
                    cap = "allowance".takeIf { response.errorCode in allowanceCodes }
                    if (response.errorCode in failedCodes) return CoachOnboardingOutcome.Failed(record)
                    outcome = if (cap == null) "refused" else "capped"
                    return CoachOnboardingOutcome.Refused(response.errorCode ?: response.status, record)
                }
                delay(1_000)
                response = get(record, authority)
            }
        } catch (cancelled: CancellationException) {
            outcome = "cancelled"
            throw cancelled
        } catch (failure: WindmillApiException.Refused) {
            if (failure.status == 404 && failure.refusal.code == "not_found") {
                outcome = "failed"
                return try {
                    record = (local.onboarding(record.owner, record.requestId) ?: record).copy(refusalCode = CoachOnboardingRecord.unanswered)
                    keep(record, authority)
                    CoachOnboardingOutcome.Unanswered(record)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Exception) {
                    reportUnexpected(failure)
                    CoachOnboardingOutcome.Failed(record)
                }
            }
            val code = failure.refusal.code ?: "unavailable"
            try {
                if (code == "device_bound" || code == "installation_bound") installation.markBound()
                if (code == "invalid_installation") installation.markInvalid()
                record = (local.onboarding(record.owner, record.requestId) ?: record).copy(refusalCode = code,
                    refusalMessage = failure.refusal.message?.takeIf { code in allowanceCodes && it.isNotBlank() })
                keep(record, authority)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                reportUnexpected(failure)
                return CoachOnboardingOutcome.Failed(record)
            }
            val declaredUnavailable = failure.status == 503 && (code == "anonymous_ai_unavailable" || code in allowanceCodes)
            if (failure.status >= 500 && !declaredUnavailable) return CoachOnboardingOutcome.Failed(record)
            cap = "allowance".takeIf { code in allowanceCodes }
            outcome = if (cap == null) "refused" else "capped"
            return CoachOnboardingOutcome.Refused(code, record)
        } catch (_: WindmillApiException) {
            return CoachOnboardingOutcome.Failed(record)
        } catch (failure: Exception) {
            reportUnexpected(failure)
            return CoachOnboardingOutcome.Failed(record)
        } finally {
            telemetry.event("gym_ask_outcome", buildMap {
                put("state", "anonymous"); put("outcome", outcome)
                put("duration_ms", ((elapsedNanos() - began).coerceAtLeast(0) / 1_000_000).toString())
                cap?.let { put("cap", it) }
            })
        }
    }

    private suspend fun post(record: CoachOnboardingRecord, authority: LocalCoach.Authority): CoachOnboardingResponse {
        val origin = CoachOnboardingSeat(record.owner, record.replica)
        if (seat() != origin) throw WindmillApiException.Refused(409, works.windmill.platform.net.Refusal(code = "seat_changed"))
        if (!local.current(authority)) throw CancellationException("coach-owner-retired")
        val credential = installation.forAnonymousSend()
        if (seat() != origin) throw WindmillApiException.Refused(409, works.windmill.platform.net.Refusal(code = "seat_changed"))
        keep(record.copy(submitted = true, refusalCode = null, refusalMessage = null), authority)
        return api.start(record.body, credential)
    }

    private suspend fun get(record: CoachOnboardingRecord, authority: LocalCoach.Authority): CoachOnboardingResponse {
        if (!local.current(authority)) throw CancellationException("coach-owner-retired")
        val credential = installation.forRecovery()
        if (!local.current(authority)) throw CancellationException("coach-owner-retired")
        return api.get(record.requestId, credential)
    }

    private suspend fun keep(record: CoachOnboardingRecord, authority: LocalCoach.Authority) {
        try {
            if (!withContext(storageDispatcher) { local.withAuthority(authority) { local.keepOnboarding(record) } }) throw CancellationException("coach-request-deleted")
            revision.update { it + 1 }
        }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) {
            telemetry.failure("gym.coachOnboarding", IOException("The Coach request could not be saved."))
            throw OnboardingStorageFailure()
        }
    }

    private fun reportUnexpected(failure: Exception) {
        if (failure is OnboardingStorageFailure || failure is AiInstallationStorageFailure) return
        telemetry.failure("gym.coachOnboarding", IOException("The Coach request could not be recovered."))
    }

    companion object {
        private val allowanceCodes = setOf("subject_exhausted", "free_month_exhausted", "free_day_exhausted",
            "concurrency_exhausted", "funding_required", "debt_outstanding", "unconfigured")
        private val failedCodes = setOf("provider_failed", "invalid_result", "internal_error", "output_truncated",
            "interrupted", "unavailable")
    }
}
