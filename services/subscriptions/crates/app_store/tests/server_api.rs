// The App Store Server API client against an Apple of the test's own, served on a local port: what it asks, with which
// token, and what it makes of each answer.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use app_store::server_api::{
    ApiFailure, ApiKey, AppStoreApi, Hosts, NotificationHistoryEntry, NotificationHistoryPage,
    NotificationHistoryRequest, PrivateKey, SendAttempt, SendAttemptResult, ServerApi,
    SignedStatus, TestNotificationStatus, TestNotificationToken, TransactionHistoryPage,
};
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
    query: Option<String>,
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
        query: uri.query().map(str::to_owned),
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
                query: None,
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
                query: None,
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
            (
                401,
                "api_unauthorized",
                true,
                written(ApiFailure::Unauthorized)
            ),
            (
                429,
                "api_rate_limited",
                true,
                written(ApiFailure::RateLimited)
            ),
            (404, "api_not_found", false, written(ApiFailure::NotFound)),
            (404, "api_not_found", false, written(ApiFailure::NotFound)),
            (
                404,
                "api_server_error",
                true,
                written(ApiFailure::ServerError)
            ),
            (
                404,
                "api_server_error",
                true,
                written(ApiFailure::ServerError)
            ),
            (
                404,
                "api_server_error",
                true,
                written(ApiFailure::ServerError)
            ),
            (404, "api_not_found", false, written(ApiFailure::NotFound)),
            (
                500,
                "api_server_error",
                true,
                written(ApiFailure::ServerError)
            ),
            (
                503,
                "api_server_error",
                true,
                written(ApiFailure::ServerError)
            ),
            (
                400,
                "api_bad_request",
                false,
                written(ApiFailure::BadRequest)
            ),
            (
                403,
                "api_bad_request",
                false,
                written(ApiFailure::BadRequest)
            ),
            (
                302,
                "api_bad_request",
                false,
                written(ApiFailure::BadRequest)
            ),
            (200, "api_malformed", false, None),
            (200, "api_not_found", false, None),
            (200, "api_not_found", false, None),
            (0, "api_unreachable", true, None),
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

#[tokio::test]
async fn transaction_history_reads_pages_with_optional_revision_and_host_per_environment() {
    let first_body = json!({
        "environment": "Production",
        "bundleId": "works.windmill.app",
        "revision": "rev+1/a=b",
        "hasMore": true,
        "signedTransactions": ["tx-jws-1", "tx-jws-2"],
    });
    let last_body = json!({
        "environment": "Sandbox",
        "bundleId": "works.windmill.app",
        "revision": "",
        "hasMore": false,
        "signedTransactions": ["tx-jws-3"],
    });
    let (production, production_url) =
        Apple::answering(StatusCode::OK, first_body.to_string()).await;
    let (sandbox, sandbox_url) = Apple::answering(StatusCode::OK, last_body.to_string()).await;
    let (key, public_key) = key();
    let api = api(key, &production_url, &sandbox_url);

    let first = api
        .transaction_history(Environment::Production, "2000000000000001", None)
        .await;
    let second = api
        .transaction_history(Environment::Sandbox, "2000000000000001", Some("rev+1/a=b"))
        .await;

    let mut prod_asked = production.asked();
    let (_, claims) = token(&prod_asked[0].authorization.take().unwrap(), &public_key);
    let mut sandbox_asked = sandbox.asked();
    sandbox_asked[0].authorization.take().unwrap();
    assert_eq!(
        (
            first,
            second,
            prod_asked,
            sandbox_asked,
            claims["bid"].clone()
        ),
        (
            Ok(TransactionHistoryPage {
                signed_transactions: vec!["tx-jws-1".to_owned(), "tx-jws-2".to_owned()],
                revision: Some("rev+1/a=b".to_owned()),
                has_more: true,
            }),
            Ok(TransactionHistoryPage {
                signed_transactions: vec!["tx-jws-3".to_owned()],
                revision: None,
                has_more: false,
            }),
            vec![Asked {
                method: Method::GET,
                path: "/inApps/v2/history/2000000000000001".to_owned(),
                query: None,
                authorization: None,
                content_type: None,
                body: String::new(),
            }],
            vec![Asked {
                method: Method::GET,
                path: "/inApps/v2/history/2000000000000001".to_owned(),
                query: Some("revision=rev%2B1%2Fa%3Db".to_owned()),
                authorization: None,
                content_type: None,
                body: String::new(),
            }],
            json!("works.windmill.app"),
        )
    );
}

