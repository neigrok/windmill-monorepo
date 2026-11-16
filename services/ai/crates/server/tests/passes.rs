use ai_server::pass::{Environment, PassVerifier};
use std::collections::BTreeMap;

#[test]
fn every_shared_pass_vector_verifies() {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../packages/api-contract/ai/passes/vectors.json"
    ))
    .unwrap();
    let verifier = PassVerifier::new(
        Environment::Development,
        BTreeMap::from([(
            vectors["kid"].as_str().unwrap().to_owned(),
            vectors["publicKey"].as_str().unwrap().to_owned(),
        )]),
    )
    .unwrap();
    for case in vectors["cases"].as_array().unwrap() {
        let result = verifier.verify(case["passValue"].as_str(), case["now"].as_i64().unwrap());
        assert_eq!(
            result.map(|_| "ok").unwrap_or_else(|code| code),
            case["expected"].as_str().unwrap(),
            "{}",
            case["name"]
        );
    }
    for alias in ["test-rfc8032", "production-alias"] {
        assert!(
            PassVerifier::new(
                Environment::Production,
                BTreeMap::from([(
                    alias.to_owned(),
                    vectors["publicKey"].as_str().unwrap().to_owned()
                )])
            )
            .is_err()
        );
    }
}
