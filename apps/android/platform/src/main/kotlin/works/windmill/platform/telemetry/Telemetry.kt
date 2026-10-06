package works.windmill.platform.telemetry

import androidx.compose.runtime.staticCompositionLocalOf
import kotlinx.coroutines.CancellationException
import works.windmill.platform.net.NetworkPhase
import works.windmill.platform.net.WindmillApiException

interface Telemetry {
    fun event(name: String, properties: Map<String, String> = emptyMap())
    fun failure(operation: String, error: Throwable, properties: Map<String, String> = emptyMap())
    fun identity(userId: String?) {}

    object None : Telemetry {
        override fun event(name: String, properties: Map<String, String>) {}
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {}
    }
}

val LocalTelemetry = staticCompositionLocalOf<Telemetry> { Telemetry.None }

object TelemetryPolicy {
    private val label = Regex("[a-zA-Z0-9_.:/-]{1,80}")
    private val eventLabel = Regex("[a-z0-9_]{1,64}")
    private val keys = setOf(
        "operation", "outcome", "failure_kind", "status", "cap", "action",
        "method", "route", "state", "release", "environment", "platform",
        "app_version", "build", "duration_ms", "network_phase", "screen",
    )
    private val commonEventKeys = setOf("platform", "app_version", "build", "release", "environment")
    private val onboardingStates = setOf("first_launch", "replay")
    private val onboardingScreens = setOf("windmill", "roadmap", "journal", "gym")
    private val onboardingEvents = mapOf(
        "onboarding_opened" to mapOf("state" to onboardingStates),
        "onboarding_page_viewed" to mapOf("state" to onboardingStates, "screen" to onboardingScreens),
        "onboarding_action" to mapOf(
            "state" to onboardingStates, "screen" to onboardingScreens,
            "action" to setOf("next", "back", "swipe", "adjust"),
        ),
        "onboarding_exited" to mapOf(
            "state" to onboardingStates, "screen" to onboardingScreens,
            "outcome" to setOf("skipped", "completed", "back", "closed"),
        ),
    )

    fun eventName(name: String): Boolean = eventLabel.matches(name) &&
        (!name.startsWith("onboarding_") || name in onboardingEvents)

    fun eventProperties(name: String, properties: Map<String, String>): Map<String, String> {
        if (!name.startsWith("onboarding_")) return properties(properties)
        val schema = onboardingEvents[name] ?: return emptyMap()
        return properties(properties.filter { (key, value) ->
            key in commonEventKeys || value in schema[key].orEmpty()
        })
    }

    fun properties(properties: Map<String, String>): Map<String, String> {
        var bytes = 2
        return properties.filter { (key, value) ->
            key in keys && label.matches(value) &&
                (key != "network_phase" || NetworkPhase.entries.any { it.value == value })
        }.entries
            .takeWhile { bytes += it.key.length + it.value.length + 6; bytes <= 900 }
            .associate { it.key to it.value }
    }

    fun operation(value: String): String = value.takeIf(label::matches) ?: "unknown"

    fun failureKind(error: Throwable): String = when (error) {
        is CancellationException -> "cancelled"
        is WindmillApiException.Offline -> "offline"
        is WindmillApiException.Timeout -> "timeout"
        is WindmillApiException.Transport -> "transport"
        is WindmillApiException.Unexpected -> "unexpected"
        is WindmillApiException.Malformed -> "malformed"
        is WindmillApiException.Refused -> "http"
        else -> error.javaClass.simpleName.takeIf(label::matches) ?: "exception"
    }

    fun report(error: Throwable): Boolean = when (error) {
        is CancellationException, is WindmillApiException.Offline -> false
        is WindmillApiException.Refused -> error.status !in setOf(400, 401, 403, 404, 409, 410, 422, 426, 429)
        else -> true
    }
}
