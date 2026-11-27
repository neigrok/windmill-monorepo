use ai_providers::{Anthropic, CarryKey, LiveAuth, LiveClient, LiveConfig, Secret};
use ai_server::{
    Service,
    config::Config,
    guards::{Rates, Refusals},
    pass::{Environment, PassVerifier},
    policy::Policy,
    public_router,
    results::Results,
    telemetry,
};
use ai_storage::Ledger;
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
    response::IntoResponse,
    routing::post,
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::{self, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Semaphore;
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;
use tracing_subscriber::{
    filter::{LevelFilter, Targets},
    prelude::*,
};

const NOW: i64 = 1_800_000_000_000;
const PUBLIC: &str = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
const MARKER: &str = "PRIVATE_CONTENT_e21cc1d2";
const PRINCIPAL: &str = "PRIVATE_PRINCIPAL_2ee44caf";
const CALLER: &str = "PRIVATE_CALLER_acdba123456789";
const PROVIDER_KEY: &str = "PRIVATE_PROVIDER_KEY_20b16ce4";
const FUNDING_KEY: &str = "PRIVATE_FUNDING_KEY_20b16ce4xxxxxxxx";
const OPERATOR_KEY: &str = "PRIVATE_OPERATOR_KEY_20b16ce4xxxxxxx";

fn sign_payload(payload: &str, kid: &str) -> String {
    sign_encoded(&URL_SAFE_NO_PAD.encode(payload), kid)
}
fn sign_encoded(payload: &str, kid: &str) -> String {
    let seed = URL_SAFE_NO_PAD
        .decode("nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A")
        .unwrap();
    let key = SigningKey::from_bytes(&seed.try_into().unwrap());
    let signed = format!("wm-pass.v1.{kid}.{payload}");
    format!(
        "{signed}.{}",
        URL_SAFE_NO_PAD.encode(key.sign(signed.as_bytes()).to_bytes())
    )
}
fn claims(account: &str) -> Value {
    json!({"aud":"ai","env":"development","iat":NOW,"exp":NOW+600_000,"sub":{"account":account},"plan":"one","ownerGrant":true,"client":"web"})
}
fn pass(account: &str) -> String {
    sign_payload(&claims(account).to_string(), "test-rfc8032")
}
fn result_code(verifier: &PassVerifier, pass: Option<&str>) -> &'static str {
    verifier
        .verify(pass, NOW)
        .map(|_| "ok")
        .unwrap_or_else(|code| code)
}

