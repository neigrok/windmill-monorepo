package works.windmill.gym.coach.turn

import works.windmill.agent.coach.AbilityReport
import works.windmill.agent.coach.EndState
import works.windmill.agent.coach.FailureOperation
import works.windmill.agent.coach.SeatKind
import works.windmill.agent.coach.Telemetry
import works.windmill.agent.coach.TurnReport
import works.windmill.domain.kit.Catalog
import works.windmill.gym.domain.coach.AbilityCall
import works.windmill.gym.domain.coach.AbilityRefusal
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.telemetry.coachAction
import works.windmill.platform.telemetry.Telemetry as PlatformTelemetry

// What a turn tells (gym Coach on the AI service §11), from the engine's telemetry port and from the host, in labels and counts: every value is a catalog name, a known code or a number, so no question, answer, input, result, pass or id can leave through here.
class GymTurnTelemetry(private val telemetry: PlatformTelemetry, private val catalog: Lazy<Catalog>) : Telemetry {
    override fun ability(report: AbilityReport) {
        telemetry.event("coach_ability", mapOf(
            "name" to if (catalog.value.ability(report.name) != null) report.name else other,
            "outcome" to if (report.outcome == "ok") "ok" else report.code?.takeIf { it in abilityOutcomes } ?: other,
        ))
    }

    override fun turn(report: TurnReport) {
        telemetry.event("coach_turn", buildMap {
            put("state", report.state.name)
            put("seat", report.seat.name)
            report.code?.let { put("code", if (it in codes) it else other) }
            put("rounds", report.rounds.toString())
            put("ability_calls", report.abilityCalls.toString())
            put("refusals", report.refusals.toString())
            put("answer_bytes", report.answerBytes.toString())
            put("duration_ms", report.durationMs.toString())
        })
    }

    // `ai-call`, `ai-pass` and `agent-host`, each a static operation with no message of anything said.
    override fun failure(operation: FailureOperation) {
        telemetry.failure(operation.label, CoachTurnFailure(operation.label))
    }

    // A failure of gym's own around the turn: its store, a record that refused its own write, or the Share door.
    fun failure(kind: TurnFault) {
        telemetry.failure("gym.coachTurn", CoachTurnFailure(kind.name), mapOf("failure_kind" to kind.name))
    }

    fun started() {
        telemetry.event("gym_ask_started", mapOf("screen" to "coach"))
    }

    // How a turn the engine ran settled: a refusal by what it means to the lifter, any other end by its state.
    fun settled(end: EndState, refusal: CoachTurnRefusal?, durationMs: Long) {
        if (refusal != null && refusal != CoachTurnRefusal.Unanswered) {
            val (outcome, cap) = refusal.askOutcome
            return asked(outcome, cap, durationMs)
        }
        asked(when (end) {
            EndState.completed -> "answered"
            EndState.stopped -> "cancelled"
            EndState.declined -> "refused"
            EndState.failed, EndState.interrupted -> "failed"
        }, null, durationMs)
    }

    // A send refused before any record.
    fun refused(refusal: CoachTurnRefusal) {
        val (outcome, cap) = refusal.askOutcome
        asked(outcome, cap, null)
    }

    // A send this phone held back for a fault of its own.
    fun heldBack(fault: CoachTurnFault) {
        asked(fault.askOutcome, null, null)
    }

    // A picture sweep that met a message this build cannot read: nothing was deleted, and the next sweep tries again.
    fun pictureSweepHeld() = telemetry.coachAction("picture_sweep", "message_unreadable")

    // A turn the process died under, ended at the next send or sweep with no engine run to end it: the record tells what it held.
    fun processEnded(seat: SeatKind, message: CoachMessage) {
        asked("failed", null, null)
        telemetry.event("coach_turn", buildMap {
            put("state", EndState.interrupted.name)
            put("seat", seat.name)
            put("code", processEndedCode)
            put("ability_calls", message.calls.size.toString())
            put("refusals", message.calls.count { it.outcome is AbilityCall.Outcome.Refused }.toString())
            put("answer_bytes", message.text.encodeToByteArray().size.toString())
        })
    }

    private fun asked(outcome: String, cap: String?, durationMs: Long?) {
        telemetry.event("gym_ask_outcome", buildMap {
            put("screen", "coach")
            put("outcome", outcome)
            cap?.let { put("cap", it) }
            durationMs?.let { put("duration_ms", it.toString()) }
        })
    }

    companion object {
        const val other = "other"
        const val processEndedCode = "process_ended"
        val abilityOutcomes = setOf("ok", other) + AbilityRefusal.entries.map { it.code } + listOf("one-proposal", "one-note", "stopped", "product-refused")
        // A turn's code: what the engine, the pass door or the AI service answered (Coach engine §7), or the seat changing under it.
        val codes = setOf("subject_exhausted", "free_day_exhausted", "free_month_exhausted", "concurrency_exhausted", "rate_limited", "busy", "paused",
            "unauthenticated", "invalid_installation", "device_bound", "client-update-required", "anonymous_ai_unavailable", "unavailable",
            "provider_unavailable", "provider_failed", "provider_rejected", "accounting_unavailable", "result_gone", "answer-timeout", "model-call-limit",
            "invalid_request", "invalid-answer", "untrusted-origin", "unsupported-media-type", "too_large", "funding_required", "conflict",
            "call_unknown", "picture_gone", "pass_expired", "pass_missing", "pass_signature", "pass_audience", "pass_malformed", "stopped", processEndedCode)
    }
}

// What failed in gym's own part of a turn, under one static operation.
enum class TurnFault { storage, refusal, share }

// The one static failure of a turn; its label is the message, and it carries nothing said.
private class CoachTurnFailure(label: String) : Exception(label)
