use std::process::ExitCode;
use std::time::Duration;
use std::{env, io};

use server::config::Config;
use server::listeners::Listener;
use server::telemetry;
use tokio::net::TcpListener;
use tokio::runtime::Runtime;
use tokio::signal::unix::{SignalKind, signal};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing_subscriber::prelude::*;

// Docker kills 10 s after SIGTERM: 7 s for requests in flight, up to 2 s for Sentry's last flush.
const DRAIN_BOUND: Duration = Duration::from_secs(7);

fn main() -> ExitCode {
    let config = match Config::from_environment(|variable| env::var(variable).ok()) {
        Ok(config) => config,
        Err(refusal) => {
            tracing_subscriber::registry()
                .with(telemetry::json_lines(io::stdout))
                .init();
            tracing::error!(variable = refusal.variable, "{refusal}");
            return ExitCode::FAILURE;
        }
    };

    // Sentry starts before the runtime, so the hub of every worker thread inherits its client.
    let _sentry = telemetry::start(&config);
    tracing::info!(
        environment = config.environment,
        release = config.release.as_deref(),
        panic_route_enabled = config.panic_route_enabled,
        "starting"
    );
    match Runtime::new() {
        Ok(runtime) => runtime.block_on(serve(config)),
        Err(error) => {
            tracing::error!(error = ?error.kind(), "runtime refused");
            ExitCode::FAILURE
        }
    }
}

async fn serve(config: Config) -> ExitCode {
    let (mut terminate, mut interrupt) = match (
        signal(SignalKind::terminate()),
        signal(SignalKind::interrupt()),
    ) {
        (Ok(terminate), Ok(interrupt)) => (terminate, interrupt),
        _ => {
            tracing::error!("signal handlers refused");
            return ExitCode::FAILURE;
        }
    };

    let stop = CancellationToken::new();
    let mut running = JoinSet::new();
    for listener in [Listener::Public, Listener::Internal] {
        let address = listener.address(&config);
        let socket = match TcpListener::bind(address).await {
            Ok(socket) => socket,
            Err(error) => {
                let kind = error.kind();
                tracing::error!(listener = listener.label(), %address, ?kind, "listener refused");
                return ExitCode::FAILURE;
            }
        };
        tracing::info!(listener = listener.label(), %address, "listening");
        let server = axum::serve(socket, listener.router(&config))
            .with_graceful_shutdown(stop.clone().cancelled_owned());
        running.spawn(server.into_future());
    }

    let signal = tokio::select! {
        _ = terminate.recv() => "SIGTERM",
        _ = interrupt.recv() => "SIGINT",
        _ = running.join_next() => {
            tracing::error!("a listener stopped by itself");
            return ExitCode::FAILURE;
        }
    };

    // Both listeners stop accepting at once; each then waits for the requests it is answering.
    tracing::info!(signal, "stopping");
    stop.cancel();
    match tokio::time::timeout(DRAIN_BOUND, running.join_all()).await {
        Ok(_) => tracing::info!("stopped"),
        Err(_) => tracing::warn!(
            drain_bound_s = DRAIN_BOUND.as_secs(),
            "stopped with requests still in flight"
        ),
    }
    ExitCode::SUCCESS
}
