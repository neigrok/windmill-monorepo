// The App Store Server API client against an Apple of the test's own, served on a local port: what it asks, with which
// token, and what it makes of each answer.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use app_store::server_api::{ApiFailure, ApiKey, Hosts, PrivateKey, ServerApi, SignedStatus};
use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use domain::Environment;
use reqwest::Url;
use ring::rand::SystemRandom;
use ring::signature::{
    ECDSA_P256_SHA256_FIXED, ECDSA_P256_SHA256_FIXED_SIGNING, ECDSA_P384_SHA384_FIXED_SIGNING,
    EcdsaKeyPair, KeyPair, UnparsedPublicKey,
};
use serde_json::{Value, json};
use tokio::net::TcpListener;

// What one request asked of the test's Apple.
#[derive(Debug, PartialEq)]
struct Asked {
    method: Method,
    path: String,
    authorization: Option<String>,
    content_type: Option<String>,
    body: String,
}

// An Apple that records each request and answers every one alike, after a delay if the test sets one.
#[derive(Clone)]
struct Apple {
    asked: Arc<Mutex<Vec<Asked>>>,
    answer: Arc<(StatusCode, String, Duration)>,
}

impl Apple {
    async fn answering(status: StatusCode, body: impl Into<String>) -> (Apple, Url) {
        Apple::answering_after(status, body, Duration::ZERO).await
    }

    async fn answering_after(
        status: StatusCode,
        body: impl Into<String>,
        delay: Duration,
    ) -> (Apple, Url) {
        let apple = Apple {
            asked: Arc::new(Mutex::new(Vec::new())),
            answer: Arc::new((status, body.into(), delay)),
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let router = Router::new().fallback(answer).with_state(apple.clone());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (apple, url)
    }

    fn asked(&self) -> Vec<Asked> {
        std::mem::take(&mut self.asked.lock().unwrap())
    }
}

async fn answer(
    State(apple): State<Apple>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    let header = |name: &str| {
        headers
            .get(name)
            .map(|value| value.to_str().unwrap().to_owned())
    };
    apple.asked.lock().unwrap().push(Asked {
        method,
        path: uri.path().to_owned(),
        authorization: header("authorization"),
        content_type: header("content-type"),
        body,
    });
    let (status, body, delay) = &*apple.answer;
    tokio::time::sleep(*delay).await;
    (*status, body.clone())
}

const NOW_SECONDS: u64 = 1_794_614_400;

fn pem(pkcs8: &[u8]) -> String {
    let encoded = STANDARD.encode(pkcs8);
    let lines: Vec<&str> = encoded
        .as_bytes()
        .chunks(64)
        .map(|line| std::str::from_utf8(line).unwrap())
        .collect();
    format!(
        "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
        lines.join("\n")
    )
}

// A key of the test's own, and its public half, which Apple would hold.
fn key() -> (ApiKey, Vec<u8>) {
    let pkcs8 =
        EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new())
            .unwrap();
    let public_key = EcdsaKeyPair::from_pkcs8(
        &ECDSA_P256_SHA256_FIXED_SIGNING,
        pkcs8.as_ref(),
        &SystemRandom::new(),
    )
    .unwrap()
    .public_key()
    .as_ref()
    .to_vec();
    let key = ApiKey {
        issuer_id: "57246542-96fe-1a63-e053-0824d011072a".to_owned(),
        key_id: "2X9R4HXF34".to_owned(),
        private_key: pem(pkcs8.as_ref()).parse().unwrap(),
    };
    (key, public_key)
}

fn api(key: ApiKey, production: &Url, sandbox: &Url) -> ServerApi {
    let hosts = Hosts {
        production: production.clone(),
        sandbox: sandbox.clone(),
    };
    ServerApi::new(key, hosts, || UNIX_EPOCH + Duration::from_secs(NOW_SECONDS))
}

fn entry(original_transaction_id: &str, status: i32) -> Value {
    json!({
        "originalTransactionId": original_transaction_id,
        "status": status,
        "signedTransactionInfo": format!("transaction-of-{original_transaction_id}"),
        "signedRenewalInfo": format!("renewal-info-of-{original_transaction_id}"),
    })
}

// The token's header and claims, once its signature verifies under the key's public half.
fn token(authorization: &str, public_key: &[u8]) -> (Value, Value) {
    let token = authorization.strip_prefix("Bearer ").unwrap();
    let (signing_input, signature) = token.rsplit_once('.').unwrap();
    UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, public_key)
        .verify(
            signing_input.as_bytes(),
            &URL_SAFE_NO_PAD.decode(signature).unwrap(),
        )
        .unwrap();
    let (header, claims) = signing_input.split_once('.').unwrap();
    let decoded = |segment: &str| -> Value {
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(segment).unwrap()).unwrap()
    };
    (decoded(header), decoded(claims))
}

