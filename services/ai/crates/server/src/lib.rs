pub mod config;
pub mod guards;
pub mod listeners;
pub mod live;
pub mod pass;
pub mod pictures;
pub mod policy;
pub mod results;
pub mod telemetry;
pub mod wire;

use ai_domain::*;
use ai_providers::{
    Anthropic, Certainty, FailureCode, LiveClient, TextClass, TextEvent, TextRequest,
};
use ai_storage::Ledger;
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{MatchedPath, Path, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post, put},
};
use config::*;
use futures_util::stream;
use guards::{Rates, Refusals};
use policy::Policy;
use results::{ResultEntry, Results};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    convert::Infallible,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot};
use tokio_util::sync::CancellationToken;

pub struct Service {
    pub config: Arc<Config>,
    pub ledger: Ledger,
    pub policy: Arc<Policy>,
    pub text: Option<Arc<Anthropic>>,
    pub live: Option<Arc<LiveClient>>,
    pub results: Results,
    pub pictures: pictures::Pictures,
    pub rates: Rates,
    pub refusals: Refusals,
    pub provider_health: telemetry::ProviderHealth,
    pub calls: Arc<Semaphore>,
    pub sessions: Arc<Semaphore>,
    pub active: Mutex<HashSet<i64>>,
    pub drain: CancellationToken,
    pub lifecycle: tokio::sync::Mutex<()>,
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl Service {
    pub fn now(&self) -> i64 {
        (self.clock)()
    }
}

pub struct ActiveCall {
    service: Arc<Service>,
    id: i64,
    _permit: OwnedSemaphorePermit,
}
impl ActiveCall {
    pub fn new(service: Arc<Service>, id: i64, permit: OwnedSemaphorePermit) -> Self {
        service
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id);
        Self {
            service,
            id,
            _permit: permit,
        }
    }
}
impl Drop for ActiveCall {
    fn drop(&mut self) {
        self.service
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
    }
}

pub async fn database<T>(
    operation: &'static str,
    request: impl std::future::Future<Output = Result<T, StaticCode>>,
) -> Result<T, StaticCode> {
    let result = tokio::time::timeout(DATABASE_DEADLINE, request)
        .await
        .unwrap_or(Err(StaticCode::AccountingUnavailable));
    if matches!(result, Err(StaticCode::AccountingUnavailable)) {
        telemetry::report_failure(operation, "accounting_unavailable", None);
    }
    result
}

pub async fn dispatch(service: &Service, id: i64) -> Result<(), StaticCode> {
    if service.drain.is_cancelled() {
        return Err(StaticCode::Busy);
    }
    database(
        "ledger.dispatch",
        service.ledger.dispatch(id, service.now()),
    )
    .await
}

pub async fn lifecycle(service: &Service) -> Result<tokio::sync::MutexGuard<'_, ()>, StaticCode> {
    tokio::time::timeout(DATABASE_DEADLINE, service.lifecycle.lock())
        .await
        .map_err(|_| {
            telemetry::report_failure("ledger.lifecycle", "accounting_unavailable", None);
            StaticCode::AccountingUnavailable
        })
}

pub async fn ledger_ready(ledger: &Ledger) -> bool {
    let ready = tokio::time::timeout(DATABASE_DEADLINE, ledger.lock_alive())
        .await
        .unwrap_or(false);
    if !ready {
        telemetry::report_failure("ledger.lock", "accounting_unavailable", None);
    }
    ready
}

pub fn now() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(i64::MAX)
}
pub fn principal_key(principal: &Principal) -> String {
    format!("{}:{}", principal.kind(), principal.id())
}

pub fn public_router(service: Arc<Service>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/calls/{callId}/text", put(text))
        .route("/v1/calls/{callId}/transcription", get(live::upgrade))
        .route("/v1/calls/{callId}/result", get(result))
        .route("/v1/calls/{callId}", get(status))
        .route("/v1/allowance", get(allowance))
        .route("/v1/pictures/{pictureId}", put(pictures::upload))
        .fallback(|| async { refusal("call_unknown", None) })
        .layer(middleware::from_fn_with_state(service.clone(), no_store))
        .with_state(service)
}

pub fn internal_router(service: Arc<Service>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/internal/v1/grants/{reference}", put(fund))
        .route("/internal/v1/grants/{reference}/close", post(close))
        .route("/internal/v1/grants/{reference}/reopen", post(reopen))
        .route("/internal/v1/principals/{kind}/{id}", get(principal))
        .route("/internal/v1/calls", get(calls))
        .route("/internal/v1/calls/{id}", get(internal_call))
        .route("/internal/v1/calls/{id}/correct", post(correct))
        .route("/internal/v1/budgets", get(budgets))
        .layer(middleware::from_fn_with_state(service.clone(), no_store))
        .with_state(service)
}

