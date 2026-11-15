use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use std::io::{self, Read};

fn main() {
    if let Err(code) = run() {
        eprintln!("pass_signer: {code}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), &'static str> {
    let kid = std::env::args().nth(1).ok_or("usage: pass_signer <kid>; JSON payload on stdin; AI_PASS_PRIVATE_KEY is unpadded base64url seed")?;
    if !(1..=32).contains(&kid.len())
        || !kid
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err("invalid kid");
    }
    let encoded = std::env::var("AI_PASS_PRIVATE_KEY")
        .map_err(|_| "AI_PASS_PRIVATE_KEY is required; no built-in signing key")?;
    let seed: [u8; 32] = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "invalid signing key")?
        .try_into()
        .map_err(|_| "invalid signing key")?;
    let mut payload = Vec::new();
    io::stdin()
        .take(2_049)
        .read_to_end(&mut payload)
        .map_err(|_| "cannot read payload")?;
    let value: serde_json::Value =
        serde_json::from_slice(&payload).map_err(|_| "invalid JSON payload")?;
    if !value.is_object() {
        return Err("payload must be an object");
    }
    let key = SigningKey::from_bytes(&seed);
    let test_key = URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes())
        == "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
    if test_key && (!kid.starts_with("test-") || value["env"] == "production") {
        return Err("published test key requires test- kid and development environment");
    }
    let signed = format!("wm-pass.v1.{kid}.{}", URL_SAFE_NO_PAD.encode(payload));
    let token = format!(
        "{signed}.{}",
        URL_SAFE_NO_PAD.encode(key.sign(signed.as_bytes()).to_bytes())
    );
    if token.len() > 2_048 {
        return Err("pass exceeds 2048 characters");
    }
    println!("{token}");
    Ok(())
}
