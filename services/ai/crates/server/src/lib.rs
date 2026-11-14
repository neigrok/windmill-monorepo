pub mod config;
pub mod guards;
pub mod listeners;
pub mod live;
pub mod pass;
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
    extract::{Path, Request, State},
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
    pub rates: Rates,
    pub refusals: Refusals,
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
        .fallback(|| async { refusal("call_unknown", None) })
        .layer(middleware::from_fn(no_store))
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
        .layer(middleware::from_fn(no_store))
        .with_state(service)
}

async fn no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store, no-transform"),
    );
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

pub async fn authenticate(service: &Service, headers: &HeaderMap) -> Result<Identity, Response> {
    let token = bearer(headers).map_err(|code| {
        service.refusals.count(code);
        refusal(code, None)
    })?;
    authenticate_token(service, token).await
}

pub async fn authenticate_token(
    service: &Service,
    token: Option<&str>,
) -> Result<Identity, Response> {
    let claims = service
        .config
        .verifier
        .verify(token, service.now())
        .map_err(|code| {
            service.refusals.count(code);
            refusal(code, None)
        })?;
    let identity = wire::identity(claims);
    let preparation = service
        .ledger
        .prepare(&identity, service.now())
        .await
        .map_err(|code| {
            telemetry::report_failure("ledger.prepare", code.as_str(), None);
            refusal(code.as_str(), None)
        })?;
    report_events(preparation.events);
    Ok(identity)
}

