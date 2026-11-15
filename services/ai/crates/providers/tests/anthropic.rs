use std::time::{Duration, Instant};

use ai_providers::{
    Anthropic, AssistantMessage, CarryKey, Certainty, CountSource, Effort, FailureCode,
    FailureKind, ModelProfile, Part, PreparedText, Reasoning, Secret, Stop, TextEvent, TextOutcome,
    TextRequest, Usage, ValidationError,
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};

struct HttpFixture {
    url: String,
    requests: mpsc::UnboundedReceiver<(String, Value)>,
    task: tokio::task::JoinHandle<()>,
}

impl HttpFixture {
    async fn new(replies: Vec<(u16, String, Duration)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (tx, requests) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            for (status, body, delay) in replies {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut data = Vec::new();
                let mut buffer = [0u8; 4096];
                let header_end = loop {
                    let length = socket.read(&mut buffer).await.unwrap();
                    if length == 0 {
                        return;
                    }
                    data.extend_from_slice(&buffer[..length]);
                    if let Some(index) = data.windows(4).position(|part| part == b"\r\n\r\n") {
                        break index + 4;
                    }
                };
                let header = std::str::from_utf8(&data[..header_end]).unwrap().to_owned();
                let length = header
                    .lines()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length: ")
                            .map(|value| value.parse::<usize>().unwrap())
                    })
                    .unwrap();
                while data.len() < header_end + length {
                    let length = socket.read(&mut buffer).await.unwrap();
                    if length == 0 {
                        return;
                    }
                    data.extend_from_slice(&buffer[..length]);
                }
                tx.send((
                    header,
                    serde_json::from_slice(&data[header_end..header_end + length]).unwrap(),
                ))
                .unwrap();
                tokio::time::sleep(delay).await;
                if status == 0 {
                    continue;
                }
                let response = format!(
                    "HTTP/1.1 {status} Fixture\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nRequest-Id: req_fixture_1\r\nLocation: /must-not-follow\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        Self {
            url,
            requests,
            task,
        }
    }
}

impl Drop for HttpFixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn profile() -> ModelProfile {
    ModelProfile {
        model: "claude-opus-5".into(),
        reasoning: Reasoning::Adaptive,
        max_effort: Effort::Max,
        image_token_ceiling: 4784,
        tool_overhead_tokens: 286,
    }
}

