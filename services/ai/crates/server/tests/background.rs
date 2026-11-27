use ai_providers::{Anthropic, CarryKey, Secret};
use ai_server::{
    Service,
    config::Config,
    guards::{Rates, Refusals},
    internal_router,
    policy::Policy,
    public_router,
    results::Results,
    telemetry,
};
use ai_storage::Ledger;
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    http::{Request, header},
    response::{IntoResponse, Response},
    routing::post,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    io::{self, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, Semaphore};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;
use tracing_subscriber::{
    filter::{LevelFilter, Targets},
    prelude::*,
};

const NOW: i64 = 1_800_000_000_000;
const ACCOUNT: &str = "PRIVATE_ACCOUNT_5d1c0b7e";
const OTHER: &str = "PRIVATE_ACCOUNT_0e7f42a9";

#[derive(Clone)]
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

fn pass(account: &str, client: &str) -> String {
    let seed = URL_SAFE_NO_PAD
        .decode("nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A")
        .unwrap();
    let key = SigningKey::from_bytes(&seed.try_into().unwrap());
    let payload = json!({"aud":"ai","env":"development","iat":NOW,"exp":NOW+600_000,"sub":{"account":account},"plan":"none","client":client});
    let signed = format!(
        "wm-pass.v1.test-rfc8032.{}",
        URL_SAFE_NO_PAD.encode(payload.to_string())
    );
    format!(
        "{signed}.{}",
        URL_SAFE_NO_PAD.encode(key.sign(signed.as_bytes()).to_bytes())
    )
}

async fn send(router: &Router, request: Request<Body>) -> Response {
    router.clone().oneshot(request).await.unwrap()
}

async fn put(router: &Router, call: &str, account: &str, client: &str, body: &Value) -> Response {
    send(
        router,
        Request::put(format!("/v1/calls/{call}/text?label=echoes"))
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", pass(account, client)),
            )
            .body(Body::from(body.to_string()))
            .unwrap(),
    )
    .await
}

