use ai_domain::*;
use ai_providers::{Anthropic, CarryKey, LiveAuth, LiveClient, LiveConfig, Secret};
use ai_server::{
    Service,
    config::Config,
    guards::{Rates, Refusals},
    policy::Policy,
    public_router,
    results::Results,
};
use ai_storage::Ledger;
use axum::{Json, Router, body::Body, http::header, response::IntoResponse, routing::post};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    io::{self, Write},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Semaphore;
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
use tokio_util::sync::CancellationToken;
use tracing_subscriber::prelude::*;

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Captured {
    type Writer = Self;
    fn make_writer(&'a self) -> Self {
        self.clone()
    }
}

impl Captured {
    fn calls(&self, operation: &str) -> Vec<Value> {
        String::from_utf8(self.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|line| line["operation"] == operation)
            .map(|mut line| {
                let fields = line.as_object_mut().unwrap();
                fields.remove("timestamp");
                assert!(fields.remove("duration_ms").unwrap().is_u64());
                line
            })
            .collect()
    }
}

const NOW: i64 = 1_800_000_000_000;
struct Database {
    url: String,
    name: String,
    admin: sqlx::PgPool,
}
impl Database {
    async fn new() -> Self {
        let source = std::env::var("AI_TEST_DATABASE_URL").expect("review requires PostgreSQL");
        let admin = sqlx::PgPool::connect(&source).await.unwrap();
        let name = format!("ai_money_{}", uuid::Uuid::new_v4().simple());
        sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
            .execute(&admin)
            .await
            .unwrap();
        let mut url = url::Url::parse(&source).unwrap();
        url.set_path(&name);
        Self {
            url: url.to_string(),
            name,
            admin,
        }
    }
    async fn finish(self) {
        sqlx::query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1")
            .bind(&self.name)
            .execute(&self.admin)
            .await
            .unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP DATABASE {}", self.name)))
            .execute(&self.admin)
            .await
            .unwrap();
        self.admin.close().await;
    }
}
fn policy() -> Policy {
    Policy::parse(
        include_str!("../../../config/tiers.toml"),
        include_str!("../../../config/prices.toml"),
    )
    .unwrap()
}
async fn ledger(db: &Database) -> Ledger {
    let p = policy();
    let ledger = Ledger::connect(&db.url, p.tiers, p.prices).await.unwrap();
    assert!(ledger.acquire_lock().await.unwrap());
    ledger
}
fn identity(name: &str) -> Identity {
    Identity {
        principal: Principal::Account(name.into()),
        plan: Plan::One,
        owner_grant: true,
        installation: None,
        client: Client::Web,
    }
}
fn admission(who: &Identity, id: &str, live: bool) -> Admission {
    Admission {
        identity: who.clone(),
        caller_id: CallerId::new(id.into()).unwrap(),
        label: "other".into(),
        requested: ModelClass::Small,
        expected_route: ModelRoute {
            provider: if live {
                Provider::OpenAi
            } else {
                Provider::Anthropic
            },
            model: if live {
                "gpt-live-transcribe"
            } else {
                "claude-haiku-4-5"
            }
            .into(),
            served: ModelClass::Small,
        },
        reservation: if live {
            Reservation::Transcription
        } else {
            Reservation::Text(TextBudget {
                input_tokens: 10,
                max_tokens: 10,
                min_tokens: None,
                cache: false,
            })
        },
    }
}
fn admitted(value: AdmissionOutcome) -> Call {
    match value {
        AdmissionOutcome::Admitted(c) => c,
        _ => panic!("expected admission"),
    }
}
fn settlement(charge: Charge) -> Settlement {
    Settlement {
        charge,
        stop: Some(Stop::Completed),
        code: None,
        provider_request_id: None,
    }
}
fn pass(name: &str) -> String {
    let seed = URL_SAFE_NO_PAD
        .decode("nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A")
        .unwrap();
    let key = SigningKey::from_bytes(&seed.try_into().unwrap());
    let payload = json!({"aud":"ai","env":"development","iat":NOW,"exp":NOW+600000,"sub":{"account":name},"plan":"one","ownerGrant":true,"client":"web"});
    let signed = format!(
        "wm-pass.v1.test-rfc8032.{}",
        URL_SAFE_NO_PAD.encode(payload.to_string())
    );
    format!(
        "{signed}.{}",
        URL_SAFE_NO_PAD.encode(key.sign(signed.as_bytes()).to_bytes())
    )
}
async fn service(
    db: &Database,
    live_url: Option<String>,
    text_url: Option<String>,
) -> Arc<Service> {
    let variables = HashMap::from([
        ("AI_ENVIRONMENT", "development".into()),
        ("AI_DATABASE_URL", db.url.clone()),
        (
            "AI_PASS_KEYS",
            r#"{"test-rfc8032":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"}"#.into(),
        ),
        ("AI_CARRY_KEY", URL_SAFE_NO_PAD.encode([42; 32])),
        ("AI_FUNDING_SECRET", "f".repeat(32)),
        ("AI_OPERATOR_SECRET", "o".repeat(32)),
    ]);
    Arc::new(Service {
        config: Arc::new(Config::from_environment(|key| variables.get(key).cloned()).unwrap()),
        ledger: ledger(db).await,
        policy: Arc::new(policy()),
        text: text_url.map(|url| {
            Arc::new(
                Anthropic::new(&url, Secret::new("fake".into()), CarryKey::new([42; 32])).unwrap(),
            )
        }),
        live: live_url.map(|url| {
            Arc::new(
                LiveClient::new(LiveConfig {
                    url,
                    key: Secret::new("fake".into()),
                    auth: LiveAuth::Bearer,
                    model: "gpt-live-transcribe".into(),
                    delay: "low".into(),
                })
                .unwrap(),
            )
        }),
        results: Results::default(),
        rates: Rates::default(),
        refusals: Refusals::default(),
        provider_health: ai_server::telemetry::ProviderHealth::default(),
        calls: Arc::new(Semaphore::new(256)),
        sessions: Arc::new(Semaphore::new(64)),
        active: Mutex::new(HashSet::new()),
        drain: CancellationToken::new(),
        lifecycle: tokio::sync::Mutex::new(()),
        clock: Arc::new(|| NOW),
    })
}

