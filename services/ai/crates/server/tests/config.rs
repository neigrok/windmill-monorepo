use ai_server::config::Config;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use std::collections::HashMap;

#[test]
fn production_requires_its_own_database_role_and_separate_listeners() {
    let mut values = HashMap::from([
        ("AI_ENVIRONMENT", "production".to_owned()),
        (
            "AI_DATABASE_URL",
            "postgresql://windmill_ai:secret@postgres/windmill_ai".to_owned(),
        ),
        ("AI_CARRY_KEY", URL_SAFE_NO_PAD.encode([42; 32])),
        ("AI_FUNDING_SECRET", "f".repeat(32)),
        ("AI_OPERATOR_SECRET", "o".repeat(32)),
    ]);
    assert!(Config::from_environment(|key| values.get(key).cloned()).is_ok());
    values.insert("AI_PASS_KEYS", String::new());
    assert!(Config::from_environment(|key| values.get(key).cloned()).is_ok());
    values.insert(
        "AI_DATABASE_URL",
        "postgresql://postgres:secret@postgres/windmill_ai".to_owned(),
    );
    assert!(Config::from_environment(|key| values.get(key).cloned()).is_err());
    values.insert(
        "AI_DATABASE_URL",
        "postgresql://windmill_ai:secret@postgres/backend".to_owned(),
    );
    assert!(Config::from_environment(|key| values.get(key).cloned()).is_err());
    values.insert("AI_ENVIRONMENT", "development".to_owned());
    assert!(Config::from_environment(|key| values.get(key).cloned()).is_ok());
    values.insert("AI_INTERNAL_ADDRESS", "127.0.0.1:8084".to_owned());
    assert!(Config::from_environment(|key| values.get(key).cloned()).is_err());
}
