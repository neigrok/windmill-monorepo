use ai_domain::Provider;
use ai_server::{
    config::{PROVIDER_BUSY_AFTER, PROVIDER_BUSY_GAP},
    telemetry::ProviderHealth,
};

#[test]
fn provider_busy_warning_requires_a_continuous_bounded_streak() {
    let health = ProviderHealth::default();
    let events = sentry::test::with_captured_events(|| {
        for now in (0..PROVIDER_BUSY_AFTER).step_by(30_000) {
            assert!(!health.observe(Provider::Anthropic, Some(529), now));
        }
        assert!(health.observe(Provider::Anthropic, Some(503), PROVIDER_BUSY_AFTER));
        assert!(!health.observe(Provider::Anthropic, Some(429), PROVIDER_BUSY_AFTER + 30_000));
        assert!(!health.observe(Provider::OpenAi, Some(503), PROVIDER_BUSY_AFTER));
        assert!(!health.observe(Provider::Anthropic, Some(200), PROVIDER_BUSY_AFTER + 30_001));
        assert!(!health.observe(Provider::Anthropic, Some(529), PROVIDER_BUSY_AFTER + 60_000));
        assert!(!health.observe(
            Provider::Anthropic,
            Some(529),
            PROVIDER_BUSY_AFTER + 60_000 + PROVIDER_BUSY_GAP + 1
        ));
    });
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].level, sentry::Level::Warning);
    assert_eq!(events[0].message.as_deref(), Some("provider.busy"));
    assert_eq!(
        events[0].tags.get("provider").map(String::as_str),
        Some("anthropic")
    );
    assert_eq!(
        events[0].tags.get("status").map(String::as_str),
        Some("overloaded")
    );
}