#[tokio::test]
async fn stalled_provider_context_does_not_block_session_drain() {
    let db = Database::new().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let release = CancellationToken::new();
    let provider_release = release.clone();
    let provider = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
        let config: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        socket
            .send(Message::Text(
                json!({"type":"session.updated","session":config["session"]})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        provider_release.cancelled().await;
        drop(socket);
    });
    let service = service(
        &db,
        Some(format!("ws://{address}/realtime?intent=transcription")),
        None,
    )
    .await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn(ai_server::listeners::serve(
        listener,
        public_router(service.clone()),
        stop.clone(),
    ));
    let mut request = format!("ws://{address}/v1/calls/context_backpressure_review/transcription")
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {}", pass("context-review"))
            .parse()
            .unwrap(),
    );
    request.headers_mut().insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        "wm-live.v1".parse().unwrap(),
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let started: Value =
        serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(started["type"], "started");
    let sender = tokio::spawn(async move {
        let context = json!({"type":"context","keywords":vec!["a".repeat(256);128]}).to_string();
        for _ in 0..2048 {
            if socket
                .send(Message::Text(context.clone().into()))
                .await
                .is_err()
            {
                break;
            }
        }
        socket
    });
    tokio::time::sleep(Duration::from_secs(2)).await;
    service.drain.cancel();
    let drained = tokio::time::timeout(Duration::from_secs(6), async {
        while !service.active.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .is_ok();
    release.cancel();
    provider.await.unwrap();
    sender.abort();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !service.active.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    stop.cancel();
    server.await.unwrap();
    drop(service);
    db.finish().await;
    assert!(
        drained,
        "provider socket backpressure kept an audio-free call dispatched and held after drain; releasing provider socket was required"
    );
}

#[tokio::test]
async fn grant_close_extension_and_settlement_remain_pinned() {
    let db = Database::new().await;
    let ledger = ledger(&db).await;
    let mut who = identity("grant-pins");
    who.owner_grant = false;
    ledger
        .fund(
            Fund {
                reference: "first".into(),
                account_id: "grant-pins".into(),
                plan: Plan::One,
                period: Period::new(NOW - 1, NOW + 1000).unwrap(),
            },
            NOW,
        )
        .await
        .unwrap();
    let call = admitted(
        ledger
            .admit(admission(&who, "grant_pin_live_identifier", true), NOW)
            .await
            .unwrap(),
    );
    ledger.dispatch(call.id, NOW).await.unwrap();
    ledger.close("first", NOW + 1).await.unwrap();
    let refused = ledger
        .extend_live(
            call.id,
            LiveProgress {
                slice: 2,
                audio_bytes: 48000,
                audio_seconds: 1,
                turns: 1,
            },
            NOW + 2,
        )
        .await
        .err();
    ledger
        .fund(
            Fund {
                reference: "second".into(),
                account_id: "grant-pins".into(),
                plan: Plan::One,
                period: Period::new(NOW + 1, NOW + 1001).unwrap(),
            },
            NOW + 2,
        )
        .await
        .unwrap();
    let outcome = ledger
        .settle(
            call.id,
            settlement(Charge::Audio {
                bytes: 48000,
                seconds: 1,
                turns: 1,
            }),
            NOW + 3,
        )
        .await
        .unwrap();
    let grants = ledger
        .principal(&who.principal, NOW + 3, None)
        .await
        .unwrap()
        .grants;
    let actual = grants
        .iter()
        .map(|g| (g.reference.clone(), g.spent.nanos(), g.held.nanos()))
        .collect::<Vec<_>>();
    drop(ledger);
    db.finish().await;
    assert_eq!(refused, Some(StaticCode::FundingRequired));
    assert_eq!(outcome.charged.nanos(), 283334);
    assert_eq!(
        actual,
        vec![("first".into(), 283334, 0), ("second".into(), 0, 0)]
    );
}

#[tokio::test]
async fn rounded_turns_extend_before_sixty_one_billed_seconds_and_settle_once() {
    let db = Database::new().await;
    let ledger = ledger(&db).await;
    let who = identity("rounding");
    ledger.prepare(&who, NOW).await.unwrap();
    let call = admitted(
        ledger
            .admit(admission(&who, "rounded_turns_live_identifier", true), NOW)
            .await
            .unwrap(),
    );
    ledger.dispatch(call.id, NOW).await.unwrap();
    let progress = || LiveProgress {
        slice: 2,
        audio_bytes: 30 * 48002,
        audio_seconds: 60,
        turns: 30,
    };
    let extended = ledger
        .extend_live(call.id, progress(), NOW + 1)
        .await
        .unwrap();
    let replay = ledger
        .extend_live(call.id, progress(), NOW + 2)
        .await
        .unwrap();
    let charge = Charge::Audio {
        bytes: 30 * 48002 + 48000,
        seconds: 61,
        turns: 31,
    };
    let first = ledger
        .settle(call.id, settlement(charge), NOW + 3)
        .await
        .unwrap();
    let second = ledger
        .settle(call.id, settlement(charge), NOW + 4)
        .await
        .unwrap();
    let allowance = ledger.allowance(&who, NOW + 5).await.unwrap();
    drop(ledger);
    db.finish().await;
    assert_eq!(
        (extended.reservation.nanos(), replay.reservation.nanos()),
        (34000000, 34000000)
    );
    assert_eq!(
        (first.charged.nanos(), second.charged.nanos(), second.replay),
        (17283334, 17283334, true)
    );
    assert_eq!(
        (allowance.used.nanos(), allowance.reserved.nanos()),
        (17283334, 0)
    );
}

#[tokio::test]
async fn many_owner_requests_share_one_cap_and_never_combine_grants() {
    let db = Database::new().await;
    let ledger = ledger(&db).await;
    let mut tasks = Vec::new();
    for i in 0..40 {
        let ledger = ledger.clone();
        tasks.push(tokio::spawn(async move {
            let who = identity(&format!("owner-{i}"));
            ledger.prepare(&who, NOW).await.unwrap();
            ledger.allowance(&who, NOW).await.unwrap().tier
        }));
    }
    let mut funded = 0;
    for task in tasks {
        if task.await.unwrap() == Tier::One {
            funded += 1;
        }
    }
    let who = identity("owner-0");
    ledger
        .fund(
            Fund {
                reference: "subscription-owner-0".into(),
                account_id: "owner-0".into(),
                plan: Plan::One,
                period: Period::new(NOW - 1, NOW + 1).unwrap(),
            },
            NOW,
        )
        .await
        .unwrap();
    let allowance = ledger.allowance(&who, NOW).await.unwrap();
    drop(ledger);
    db.finish().await;
    assert_eq!(funded, 25);
    assert_eq!(
        (allowance.limit.nanos(), allowance.period),
        (7000000000, AllowancePeriod::BillingPeriod)
    );
}

#[tokio::test]
async fn bound_installation_correction_counts_once_and_not_into_grant() {
    let db = Database::new().await;
    let ledger = ledger(&db).await;
    let installation = Identity {
        principal: Principal::Installation("bound-review".into()),
        plan: Plan::None,
        owner_grant: false,
        installation: None,
        client: Client::Web,
    };
    let call = admitted(
        ledger
            .admit(
                admission(&installation, "bound_installation_call_id", false),
                NOW,
            )
            .await
            .unwrap(),
    );
    ledger.dispatch(call.id, NOW).await.unwrap();
    ledger
        .settle(call.id, settlement(Charge::Assumed), NOW)
        .await
        .unwrap();
    let mut who = identity("binding-account");
    who.plan = Plan::None;
    who.owner_grant = false;
    who.installation = Some("bound-review".into());
    ledger.prepare(&who, NOW).await.unwrap();
    ledger.prepare(&who, NOW).await.unwrap();
    let cost = NanoUsd::new(12345).unwrap();
    ledger.correct(call.id, cost, NOW).await.unwrap();
    let replay = ledger.correct(call.id, cost, NOW).await.unwrap();
    let allowance = ledger.allowance(&who, NOW).await.unwrap();
    who.plan = Plan::One;
    who.owner_grant = true;
    ledger.prepare(&who, NOW).await.unwrap();
    let paid = ledger.allowance(&who, NOW).await.unwrap();
    drop(ledger);
    db.finish().await;
    assert!(replay.replay);
    assert_eq!(
        (allowance.used.nanos(), allowance.reserved.nanos()),
        (12345, 0)
    );
    assert_eq!((paid.used.nanos(), paid.reserved.nanos()), (0, 0));
}

#[tokio::test]
async fn unpriceable_usage_is_assumed_and_does_not_retry_forever() {
    let logs = Captured::default();
    let subscriber =
        tracing_subscriber::registry().with(ai_server::telemetry::json_lines(logs.clone()));
    let _scope = tracing::subscriber::set_default(subscriber);
    let db = Database::new().await;
    let response = concat!(
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"role\":\"assistant\",\"content\":[],\"usage\":{\"input_tokens\":10}}}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":18446744073709551615}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
    );
    let router = Router::new()
        .route(
            "/v1/messages/count_tokens",
            post(|| async { Json(json!({"input_tokens":10})) }),
        )
        .route(
            "/v1/messages",
            post(move || async move { ([(header::CONTENT_TYPE, "text/event-stream")], response) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let provider = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let service = service(&db, None, Some(format!("http://{address}"))).await;
    let id = "overflow_provider_usage_review";
    let who = identity("overflow");
    let request=axum::http::Request::put(format!("/v1/calls/{id}/text")).header(header::AUTHORIZATION,format!("Bearer {}",pass("overflow"))).body(Body::from(json!({"model":"small","messages":[{"role":"user","parts":[{"text":"hello"}]}],"output":{"maxTokens":10},"cache":false}).to_string())).unwrap();
    let response = tower::ServiceExt::oneshot(public_router(service.clone()), request)
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let events = tokio::time::timeout(
        Duration::from_secs(5),
        axum::body::to_bytes(response.into_body(), 65536),
    )
    .await
    .unwrap()
    .unwrap();
    let call = service
        .ledger
        .lookup(&who.principal, &CallerId::new(id.into()).unwrap())
        .await
        .unwrap()
        .unwrap();
    let result = (
        call.state,
        call.charged,
        call.reservation,
        service.active.lock().unwrap().len(),
    );
    assert_eq!(
        logs.calls("call.text"),
        vec![json!({
            "level":"INFO", "message":"call ended", "operation":"call.text",
        "product":"ai", "door":"public", "outcome":"assumed",
            "id":call.id, "label":"other", "client":"web", "environment":"development",
            "tier":"one", "provider":"anthropic", "requested":"small", "served":"small",
            "stop":"completed", "state":"assumed", "reservation":call.reservation.nanos(),
            "charged":call.reservation.nanos(), "http_status":200, "failure_kind":"None",
            "input":10, "output":u64::MAX, "cache_write":0, "cache_write_1h":0, "cache_read":0
        })]
    );
    provider.abort();
    drop(service);
    db.finish().await;
    assert_eq!(
        (result.0, result.1, result.3),
        (CallState::Assumed, Some(result.2), 0)
    );
    assert!(
        String::from_utf8(events.to_vec())
            .unwrap()
            .contains("event: ended")
    );
}

#[tokio::test]
async fn unsupported_provider_content_drains_to_eof_and_charges_reservation() {
    let db = Database::new().await;
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let provider_done = done.clone();
    let router=Router::new().route("/v1/messages/count_tokens",post(||async{Json(json!({"input_tokens":10}))})).route("/v1/messages",post(move||{let done=provider_done.clone();async move{
  let stream=futures_util::stream::unfold((0,done),|(index,done)|async move{match index{
   0=>Some((Ok::<_,std::io::Error>("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"role\":\"assistant\",\"content\":[],\"usage\":{\"input_tokens\":10}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"server_tool_use\"}}\n\n"),(1,done))),
   1=>{tokio::time::sleep(Duration::from_millis(300)).await;done.store(true,std::sync::atomic::Ordering::SeqCst);Some((Ok("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"),(2,done)))},_=>None
  }});([(header::CONTENT_TYPE,"text/event-stream")],Body::from_stream(stream)).into_response()
 }}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let provider = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let service = service(&db, None, Some(format!("http://{address}"))).await;
    let id = "unsupported_provider_review";
    let who = identity("unsupported");
    let request=axum::http::Request::put(format!("/v1/calls/{id}/text")).header(header::AUTHORIZATION,format!("Bearer {}",pass("unsupported"))).body(Body::from(json!({"model":"small","messages":[{"role":"user","parts":[{"text":"hello"}]}],"output":{"maxTokens":10},"cache":false}).to_string())).unwrap();
    let response = tower::ServiceExt::oneshot(public_router(service.clone()), request)
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let events = tokio::time::timeout(
        Duration::from_secs(5),
        axum::body::to_bytes(response.into_body(), 65536),
    )
    .await
    .unwrap()
    .unwrap();
    let call = service
        .ledger
        .lookup(&who.principal, &CallerId::new(id.into()).unwrap())
        .await
        .unwrap()
        .unwrap();
    let finished = done.load(std::sync::atomic::Ordering::SeqCst);
    provider.abort();
    drop(service);
    db.finish().await;
    assert!(
        finished,
        "caller ended before provider's final delayed bytes were drained"
    );
    assert_eq!(
        (call.state, call.charged),
        (CallState::Assumed, Some(call.reservation))
    );
    assert!(
        String::from_utf8(events.to_vec())
            .unwrap()
            .contains("event: failed")
    );
}

#[tokio::test]
async fn counted_route_mismatch_never_creates_a_call_or_hold() {
    let db = Database::new().await;
    let ledger = ledger(&db).await;
    let who = identity("route-change");
    ledger.prepare(&who, NOW).await.unwrap();
    let mut request = admission(&who, "expected_route_review_call", false);
    request.expected_route.model = "claude-opus-5".into();
    let refused = ledger.admit(request, NOW).await.err();
    let allowance = ledger.allowance(&who, NOW).await.unwrap();
    let missing = ledger
        .lookup(
            &who.principal,
            &CallerId::new("expected_route_review_call".into()).unwrap(),
        )
        .await
        .unwrap()
        .is_none();
    let call = admitted(
        ledger
            .admit(admission(&who, "expected_route_review_call", false), NOW)
            .await
            .unwrap(),
    );
    ledger
        .settle(call.id, settlement(Charge::Unconsumed), NOW)
        .await
        .unwrap();
    drop(ledger);
    db.finish().await;
    assert_eq!(refused, Some(StaticCode::AccountingUnavailable));
    assert!(missing);
    assert_eq!((allowance.used.nanos(), allowance.reserved.nanos()), (0, 0));
}

#[tokio::test]
async fn live_open_failure_and_initial_refusals_each_emit_one_static_signal() {
    let logs = Captured::default();
    let subscriber =
        tracing_subscriber::registry().with(ai_server::telemetry::json_lines(logs.clone()));
    let _scope = tracing::subscriber::set_default(subscriber);
    let db = Database::new().await;
    let provider_socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider_address = provider_socket.local_addr().unwrap();
    let provider = tokio::spawn(async move {
        let router =
            Router::new().fallback(|| async { axum::http::StatusCode::SERVICE_UNAVAILABLE });
        axum::serve(provider_socket, router).await.unwrap();
    });
    let service = service(
        &db,
        Some(format!(
            "ws://{provider_address}/realtime?intent=transcription"
        )),
        None,
    )
    .await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn(ai_server::listeners::serve(
        listener,
        public_router(service.clone()),
        stop.clone(),
    ));
    for (id, code) in [
        ("short", "invalid_request"),
        ("live_open_failure_signal", "provider_unavailable"),
        ("live_open_failure_signal", "conflict"),
    ] {
        let mut request = format!("ws://{address}/v1/calls/{id}/transcription")
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            header::AUTHORIZATION,
            format!("Bearer {}", pass("signals")).parse().unwrap(),
        );
        request.headers_mut().insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            "wm-live.v1".parse().unwrap(),
        );
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let message: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
        assert_eq!(
            (&message["type"], &message["code"]),
            (&json!("failed"), &json!(code))
        );
    }
    let call = service
        .ledger
        .lookup(
            &identity("signals").principal,
            &CallerId::new("live_open_failure_signal".into()).unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(call.state, CallState::Unconsumed);
    let lines = logs.calls("call.transcription");
    assert_eq!(
        lines,
        vec![
            json!({"level":"INFO","message":"refused","operation":"call.transcription","product":"ai","door":"public","code":"invalid_request","client":"web","tier":"one","label":"other","environment":"development"}),
            json!({"level":"INFO","message":"call ended","operation":"call.transcription","product":"ai","door":"public","outcome":"unconsumed","id":call.id,"label":"other","client":"web","environment":"development","tier":"one","provider":"openai","requested":"small","served":"small","code":"provider_unavailable","state":"unconsumed","reservation":call.reservation.nanos(),"charged":0,"http_status":503,"failure_kind":"Some(HttpStatus)"}),
            json!({"level":"INFO","message":"refused","operation":"call.transcription","product":"ai","door":"public","code":"conflict","client":"web","tier":"one","label":"other","environment":"development"}),
        ]
    );
    stop.cancel();
    server.await.unwrap();
    provider.abort();
    drop(service);
    db.finish().await;
}
