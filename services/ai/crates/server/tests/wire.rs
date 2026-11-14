use ai_domain::*;
use ai_server::{refusal, wire};
use serde_json::Value;

#[tokio::test]
async fn refusal_status_and_whole_body_match_shared_contract() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../packages/api-contract/ai/wire/fixtures.json"
    ))
    .unwrap();
    for case in fixture["refusals"].as_array().unwrap() {
        let code = case["body"]["code"].as_str().unwrap();
        let code: &'static str = Box::leak(code.to_owned().into_boxed_str());
        let allowance =
            (!case["body"]["allowance"].is_null()).then(|| fixture["allowance"].clone());
        let response = refusal(code, allowance);
        assert_eq!(
            response.status().as_u16(),
            case["status"].as_u64().unwrap() as u16
        );
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap(),
            case["body"]
        );
    }
}

#[test]
fn allowance_matches_shared_contract() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../packages/api-contract/ai/wire/fixtures.json"
    ))
    .unwrap();
    assert_eq!(
        wire::allowance(&Allowance {
            tier: Tier::Free,
            period: AllowancePeriod::CalendarMonthUtc,
            limit: NanoUsd::from_usd("0.5").unwrap(),
            used: NanoUsd::from_usd("0.01").unwrap(),
            reserved: NanoUsd::from_usd("0.02").unwrap(),
            remaining: NanoUsd::from_usd("0.47").unwrap(),
            resets_at: Some(1801440000000),
            budget_resets_at: None,
            code: StaticCode::Ok,
            text: [ModelClass::Large, ModelClass::Medium, ModelClass::Small],
            transcription: false
        }),
        fixture["allowance"]
    );
}