#[test]
fn adversarial_passes_fail_closed_before_claims_are_trusted() {
    let verifier = PassVerifier::new(
        Environment::Development,
        BTreeMap::from([("test-rfc8032".to_owned(), PUBLIC.to_owned())]),
    )
    .unwrap();
    let valid = pass("account");
    assert_eq!(result_code(&verifier, Some(&valid)), "ok");
    assert_eq!(result_code(&verifier, None), "pass_missing");
    for token in [
        "wm-pass.v1.test-rfc8032.invalid.AA".to_owned(),
        valid[..valid.len() - 1].to_owned(),
        format!("{valid}.extra"),
        "x".repeat(2049),
        valid.replace("test-rfc8032", "unknown"),
        valid.replace("wm-pass", "WM-PASS"),
    ] {
        assert_eq!(result_code(&verifier, Some(&token)), "pass_signature");
    }
    let signed_invalid = sign_encoded("%not-base64%", "test-rfc8032");
    assert_eq!(
        result_code(&verifier, Some(&signed_invalid)),
        "pass_malformed"
    );
    let forged_invalid = format!(
        "{}.{}",
        signed_invalid.rsplit_once('.').unwrap().0,
        URL_SAFE_NO_PAD.encode([0u8; 64])
    );
    assert_eq!(
        result_code(&verifier, Some(&forged_invalid)),
        "pass_signature"
    );
    let raw = claims("account").to_string();
    for payload in [format!("{raw} "), format!("\n{raw}\n")] {
        let rewritten = valid.replace(
            &URL_SAFE_NO_PAD.encode(&raw),
            &URL_SAFE_NO_PAD.encode(&payload),
        );
        assert_eq!(result_code(&verifier, Some(&rewritten)), "pass_signature");
    }
    for (field, value, expected) in [
        ("env", json!("production"), "pass_audience"),
        ("aud", json!("backend"), "pass_audience"),
        ("unknown", json!(MARKER), "pass_malformed"),
        ("plan", Value::Null, "pass_malformed"),
        ("ownerGrant", Value::Null, "pass_malformed"),
        ("installation", Value::Null, "pass_malformed"),
        ("plan", json!("none"), "pass_malformed"),
        ("ownerGrant", json!(false), "pass_malformed"),
        (
            "sub",
            json!({"account":"a","installation":"b"}),
            "pass_malformed",
        ),
        (
            "sub",
            json!({"account":"a","installation":null}),
            "pass_malformed",
        ),
        ("sub", json!({"installation":"a"}), "pass_malformed"),
        ("sub", json!({"account":""}), "pass_malformed"),
        ("sub", json!({"account":"a\n"}), "pass_malformed"),
        ("sub", json!({"account":"a".repeat(257)}), "pass_malformed"),
        ("exp", json!(NOW), "pass_malformed"),
        ("exp", json!(NOW + 600_001), "pass_malformed"),
        ("iat", json!(i64::MIN), "pass_malformed"),
        ("client", json!(MARKER), "pass_malformed"),
    ] {
        let mut payload = claims("account");
        payload[field] = value;
        assert_eq!(
            result_code(
                &verifier,
                Some(&sign_payload(&payload.to_string(), "test-rfc8032"))
            ),
            expected,
            "{field}"
        );
    }
    for (iat, exp, expected) in [
        (NOW - 600_000, NOW, "pass_expired"),
        (NOW + 60_001, NOW + 600_000, "pass_expired"),
        (NOW + 60_000, NOW + 600_000, "ok"),
    ] {
        let mut payload = claims("account");
        payload["iat"] = json!(iat);
        payload["exp"] = json!(exp);
        assert_eq!(
            result_code(
                &verifier,
                Some(&sign_payload(&payload.to_string(), "test-rfc8032"))
            ),
            expected
        );
    }
    for payload in [
        raw.replacen('{', "{\"aud\":\"ai\",", 1),
        raw.replace(
            "\"account\":\"account\"",
            "\"account\":\"other\",\"account\":\"account\"",
        ),
        raw.replace("\"plan\":\"one\"", "\"plan\":\"none\",\"plan\":\"one\""),
    ] {
        assert_eq!(
            result_code(&verifier, Some(&sign_payload(&payload, "test-rfc8032"))),
            "pass_malformed"
        );
    }
    let encoded = URL_SAFE_NO_PAD.encode(raw);
    assert_eq!(
        result_code(
            &verifier,
            Some(&sign_encoded(&format!("{encoded}="), "test-rfc8032"))
        ),
        "pass_malformed"
    );
    let signature = valid.rsplit_once('.').unwrap().1;
    let padded = format!("{}.{}=", valid.rsplit_once('.').unwrap().0, signature);
    assert_eq!(result_code(&verifier, Some(&padded)), "pass_signature");
    let mut noncanonical_signature = signature.as_bytes().to_vec();
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let last = noncanonical_signature.len() - 1;
    let index = alphabet
        .iter()
        .position(|byte| *byte == noncanonical_signature[last])
        .unwrap();
    noncanonical_signature[last] = alphabet[index + 1];
    let noncanonical = format!(
        "{}.{}",
        valid.rsplit_once('.').unwrap().0,
        String::from_utf8(noncanonical_signature).unwrap()
    );
    assert_eq!(
        result_code(&verifier, Some(&noncanonical)),
        "pass_signature"
    );
    for kid in ["test-rfc8032", "production-alias"] {
        assert!(matches!(
            PassVerifier::new(
                Environment::Production,
                BTreeMap::from([(kid.to_owned(), PUBLIC.to_owned())])
            ),
            Err("public_test_key")
        ));
    }
}