async fn get(router: &Router, path: &str, bearer: &str) -> Response {
    send(
        router,
        Request::get(path)
            .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await
}

async fn answer(response: Response) -> (u16, Value) {
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn last_event(response: Response) -> (String, Value) {
    assert_eq!(response.status(), 200);
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    let block = text
        .split("\n\n")
        .filter(|block| block.contains("data: "))
        .last()
        .unwrap();
    let field = |name: &str| {
        block
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .unwrap()
            .to_owned()
    };
    (
        field("event: "),
        serde_json::from_str(&field("data: ")).unwrap(),
    )
}

fn provider_answer() -> String {
    [
        json!({"type":"message_start","message":{"id":"msg_background","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\"passages\":[]}"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}),
        json!({"type":"message_stop"}),
    ]
    .iter()
    .map(|event| format!("event: {}\ndata: {event}\n\n", event["type"].as_str().unwrap()))
    .collect()
}

async fn background_beside_a_person(source: &str) {
    let admin = sqlx::PgPool::connect(source).await.unwrap();
    let database_name = format!("ai_background_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "CREATE DATABASE {database_name}"
    )))
    .execute(&admin)
    .await
    .unwrap();
    let mut database_url = url::Url::parse(source).unwrap();
    database_url.set_path(&database_name);
    let database = database_url.to_string();
    let messages = Arc::new(AtomicUsize::new(0));
    let release = Arc::new(Notify::new());
    let provider = Router::new()
        .route(
            "/v1/messages/count_tokens",
            post(|| async { Json(json!({"input_tokens":10})) }),
        )
        .route(
            "/v1/messages",
            post({
                let messages = messages.clone();
                let release = release.clone();
                move || {
                    let first = messages.fetch_add(1, Ordering::SeqCst) == 0;
                    let release = release.clone();
                    async move {
                        if first {
                            release.notified().await;
                        }
                        (
                            [(header::CONTENT_TYPE, "text/event-stream")],
                            provider_answer(),
                        )
                            .into_response()
                    }
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let provider_task = tokio::spawn(async move {
        axum::serve(listener, provider).await.unwrap();
    });
    let variables = HashMap::from([
        ("AI_ENVIRONMENT", "development".to_owned()),
        ("AI_DATABASE_URL", database.clone()),
        (
            "AI_PASS_KEYS",
            r#"{"test-rfc8032":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"}"#.to_owned(),
        ),
        ("AI_CARRY_KEY", URL_SAFE_NO_PAD.encode([42; 32])),
        ("AI_FUNDING_SECRET", "f".repeat(32)),
        ("AI_OPERATOR_SECRET", "o".repeat(32)),
        ("AI_ANTHROPIC_URL", format!("http://{address}")),
    ]);
    let config = Arc::new(Config::from_environment(|key| variables.get(key).cloned()).unwrap());
    let policy = Arc::new(
        Policy::parse(
            &include_str!("../../../config/tiers.toml").replace("hour = \"1\"", "hour = \"0.2\""),
            include_str!("../../../config/prices.toml"),
        )
        .unwrap(),
    );
    let ledger = Ledger::connect(&database, policy.tiers.clone(), policy.prices.clone())
        .await
        .unwrap();
    assert!(ledger.acquire_lock().await.unwrap());
    let service = Arc::new(Service {
        config,
        ledger,
        policy,
        text: Some(Arc::new(
            Anthropic::new(
                &format!("http://{address}"),
                Secret::new("mock".to_owned()),
                CarryKey::new([42; 32]),
            )
            .unwrap(),
        )),
        live: None,
        results: Results::default(),
        pictures: ai_server::pictures::Pictures::default(),
        rates: Rates::default(),
        refusals: Refusals::default(),
        provider_health: ai_server::telemetry::ProviderHealth::default(),
        calls: Arc::new(Semaphore::new(256)),
        sessions: Arc::new(Semaphore::new(64)),
        active: Mutex::new(HashSet::new()),
        drain: CancellationToken::new(),
        lifecycle: tokio::sync::Mutex::new(()),
        clock: Arc::new(|| NOW),
    });
    let router = public_router(service.clone());
    let echo = json!({"model":"medium","system":["Cut the page into passages."],"messages":[{"role":"user","parts":[{"text":"A page."}]}],"output":{"maxTokens":16000,"schema":{"type":"object","properties":{"passages":{"type":"array","items":{"type":"string"}}},"required":["passages"],"additionalProperties":false}},"effort":"low","cache":false});
    let coach = json!({"model":"small","messages":[{"role":"user","parts":[{"text":"Hello"}]}],"output":{"maxTokens":20},"cache":false});

    let background = put(&router, "backgroundcall00000001", ACCOUNT, "server", &echo).await;
    assert_eq!(background.status(), 200);
    let person = put(&router, "personcall000000000001", ACCOUNT, "web", &coach).await;
    let (event, ended) = last_event(person).await;
    assert_eq!(
        (
            event.as_str(),
            &ended["stop"],
            &ended["allowance"]["tier"],
            &ended["allowance"]["reserved"],
            &ended["allowance"]["code"],
        ),
        (
            "ended",
            &json!("completed"),
            &json!("free"),
            &json!("0"),
            &json!("ok")
        )
    );
    assert_eq!(
        answer(put(&router, "backgroundcall00000002", ACCOUNT, "server", &echo).await).await,
        (
            429,
            json!({"code":"concurrency_exhausted","allowance":null})
        )
    );
    for call in ["backgroundhour00000001", "backgroundhour00000002"] {
        assert_eq!(
            answer(put(&router, call, OTHER, "server", &echo).await).await,
            (503, json!({"code":"paused","allowance":null}))
        );
    }
    let internal = internal_router(service.clone());
    let (status, shared) =
        answer(get(&internal, "/internal/v1/budgets", &"o".repeat(32)).await).await;
    assert_eq!(
        (status, &shared["backgroundHour"]),
        (200, &json!({"spent":"0","held":"0.16015","limit":"0.2"}))
    );
    assert_eq!(
        answer(get(&router, "/v1/allowance", &pass(ACCOUNT, "server")).await).await,
        (400, json!({"code":"invalid_request","allowance":null}))
    );
    let (status, persons) =
        answer(get(&router, "/v1/allowance", &pass(ACCOUNT, "web")).await).await;
    assert_eq!(
        (
            status,
            &persons["tier"],
            &persons["reserved"],
            &persons["code"]
        ),
        (200, &json!("free"), &json!("0"), &json!("ok"))
    );

    release.notify_one();
    let (event, ended) = last_event(background).await;
    assert_eq!(
        (event.as_str(), &ended["stop"], &ended["allowance"]),
        ("ended", &json!("completed"), &Value::Null)
    );
    assert!(ended["charged"].is_string());
    let (status, calls) = answer(
        get(
            &internal,
            "/internal/v1/calls?callId=backgroundcall00000001",
            &"o".repeat(32),
        )
        .await,
    )
    .await;
    let call = &calls["calls"][0];
    assert_eq!(
        (
            status,
            &call["tier"],
            &call["client"],
            &call["label"],
            &call["requested"],
            &call["served"],
            &call["state"],
            &call["maxTokens"],
        ),
        (
            200,
            &json!("background"),
            &json!("server"),
            &json!("echoes"),
            &json!("medium"),
            &json!("medium"),
            &json!("settled"),
            &json!(16000),
        )
    );

    let starts_left = 29;
    for index in 0..starts_left {
        let (status, _) = answer(
            put(
                &router,
                &format!("personstart{index:0>11}"),
                ACCOUNT,
                "web",
                &json!({}),
            )
            .await,
        )
        .await;
        assert_eq!(status, 400);
    }
    let (status, refused) = answer(
        put(
            &router,
            "personstart00000000099",
            ACCOUNT,
            "web",
            &json!({}),
        )
        .await,
    )
    .await;
    assert_eq!(
        (status, &refused["code"], &refused["allowance"]["tier"]),
        (429, &json!("rate_limited"), &json!("free"))
    );
    assert_eq!(
        answer(
            put(
                &router,
                "backgroundcall00000099",
                ACCOUNT,
                "server",
                &json!({})
            )
            .await
        )
        .await,
        (400, json!({"code":"invalid_request","allowance":null}))
    );

    service.drain.cancel();
    drop(router);
    drop(service);
    provider_task.abort();
    sqlx::query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1")
        .bind(&database_name)
        .execute(&admin)
        .await
        .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "DROP DATABASE {database_name}"
    )))
    .execute(&admin)
    .await
    .unwrap();
    admin.close().await;
}

#[test]
fn a_server_pass_is_background_work_beside_the_persons_own_call() {
    let source = std::env::var("AI_TEST_DATABASE_URL")
        .expect("AI_TEST_DATABASE_URL is required for server PostgreSQL tests");
    let logs = Captured(Arc::new(Mutex::new(vec![])));
    let subscriber = tracing_subscriber::registry()
        .with(
            Targets::new()
                .with_default(LevelFilter::OFF)
                .with_targets(telemetry::SERVICE_CRATES.map(|name| (name, LevelFilter::TRACE))),
        )
        .with(telemetry::json_lines(logs.clone()));
    let events = sentry::test::with_captured_events(|| {
        tracing::subscriber::with_default(subscriber, || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    tokio::time::timeout(
                        Duration::from_secs(60),
                        background_beside_a_person(&source),
                    )
                    .await
                    .expect("the background story exceeded 60 seconds");
                });
        });
    });
    let hours = events
        .iter()
        .filter(|event| event.message.as_deref() == Some("background.hour"))
        .map(|event| (event.level, event.fingerprint.to_vec()))
        .collect::<Vec<_>>();
    assert_eq!(
        hours,
        vec![(sentry::Level::Warning, vec!["background.hour".into()])]
    );
    let logs = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    let lines = logs
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    let refused = lines
        .iter()
        .find(|line| line["code"] == "concurrency_exhausted")
        .unwrap();
    assert_eq!(
        (
            &refused["operation"],
            &refused["tier"],
            &refused["client"],
            &refused["label"],
            &refused["message"],
        ),
        (
            &json!("call.text"),
            &json!("background"),
            &json!("server"),
            &json!("echoes"),
            &json!("refused"),
        )
    );
    let paused = lines
        .iter()
        .filter(|line| line["code"] == "paused")
        .map(|line| {
            (
                line["operation"].clone(),
                line["ceiling"].clone(),
                line["tier"].clone(),
                line["client"].clone(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        paused,
        vec![
            (
                json!("call.text"),
                json!("background_hour"),
                json!("background"),
                json!("server")
            );
            2
        ]
    );
    let ended = lines
        .iter()
        .find(|line| line["message"] == "call ended" && line["client"] == "server")
        .unwrap();
    assert_eq!(
        (&ended["tier"], &ended["state"], &ended["label"]),
        (&json!("background"), &json!("settled"), &json!("echoes"))
    );
    assert!(!logs.contains(ACCOUNT));
    assert!(!logs.contains(OTHER));
    assert!(!logs.contains(&pass(ACCOUNT, "server")));
    assert!(!logs.contains("backgroundcall"));
}