#[tokio::test]
async fn a_status_pull_answers_the_lineage_s_entry_under_a_token_apple_takes() {
    let response = json!({
        "environment": "Sandbox",
        "bundleId": "works.windmill.app",
        "appAppleId": 1_234_567_890,
        "data": [
            {"subscriptionGroupIdentifier": "21000002", "lastTransactions": [entry("2000000000000009", 2)]},
            {"subscriptionGroupIdentifier": "21000001", "lastTransactions": [
                entry("2000000000000008", 1),
                entry("2000000000000001", 4),
            ]},
        ],
    });
    let (apple, url) = Apple::answering(StatusCode::OK, response.to_string()).await;
    let (key, public_key) = key();

    let pulled = api(key, &url, &url)
        .subscription_status(Environment::Sandbox, "2000000000000001")
        .await;

    let mut asked = apple.asked();
    let authorization = asked[0].authorization.take().unwrap();
    assert!(
        pulled
            == Ok(SignedStatus {
                status: Some(4),
                signed_transaction_info: "transaction-of-2000000000000001".to_owned(),
                signed_renewal_info: Some("renewal-info-of-2000000000000001".to_owned()),
            }),
        "{:?}",
        pulled.err()
    );
    assert_eq!(
        (asked, token(&authorization, &public_key)),
        (
            vec![Asked {
                method: Method::GET,
                path: "/inApps/v1/subscriptions/2000000000000001".to_owned(),
                authorization: None,
                content_type: None,
                body: String::new(),
            }],
            (
                json!({"alg": "ES256", "kid": "2X9R4HXF34", "typ": "JWT"}),
                json!({
                    "iss": "57246542-96fe-1a63-e053-0824d011072a",
                    "iat": NOW_SECONDS,
                    "exp": NOW_SECONDS + 300,
                    "aud": "appstoreconnect-v1",
                    "bid": "works.windmill.app",
                })
            )
        )
    );
}

#[tokio::test]
async fn each_environment_is_asked_at_its_own_host() {
    let lists = |id: &str| json!({"data": [{"lastTransactions": [entry(id, 1)]}]}).to_string();
    let (production, production_url) =
        Apple::answering(StatusCode::OK, lists("2000000000000001")).await;
    let (sandbox, sandbox_url) = Apple::answering(StatusCode::OK, lists("2000000000000002")).await;
    let api = api(key().0, &production_url, &sandbox_url);

    let pulled = [
        api.subscription_status(Environment::Production, "2000000000000001")
            .await
            .map(|status| status.signed_transaction_info),
        api.subscription_status(Environment::Sandbox, "2000000000000002")
            .await
            .map(|status| status.signed_transaction_info),
    ];

    let paths = |apple: &Apple| -> Vec<String> {
        apple.asked().into_iter().map(|asked| asked.path).collect()
    };
    assert_eq!(
        (pulled, paths(&production), paths(&sandbox)),
        (
            [
                Ok("transaction-of-2000000000000001".to_owned()),
                Ok("transaction-of-2000000000000002".to_owned()),
            ],
            vec!["/inApps/v1/subscriptions/2000000000000001".to_owned()],
            vec!["/inApps/v1/subscriptions/2000000000000002".to_owned()],
        )
    );
}

#[tokio::test]
async fn the_account_is_put_as_the_app_account_token_of_the_original_transaction() {
    let (apple, url) = Apple::answering(StatusCode::OK, "").await;
    let (key, public_key) = key();

    let written = api(key, &url, &url)
        .set_app_account_token(
            Environment::Production,
            "2000000000000001",
            "6f9d0c2e-4b1a-4c8e-9f3d-2a7b5e1c0d84",
        )
        .await;

    let mut asked = apple.asked();
    let (_, claims) = token(&asked[0].authorization.take().unwrap(), &public_key);
    assert_eq!(
        (written, asked, claims["bid"].clone()),
        (
            Ok(()),
            vec![Asked {
                method: Method::PUT,
                path: "/inApps/v1/transactions/2000000000000001/appAccountToken".to_owned(),
                authorization: None,
                content_type: Some("application/json".to_owned()),
                body: json!({"appAccountToken": "6f9d0c2e-4b1a-4c8e-9f3d-2a7b5e1c0d84"})
                    .to_string(),
            }],
            json!("works.windmill.app")
        )
    );
}

