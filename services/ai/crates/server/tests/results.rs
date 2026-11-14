use ai_server::results::Results;
use serde_json::json;

#[test]
fn new_reader_replaces_old_and_replays_after_cursor() {
    let results = Results::new(4096, 8192);
    let entry = results.create("1".to_owned(), "account:a".to_owned(), false);
    results.push(
        &entry,
        "started",
        json!({"callId":"abcdefghijklmnopqrstuv","served":"small","maxTokens":20}),
        false,
    );
    let first = entry.attach();
    let second = entry.attach();
    assert!(entry.next(0, first).1);
    assert_eq!(
        entry.next(0, second).0.unwrap().data,
        r#"{"callId":"abcdefghijklmnopqrstuv","maxTokens":20,"served":"small"}"#
    );
    results.push(
        &entry,
        "ended",
        json!({"charged":"0","stop":"completed"}),
        true,
    );
    let (event, ended) = entry.next(1, second);
    assert!(ended);
    assert_eq!(event.unwrap().data, r#"{"charged":"0","stop":"completed"}"#);
    assert!(entry.next(2, second).0.is_none());
}

#[test]
fn active_answer_overflow_discards_own_content_and_never_blocks_writer() {
    let results = Results::new(100, 200);
    let first = results.create("1".to_owned(), "account:a".to_owned(), false);
    let other = results.create("2".to_owned(), "account:b".to_owned(), false);
    results.push(&other, "ended", json!({"text":"safe"}), true);
    for _ in 0..1000 {
        results.push(&first, "text", json!({"delta":"too much content"}), false);
    }
    assert!(results.get("1").is_none());
    assert!(results.get("2").is_some());
    assert!(first.next(0, first.attach()).1);
}

#[test]
fn total_overflow_discards_triggering_answer_without_evicting_other_principal() {
    let results = Results::new(300, 100);
    let first = results.create("1".to_owned(), "account:a".to_owned(), false);
    results.push(&first, "ended", json!({"text":"safe"}), true);
    let next = results.create("2".to_owned(), "account:b".to_owned(), false);
    results.push(
        &next,
        "text",
        json!({"text":"a much larger active answer"}),
        false,
    );
    assert!(results.get("1").is_some());
    assert!(results.get("2").is_none());
}
