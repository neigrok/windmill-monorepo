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
    // An account that cannot return: its queued events named in `carrying` send without credentials, the rest are dropped.
    fun retireAccount(userId: String, carrying: Set<String>) {}

    object None : Telemetry {
        override fun event(name: String, properties: Map<String, String>) {}
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {}
    }
}

val LocalTelemetry = staticCompositionLocalOf<Telemetry> { Telemetry.None }

// Which of an event's properties its schema allows beyond the common ones; the rest never leave the phone.
fun interface EventSchema {
    fun allowedKeys(properties: Map<String, String>): Set<String>
}

// Each key with the bounded values it may carry.
class LabelSchema(val values: Map<String, Set<String>>) : EventSchema {
    override fun allowedKeys(properties: Map<String, String>): Set<String> =
        properties.filter { (key, value) -> value in values[key].orEmpty() }.keys
}

// The events a module registers by name. A reserved prefix belongs to its module: no unregistered name may use it.
// An unregistered event keeps the general property allowlist.
class EventSchemas(val events: Map<String, EventSchema>, val reservedPrefixes: Set<String> = emptySet()) {
    operator fun plus(other: EventSchemas) = EventSchemas(events + other.events, reservedPrefixes + other.reservedPrefixes)

    fun accepts(name: String): Boolean = eventLabel.matches(name) &&
        (name in events || reservedPrefixes.none { name.startsWith(it) })

    fun properties(name: String, properties: Map<String, String>): Map<String, String> {
        val schema = events[name] ?: return TelemetryPolicy.properties(properties)
        val allowed = schema.allowedKeys(properties - commonKeys)
        return TelemetryPolicy.properties(properties.filterKeys { it in commonKeys || it in allowed })
    }

    companion object {
        private val eventLabel = Regex("[a-z0-9_]{1,64}")
        val commonKeys = setOf("platform", "app_version", "build", "release", "environment")

        val platform = EventSchemas(mapOf(
            "account_delete" to LabelSchema(mapOf(
                "state" to setOf("shown"),
                "action" to setOf("confirm", "check", "cleanup", "back", "done", "retry", "date_time"),
                "outcome" to setOf("started", "cancelled", "refused", "clock_refused", "not_deleted", "failed", "ok",
                    "cleanup_pending", "pending_confirmation"),
            )),
            "ai_installation_outcome" to LabelSchema(mapOf("action" to setOf("bind"), "outcome" to setOf("refused", "failed"))),
        ))
    }
}

object TelemetryPolicy {
    private val label = Regex("[a-zA-Z0-9_.:/-]{1,80}")
    private val keys = setOf(
        "operation", "outcome", "failure_kind", "status", "cap", "action",
        "method", "route", "state", "release", "environment", "platform",
        "app_version", "build", "duration_ms", "network_phase", "screen",
    )

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