#[derive(Clone)]
struct RefusalCode(&'static str);
#[derive(Clone)]
struct RefusalLine {
    operation: &'static str,
    code: &'static str,
    client: &'static str,
    tier: Option<&'static str>,
}
#[derive(Clone)]
struct WriteOutcome(&'static str);

async fn no_store(State(service): State<Arc<Service>>, request: Request, next: Next) -> Response {
    let start = Instant::now();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map_or("unmatched", MatchedPath::as_str)
        .to_owned();
    let label = service
        .policy
        .tiers
        .label(&query(&request, "label").unwrap_or_default());
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store, no-transform"),
    );
    let duration_ms = start.elapsed().as_millis() as u64;
    let operation = match route.as_str() {
        "/internal/v1/grants/{reference}" => Some("grant.fund"),
        "/internal/v1/grants/{reference}/close" => Some("grant.close"),
        "/internal/v1/grants/{reference}/reopen" => Some("grant.reopen"),
        "/internal/v1/calls/{id}/correct" => Some("call.correct"),
        _ => None,
    };
    if route == "/v1/pictures/{pictureId}" {
        let outcome = response
            .extensions()
            .get::<RefusalCode>()
            .map_or("ok", |code| code.0);
        tracing::info!(
            operation = "picture.upload",
            product = "ai",
            door = "public",
            outcome,
            duration_ms,
            "write"
        );
    } else if let Some(operation) = operation {
        let outcome = response
            .extensions()
            .get::<WriteOutcome>()
            .map(|value| value.0)
            .or_else(|| {
                response
                    .extensions()
                    .get::<RefusalCode>()
                    .map(|value| value.0)
            })
            .unwrap_or("invalid_request");
        tracing::info!(
            operation,
            product = "ai",
            door = "internal",
            outcome,
            duration_ms,
            "write"
        );
    } else if let Some(line) = response.extensions().get::<RefusalLine>() {
        tracing::info!(
            operation = line.operation,
            product = "ai",
            door = "public",
            code = line.code,
            client = line.client,
            tier = line.tier,
            label,
            environment = service.config.environment.label(),
            duration_ms,
            "refused"
        );
    } else if response.status().is_success()
        && matches!(
            route.as_str(),
            "/v1/allowance"
                | "/v1/calls/{callId}"
                | "/v1/calls/{callId}/result"
                | "/internal/v1/principals/{kind}/{id}"
                | "/internal/v1/calls"
                | "/internal/v1/calls/{id}"
                | "/internal/v1/budgets"
        )
    {
        tracing::info!(
            operation = "request.read",
            route,
            duration_ms,
            status = response.status().as_u16(),
            "read"
        );
    } else if route == "/health" && response.status().is_success() {
        tracing::debug!(operation = "health.read", duration_ms, "ready");
    }
    response
}

pub fn bearer(headers: &HeaderMap) -> Result<Option<&str>, &'static str> {
    let values: Vec<_> = headers.get_all(header::AUTHORIZATION).iter().collect();
    if values.len() > 1 {
        return Err("pass_malformed");
    }
    match values.first() {
        None => Ok(None),
        Some(value) => value
            .to_str()
            .ok()
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|value| !value.is_empty())
            .map(Some)
            .ok_or("pass_signature"),
    }
}

pub async fn authenticate(
    service: &Service,
    headers: &HeaderMap,
) -> Result<Identity, &'static str> {
    let token = bearer(headers).inspect_err(|code| {
        service.refusals.count(code);
    })?;
    authenticate_token(service, token).await
}

pub async fn authenticate_token(
    service: &Service,
    token: Option<&str>,
) -> Result<Identity, &'static str> {
    let started = Instant::now();
    let claims = service
        .config
        .verifier
        .verify(token, service.now())
        .inspect_err(|code| {
            service.refusals.count(code);
        })?;
    let identity = wire::identity(claims);
    let preparation = crate::database(
        "ledger.prepare",
        service.ledger.prepare(&identity, service.now()),
    )
    .await
    .map_err(|code| {
        tracing::info!(
            operation = "request.authenticate",
            code = code.as_str(),
            client = identity.client.as_str(),
            environment = service.config.environment.label(),
            duration_ms = started.elapsed().as_millis() as u64,
            "refused"
        );
        code.as_str()
    })?;
    report_events(preparation.events, started.elapsed());
    Ok(identity)
}