fn request() -> TextRequest {
    TextRequest::parse(br#"{"model":"large","system":["system marker"],"tools":[{"name":"lookup","description":"tool marker","input":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"],"additionalProperties":false}}],"messages":[{"role":"user","parts":[{"text":"content marker"}]}],"output":{"maxTokens":2048,"minTokens":1024},"effort":"max"}"#).unwrap()
}

#[test]
fn content_has_no_debug_or_display() {
    static_assertions::assert_not_impl_any!(TextRequest: std::fmt::Debug, std::fmt::Display);
    static_assertions::assert_not_impl_any!(PreparedText: std::fmt::Debug, std::fmt::Display);
    static_assertions::assert_not_impl_any!(AssistantMessage: std::fmt::Debug, std::fmt::Display);
    static_assertions::assert_not_impl_any!(TextOutcome: std::fmt::Debug, std::fmt::Display);
    static_assertions::assert_not_impl_any!(TextEvent: std::fmt::Debug, std::fmt::Display);
    static_assertions::assert_not_impl_any!(Part: std::fmt::Debug, std::fmt::Display);
    static_assertions::assert_not_impl_any!(Secret: std::fmt::Debug, std::fmt::Display);
    static_assertions::assert_not_impl_any!(CarryKey: std::fmt::Debug, std::fmt::Display);
}

#[test]
fn request_rejects_unknown_fields_illegal_parts_and_incomplete_tool_results() {
    let base = serde_json::to_value(request()).unwrap();
    let mut cases = Vec::new();
    let mut unknown = base.clone();
    unknown["temperature"] = json!(0.4);
    cases.push(unknown);
    let mut hosted = base.clone();
    hosted["tools"][0]["type"] = json!("web_search_20250305");
    cases.push(hosted);
    let mut forced = base.clone();
    forced["toolChoice"] = json!("lookup");
    cases.push(forced);
    let mut url = base.clone();
    url["messages"][0]["parts"] = json!([{"image":{"url":"https://example.com/p.png"}}]);
    cases.push(url);
    let mut mixed = base.clone();
    mixed["messages"][0]["parts"] =
        json!([{"text":"x","image":{"mediaType":"image/png","data":"AA=="}}]);
    cases.push(mixed);
    let mut nested = base.clone();
    nested["messages"][0]["extra"] = json!(true);
    cases.push(nested);
    let mut results = base.clone();
    results["messages"] = json!([{"role":"assistant","parts":[{"toolCall":{"id":"a","name":"lookup","input":{}}},{"toolCall":{"id":"b","name":"lookup","input":{}}}]},{"role":"tool","results":[{"id":"a","content":"value","isError":false}]}]);
    cases.push(results);
    let mut duplicate = base.clone();
    duplicate["messages"] = json!([{"role":"assistant","parts":[{"toolCall":{"id":"a","name":"lookup","input":{}}}]},{"role":"tool","results":[{"id":"a","content":"one","isError":false},{"id":"a","content":"two","isError":false}]}]);
    cases.push(duplicate);
    for value in cases {
        assert!(matches!(
            TextRequest::parse(&serde_json::to_vec(&value).unwrap()),
            Err(ValidationError::InvalidRequest)
        ));
    }
    let deep = format!("{}0{}", "[".repeat(65), "]".repeat(65));
    assert!(matches!(
        TextRequest::parse(deep.as_bytes()),
        Err(ValidationError::InvalidRequest)
    ));
    assert!(matches!(
        TextRequest::parse(&vec![b' '; 8 * 1024 * 1024 + 1]),
        Err(ValidationError::TooLarge)
    ));
}

#[tokio::test]
async fn count_has_same_input_as_dispatch_strict_tools_and_exact_cache_breakpoints() {
    let mut fixture = HttpFixture::new(vec![
        (200, "{\"input_tokens\":123}".into(), Duration::ZERO),
        (
            200,
            include_str!("../../../tests/provider-fixtures/anthropic-tools.sse").into(),
            Duration::ZERO,
        ),
    ])
    .await;
    let client = Anthropic::new(
        &fixture.url,
        Secret::new("test-key".into()),
        CarryKey::new([7; 32]),
    )
    .unwrap();
    let prepared = client.prepare(request(), &profile()).unwrap();
    assert_eq!(client.count(&prepared).await.unwrap().input_tokens, 123);
    let (sender, mut events) = mpsc::unbounded_channel();
    let outcome = client
        .run(prepared, 1024, move |event| {
            let _ = sender.send(event);
        })
        .await;
    assert_eq!(outcome.stop, Some(Stop::ToolCalls));
    assert_eq!(
        outcome.usage,
        Some(Usage {
            input_tokens: 101,
            cache_creation_input_tokens: 210,
            cache_read_input_tokens: 303,
            cache_creation_5m_input_tokens: 200,
            cache_creation_1h_input_tokens: 10,
            output_tokens: 44
        })
    );
    assert!(outcome.failure.is_none());
    let (headers, count) = fixture.requests.recv().await.unwrap();
    assert!(headers.starts_with("POST /v1/messages/count_tokens HTTP/1.1\r\n"));
    assert!(headers.contains("anthropic-version: 2023-06-01\r\n"));
    let (_, mut dispatch) = fixture.requests.recv().await.unwrap();
    assert_eq!(dispatch["max_tokens"], 1024);
    dispatch.as_object_mut().unwrap().remove("max_tokens");
    dispatch.as_object_mut().unwrap().remove("stream");
    assert_eq!(count, dispatch);
    assert_eq!(
        count,
        json!({"model":"claude-opus-5","system":[{"type":"text","text":"system marker","cache_control":{"type":"ephemeral","ttl":"5m"}}],"tools":[{"name":"lookup","description":"tool marker","input_schema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"],"additionalProperties":false},"strict":true}],"messages":[{"role":"user","content":[{"type":"text","text":"content marker","cache_control":{"type":"ephemeral","ttl":"5m"}}]}],"thinking":{"type":"adaptive"},"output_config":{"effort":"max"}})
    );
    assert!(matches!(events.recv().await,Some(TextEvent::Text{delta}) if delta=="I can help. "));
    assert!(
        matches!(events.recv().await,Some(TextEvent::ToolCall{id,name,input}) if id=="tool_1" && name=="lookup" && input==json!({"query":"one"}))
    );
    assert!(events.recv().await.is_none());
    let message = serde_json::to_value(outcome.message.unwrap()).unwrap();
    assert_eq!(
        message["parts"],
        json!([{"text":"I can help. "},{"toolCall":{"id":"tool_1","name":"lookup","input":{"query":"one"}}}])
    );
    assert!(!message.to_string().contains("HIDDEN_REASONING_MARKER"));
}