#[test]
fn active_buffers_are_bounded_and_one_principal_cannot_evict_another() {
    let results = Results::new(256, 512);
    let victim = results.create("1".into(), "victim".into(), false);
    results.push(&victim, "ended", json!({"text":"victim"}), true);
    for index in 2..200 {
        let attacker = results.create(index.to_string(), "attacker".into(), false);
        results.push(&attacker, "text", json!({"text":"x".repeat(128)}), false);
        assert!(results.get("1").is_some());
    }
    let retained = (2..200)
        .filter(|index| results.get(&index.to_string()).is_some())
        .count();
    assert_eq!(retained, 1);
    let entry = results.create("reader".into(), "reader".into(), false);
    let first = entry.attach();
    let second = entry.attach();
    results.push(&entry, "text", json!({"delta":"x"}), false);
    let old = entry.next(0, first);
    assert!(old.0.is_none() && old.1);
    let new = entry.next(0, second);
    assert_eq!(new.0.unwrap().data, r#"{"delta":"x"}"#);
    assert!(!new.1);
}

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

fn event(name: &str, value: Value) -> String {
    format!("event: {name}\ndata: {value}\n\n")
}
fn answer(failed: bool) -> String {
    let mut stream = event(
        "message_start",
        json!({"type":"message_start","message":{"id":"provider_metadata_id","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}),
    );
    stream += &event(
        "content_block_start",
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
    );
    stream += &event(
        "content_block_delta",
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":MARKER}}),
    );
    if failed {
        return stream
            + &event(
                "error",
                json!({"type":"error","error":{"type":MARKER,"message":MARKER}}),
            );
    }
    stream += &event(
        "content_block_stop",
        json!({"type":"content_block_stop","index":0}),
    );
    stream += &event(
        "message_delta",
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}),
    );
    stream + &event("message_stop", json!({"type":"message_stop"}))
}
fn text_request() -> Value {
    let mut image = b"\x89PNG\r\n\x1a\n".to_vec();
    image.extend_from_slice(MARKER.as_bytes());
    json!({"model":"small","system":[MARKER],"tools":[{"name":MARKER,"description":MARKER,"input":{"type":"object","properties":{"secret":{"type":"string","description":MARKER}}}}],"messages":[{"role":"user","parts":[{"text":MARKER},{"image":{"mediaType":"image/png","data":STANDARD.encode(image)}}]},{"role":"assistant","parts":[{"text":MARKER},{"toolCall":{"id":MARKER,"name":MARKER,"input":{"value":MARKER}}}],"carry":MARKER},{"role":"tool","results":[{"id":MARKER,"content":MARKER,"isError":false}]}],"output":{"maxTokens":20,"schema":{"type":"object","description":MARKER}},"cache":false})
}
async fn call(
    router: &Router,
    method: &str,
    path: &str,
    account: &str,
    body: Value,
) -> (u16, String) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header(header::AUTHORIZATION, format!("Bearer {}", pass(account)))
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let data = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (status, String::from_utf8(data.to_vec()).unwrap())
}

#[test]
fn content_stays_out_of_logs_sentry_database_and_provider_identity() {
    let source =
        std::env::var("AI_TEST_DATABASE_URL").expect("privacy review requires disposable Postgres");
    let logs = Captured(Arc::new(Mutex::new(vec![])));
    let subscriber = tracing_subscriber::registry()
        .with(
            Targets::new()
                .with_default(LevelFilter::OFF)
                .with_targets(telemetry::SERVICE_CRATES.map(|name| (name, LevelFilter::TRACE))),
        )
        .with(telemetry::json_lines(logs.clone()))
        .with(sentry::integrations::tracing::LogLayer::new());
    let envelopes = sentry::test::with_captured_envelopes(|| {
        tracing::subscriber::with_default(subscriber, || {
            let previous = std::panic::take_hook();
            telemetry::report_panics();
            let panic_value = MARKER.to_owned();
            let panic = std::panic::catch_unwind(|| std::panic::panic_any(panic_value));
            std::panic::set_hook(previous);
            assert!(panic.is_err());
            tracing::error!(target:"reqwest",private=MARKER,"dependency trace must be excluded");
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    tokio::time::timeout(Duration::from_secs(90), privacy_pipeline(&source, false))
                        .await
                        .expect("privacy pipeline exceeded90seconds");
                });
            sentry::Hub::current()
                .client()
                .unwrap()
                .flush(Some(Duration::from_secs(2)));
        });
    });
    assert!(envelopes.iter().any(|envelope| {
        envelope
            .event()
            .is_some_and(|event| !event.exception.is_empty())
    }));
    assert!(envelopes.iter().any(|envelope| {
        envelope
            .event()
            .is_some_and(|event| event.message.as_deref() == Some("ledger.settle"))
    }));
    let mut sentry_bytes = vec![];
    for envelope in &envelopes {
        envelope.to_writer(&mut sentry_bytes).unwrap();
    }
    let sentry_text = String::from_utf8_lossy(&sentry_bytes);
    let logs = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    assert!(logs.contains("call.text"));
    assert!(logs.contains("call.transcription"));
    assert!(logs.contains("invalid_request"));
    assert!(logs.contains(r#""refusal":"schema_too_complex""#));
    assert!(logs.contains(r#""refusal":"prompt_too_long""#));
    for private in [
        MARKER,
        PRINCIPAL,
        CALLER,
        PROVIDER_KEY,
        FUNDING_KEY,
        OPERATOR_KEY,
        &pass(PRINCIPAL),
    ] {
        assert!(!logs.contains(private), "stdout leaked private marker");
        assert!(
            !sentry_text.contains(private),
            "Sentry leaked private marker"
        );
    }
    for envelope in &envelopes {
        if let Some(event) = envelope.event() {
            for exception in &event.exception.values {
                if exception.ty == "panic" {
                    assert!(exception.value.as_deref().unwrap().contains("privacy.rs:"));
                    assert!(!exception.stacktrace.as_ref().unwrap().frames.is_empty());
                }
            }
        }
    }
}

#[test]
fn recovered_orphan_does_not_retain_content_past_linger() {
    if std::env::var_os("AI_ORPHAN_PROBE_CHILD").is_none() {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "recovered_orphan_does_not_retain_content_past_linger",
            ])
            .env("AI_ORPHAN_PROBE_CHILD", "1")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let start = std::time::Instant::now();
        loop {
            if child.try_wait().unwrap().is_some() {
                let output = child.wait_with_output().unwrap();
                assert!(
                    output.status.success(),
                    "orphan regression failed: {} {}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
                return;
            }
            if start.elapsed() >= Duration::from_secs(120) {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("orphan regression process exceeded120seconds");
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    let source =
        std::env::var("AI_TEST_DATABASE_URL").expect("privacy review requires disposable Postgres");
    let previous = std::panic::take_hook();
    telemetry::report_panics();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(90), privacy_pipeline(&source, true))
                .await
                .expect("orphan privacy pipeline exceeded90seconds");
        })
    }));
    std::panic::set_hook(previous);
    assert!(
        result.is_ok(),
        "ended orphan answer remained reachable after a simulated hour"
    );
}

