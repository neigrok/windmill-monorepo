// The binary as Docker runs it: what it writes to stdout, and how it exits.

use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

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
            "code": "unreachable",
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
