mod anthropic;
mod realtime;
mod text;

pub use anthropic::{
    Anthropic, CarryKey, CountSource, InputCount, ModelProfile, PreparedText, Reasoning,
};
pub use realtime::{LiveAuth, LiveClient, LiveConfig, LiveEvent, LiveSession};
pub use text::{
    AssistantMessage, Effort, Image, Message, Output, Part, Picture, TextClass, TextRequest, Tool,
    ToolCall, ToolResult, ValidationError,
};

use serde::Serialize;
use zeroize::Zeroize;

pub const MAX_TEXT_BODY: usize = 8 * 1024 * 1024;
pub const MAX_AUDIO_FRAME: usize = 64 * 1024;
pub(crate) const MAX_PROVIDER_FRAME: usize = 1024 * 1024;
pub(crate) const MAX_PROVIDER_RESPONSE: usize = 16 * 1024 * 1024;
pub(crate) const MAX_REFUSAL_BODY: usize = 16 * 1024;

pub struct Secret(String);

impl Secret {
    pub fn new(value: String) -> Self {
        Self(value)
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCode {
    ProviderRejected,
    ProviderUnavailable,
    ProviderFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Certainty {
    Unconsumed,
    Assumed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    Configuration,
    Connect,
    HttpStatus,
    KeyOrAccount,
    Timeout,
    Transport,
    Protocol,
    Limit,
    ProviderError,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RefusalReason {
    SchemaTooComplex,
    TooManyStrictTools,
    TooManyOptionalParameters,
    TooManyUnionParameters,
    SchemaUnsupported,
    PromptTooLong,
    MaxTokens,
    InvalidRequestOther,
    RequestTooLarge,
    Unparsed,
}

impl RefusalReason {
    // A row matches when the lowercased message holds every one of its fragments; the first row wins.
    const PATTERNS: [(Self, &'static [&'static str]); 19] = [
        (Self::SchemaTooComplex, &["too complex"]),
        (Self::TooManyOptionalParameters, &["optional param"]),
        (Self::TooManyUnionParameters, &["union"]),
        (Self::TooManyUnionParameters, &["anyof"]),
        (Self::TooManyUnionParameters, &["type array"]),
        (Self::TooManyStrictTools, &["strict", "tool", "limit"]),
        (Self::TooManyStrictTools, &["strict", "tool", "maximum"]),
        (Self::TooManyStrictTools, &["strict", "tool", "too many"]),
        (Self::TooManyStrictTools, &["strict", "tool", "count"]),
        (Self::SchemaUnsupported, &["unsupported", "schema"]),
        (Self::SchemaUnsupported, &["not supported", "schema"]),
        (Self::SchemaUnsupported, &["unsupported", "tools."]),
        (Self::SchemaUnsupported, &["not supported", "tools."]),
        (Self::PromptTooLong, &["prompt is too long"]),
        (Self::PromptTooLong, &["prompt too long"]),
        (Self::PromptTooLong, &["context window"]),
        (Self::PromptTooLong, &["context limit"]),
        (Self::PromptTooLong, &["maximum", "input"]),
        (Self::MaxTokens, &["max_tokens"]),
    ];

    pub(crate) fn classify(status: u16, body: &[u8]) -> Self {
        if status == 413 {
            return Self::RequestTooLarge;
        }
        let body = &body[..body.len().min(MAX_REFUSAL_BODY)];
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) else {
            return Self::Unparsed;
        };
        let Some(kind) = value["error"]["type"].as_str() else {
            return Self::Unparsed;
        };
        if kind == "request_too_large" {
            return Self::RequestTooLarge;
        }
        let message = value["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .to_lowercase();
        Self::PATTERNS
            .iter()
            .find(|(_, fragments)| fragments.iter().all(|fragment| message.contains(fragment)))
            .map_or(Self::InvalidRequestOther, |(reason, _)| *reason)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::SchemaTooComplex => "schema_too_complex",
            Self::TooManyStrictTools => "too_many_strict_tools",
            Self::TooManyOptionalParameters => "too_many_optional_parameters",
            Self::TooManyUnionParameters => "too_many_union_parameters",
            Self::SchemaUnsupported => "schema_unsupported",
            Self::PromptTooLong => "prompt_too_long",
            Self::MaxTokens => "max_tokens",
            Self::InvalidRequestOther => "invalid_request_other",
            Self::RequestTooLarge => "request_too_large",
            Self::Unparsed => "unparsed",
        }
    }
}

#[derive(Clone)]
pub struct ProviderFailure {
    pub code: FailureCode,
    pub certainty: Certainty,
    pub kind: FailureKind,
    pub http_status: Option<u16>,
    pub request_id: Option<String>,
    pub key_account_fault: bool,
    pub refusal: Option<RefusalReason>,
}

impl ProviderFailure {
    pub(crate) fn new(code: FailureCode, certainty: Certainty, kind: FailureKind) -> Self {
        Self {
            code,
            certainty,
            kind,
            http_status: None,
            request_id: None,
            key_account_fault: false,
            refusal: None,
        }
    }

    pub(crate) fn protocol() -> Self {
        Self::new(
            FailureCode::ProviderFailed,
            Certainty::Assumed,
            FailureKind::Protocol,
        )
    }

    pub(crate) fn configuration() -> Self {
        Self::new(
            FailureCode::ProviderUnavailable,
            Certainty::Unconsumed,
            FailureKind::Configuration,
        )
    }

    pub(crate) fn status(status: u16, request_id: Option<String>, body: &[u8]) -> Self {
        let key_account_fault = matches!(status, 401..=403);
        let rejected = matches!(status, 400 | 413 | 422);
        Self {
            code: if rejected {
                FailureCode::ProviderRejected
            } else {
                FailureCode::ProviderUnavailable
            },
            certainty: Certainty::Unconsumed,
            kind: if key_account_fault {
                FailureKind::KeyOrAccount
            } else {
                FailureKind::HttpStatus
            },
            http_status: Some(status),
            request_id,
            key_account_fault,
            refusal: rejected.then(|| RefusalReason::classify(status, body)),
        }
    }
}

impl std::fmt::Debug for ProviderFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderFailure")
            .field("code", &self.code)
            .field("certainty", &self.certainty)
            .field("kind", &self.kind)
            .field("http_status", &self.http_status)
            .field("key_account_fault", &self.key_account_fault)
            .field("refusal", &self.refusal.map(RefusalReason::as_str))
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stop {
    Completed,
    ToolCalls,
    Truncated,
    Declined,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_5m_input_tokens: u64,
    pub cache_creation_1h_input_tokens: u64,
    pub output_tokens: u64,
}

pub enum TextEvent {
    Text {
        delta: String,
    },
    ToolCall {
        id: String,
        name: String,
        input: serde_json::Value,
    },
}

pub struct TextOutcome {
    pub usage: Option<Usage>,
    pub message: Option<AssistantMessage>,
    pub stop: Option<Stop>,
    pub failure: Option<ProviderFailure>,
    pub request_id: Option<String>,
    pub http_status: Option<u16>,
}

impl TextOutcome {
    pub(crate) fn failed(failure: ProviderFailure) -> Self {
        Self {
            request_id: failure.request_id.clone(),
            http_status: failure.http_status,
            usage: None,
            message: None,
            stop: None,
            failure: Some(failure),
        }
    }
}

pub(crate) fn request_id(value: Option<&str>) -> Option<String> {
    value
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anthropic(kind: &str, message: &str) -> Vec<u8> {
        serde_json::to_vec(
            &serde_json::json!({"type":"error","error":{"type":kind,"message":message}}),
        )
        .unwrap()
    }

    #[test]
    fn refusals_classify_from_the_provider_error_into_a_fixed_label() {
        for (status, body, reason) in [
            (
                400,
                anthropic(
                    "invalid_request_error",
                    "Schema is too complex for compilation.",
                ),
                RefusalReason::SchemaTooComplex,
            ),
            (
                400,
                anthropic(
                    "invalid_request_error",
                    "Too many strict tools: a request may define at most 20 tools with strict: true.",
                ),
                RefusalReason::TooManyStrictTools,
            ),
            (
                400,
                anthropic(
                    "invalid_request_error",
                    "The number of strict tools exceeds the limit of 20.",
                ),
                RefusalReason::TooManyStrictTools,
            ),
            (
                400,
                anthropic(
                    "invalid_request_error",
                    "Too many optional parameters across strict tool schemas (36 > 24).",
                ),
                RefusalReason::TooManyOptionalParameters,
            ),
            (
                400,
                anthropic(
                    "invalid_request_error",
                    "Too many parameters with union types in strict tool schemas.",
                ),
                RefusalReason::TooManyUnionParameters,
            ),
            (
                400,
                anthropic(
                    "invalid_request_error",
                    "tools.3.custom.input_schema: anyOf is limited to 16 parameters.",
                ),
                RefusalReason::TooManyUnionParameters,
            ),
            (
                400,
                anthropic(
                    "invalid_request_error",
                    "tools.0.custom.input_schema: The 'format' keyword value 'hostname' is not supported.",
                ),
                RefusalReason::SchemaUnsupported,
            ),
            (
                400,
                anthropic(
                    "invalid_request_error",
                    "Unsupported JSON schema property 'minItems' in tool schema.",
                ),
                RefusalReason::SchemaUnsupported,
            ),
            (
                400,
                anthropic(
                    "invalid_request_error",
                    "prompt is too long: 214213 tokens > 200000 maximum",
                ),
                RefusalReason::PromptTooLong,
            ),
            (
                400,
                anthropic(
                    "invalid_request_error",
                    "input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000, decrease input length or `max_tokens` and try again",
                ),
                RefusalReason::PromptTooLong,
            ),
            (
                400,
                anthropic(
                    "invalid_request_error",
                    "max_tokens: 100000 > 64000, which is the maximum allowed number of output tokens for claude-opus-5",
                ),
                RefusalReason::MaxTokens,
            ),
            (
                400,
                anthropic(
                    "invalid_request_error",
                    "messages: text content blocks must be non-empty",
                ),
                RefusalReason::InvalidRequestOther,
            ),
            (
                413,
                anthropic(
                    "request_too_large",
                    "Request exceeds the maximum allowed number of bytes.",
                ),
                RefusalReason::RequestTooLarge,
            ),
            (
                413,
                b"<html>413 Request Entity Too Large</html>".to_vec(),
                RefusalReason::RequestTooLarge,
            ),
            (
                400,
                anthropic(
                    "request_too_large",
                    "Request exceeds the maximum allowed number of bytes.",
                ),
                RefusalReason::RequestTooLarge,
            ),
            (
                400,
                b"<html>Bad Request</html>".to_vec(),
                RefusalReason::Unparsed,
            ),
            (
                422,
                br#"{"message":"unprocessable"}"#.to_vec(),
                RefusalReason::Unparsed,
            ),
            (400, Vec::new(), RefusalReason::Unparsed),
        ] {
            assert_eq!(
                RefusalReason::classify(status, &body),
                reason,
                "{}",
                String::from_utf8_lossy(&body)
            );
            assert_eq!(serde_json::to_value(reason).unwrap(), reason.as_str());
        }
    }

    #[test]
    fn a_refusal_carries_its_label_and_debug_never_shows_the_message() {
        let failure = ProviderFailure::status(
            400,
            Some("req_011".into()),
            &anthropic(
                "invalid_request_error",
                "Schema is too complex: PRIVATE_TOOL_NAME",
            ),
        );
        assert_eq!(failure.refusal, Some(RefusalReason::SchemaTooComplex));
        let debug = format!("{failure:?}");
        assert!(debug.contains("schema_too_complex"));
        assert!(!debug.contains("PRIVATE_TOOL_NAME"));
        assert_eq!(
            ProviderFailure::status(429, None, &anthropic("rate_limit_error", "slow down")).refusal,
            None
        );
    }
}
