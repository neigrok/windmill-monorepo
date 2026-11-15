use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn signer_reproduces_every_valid_payload_byte_for_byte() {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../packages/api-contract/ai/passes/vectors.json"
    ))
    .unwrap();
    for case in vectors["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["expected"] == "ok")
    {
        let mut child = Command::new(env!("CARGO_BIN_EXE_pass_signer"))
            .arg(vectors["kid"].as_str().unwrap())
            .env(
                "AI_PASS_PRIVATE_KEY",
                vectors["privateSeed"].as_str().unwrap(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(case["payload"].as_str().unwrap().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("{}\n", case["passValue"].as_str().unwrap())
        );
        assert_eq!(output.stderr, Vec::<u8>::new());
    }
    for (kid, payload) in [
        (
            "production-alias",
            vectors["cases"][0]["payload"].as_str().unwrap().to_owned(),
        ),
        (
            "test-rfc8032",
            vectors["cases"][0]["payload"]
                .as_str()
                .unwrap()
                .replace("development", "production"),
        ),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_pass_signer"))
            .arg(kid)
            .env(
                "AI_PASS_PRIVATE_KEY",
                vectors["privateSeed"].as_str().unwrap(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(payload.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(!output.status.success());
        assert_eq!(output.stdout, Vec::<u8>::new());
        assert_eq!(
            String::from_utf8(output.stderr).unwrap(),
            "pass_signer: published test key requires test- kid and development environment\n"
        );
    }
}