pub fn report_events(events: Vec<LedgerEvent>, duration: Duration) {
    let duration_ms = duration.as_millis() as u64;
    for event in events {
        match event {
            LedgerEvent::Threshold { budget_id, percent } => {
                tracing::warn!(
                    operation = "budget.threshold",
                    budget_id,
                    percent,
                    "threshold"
                );
                sentry::with_scope(
                    |scope| {
                        scope.set_tag("budget_id", budget_id.to_string());
                        scope.set_tag("percent", percent.to_string());
                    },
                    || sentry::capture_message("budget.threshold", sentry::Level::Warning),
                );
            }
            LedgerEvent::OwnerGrant { outcome } => {
                tracing::info!(
                    operation = "grant.owner",
                    product = "ai",
                    door = "public",
                    outcome,
                    duration_ms,
                    "write"
                );
                if outcome == "owner_grant_cap" {
                    telemetry::report_failure("grant.owner", "owner_grant_cap", None);
                }
            }
            LedgerEvent::InstallationBind { outcome } => {
                tracing::info!(
                    operation = "installation.bind",
                    product = "ai",
                    door = "public",
                    outcome,
                    duration_ms,
                    "write"
                );
                if outcome == "binding_contradiction" {
                    telemetry::report_failure("installation.bind", "binding_contradiction", None);
                }
            }
            LedgerEvent::SweepEnd { call_id, state } => {
                tracing::info!(
                    operation = "sweep.end",
                    product = "ai",
                    door = "background",
                    duration_ms,
                    id = call_id,
                    outcome = state.as_str(),
                    "write"
                );
                if state == CallState::Assumed {
                    telemetry::report_failure("sweep.end", "assumed", None);
                }
            }
        }
    }
}

pub fn refusal(code: &'static str, allowance: Option<Value>) -> Response {
    let status = match code {
        "pass_missing" | "pass_signature" | "pass_audience" | "pass_malformed" | "pass_expired" => {
            StatusCode::UNAUTHORIZED
        }
        "funding_required" | "device_bound" => StatusCode::FORBIDDEN,
        "call_unknown" | "not_found" => StatusCode::NOT_FOUND,
        "conflict" => StatusCode::CONFLICT,
        "result_gone" | "picture_gone" => StatusCode::GONE,
        "too_large" => StatusCode::PAYLOAD_TOO_LARGE,
        "subject_exhausted"
        | "free_month_exhausted"
        | "free_day_exhausted"
        | "concurrency_exhausted"
        | "rate_limited" => StatusCode::TOO_MANY_REQUESTS,
        "busy" | "paused" | "accounting_unavailable" | "provider_unavailable" => {
            StatusCode::SERVICE_UNAVAILABLE
        }
        _ => StatusCode::BAD_REQUEST,
    };
    let mut response = (status, Json(json!({"code":code,"allowance":allowance}))).into_response();
    response.extensions_mut().insert(RefusalCode(code));
    response
}

pub async fn reject(
    service: &Service,
    identity: &Identity,
    code: StaticCode,
    operation: &'static str,
) -> Response {
    let counted = matches!(code, StaticCode::Busy | StaticCode::RateLimited);
    if counted {
        service.refusals.count(code.as_str());
    }
    let allowance = if code == StaticCode::AccountingUnavailable {
        None
    } else {
        crate::database(
            "ledger.allowance",
            service.ledger.allowance(identity, service.now()),
        )
        .await
        .ok()
    };
    let mut response = refusal(code.as_str(), allowance.as_ref().map(wire::allowance));
    if !counted {
        response.extensions_mut().insert(RefusalLine {
            operation,
            code: code.as_str(),
            client: identity.client.as_str(),
            tier: allowance.map(|value| value.tier.as_str()),
        });
    }
    response
}

pub fn read_rate(service: &Service, identity: &Identity) -> bool {
    service
        .rates
        .allow(principal_key(&identity.principal), false, READS_PER_MINUTE)
}

pub async fn body(request: Request, limit: usize) -> Result<axum::body::Bytes, StaticCode> {
    match tokio::time::timeout(BODY_DEADLINE, to_bytes(request.into_body(), limit)).await {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(_)) => Err(StaticCode::TooLarge),
        Err(_) => Err(StaticCode::InvalidRequest),
    }
}

fn query(request: &Request, name: &str) -> Option<String> {
    url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

async fn health(State(service): State<Arc<Service>>) -> Response {
    if crate::ledger_ready(&service.ledger).await {
        Json(json!({"status":"ready"})).into_response()
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status":"unavailable"})),
        )
            .into_response()
    }
}

async fn allowance(State(service): State<Arc<Service>>, request: Request) -> Response {
    let identity = match authenticate(&service, request.headers()).await {
        Ok(value) => value,
        Err(code) => return refusal(code, None),
    };
    if !read_rate(&service, &identity) {
        return reject(
            &service,
            &identity,
            StaticCode::RateLimited,
            "allowance.read",
        )
        .await;
    }
    match crate::database(
        "ledger.allowance",
        service.ledger.allowance(&identity, service.now()),
    )
    .await
    {
        Ok(value) => Json(wire::allowance(&value)).into_response(),
        Err(code) => reject(&service, &identity, code, "allowance.read").await,
    }
}

