use ai_domain::Provider;
use ai_providers::{Anthropic, CarryKey, LiveAuth, LiveClient, LiveConfig, Secret};
use ai_server::{
    Service,
    config::{CALLS_IN_FLIGHT_MAX, Config, DRAIN, LIVE_SESSIONS_MAX, SWEEP_EVERY},
    guards::{Rates, Refusals},
    internal_router, listeners, now,
    policy::Policy,
    public_router, report_events,
    results::Results,
    telemetry,
};
use ai_storage::Ledger;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{net::TcpListener, sync::Semaphore};
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() {
    if let Err(code) = run().await {
        eprintln!("windmill-ai: {code}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), &'static str> {
    let config = Arc::new(Config::from_environment(|key| std::env::var(key).ok())?);
    let _sentry = telemetry::start(&config);
    let tiers = std::fs::read_to_string("config/tiers.toml").map_err(|_| "tiers_unreadable")?;
    let prices = std::fs::read_to_string("config/prices.toml").map_err(|_| "prices_unreadable")?;
    let policy = Arc::new(Policy::parse(&tiers, &prices).map_err(|_| "policy_invalid")?);
    let ledger = ai_server::database(
        "ledger.connect",
        Ledger::connect(
            &config.database_url,
            policy.tiers.clone(),
            policy.prices.clone(),
        ),
    )
    .await
    .map_err(|_| "database_unavailable")?;
    if !ai_server::database("ledger.acquire_lock", ledger.acquire_lock())
        .await
        .map_err(|_| "lock_unavailable")?
    {
        return Err("already_running");
    }
    let sweep_start = Instant::now();
    report_events(
        ai_server::database("ledger.sweep", ledger.sweep(&[], now()))
            .await
            .map_err(|_| "sweep_unavailable")?
            .events,
        sweep_start.elapsed(),
    );
    let text = config
        .anthropic_key
        .clone()
        .map(|key| {
            Anthropic::new(
                &config.anthropic_url,
                Secret::new(key),
                CarryKey::new(config.carry_key),
            )
        })
        .transpose()
        .map_err(|_| "anthropic_configuration")?
        .map(Arc::new);
    let live = match policy.tiers.transcription.provider {
        Provider::OpenAi => config.openai_key.clone().map(|key| LiveConfig {
            url: config.openai_url.clone(),
            key: Secret::new(key),
            auth: LiveAuth::Bearer,
            model: policy.tiers.transcription.model.clone(),
            delay: policy.tiers.transcription.delay.clone(),
        }),
        Provider::Azure => match (
            &config.azure_key,
            &config.azure_url,
            &config.azure_deployment,
        ) {
            (Some(key), Some(url), Some(model)) => Some(LiveConfig {
                url: url.clone(),
                key: Secret::new(key.clone()),
                auth: LiveAuth::ApiKey,
                model: model.clone(),
                delay: policy.tiers.transcription.delay.clone(),
            }),
            _ => None,
        },
        Provider::Anthropic => return Err("transcription_provider"),
    }
    .map(LiveClient::new)
    .transpose()
    .map_err(|_| "live_configuration")?
    .map(Arc::new);
    let service = Arc::new(Service {
        config: config.clone(),
        ledger,
        policy,
        text,
        live,
        results: Results::default(),
        pictures: ai_server::pictures::Pictures::default(),
        rates: Rates::default(),
        refusals: Refusals::default(),
        provider_health: ai_server::telemetry::ProviderHealth::default(),
        calls: Arc::new(Semaphore::new(CALLS_IN_FLIGHT_MAX)),
        sessions: Arc::new(Semaphore::new(LIVE_SESSIONS_MAX)),
        active: Mutex::new(HashSet::new()),
        drain: CancellationToken::new(),
        lifecycle: tokio::sync::Mutex::new(()),
        clock: Arc::new(now),
    });
    let public = TcpListener::bind(config.public_address)
        .await
        .map_err(|_| {
            telemetry::report_failure("listener.public_bind", "bind_failed", None);
            "public_bind"
        })?;
    let internal = TcpListener::bind(config.internal_address)
        .await
        .map_err(|_| {
            telemetry::report_failure("listener.internal_bind", "bind_failed", None);
            "internal_bind"
        })?;
    let stop = CancellationToken::new();
    let public_task = tokio::spawn(listeners::serve(
        public,
        public_router(service.clone()),
        stop.clone(),
    ));
    let internal_task = tokio::spawn(listeners::serve(
        internal,
        internal_router(service.clone()),
        stop.clone(),
    ));
    let cleanup_service = service.clone();
    let cleanup_stop = stop.clone();
    let cleanup = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                _=cleanup_stop.cancelled()=>break,
                _=tick.tick()=>{
                    cleanup_service.results.prune();
                    cleanup_service.pictures.prune(Instant::now());
                    cleanup_service.refusals.flush();
                }
            }
        }
    });
    let maintenance_service = service.clone();
    let maintenance_stop = stop.clone();
    let maintenance = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        let mut sweep = Instant::now();
        loop {
            tokio::select! {
                _ = maintenance_stop.cancelled() => break,
                _ = tick.tick() => {
                    if sweep.elapsed() >= SWEEP_EVERY {
                        sweep = Instant::now();
                        let ready = ai_server::ledger_ready(&maintenance_service.ledger).await;
                        if !ready {
                            let _ = ai_server::database(
                                "ledger.acquire_lock",
                                maintenance_service.ledger.acquire_lock(),
                            ).await;
                        }
                        if ready || ai_server::ledger_ready(&maintenance_service.ledger).await {
                            let _lifecycle = match ai_server::lifecycle(&maintenance_service).await {
                                Ok(guard) => guard,
                                Err(_) => continue,
                            };
                            let active = maintenance_service.active.lock()
                                .unwrap_or_else(|error| error.into_inner())
                                .iter().copied().collect::<Vec<_>>();
                            let sweep_start = Instant::now();
                            if let Ok(outcome) = ai_server::database(
                                "ledger.sweep",
                                maintenance_service.ledger.sweep(&active, maintenance_service.now()),
                            ).await {
                                for event in &outcome.events {
                                    if let ai_domain::LedgerEvent::SweepEnd { call_id, .. } = event {
                                        maintenance_service.results.remove(&call_id.to_string());
                                    }
                                }
                                report_events(outcome.events, sweep_start.elapsed());
                            }
                        }
                    }
                    let events_start = Instant::now();
                    if let Ok(events) = ai_server::database(
                        "ledger.drain_events",
                        maintenance_service.ledger.drain_events(),
                    ).await {
                        report_events(events, events_start.elapsed());
                    }
                }
            }
        }
    });
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .map_err(|_| "signal_configuration")?;
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = term.recv() => {},
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c()
        .await
        .map_err(|_| "signal_configuration")?;
    let start = Instant::now();
    service.drain.cancel();
    while start.elapsed() < DRAIN && service.calls.available_permits() < CALLS_IN_FLIGHT_MAX {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    stop.cancel();
    let _ = public_task.await;
    let _ = internal_task.await;
    let _ = tokio::time::timeout(Duration::from_secs(5), maintenance).await;
    let _ = cleanup.await;
    Ok(())
}