#[tokio::test]
async fn notification_history_posts_filters_and_optional_pagination_token() {
    let response = json!({
        "paginationToken": "page-2-token",
        "hasMore": true,
        "notificationHistory": [
            {
                "signedPayload": "notif-jws-1",
                "sendAttempts": [
                    {"attemptDate": 1_794_614_400_000_i64, "sendAttemptResult": "TIMED_OUT"},
                    {"attemptDate": 1_794_618_000_000_i64, "sendAttemptResult": "SUCCESS"},
                    {"attemptDate": 1_794_621_600_000_i64, "sendAttemptResult": "FUTURE_APPLE_CODE"}
                ]
            }
        ]
    });
    let (production, production_url) = Apple::answering(StatusCode::OK, response.to_string()).await;
    let (sandbox, sandbox_url) = Apple::answering(
        StatusCode::OK,
        json!({"hasMore": false, "notificationHistory": []}).to_string(),
    )
    .await;
    let (key, public_key) = key();
    let api = api(key, &production_url, &sandbox_url);

    let minimal = NotificationHistoryRequest {
        start_date: 1_794_000_000_000,
        end_date: 1_794_614_400_000,
        notification_type: None,
        notification_subtype: None,
        only_failures: None,
        transaction_id: None,
    };
    let by_type = NotificationHistoryRequest {
        start_date: 1_794_000_000_000,
        end_date: 1_794_614_400_000,
        notification_type: Some("DID_RENEW".to_owned()),
        notification_subtype: Some("BILLING_RECOVERY".to_owned()),
        only_failures: Some(true),
        transaction_id: None,
    };
    let by_transaction = NotificationHistoryRequest {
        start_date: 1_794_000_000_000,
        end_date: 1_794_614_400_000,
        notification_type: None,
        notification_subtype: None,
        only_failures: Some(false),
        transaction_id: Some("2000000000000001".to_owned()),
    };

    let first = api
        .notification_history(Environment::Production, &minimal, None)
        .await;
    let second = api
        .notification_history(Environment::Sandbox, &by_type, Some("tok+1/2"))
        .await;
    let third = api
        .notification_history(Environment::Sandbox, &by_transaction, None)
        .await;

    let mut prod_asked = production.asked();
    let (_, claims) = token(&prod_asked[0].authorization.take().unwrap(), &public_key);
    let mut sandbox_asked = sandbox.asked();
    for asked in &mut sandbox_asked {
        asked.authorization.take().unwrap();
    }
    assert_eq!(
        (
            first,
            second,
            third,
            prod_asked,
            sandbox_asked,
            claims["aud"].clone()
        ),
        (
            Ok(NotificationHistoryPage {
                entries: vec![NotificationHistoryEntry {
                    signed_payload: "notif-jws-1".to_owned(),
                    send_attempts: vec![
                        SendAttempt {
                            attempt_date: Some(1_794_614_400_000),
                            result: Some(SendAttemptResult::TimedOut),
                        },
                        SendAttempt {
                            attempt_date: Some(1_794_618_000_000),
                            result: Some(SendAttemptResult::Success),
                        },
                        SendAttempt {
                            attempt_date: Some(1_794_621_600_000),
                            result: Some(SendAttemptResult::Unknown),
                        },
                    ],
                }],
                pagination_token: Some("page-2-token".to_owned()),
                has_more: true,
            }),
            Ok(NotificationHistoryPage {
                entries: vec![],
                pagination_token: None,
                has_more: false,
            }),
            Ok(NotificationHistoryPage {
                entries: vec![],
                pagination_token: None,
                has_more: false,
            }),
            vec![Asked {
                method: Method::POST,
                path: "/inApps/v1/notifications/history".to_owned(),
                query: None,
                authorization: None,
                content_type: Some("application/json".to_owned()),
                body: json!({
                    "startDate": 1_794_000_000_000_i64,
                    "endDate": 1_794_614_400_000_i64,
                })
                .to_string(),
            }],
            vec![
                Asked {
                    method: Method::POST,
                    path: "/inApps/v1/notifications/history".to_owned(),
                    query: Some("paginationToken=tok%2B1%2F2".to_owned()),
                    authorization: None,
                    content_type: Some("application/json".to_owned()),
                    body: json!({
                        "startDate": 1_794_000_000_000_i64,
                        "endDate": 1_794_614_400_000_i64,
                        "notificationType": "DID_RENEW",
                        "notificationSubtype": "BILLING_RECOVERY",
                        "onlyFailures": true,
                    })
                    .to_string(),
                },
                Asked {
                    method: Method::POST,
                    path: "/inApps/v1/notifications/history".to_owned(),
                    query: None,
                    authorization: None,
                    content_type: Some("application/json".to_owned()),
                    body: json!({
                        "startDate": 1_794_000_000_000_i64,
                        "endDate": 1_794_614_400_000_i64,
                        "onlyFailures": false,
                        "transactionId": "2000000000000001",
                    })
                    .to_string(),
                },
            ],
            json!("appstoreconnect-v1"),
        )
    );
}

