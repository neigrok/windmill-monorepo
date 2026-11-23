use ai_domain::*;
use ai_providers::{Anthropic, CarryKey, LiveAuth, LiveClient, LiveConfig, Secret, TextRequest};
use ai_server::{
    Service,
    config::Config,
    guards::{Rates, Refusals},
    internal_router,
    policy::Policy,
    public_router, refusal,
    results::Results,
    wire,
};
use ai_storage::Ledger;
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
    response::IntoResponse,
    routing::post,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Semaphore;
use tokio_tungstenite::tungstenite::{Message as SocketMessage, client::IntoClientRequest};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

fn fixtures() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../packages/api-contract/ai/wire/fixtures.json"
    ))
    .unwrap()
}

fn usd(value: &str) -> NanoUsd {
    NanoUsd::from_usd(value).unwrap()
}

fn free_allowance() -> Allowance {
    Allowance {
        tier: Tier::Free,
        period: AllowancePeriod::CalendarMonthUtc,
        limit: usd("0.5"),
        used: usd("0.01"),
        reserved: usd("0.02"),
        remaining: usd("0.47"),
        resets_at: Some(1801440000000),
        budget_resets_at: None,
        code: StaticCode::Ok,
        text: [ModelClass::Large, ModelClass::Medium, ModelClass::Small],
        transcription: false,
    }
}

fn sample_call() -> Call {
    Call {
        id: 41,
        principal: Principal::Account("account-vector".to_owned()),
        caller_id: CallerId::new("abcdefghijklmnopqrstuv".to_owned()).unwrap(),
        capability: Capability::Text,
        tier: Tier::Free,
        requested: ModelClass::Small,
        route: ModelRoute {
            provider: Provider::Anthropic,
            model: "claude-haiku-4-5".to_owned(),
            served: ModelClass::Small,
        },
        price_version: "2026-11-15".to_owned(),
        label: "other".to_owned(),
        client: Client::Web,
        state: CallState::Settled,
        reservation: usd("0.002"),
        charged: Some(usd("0.0002325")),
        original_charge: None,
        max_tokens: Some(100),
        usage: Some(TokenUsage {
            input: 10,
            output: 20,
            cache_write: 30,
            cache_write_1h: 40,
            cache_read: 50,
        }),
        audio_bytes: 0,
        audio_seconds: 0,
        turns: 0,
        slices: 0,
        provider_request_id: Some("req_vector".to_owned()),
        stop: Some(Stop::Completed),
        code: None,
        created_at: 1800000000000,
        ended_at: Some(1800000001000),
    }
}

fn sample_budgets() -> Vec<Budget> {
    vec![
        Budget {
            id: 1,
            kind: "account_month".to_owned(),
            period: Some(Period::new(1798761600000, 1801440000000).unwrap()),
            limit: usd("0.5"),
            spent: usd("0.01"),
            held: usd("0.02"),
        },
        Budget {
            id: 2,
            kind: "grant".to_owned(),
            period: Some(Period::new(1800000000000, 1802592000000).unwrap()),
            limit: usd("7"),
            spent: usd("0.1"),
            held: usd("0.2"),
        },
    ]
}

fn sample_grants() -> Vec<Grant> {
    vec![Grant {
        id: 2,
        reference: "period-vector".to_owned(),
        account_id: "account-vector".to_owned(),
        source: GrantSource::Subscription,
        period: Period::new(1800000000000, 1802592000000).unwrap(),
        closed_at: None,
        amount: usd("7"),
        spent: usd("0.1"),
        held: usd("0.2"),
    }]
}

#[tokio::test]
async fn every_refusal_status_and_whole_body_matches_shared_contract() {
    let fixture = fixtures();
    for case in fixture["refusals"].as_array().unwrap() {
        let code: &'static str = Box::leak(
            case["body"]["code"]
                .as_str()
                .unwrap()
                .to_owned()
                .into_boxed_str(),
        );
        let response = refusal(
            code,
            (!case["body"]["allowance"].is_null()).then(|| wire::allowance(&free_allowance())),
        );
        assert_eq!(
            response.status().as_u16(),
            case["status"].as_u64().unwrap() as u16
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&to_bytes(response.into_body(), 65536).await.unwrap())
                .unwrap(),
            case["body"]
        );
    }
}

#[test]