async fn privacy_pipeline(source: &str, probe_orphan: bool) {
    let admin = sqlx::PgPool::connect(source).await.unwrap();
    let database_name = format!("ai_privacy_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "CREATE DATABASE {database_name}"
    )))
    .execute(&admin)
    .await
    .unwrap();
    let mut database_url = url::Url::parse(source).unwrap();
    database_url.set_path(&database_name);
    let database = database_url.to_string();
    let seen = Arc::new(Mutex::new(Vec::<Value>::new()));
    let mode = Arc::new(AtomicUsize::new(0));
    let provider = Router::new()
        .route(
            "/v1/messages/count_tokens",
            post({
                let seen = seen.clone();
                let mode = mode.clone();
                move |Json(value): Json<Value>| {
                    let seen = seen.clone();
                    let mode = mode.clone();
                    async move {
                        seen.lock().unwrap().push(value);
                        match mode.load(Ordering::SeqCst) {
                            4 => (
                                StatusCode::BAD_REQUEST,
                                Json(json!({"type":"error","error":{"type":"invalid_request_error","message":format!("prompt is too long: {MARKER}")}})),
                            )
                                .into_response(),
                            _ => Json(json!({"input_tokens":10})).into_response(),
                        }
                    }
                }
            }),
        )
        .route(
            "/v1/messages",
            post({
                let seen = seen.clone();
                let mode = mode.clone();
                move |Json(value): Json<Value>| {
                    let seen = seen.clone();
                    let mode = mode.clone();
                    async move {
                        seen.lock().unwrap().push(value);
                        match mode.load(Ordering::SeqCst) {
                            1 => (StatusCode::UNAUTHORIZED, MARKER).into_response(),
                            2 => ([(header::CONTENT_TYPE, "text/event-stream")], answer(true))
                                .into_response(),
                            3 => (
                                StatusCode::BAD_REQUEST,
                                Json(json!({"type":"error","error":{"type":"invalid_request_error","message":format!("Schema is too complex for compilation: {MARKER}")}})),
                            )
                                .into_response(),
                            _ => ([(header::CONTENT_TYPE, "text/event-stream")], answer(false))
                                .into_response(),
                        }
                    }
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let provider_task = tokio::spawn(async move {
        axum::serve(listener, provider).await.unwrap();
    });
    let live_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let live_address = live_listener.local_addr().unwrap();
    let live_seen = Arc::new(Mutex::new(vec![]));
    let live_received = live_seen.clone();
    let live_provider = tokio::spawn(async move {
        let (socket, _) = live_listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
        let config: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        live_received.lock().unwrap().push(config.clone());
        socket
            .send(Message::Text(
                json!({"type":"session.updated","session":config["session"]})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        loop {
            let message = socket.next().await.unwrap().unwrap();
            let value: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
            let committed = value["type"] == "input_audio_buffer.commit";
            live_received.lock().unwrap().push(value);
            if committed {
                break;
            }
        }
        for value in [
            json!({"type":"input_audio_buffer.committed","item_id":"item_private","previous_item_id":null}),
            json!({"type":"conversation.item.input_audio_transcription.delta","item_id":"item_private","delta":MARKER}),
            json!({"type":"conversation.item.input_audio_transcription.completed","item_id":"item_private","transcript":MARKER}),
        ] {
            socket
                .send(Message::Text(value.to_string().into()))
                .await
                .unwrap();
        }
        while let Some(Ok(message)) = socket.next().await {
            if message.is_close() {
                break;
            }
        }
    });
    let variables = HashMap::from([
        ("AI_ENVIRONMENT", "development".to_owned()),
        ("AI_DATABASE_URL", database.clone()),
        ("AI_PASS_KEYS", format!(r#"{{"test-rfc8032":"{PUBLIC}"}}"#)),
        ("AI_CARRY_KEY", URL_SAFE_NO_PAD.encode([42; 32])),
        ("AI_FUNDING_SECRET", FUNDING_KEY.to_owned()),
        ("AI_OPERATOR_SECRET", OPERATOR_KEY.to_owned()),
        ("AI_ANTHROPIC_URL", format!("http://{address}")),
    ]);
    let config = Arc::new(Config::from_environment(|key| variables.get(key).cloned()).unwrap());
    let policy = Arc::new(
        Policy::parse(
            include_str!("../../../config/tiers.toml"),
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
                Secret::new(PROVIDER_KEY.to_owned()),
                CarryKey::new([42; 32]),
            )
            .unwrap(),
        )),
        live: Some(Arc::new(
            LiveClient::new(LiveConfig {
                url: format!("ws://{live_address}/v1/realtime?intent=transcription"),
                key: Secret::new(PROVIDER_KEY.to_owned()),
                auth: LiveAuth::Bearer,
                model: "gpt-live-transcribe".to_owned(),
                delay: "low".to_owned(),
            })
            .unwrap(),
        )),
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
    let mut request = text_request();
    let image_data = request["messages"][0]["parts"][1]["image"]["data"]
        .as_str()
        .unwrap()
        .to_owned();
    let picture_id = "private_picture_1234567890";
    request["messages"][0]["parts"][1] = json!({"image":{"picture":picture_id}});
    let missing = call(
        &router,
        "PUT",
        &format!("/v1/calls/{CALLER}/text"),
        PRINCIPAL,
        request.clone(),
    )
    .await;
    assert_eq!(missing.0, 410);
    assert_eq!(
        serde_json::from_str::<Value>(&missing.1).unwrap()["code"],
        "picture_gone"
    );
    assert!(
        service
            .ledger
            .lookup(
                &ai_domain::Principal::new("account", PRINCIPAL.into()).unwrap(),
                &ai_domain::CallerId::new(CALLER.into()).unwrap()
            )
            .await
            .unwrap()
            .is_none()
    );
    assert!(seen.lock().unwrap().is_empty());
    let large_picture_id = format!("{MARKER}_large_picture");
    let mut large_picture = vec![0; ai_server::config::MAX_PICTURE];
    large_picture[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    large_picture[8..8 + MARKER.len()].copy_from_slice(MARKER.as_bytes());
    let uploaded = router
        .clone()
        .oneshot(
            Request::put(format!("/v1/pictures/{large_picture_id}"))
                .header(header::AUTHORIZATION, format!("Bearer {}", pass(PRINCIPAL)))
                .header(header::CONTENT_TYPE, "image/png")
                .body(Body::from(large_picture))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(uploaded.status(), 204);
    let mut expanded = request.clone();
    expanded["messages"][0]["parts"] =
        json!(vec![json!({"image":{"picture":large_picture_id}}); 8]);
    let oversized = call(
        &router,
        "PUT",
        &format!("/v1/calls/{CALLER}/text"),
        PRINCIPAL,
        expanded,
    )
    .await;
    assert_eq!(oversized.0, 400);
    assert_eq!(
        serde_json::from_str::<Value>(&oversized.1).unwrap(),
        json!({"code":"invalid_request","allowance":serde_json::from_str::<Value>(&missing.1).unwrap()["allowance"]})
    );
    assert!(
        service
            .ledger
            .lookup(
                &ai_domain::Principal::new("account", PRINCIPAL.into()).unwrap(),
                &ai_domain::CallerId::new(CALLER.into()).unwrap()
            )
            .await
            .unwrap()
            .is_none()
    );
    assert!(seen.lock().unwrap().is_empty());
    for bytes in [
        STANDARD.decode(&image_data).unwrap(),
        b"\x89PNG\r\n\x1a\nreplacement".to_vec(),
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::put(format!("/v1/pictures/{picture_id}"))
                    .header(header::AUTHORIZATION, format!("Bearer {}", pass(PRINCIPAL)))
                    .header(header::CONTENT_TYPE, "image/png")
                    .body(Body::from(bytes))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 204);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "no-store, no-transform"
        );
        assert!(
            to_bytes(response.into_body(), 1024)
                .await
                .unwrap()
                .is_empty()
        );
    }
    let other = call(
        &router,
        "PUT",
        &format!("/v1/calls/{CALLER}/text"),
        "attacker",
        request.clone(),
    )
    .await;
    assert_eq!(other.0, 410);
    assert_eq!(
        serde_json::from_str::<Value>(&other.1).unwrap()["code"],
        "picture_gone"
    );
    let first = call(
        &router,
        "PUT",
        &format!("/v1/calls/{CALLER}/text?label={MARKER}"),
        PRINCIPAL,
        request.clone(),
    )
    .await;
    assert_eq!(first.0, 200);
    assert!(first.1.contains("event: ended"));
    assert!(first.1.contains(MARKER));
    for suffix in ["", "/result"] {
        let victim = call(
            &router,
            "GET",
            &format!("/v1/calls/{CALLER}{suffix}"),
            "attacker",
            Value::Null,
        )
        .await;
        let absent = call(
            &router,
            "GET",
            &format!("/v1/calls/absent_call_123456789012345{suffix}"),
            "attacker",
            Value::Null,
        )
        .await;
        assert_eq!(victim, absent);
        assert_eq!(victim.0, 404);
    }
    let ended = first
        .1
        .split("event: ended\n")
        .nth(1)
        .unwrap()
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .unwrap();
    let ended: Value = serde_json::from_str(ended).unwrap();
    let mut continued = request.clone();
    continued["messages"] = json!([{"role":"user","parts":[{"text":MARKER}]},ended["message"],{"role":"user","parts":[{"text":MARKER}]}]);
    let second = call(
        &router,
        "PUT",
        "/v1/calls/continued_call_123456789012345/text",
        PRINCIPAL,
        continued,
    )
    .await;
    assert!(second.1.contains("event: ended"));
    mode.store(1, Ordering::SeqCst);
    let rejected = call(
        &router,
        "PUT",
        "/v1/calls/rejected_call_123456789012345/text",
        PRINCIPAL,
        request.clone(),
    )
    .await;
    assert!(rejected.1.contains("provider_unavailable"));
    assert!(!rejected.1.contains(MARKER));
    mode.store(2, Ordering::SeqCst);
    let assumed = call(
        &router,
        "PUT",
        "/v1/calls/assumed_call_123456789012345/text",
        PRINCIPAL,
        request.clone(),
    )
    .await;
    assert!(assumed.1.contains("provider_failed"));
    for (refusal, path) in [
        (3, "/v1/calls/schema_call_12345678901234567/text"),
        (4, "/v1/calls/counted_call_1234567890123456/text"),
    ] {
        mode.store(refusal, Ordering::SeqCst);
        let rejected = call(&router, "PUT", path, PRINCIPAL, request.clone()).await;
        assert!(rejected.1.contains("provider_rejected"));
        assert!(!rejected.1.contains(MARKER));
    }
    let mut malformed = request;
    malformed["unknown"] = json!(MARKER);
    let refused = call(
        &router,
        "PUT",
        "/v1/calls/refused_call_123456789012345/text",
        PRINCIPAL,
        malformed,
    )
    .await;
    assert_eq!(refused.0, 400);
    assert!(!refused.1.contains(MARKER));
    let public_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let public_address = public_listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let public_task = tokio::spawn(ai_server::listeners::serve(
        public_listener,
        router.clone(),
        stop.clone(),
    ));
    let live_path =
        format!("ws://{public_address}/v1/calls/live_call_1234567890123456789/transcription");
    let mut socket_request = live_path.into_client_request().unwrap();
    socket_request.headers_mut().insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        format!("wm-live.v1, {}", pass(PRINCIPAL)).parse().unwrap(),
    );
    let (mut socket, handshake) = tokio_tungstenite::connect_async(socket_request)
        .await
        .unwrap();
    assert_eq!(
        handshake.headers()[header::SEC_WEBSOCKET_PROTOCOL],
        "wm-live.v1"
    );
    let started: Value =
        serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(started["type"], "started");
    socket
        .send(Message::Text(
            json!({"type":"context","keywords":[MARKER]})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let mut audio = vec![0; 48_000];
    audio[..MARKER.len()].copy_from_slice(MARKER.as_bytes());
    socket.send(Message::Binary(audio.into())).await.unwrap();
    socket
        .send(Message::Text(r#"{"type":"end"}"#.into()))
        .await
        .unwrap();
    loop {
        let message = socket.next().await.unwrap().unwrap();
        if !message.is_text() {
            continue;
        }
        let value: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
        if value["type"] == "ended" || value["type"] == "failed" {
            assert_eq!(value["type"], "ended");
            assert_eq!(value["text"], MARKER);
            break;
        }
    }
    stop.cancel();
    public_task.await.unwrap();
    live_provider.await.unwrap();
    assert_eq!(
        seen.lock().unwrap()[0]["messages"][0]["content"][1]["source"]["data"],
        image_data
    );
    let provider_bodies = serde_json::to_string(&*seen.lock().unwrap()).unwrap();
    assert!(!provider_bodies.contains(picture_id));
    let live_bodies = serde_json::to_string(&*live_seen.lock().unwrap()).unwrap();
    assert!(provider_bodies.contains(MARKER));
    assert!(live_bodies.contains(MARKER));
    for private in [
        PRINCIPAL,
        CALLER,
        PROVIDER_KEY,
        FUNDING_KEY,
        OPERATOR_KEY,
        &pass(PRINCIPAL),
    ] {
        assert!(!provider_bodies.contains(private));
        assert!(!live_bodies.contains(private));
    }
    let dump = std::process::Command::new("pg_dump")
        .args(["--data-only", "--inserts", &database])
        .output()
        .unwrap();
    assert!(dump.status.success());
    let dump = String::from_utf8(dump.stdout).unwrap();
    assert!(dump.contains(PRINCIPAL));
    assert!(dump.contains(CALLER));
    for private in [
        MARKER,
        PROVIDER_KEY,
        FUNDING_KEY,
        OPERATOR_KEY,
        &pass(PRINCIPAL),
        &STANDARD.encode(MARKER),
        &image_data,
        picture_id,
    ] {
        assert!(!dump.contains(private), "database persisted content");
    }
    let mut orphan_retained = false;
    if probe_orphan {
        use ai_domain::{
            Admission, AdmissionOutcome, CallerId, ModelClass, Reservation, TextBudget, Tier,
        };
        let identity = ai_server::wire::identity(
            service
                .config
                .verifier
                .verify(Some(&pass(PRINCIPAL)), NOW)
                .unwrap(),
        );
        let route = service
            .policy
            .tiers
            .route(Tier::One, ModelClass::Small)
            .unwrap()
            .clone();
        let admitted = service
            .ledger
            .admit(
                Admission {
                    expected_route: route,
                    identity,
                    caller_id: CallerId::new("orphan_call_123456789012345".to_owned()).unwrap(),
                    label: "other".to_owned(),
                    requested: ModelClass::Small,
                    reservation: Reservation::Text(TextBudget {
                        input_tokens: 10,
                        max_tokens: 20,
                        min_tokens: Some(20),
                        cache: false,
                    }),
                },
                NOW,
            )
            .await
            .unwrap();
        let AdmissionOutcome::Admitted(orphan) = admitted else {
            panic!("expected new orphan")
        };
        service.ledger.dispatch(orphan.id, NOW).await.unwrap();
        let entry =
            service
                .results
                .create(orphan.id.to_string(), format!("account:{PRINCIPAL}"), false);
        let active = ai_server::ActiveCall::new(
            service.clone(),
            orphan.id,
            service.calls.clone().try_acquire_owned().unwrap(),
        );
        service
            .results
            .push(&entry, "text", json!({"delta":MARKER}), false);
        let producer = entry.producer();
        assert!(
            tokio::spawn(async move {
                let _producer = producer;
                let _active = active;
                std::panic::panic_any(MARKER.to_owned());
            })
            .await
            .is_err()
        );
        assert!(
            entry.next(0, entry.attach()).0.is_none(),
            "orphan content must be cleared before any recovery I/O"
        );
        assert!(
            service.results.get(&orphan.id.to_string()).is_none(),
            "orphan replay must end before database recovery"
        );
        service.ledger.sweep(&[], NOW + 1000).await.unwrap();
        let recovered = service.ledger.call(orphan.id).await.unwrap().unwrap();
        assert_eq!(recovered.state.as_str(), "assumed");
        service
            .results
            .prune_at(std::time::Instant::now() + Duration::from_secs(3600));
        orphan_retained = service.results.get(&orphan.id.to_string()).is_some();
        if orphan_retained {
            assert!(
                entry
                    .next(0, entry.attach())
                    .0
                    .unwrap()
                    .data
                    .contains(MARKER)
            );
        }
    }
    provider_task.abort();
    drop(router);
    drop(service);
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
    assert!(
        !orphan_retained,
        "recovered orphan retained content beyond linger"
    );
}