#[tokio::test]
async fn test_notification_requests_a_token_and_reads_its_status() {
    let (request_apple, request_url) = Apple::answering(
        StatusCode::OK,
        json!({"testNotificationToken": "secret-test-token-42"}).to_string(),
    )
    .await;
    let (status_apple, status_url) = Apple::answering(
        StatusCode::OK,
        json!({
            "signedPayload": "secret-test-jws-payload",
            "sendAttempts": [
                {"attemptDate": 1_794_614_400_000_i64, "sendAttemptResult": "SUCCESS"}
            ]
        })
        .to_string(),
    )
    .await;
    let (key, public_key) = key();
    let api = api(key, &request_url, &status_url);

    let requested = api.request_test_notification(Environment::Production).await;
    let token_value = requested.unwrap();
    let status = api
        .test_notification_status(Environment::Sandbox, &token_value)
        .await;

    let mut req_asked = request_apple.asked();
    let (_, claims) = token(&req_asked[0].authorization.take().unwrap(), &public_key);
    let mut status_asked = status_apple.asked();
    status_asked[0].authorization.take().unwrap();
    assert_eq!(
        (
            token_value.expose(),
            status,
            req_asked,
            status_asked,
            claims["bid"].clone()
        ),
        (
            "secret-test-token-42",
            Ok(TestNotificationStatus {
                signed_payload: "secret-test-jws-payload".to_owned(),
                send_attempts: vec![SendAttempt {
                    attempt_date: Some(1_794_614_400_000),
                    result: Some(SendAttemptResult::Success),
                }],
            }),
            vec![Asked {
                method: Method::POST,
                path: "/inApps/v1/notifications/test".to_owned(),
                query: None,
                authorization: None,
                content_type: None,
                body: String::new(),
            }],
            vec![Asked {
                method: Method::GET,
                path: "/inApps/v1/notifications/test/secret-test-token-42".to_owned(),
                query: None,
                authorization: None,
                content_type: None,
                body: String::new(),
            }],
            json!("works.windmill.app"),
        )
    );
}

#[tokio::test]
async fn invalid_inputs_and_dot_segments_are_refused_before_any_request_and_path_segments_are_encoded()
 {
    let (apple, url) = Apple::answering(
        StatusCode::OK,
        json!({"hasMore": false, "signedTransactions": []}).to_string(),
    )
    .await;
    let api = api(key().0, &url, &url);
    let valid_history_req = NotificationHistoryRequest {
        start_date: 1_000,
        end_date: 2_000,
        notification_type: None,
        notification_subtype: None,
        only_failures: None,
        transaction_id: None,
    };

    for bad_segment in ["", ".", ".."] {
        assert_eq!(
            api.subscription_status(Environment::Sandbox, bad_segment)
                .await
                .err(),
            Some(ApiFailure::BadRequest),
            "subscription_status {bad_segment:?}"
        );
        assert_eq!(
            api.set_app_account_token(Environment::Sandbox, bad_segment, "token")
                .await
                .err(),
            Some(ApiFailure::BadRequest),
            "set_app_account_token {bad_segment:?}"
        );
        assert_eq!(
            api.transaction_history(Environment::Sandbox, bad_segment, None)
                .await
                .err(),
            Some(ApiFailure::BadRequest),
            "transaction_history {bad_segment:?}"
        );
        assert_eq!(
            api.test_notification_status(
                Environment::Sandbox,
                &TestNotificationToken::new(bad_segment)
            )
            .await
            .err(),
            Some(ApiFailure::BadRequest),
            "test_notification_status {bad_segment:?}"
        );
    }

    assert_eq!(
        api.transaction_history(Environment::Sandbox, "2000000000000001", Some(""))
            .await
            .err(),
        Some(ApiFailure::BadRequest)
    );
    assert_eq!(
        api.notification_history(Environment::Sandbox, &valid_history_req, Some(""))
            .await
            .err(),
        Some(ApiFailure::BadRequest)
    );

    let invalid_history_requests = [
        NotificationHistoryRequest {
            start_date: 2_001,
            end_date: 2_000,
            ..valid_history_req.clone()
        },
        NotificationHistoryRequest {
            transaction_id: Some(String::new()),
            ..valid_history_req.clone()
        },
        NotificationHistoryRequest {
            notification_type: Some(String::new()),
            ..valid_history_req.clone()
        },
        NotificationHistoryRequest {
            notification_type: Some("DID_RENEW".to_owned()),
            notification_subtype: Some(String::new()),
            ..valid_history_req.clone()
        },
        NotificationHistoryRequest {
            notification_subtype: Some("BILLING_RECOVERY".to_owned()),
            ..valid_history_req.clone()
        },
        NotificationHistoryRequest {
            notification_type: Some("DID_RENEW".to_owned()),
            transaction_id: Some("2000000000000001".to_owned()),
            ..valid_history_req.clone()
        },
    ];
    for invalid in invalid_history_requests {
        assert_eq!(
            api.notification_history(Environment::Sandbox, &invalid, None)
                .await
                .err(),
            Some(ApiFailure::BadRequest),
            "{invalid:?}"
        );
    }
    assert!(apple.asked().is_empty());

    let _ = api
        .transaction_history(Environment::Sandbox, "../escape?x=1#frag", None)
        .await
        .unwrap();
    let asked = apple.asked();
    assert_eq!(
        (asked[0].path.as_str(), asked[0].query.as_deref()),
        ("/inApps/v2/history/..%2Fescape%3Fx=1%23frag", None)
    );
}