#[tokio::test]
async fn count_deadline_covers_response_body_and_falls_back_to_conservative_raw_count() {
    let mut fixture = HttpFixture::new(vec![(
        200,
        "{\"input_tokens\":1}".into(),
        Duration::from_secs(3),
    )])
    .await;
    let client = Anthropic::new(
        &fixture.url,
        Secret::new("test".into()),
        CarryKey::new([7; 32]),
    )
    .unwrap();
    let prepared = client.prepare(request(), &profile()).unwrap();
    let start = Instant::now();
    let count = client.count(&prepared).await.unwrap();
    assert_eq!(count.source, CountSource::Fallback);
    assert!(start.elapsed() < Duration::from_millis(2500));
    let (_, mut body) = fixture.requests.recv().await.unwrap();
    body["max_tokens"] = json!(2048);
    body["stream"] = json!(true);
    assert_eq!(
        count.input_tokens,
        serde_json::to_vec(&body).unwrap().len() as u64 + 286
    );
}

#[tokio::test]
async fn status_refusals_are_unconsumed_and_redirects_are_never_followed() {
    for (status, code) in [
        (400, FailureCode::ProviderRejected),
        (413, FailureCode::ProviderRejected),
        (422, FailureCode::ProviderRejected),
        (401, FailureCode::ProviderUnavailable),
        (402, FailureCode::ProviderUnavailable),
        (403, FailureCode::ProviderUnavailable),
        (429, FailureCode::ProviderUnavailable),
        (302, FailureCode::ProviderUnavailable),
    ] {
        let fixture = HttpFixture::new(vec![(
            status,
            "PRIVATE_PROVIDER_ERROR_TEXT".into(),
            Duration::ZERO,
        )])
        .await;
        let client = Anthropic::new(
            &fixture.url,
            Secret::new("test".into()),
            CarryKey::new([7; 32]),
        )
        .unwrap();
        let (sender, _) = mpsc::unbounded_channel();
        let outcome = client
            .run(
                client.prepare(request(), &profile()).unwrap(),
                1024,
                move |event| {
                    let _ = sender.send(event);
                },
            )
            .await;
        let failure = outcome.failure.unwrap();
        assert_eq!(
            (
                failure.code,
                failure.certainty,
                failure.http_status,
                failure.key_account_fault
            ),
            (
                code,
                Certainty::Unconsumed,
                Some(status),
                matches!(status, 401..=403)
            )
        );
        assert!(!format!("{failure:?}").contains("PRIVATE_PROVIDER_ERROR_TEXT"));
    }
}

#[tokio::test]
async fn dropped_reader_does_not_interrupt_and_incomplete_tool_json_is_omitted() {
    let transcript = include_str!("../../../tests/provider-fixtures/anthropic-tools.sse")
        .replace("\\\"one\\\"}", "\\\"one")
        .replace(
            "\"stop_reason\":\"tool_use\"",
            "\"stop_reason\":\"max_tokens\"",
        );
    let fixture = HttpFixture::new(vec![(200, transcript, Duration::ZERO)]).await;
    let client = Anthropic::new(
        &fixture.url,
        Secret::new("test".into()),
        CarryKey::new([7; 32]),
    )
    .unwrap();
    let (sender, receiver) = mpsc::unbounded_channel();
    drop(receiver);
    let outcome = client
        .run(
            client.prepare(request(), &profile()).unwrap(),
            1024,
            move |event| {
                let _ = sender.send(event);
            },
        )
        .await;
    assert_eq!(outcome.stop, Some(Stop::Truncated));
    assert!(outcome.failure.is_none());
    assert_eq!(
        serde_json::to_value(outcome.message.unwrap()).unwrap()["parts"],
        json!([{"text":"I can help. "}])
    );
}

#[tokio::test]
async fn broken_stream_is_assumed_even_after_usage_and_disconnect_before_headers_is_uncertain() {
    for (status, body) in [
        (
            200,
            include_str!("../../../tests/provider-fixtures/anthropic-tools.sse").replace(
                "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
                "",
            ),
        ),
        (0, String::new()),
        (200, "event: message_start\ndata: not json\n\n".into()),
    ] {
        let fixture = HttpFixture::new(vec![(status, body, Duration::ZERO)]).await;
        let client = Anthropic::new(
            &fixture.url,
            Secret::new("test".into()),
            CarryKey::new([7; 32]),
        )
        .unwrap();
        let (sender, _) = mpsc::unbounded_channel();
        let outcome = client
            .run(
                client.prepare(request(), &profile()).unwrap(),
                1024,
                move |event| {
                    let _ = sender.send(event);
                },
            )
            .await;
        let failure = outcome.failure.unwrap();
        assert_eq!(
            (failure.code, failure.certainty),
            (FailureCode::ProviderFailed, Certainty::Assumed)
        );
        assert_eq!(outcome.usage, None);
    }
}

