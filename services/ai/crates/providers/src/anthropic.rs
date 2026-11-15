use std::collections::BTreeMap;
use std::time::Duration;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, OsRng, rand_core::RngCore},
};
use futures_util::StreamExt;
use reqwest::{
    Client, Url,
    header::{HeaderMap, HeaderValue},
};
use serde_json::{Value, json};
use zeroize::Zeroize;

use crate::{
    AssistantMessage, Certainty, Effort, FailureCode, FailureKind, MAX_PROVIDER_FRAME,
    MAX_PROVIDER_RESPONSE, MAX_TEXT_BODY, Message, Part, ProviderFailure, Secret, Stop, TextEvent,
    TextOutcome, TextRequest, ToolCall, Usage, ValidationError, request_id,
};

pub struct CarryKey([u8; 32]);

impl CarryKey {
    pub fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    fn seal(&self, content: &[Value]) -> Result<String, ProviderFailure> {
        let bytes = serde_json::to_vec(content).map_err(|_| ProviderFailure::protocol())?;
        let mut nonce = [0u8; 24];
        OsRng
            .try_fill_bytes(&mut nonce)
            .map_err(|_| ProviderFailure::configuration())?;
        let cipher = XChaCha20Poly1305::new((&self.0).into());
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                chacha20poly1305::aead::Payload {
                    msg: &bytes,
                    aad: b"windmill-ai-carry.v1",
                },
            )
            .map_err(|_| ProviderFailure::protocol())?;
        let mut sealed = Vec::with_capacity(nonce.len() + ciphertext.len());
        sealed.extend_from_slice(&nonce);
        sealed.extend_from_slice(&ciphertext);
        Ok(format!("wm-carry.v1.{}", URL_SAFE_NO_PAD.encode(sealed)))
    }

    fn open(&self, carry: &str) -> Option<Vec<Value>> {
        if carry.len() > MAX_TEXT_BODY {
            return None;
        }
        let sealed = URL_SAFE_NO_PAD
            .decode(carry.strip_prefix("wm-carry.v1.")?)
            .ok()?;
        if sealed.len() < 40 {
            return None;
        }
        let cipher = XChaCha20Poly1305::new((&self.0).into());
        let mut bytes = cipher
            .decrypt(
                XNonce::from_slice(&sealed[..24]),
                chacha20poly1305::aead::Payload {
                    msg: &sealed[24..],
                    aad: b"windmill-ai-carry.v1",
                },
            )
            .ok()?;
        let content = serde_json::from_slice(&bytes).ok();
        bytes.zeroize();
        content
    }
}

impl Drop for CarryKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Reasoning {
    Adaptive,
    Budget,
    Disabled,
}

pub struct ModelProfile {
    pub model: String,
    pub reasoning: Reasoning,
    pub max_effort: Effort,
    pub image_token_ceiling: u64,
    pub tool_overhead_tokens: u64,
}

pub struct PreparedText {
    body: Value,
    fallback_input: u64,
    cache: bool,
    max_tokens: u32,
    min_tokens: u32,
    model: String,
}

