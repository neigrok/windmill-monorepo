use std::fs;
use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use server::telemetry::{SERVICE_CRATES, json_lines, report_failure};
use tracing_subscriber::prelude::*;

#[derive(Clone)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl io::Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn every_crate_and_binary_of_the_workspace_is_one_of_the_service_s_own() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();

    let mut names: Vec<String> = fs::read_dir(crates)
        .unwrap()
        .map(|entry| entry.unwrap().path().join("Cargo.toml"))
        .filter(|manifest| manifest.exists())
        .flat_map(|manifest| {
            fs::read_to_string(manifest)
                .unwrap()
                .lines()
                .filter_map(|line| line.strip_prefix("name = \""))
                .map(|name| name.trim_end_matches('"').to_owned())
                .collect::<Vec<_>>()
        })
        .collect();
    names.sort();

    assert_eq!(names, SERVICE_CRATES);
}

#[test]
fn a_failure_reaches_sentry_as_its_operation_and_code_and_writes_one_line() {
    let captured = Captured(Arc::new(Mutex::new(Vec::new())));
    let writer = captured.clone();
    let _logs = tracing::subscriber::set_default(
        tracing_subscriber::registry().with(json_lines(move || writer.clone())),
    );

    let events = sentry::test::with_captured_events(|| {
        report_failure("ledger.open", "refused", Some("28000"));
    });

    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(
        (
            event.level,
            event.message.as_deref(),
            &event.fingerprint[..],
            event.exception.values.len()
        ),
        (
            sentry::Level::Error,
            Some("ledger.open"),
            &["ledger.open".into(), "refused".into()][..],
            0
        )
    );
    assert_eq!(
        event.tags,
        [
            ("code", "refused"),
            ("operation", "ledger.open"),
            ("sqlstate", "28000")
        ]
        .map(|(tag, value)| (tag.to_owned(), value.to_owned()))
        .into()
    );
    let output = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
    let mut line: Value = serde_json::from_str(output.trim_end()).unwrap();
    assert!(
        line.as_object_mut()
            .unwrap()
            .remove("timestamp")
            .unwrap()
            .is_string()
    );
    assert_eq!(
        line,
        json!({
            "level": "ERROR",
            "message": "ledger.open failed",
            "operation": "ledger.open",
            "code": "refused",
            "sqlstate": "28000",
            "sentry_event_id": event.event_id.simple().to_string(),
        })
    );
}
