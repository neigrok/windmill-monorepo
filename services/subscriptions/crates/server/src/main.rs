use std::panic::AssertUnwindSafe;
use std::process::ExitCode;
use std::time::{Duration, SystemTime};
use std::{env, fs, io};

use app_store::verification::SignedDataVerifier;
use axum::Router;
use futures_util::FutureExt;
use server::config::Config;
use server::listeners::{Bounds, Listener};
use server::store_doors::{self, AppStoreDoor};
use server::telemetry;
use storage::{Ledger, StorageError};
use tokio::net::TcpListener;
use tokio::runtime::Runtime;
use tokio::signal::unix::{SignalKind, signal};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing_subscriber::prelude::*;

// Docker kills 10 s after SIGTERM: 6 s for open connections, the deliveries being applied and the ledger's
// connections, then at most 3 s for Sentry.
const DRAIN_BOUND: Duration = Duration::from_secs(6);

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
        app_store_test_root = config.app_store_test_root.is_some(),
        "starting"
    );

    // Apple's pinned root, and in a test deployment also the root the test signer signs under.
    let verifier = match &config.app_store_test_root {
        None => SignedDataVerifier::windmill(SystemTime::now),
        Some(path) => match fs::read(path)
            .map(|root| SignedDataVerifier::windmill_also_trusting(&root, SystemTime::now))
        {
            Ok(Ok(verifier)) => verifier,
            _ => {
                let variable = "SUBSCRIPTIONS_APP_STORE_TEST_ROOT";
                tracing::error!(variable, "{variable} names no certificate to trust");
                return ExitCode::FAILURE;
            }
        },
    };

    match Runtime::new() {
        Ok(runtime) => runtime.block_on(serve(config, verifier)),
        Err(error) => {
            tracing::error!(error = ?error.kind(), "runtime refused");
            ExitCode::FAILURE
        }
    }
}

async fn serve(config: Config, verifier: SignedDataVerifier) -> ExitCode {
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

    // The ledger is migrated before either listener binds, so no door ever answers over an older schema.
    let opened = async {
        let ledger = Ledger::open(&config.database_url).await?;
        let epoch = ledger.epoch().await?;
        Ok::<_, StorageError>((ledger, epoch))
    };
    let ledger = match opened.await {
        Ok((ledger, epoch)) => {
            tracing::info!(%epoch, "ledger open");
            ledger
        }
        Err(failure) => {
            telemetry::report_failure("ledger.open", failure.code(), failure.sqlstate());
            return ExitCode::FAILURE;
        }
    };

    let app_store = AppStoreDoor::new(ledger.clone(), verifier, SystemTime::now);
    let bounds = Bounds::default();
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
        let bound = socket.local_addr().unwrap_or(address);
        tracing::info!(listener = listener.label(), address = %bound, "listening");
        let doors = match listener {
            Listener::Public => store_doors::router(app_store.clone()),
            Listener::Internal => Router::new(),
        };
        let router = listener.router(&config, ledger.clone(), doors, bounds);
        let stop = stop.clone();
        running.spawn(async move {
            let served = AssertUnwindSafe(listener.serve(socket, router, bounds, stop))
                .catch_unwind()
                .await;
            (
                listener,
                if served.is_ok() {
                    "returned"
                } else {
                    "panicked"
                },
            )
        });
    }

    let signal = tokio::select! {
        _ = terminate.recv() => "SIGTERM",
        _ = interrupt.recv() => "SIGINT",
        Some(Ok((listener, why))) = running.join_next() => {
            tracing::error!(listener = listener.label(), why, "listener stopped by itself");
            return ExitCode::FAILURE;
        }
    };

    // Both listeners stop accepting at once; each then waits for the requests it is answering, the App Store door
    // for the deliveries it is applying, and the ledger's connections close once nothing holds one.
    tracing::info!(signal, "stopping");
    stop.cancel();
    let drained = async {
        running.join_all().await;
        app_store.drain().await;
        ledger.close().await;
    };
    match tokio::time::timeout(DRAIN_BOUND, drained).await {
        Ok(_) => tracing::info!("stopped"),
        Err(_) => tracing::warn!(
            drain_bound_s = DRAIN_BOUND.as_secs(),
            "stopped with requests still in flight"
        ),
    }
    ExitCode::SUCCESS
}
