use std::io::Write;
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use app_store::verification::SignedDataVerifier;
use app_store_test_signer::TEST_ROOT;

fn run_signer(stdin: &str) -> Output {
    let mut signer = Command::new(env!("CARGO_BIN_EXE_app_store_test_signer"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    signer
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    let (exited, exit) = mpsc::channel();
    thread::spawn(move || exited.send(signer.wait_with_output()));
    exit.recv_timeout(Duration::from_secs(30))
        .expect("the signer exits within 30 s")
        .unwrap()
}

fn millis(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

#[test]
fn the_command_signs_the_description_on_stdin_at_the_current_time() {
    let before = millis(SystemTime::now());

    let signed = run_signer(include_str!(
        "../../../tests/fixtures/app_store/test-payloads/purchase-transaction.json"
    ));

    let after = millis(SystemTime::now());
    let stdout = String::from_utf8(signed.stdout).unwrap();
    let transaction = SignedDataVerifier::new(&[TEST_ROOT], "works.windmill.app", SystemTime::now)
        .unwrap()
        .verify_transaction(stdout.trim_end_matches('\n'))
        .unwrap_or_else(|refusal| panic!("refused: {refusal}"));
    let signed_date = transaction.signed_date.unwrap();
    assert_eq!(
        (
            signed.status.code(),
            String::from_utf8(signed.stderr).unwrap(),
            stdout.matches('\n').count(),
            (before..=after).contains(&signed_date),
            transaction.purchase_date == signed_date,
            transaction.expires_date == Some(signed_date + 30 * 86_400_000),
        ),
        (Some(0), String::new(), 1, true, true, true)
    );
}

#[test]
fn the_command_refuses_stdin_that_describes_no_app_store_payload() {
    let refused = run_signer(r#"{"receipt": {}}"#);

    assert_eq!(
        (
            refused.status.code(),
            String::from_utf8(refused.stdout).unwrap(),
            String::from_utf8(refused.stderr).unwrap(),
        ),
        (
            Some(1),
            String::new(),
            "app_store_test_signer: stdin holds no description: unknown variant `receipt`, expected `notification` or `transaction` at line 1 column 10\n"
                .to_owned()
        )
    );
}