fn every_tier_grace_period_and_exhaustion_serializes_the_whole_allowance() {
    let fixture = fixtures();
    let free = free_allowance();
    let empty = Allowance {
        used: usd("0"),
        reserved: usd("0"),
        remaining: usd("0.5"),
        ..free.clone()
    };
    let one = Allowance {
        tier: Tier::One,
        period: AllowancePeriod::BillingPeriod,
        limit: usd("7"),
        used: usd("0.1"),
        reserved: usd("0.2"),
        remaining: usd("6.7"),
        resets_at: Some(1802592000000),
        transcription: true,
        ..free.clone()
    };
    let cases = [
        (
            "anonymous",
            Allowance {
                tier: Tier::Anonymous,
                period: AllowancePeriod::Lifetime,
                limit: usd("0.25"),
                remaining: usd("0.25"),
                resets_at: None,
                text: [ModelClass::Medium, ModelClass::Medium, ModelClass::Small],
                ..empty.clone()
            },
        ),
        ("free", free),
        ("one_subscription", one.clone()),
        (
            "one_owner",
            Allowance {
                period: AllowancePeriod::CalendarMonthUtc,
                used: usd("0"),
                reserved: usd("0"),
                remaining: usd("7"),
                resets_at: Some(1801440000000),
                ..one
            },
        ),
        ("one_without_grant", empty.clone()),
        (
            "subject_exhausted",
            Allowance {
                used: usd("0.5"),
                remaining: usd("0"),
                code: StaticCode::SubjectExhausted,
                budget_resets_at: Some(1801440000000),
                ..empty.clone()
            },
        ),
        (
            "free_month_exhausted",
            Allowance {
                code: StaticCode::FreeMonthExhausted,
                budget_resets_at: Some(1801440000000),
                ..empty.clone()
            },
        ),
        (
            "free_day_exhausted",
            Allowance {
                code: StaticCode::FreeDayExhausted,
                budget_resets_at: Some(1800057600000),
                ..empty.clone()
            },
        ),
        (
            "concurrency_exhausted",
            Allowance {
                reserved: usd("0.002"),
                remaining: usd("0.498"),
                code: StaticCode::ConcurrencyExhausted,
                ..empty
            },
        ),
    ];
    for (name, value) in cases {
        assert_eq!(
            wire::allowance(&value),
            fixture["allowances"][name],
            "{name}"
        );
    }
}

#[test]

fn request_parsers_accept_complete_contract_and_reject_unknown_fields() {
    let fixture = fixtures();
    let parsed = TextRequest::parse(&serde_json::to_vec(&fixture["textRequest"]).unwrap()).unwrap();
    assert_eq!(
        serde_json::to_value(parsed).unwrap(),
        fixture["textRequest"]
    );
    for key in ["temperature", "modelId", "toolChoice"] {
        let mut invalid = fixture["textRequest"].clone();
        invalid[key] = json!("forbidden");
        assert!(TextRequest::parse(&serde_json::to_vec(&invalid).unwrap()).is_err());
    }
    for (said, strict) in [(None, true), (Some(false), false), (Some(true), true)] {
        let mut request = fixture["textRequest"].clone();
        let tool = request["tools"][0].as_object_mut().unwrap();
        tool.remove("strict");
        if let Some(said) = said {
            tool.insert("strict".into(), json!(said));
        }
        let parsed = TextRequest::parse(&serde_json::to_vec(&request).unwrap()).unwrap();
        assert_eq!(parsed.tools[0].strict, strict);
    }
    let request: wire::FundRequest =
        serde_json::from_value(fixture["internalRequests"]["fund"].clone()).unwrap();
    assert_eq!(
        json!({ "accountId":request.account_id,"plan":request.plan,"period":{ "start":request.period.start,"end":request.period.end } } ),
        fixture["internalRequests"]["fund"]
    );
    let close: wire::CloseRequest =
        serde_json::from_value(fixture["internalRequests"]["close"].clone()).unwrap();
    assert_eq!(
        json!({ "closedAt":close.closed_at } ),
        fixture["internalRequests"]["close"]
    );
    let correct: wire::CorrectRequest =
        serde_json::from_value(fixture["internalRequests"]["correct"].clone()).unwrap();
    assert_eq!(
        json!({ "charged":correct.charged } ),
        fixture["internalRequests"]["correct"]
    );
    assert!(serde_json::from_value::<wire::CorrectRequest>(json!({ "charged":0.001 } )).is_err());
    assert!(
        serde_json::from_value::<wire::CloseRequest>(json!({ "closedAt":1,"unknown":true } ))
            .is_err()
    );
}

#[test]