#[tokio::test]
async fn every_answer_but_a_success_is_one_failure_and_says_whether_the_api_is_at_fault() {
    let error = |code: i64| json!({"errorCode": code, "errorMessage": "never read"}).to_string();
    let answers = [
        (StatusCode::UNAUTHORIZED, String::new()),
        (StatusCode::TOO_MANY_REQUESTS, error(4_290_000)),
        (StatusCode::NOT_FOUND, error(4_040_010)),
        (StatusCode::NOT_FOUND, error(4_040_005)),
        (StatusCode::NOT_FOUND, error(4_040_002)),
        (StatusCode::NOT_FOUND, error(4_040_004)),
        (StatusCode::NOT_FOUND, error(4_040_006)),
        (StatusCode::NOT_FOUND, "not json".to_owned()),
        (StatusCode::INTERNAL_SERVER_ERROR, error(5_000_001)),
        (StatusCode::SERVICE_UNAVAILABLE, String::new()),
        (StatusCode::BAD_REQUEST, error(4_000_006)),
        (StatusCode::FORBIDDEN, String::new()),
        (StatusCode::FOUND, String::new()),
        (StatusCode::OK, "not json".to_owned()),
        (StatusCode::OK, json!({"data": []}).to_string()),
        (
            StatusCode::OK,
            json!({"data": [{"lastTransactions": [entry("2000000000000009", 1)]}]}).to_string(),
        ),
    ];
    let mut failures = Vec::new();
    for (status, body) in answers {
        let (_, url) = Apple::answering(status, body).await;
        let api = api(key().0, &url, &url);
        let pulled = api
            .subscription_status(Environment::Production, "2000000000000001")
            .await
            .err()
            .unwrap();
        let written = api
            .set_app_account_token(Environment::Production, "2000000000000001", "token")
            .await
            .err();
        failures.push((status.as_u16(), pulled.code(), pulled.of_the_api(), written));
    }
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let closed_url = Url::parse(&format!("http://{}", closed.local_addr().unwrap())).unwrap();
    drop(closed);
    let unreachable = api(key().0, &closed_url, &closed_url)
        .subscription_status(Environment::Production, "2000000000000001")
        .await
        .err()
        .unwrap();
    failures.push((0, unreachable.code(), unreachable.of_the_api(), None));

    let written = |failure| Some(failure);
    assert_eq!(
        failures,
        vec![
            (401, "unauthorized", true, written(ApiFailure::Unauthorized)),
            (429, "rate_limited", true, written(ApiFailure::RateLimited)),
            (404, "not_found", false, written(ApiFailure::NotFound)),
            (404, "not_found", false, written(ApiFailure::NotFound)),
            (404, "store_error", true, written(ApiFailure::StoreError)),
            (404, "store_error", true, written(ApiFailure::StoreError)),
            (404, "store_error", true, written(ApiFailure::StoreError)),
            (404, "not_found", false, written(ApiFailure::NotFound)),
            (500, "store_error", true, written(ApiFailure::StoreError)),
            (503, "store_error", true, written(ApiFailure::StoreError)),
            (400, "bad_request", false, written(ApiFailure::BadRequest)),
            (403, "bad_request", false, written(ApiFailure::BadRequest)),
            (302, "bad_request", false, written(ApiFailure::BadRequest)),
            (200, "malformed", false, None),
            (200, "not_found", false, None),
            (200, "not_found", false, None),
            (0, "unreachable", true, None),
        ]
    );
}

#[tokio::test]
async fn an_apple_that_answers_later_than_the_bound_is_unreachable() {
    let (_, url) = Apple::answering_after(StatusCode::OK, "{}", Duration::from_secs(10)).await;
    let started = Instant::now();

    let pulled = api(key().0, &url, &url)
        .subscription_status(Environment::Production, "2000000000000001")
        .await;

    let waited = started.elapsed();
    assert_eq!(pulled.err(), Some(ApiFailure::Unreachable));
    assert!(
        waited >= Duration::from_secs(3) && waited < Duration::from_secs(5),
        "{waited:?}"
    );
}

#[test]
fn the_private_key_is_read_from_the_p8_pem_and_never_printed() {
    let pkcs8 =
        EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new())
            .unwrap();
    let p384 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P384_SHA384_FIXED_SIGNING, &SystemRandom::new())
        .unwrap();
    let as_p8 = pem(pkcs8.as_ref());
    let on_one_line = format!(
        "-----BEGIN PRIVATE KEY-----{}-----END PRIVATE KEY-----",
        STANDARD.encode(pkcs8.as_ref())
    );

    let read = |text: &str| text.parse::<PrivateKey>().map(|key| format!("{key:?}"));
    assert_eq!(
        [
            read(&as_p8),
            read(&on_one_line),
            read(&pem(p384.as_ref())),
            read(&as_p8.replace("PRIVATE KEY", "EC PRIVATE KEY")),
            read(&STANDARD.encode(pkcs8.as_ref())),
            read("-----BEGIN PRIVATE KEY-----\nnot base64\n-----END PRIVATE KEY-----"),
        ]
        .map(|read| read.map_err(|invalid| invalid.to_string())),
        [
            Ok("PrivateKey(redacted)".to_owned()),
            Ok("PrivateKey(redacted)".to_owned()),
            Err("the key is no P-256 private key in PKCS#8 PEM".to_owned()),
            Err("the key is no P-256 private key in PKCS#8 PEM".to_owned()),
            Err("the key is no P-256 private key in PKCS#8 PEM".to_owned()),
            Err("the key is no P-256 private key in PKCS#8 PEM".to_owned()),
        ]
    );
    assert_eq!(
        as_p8.parse::<PrivateKey>().unwrap(),
        on_one_line.parse::<PrivateKey>().unwrap()
    );
}