#[tokio::test]
async fn unknown_stop_retains_complete_usage_but_fails_with_static_code() {
    let fixture = HttpFixture::new(vec![(
        200,
        include_str!("../../../tests/provider-fixtures/anthropic-tools.sse").replace(
            "\"stop_reason\":\"tool_use\"",
            "\"stop_reason\":\"PRIVATE_UNKNOWN_STOP\"",
        ),
        Duration::ZERO,
    )])
    .await;
    let client = Anthropic::new(
        &fixture.url,
        Secret::new("test".into()),
        CarryKey::new([7; 32]),
    )
    .unwrap();
    let (sender, _) = mpsc::unbounded_channel();
    let outcome = client
        .run(
            client.prepare(request(), &profile()).unwrap(),
            1024,
            move |event| {
                let _ = sender.send(event);
            },
        )
        .await;
    assert!(outcome.usage.is_some());
    let failure = outcome.failure.unwrap();
    assert_eq!(
        (failure.code, failure.kind),
        (FailureCode::ProviderFailed, FailureKind::Protocol)
    );
    assert!(!format!("{failure:?}").contains("PRIVATE_UNKNOWN_STOP"));
}

#[tokio::test]
async fn sealed_carry_restores_reasoning_across_models_and_tamper_rebuilds_visible_parts() {
    let mut fixture = HttpFixture::new(vec![
        (
            200,
            include_str!("../../../tests/provider-fixtures/anthropic-tools.sse").into(),
            Duration::ZERO,
        ),
        (200, "{\"input_tokens\":123}".into(), Duration::ZERO),
        (200, "{\"input_tokens\":123}".into(), Duration::ZERO),
    ])
    .await;
    let client = Anthropic::new(
        &fixture.url,
        Secret::new("test".into()),
        CarryKey::new([7; 32]),
    )
    .unwrap();
    let (sender, _) = mpsc::unbounded_channel();
    let outcome = client
        .run(
            client.prepare(request(), &profile()).unwrap(),
            1024,
            move |event| {
                let _ = sender.send(event);
            },
        )
        .await;
    fixture.requests.recv().await.unwrap();
    let message = serde_json::to_value(outcome.message.unwrap()).unwrap();
    for tamper in [false, true] {
        let mut body = serde_json::to_value(request()).unwrap();
        let mut assistant = message.clone();
        if tamper {
            let carry = assistant["carry"].as_str().unwrap();
            let mut bytes = carry.as_bytes().to_vec();
            bytes[20] = if bytes[20] == b'A' { b'B' } else { b'A' };
            assistant["carry"] = json!(String::from_utf8(bytes).unwrap());
        }
        body["messages"].as_array_mut().unwrap().push(assistant);
        body["messages"].as_array_mut().unwrap().push(
            json!({"role":"tool","results":[{"id":"tool_1","content":"one","isError":false}]}),
        );
        let mut profile = profile();
        profile.model = "claude-sonnet-5".into();
        let prepared = client
            .prepare(
                TextRequest::parse(&serde_json::to_vec(&body).unwrap()).unwrap(),
                &profile,
            )
            .unwrap();
        client.count(&prepared).await.unwrap();
        let (_, actual) = fixture.requests.recv().await.unwrap();
        assert_eq!(actual["model"], "claude-sonnet-5");
        assert_eq!(
            actual.to_string().contains("HIDDEN_REASONING_MARKER"),
            !tamper
        );
        assert_eq!(
            actual["messages"][1]["content"].as_array().unwrap().len(),
            if tamper { 2 } else { 3 }
        );
    }
}

#[tokio::test]
async fn malformed_stream_is_drained_before_the_call_ends() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = [0u8; 8192];
        assert!(socket.read(&mut buffer).await.unwrap() > 0);
        let prefix = "event: message_start\ndata: malformed\n\n";
        let tail = "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{prefix}",
                    prefix.len() + tail.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(250)).await;
        socket.write_all(tail.as_bytes()).await.unwrap();
    });
    let client = Anthropic::new(&url, Secret::new("test".into()), CarryKey::new([7; 32])).unwrap();
    let (sender, _) = mpsc::unbounded_channel();
    let start = Instant::now();
    let outcome = client
        .run(
            client.prepare(request(), &profile()).unwrap(),
            1024,
            move |event| {
                let _ = sender.send(event);
            },
        )
        .await;
    assert!(start.elapsed() >= Duration::from_millis(250));
    assert_eq!(outcome.failure.unwrap().certainty, Certainty::Assumed);
    task.await.unwrap();
}