fn every_call_state_and_operator_metadata_matches_the_complete_contract() {
    let fixture = fixtures();
    for (index, state, charge, end) in [
        (0, CallState::Reserved, None, None),
        (1, CallState::Dispatched, None, None),
        (
            2,
            CallState::Settled,
            Some(usd("0.001")),
            Some(1800000001000),
        ),
        (
            3,
            CallState::Unconsumed,
            Some(usd("0")),
            Some(1800000001000),
        ),
        (
            4,
            CallState::Assumed,
            Some(usd("0.002")),
            Some(1800000001000),
        ),
    ] {
        let call = Call {
            state,
            charged: charge,
            ended_at: end,
            stop: None,
            code: None,
            ..sample_call()
        };
        assert_eq!(wire::status(&call), fixture["calls"][index]);
    }
    assert_eq!(
        wire::call(&sample_call()),
        fixture["internalCalls"]["settled"]
    );
    let corrected = Call {
        state: CallState::Assumed,
        charged: Some(usd("0.001")),
        original_charge: Some(usd("0.002")),
        usage: None,
        stop: None,
        code: Some(StaticCode::ProviderFailed),
        ..sample_call()
    };
    assert_eq!(
        wire::call(&corrected),
        fixture["internalCalls"]["corrected"]
    );
    let live = Call {
        id: 42,
        capability: Capability::Transcription,
        tier: Tier::One,
        route: ModelRoute {
            provider: Provider::OpenAi,
            model: "gpt-live-transcribe".to_owned(),
            served: ModelClass::Small,
        },
        reservation: usd("0.017"),
        charged: Some(usd("0.000283334")),
        max_tokens: None,
        usage: None,
        audio_bytes: 48000,
        audio_seconds: 1,
        turns: 1,
        slices: 1,
        ..sample_call()
    };
    assert_eq!(wire::call(&live), fixture["internalCalls"]["transcription"]);
    let principal = PrincipalLedger {
        budgets: sample_budgets(),
        grants: sample_grants(),
        installations: vec!["installation-vector".to_owned()],
        calls: vec![sample_call()],
    };
    assert_eq!(wire::principal(principal), fixture["internalPrincipal"]);
    let shared = SharedLedger {
        budgets: vec![Budget {
            id: 3,
            kind: "free_month".to_owned(),
            limit: usd("100"),
            spent: usd("50"),
            held: usd("1"),
            ..sample_budgets().remove(0)
        }],
        fuses: vec![
            ProviderFuse {
                provider: Provider::Anthropic,
                spent: usd("20.000000001"),
                limit: usd("20"),
                paused: true,
            },
            ProviderFuse {
                provider: Provider::OpenAi,
                spent: usd("0"),
                limit: usd("20"),
                paused: false,
            },
            ProviderFuse {
                provider: Provider::Azure,
                spent: usd("0"),
                limit: usd("20"),
                paused: false,
            },
        ],
    };
    assert_eq!(wire::shared(shared), fixture["shared"]);
}

fn signed_pass(principal: &str, plan: &str, owner: bool) -> String {
    let key = SigningKey::from_bytes(
        &URL_SAFE_NO_PAD
            .decode("nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A")
            .unwrap()
            .try_into()
            .unwrap(),
    );
    let mut payload = json!({ "aud":"ai","env":"development","iat":1800000000000i64,"exp":1800000600000i64,"sub":{ "account":principal } ,"plan":plan,"client":"web" } );
    if owner {
        payload["ownerGrant"] = json!(true);
    }
    let signed = format!(
        "wm-pass.v1.test-rfc8032.{}",
        URL_SAFE_NO_PAD.encode(payload.to_string())
    );
    format!(
        "{signed}.{}",
        URL_SAFE_NO_PAD.encode(key.sign(signed.as_bytes()).to_bytes())
    )
}

struct TestService {
    service: Arc<Service>,
    admin: sqlx::PgPool,
    database: String,
    pool: sqlx::PgPool,
}

impl TestService {
    async fn new(provider_url: Option<&str>, live_url: Option<&str>) -> Option<Self> {
        let Ok(source) = std::env::var("AI_TEST_DATABASE_URL") else {
            assert!(
                std::env::var("CI").is_err(),
                "AI_TEST_DATABASE_URL required in CI"
            );
            return None;
        };
        let admin = sqlx::PgPool::connect(&source).await.unwrap();
        let database = format!("ai_wire_{}", uuid::Uuid::new_v4().simple());
        sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE {database}")))
            .execute(&admin)
            .await
            .unwrap();
        let mut url = url::Url::parse(&source).unwrap();
        url.set_path(&database);
        let variables = HashMap::from([
            ("AI_ENVIRONMENT", "development".to_owned()),
            ("AI_DATABASE_URL", url.to_string()),
            (
                "AI_PASS_KEYS",
                r#"{"test-rfc8032":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"}"#.to_owned(),
            ),
            ("AI_CARRY_KEY", URL_SAFE_NO_PAD.encode([42; 32])),
            ("AI_FUNDING_SECRET", "f".repeat(32)),
            ("AI_OPERATOR_SECRET", "o".repeat(32)),
        ]);
        let config = Arc::new(Config::from_environment(|key| variables.get(key).cloned()).unwrap());
        let policy = Arc::new(
            Policy::parse(
                include_str!("../../../config/tiers.toml"),
                include_str!("../../../config/prices.toml"),
            )
            .unwrap(),
        );
        let ledger = Ledger::connect(url.as_ref(), policy.tiers.clone(), policy.prices.clone())
            .await
            .unwrap();
        assert!(ledger.acquire_lock().await.unwrap());
        let service = Arc::new(Service {
            config,
            ledger,
            policy,
            text: provider_url.map(|url| {
                Arc::new(
                    Anthropic::new(url, Secret::new("mock".to_owned()), CarryKey::new([42; 32]))
                        .unwrap(),
                )
            }),
            live: live_url.map(|url| {
                Arc::new(
                    LiveClient::new(LiveConfig {
                        url: url.to_owned(),
                        key: Secret::new("mock".to_owned()),
                        auth: LiveAuth::Bearer,
                        model: "gpt-live-transcribe".to_owned(),
                        delay: "low".to_owned(),
                    })
                    .unwrap(),
                )
            }),
            results: Results::default(),
            pictures: ai_server::pictures::Pictures::default(),
            rates: Rates::default(),
            refusals: Refusals::default(),
            provider_health: Default::default(),
            calls: Arc::new(Semaphore::new(256)),
            sessions: Arc::new(Semaphore::new(64)),
            active: Mutex::new(HashSet::new()),
            drain: CancellationToken::new(),
            lifecycle: tokio::sync::Mutex::new(()),
            clock: Arc::new(|| 1800000000000),
        });
        let pool = sqlx::PgPool::connect(url.as_ref()).await.unwrap();
        Some(Self {
            service,
            admin,
            database,
            pool,
        })
    }
    async fn internal(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        funding: bool,
    ) -> (u16, Value) {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(
                header::AUTHORIZATION,
                format!(
                    "Bearer {}",
                    if funding {
                        "f".repeat(32)
                    } else {
                        "o".repeat(32)
                    }
                ),
            )
            .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
            .unwrap();
        let response = internal_router(self.service.clone())
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "no-store, no-transform"
        );
        let status = response.status().as_u16();
        let value = serde_json::from_slice(
            &to_bytes(response.into_body(), 2 * 1024 * 1024)
                .await
                .unwrap(),
        )
        .unwrap();
        (status, value)
    }
    async fn finish(self) {
        self.service.drain.cancel();
        self.pool.close().await;
        drop(self.service);
        sqlx::query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1")
            .bind(&self.database)
            .execute(&self.admin)
            .await
            .unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DROP DATABASE {}",
            self.database
        )))
        .execute(&self.admin)
        .await
        .unwrap();
        self.admin.close().await;
    }
}

