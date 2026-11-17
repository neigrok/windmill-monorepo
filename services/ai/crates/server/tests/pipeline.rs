use ai_providers::{Anthropic, CarryKey, LiveAuth, LiveClient, LiveConfig, Secret};
use ai_server::{
    Service,
    config::Config,
    guards::{Rates, Refusals},
    internal_router,
    policy::Policy,
    public_router,
    results::Results,
};
use ai_storage::Ledger;
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    http::{Request, header},
    response::IntoResponse,
    routing::post,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::{Notify, Semaphore};
use tokio_tungstenite::tungstenite::{Message as SocketMessage, client::IntoClientRequest};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

fn pass(account: &str) -> String {
    let seed = URL_SAFE_NO_PAD
        .decode("nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A")
        .unwrap();
    let key = SigningKey::from_bytes(&seed.try_into().unwrap());
    let payload = json!({"aud":"ai","env":"development","iat":1800000000000i64,"exp":1800000600000i64,"sub":{"account":account},"plan":"one","ownerGrant":true,"client":"web"});
    let signed = format!(
        "wm-pass.v1.test-rfc8032.{}",
        URL_SAFE_NO_PAD.encode(payload.to_string())
    );
    format!(
        "{signed}.{}",
        URL_SAFE_NO_PAD.encode(key.sign(signed.as_bytes()).to_bytes())
    )
}

