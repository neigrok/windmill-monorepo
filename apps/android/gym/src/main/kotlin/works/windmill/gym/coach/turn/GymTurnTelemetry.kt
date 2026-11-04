package works.windmill.gym.coach.turn

import works.windmill.agent.SeatKind
import works.windmill.agent.TurnFailure
import works.windmill.agent.TurnLabel
import works.windmill.agent.TurnState
import works.windmill.agent.TurnTally
import works.windmill.agent.TurnTelemetry
import works.windmill.domain.kit.Catalog
import works.windmill.gym.domain.coach.AbilityCall
import works.windmill.gym.domain.coach.AbilityRefusal
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.platform.telemetry.Telemetry

// What a turn tells (Coach §10.2), in labels and counts: every value is a catalog name, a known code or a number, so no question, answer, input, result or id can leave through here.
class GymTurnTelemetry(private val telemetry: Telemetry, private val catalog: Lazy<Catalog>) : TurnTelemetry {
    override fun ability(name: TurnLabel, outcome: TurnLabel) {
        telemetry.event("coach_ability", mapOf(
            "name" to if (catalog.value.ability(name.value) != null) name.value else other,
            "outcome" to if (outcome.value in abilityOutcomes) outcome.value else other,
        ))
    }

    override fun ended(state: TurnState, seat: SeatKind, code: TurnLabel?, tally: TurnTally, durationMs: Long) {
        val allowance = if (state == TurnState.failed) code?.let { CoachTurnRefusal.of(it.value).askOutcome.second == "allowance" } == true else false
        val outcome = if (allowance) "capped" else when (state) {
            TurnState.completed -> "answered"
            TurnState.stopped -> "cancelled"
            TurnState.declined -> "refused"
            TurnState.failed, TurnState.interrupted, TurnState.running -> "failed"
        }
        asked(outcome, if (allowance) "allowance" else null, durationMs)
        telemetry.event("coach_turn", buildMap {
            put("state", state.name)
            put("seat", seat.name)
            put("ability_calls", tally.calls.toString())
            put("refusals", tally.refusals.toString())
            put("answer_bytes", tally.answerBytes.toString())
            code?.let { put("code", it.value) }
            put("duration_ms", durationMs.toString())
        })
    }

    override fun withdrawn(status: Int, code: TurnLabel, durationMs: Long) {
        val refusal = CoachTurnRefusal.of(code.value, status)
        val (outcome, cap) = refusal.askOutcome
        val failed = if (refusal == CoachTurnRefusal.Offline) mapOf("failure_kind" to "offline") else mapOf("failure_kind" to "http", "status" to status.toString())
        telemetry.event("api_request_failed", mapOf("operation" to "gym_coach_turn", "route" to "/v1/gym", "method" to "POST") + failed)
        asked(if (outcome == "refused" && status >= 500) "failed" else outcome, cap, durationMs)
    }

    // A lost connection and a cancellation never come here: the driver keeps them from its port, and expected refusals are the events above.
    override fun failure(kind: TurnFailure, status: Int?) {
        telemetry.failure("gym.coachTurn", CoachTurnFailure(kind), buildMap {
            put("failure_kind", kind.name)
            status?.let { put("status", it.toString()) }
        })
    }

    fun started() {
        telemetry.event("gym_ask_started", mapOf("screen" to "coach"))
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

    // A turn that ended with no driver to say so: the seat changed under it, or the process died under it. The record tells what it held, when the record is still on this replica, and how it ended if a writer's commit outlived the cancellation.
    fun interrupted(seat: SeatKind, cause: InterruptedCause, message: CoachMessage?, durationMs: Long?) {
        asked("failed", null, durationMs)
        telemetry.event("coach_turn", buildMap {
            put("state", message?.state?.takeIf { it.isWritersTerminal }?.name ?: TurnState.interrupted.name)
            put("seat", seat.name)
            put("code", cause.name)
            message?.let { held ->
                put("ability_calls", held.calls.size.toString())
                put("refusals", held.calls.count { it.outcome is AbilityCall.Outcome.Refused }.toString())
                put("answer_bytes", held.text.encodeToByteArray().size.toString())
            }
            durationMs?.let { put("duration_ms", it.toString()) }
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
        val abilityOutcomes = setOf("ok", other) + AbilityRefusal.entries.map { it.code }
    }
}

// How a turn ended with no driver left to end it.
enum class InterruptedCause { seat_changed, process_ended }

// The one static failure of a turn; its kind is the label, and it carries no message of anything said.
private class CoachTurnFailure(kind: TurnFailure) : Exception(kind.name)