impl PreparedText {
    pub fn cache(&self) -> bool {
        self.cache
    }
    pub fn model(&self) -> &str {
        &self.model
    }
    pub fn max_tokens(&self) -> u32 {
        self.max_tokens
    }
    pub fn min_tokens(&self) -> u32 {
        self.min_tokens
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CountSource {
    Provider,
    Fallback,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InputCount {
    pub input_tokens: u64,
    pub source: CountSource,
}

pub struct Anthropic {
    client: Client,
    messages_url: Url,
    count_url: Url,
    carry_key: CarryKey,
}

impl Anthropic {
    pub fn new(
        base_url: &str,
        api_key: Secret,
        carry_key: CarryKey,
    ) -> Result<Self, ProviderFailure> {
        let url = Url::parse(base_url).map_err(|_| ProviderFailure::configuration())?;
        if !matches!(url.scheme(), "https" | "http")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(ProviderFailure::configuration());
        }
        let mut headers = HeaderMap::new();
        let mut key = HeaderValue::from_str(api_key.expose())
            .map_err(|_| ProviderFailure::configuration())?;
        key.set_sensitive(true);
        headers.insert("x-api-key", key);
        headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        let client = Client::builder()
            .default_headers(headers)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .referer(false)
            .connection_verbose(false)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(600))
            .build()
            .map_err(|_| ProviderFailure::configuration())?;
        let base = format!("{}/", url.as_str().trim_end_matches('/'));
        let base = Url::parse(&base).map_err(|_| ProviderFailure::configuration())?;
        Ok(Self {
            client,
            messages_url: base
                .join("v1/messages")
                .map_err(|_| ProviderFailure::configuration())?,
            count_url: base
                .join("v1/messages/count_tokens")
                .map_err(|_| ProviderFailure::configuration())?,
            carry_key,
        })
    }

    pub fn prepare(
        &self,
        request: TextRequest,
        profile: &ModelProfile,
    ) -> Result<PreparedText, ValidationError> {
        request.validate()?;
        if profile.model.is_empty()
            || profile.image_token_ceiling == 0
            || profile.tool_overhead_tokens == 0
        {
            return Err(ValidationError::InvalidRequest);
        }
        let mut tools: Vec<Value> = request
            .tools
            .into_iter()
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.input,
                    "strict": true,
                })
            })
            .collect();
        let mut system: Vec<Value> = request
            .system
            .into_iter()
            .map(|text| json!({"type":"text","text":text}))
            .collect();
        let mut messages = Vec::new();
        let mut image_count = 0u64;
        for message in request.messages {
            let (role, content) = match message {
                Message::Tool { results } => {
                    let content = results
                        .into_iter()
                        .map(|result| {
                            json!({
                                "type": "tool_result",
                                "tool_use_id": result.id,
                                "content": result.content,
                                "is_error": result.is_error,
                            })
                        })
                        .collect();
                    ("user", content)
                }
                Message::User { parts } => {
                    let mut content = Vec::new();
                    for part in parts {
                        match part {
                            Part::Text { text } => content.push(json!({"type":"text","text":text})),
                            Part::Image { image } => {
                                image_count += 1;
                                content.push(json!({
                                    "type": "image",
                                    "source": {"type":"base64", "media_type":image.media_type, "data":image.data},
                                }));
                            }
                            Part::ToolCall { .. } | Part::Picture { .. } => {
                                return Err(ValidationError::InvalidRequest);
                            }
                        }
                    }
                    ("user", content)
                }
                Message::Assistant { parts, carry } => {
                    let content = match carry
                        .as_deref()
                        .and_then(|carry| self.carry_key.open(carry))
                    {
                        Some(content) => content,
                        None => {
                            let mut content = Vec::new();
                            for part in parts {
                                match part {
                                    Part::Text { text } => {
                                        content.push(json!({"type":"text", "text":text}))
                                    }
                                    Part::ToolCall { tool_call } => content.push(json!({
                                        "type":"tool_use", "id":tool_call.id,
                                        "name":tool_call.name, "input":tool_call.input,
                                    })),
                                    Part::Image { .. } | Part::Picture { .. } => {
                                        return Err(ValidationError::InvalidRequest);
                                    }
                                }
                            }
                            content
                        }
                    };
                    ("assistant", content)
                }
            };
            messages.push(json!({"role":role,"content":content}));
        }
        if request.cache {
            if let Some(last) = system.last_mut() {
                last["cache_control"] = json!({"type":"ephemeral","ttl":"5m"});
            } else if let Some(last) = tools.last_mut() {
                last["cache_control"] = json!({"type":"ephemeral","ttl":"5m"});
            }
            if let Some(last) = messages
                .last_mut()
                .and_then(|message| message["content"].as_array_mut())
                .and_then(|content| {
                    content.iter_mut().rev().find(|block| {
                        matches!(
                            block["type"].as_str(),
                            Some("text" | "image" | "tool_use" | "tool_result")
                        )
                    })
                })
            {
                last["cache_control"] = json!({"type":"ephemeral","ttl":"5m"});
            }
        }
        let tool_overhead = if tools.is_empty() {
            0
        } else {
            profile.tool_overhead_tokens
        };
        let mut body = json!({
            "model": profile.model,
            "system": system,
            "messages": messages,
            "tools": tools,
            "max_tokens": request.output.max_tokens,
            "stream": true,
        });
        if profile.reasoning == Reasoning::Adaptive {
            body["thinking"] = json!({"type":"adaptive"});
            body["output_config"] = json!({"effort":request.effort.min(profile.max_effort)});
        }
        if profile.reasoning == Reasoning::Budget
            && request
                .output
                .min_tokens
                .unwrap_or(request.output.max_tokens)
                > 1024
        {
            body["thinking"] = json!({"type":"enabled","budget_tokens":1024});
        }
        if let Some(schema) = request.output.schema {
            body["output_config"]["format"] = json!({"type":"json_schema","schema":schema});
        }
        let bytes = serde_json::to_vec(&body).map_err(|_| ValidationError::InvalidRequest)?;
        if bytes.len() > MAX_TEXT_BODY {
            return Err(ValidationError::TooLarge);
        }
        let input = (bytes.len() as u64)
            .checked_add(
                image_count
                    .checked_mul(profile.image_token_ceiling)
                    .ok_or(ValidationError::InvalidRequest)?,
            )
            .and_then(|sum| sum.checked_add(tool_overhead))
            .ok_or(ValidationError::InvalidRequest)?;
        Ok(PreparedText {
            body,
            fallback_input: input,
            cache: request.cache,
            max_tokens: request.output.max_tokens,
            min_tokens: request
                .output
                .min_tokens
                .unwrap_or(request.output.max_tokens),
            model: profile.model.clone(),
        })
    }

    pub async fn count(&self, prepared: &PreparedText) -> Result<InputCount, ProviderFailure> {
        let count = async {
            let mut body = prepared.body.clone();
            let object = body.as_object_mut().ok_or_else(ProviderFailure::protocol)?;
            object.remove("stream");
            object.remove("max_tokens");
            let response = self
                .client
                .post(self.count_url.clone())
                .json(&body)
                .send()
                .await
                .map_err(|_| {
                    ProviderFailure::new(
                        FailureCode::ProviderUnavailable,
                        Certainty::Unconsumed,
                        FailureKind::Transport,
                    )
                })?;
            let status = response.status().as_u16();
            let id = request_id(
                response
                    .headers()
                    .get("request-id")
                    .and_then(|value| value.to_str().ok()),
            );
            if !response.status().is_success() {
                return Err(ProviderFailure::status(status, id));
            }
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| ProviderFailure::protocol())?;
                if bytes.len() + chunk.len() > MAX_PROVIDER_FRAME {
                    return Err(ProviderFailure::protocol());
                }
                bytes.extend_from_slice(&chunk);
            }
            let value: Value =
                serde_json::from_slice(&bytes).map_err(|_| ProviderFailure::protocol())?;
            let input = value["input_tokens"]
                .as_u64()
                .ok_or_else(ProviderFailure::protocol)?;
            Ok(InputCount {
                input_tokens: input,
                source: CountSource::Provider,
            })
        };
        match tokio::time::timeout(Duration::from_secs(2), count).await {
            Ok(Ok(count)) => Ok(count),
            Ok(Err(failure))
                if failure.code == FailureCode::ProviderRejected || failure.key_account_fault =>
            {
                Err(failure)
            }
            _ => Ok(InputCount {
                input_tokens: prepared.fallback_input,
                source: CountSource::Fallback,
            }),
        }
    }

    pub async fn run<F: FnMut(TextEvent) + Send>(
        &self,
        mut prepared: PreparedText,
        max_tokens: u32,
        mut emit: F,
    ) -> TextOutcome {
        if max_tokens == 0 || max_tokens > prepared.max_tokens || max_tokens < prepared.min_tokens {
            return TextOutcome::failed(ProviderFailure::new(
                FailureCode::ProviderRejected,
                Certainty::Unconsumed,
                FailureKind::Configuration,
            ));
        }
        prepared.body["max_tokens"] = json!(max_tokens);
        let response = self
            .client
            .post(self.messages_url.clone())
            .json(&prepared.body)
            .send();
        drop(prepared);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
        let response = match tokio::time::timeout_at(deadline, response).await {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                let (code, certainty, kind) = if error.is_connect() || error.is_builder() {
                    (
                        FailureCode::ProviderUnavailable,
                        Certainty::Unconsumed,
                        FailureKind::Connect,
                    )
                } else if error.is_timeout() {
                    (
                        FailureCode::ProviderFailed,
                        Certainty::Assumed,
                        FailureKind::Timeout,
                    )
                } else {
                    (
                        FailureCode::ProviderFailed,
                        Certainty::Assumed,
                        FailureKind::Transport,
                    )
                };
                return TextOutcome::failed(ProviderFailure::new(code, certainty, kind));
            }
            Err(_) => {
                return TextOutcome::failed(ProviderFailure::new(
                    FailureCode::ProviderFailed,
                    Certainty::Assumed,
                    FailureKind::Timeout,
                ));
            }
        };
        let status = response.status().as_u16();
        let id = request_id(
            response
                .headers()
                .get("request-id")
                .and_then(|value| value.to_str().ok()),
        );
        if !response.status().is_success() {
            return TextOutcome::failed(ProviderFailure::status(status, id));
        }
        let mut parser = EventStream::default();
        let mut message = AnthropicMessage::default();
        let mut stream = response.bytes_stream();
        let mut total = 0usize;
        let mut failure = None;
        let result = async {
            while let Some(chunk) = stream.next().await {
                let chunk = match chunk {
                    Ok(chunk) => chunk,
                    Err(_) => {
                        return Err(failure.unwrap_or_else(|| {
                            ProviderFailure::new(
                                FailureCode::ProviderFailed,
                                Certainty::Assumed,
                                FailureKind::Transport,
                            )
                        }));
                    }
                };
                if failure.is_some() {
                    continue;
                }
                total = total.saturating_add(chunk.len());
                if total > MAX_PROVIDER_RESPONSE {
                    failure = Some(ProviderFailure::new(
                        FailureCode::ProviderFailed,
                        Certainty::Assumed,
                        FailureKind::Limit,
                    ));
                } else {
                    match parser.push(&chunk) {
                        Ok(frames) => {
                            for frame in frames {
                                match message.accept(frame, &mut emit) {
                                    Ok(true) => return message.finish(&self.carry_key),
                                    Ok(false) => {}
                                    Err(error) => {
                                        failure = Some(error);
                                        break;
                                    }
                                }
                            }
                        }
                        Err(error) => failure = Some(error),
                    }
                }
                if failure.is_some() {
                    parser.bytes.clear();
                    message = AnthropicMessage::default();
                }
            }
            Err(failure.unwrap_or_else(ProviderFailure::protocol))
        };
        let mut outcome = match tokio::time::timeout_at(deadline, result).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(failure)) => TextOutcome::failed(failure),
            Err(_) => TextOutcome::failed(ProviderFailure::new(
                FailureCode::ProviderFailed,
                Certainty::Assumed,
                FailureKind::Timeout,
            )),
        };
        outcome.request_id = id.clone();
        outcome.http_status = Some(status);
        if let Some(failure) = &mut outcome.failure {
            failure.request_id = id;
            failure.http_status = Some(status);
        }
        outcome
    }
}