#[tokio::test]
async fn detached_text_replay_and_internal_secrets_on_real_ledger() {
    let source = std::env::var("AI_TEST_DATABASE_URL")
        .expect("AI_TEST_DATABASE_URL is required for server PostgreSQL tests");
    tokio::time::timeout(std::time::Duration::from_secs(60),async {
    let admin=sqlx::PgPool::connect(&source).await.unwrap();
    let database_name=format!("ai_server_{}",uuid::Uuid::new_v4().simple());
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE {database_name}"))).execute(&admin).await.unwrap();
    let mut database_url=url::Url::parse(&source).unwrap();database_url.set_path(&database_name);
    let database=database_url.to_string();
    let dispatches = Arc::new(AtomicUsize::new(0));
    let finish = Arc::new(Notify::new());
    let count_status = Arc::new(AtomicUsize::new(200));
    let provider=Router::new().route("/v1/messages/count_tokens",post({let count_status=count_status.clone();move||{let count_status=count_status.clone();async move{(axum::http::StatusCode::from_u16(count_status.load(Ordering::SeqCst) as u16).unwrap(),Json(json!({"input_tokens":10})))}}})).route("/v1/messages",post({let dispatches=dispatches.clone();let finish=finish.clone();move||{let dispatches=dispatches.clone();let finish=finish.clone();async move{
        dispatches.fetch_add(1,Ordering::SeqCst);finish.notified().await;
        let stream=concat!("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_test\",\"role\":\"assistant\",\"content\":[],\"usage\":{\"input_tokens\":10,\"output_tokens\":0,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":0}}}\n\n","event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n","event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n","event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n","event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n","event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
        ([(header::CONTENT_TYPE,"text/event-stream")],stream).into_response()
    }}}));
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = socket.local_addr().unwrap();
    let provider_task = tokio::spawn(async move {
        axum::serve(socket, provider).await.unwrap();
    });
    let live_socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let live_address = live_socket.local_addr().unwrap();
    let live_provider = tokio::spawn(async move {
        let (socket, _) = live_socket.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
        let config: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        socket
            .send(SocketMessage::Text(
                json!({"type":"session.updated","session":config["session"]})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let mut commits = 0;
        let mut bytes = 0;
        while commits < 2 {
            let message: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            match message["type"].as_str().unwrap() {
                "input_audio_buffer.append" => {
                    bytes += base64::engine::general_purpose::STANDARD
                        .decode(message["audio"].as_str().unwrap())
                        .unwrap()
                        .len();
                }
                "input_audio_buffer.commit" => {
                    commits += 1;
                }
                _ => panic!("unexpected provider message type"),
            }
        }
        assert_eq!(bytes, 96000);
        for event in [
            json!({"type":"input_audio_buffer.committed","item_id":"first","previous_item_id":null}),
            json!({"type":"input_audio_buffer.committed","item_id":"second","previous_item_id":"first"}),
            json!({"type":"conversation.item.input_audio_transcription.completed","item_id":"second","transcript":"Second"}),
            json!({"type":"conversation.item.input_audio_transcription.completed","item_id":"first","transcript":"First"}),
        ] {
            socket
                .send(SocketMessage::Text(event.to_string().into()))
                .await
                .unwrap();
        }
        while let Some(Ok(message)) = socket.next().await {
            if message.is_close() {
                break;
            }
        }
    });
    let variables = std::collections::HashMap::from([
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
            include_str!("../../../config/tiers.toml"),
            include_str!("../../../config/prices.toml"),
        )
        .unwrap(),
    );
    let ledger = Ledger::connect(&database, policy.tiers.clone(), policy.prices.clone())
        .await
        .unwrap();
    assert!(ledger.acquire_lock().await.unwrap());
    let adapter = Anthropic::new(
        &format!("http://{address}"),
        Secret::new("mock".to_owned()),
        CarryKey::new([42; 32]),
    )
    .unwrap();
    let service = Arc::new(Service {
        config,
        ledger,
        policy,
        text: Some(Arc::new(adapter)),
        live: Some(Arc::new(
            LiveClient::new(LiveConfig {
                url: format!("ws://{live_address}/v1/realtime?intent=transcription"),
                key: Secret::new("mock".to_owned()),
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
        clock: Arc::new(|| 1800000000000),
    });
    let router = public_router(service.clone());
    let internal = internal_router(service.clone());
    let account = format!("scenario-{}", uuid::Uuid::new_v4());
    let authorization = format!("Bearer {}", pass(&account));
    let id = uuid::Uuid::new_v4().simple().to_string();
    let request = json!({"model":"small","system":["private-marker"],"messages":[{"role":"user","parts":[{"text":"private-marker"}]}],"output":{"maxTokens":20},"cache":false});
    let response = router
        .clone()
        .oneshot(
            Request::put(format!("/v1/calls/{id}/text?label=coach"))
                .header(header::AUTHORIZATION, &authorization)
                .body(Body::from(request.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    drop(response);
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while dispatches.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let reads = Arc::new(AtomicUsize::new(0));
    let body_reads = reads.clone();
    let unread = Body::from_stream(futures_util::stream::poll_fn(move |_| {
        body_reads.fetch_add(1, Ordering::SeqCst);
        std::task::Poll::Ready(Some(Err::<axum::body::Bytes, std::io::Error>(
            std::io::ErrorKind::Other.into(),
        )))
    }));
    let response = router
        .clone()
        .oneshot(
            Request::put(format!("/v1/calls/{id}/text"))
                .header(header::AUTHORIZATION, &authorization)
                .body(unread)
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(reads.load(Ordering::SeqCst), 0);
    finish.notify_one();
    let events = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        to_bytes(response.into_body(), 65536),
    )
    .await
    .unwrap()
    .unwrap();
    let events = String::from_utf8(events.to_vec()).unwrap();
    assert!(events.contains("event: ended"), "{events}");
    assert!(events.contains("Hello"));
    assert_eq!(dispatches.load(Ordering::SeqCst), 1);
    let response = router
        .clone()
        .oneshot(
            Request::get(format!("/v1/calls/{id}"))
                .header(header::AUTHORIZATION, &authorization)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
    assert_eq!(status["state"], "settled");
    assert_eq!(status["charged"], "0.000015");
    let response = router
        .clone()
        .oneshot(
            Request::get(format!("/v1/calls/{id}"))
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", pass("unrelated-account")),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    let response = internal
        .clone()
        .oneshot(
            Request::get("/internal/v1/budgets")
                .header(header::AUTHORIZATION, format!("Bearer {}", "f".repeat(32)))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let response = router
        .clone()
        .oneshot(
            Request::get("/internal/v1/budgets")
                .header(header::AUTHORIZATION, format!("Bearer {}", "o".repeat(32)))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    count_status.store(401, Ordering::SeqCst);
    let response = router
        .clone()
        .oneshot(
            Request::put(format!("/v1/calls/{}/text", uuid::Uuid::new_v4().simple()))
                .header(header::AUTHORIZATION, &authorization)
                .body(Body::from(request.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 503);
    let failure: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
    assert_eq!(failure["code"], "provider_unavailable");
    assert_eq!(dispatches.load(Ordering::SeqCst), 1);
    let public_socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let public_address = public_socket.local_addr().unwrap();
    let public_stop = CancellationToken::new();
    let public_task = tokio::spawn(ai_server::listeners::serve(
        public_socket,
        public_router(service.clone()),
        public_stop.clone(),
    ));
    let live_id = uuid::Uuid::new_v4().simple().to_string();
    let mut socket_request = format!("ws://{public_address}/v1/calls/{live_id}/transcription")
        .into_client_request()
        .unwrap();
    socket_request
        .headers_mut()
        .insert(header::AUTHORIZATION, authorization.parse().unwrap());
    socket_request.headers_mut().insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        "wm-live.v1".parse().unwrap(),
    );
    let (mut socket, handshake) = tokio_tungstenite::connect_async(socket_request.clone())
        .await
        .unwrap();
    assert_eq!(
        handshake.headers()[header::SEC_WEBSOCKET_PROTOCOL],
        "wm-live.v1"
    );
    let started: Value =
        serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(started["type"], "started");
    for _ in 0..2 {
        socket
            .send(SocketMessage::Binary(vec![0; 48000].into()))
            .await
            .unwrap();
        socket
            .send(SocketMessage::Text(r#"{"type":"commit"}"#.into()))
            .await
            .unwrap();
    }
    socket
        .send(SocketMessage::Text(r#"{"type":"end"}"#.into()))
        .await
        .unwrap();
    let last = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let message = socket.next().await.unwrap().unwrap();
            if !message.is_text() {
                continue;
            }
            let value: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
            if value["type"] == "ended" || value["type"] == "failed" {
                break value;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(last["type"], "ended");
    assert_eq!(last["stop"], "completed");
    assert_eq!(last["text"], "First Second");
    assert_eq!(last["seconds"], 2);
    assert_eq!(last["charged"], "0.000566667");
    let response = router
        .clone()
        .oneshot(
            Request::get(format!("/v1/calls/{live_id}/result"))
                .header(header::AUTHORIZATION, &authorization)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&to_bytes(response.into_body(), 65536).await.unwrap())
            .unwrap(),
        last
    );
    let (mut duplicate, _) = tokio_tungstenite::connect_async(socket_request)
        .await
        .unwrap();
    let failure: Value =
        serde_json::from_str(duplicate.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(failure["code"], "conflict");
    public_stop.cancel();
    public_task.await.unwrap();
    live_provider.await.unwrap();
    provider_task.abort();
    drop(router);drop(internal);drop(service);
    sqlx::query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1").bind(&database_name).execute(&admin).await.unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!("DROP DATABASE {database_name}"))).execute(&admin).await.unwrap();
    admin.close().await;
    }).await.expect("server pipeline exceeded60seconds");
}
