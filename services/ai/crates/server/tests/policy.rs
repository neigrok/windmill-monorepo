use ai_server::policy::Policy;

#[test]
fn shipped_configuration_is_complete_and_rejects_provider_mismatch() {
    let tiers = include_str!("../../../config/tiers.toml");
    let prices = include_str!("../../../config/prices.toml");
    assert!(Policy::parse(tiers, prices).is_ok());
    assert!(
        Policy::parse(
            &tiers.replacen("provider = \"anthropic\"", "provider = \"openai\"", 1),
            prices
        )
        .is_err()
    );
    assert!(
        Policy::parse(
            &tiers.replacen("provider = \"openai\"", "provider = \"anthropic\"", 1),
            prices
        )
        .is_err()
    );
    assert!(Policy::parse(tiers, &prices.replace("cache_read =", "unknown_rate =")).is_err());
}