#[tokio::test]
async fn funding_and_correction_http_responses_match_shared_contract() {
    let Some(test) = TestService::new(None, None).await else {
        return;
    };
    let fixture = fixtures();
    let fund = &fixture["internalRequests"]["fund"];
    for (path, index) in [
        ("/internal/v1/grants/period-vector", 0),
        ("/internal/v1/grants/period-vector", 1),
        ("/internal/v1/grants/overlap", 2),
    ] {
        assert_eq!(
            test.internal("PUT", path, Some(fund), true).await,
            (200, fixture["grantOutcomes"][index].clone())
        );
    }
    for suffix in ["close", "reopen"] {
        assert_eq!(
            test.internal(
                "POST",
                &format!("/internal/v1/grants/unknown/{suffix}"),
                (suffix == "close").then_some(&fixture["internalRequests"]["close"]),
                true
            )
            .await,
            (200, fixture["grantOutcomes"][3].clone())
        );
    }
    assert_eq!(
        test.internal(
            "POST",
            "/internal/v1/grants/period-vector/close",
            Some(&fixture["internalRequests"]["close"]),
            true
        )
        .await,
        (200, fixture["grantOutcomes"][0].clone())
    );
    let mut replacement = fund.clone();
    replacement["period"]["start"] = fixture["internalRequests"]["close"]["closedAt"].clone();
    assert_eq!(
        test.internal(
            "PUT",
            "/internal/v1/grants/replacement",
            Some(&replacement),
            true
        )
        .await,
        (200, fixture["grantOutcomes"][0].clone())
    );
    assert_eq!(
        test.internal(
            "POST",
            "/internal/v1/grants/period-vector/reopen",
            None,
            true
        )
        .await,
        (200, fixture["grantOutcomes"][2].clone())
    );
    assert_eq!(
        test.internal(
            "POST",
            "/internal/v1/grants/replacement/close",
            Some(&fixture["internalRequests"]["close"]),
            true
        )
        .await,
        (200, fixture["grantOutcomes"][0].clone())
    );
    assert_eq!(
        test.internal(
            "POST",
            "/internal/v1/grants/period-vector/reopen",
            None,
            true
        )
        .await,
        (200, fixture["grantOutcomes"][0].clone())
    );
    let identity = Identity {
        principal: Principal::Account("account-vector".to_owned()),
        plan: Plan::None,
        owner_grant: false,
        installation: None,
        client: Client::Web,
    };
    let outcome = test
        .service
        .ledger
        .admit(
            Admission {
                identity,
                caller_id: CallerId::new("abcdefghijklmnopqrstuv".to_owned()).unwrap(),
                label: "other".to_owned(),
                requested: ModelClass::Small,
                expected_route: test
                    .service
                    .policy
                    .tiers
                    .route(Tier::Free, ModelClass::Small)
                    .unwrap(),
                reservation: Reservation::Text(TextBudget {
                    input_tokens: 10,
                    max_tokens: 100,
                    min_tokens: None,
                    cache: false,
                }),
            },
            1800000000000,
        )
        .await
        .unwrap();
    let call = match outcome {
        AdmissionOutcome::Admitted(call) => call,
        AdmissionOutcome::Existing(_) => panic!("new call required"),
    };
    test.service
        .ledger
        .dispatch(call.id, 1800000000000)
        .await
        .unwrap();
    test.service
        .ledger
        .settle(
            call.id,
            Settlement {
                charge: Charge::Assumed,
                stop: None,
                code: Some(StaticCode::ProviderFailed),
                provider_request_id: None,
            },
            1800000001000,
        )
        .await
        .unwrap();
    for name in ["corrected", "replayed"] {
        assert_eq!(
            test.internal(
                "POST",
                &format!("/internal/v1/calls/{}/correct", call.id),
                Some(&fixture["internalRequests"]["correct"]),
                false
            )
            .await,
            (200, fixture["corrections"][name].clone())
        );
    }
    let mut expected = fixture["internalCalls"]["corrected"].clone();
    expected["id"] = json!(call.id);
    expected["reservation"] = json!("0.000575");
    expected["originalCharge"] = json!("0.000575");
    expected["providerRequestId"] = Value::Null;
    assert_eq!(
        test.internal(
            "GET",
            &format!("/internal/v1/calls/{}", call.id),
            None,
            false
        )
        .await,
        (200, expected)
    );
    test.finish().await;
}

