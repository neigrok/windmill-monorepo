// The binary as Docker runs it: what it writes to stdout, and how it exits.

use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use axum::Router;
use axum::http::StatusCode;
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair};
use serde_json::{Value, json};

#[test]
fn a_ledger_that_does_not_answer_stops_the_start_before_either_listener_binds() {
    let closed = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    let mut service = Command::new(env!("CARGO_BIN_EXE_subscriptions"))
        .env_clear()
        .env("SUBSCRIPTIONS_PUBLIC_ADDRESS", "127.0.0.1:0")
        .env("SUBSCRIPTIONS_INTERNAL_ADDRESS", "127.0.0.1:0")
        .env(
            "SUBSCRIPTIONS_DATABASE_URL",
            format!("postgresql://windmill_subscriptions:secret-password@{closed}/ledger"),
        )
        .env("SENTRY_ENVIRONMENT", "test")
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = service.stdout.take().unwrap();
    let reader = thread::spawn(move || {
        BufReader::new(stdout)
            .lines()
            .map(Result::unwrap)
            .collect::<Vec<String>>()
    });

    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        if let Some(status) = service.try_wait().unwrap() {
            break status;
        }
        if Instant::now() > deadline {
            service.kill().unwrap();
            panic!("the service was still running after 20 s");
        }
        thread::sleep(Duration::from_millis(50));
    };
    let lines = reader.join().unwrap();

    assert_eq!(status.code(), Some(1));
    assert!(
        lines.iter().all(|line| !line.contains("secret-password")),
        "{lines:#?}"
    );
    let lines: Vec<Value> = lines
        .iter()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let messages: Vec<&str> = lines
        .iter()
        .map(|line| line["message"].as_str().unwrap())
        .collect();
    assert_eq!(
        messages,
        [
            "sentry disabled: SENTRY_DSN is not set",
            "starting",
            "ledger.open failed"
        ]
    );
    let mut failure = lines[2].clone();
    failure.as_object_mut().unwrap().remove("timestamp");
    assert_eq!(
        failure,
        json!({
            "level": "ERROR",
            "message": "ledger.open failed",
            "operation": "ledger.open",
            "code": "ledger_unreachable",
        })
    );
}

#[test]
fn a_test_root_that_names_no_certificate_stops_the_start_before_the_ledger_opens() {
    let closed = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let missing = Path::new(env!("CARGO_MANIFEST_DIR")).join("no-such-root.cer");

    for test_root in [manifest, missing] {
        let mut service = Command::new(env!("CARGO_BIN_EXE_subscriptions"))
            .env_clear()
            .env("SUBSCRIPTIONS_PUBLIC_ADDRESS", "127.0.0.1:0")
            .env("SUBSCRIPTIONS_INTERNAL_ADDRESS", "127.0.0.1:0")
            .env(
                "SUBSCRIPTIONS_DATABASE_URL",
                format!("postgresql://windmill_subscriptions:secret-password@{closed}/ledger"),
            )
            .env("SENTRY_ENVIRONMENT", "test")
            .env("SUBSCRIPTIONS_APP_STORE_TEST_ROOT", &test_root)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = service.stdout.take().unwrap();
        let reader = thread::spawn(move || {
            BufReader::new(stdout)
                .lines()
                .map(Result::unwrap)
                .collect::<Vec<String>>()
        });

        let deadline = Instant::now() + Duration::from_secs(20);
        let status = loop {
            if let Some(status) = service.try_wait().unwrap() {
                break status;
            }
            if Instant::now() > deadline {
                service.kill().unwrap();
                panic!("the service was still running after 20 s");
            }
            thread::sleep(Duration::from_millis(50));
        };
        let lines: Vec<Value> = reader
            .join()
            .unwrap()
            .iter()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();

        assert_eq!(status.code(), Some(1), "{test_root:?}");
        let messages: Vec<&str> = lines
            .iter()
            .map(|line| line["message"].as_str().unwrap())
            .collect();
        assert_eq!(
            messages,
            [
                "sentry disabled: SENTRY_DSN is not set",
                "starting",
                "SUBSCRIPTIONS_APP_STORE_TEST_ROOT names no certificate to trust"
            ],
            "{test_root:?}"
        );
        assert_eq!(lines[1]["app_store_test_root"], json!(true));
        let mut refusal = lines[2].clone();
        refusal.as_object_mut().unwrap().remove("timestamp");
        assert_eq!(
            refusal,
            json!({
                "level": "ERROR",
                "message": "SUBSCRIPTIONS_APP_STORE_TEST_ROOT names no certificate to trust",
                "variable": "SUBSCRIPTIONS_APP_STORE_TEST_ROOT",
            })
        );
    }
}

fn p8_key() -> String {
    let pkcs8 =
        EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new())
            .unwrap();
    format!(
        "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
        STANDARD.encode(pkcs8.as_ref())
    )
}

