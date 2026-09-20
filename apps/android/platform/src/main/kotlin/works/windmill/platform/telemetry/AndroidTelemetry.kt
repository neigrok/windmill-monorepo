package works.windmill.platform.telemetry

import android.content.Context
import android.util.Log
import io.sentry.Sentry
import io.sentry.SentryEvent
import io.sentry.android.core.SentryAndroid
import kotlinx.coroutines.CoroutineScope
import okhttp3.HttpUrl
import works.windmill.platform.net.WindmillApi

class AndroidTelemetry(
    context: Context,
    baseUrl: HttpUrl,
    release: String,
    environment: String,
    version: String,
    build: String,
    userId: String?,
    private val credential: () -> String?,
    scope: CoroutineScope,
) : Telemetry {
    private val metadata = mapOf(
        "platform" to "android", "release" to release, "environment" to environment,
        "app_version" to version, "build" to build,
    )
    private val events: EventQueue

    init {
        val prefs = runCatching { context.getSharedPreferences("works.windmill.telemetry", Context.MODE_PRIVATE) }
            .onFailure { capture("telemetry_storage", it) }.getOrNull()
        events = EventQueue(
            userId, runCatching(credential).onFailure { capture("telemetry_credential", it) }.getOrNull(),
            read = { prefs?.getString("queue", null) },
            write = { prefs?.edit()?.putString("queue", it)?.commit() == true },
            send = { batch, bearer ->
                WindmillApi(baseUrl, { bearer }).send<EventBatchOut>("POST", "/v1/events", batch).accepted
            },
            failure = { operation, error -> capture(operation, error) },
            scope = scope,
        )
    }

    override fun identity(userId: String?) {
        runCatching { events.identity(userId, credential()) }.onFailure { capture("telemetry_identity", it) }
    }

    override fun event(name: String, properties: Map<String, String>) {
        runCatching { events.add(name, properties + metadata) }.onFailure { capture("telemetry_enqueue", it) }
    }

    override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
        if (!TelemetryPolicy.report(error)) return
        val safe = TelemetryPolicy.properties(properties) + mapOf(
            "operation" to TelemetryPolicy.operation(operation),
            "failure_kind" to TelemetryPolicy.failureKind(error),
        )
        event("client_error", safe)
        capture(operation, error, safe)
    }

    private fun capture(operation: String, error: Throwable, properties: Map<String, String> = emptyMap()) {
        SentryErrors.failure(operation, error, properties + metadata)
    }

    companion object {
        fun startSentry(context: Context, dsn: String, release: String, environment: String, build: String) {
            runCatching {
                SentryAndroid.init(context) { options ->
                    options.dsn = dsn
                    options.release = release
                    options.environment = environment
                    options.dist = build
                    options.setTag("platform", "android")
                    options.isSendDefaultPii = false
                    options.isAttachScreenshot = false
                    options.isAttachViewHierarchy = false
                    options.isAttachAnrThreadDump = false
                    options.isEnableUserInteractionBreadcrumbs = false
                    options.isEnableNdk = false
                    options.isEnableDeduplication = false
                    options.logs.isEnabled = false
                    options.tracesSampleRate = 0.0
                    options.profilesSampleRate = 0.0
                    options.setBeforeBreadcrumb { _, _ -> null }
                    options.setBeforeSend { event, _ -> scrub(event) }
                }
            }.onFailure { Log.e("WindmillTelemetry", "Crash reporting unavailable") }
        }

        internal fun scrub(event: SentryEvent): SentryEvent {
            event.message = null
            event.request = null
            event.breadcrumbs = null
            event.extras = null
            event.exceptions?.forEach { it.value = null }
            event.user = null
            return event
        }
    }
}

object SentryErrors : Telemetry {
    override fun event(name: String, properties: Map<String, String>) {}

    override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
        runCatching {
            val event = SentryEvent(error)
            for ((key, value) in TelemetryPolicy.properties(properties)) event.setTag(key, value)
            event.setTag("operation", TelemetryPolicy.operation(operation))
            event.setTag("failure_kind", TelemetryPolicy.failureKind(error))
            Sentry.captureEvent(event)
        }.onFailure { Log.e("WindmillTelemetry", "Error delivery unavailable") }
    }
}