#[derive(Default)]
struct EventStream {
    bytes: Vec<u8>,
}

impl EventStream {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>, ProviderFailure> {
        self.bytes.extend_from_slice(chunk);
        let mut frames = Vec::new();
        loop {
            let separator = self
                .bytes
                .windows(2)
                .position(|bytes| bytes == b"\n\n")
                .map(|index| (index, 2))
                .into_iter()
                .chain(
                    self.bytes
                        .windows(4)
                        .position(|bytes| bytes == b"\r\n\r\n")
                        .map(|index| (index, 4)),
                )
                .min_by_key(|(index, _)| *index);
            let Some((end, separator_length)) = separator else {
                break;
            };
            if end > MAX_PROVIDER_FRAME {
                return Err(ProviderFailure::protocol());
            }
            let frame =
                std::str::from_utf8(&self.bytes[..end]).map_err(|_| ProviderFailure::protocol())?;
            let mut data = String::new();
            let mut name = None;
            for line in frame.lines() {
                if let Some(value) = line.strip_prefix("event:") {
                    name = Some(value.trim());
                }
                if let Some(value) = line.strip_prefix("data:") {
                    if !data.is_empty() {
                        data.push('\n');
                    }
                    data.push_str(value.strip_prefix(' ').unwrap_or(value));
                }
            }
            if !data.is_empty() {
                let value: Value =
                    serde_json::from_str(&data).map_err(|_| ProviderFailure::protocol())?;
                if let Some(name) = name
                    && value["type"].as_str() != Some(name)
                {
                    return Err(ProviderFailure::protocol());
                }
                frames.push(value);
            }
            self.bytes.drain(..end + separator_length);
        }
        if self.bytes.len() > MAX_PROVIDER_FRAME {
            return Err(ProviderFailure::protocol());
        }
        Ok(frames)
    }
}

