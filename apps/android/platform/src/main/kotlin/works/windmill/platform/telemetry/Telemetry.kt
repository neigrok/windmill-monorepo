package works.windmill.platform.telemetry

import androidx.compose.runtime.staticCompositionLocalOf
import java.io.EOFException
import java.io.InterruptedIOException
import java.net.ProtocolException
import java.net.SocketException
import java.net.UnknownHostException
import java.security.cert.CertificateException
import javax.net.ssl.SSLPeerUnverifiedException
import kotlinx.coroutines.CancellationException
import okhttp3.internal.http2.ConnectionShutdownException
import okhttp3.internal.http2.ErrorCode
import okhttp3.internal.http2.StreamResetException
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
    private val coachOnboardingEvents = mapOf(
        "gym_setup_step" to mapOf("screen" to setOf("coach"), "action" to setOf("shown", "screenshot", "build_manually", "photo_selected", "photo_removed", "sign_in")),
        "gym_coach_import" to mapOf("outcome" to setOf("started", "committed", "replayed", "refused", "failed")),
        "ai_installation_outcome" to mapOf("action" to setOf("bind"), "outcome" to setOf("refused", "failed")),
    )

    fun eventName(name: String): Boolean = eventLabel.matches(name) &&
        (!name.startsWith("onboarding_") || name in onboardingEvents)

    fun eventProperties(name: String, properties: Map<String, String>): Map<String, String> {
        coachOnboardingEvents[name]?.let { schema ->
            return properties(properties.filter { (key, value) -> key in commonEventKeys || value in schema[key].orEmpty() })
        }
        if (name == "gym_action") {
            val actions = when (properties["screen"]) {
                "routines", "notes" -> mapOf("delete" to setOf("ok", "refused", "failed"))
                "log" -> mapOf("discard" to setOf("ok", "cancelled", "refused", "failed"),
                    "open_workout" to setOf("ok"), "open_bodyweight" to setOf("ok"), "open_record" to setOf("ok"),
                    "share" to setOf("ok", "refused", "failed"))
                "finish" -> mapOf("discard" to setOf("ok", "cancelled", "refused", "failed"), "keep" to setOf("ok"), "done" to setOf("ok"))
                "session" -> mapOf("discard" to setOf("ok", "cancelled", "refused", "failed"), "delete" to setOf("ok", "refused", "failed"), "fix" to setOf("ok", "refused", "failed"))
                "note_editor" -> mapOf("delete" to setOf("ok", "refused", "failed"), "save" to setOf("ok", "refused", "failed"))
                "record" -> mapOf("edit" to setOf("ok", "refused", "failed"))
                "routine_editor" -> mapOf("save" to setOf("ok", "refused", "failed"))
                "movement_form" -> mapOf("open" to setOf("ok"), "stage" to setOf("ok", "refused"), "cancel" to setOf("ok"),
                    "create" to setOf("ok", "refused", "failed"), "add" to setOf("ok", "refused", "failed"))
                "bodyweight" -> mapOf("delete" to setOf("held", "closed", "refused", "failed"),
                    "undo" to setOf("ok", "closed", "failed"), "cancel" to setOf("rewritten"),
                    "calendar_open" to setOf("ok"), "calendar_confirm" to setOf("ok"), "calendar_cancel" to setOf("ok"))
                "coach" -> listOf("fresh_entry", "history_open", "draft_restored", "reply_open", "read_sources", "jump_latest")
                    .associateWith { setOf("ok") } + mapOf("copy" to setOf("ok", "failed"), "access" to setOf("available", "bound", "unavailable"))
                "threads" -> mapOf("delete" to setOf("ok", "refused", "failed", "cancelled"))
                "notification" -> mapOf("open" to setOf("ok", "refused"), "log_set" to setOf("ok", "refused"))
                "workout_bar" -> mapOf("open" to setOf("ok", "refused"))
                "workout" -> mapOf("hide" to setOf("ok", "refused"), "show_notification" to setOf("ok", "refused"),
                    "movement_switch" to setOf("ok"), "open_workout" to setOf("ok"), "remove" to setOf("ok", "refused"), "reorder" to setOf("ok"),
                    "picker_open" to setOf("ok"), "picker_cancel" to setOf("ok"), "picker_add" to setOf("ok", "refused"), "fix" to setOf("ok", "refused", "failed"))
                "tile" -> mapOf("open" to setOf("ok", "failed"), "routines" to setOf("ok", "failed"))
                else -> emptyMap()
            }
            val shown = (properties["screen"] == "threads" && properties["action"] == "delete" ||
                properties["screen"] in setOf("finish", "session", "log") && properties["action"] == "discard") &&
                properties["state"] == "shown" && properties["outcome"] == null

            val valid = properties["outcome"] in actions[properties["action"]].orEmpty()
            val allowed = if (shown) setOf("screen", "action", "state") else setOf("screen", "action", "outcome")
            return properties(properties.filterKeys { it in commonEventKeys || (valid || shown) && it in allowed })
        }
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

    fun report(error: Throwable, operation: String? = null): Boolean = when (error) {
        is CancellationException, is WindmillApiException.Offline -> false
        is WindmillApiException.Refused -> error.status !in setOf(400, 401, 403, 404, 409, 410, 422, 426, 429) &&
            !(error.status == 503 && operation in setOf("ai_installation", "gym.coachOnboarding") &&
                error.refusal.code in setOf("anonymous_ai_unavailable", "unconfigured", "subject_exhausted",
                    "free_month_exhausted", "free_day_exhausted", "concurrency_exhausted", "funding_required", "debt_outstanding"))
        else -> true
    }

    // Lost network, as the sync engine's `failureKind` decides `unreachable` (copied; both modules' tests run sync-engine's failure-kinds.tsv).
    fun networkLoss(error: Throwable): Boolean {
        if (error is WindmillApiException.Offline) return true
        val failure = if (error is WindmillApiException) error.cause ?: return false else error
        val causes = generateSequence(failure) { it.cause }.take(8).toList()
        if (causes.any { it is CertificateException || it is SSLPeerUnverifiedException }) return false
        return causes.any {
            it is UnknownHostException || it is SocketException || it is InterruptedIOException || it is EOFException ||
                it is ProtocolException && it.message == "unexpected end of stream" || it is ConnectionShutdownException ||
                it is StreamResetException && it.errorCode in setOf(ErrorCode.CANCEL, ErrorCode.REFUSED_STREAM)
        }
    }
}
