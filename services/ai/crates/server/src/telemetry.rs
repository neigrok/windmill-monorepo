use std::collections::HashMap;
use std::io;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use sentry::integrations::backtrace::current_stacktrace;
use sentry::integrations::tracing::LogLayer;
use sentry::protocol::{Event, Exception, Mechanism};
use sentry::transports::ReqwestHttpTransportOptions;
use sentry::{ClientInitGuard, ClientOptions, Transport, TransportFactory, TransportOptions};
use tracing::Subscriber;
use tracing_subscriber::Layer;
use tracing_subscriber::filter::{LevelFilter, Targets};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::prelude::*;
use tracing_subscriber::registry::LookupSpan;

use crate::config::Config;

pub const SERVICE_CRATES: [&str; 5] = [
    "ai_providers",
    "ai_domain",
    "ai_server",
    "ai_storage",
    "windmill_ai",
];

const SENTRY_FLUSH: Duration = Duration::from_secs(1);
const SENTRY_SEND: Duration = Duration::from_secs(2);

pub fn json_lines<S, W>(writer: W) -> impl Layer<S>
where
    S: Subscriber + for<'span> LookupSpan<'span>,
    W: for<'writer> MakeWriter<'writer> + Send + Sync + 'static,
{
    tracing_subscriber::fmt::layer()
        .json()
        .flatten_event(true)
        .with_current_span(true)
        .with_span_list(false)
        .with_target(false)
        .with_writer(writer)
}

pub fn start(config: &Config) -> ClientInitGuard {
    let quiet_sqlx = Targets::new()
        .with_default(LevelFilter::OFF)
        .with_targets(SERVICE_CRATES.map(|name| (name, LevelFilter::TRACE)));
    let own_lines =
        Targets::new().with_targets(SERVICE_CRATES.map(|name| (name, config.sentry_log_level)));
    tracing_subscriber::registry()
        .with(quiet_sqlx)
        .with(json_lines(io::stdout).with_filter(config.log_level))
        .with(LogLayer::new().with_filter(own_lines))
        .init();

    let mut options = ClientOptions::new();
    options.dsn = config.sentry_dsn.clone();
    options.environment = Some(config.environment.label().into());
    options.release = config.release.clone().map(Into::into);
    options.in_app_include = SERVICE_CRATES.to_vec();
    options.shutdown_timeout = SENTRY_FLUSH;
    options.transport = Some(Arc::new(BoundedSends));
    let sentry = sentry::init(options);
    if !sentry.is_enabled() {
        tracing::warn!("sentry disabled: SENTRY_DSN is not set");
    }
    report_panics();
    sentry
}

struct BoundedSends;

impl TransportFactory for BoundedSends {
    fn create_transport_with_options(&self, options: TransportOptions) -> Arc<dyn Transport> {
        let client = reqwest::Client::builder()
            .timeout(SENTRY_SEND)
            .build()
            .expect("the HTTP client for Sentry starts with the TLS the image carries");
        Arc::new(
            ReqwestHttpTransportOptions::from(options)
                .with_client(client)
                .build(),
        )
    }
}

struct BoundedReports {
    interval: Duration,
    last: Mutex<HashMap<&'static str, Instant>>,
}

impl BoundedReports {
    fn new(interval: Duration) -> Self {
        Self {
            interval,
            last: Mutex::new(HashMap::new()),
        }
    }

    fn admit(&self, operation: &'static str, now: Instant) -> bool {
        let mut last = self.last.lock().unwrap_or_else(|error| error.into_inner());
        if last
            .get(operation)
            .is_some_and(|previous| now.saturating_duration_since(*previous) < self.interval)
        {
            return false;
        }
        last.insert(operation, now);
        true
    }
}

pub fn report_failure(operation: &'static str, code: &'static str, sqlstate: Option<&str>) {
    static ACCOUNTING: LazyLock<BoundedReports> =
        LazyLock::new(|| BoundedReports::new(crate::config::DATABASE_REPORT_INTERVAL));
    if code == "accounting_unavailable" && !ACCOUNTING.admit(operation, Instant::now()) {
        tracing::error!(operation, code, "{operation} failed");
        return;
    }
    let event_id = sentry::with_scope(
        |scope| {
            scope.set_tag("operation", operation);
            scope.set_tag("code", code);
            if let Some(sqlstate) = sqlstate {
                scope.set_tag("sqlstate", sqlstate);
            }
            scope.set_fingerprint(Some(&[operation, code]));
        },
        || sentry::capture_message(operation, sentry::Level::Error),
    );
    let sentry_event_id = (!event_id.is_nil()).then(|| event_id.simple().to_string());
    tracing::error!(
        operation,
        code,
        sqlstate,
        sentry_event_id,
        "{operation} failed"
    );
}

pub fn report_background_hour() {
    static HOURLY: LazyLock<BoundedReports> =
        LazyLock::new(|| BoundedReports::new(crate::config::BACKGROUND_HOUR_REPORT_INTERVAL));
    if !HOURLY.admit("background.hour", Instant::now()) {
        return;
    }
    sentry::with_scope(
        |scope| scope.set_fingerprint(Some(&["background.hour"])),
        || sentry::capture_message("background.hour", sentry::Level::Warning),
    );
    tracing::warn!(
        operation = "background.hour",
        "background work reached its hourly ceiling"
    );
}