struct Block {
    value: Value,
    json: String,
    complete: bool,
    invalid_tool: bool,
}

#[derive(Default)]
struct AnthropicMessage {
    started: bool,
    delta: bool,
    blocks: BTreeMap<u64, Block>,
    usage: Option<Usage>,
    stop: Option<Stop>,
    unknown_stop: bool,
}

impl AnthropicMessage {
    fn accept(
        &mut self,
        value: Value,
        emit: &mut impl FnMut(TextEvent),
    ) -> Result<bool, ProviderFailure> {
        let kind = value["type"]
            .as_str()
            .ok_or_else(ProviderFailure::protocol)?;
        match kind {
            "ping" => {}
            "error" => {
                return Err(ProviderFailure::new(
                    FailureCode::ProviderFailed,
                    Certainty::Assumed,
                    FailureKind::ProviderError,
                ));
            }
            "message_start" => {
                if self.started
                    || value["message"]["role"] != "assistant"
                    || value["message"]["content"]
                        .as_array()
                        .is_none_or(|content| !content.is_empty())
                {
                    return Err(ProviderFailure::protocol());
                }
                self.started = true;
                self.usage = parse_usage(&value["message"]["usage"]);
            }
            "content_block_start" => {
                if !self.started || self.delta {
                    return Err(ProviderFailure::protocol());
                }
                let index = value["index"]
                    .as_u64()
                    .ok_or_else(ProviderFailure::protocol)?;
                if index != self.blocks.len() as u64
                    || self.blocks.values().any(|block| !block.complete)
                {
                    return Err(ProviderFailure::protocol());
                }
                let block = value["content_block"].clone();
                match block["type"].as_str() {
                    Some("text") => {
                        let text = block["text"]
                            .as_str()
                            .ok_or_else(ProviderFailure::protocol)?;
                        if !text.is_empty() {
                            emit(TextEvent::Text {
                                delta: text.to_owned(),
                            });
                        }
                    }
                    Some("tool_use") => {
                        if block["id"].as_str().is_none()
                            || block["name"].as_str().is_none()
                            || !block["input"].is_object()
                        {
                            return Err(ProviderFailure::protocol());
                        }
                    }
                    Some("thinking") => {
                        if block["thinking"].as_str().is_none() {
                            return Err(ProviderFailure::protocol());
                        }
                    }
                    Some("redacted_thinking") => {
                        if block["data"].as_str().is_none() {
                            return Err(ProviderFailure::protocol());
                        }
                    }
                    _ => return Err(ProviderFailure::protocol()),
                }
                self.blocks.insert(
                    index,
                    Block {
                        value: block,
                        json: String::new(),
                        complete: false,
                        invalid_tool: false,
                    },
                );
            }
            "content_block_delta" => {
                let index = value["index"]
                    .as_u64()
                    .ok_or_else(ProviderFailure::protocol)?;
                let block = self
                    .blocks
                    .get_mut(&index)
                    .filter(|block| !block.complete)
                    .ok_or_else(ProviderFailure::protocol)?;
                let delta = &value["delta"];
                let (field, expected) = match delta["type"].as_str() {
                    Some("text_delta") => ("text", "text"),
                    Some("thinking_delta") => ("thinking", "thinking"),
                    Some("signature_delta") => ("signature", "thinking"),
                    Some("input_json_delta") => ("partial_json", "tool_use"),
                    _ => return Err(ProviderFailure::protocol()),
                };
                if block.value["type"] != expected {
                    return Err(ProviderFailure::protocol());
                }
                let text = delta[field]
                    .as_str()
                    .ok_or_else(ProviderFailure::protocol)?;
                if field == "partial_json" {
                    block.json.push_str(text);
                } else {
                    let mut whole = block.value[field].as_str().unwrap_or_default().to_owned();
                    whole.push_str(text);
                    block.value[field] = Value::String(whole);
                    if field == "text" {
                        emit(TextEvent::Text {
                            delta: text.to_owned(),
                        });
                    }
                }
            }
            "content_block_stop" => {
                let index = value["index"]
                    .as_u64()
                    .ok_or_else(ProviderFailure::protocol)?;
                let block = self
                    .blocks
                    .get_mut(&index)
                    .filter(|block| !block.complete)
                    .ok_or_else(ProviderFailure::protocol)?;
                block.complete = true;
                if block.value["type"] == "tool_use" {
                    if !block.json.is_empty() {
                        match serde_json::from_str::<Value>(&block.json) {
                            Ok(input) if input.is_object() => block.value["input"] = input,
                            _ => block.invalid_tool = true,
                        }
                    }
                    if !block.invalid_tool {
                        emit(TextEvent::ToolCall {
                            id: block.value["id"]
                                .as_str()
                                .ok_or_else(ProviderFailure::protocol)?
                                .to_owned(),
                            name: block.value["name"]
                                .as_str()
                                .ok_or_else(ProviderFailure::protocol)?
                                .to_owned(),
                            input: block.value["input"].clone(),
                        });
                    }
                }
            }
            "message_delta" => {
                if !self.started || self.blocks.values().any(|block| !block.complete) {
                    return Err(ProviderFailure::protocol());
                }
                self.delta = true;
                if let Some(usage) = &mut self.usage {
                    if let Some(output) = value["usage"]["output_tokens"].as_u64() {
                        usage.output_tokens = output;
                    } else {
                        self.usage = None;
                    }
                }
                if let Some(reason) = value["delta"]["stop_reason"].as_str() {
                    self.stop = match reason {
                        "end_turn" => Some(Stop::Completed),
                        "tool_use" => Some(Stop::ToolCalls),
                        "max_tokens" => Some(Stop::Truncated),
                        "refusal" => Some(Stop::Declined),
                        _ => None,
                    };
                    self.unknown_stop = self.stop.is_none();
                }
            }
            "message_stop" => {
                if !self.started
                    || !self.delta
                    || (self.stop.is_none() && !self.unknown_stop)
                    || self.blocks.values().any(|block| !block.complete)
                {
                    return Err(ProviderFailure::protocol());
                }
                return Ok(true);
            }
            _ => {}
        }
        Ok(false)
    }