async fn status(
    State(service): State<Arc<Service>>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let identity = match authenticate(&service, request.headers()).await {
        Ok(value) => value,
        Err(code) => return refusal(code, None),
    };
    if !read_rate(&service, &identity) {
        return reject(&service, &identity, StaticCode::RateLimited, "call.read").await;
    }
    let caller = match CallerId::new(id) {
        Ok(value) => value,
        Err(code) => return reject(&service, &identity, code, "call.read").await,
    };
    match crate::database(
        "ledger.lookup",
        service.ledger.lookup(&identity.principal, &caller),
    )
    .await
    {
        Ok(Some(call)) => Json(wire::status(&call)).into_response(),
        Ok(None) => reject(&service, &identity, StaticCode::CallUnknown, "call.read").await,
        Err(code) => reject(&service, &identity, code, "call.read").await,
    }
}

async fn result(
    State(service): State<Arc<Service>>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let identity = match authenticate(&service, request.headers()).await {
        Ok(value) => value,
        Err(code) => return refusal(code, None),
    };
    if !read_rate(&service, &identity) {
        return reject(&service, &identity, StaticCode::RateLimited, "call.result").await;
    }
    let caller = match CallerId::new(id) {
        Ok(value) => value,
        Err(code) => return reject(&service, &identity, code, "call.result").await,
    };
    let after = match query(&request, "after")
        .map(|v| v.parse::<u64>())
        .transpose()
    {
        Ok(value) => value.unwrap_or(0),
        Err(_) => {
            return reject(
                &service,
                &identity,
                StaticCode::InvalidRequest,
                "call.result",
            )
            .await;
        }
    };
    let _lifecycle = match lifecycle(&service).await {
        Ok(guard) => guard,
        Err(code) => return reject(&service, &identity, code, "call.read").await,
    };
    match crate::database(
        "ledger.lookup",
        service.ledger.lookup(&identity.principal, &caller),
    )
    .await
    {
        Ok(Some(call)) => existing_result(&service, &identity, &call, after).await,
        Ok(None) => reject(&service, &identity, StaticCode::CallUnknown, "call.result").await,
        Err(code) => reject(&service, &identity, code, "call.result").await,
    }
}

pub async fn existing_result(
    service: &Service,
    identity: &Identity,
    call: &Call,
    after: u64,
) -> Response {
    if call.capability == Capability::Transcription && call.state.is_open() {
        return reject(service, identity, StaticCode::Conflict, "call.result").await;
    }
    let Some(entry) = service.results.get(&call.id.to_string()) else {
        return reject(service, identity, StaticCode::ResultGone, "call.result").await;
    };
    if entry.transcription {
        return match entry.last() {
            Some(data) => ([(header::CONTENT_TYPE, "application/json")], data).into_response(),
            None => reject(service, identity, StaticCode::ResultGone, "call.result").await,
        };
    }
    event_stream(entry, after)
}

pub fn event_stream(entry: Arc<ResultEntry>, after: u64) -> Response {
    let reader = entry.attach();
    let events = stream::unfold(
        (entry, after, reader),
        |(entry, mut after, reader)| async move {
            loop {
                let notified = entry.changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let (event, done) = entry.next(after, reader);
                if let Some(event) = event {
                    after = event.id;
                    return Some((
                        Ok::<_, Infallible>(
                            Event::default()
                                .id(event.id.to_string())
                                .event(event.name)
                                .data(event.data),
                        ),
                        (entry.clone(), after, reader),
                    ));
                }
                if done {
                    return None;
                }
                notified.await;
            }
        },
    );
    Sse::new(events)
        .keep_alive(KeepAlive::new().interval(HEARTBEAT).text("heartbeat"))
        .into_response()
}