pub fn report_panics() {
    std::panic::set_hook(Box::new(|panic| {
        let location = panic.location().map_or_else(
            || "unknown".to_owned(),
            |at| format!("{}:{}", at.file(), at.line()),
        );
        // The newest frames are this hook's, under std::panicking; the panicking code is below.
        let stacktrace = current_stacktrace().map(|mut stack| {
            if let Some(hook) = stack.frames.iter().rposition(|frame| {
                frame
                    .function
                    .as_deref()
                    .is_some_and(|function| function.starts_with("std::panicking::"))
            }) {
                stack.frames.truncate(hook);
            }
            stack
        });
        let event_id = sentry::capture_event(Event {
            level: sentry::Level::Error,
            exception: vec![Exception {
                ty: "panic".to_owned(),
                value: Some(format!("panicked at {location}")),
                stacktrace,
                mechanism: Some(Mechanism {
                    ty: "panic".to_owned(),
                    handled: Some(false),
                    ..Default::default()
                }),
                ..Default::default()
            }]
            .into(),
            ..Default::default()
        });
        let sentry_event_id = (!event_id.is_nil()).then(|| event_id.simple().to_string());
        tracing::error!(location, sentry_event_id, "panic");
    }));
}

pub struct CallSignal {
    pub started: std::time::Instant,
    pub http_status: Option<u16>,
    pub failure_kind: Option<ai_providers::FailureKind>,
    pub refusal: Option<ai_providers::RefusalReason>,
    pub usage: Option<ai_domain::TokenUsage>,
}

impl CallSignal {
    pub fn new(started: std::time::Instant) -> Self {
        Self {
            started,
            http_status: None,
            failure_kind: None,
            refusal: None,
            usage: None,
        }
    }

    pub fn finish(
        self,
        call: &ai_domain::Call,
        settlement: &ai_domain::Settlement,
        outcome: &ai_domain::SettlementOutcome,
        environment: crate::pass::Environment,
    ) {
        use ai_domain::{Capability, Charge, StaticCode, Stop};
        let operation = match call.capability {
            Capability::Text => "call.text",
            Capability::Transcription => "call.transcription",
        };
        let (seconds, turns) = match settlement.charge {
            Charge::Audio { seconds, turns, .. } => (Some(seconds), Some(turns)),
            _ => (None, None),
        };
        tracing::info!(
            operation,
            product = "ai",
            door = "public",
            outcome = outcome.state.as_str(),
            id = call.id,
            label = call.label,
            client = call.client.as_str(),
            environment = environment.label(),
            tier = call.tier.as_str(),
            provider = call.route.provider.as_str(),
            requested = call.requested.as_str(),
            served = call.route.served.as_str(),
            code = settlement.code.map(StaticCode::as_str),
            stop = settlement.stop.map(Stop::as_str),
            state = outcome.state.as_str(),
            duration_ms = self.started.elapsed().as_millis() as u64,
            reservation = call.reservation.nanos(),
            charged = outcome.charged.nanos(),
            http_status = self.http_status,
            failure_kind = ?self.failure_kind,
            refusal = self.refusal.map(ai_providers::RefusalReason::as_str),
            provider_request_id = settlement.provider_request_id.as_deref(),
            input = self.usage.map(|usage| usage.input),
            output = self.usage.map(|usage| usage.output),
            cache_write = self.usage.map(|usage| usage.cache_write),
            cache_write_1h = self.usage.map(|usage| usage.cache_write_1h),
            cache_read = self.usage.map(|usage| usage.cache_read),
            seconds,
            turns,
            "call ended"
        );
    }
}

#[derive(Clone, Copy)]
struct BusyWindow {
    first: i64,
    last: i64,
    reported: bool,
}

#[derive(Default)]
pub struct ProviderHealth {
    busy: std::sync::Mutex<[Option<BusyWindow>; 3]>,
}

impl ProviderHealth {
    pub fn observe(&self, provider: ai_domain::Provider, status: Option<u16>, now: i64) -> bool {
        use crate::config::{PROVIDER_BUSY_AFTER, PROVIDER_BUSY_GAP};
        use ai_domain::Provider;
        let index = match provider {
            Provider::Anthropic => 0,
            Provider::OpenAi => 1,
            Provider::Azure => 2,
        };
        let label = match status {
            Some(429) => Some("rate_limited"),
            Some(503 | 529) => Some("overloaded"),
            _ => None,
        };
        let mut windows = self.busy.lock().unwrap_or_else(|error| error.into_inner());
        let Some(label) = label else {
            windows[index] = None;
            return false;
        };
        let window = windows[index].get_or_insert(BusyWindow {
            first: now,
            last: now,
            reported: false,
        });
        if now < window.last || now - window.last > PROVIDER_BUSY_GAP {
            *window = BusyWindow {
                first: now,
                last: now,
                reported: false,
            };
        }
        window.last = now;
        if window.reported || now - window.first < PROVIDER_BUSY_AFTER {
            return false;
        }
        window.reported = true;
        sentry::with_scope(
            |scope| {
                scope.set_tag("provider", provider.as_str());
                scope.set_tag("status", label);
                scope.set_fingerprint(Some(&["provider.busy", provider.as_str()]));
            },
            || sentry::capture_message("provider.busy", sentry::Level::Warning),
        );
        tracing::warn!(
            operation = "provider.busy",
            provider = provider.as_str(),
            status = label,
            duration_ms = now - window.first,
            "provider stayed busy"
        );
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accounting_outages_keep_reports_bounded_per_operation() {
        let reports = BoundedReports::new(crate::config::DATABASE_REPORT_INTERVAL);
        let now = Instant::now();
        assert!(reports.admit("ledger.lock", now));
        for elapsed in 1..60 {
            assert!(!reports.admit("ledger.lock", now + Duration::from_secs(elapsed)));
        }
        assert!(reports.admit("ledger.calls", now + Duration::from_secs(10)));
        assert!(reports.admit("ledger.lock", now + crate::config::DATABASE_REPORT_INTERVAL));
    }
}