    fn finish(self, key: &CarryKey) -> Result<TextOutcome, ProviderFailure> {
        let invalid_tool = self.blocks.values().any(|block| block.invalid_tool);
        let mut content = Vec::new();
        let mut parts = Vec::new();
        for block in self
            .blocks
            .into_values()
            .filter(|block| block.complete && !block.invalid_tool)
        {
            match block.value["type"].as_str() {
                Some("text") => parts.push(Part::Text {
                    text: block.value["text"]
                        .as_str()
                        .ok_or_else(ProviderFailure::protocol)?
                        .to_owned(),
                }),
                Some("tool_use") => parts.push(Part::ToolCall {
                    tool_call: ToolCall {
                        id: block.value["id"]
                            .as_str()
                            .ok_or_else(ProviderFailure::protocol)?
                            .to_owned(),
                        name: block.value["name"]
                            .as_str()
                            .ok_or_else(ProviderFailure::protocol)?
                            .to_owned(),
                        input: block.value["input"].clone(),
                    },
                }),
                _ => {}
            }
            content.push(block.value);
        }
        let failure = if self.unknown_stop || (invalid_tool && self.stop != Some(Stop::Truncated)) {
            Some(ProviderFailure::protocol())
        } else {
            None
        };
        Ok(TextOutcome {
            usage: self.usage,
            message: Some(AssistantMessage {
                role: "assistant",
                parts,
                carry: key.seal(&content)?,
            }),
            stop: self.stop,
            failure,
            request_id: None,
            http_status: None,
        })
    }
}

