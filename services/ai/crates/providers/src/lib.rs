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

#[derive(Clone)]
pub struct ProviderFailure {
    pub code: FailureCode,
    pub certainty: Certainty,
    pub kind: FailureKind,
    pub http_status: Option<u16>,
    pub request_id: Option<String>,
    pub key_account_fault: bool,
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

    pub(crate) fn status(status: u16, request_id: Option<String>) -> Self {
        let key_account_fault = matches!(status, 401..=403);
        Self {
            code: if matches!(status, 400 | 413 | 422) {
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
