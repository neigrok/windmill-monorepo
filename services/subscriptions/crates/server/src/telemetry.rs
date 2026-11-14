use std::io;

use sentry::integrations::backtrace::current_stacktrace;
use sentry::integrations::tracing::LogLayer;
use sentry::protocol::{Event, Exception, Mechanism};
use sentry::{ClientInitGuard, ClientOptions};
use tracing::Subscriber;
use tracing_subscriber::Layer;
use tracing_subscriber::filter::Targets;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::prelude::*;
use tracing_subscriber::registry::LookupSpan;

use crate::config::Config;

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
    let own_lines = Targets::new()
        .with_target("server", config.sentry_log_level)
        .with_target("subscriptions", config.sentry_log_level);
    tracing_subscriber::registry()
        .with(json_lines(io::stdout).with_filter(config.log_level))
        .with(LogLayer::new().with_filter(own_lines))
        .init();

    let mut options = ClientOptions::new();
    options.dsn = config.sentry_dsn.clone();
    options.environment = Some(config.environment.clone().into());
    options.release = config.release.clone().map(Into::into);
    let sentry = sentry::init(options);
    if !sentry.is_enabled() {
        tracing::warn!("sentry disabled: SENTRY_DSN is not set");
    }

    // The one source of Issues: location and stack, never the message, which may hold anything.
    std::panic::set_hook(Box::new(|panic| {
        let location = panic.location().map_or_else(
            || "unknown".to_owned(),
            |at| format!("{}:{}", at.file(), at.line()),
        );
        let event_id = sentry::capture_event(Event {
            level: sentry::Level::Error,
            exception: vec![Exception {
                ty: "panic".to_owned(),
                value: Some(format!("panicked at {location}")),
                stacktrace: current_stacktrace(),
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
        tracing::error!(location, sentry_event_id = %event_id.simple(), "panic");
    }));
    sentry
}