async fn text(
    State(service): State<Arc<Service>>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let identity = match authenticate(&service, request.headers()).await {
        Ok(value) => value,
        Err(code) => return refusal(code, None),
    };
    let caller = match CallerId::new(id) {
        Ok(value) => value,
        Err(code) => return reject(&service, &identity, code, "call.text").await,
    };
    {
        let _lifecycle = match lifecycle(&service).await {
            Ok(guard) => guard,
            Err(code) => return reject(&service, &identity, code, "call.read").await,
        };
        match crate::database(
            "ledger.lookup",
            service.ledger.lookup(&identity.principal, &caller),
        )
        .await
        {
            Ok(Some(call)) => {
                if !read_rate(&service, &identity) {
                    return reject(&service, &identity, StaticCode::RateLimited, "call.text").await;
                }
                if call.capability != Capability::Text {
                    return reject(&service, &identity, StaticCode::Conflict, "call.text").await;
                }
                return existing_result(&service, &identity, &call, 0).await;
            }
            Ok(None) => {}
            Err(code) => return reject(&service, &identity, code, "call.text").await,
        }
    }
    if service.drain.is_cancelled() {
        return reject(&service, &identity, StaticCode::Busy, "call.text").await;
    }
    if !crate::ledger_ready(&service.ledger).await {
        return reject(
            &service,
            &identity,
            StaticCode::AccountingUnavailable,
            "call.text",
        )
        .await;
    }
    let permit = match service.calls.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return reject(&service, &identity, StaticCode::Busy, "call.text").await,
    };
    let allowance = match crate::database(
        "ledger.allowance",
        service.ledger.allowance(&identity, service.now()),
    )
    .await
    {
        Ok(value) => value,
        Err(code) => return reject(&service, &identity, code, "call.text").await,
    };
    let row = match service.policy.tiers.row(allowance.tier) {
        Ok(row) => row,
        Err(code) => return reject(&service, &identity, code, "call.text").await,
    };
    if !service.rates.allow(
        principal_key(&identity.principal),
        true,
        row.calls_per_minute as usize,
    ) {
        return reject(&service, &identity, StaticCode::RateLimited, "call.text").await;
    }
    if allowance.code != StaticCode::Ok {
        return reject(&service, &identity, allowance.code, "call.text").await;
    }
    let label = service
        .policy
        .tiers
        .label(&query(&request, "label").unwrap_or_default());
    let bytes = match body(request, MAX_TEXT_BODY).await {
        Ok(bytes) => bytes,
        Err(code) => return reject(&service, &identity, code, "call.text").await,
    };
    let mut request = match TextRequest::parse(&bytes) {
        Ok(request) => request,
        Err(_) => {
            return reject(&service, &identity, StaticCode::InvalidRequest, "call.text").await;
        }
    };
    drop(bytes);
    if let Err(code) = service.pictures.resolve(
        &principal_key(&identity.principal),
        &mut request,
        Instant::now(),
    ) {
        return reject(&service, &identity, code, "call.text").await;
    }
    request.output.max_tokens = request.output.max_tokens.min(row.output_ceiling);
    let requested = match request.model {
        TextClass::Large => ModelClass::Large,
        TextClass::Medium => ModelClass::Medium,
        TextClass::Small => ModelClass::Small,
    };
    let route = match service.policy.tiers.route(allowance.tier, requested) {
        Ok(route) => route,
        Err(code) => return reject(&service, &identity, code, "call.text").await,
    };
    let Some(adapter) = service.text.clone() else {
        return reject(
            &service,
            &identity,
            StaticCode::ProviderUnavailable,
            "call.text",
        )
        .await;
    };
    let Some(profile) = service
        .policy
        .profiles
        .iter()
        .find(|profile| profile.model == route.model)
    else {
        return reject(&service, &identity, StaticCode::InvalidRequest, "call.text").await;
    };
    let prepared = match adapter.prepare(request, profile) {
        Ok(value) => value,
        Err(_) => {
            return reject(&service, &identity, StaticCode::InvalidRequest, "call.text").await;
        }
    };
    let count = match adapter.count(&prepared).await {
        Ok(count) => count,
        Err(failure) => {
            if failure.key_account_fault {
                telemetry::report_failure("provider.count", "provider_credentials", None);
            }
            let code = match failure.code {
                FailureCode::ProviderRejected => StaticCode::ProviderRejected,
                FailureCode::ProviderUnavailable => StaticCode::ProviderUnavailable,
                FailureCode::ProviderFailed => StaticCode::ProviderFailed,
            };
            return reject(&service, &identity, code, "call.text").await;
        }
    };
    match crate::database(
        "ledger.fuse",
        service.ledger.fuse(route.provider, service.now()),
    )
    .await
    {
        Ok(fuse) if !fuse.paused => {}
        Ok(_) => {
            sentry::capture_message("provider.fuse", sentry::Level::Warning);
            return reject(&service, &identity, StaticCode::Paused, "call.text").await;
        }
        Err(code) => return reject(&service, &identity, code, "call.text").await,
    }
    let admission = Admission {
        expected_route: route.clone(),
        identity: identity.clone(),
        caller_id: caller,
        label,
        requested,
        reservation: Reservation::Text(TextBudget {
            input_tokens: count.input_tokens,
            max_tokens: prepared.max_tokens(),
            min_tokens: Some(prepared.min_tokens()),
            cache: prepared.cache(),
        }),
    };
    let lifecycle = match lifecycle(&service).await {
        Ok(guard) => guard,
        Err(code) => return reject(&service, &identity, code, "call.text").await,
    };
    if service.drain.is_cancelled() {
        return reject(&service, &identity, StaticCode::Busy, "call.text").await;
    }
    let call = match crate::database(
        "ledger.admit",
        service.ledger.admit(admission, service.now()),
    )
    .await
    {
        Ok(AdmissionOutcome::Admitted(call)) => call,
        Ok(AdmissionOutcome::Existing(call)) => {
            return existing_result(&service, &identity, &call, 0).await;
        }
        Err(code) => return reject(&service, &identity, code, "call.text").await,
    };
    let entry = service
        .results
        .create(call.id.to_string(), principal_key(&call.principal), false);
    let active = ActiveCall::new(service.clone(), call.id, permit);
    drop(lifecycle);
    let (ready, answer) = oneshot::channel();
    let task = TextCall {
        producer: entry.producer(),
        identity: identity.clone(),
        call,
        prepared,
        entry: entry.clone(),
        active,
    };
    let task_service = service.clone();
    tokio::spawn(async move {
        text_task(task_service, adapter, task, ready).await;
    });
    match answer.await {
        Ok(Ok(())) => event_stream(entry, 0),
        Ok(Err(code)) => reject(&service, &identity, code, "call.text").await,
        Err(_) => {
            reject(
                &service,
                &identity,
                StaticCode::AccountingUnavailable,
                "call.text",
            )
            .await
        }
    }
}

