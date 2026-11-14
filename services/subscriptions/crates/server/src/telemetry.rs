use std::io;
use std::sync::Arc;
use std::time::Duration;

use sentry::integrations::backtrace::current_stacktrace;
use sentry::integrations::tracing::LogLayer;
use sentry::protocol::{Event, Exception, Mechanism};
use sentry::transports::ReqwestHttpTransportOptions;
use sentry::{ClientInitGuard, ClientOptions, Transport, TransportFactory, TransportOptions};
use tracing::Subscriber;
use tracing_subscriber::Layer;
use tracing_subscriber::filter::Targets;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::prelude::*;
use tracing_subscriber::registry::LookupSpan;

use crate::config::Config;

// Every crate of the workspace and the binary: their frames are the service's own in a Sentry
// stack, and their lines are the ones sent to Sentry Logs.
pub const SERVICE_CRATES: [&str; 5] = ["app_store", "domain", "server", "storage", "subscriptions"];

// Docker kills 10 s after SIGTERM. Sentry's last flush waits 1 s, then the send it is in finishes
// within its 2 s, so shutdown spends at most 3 s on Sentry, whatever the ingest does.
const SENTRY_FLUSH: Duration = Duration::from_secs(1);
const SENTRY_SEND: Duration = Duration::from_secs(2);

// One JSON object per line: its fields on top and, inside a request, the request's span as `span`.
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

// Stdout takes lines from WINDMILL_LOG_LEVEL; Sentry Logs, the service's own from SENTRY_LOG_LEVEL.
pub fn start(config: &Config) -> ClientInitGuard {
    let own_lines =
        Targets::new().with_targets(SERVICE_CRATES.map(|name| (name, config.sentry_log_level)));
    tracing_subscriber::registry()
        .with(json_lines(io::stdout).with_filter(config.log_level))
        .with(LogLayer::new().with_filter(own_lines))
        .init();

    let mut options = ClientOptions::new();
    options.dsn = config.sentry_dsn.clone();
    options.environment = Some(config.environment.clone().into());
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

// Sentry's own transport, with a client that gives up on a send after SENTRY_SEND.
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

// An unexpected failure of a named operation (spec §10): one Issue per operation and code, and one
// line naming both. No message travels: a failure's text can quote what it was handed.
pub fn report_failure(operation: &'static str, code: &'static str, sqlstate: Option<&str>) {
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

// The other source of Issues: location and stack, never the message, which may hold anything.
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