#[tokio::test]
async fn history_and_test_endpoints_map_http_and_shape_failures_cleanly() {
    let error = |code: i64| json!({"errorCode": code, "errorMessage": "never read"}).to_string();
    let history_req = NotificationHistoryRequest {
        start_date: 1_000,
        end_date: 2_000,
        notification_type: None,
        notification_subtype: None,
        only_failures: None,
        transaction_id: None,
    };
    let test_token = TestNotificationToken::new("tok-1");

    let status_cases = [
        (
            StatusCode::UNAUTHORIZED,
            String::new(),
            ApiFailure::Unauthorized,
        ),
        (
            StatusCode::TOO_MANY_REQUESTS,
            error(4_290_000),
            ApiFailure::RateLimited,
        ),
        (
            StatusCode::NOT_FOUND,
            error(4_040_008),
            ApiFailure::NotFound,
        ),
        (
            StatusCode::NOT_FOUND,
            error(4_040_002),
            ApiFailure::ServerError,
        ),
        (
            StatusCode::NOT_FOUND,
            error(4_040_004),
            ApiFailure::ServerError,
        ),
        (
            StatusCode::NOT_FOUND,
            error(4_040_006),
            ApiFailure::ServerError,
        ),
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            error(5_000_001),
            ApiFailure::ServerError,
        ),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            String::new(),
            ApiFailure::ServerError,
        ),
        (
            StatusCode::BAD_REQUEST,
            error(4_000_006),
            ApiFailure::BadRequest,
        ),
        (StatusCode::FOUND, String::new(), ApiFailure::BadRequest),
        (StatusCode::OK, "not json".to_owned(), ApiFailure::Malformed),
        (StatusCode::OK, "{}".to_owned(), ApiFailure::Malformed),
    ];

    for (status, body, expected) in status_cases {
        let (_, url) = Apple::answering(status, body).await;
        let api = api(key().0, &url, &url);
        assert_eq!(
            api.transaction_history(Environment::Production, "2000000000000001", None)
                .await
                .err(),
            Some(expected),
            "transaction_history {status}"
        );
        assert_eq!(
            api.notification_history(Environment::Production, &history_req, None)
                .await
                .err(),
            Some(expected),
            "notification_history {status}"
        );
        assert_eq!(
            api.request_test_notification(Environment::Production)
                .await
                .err(),
            Some(expected),
            "request_test_notification {status}"
        );
        assert_eq!(
            api.test_notification_status(Environment::Production, &test_token)
                .await
                .err(),
            Some(expected),
            "test_notification_status {status}"
        );
    }

    for (malformed, cursor) in [
        (
            json!({"hasMore": true, "signedTransactions": ["tx-1"]}),
            None,
        ),
        (
            json!({"hasMore": true, "revision": "", "signedTransactions": ["tx-1"]}),
            None,
        ),
        (
            json!({"hasMore": true, "revision": "rev-same", "signedTransactions": ["tx-1"]}),
            Some("rev-same"),
        ),
        (json!({"hasMore": false, "signedTransactions": [""]}), None),
    ] {
        let (_, url) = Apple::answering(StatusCode::OK, malformed.to_string()).await;
        assert_eq!(
            api(key().0, &url, &url)
                .transaction_history(Environment::Sandbox, "2000000000000001", cursor)
                .await
                .err(),
            Some(ApiFailure::Malformed)
        );
    }

    for (malformed, cursor) in [
        (json!({"hasMore": true, "notificationHistory": []}), None),
        (
            json!({"hasMore": true, "paginationToken": "", "notificationHistory": []}),
            None,
        ),
        (
            json!({"hasMore": true, "paginationToken": "tok-same", "notificationHistory": []}),
            Some("tok-same"),
        ),
        (
            json!({"hasMore": false, "notificationHistory": [{"signedPayload": "", "sendAttempts": []}]}),
            None,
        ),
    ] {
        let (_, url) = Apple::answering(StatusCode::OK, malformed.to_string()).await;
        assert_eq!(
            api(key().0, &url, &url)
                .notification_history(Environment::Sandbox, &history_req, cursor)
                .await
                .err(),
            Some(ApiFailure::Malformed)
        );
    }

    for bad_token in ["", ".", ".."] {
        let (_, bad_token_url) = Apple::answering(
            StatusCode::OK,
            json!({"testNotificationToken": bad_token}).to_string(),
        )
        .await;
        assert_eq!(
            api(key().0, &bad_token_url, &bad_token_url)
                .request_test_notification(Environment::Sandbox)
                .await
                .err(),
            Some(ApiFailure::Malformed),
            "testNotificationToken {bad_token:?}"
        );
    }

    let (_, empty_payload_url) = Apple::answering(
        StatusCode::OK,
        json!({"signedPayload": "", "sendAttempts": []}).to_string(),
    )
    .await;
    assert_eq!(
        api(key().0, &empty_payload_url, &empty_payload_url)
            .test_notification_status(Environment::Sandbox, &test_token)
            .await
            .err(),
        Some(ApiFailure::Malformed)
    );
}

