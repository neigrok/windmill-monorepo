use ai_domain::{BudgetKind, LedgerEvent, Provider};
use ai_server::{
    config::{PROVIDER_BUSY_AFTER, PROVIDER_BUSY_GAP},
    report_events, telemetry,
    telemetry::ProviderHealth,
};
use serde_json::{Value, json};
use std::{
    io::{self, Write},
    sync::{Arc, Mutex},
    time::Duration,
};
use tracing_subscriber::{
    filter::{LevelFilter, Targets},
    prelude::*,
};

#[derive(Clone)]
struct Captured(Arc<Mutex<Vec<u8>>>);
impl Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Captured {
    type Writer = Self;
    fn make_writer(&'a self) -> Self {
        self.clone()
    }
}

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

#[test]
fn each_shared_budget_kind_crosses_into_its_own_issue_and_an_unreadable_crossing_is_an_error() {
    let logs = Captured(Arc::new(Mutex::new(vec![])));
    let subscriber = tracing_subscriber::registry()
        .with(
            Targets::new()
                .with_default(LevelFilter::OFF)
                .with_targets(telemetry::SERVICE_CRATES.map(|name| (name, LevelFilter::TRACE))),
        )
        .with(telemetry::json_lines(logs.clone()));
    let events = sentry::test::with_captured_events(|| {
        tracing::subscriber::with_default(subscriber, || {
            report_events(
                vec![
                    LedgerEvent::Threshold {
                        budget_id: 4,
                        kind: BudgetKind::BackgroundDay,
                        percent: 80,
                    },
                    LedgerEvent::Threshold {
                        budget_id: 2,
                        kind: BudgetKind::FreeDay,
                        percent: 95,
                    },
                    LedgerEvent::ThresholdUnreadable,
                ],
                Duration::ZERO,
            );
        });
    });
    assert_eq!(
        events
            .iter()
            .map(|event| (
                event.message.clone(),
                event.level,
                event.fingerprint.to_vec(),
                event.tags.get("kind").cloned(),
            ))
            .collect::<Vec<_>>(),
        vec![
            (
                Some("budget.threshold".to_owned()),
                sentry::Level::Warning,
                vec!["budget.threshold".into(), "background_day".into()],
                Some("background_day".to_owned()),
            ),
            (
                Some("budget.threshold".to_owned()),
                sentry::Level::Warning,
                vec!["budget.threshold".into(), "free_day".into()],
                Some("free_day".to_owned()),
            ),
            (
                Some("ledger.drain_events".to_owned()),
                sentry::Level::Error,
                vec!["ledger.drain_events".into(), "threshold_unreadable".into()],
                None,
            ),
        ]
    );
    let logs = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    assert_eq!(
        logs.lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .map(|line| (
                line["operation"].clone(),
                line["kind"].clone(),
                line["percent"].clone(),
                line["code"].clone(),
            ))
            .collect::<Vec<_>>(),
        vec![
            (
                json!("budget.threshold"),
                json!("background_day"),
                json!(80),
                Value::Null
            ),
            (
                json!("budget.threshold"),
                json!("free_day"),
                json!(95),
                Value::Null
            ),
            (
                json!("ledger.drain_events"),
                Value::Null,
                Value::Null,
                json!("threshold_unreadable")
            ),
        ]
    );
}