#[tokio::test]
async fn internal_metadata_and_thousand_row_cursors_match_complete_http_contract() {
    let Some(test) = TestService::new(None, None).await else {
        return;
    };
    let fixture = fixtures();
    sqlx::query("INSERT INTO ai_budgets(id,budget_key,kind,principal_kind,principal_id,period_start,period_end,limit_nanos,spent,held) VALUES(1,'account','account_month','account','account-vector',1798761600000,1801440000000,500000000,10000000,20000000),(2,'grant','grant','account','account-vector',1800000000000,1802592000000,7000000000,100000000,200000000),(3,'shared','free_month',NULL,NULL,1798761600000,1801440000000,100000000000,50000000000,1000000000)").execute(&test.pool).await.unwrap();
    sqlx::query("INSERT INTO ai_grants(id,reference,account_id,source,plan,period_start,period_end,budget_id) VALUES(2,'period-vector','account-vector','subscription','one',1800000000000,1802592000000,2)").execute(&test.pool).await.unwrap();
    sqlx::query("INSERT INTO ai_bindings(installation_id,account_id,bound_at) VALUES('installation-vector','account-vector',1800000000000)").execute(&test.pool).await.unwrap();
    sqlx::query("INSERT INTO ai_calls(id,principal_kind,principal_id,caller_id,capability,tier,requested,provider,model,served,price_version,label,client,state,reservation,applied,held,charged,max_tokens,input_tokens,output_tokens,cache_write_tokens,cache_write_1h_tokens,cache_read_tokens,provider_request_id,stop,month_start,instance,created_at,ended_at) SELECT id,'account','account-vector',CASE WHEN id=41 THEN 'abcdefghijklmnopqrstuv' ELSE lpad(id::text,22,'0') END,'text','free','small','anthropic','claude-haiku-4-5','small','2026-11-15','other','web','settled',2000000,232500,0,232500,100,10,20,30,40,50,'req_vector','completed',1798761600000,'fixture',1800000000000,1800000001000 FROM generate_series(1,1001) id").execute(&test.pool).await.unwrap();
    sqlx::query("INSERT INTO ai_spend_events(provider,at,delta) VALUES('anthropic',1800000000000,20000000001)").execute(&test.pool).await.unwrap();
    assert_eq!(
        test.internal("GET", "/internal/v1/calls/41", None, false)
            .await,
        (200, fixture["internalCalls"]["settled"].clone())
    );
    assert_eq!(
        test.internal("GET", "/internal/v1/budgets", None, false)
            .await,
        (200, fixture["shared"].clone())
    );
    let expected_calls = (2..=1001)
        .rev()
        .map(|id| {
            let mut value = fixture["internalCalls"]["settled"].clone();
            value["id"] = json!(id);
            if id != 41 {
                value["callId"] = json!(format!("{id:022}"));
            }
            value
        })
        .collect::<Vec<_>>();
    let page = json!({ "calls":expected_calls,"nextBeforeId":2 } );
    assert_eq!(
        test.internal(
            "GET",
            "/internal/v1/calls?state=settled&since=1800000001000",
            None,
            false
        )
        .await,
        (200, page.clone())
    );
    let mut principal = fixture["internalPrincipal"].clone();
    principal["calls"] = page["calls"].clone();
    principal["nextBeforeId"] = json!(2);
    assert_eq!(
        test.internal(
            "GET",
            "/internal/v1/principals/account/account-vector",
            None,
            false
        )
        .await,
        (200, principal.clone())
    );
    let mut last = fixture["internalCalls"]["settled"].clone();
    last["id"] = json!(1);
    last["callId"] = json!("0000000000000000000001");
    assert_eq!(
        test.internal("GET", "/internal/v1/calls?before=2", None, false)
            .await,
        (200, json!({ "calls":[last.clone()],"nextBeforeId":null } ))
    );
    principal["calls"] = json!([last]);
    principal["nextBeforeId"] = Value::Null;
    assert_eq!(
        test.internal(
            "GET",
            "/internal/v1/principals/account/account-vector?before=2",
            None,
            false
        )
        .await,
        (200, principal)
    );
    assert_eq!(
        test.internal("GET", "/internal/v1/calls?before=1", None, false)
            .await,
        (200, fixture["internalPages"]["empty"].clone())
    );
    for endpoint in [
        "/internal/v1/calls",
        "/internal/v1/principals/account/account-vector",
    ] {
        for cursor in ["0", "-1", "not-a-number"] {
            assert_eq!(
                test.internal("GET", &format!("{endpoint}?before={cursor}"), None, false)
                    .await,
                (400, json!({ "code":"invalid_request","allowance":null } ))
            );
        }
    }
    test.finish().await;
}