fn parse_usage(value: &Value) -> Option<Usage> {
    let input_tokens = value["input_tokens"].as_u64()?;
    let cache_creation_input_tokens = value
        .get("cache_creation_input_tokens")
        .filter(|value| !value.is_null())
        .map(Value::as_u64)
        .unwrap_or(Some(0))?;
    let cache_read_input_tokens = value
        .get("cache_read_input_tokens")
        .filter(|value| !value.is_null())
        .map(Value::as_u64)
        .unwrap_or(Some(0))?;
    let (cache_creation_5m_input_tokens, cache_creation_1h_input_tokens) =
        if value["cache_creation"].is_object() {
            (
                value["cache_creation"]["ephemeral_5m_input_tokens"].as_u64()?,
                value["cache_creation"]["ephemeral_1h_input_tokens"].as_u64()?,
            )
        } else {
            (cache_creation_input_tokens, 0)
        };
    if cache_creation_5m_input_tokens.checked_add(cache_creation_1h_input_tokens)?
        != cache_creation_input_tokens
    {
        return None;
    }
    if value
        .get("server_tool_use")
        .and_then(Value::as_object)
        .is_some_and(|counts| counts.values().any(|count| count.as_u64() != Some(0)))
    {
        return None;
    }
    Some(Usage {
        input_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        cache_creation_5m_input_tokens,
        cache_creation_1h_input_tokens,
        output_tokens: 0,
    })
}

#[cfg(test)]
#[path = "../tests/anthropic_stream.rs"]
mod tests;