#[tokio::test]
async fn every_stop_maps_and_missing_usage_never_becomes_zero_cost() {
    for (reason, expected) in [("end_turn", Stop::Completed), ("refusal", Stop::Declined)] {
        let transcript = include_str!("../../../tests/provider-fixtures/anthropic-tools.sse")
            .replace(
                "\"stop_reason\":\"tool_use\"",
                &format!("\"stop_reason\":\"{reason}\""),
            );
        let fixture = HttpFixture::new(vec![(200, transcript, Duration::ZERO)]).await;
        let client = Anthropic::new(
            &fixture.url,
            Secret::new("test".into()),
            CarryKey::new([7; 32]),
        )
        .unwrap();
        let outcome = client
            .run(client.prepare(request(), &profile()).unwrap(), 1024, |_| {})
            .await;
        assert_eq!(outcome.stop, Some(expected));
        assert!(outcome.failure.is_none());
        assert!(outcome.usage.is_some());
    }
    let transcript = include_str!("../../../tests/provider-fixtures/anthropic-tools.sse")
        .replace("\"input_tokens\":101,", "");
    let fixture = HttpFixture::new(vec![(200, transcript, Duration::ZERO)]).await;
    let client = Anthropic::new(
        &fixture.url,
        Secret::new("test".into()),
        CarryKey::new([7; 32]),
    )
    .unwrap();
    let outcome = client
        .run(client.prepare(request(), &profile()).unwrap(), 1024, |_| {})
        .await;
    assert_eq!(outcome.stop, Some(Stop::ToolCalls));
    assert!(outcome.failure.is_none());
    assert_eq!(outcome.usage, None);
}

#[tokio::test]
async fn fallback_covers_images_and_count_rejection_never_dispatches() {
    let mut fixture = HttpFixture::new(vec![
        (503, "unavailable".into(), Duration::ZERO),
        (400, "PRIVATE_REJECTION".into(), Duration::ZERO),
    ])
    .await;
    let client = Anthropic::new(
        &fixture.url,
        Secret::new("test".into()),
        CarryKey::new([7; 32]),
    )
    .unwrap();
    let mut body = serde_json::to_value(request()).unwrap();
    body["messages"][0]["parts"].as_array_mut().unwrap().push(json!({"image":{"mediaType":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6FAAAAAASUVORK5CYII="}}));
    let prepared = client
        .prepare(
            TextRequest::parse(&serde_json::to_vec(&body).unwrap()).unwrap(),
            &profile(),
        )
        .unwrap();
    let count = client.count(&prepared).await.unwrap();
    let (_, mut wire) = fixture.requests.recv().await.unwrap();
    wire["max_tokens"] = json!(2048);
    wire["stream"] = json!(true);
    assert_eq!(
        count.input_tokens,
        serde_json::to_vec(&wire).unwrap().len() as u64 + 4784 + 286
    );
    assert_eq!(count.source, CountSource::Fallback);
    let refusal = client.count(&prepared).await.unwrap_err();
    assert_eq!(refusal.code, FailureCode::ProviderRejected);
    assert_eq!(refusal.certainty, Certainty::Unconsumed);
    assert!(!format!("{refusal:?}").contains("PRIVATE_REJECTION"));
}

#[tokio::test]
async fn budget_reasoning_keeps_the_counted_configuration_under_admission_cap_changes() {
    let mut fixture =
        HttpFixture::new(vec![(200, "{\"input_tokens\":50}".into(), Duration::ZERO)]).await;
    let client = Anthropic::new(
        &fixture.url,
        Secret::new("test".into()),
        CarryKey::new([7; 32]),
    )
    .unwrap();
    let mut request = request();
    request.output.min_tokens = Some(1025);
    request.output.schema =
        Some(json!({"type":"object","properties":{},"additionalProperties":false}));
    request.cache = false;
    let mut profile = profile();
    profile.reasoning = Reasoning::Budget;
    profile.model = "claude-haiku-4-5".into();
    client
        .count(&client.prepare(request, &profile).unwrap())
        .await
        .unwrap();
    let (_, body) = fixture.requests.recv().await.unwrap();
    assert_eq!(
        body["thinking"],
        json!({"type":"enabled","budget_tokens":1024})
    );
    assert_eq!(
        body["output_config"],
        json!({"format":{"type":"json_schema","schema":{"type":"object","properties":{},"additionalProperties":false}}})
    );
    assert!(!body.to_string().contains("cache_control"));
}
