use std::panic::AssertUnwindSafe;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};
use std::{env, fs, io};

use app_store::server_api::{AppStoreApi, Hosts, ServerApi};
use app_store::verification::SignedDataVerifier;
use domain::Environment;
use futures_util::FutureExt;
use server::config::{AppStoreApiConfig, AppStoreApiKey, Config};
use server::internal;
use server::listeners::Listener;
use server::store_doors::{self, AppStoreDoor};
use server::sweep::{self, Sweep};
use server::telemetry;
use storage::{Ledger, StorageError};
use tokio::net::TcpListener;
use tokio::runtime::Runtime;
use tokio::signal::unix::{SignalKind, signal};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing_subscriber::filter::{LevelFilter, Targets};
use tracing_subscriber::prelude::*;

// Docker kills 10 s after SIGTERM: 6 s for open connections, the deliveries being applied and the ledger's
// connections, then at most 3 s for Sentry.
const DRAIN_BOUND: Duration = Duration::from_secs(6);

// How many times `subscriptions test-notification` checks Apple for the test notification's delivery status, spaced
// one second apart.
const TEST_NOTIFICATION_POLLS: usize = 10;
const TEST_NOTIFICATION_POLL_EVERY: Duration = Duration::from_secs(1);

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [] => run_server(),
        ["test-notification", environment] => {
            let environment = match *environment {
                "sandbox" => Environment::Sandbox,
                "production" => Environment::Production,
                _ => return usage_error(),
            };
            run_test_notification(environment)
        }
        _ => usage_error(),
    }
}

fn init_cli_logging() {
    let own_lines = Targets::new()
        .with_targets(telemetry::SERVICE_CRATES.map(|name| (name, LevelFilter::INFO)));
    tracing_subscriber::registry()
        .with(telemetry::json_lines(io::stdout).with_filter(own_lines))
        .init();
}

fn usage_error() -> ExitCode {
    init_cli_logging();
    tracing::error!("usage: subscriptions [test-notification <sandbox|production>]");
    ExitCode::FAILURE
}

fn hosts_for(test_url: Option<&reqwest::Url>) -> Hosts {
    match test_url {
        None => Hosts::apple(),
        Some(url) => Hosts {
            production: url.clone(),
            sandbox: url.clone(),
        },
    }
}

fn run_test_notification(environment: Environment) -> ExitCode {
    init_cli_logging();
    let config = match AppStoreApiConfig::from_environment(|variable| env::var(variable).ok()) {
        Ok(config) => config,
        Err(refusal) => {
            tracing::error!(variable = refusal.variable, "{refusal}");
            return ExitCode::FAILURE;
        }
    };
    let api = ServerApi::new(
        config.key,
        hosts_for(config.test_url.as_ref()),
        SystemTime::now,
    );
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            tracing::error!(error = ?error.kind(), "runtime refused");
            return ExitCode::FAILURE;
        }
    };
    let started = Instant::now();
    let outcome = runtime.block_on(store_doors::run_test_notification(
        &api,
        environment,
        TEST_NOTIFICATION_POLLS,
        TEST_NOTIFICATION_POLL_EVERY,
    ));
    outcome.log(environment, started.elapsed());
    if outcome.succeeded() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn run_server() -> ExitCode {
    let config = match Config::from_environment(|variable| env::var(variable).ok()) {
        Ok(config) => config,
        Err(refusal) => {
            init_cli_logging();
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
        app_store_api = config.app_store_api.key().is_some(),
        app_store_api_test_url = config.app_store_api_test_url.is_some(),
        internal_token_set = config.internal_token.is_some(),
        "starting"
    );
    if let AppStoreApiKey::Lacking(unset) = &config.app_store_api {
        for variable in unset {
            tracing::warn!(
                variable,
                "{variable} is not set, so the App Store Server API is off"
            );
        }
    }

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

    // Apple's hosts, or in a test deployment an Apple of the test's own answering for both environments.
    let api: Option<Arc<dyn AppStoreApi>> = config.app_store_api.key().map(|key| {
        let hosts = hosts_for(config.app_store_api_test_url.as_ref());
        Arc::new(ServerApi::new(key.clone(), hosts, SystemTime::now)) as Arc<dyn AppStoreApi>
    });
    let app_store = AppStoreDoor::new(ledger.clone(), verifier, api, SystemTime::now);
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
            Listener::Internal => internal::doors(
                config.internal_token.clone(),
                ledger.clone(),
                store_doors::internal_router(app_store.clone()),
            ),
        };
        let bounds = listener.bounds();
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

    // On start, so what the last run kept and left unsettled is applied first, then every minute.
    let sweep =
        tokio::spawn(Sweep::new(ledger.clone(), app_store.clone(), sweep::EVERY).run(stop.clone()));

    let signal = tokio::select! {
        _ = terminate.recv() => "SIGTERM",
        _ = interrupt.recv() => "SIGINT",
        Some(Ok((listener, why))) = running.join_next() => {
            tracing::error!(listener = listener.label(), why, "listener stopped by itself");
            return ExitCode::FAILURE;
        }
    };

    // Both listeners stop accepting at once and the sweep stops after the row it is applying; each listener then waits
    // for the requests it is answering, the App Store door for the deliveries it is applying, and the ledger's
    // connections close once nothing holds one.
    tracing::info!(signal, "stopping");
    stop.cancel();
    let drained = async {
        running.join_all().await;
        let _ = sweep.await;
        app_store.drain().await;
        ledger.close().await;
    };
    if tokio::time::timeout(DRAIN_BOUND, drained).await.is_ok() {
        tracing::info!("stopped");
        return ExitCode::SUCCESS;
    }
    // Whatever was kept and not applied is applied by the next start's sweep; a delivery not kept yet is sent again.
    let abandoned_deliveries = app_store.deliveries_under_way();
    let sentry_event_id = (abandoned_deliveries > 0)
        .then(|| {
            telemetry::report(
                sentry::Level::Error,
                "store.notification",
                "abandoned",
                None,
            )
        })
        .flatten();
    tracing::warn!(
        drain_bound_s = DRAIN_BOUND.as_secs(),
        abandoned_deliveries,
        sentry_event_id,
        "stopped with requests still in flight"
    );
    ExitCode::SUCCESS
}