struct TextCall {
    producer: results::ResultProducer,
    identity: Identity,
    call: Call,
    prepared: ai_providers::PreparedText,
    entry: Arc<ResultEntry>,
    active: ActiveCall,
}

async fn text_task(
    service: Arc<Service>,
    adapter: Arc<Anthropic>,
    task: TextCall,
    ready: oneshot::Sender<Result<(), StaticCode>>,
) {
    let TextCall {
        producer: _producer,
        identity,
        call,
        prepared,
        entry,
        active,
    } = task;
    let start = Instant::now();
    if let Err(code) = dispatch(&service, call.id).await {
        let settlement = Settlement {
            charge: Charge::Unconsumed,
            stop: None,
            code: Some(code),
            provider_request_id: None,
        };
        let charged = settle(
            service.clone(),
            call.clone(),
            settlement,
            active,
            telemetry::CallSignal::new(start),
        )
        .await;
        service.results.push(
            &entry,
            "failed",
            json!({"code":code.as_str(),"charged":charged.map(NanoUsd::usd),"allowance":null}),
            true,
        );
        let _ = ready.send(Err(code));
        return;
    }
    let _ = ready.send(Ok(()));
    service.results.push(&entry,"started",json!({"callId":call.caller_id.as_str(),"served":call.route.served.as_str(),"maxTokens":call.max_tokens}),false);
    let outcome = adapter
        .run(
            prepared,
            call.max_tokens.unwrap_or(1),
            |event| match event {
                TextEvent::Text { delta } => {
                    service
                        .results
                        .push(&entry, "text", json!({"delta":delta}), false)
                }
                TextEvent::ToolCall { id, name, input } => service.results.push(
                    &entry,
                    "toolCall",
                    json!({"id":id,"name":name,"input":input}),
                    false,
                ),
            },
        )
        .await;
    service
        .provider_health
        .observe(call.route.provider, outcome.http_status, service.now());
    let usage = outcome.usage.map(|usage| TokenUsage {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cache_write: usage.cache_creation_5m_input_tokens,
        cache_write_1h: usage.cache_creation_1h_input_tokens,
        cache_read: usage.cache_read_input_tokens,
    });
    let code = outcome.failure.as_ref().map(|failure| match failure.code {
        FailureCode::ProviderRejected => StaticCode::ProviderRejected,
        FailureCode::ProviderUnavailable => StaticCode::ProviderUnavailable,
        FailureCode::ProviderFailed => StaticCode::ProviderFailed,
    });
    if outcome
        .failure
        .as_ref()
        .is_some_and(|failure| failure.key_account_fault)
    {
        telemetry::report_failure("provider.text", "provider_credentials", None);
    }
    let charge = if let Some(usage) = usage {
        Charge::Usage(usage)
    } else if outcome
        .failure
        .as_ref()
        .is_some_and(|failure| failure.certainty == Certainty::Unconsumed)
    {
        Charge::Unconsumed
    } else {
        Charge::Assumed
    };
    let stop = outcome.stop.map(|stop| match stop {
        ai_providers::Stop::Completed => Stop::Completed,
        ai_providers::Stop::ToolCalls => Stop::ToolCalls,
        ai_providers::Stop::Truncated => Stop::Truncated,
        ai_providers::Stop::Declined => Stop::Declined,
    });
    let signal = telemetry::CallSignal {
        started: start,
        http_status: outcome.http_status,
        failure_kind: outcome.failure.as_ref().map(|failure| failure.kind),
        usage,
    };
    let charged = settle(
        service.clone(),
        call.clone(),
        Settlement {
            charge,
            stop,
            code,
            provider_request_id: outcome.request_id,
        },
        active,
        signal,
    )
    .await;
    let allowance = crate::database(
        "ledger.allowance",
        service.ledger.allowance(&identity, service.now()),
    )
    .await
    .ok()
    .map(|value| wire::allowance(&value));
    if let Some(code) = code {
        service.results.push(
            &entry,
            "failed",
            json!({"code":code.as_str(),"charged":charged.map(NanoUsd::usd),"allowance":allowance}),
            true,
        );
    } else {
        service.results.push(&entry,"ended",json!({"stop":stop.map(Stop::as_str),"message":outcome.message,"charged":charged.map(NanoUsd::usd),"allowance":allowance}),true);
    }
}

