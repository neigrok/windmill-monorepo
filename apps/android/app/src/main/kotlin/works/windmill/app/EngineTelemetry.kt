package works.windmill.app

import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.engine.EngineOutcome
import works.windmill.sync.engine.EngineTelemetry

internal fun engineTelemetry(telemetry: Telemetry) = EngineTelemetry { event ->
    if (event.outcome == EngineOutcome.success) return@EngineTelemetry
    val labels = mapOf("operation" to event.operation.name, "outcome" to event.outcome.name) +
        (event.code?.let { mapOf("failure_kind" to it) } ?: emptyMap())
    telemetry.event("sync_engine", labels)
    if (event.outcome in setOf(EngineOutcome.failure, EngineOutcome.timeout))
        telemetry.failure("sync_${event.operation.name}", IllegalStateException("Sync boundary failed"), labels)
}