fn provider_stream(mode: &str) -> String {
    let mut stream = String::new();
    let mut event = |name: &str, data: Value| {
        stream.push_str(&format!("event: {name}\ndata: {data}\n\n"));
    };
    event(
        "message_start",
        json!({ "type":"message_start","message":{ "id":"msg_wire","role":"assistant","content":[],"usage":{ "input_tokens":10,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0 } } } ),
    );
    if mode == "tool_calls" {
        event(
            "content_block_start",
            json!({ "type":"content_block_start","index":0,"content_block":{ "type":"tool_use","id":"tool-1","name":"read","input":{ } } } ),
        );
        event(
            "content_block_delta",
            json!({ "type":"content_block_delta","index":0,"delta":{ "type":"input_json_delta","partial_json":"{}" } } ),
        );
    } else {
        event(
            "content_block_start",
            json!({ "type":"content_block_start","index":0,"content_block":{ "type":"text","text":"" } } ),
        );
        event(
            "content_block_delta",
            json!({ "type":"content_block_delta","index":0,"delta":{ "type":"text_delta","text":"Hello" } } ),
        );
    }
    if mode == "provider_failed" {
        return stream;
    }
    event(
        "content_block_stop",
        json!({ "type":"content_block_stop","index":0 } ),
    );
    let stop = match mode {
        "tool_calls" => "tool_use",
        "truncated" => "max_tokens",
        "declined" => "refusal",
        _ => "end_turn",
    };
    event(
        "message_delta",
        json!({ "type":"message_delta","delta":{ "stop_reason":stop } ,"usage":{ "output_tokens":1 } } ),
    );
    event("message_stop", json!({ "type":"message_stop" } ));
    stream
}

fn text_events(bytes: &[u8]) -> Vec<Value> {
    let text = std::str::from_utf8(bytes).unwrap();
    let mut result = Vec::new();
    for block in text.split("\n\n") {
        let name = block.lines().find_map(|line| line.strip_prefix("event: "));
        let data = block.lines().find_map(|line| line.strip_prefix("data: "));
        if let (Some(name), Some(data)) = (name, data) {
            let id = block
                .lines()
                .find_map(|line| line.strip_prefix("id: "))
                .unwrap()
                .parse::<usize>()
                .unwrap();
            assert_eq!(id, result.len() + 1);
            result
                .push(json!({ "event":name,"data":serde_json::from_str::<Value>(data).unwrap() } ));
        }
    }
    result
}

fn normalize_carry(event: &mut Value) {
    if let Some(carry) = event["data"]["message"]["carry"].as_str() {
        let bytes = URL_SAFE_NO_PAD
            .decode(carry.strip_prefix("wm-carry.v1.").unwrap())
            .unwrap();
        assert!(bytes.len() > 40);
        event["data"]["message"]["carry"] = json!("wm-carry.v1.<opaque>");
    }
}