pub async fn settle(
    service: Arc<Service>,
    call: Call,
    mut settlement: Settlement,
    active: ActiveCall,
    signal: telemetry::CallSignal,
) -> Option<NanoUsd> {
    let (sender, receiver) = oneshot::channel();
    tokio::spawn(async move {
        let _active = active;
        let mut sender = Some(sender);
        let start = Instant::now();
        let mut reported = false;
        loop {
            match tokio::time::timeout(
                Duration::from_secs(5),
                service
                    .ledger
                    .settle(call.id, settlement.clone(), service.now()),
            )
            .await
            {
                Ok(Ok(outcome)) => {
                    signal.finish(&call, &settlement, &outcome, service.config.environment);
                    if outcome.excess > NanoUsd::ZERO {
                        telemetry::report_failure("ledger.settle", "reservation_excess", None);
                    }
                    if outcome.state == CallState::Assumed {
                        telemetry::report_failure("ledger.settle", "assumed", None);
                    }
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(Some(outcome.charged));
                    }
                    break;
                }
                Ok(Err(StaticCode::InvalidRequest))
                    if matches!(settlement.charge, Charge::Usage(_)) =>
                {
                    settlement.charge = Charge::Assumed;
                }
                _ => {
                    if !reported {
                        telemetry::report_failure("ledger.settle", "accounting_unavailable", None);
                        reported = true;
                    }
                }
            }
            if start.elapsed() >= SETTLE_RETRY
                && let Some(sender) = sender.take()
            {
                let _ = sender.send(None);
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
    receiver.await.unwrap_or(None)
}

fn internal_authorized(service: &Service, headers: &HeaderMap, funding: bool) -> bool {
    let Ok(Some(token)) = bearer(headers) else {
        return false;
    };
    let expected = if funding {
        &service.config.funding_secret
    } else {
        &service.config.operator_secret
    };
    token.as_bytes().ct_eq(expected.as_bytes()).into()
}

async fn fund(
    State(service): State<Arc<Service>>,
    Path(reference): Path<String>,
    request: Request,
) -> Response {
    if !internal_authorized(&service, request.headers(), true) {
        return refusal("pass_signature", None);
    }
    let value = match body(request, 65536).await.and_then(|bytes| {
        serde_json::from_slice::<wire::FundRequest>(&bytes).map_err(|_| StaticCode::InvalidRequest)
    }) {
        Ok(value) => value,
        Err(code) => return refusal(code.as_str(), None),
    };
    let fund = match Plan::parse(&value.plan).and_then(|plan| {
        Ok(Fund {
            reference,
            account_id: value.account_id,
            plan,
            period: Period::new(value.period.start, value.period.end)?,
        })
    }) {
        Ok(value) => value,
        Err(code) => return refusal(code.as_str(), None),
    };
    grant_response(
        "grant.fund",
        crate::database("ledger.fund", service.ledger.fund(fund, service.now())).await,
    )
}
async fn close(
    State(service): State<Arc<Service>>,
    Path(reference): Path<String>,
    request: Request,
) -> Response {
    if !internal_authorized(&service, request.headers(), true) {
        return refusal("pass_signature", None);
    }
    let value = match body(request, 65536).await.and_then(|bytes| {
        serde_json::from_slice::<wire::CloseRequest>(&bytes).map_err(|_| StaticCode::InvalidRequest)
    }) {
        Ok(value) => value,
        Err(code) => return refusal(code.as_str(), None),
    };
    grant_response(
        "grant.close",
        crate::database(
            "ledger.close",
            service.ledger.close(&reference, value.closed_at),
        )
        .await,
    )
}
async fn reopen(
    State(service): State<Arc<Service>>,
    Path(reference): Path<String>,
    request: Request,
) -> Response {
    if !internal_authorized(&service, request.headers(), true) {
        return refusal("pass_signature", None);
    }
    grant_response(
        "grant.reopen",
        crate::database("ledger.reopen", service.ledger.reopen(&reference)).await,
    )
}
fn grant_response(operation: &'static str, result: Result<GrantOutcome, StaticCode>) -> Response {
    match result {
        Ok(outcome) => {
            if outcome == GrantOutcome::Conflict {
                sentry::capture_message(operation, sentry::Level::Warning);
            }
            let mut response = Json(json!({"outcome":outcome.as_str()})).into_response();
            response
                .extensions_mut()
                .insert(WriteOutcome(outcome.as_str()));
            response
        }
        Err(code) => refusal(code.as_str(), None),
    }
}
async fn principal(
    State(service): State<Arc<Service>>,
    Path((kind, id)): Path<(String, String)>,
    request: Request,
) -> Response {
    if !internal_authorized(&service, request.headers(), false) {
        return refusal("pass_signature", None);
    }
    let principal = match Principal::new(&kind, id) {
        Ok(value) => value,
        Err(code) => return refusal(code.as_str(), None),
    };
    let before = match query(&request, "before")
        .map(|value| value.parse::<i64>())
        .transpose()
    {
        Ok(value) if value.is_none_or(|id| id > 0) => value,
        _ => return refusal("invalid_request", None),
    };
    match crate::database(
        "ledger.principal",
        service.ledger.principal(&principal, service.now(), before),
    )
    .await
    {
        Ok(value) => Json(wire::principal(value)).into_response(),
        Err(code) => refusal(code.as_str(), None),
    }
}
async fn internal_call(
    State(service): State<Arc<Service>>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    if !internal_authorized(&service, request.headers(), false) {
        return refusal("pass_signature", None);
    }
    let id = match id.parse() {
        Ok(value) => value,
        Err(_) => return refusal("invalid_request", None),
    };
    match crate::database("ledger.call", service.ledger.call(id)).await {
        Ok(Some(value)) => Json(wire::call(&value)).into_response(),
        Ok(None) => refusal("call_unknown", None),
        Err(code) => refusal(code.as_str(), None),
    }
}
async fn calls(State(service): State<Arc<Service>>, request: Request) -> Response {
    if !internal_authorized(&service, request.headers(), false) {
        return refusal("pass_signature", None);
    }
    let state = match query(&request, "state")
        .map(|value| CallState::parse(&value))
        .transpose()
    {
        Ok(value) => value,
        Err(code) => return refusal(code.as_str(), None),
    };
    let since = match query(&request, "since")
        .map(|value| value.parse::<i64>())
        .transpose()
    {
        Ok(value) => value,
        Err(_) => return refusal("invalid_request", None),
    };
    let caller = match query(&request, "callId").map(CallerId::new).transpose() {
        Ok(value) => value,
        Err(code) => return refusal(code.as_str(), None),
    };
    let before = match query(&request, "before")
        .map(|value| value.parse::<i64>())
        .transpose()
    {
        Ok(value) if value.is_none_or(|id| id > 0) => value,
        _ => return refusal("invalid_request", None),
    };
    match crate::database(
        "ledger.calls",
        service.ledger.calls(state, since, caller.as_ref(), before),
    )
    .await
    {
        Ok(mut value) => {
            let more = value.len() > 1000;
            value.truncate(1000);
            let next_before_id = if more {
                value.last().map(|call| call.id)
            } else {
                None
            };
            Json(json!({"calls":value.iter().map(wire::call).collect::<Vec<_>>(),"nextBeforeId":next_before_id})).into_response()
        }
        Err(code) => refusal(code.as_str(), None),
    }
}
async fn budgets(State(service): State<Arc<Service>>, request: Request) -> Response {
    if !internal_authorized(&service, request.headers(), false) {
        return refusal("pass_signature", None);
    }
    match crate::database("ledger.shared", service.ledger.shared(service.now())).await {
        Ok(value) => Json(wire::shared(value)).into_response(),
        Err(code) => refusal(code.as_str(), None),
    }
}
async fn correct(
    State(service): State<Arc<Service>>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    if !internal_authorized(&service, request.headers(), false) {
        return refusal("pass_signature", None);
    }
    let id = match id.parse() {
        Ok(value) => value,
        Err(_) => return refusal("invalid_request", None),
    };
    let value = match body(request, 65536).await.and_then(|bytes| {
        serde_json::from_slice::<wire::CorrectRequest>(&bytes)
            .map_err(|_| StaticCode::InvalidRequest)
    }) {
        Ok(value) => value,
        Err(code) => return refusal(code.as_str(), None),
    };
    let cost = match NanoUsd::from_usd(&value.charged) {
        Ok(value) => value,
        Err(code) => return refusal(code.as_str(), None),
    };
    match crate::database(
        "ledger.correct",
        service.ledger.correct(id, cost, service.now()),
    )
    .await
    {
        Ok(value) => {
            let mut response=Json(json!({"state":value.state.as_str(),"charged":value.charged.usd(),"replay":value.replay})).into_response();
            response.extensions_mut().insert(WriteOutcome("ok"));
            response
        }
        Err(code) => refusal(code.as_str(), None),
    }
}