#[tokio::test]
async fn server_api_works_behind_arc_dyn_app_store_api() {
    let (_, url) = Apple::answering(
        StatusCode::OK,
        json!({"hasMore": false, "signedTransactions": ["tx-1"]}).to_string(),
    )
    .await;
    let client: Arc<dyn AppStoreApi> = Arc::new(api(key().0, &url, &url));

    let page = client
        .transaction_history(Environment::Sandbox, "2000000000000001", None)
        .await
        .unwrap();
    assert_eq!(page.signed_transactions, vec!["tx-1"]);
    assert!(!page.has_more);
}

#[test]
fn debug_redacts_signed_payloads_transaction_ids_cursors_and_test_tokens() {
    let tx_page = TransactionHistoryPage {
        signed_transactions: vec!["secret-tx-jws".to_owned()],
        revision: Some("secret-revision-cursor".to_owned()),
        has_more: true,
    };
    let notif_req = NotificationHistoryRequest {
        start_date: 1_000,
        end_date: 2_000,
        notification_type: Some("DID_RENEW".to_owned()),
        notification_subtype: None,
        only_failures: Some(false),
        transaction_id: Some("secret-tx-id-999".to_owned()),
    };
    let notif_page = NotificationHistoryPage {
        entries: vec![NotificationHistoryEntry {
            signed_payload: "secret-notif-jws".to_owned(),
            send_attempts: vec![SendAttempt {
                attempt_date: Some(1_500),
                result: Some(SendAttemptResult::Success),
            }],
        }],
        pagination_token: Some("secret-pagination-token".to_owned()),
        has_more: true,
    };
    let test_token = TestNotificationToken::new("secret-test-token-xyz");
    let test_status = TestNotificationStatus {
        signed_payload: "secret-test-status-jws".to_owned(),
        send_attempts: vec![SendAttempt {
            attempt_date: Some(1_600),
            result: Some(SendAttemptResult::TimedOut),
        }],
    };

    let printed = [
        format!("{tx_page:?}"),
        format!("{notif_req:?}"),
        format!("{notif_page:?}"),
        format!("{test_token:?}"),
        format!("{test_status:?}"),
    ];
    for (label, text) in [
        ("tx_page", &printed[0]),
        ("notif_req", &printed[1]),
        ("notif_page", &printed[2]),
        ("test_token", &printed[3]),
        ("test_status", &printed[4]),
    ] {
        assert!(!text.contains("secret-"), "{label} leaked secret: {text}");
    }
    assert_eq!(printed[3], "TestNotificationToken(redacted)");
}
