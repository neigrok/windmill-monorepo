use super::*;

#[test]
fn split_utf8_crlf_multiline_data_and_comments_parse_at_every_boundary() {
    let bytes = b": heartbeat\r\n\r\nevent: ping\r\ndata: {\"type\":\r\ndata: \"ping\",\"text\":\"\xe2\x82\xac\"}\r\n\r\n";
    for boundary in 0..bytes.len() {
        let mut stream = EventStream::default();
        let mut events = stream.push(&bytes[..boundary]).unwrap();
        events.extend(stream.push(&bytes[boundary..]).unwrap());
        assert_eq!(events, vec![json!({"type":"ping","text":"€"})]);
    }
}

#[test]
fn wrong_event_name_and_oversized_frames_fail() {
    assert!(
        EventStream::default()
            .push(b"event: message_stop\ndata: {\"type\":\"ping\"}\n\n")
            .is_err()
    );
    assert!(
        EventStream::default()
            .push(&vec![b'a'; MAX_PROVIDER_FRAME + 1])
            .is_err()
    );
}

#[test]
fn cache_breakdown_must_reconcile_and_usage_must_exist() {
    assert_eq!(
        parse_usage(
            &json!({"input_tokens":1,"cache_creation_input_tokens":20,"cache_creation":{"ephemeral_5m_input_tokens":19,"ephemeral_1h_input_tokens":2}})
        ),
        None
    );
    assert_eq!(parse_usage(&Value::Null), None);
    assert_eq!(
        parse_usage(&json!({"input_tokens":1,"server_tool_use":{"web_search_requests":1}})),
        None
    );
    assert_eq!(
        parse_usage(
            &json!({"input_tokens":1,"cache_creation_input_tokens":20,"cache_read_input_tokens":8})
        ),
        Some(Usage {
            input_tokens: 1,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 8,
            cache_creation_5m_input_tokens: 20,
            cache_creation_1h_input_tokens: 0,
            output_tokens: 0
        })
    );
}