pub fn report_events(events: Vec<LedgerEvent>) {
    for event in events {
        match event {
            LedgerEvent::Threshold { percent, .. } => {
                tracing::warn!(operation = "budget.threshold", percent, "threshold");
                sentry::capture_message("budget.threshold", sentry::Level::Warning);
            }
            LedgerEvent::OwnerGrant { outcome } => {
                tracing::info!(operation = "grant.owner", outcome, "write");
                if outcome == "owner_grant_cap" {
                    telemetry::report_failure("grant.owner", "owner_grant_cap", None);
                }
            }
            LedgerEvent::InstallationBind { outcome } => {
                tracing::info!(operation = "installation.bind", outcome, "write");
                if outcome == "binding_contradiction" {
                    telemetry::report_failure("installation.bind", "binding_contradiction", None);
                }
            }
            LedgerEvent::SweepEnd { call_id, state } => {
                tracing::info!(
                    operation = "sweep.end",
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
        "result_gone" => StatusCode::GONE,
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
    (status, Json(json!({"code":code,"allowance":allowance}))).into_response()
}

pub async fn reject(
    service: &Service,
    identity: &Identity,
    code: StaticCode,
    operation: &'static str,
) -> Response {
    if matches!(code, StaticCode::Busy | StaticCode::RateLimited) {
        service.refusals.count(code.as_str());
    } else {
        tracing::info!(
            operation,
            code = code.as_str(),
            client = identity.client.as_str(),
            environment = service.config.environment.label(),
            "refused"
        );
    }
    if code == StaticCode::AccountingUnavailable {
        telemetry::report_failure(operation, code.as_str(), None);
        return refusal(code.as_str(), None);
    }
    let allowance = service
        .ledger
        .allowance(identity, service.now())
        .await
        .ok()
        .map(|value| wire::allowance(&value));
    refusal(code.as_str(), allowance)
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
    if service.ledger.lock_alive().await {
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
        Err(response) => return response,
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
    match service.ledger.allowance(&identity, service.now()).await {
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
        Err(response) => return response,
    };
    if !read_rate(&service, &identity) {
        return reject(&service, &identity, StaticCode::RateLimited, "call.read").await;
    }
    let caller = match CallerId::new(id) {
        Ok(value) => value,
        Err(code) => return reject(&service, &identity, code, "call.read").await,
    };
    match service.ledger.lookup(&identity.principal, &caller).await {
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
        Err(response) => return response,
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
    let _lifecycle = service.lifecycle.lock().await;
    match service.ledger.lookup(&identity.principal, &caller).await {
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
        Err(response) => return response,
    };
    let caller = match CallerId::new(id) {
        Ok(value) => value,
        Err(code) => return reject(&service, &identity, code, "call.text").await,
    };
    {
        let _lifecycle = service.lifecycle.lock().await;
        match service.ledger.lookup(&identity.principal, &caller).await {
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
    if !service.ledger.lock_alive().await {
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
    let allowance = match service.ledger.allowance(&identity, service.now()).await {
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
            return reject(
                &service,
                &identity,
                StaticCode::ProviderRejected,
                "call.text",
            )
            .await;
        }
    };
    match service.ledger.fuse(route.provider, service.now()).await {
        Ok(fuse) if !fuse.paused => {}
        Ok(_) => {
            sentry::capture_message("provider.fuse", sentry::Level::Warning);
            return reject(&service, &identity, StaticCode::Paused, "call.text").await;
        }
        Err(code) => return reject(&service, &identity, code, "call.text").await,
    }
    let admission = Admission {
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
    let lifecycle = service.lifecycle.lock().await;
    if service.drain.is_cancelled() {
        return reject(&service, &identity, StaticCode::Busy, "call.text").await;
    }
    let call = match service.ledger.admit(admission, service.now()).await {
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
    let task_entry = entry.clone();
    tokio::spawn(async move {
        text_task(
            service, identity, call, adapter, prepared, task_entry, active,
        )
        .await;
    });
    event_stream(entry, 0)
}

async fn text_task(
    service: Arc<Service>,
    identity: Identity,
    call: Call,
    adapter: Arc<Anthropic>,
    prepared: ai_providers::PreparedText,
    entry: Arc<ResultEntry>,
    active: ActiveCall,
) {
    let start = Instant::now();
    if service
        .ledger
        .dispatch(call.id, service.now())
        .await
        .is_err()
    {
        let settlement = Settlement {
            charge: Charge::Unconsumed,
            stop: None,
            code: Some(StaticCode::AccountingUnavailable),
            provider_request_id: None,
        };
        let charged = settle(service.clone(), call.id, settlement, active).await;
        service.results.push(&entry,"failed",json!({"code":"accounting_unavailable","charged":charged.map(NanoUsd::usd),"allowance":null}),true);
        telemetry::report_failure("ledger.dispatch", "accounting_unavailable", None);
        tracing::info!(
            operation = "call.text",
            id = call.id,
            label = call.label,
            client = call.client.as_str(),
            environment = service.config.environment.label(),
            tier = call.tier.as_str(),
            requested = call.requested.as_str(),
            served = call.route.served.as_str(),
            state = "unconsumed",
            code = "accounting_unavailable",
            duration_ms = start.elapsed().as_millis() as u64,
            reservation = call.reservation.nanos(),
            charged = charged.map(NanoUsd::nanos),
            "call ended"
        );
        return;
    }
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
    let charged = settle(
        service.clone(),
        call.id,
        Settlement {
            charge,
            stop,
            code,
            provider_request_id: outcome.request_id,
        },
        active,
    )
    .await;
    let allowance = service
        .ledger
        .allowance(&identity, service.now())
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
    tracing::info!(operation="call.text",id=call.id,label=call.label,client=call.client.as_str(),environment=service.config.environment.label(),tier=call.tier.as_str(),requested=call.requested.as_str(),served=call.route.served.as_str(),code=code.map(StaticCode::as_str),stop=stop.map(Stop::as_str),duration_ms=start.elapsed().as_millis() as u64,reservation=call.reservation.nanos(),charged=charged.map(NanoUsd::nanos),http_status=outcome.http_status,input=usage.map(|u|u.input),output=usage.map(|u|u.output),cache_write=usage.map(|u|u.cache_write),cache_write_1h=usage.map(|u|u.cache_write_1h),cache_read=usage.map(|u|u.cache_read),state=match charge{Charge::Usage(_)=>"settled",Charge::Unconsumed=>"unconsumed",_=>"assumed"},failure_kind=?outcome.failure.as_ref().map(|failure|failure.kind),"call ended");
}

pub async fn settle(
    service: Arc<Service>,
    id: i64,
    mut settlement: Settlement,
    active: ActiveCall,
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
                service.ledger.settle(id, settlement.clone(), service.now()),
            )
            .await
            {
                Ok(Ok(outcome)) => {
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
            if start.elapsed() >= SETTLE_RETRY {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(None);
                }
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
        serde_json::from_slice::<wire::FundIn>(&bytes).map_err(|_| StaticCode::InvalidRequest)
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
    grant_response("grant.fund", service.ledger.fund(fund, service.now()).await)
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
        serde_json::from_slice::<wire::CloseIn>(&bytes).map_err(|_| StaticCode::InvalidRequest)
    }) {
        Ok(value) => value,
        Err(code) => return refusal(code.as_str(), None),
    };
    grant_response(
        "grant.close",
        service.ledger.close(&reference, value.closed_at).await,
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
    grant_response("grant.reopen", service.ledger.reopen(&reference).await)
}
fn grant_response(operation: &'static str, result: Result<GrantOutcome, StaticCode>) -> Response {
    match result {
        Ok(outcome) => {
            tracing::info!(operation, outcome = outcome.as_str(), "write");
            if outcome == GrantOutcome::Conflict {
                sentry::capture_message(operation, sentry::Level::Warning);
            }
            Json(json!({"outcome":outcome.as_str()})).into_response()
        }
        Err(code) => {
            telemetry::report_failure(operation, code.as_str(), None);
            refusal(code.as_str(), None)
        }
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
    match service.ledger.principal(&principal, service.now()).await {
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
    match service.ledger.call(id).await {
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
    match service.ledger.calls(state, since, caller.as_ref()).await {
        Ok(value) => {
            Json(json!({"calls":value.iter().map(wire::call).collect::<Vec<_>>()})).into_response()
        }
        Err(code) => refusal(code.as_str(), None),
    }
}
async fn budgets(State(service): State<Arc<Service>>, request: Request) -> Response {
    if !internal_authorized(&service, request.headers(), false) {
        return refusal("pass_signature", None);
    }
    match service.ledger.shared(service.now()).await {
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
        serde_json::from_slice::<wire::CorrectIn>(&bytes).map_err(|_| StaticCode::InvalidRequest)
    }) {
        Ok(value) => value,
        Err(code) => return refusal(code.as_str(), None),
    };
    let cost = match NanoUsd::from_usd(&value.charged) {
        Ok(value) => value,
        Err(code) => return refusal(code.as_str(), None),
    };
    match service.ledger.correct(id, cost, service.now()).await {
        Ok(value) => {
            tracing::info!(operation = "call.correct", id, outcome = "ok", "write");
            Json(json!({"state":value.state.as_str(),"charged":value.charged.usd(),"replay":value.replay})).into_response()
        }
        Err(code) => {
            tracing::info!(
                operation = "call.correct",
                id,
                outcome = code.as_str(),
                "write"
            );
            if code == StaticCode::AccountingUnavailable {
                telemetry::report_failure("call.correct", code.as_str(), None);
            }
            refusal(code.as_str(), None)
        }
    }
}
