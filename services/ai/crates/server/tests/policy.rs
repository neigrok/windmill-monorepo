use ai_domain::{ModelClass, Tier};
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

#[test]
fn background_work_has_its_own_section_with_an_hour_below_the_fuse() {
    let tiers = include_str!("../../../config/tiers.toml");
    let prices = include_str!("../../../config/prices.toml");
    let policy = Policy::parse(tiers, prices).unwrap();
    let background = policy.tiers.row(Tier::Background).unwrap();
    assert_eq!(
        (
            background.amount.usd(),
            background.month_pool.as_ref().map(|pool| pool.limit.usd()),
            background.day_pool.as_ref().map(|pool| pool.limit.usd()),
            policy.tiers.background_hour.usd(),
            policy.tiers.hourly_fuse.usd(),
            background.in_flight,
            background.calls_per_minute,
            background.output_ceiling,
            background.text,
            background.transcription,
        ),
        (
            "2".to_owned(),
            Some("30".to_owned()),
            Some("3".to_owned()),
            "1".to_owned(),
            "20".to_owned(),
            1,
            30,
            16000,
            [ModelClass::Medium, ModelClass::Medium, ModelClass::Small],
            false,
        )
    );
    let (rows, section) = tiers.split_once("[background]").unwrap();
    assert!(Policy::parse(rows, prices).is_err());
    for invalid in [
        section.replace("hour = \"1\"", "hour = \"20\""),
        section.replace("\"small\"]", "\"tiny\"]"),
        section.replace("[\"medium\", \"medium\"", "[\"large\", \"medium\""),
        section.replace("\"medium\", \"small\"]", "\"large\", \"small\"]"),
        format!("{section}transcription = false\n"),
    ] {
        assert!(Policy::parse(&format!("{rows}[background]{invalid}"), prices).is_err());
    }
    assert!(
        Policy::parse(
            &tiers.replacen("tier = \"free\"", "tier = \"background\"", 1),
            prices
        )
        .is_err()
    );
}