#[tokio::test]
async fn complete_text_streams_match_every_stop_and_provider_failure_fixture() {
    let scenario = async {
        let mode = Arc::new(Mutex::new("completed".to_owned()));
        let provider = Router::new()
            .route(
                "/v1/messages/count_tokens",
                post(|| async { Json(json!({ "input_tokens":10 } )) }),
            )
            .route(
                "/v1/messages",
                post({
                    let mode = mode.clone();
                    move || {
                        let mode = mode.lock().unwrap().clone();
                        async move {
                            match mode.as_str() {
                                "provider_rejected" => (
                                    StatusCode::BAD_REQUEST,
                                    Json(json!({ "error":{ "type":"invalid_request_error" } } )),
                                )
                                    .into_response(),
                                "provider_unavailable" => (
                                    StatusCode::SERVICE_UNAVAILABLE,
                                    Json(json!({ "error":{ "type":"overloaded_error" } } )),
                                )
                                    .into_response(),
                                _ => (
                                    [(header::CONTENT_TYPE, "text/event-stream")],
                                    provider_stream(&mode),
                                )
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
        let Some(test) = TestService::new(Some(&format!("http://{address}")), None).await else {
            provider_task.abort();
            return;
        };
        let fixture = fixtures();
        for mode_name in [
            "completed",
            "tool_calls",
            "truncated",
            "declined",
            "provider_rejected",
            "provider_unavailable",
            "provider_failed",
            "null_charged",
        ] {
            *mode.lock().unwrap() = mode_name.to_owned();
            if mode_name == "null_charged" {
                sqlx::query("CREATE FUNCTION reject_wire_settlement() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''fixture settlement failure''; END'").execute(&test.pool).await.unwrap();
                sqlx::query("CREATE TRIGGER reject_wire_settlement BEFORE UPDATE ON ai_calls FOR EACH ROW WHEN (NEW.state = 'settled') EXECUTE FUNCTION reject_wire_settlement()").execute(&test.pool).await.unwrap();
            }
            let body = json!({ "model":"small","tools":[{ "name":"read","description":"Read the current item.","input":{ "type":"object","properties":{ } } } ],"messages":[{ "role":"user","parts":[{ "text":"Hello" } ] } ],"output":{ "maxTokens":100 } ,"cache":false } );
            let request = Request::put("/v1/calls/abcdefghijklmnopqrstuv/text")
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", signed_pass(mode_name, "one", true)),
                )
                .body(Body::from(body.to_string()))
                .unwrap();
            let response = public_router(test.service.clone())
                .oneshot(request)
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "no-store, no-transform"
            );
            let mut actual = text_events(&to_bytes(response.into_body(), 65536).await.unwrap());
            for event in &mut actual {
                normalize_carry(event);
            }
            let mut expected = vec![fixture["textEvents"][0].clone()];
            if mode_name == "tool_calls" {
                expected.push(fixture["textEvents"][2].clone());
            } else if !["provider_rejected", "provider_unavailable"].contains(&mode_name) {
                expected.push(fixture["textEvents"][1].clone());
            }
            expected.push(fixture["textTerminals"][mode_name].clone());
            assert_eq!(actual, expected, "{mode_name}");
            if mode_name == "null_charged" {
                sqlx::query("DROP TRIGGER reject_wire_settlement ON ai_calls")
                    .execute(&test.pool)
                    .await
                    .unwrap();
                sqlx::query("DROP FUNCTION reject_wire_settlement()")
                    .execute(&test.pool)
                    .await
                    .unwrap();
                tokio::time::timeout(Duration::from_secs(5), async {
                    loop {
                        if test.service.active.lock().unwrap().is_empty() {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                })
                .await
                .unwrap();
            }
        }
        test.finish().await;
        provider_task.abort();
    };
    tokio::time::timeout(Duration::from_secs(90), scenario)
        .await
        .unwrap();
}

#[tokio::test]
async fn live_first_refusals_match_uncharged_websocket_contract() {
    let scenario = async {
        let Some(test) = TestService::new(None, None).await else {
            return;
        };
        let fixture = fixtures();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = public_router(test.service.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        for (code, owner) in [
            ("funding_required", false),
            ("provider_unavailable", true),
            ("accounting_unavailable", false),
        ] {
            if code == "accounting_unavailable" {
                sqlx::query("SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())").execute(&test.pool).await.unwrap();
                assert!(!test.service.ledger.lock_alive().await);
            }
            let mut request =
                format!("ws://{address}/v1/calls/abcdefghijklmnopqrstuv/transcription")
                    .into_client_request()
                    .unwrap();
            request.headers_mut().insert(
                header::AUTHORIZATION,
                format!("Bearer {}", signed_pass(code, "one", owner))
                    .parse()
                    .unwrap(),
            );
            request.headers_mut().insert(
                header::SEC_WEBSOCKET_PROTOCOL,
                "wm-live.v1".parse().unwrap(),
            );
            let (mut socket, response) = tokio_tungstenite::connect_async(request).await.unwrap();
            assert_eq!(
                response.headers()[header::SEC_WEBSOCKET_PROTOCOL],
                "wm-live.v1"
            );
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "no-store, no-transform"
            );
            let message = socket.next().await.unwrap().unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(message.to_text().unwrap()).unwrap(),
                fixture["liveFirstFailures"][code]
            );
        }
        server.abort();
        test.finish().await;
    };
    tokio::time::timeout(Duration::from_secs(30), scenario)
        .await
        .unwrap();
}

#[tokio::test]
async fn live_context_commit_end_disconnect_and_restart_match_complete_contract() {
    let scenario = async {
        let provider = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let provider_address = provider.local_addr().unwrap();
        let provider_task = tokio::spawn(async move {
            loop {
                let (socket, _) = provider.accept().await.unwrap();
                tokio::spawn(async move {
                    let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
                    while let Some(Ok(message)) = socket.next().await {
                        if message.is_close() {
                            break;
                        }
                        if !message.is_text() {
                            continue;
                        }
                        let value: Value =
                            serde_json::from_str(message.to_text().unwrap()).unwrap();
                        let events = match value["type"].as_str().unwrap() {
                            "session.update" => vec![
                                json!({ "type":"session.updated","session":value["session"] } ),
                            ],
                            "input_audio_buffer.commit" => vec![
                                json!({ "type":"input_audio_buffer.committed","item_id":"item-1","previous_item_id":null } ),
                                json!({ "type":"conversation.item.input_audio_transcription.delta","item_id":"item-1","delta":"Hello" } ),
                                json!({ "type":"conversation.item.input_audio_transcription.completed","item_id":"item-1","transcript":"Hello" } ),
                            ],
                            _ => vec![],
                        };
                        for event in events {
                            if socket
                                .send(SocketMessage::Text(event.to_string().into()))
                                .await
                                .is_err()
                            {
                                return;
                            }
                        }
                    }
                });
            }
        });
        let Some(test) = TestService::new(
            None,
            Some(&format!(
                "ws://{provider_address}/v1/realtime?intent=transcription"
            )),
        )
        .await
        else {
            provider_task.abort();
            return;
        };
        let fixture = fixtures();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = public_router(test.service.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        for mode in ["completed", "went_away", "restarting"] {
            let authorization = format!(
                "Bearer {}",
                signed_pass(&format!("live-{mode}"), "one", true)
            );
            let mut request =
                format!("ws://{address}/v1/calls/abcdefghijklmnopqrstuv/transcription")
                    .into_client_request()
                    .unwrap();
            request
                .headers_mut()
                .insert(header::AUTHORIZATION, authorization.parse().unwrap());
            request.headers_mut().insert(
                header::SEC_WEBSOCKET_PROTOCOL,
                "wm-live.v1".parse().unwrap(),
            );
            let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
            let message = socket.next().await.unwrap().unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(message.to_text().unwrap()).unwrap(),
                fixture["liveEvents"][0]
            );
            socket
                .send(SocketMessage::Text(
                    fixture["liveFrames"][0].to_string().into(),
                ))
                .await
                .unwrap();
            socket
                .send(SocketMessage::Binary(vec![0; 48000].into()))
                .await
                .unwrap();
            socket
                .send(SocketMessage::Text(
                    fixture["liveFrames"][1].to_string().into(),
                ))
                .await
                .unwrap();
            for expected in [&fixture["liveEvents"][1], &fixture["liveEvents"][2]] {
                let message = socket.next().await.unwrap().unwrap();
                assert_eq!(
                    &serde_json::from_str::<Value>(message.to_text().unwrap()).unwrap(),
                    expected
                );
            }
            if mode == "completed" {
                socket
                    .send(SocketMessage::Text(
                        fixture["liveFrames"][2].to_string().into(),
                    ))
                    .await
                    .unwrap();
            } else if mode == "went_away" {
                socket.close(None).await.unwrap();
            } else {
                test.service.drain.cancel();
            }
            if mode != "went_away" {
                let message = socket.next().await.unwrap().unwrap();
                assert_eq!(
                    serde_json::from_str::<Value>(message.to_text().unwrap()).unwrap(),
                    fixture["liveTerminals"][mode]
                );
            }
            let response = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let request = Request::get("/v1/calls/abcdefghijklmnopqrstuv/result")
                        .header(header::AUTHORIZATION, &authorization)
                        .body(Body::empty())
                        .unwrap();
                    let response = public_router(test.service.clone())
                        .oneshot(request)
                        .await
                        .unwrap();
                    if response.status() == StatusCode::OK {
                        break response;
                    }
                    assert_eq!(response.status(), StatusCode::CONFLICT);
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(
                    &to_bytes(response.into_body(), 65536).await.unwrap()
                )
                .unwrap(),
                fixture["liveTerminals"][mode]
            );
        }
        server.abort();
        provider_task.abort();
        test.finish().await;
    };
    tokio::time::timeout(Duration::from_secs(45), scenario)
        .await
        .unwrap();
}

#[tokio::test]
async fn rejected_count_is_a_complete_prestream_http_refusal_without_a_call() {
    let scenario = async {
        let status = Arc::new(Mutex::new(StatusCode::BAD_REQUEST));
        let provider = Router::new().route(
            "/v1/messages/count_tokens",
            post({
                let status = status.clone();
                move || {
                    let status = *status.lock().unwrap();
                    async move {
                        (
                            status,
                            Json(json!({ "error":{ "type":"invalid_request_error" } } )),
                        )
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, provider).await.unwrap();
        });
        let Some(test) = TestService::new(Some(&format!("http://{address}")), None).await else {
            task.abort();
            return;
        };
        let fixture = fixtures();
        for (code, http_status) in [
            ("provider_rejected", StatusCode::BAD_REQUEST),
            ("provider_unavailable", StatusCode::UNAUTHORIZED),
        ] {
            *status.lock().unwrap() = http_status;
            let request = Request::put("/v1/calls/abcdefghijklmnopqrstuv/text")
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", signed_pass(code, "one", true)),
                )
                .body(Body::from(
                    json!({ "model":"small","messages":[{ "role":"user","parts":[{ "text":"Hello" } ] } ],"output":{ "maxTokens":100 } ,"cache":false } )
                    .to_string(),
                ))
                .unwrap();
            let response = public_router(test.service.clone())
                .oneshot(request)
                .await
                .unwrap();
            assert_eq!(
                response.status().as_u16(),
                fixture["prestreamRefusals"][code]["status"]
                    .as_u64()
                    .unwrap() as u16
            );
            assert_eq!(
                serde_json::from_slice::<Value>(
                    &to_bytes(response.into_body(), 65536).await.unwrap()
                )
                .unwrap(),
                fixture["prestreamRefusals"][code]["body"]
            );
            assert!(
                test.service
                    .ledger
                    .lookup(
                        &Principal::Account(code.to_owned()),
                        &CallerId::new("abcdefghijklmnopqrstuv".to_owned()).unwrap()
                    )
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        test.finish().await;
        task.abort();
    };
    tokio::time::timeout(Duration::from_secs(30), scenario)
        .await
        .unwrap();
}