#[tokio::test]
async fn test_notification_subcommand_calls_apple_without_database_and_redacts_secrets() {
    let router = Router::new()
        .route(
            "/inApps/v1/notifications/test",
            post(|| async {
                (
                    StatusCode::OK,
                    json!({"testNotificationToken": "secret-token-value-99"}).to_string(),
                )
            }),
        )
        .route(
            "/inApps/v1/notifications/test/{token}",
            get(|| async {
                (
                    StatusCode::OK,
                    json!({
                        "signedPayload": "secret-jws-payload-99",
                        "sendAttempts": [
                            {"attemptDate": 1_794_614_400_000_i64, "sendAttemptResult": "SUCCESS"}
                        ]
                    })
                    .to_string(),
                )
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let private_key = p8_key();
    let key_body = private_key.lines().nth(1).unwrap().to_owned();

    let output = tokio::task::spawn_blocking(move || {
        Command::new(env!("CARGO_BIN_EXE_subscriptions"))
            .args(["test-notification", "sandbox"])
            .env_clear()
            .env("SENTRY_ENVIRONMENT", "test")
            .env(
                "SUBSCRIPTIONS_APP_STORE_API_ISSUER_ID",
                "57246542-96fe-1a63-e053-0824d011072a",
            )
            .env("SUBSCRIPTIONS_APP_STORE_API_KEY_ID", "2X9R4HXF34")
            .env("SUBSCRIPTIONS_APP_STORE_API_PRIVATE_KEY", &private_key)
            .env(
                "SUBSCRIPTIONS_APP_STORE_API_TEST_URL",
                format!("http://{address}"),
            )
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    server.abort();

    let stdout = String::from_utf8(output.stdout).unwrap();
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "stdout={stdout} stderr={stderr}"
    );
    assert!(stderr.is_empty(), "{stderr}");
    for secret in ["secret-token", "secret-jws", &key_body[..16]] {
        assert!(!stdout.contains(secret), "stdout leaked {secret}: {stdout}");
    }
    let lines: Vec<Value> = stdout
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 1, "{lines:#?}");
    let mut line = lines[0].clone();
    let fields = line.as_object_mut().unwrap();
    assert!(fields.remove("timestamp").unwrap().is_string());
    assert!(fields.remove("duration_ms").unwrap().is_number());
    assert_eq!(
        line,
        json!({
            "level": "INFO",
            "message": "store.test_notification",
            "operation": "store.test_notification",
            "store": "app_store",
            "environment": "sandbox",
            "outcome": "delivered",
            "send_attempt_result": "success",
            "attempts": 1,
        })
    );
}

#[tokio::test]
async fn test_notification_subcommand_reports_api_failure_without_raw_apple_error() {
    let router = Router::new().route(
        "/inApps/v1/notifications/test",
        post(|| async {
            (
                StatusCode::UNAUTHORIZED,
                json!({"errorCode": 4_010_000, "errorMessage": "raw-apple-error-text"}).to_string(),
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let private_key = p8_key();

    let output = tokio::task::spawn_blocking(move || {
        Command::new(env!("CARGO_BIN_EXE_subscriptions"))
            .args(["test-notification", "production"])
            .env_clear()
            .env("SENTRY_ENVIRONMENT", "test")
            .env("SUBSCRIPTIONS_APP_STORE_API_ISSUER_ID", "issuer")
            .env("SUBSCRIPTIONS_APP_STORE_API_KEY_ID", "key")
            .env("SUBSCRIPTIONS_APP_STORE_API_PRIVATE_KEY", &private_key)
            .env(
                "SUBSCRIPTIONS_APP_STORE_API_TEST_URL",
                format!("http://{address}"),
            )
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    server.abort();

    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_eq!(output.status.code(), Some(1), "{stdout}");
    assert!(!stdout.contains("raw-apple-error-text"), "{stdout}");
    let mut line: Value = serde_json::from_str(stdout.trim()).unwrap();
    let fields = line.as_object_mut().unwrap();
    assert!(fields.remove("timestamp").unwrap().is_string());
    assert!(fields.remove("duration_ms").unwrap().is_number());
    assert_eq!(
        line,
        json!({
            "level": "ERROR",
            "message": "store.test_notification",
            "operation": "store.test_notification",
            "store": "app_store",
            "environment": "production",
            "outcome": "request_failed",
            "code": "api_unauthorized",
        })
    );
}

#[test]
fn test_notification_subcommand_refuses_missing_key_and_bad_arguments() {
    let missing_key = Command::new(env!("CARGO_BIN_EXE_subscriptions"))
        .args(["test-notification", "sandbox"])
        .env_clear()
        .output()
        .unwrap();
    assert_eq!(missing_key.status.code(), Some(1));
    let mut line: Value =
        serde_json::from_str(std::str::from_utf8(&missing_key.stdout).unwrap().trim()).unwrap();
    line.as_object_mut().unwrap().remove("timestamp");
    assert_eq!(
        line,
        json!({
            "level": "ERROR",
            "message": "SUBSCRIPTIONS_APP_STORE_API_ISSUER_ID is not set",
            "variable": "SUBSCRIPTIONS_APP_STORE_API_ISSUER_ID",
        })
    );

    for args in [
        &["test-notification"][..],
        &["test-notification", "staging"][..],
        &["unknown"][..],
    ] {
        let bad_args = Command::new(env!("CARGO_BIN_EXE_subscriptions"))
            .args(args)
            .env_clear()
            .output()
            .unwrap();
        assert_eq!(bad_args.status.code(), Some(1), "{args:?}");
        let mut line: Value =
            serde_json::from_str(std::str::from_utf8(&bad_args.stdout).unwrap().trim()).unwrap();
        line.as_object_mut().unwrap().remove("timestamp");
        assert_eq!(
            line,
            json!({
                "level": "ERROR",
                "message": "usage: subscriptions [test-notification <sandbox|production>]",
            }),
            "{args:?}"
        );
    }
}
