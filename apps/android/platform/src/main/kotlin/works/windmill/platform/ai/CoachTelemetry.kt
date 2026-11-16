package works.windmill.platform.ai

import works.windmill.agent.coach.AbilityReport
import works.windmill.agent.coach.FailureOperation
import works.windmill.agent.coach.Telemetry
import works.windmill.agent.coach.TurnReport

// Products translate bounded engine outcomes to their registered first-party events.
class CoachTelemetry(private val platform: works.windmill.platform.telemetry.Telemetry,
    private val turnEvent: (TurnReport) -> Unit, private val abilityEvent: (AbilityReport) -> Unit) : Telemetry {
    override fun turn(report: TurnReport) = turnEvent(report)
    override fun ability(report: AbilityReport) = abilityEvent(report)
    override fun failure(operation: FailureOperation) {
        platform.failure(operation.label, IllegalStateException(operation.label))
    }
}
