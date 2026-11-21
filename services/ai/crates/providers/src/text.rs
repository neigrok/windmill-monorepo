use std::collections::HashSet;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::MAX_TEXT_BODY;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ValidationError {
    InvalidRequest,
    TooLarge,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TextClass {
    Large,
    Medium,
    Small,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, Eq, PartialEq, Ord, PartialOrd)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    #[default]
    High,
    Xhigh,
    Max,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TextRequest {
    pub model: TextClass,
    #[serde(default)]
    pub system: Vec<String>,
    #[serde(default)]
    pub tools: Vec<Tool>,
    pub messages: Vec<Message>,
    pub output: Output,
    #[serde(default)]
    pub effort: Effort,
    #[serde(default = "cache_default")]
    pub cache: bool,
}

fn cache_default() -> bool {
    true
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Output {
    pub max_tokens: u32,
    pub min_tokens: Option<u32>,
    pub schema: Option<Value>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub input: Value,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "role", rename_all = "lowercase", deny_unknown_fields)]
pub enum Message {
    User {
        parts: Vec<Part>,
    },
    Assistant {
        parts: Vec<Part>,
        carry: Option<String>,
    },
    Tool {
        results: Vec<ToolResult>,
    },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum Part {
    Text {
        text: String,
    },
    Image {
        image: Image,
    },
    Picture {
        image: Picture,
    },
    ToolCall {
        #[serde(rename = "toolCall")]
        tool_call: ToolCall,
    },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Picture {
    pub picture: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Image {
    pub media_type: String,
    pub data: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ToolResult {
    pub id: String,
    pub content: String,
    pub is_error: bool,
}

#[derive(Serialize)]
pub struct AssistantMessage {
    pub role: &'static str,
    pub parts: Vec<Part>,
    pub carry: String,
}

impl TextRequest {
    pub fn parse(bytes: &[u8]) -> Result<Self, ValidationError> {
        if bytes.len() > MAX_TEXT_BODY {
            return Err(ValidationError::TooLarge);
        }
        // Bound depth before recursive deserialization, including caller schemas and tool inputs.
        let mut depth = 0usize;
        let mut string = false;
        let mut escape = false;
        for byte in bytes {
            if string {
                if escape {
                    escape = false;
                } else if *byte == b'\\' {
                    escape = true;
                } else if *byte == b'"' {
                    string = false;
                }
                continue;
            }
            match byte {
                b'"' => string = true,
                b'{' | b'[' => {
                    depth += 1;
                    if depth > 64 {
                        return Err(ValidationError::InvalidRequest);
                    }
                }
                b'}' | b']' => {
                    depth = depth
                        .checked_sub(1)
                        .ok_or(ValidationError::InvalidRequest)?;
                }
                _ => {}
            }
        }
        let request: Self =
            serde_json::from_slice(bytes).map_err(|_| ValidationError::InvalidRequest)?;
        request.validate()?;
        Ok(request)
    }

    pub(crate) fn validate(&self) -> Result<(), ValidationError> {
        let invalid = ValidationError::InvalidRequest;
        if self.messages.is_empty()
            || self.output.max_tokens == 0
            || self
                .output
                .min_tokens
                .is_some_and(|min| min == 0 || min > self.output.max_tokens)
        {
            return Err(invalid);
        }
        if self
            .output
            .schema
            .as_ref()
            .is_some_and(|schema| !schema.is_object())
        {
            return Err(invalid);
        }
        let mut tools = HashSet::new();
        for tool in &self.tools {
            if !valid_name(&tool.name)
                || !tools.insert(tool.name.as_str())
                || !tool.input.is_object()
                || tool.input.get("type").and_then(Value::as_str) != Some("object")
            {
                return Err(invalid);
            }
        }
        let mut images = 0;
        let mut pending = HashSet::new();
        for message in &self.messages {
            match message {
                Message::Tool { results } => {
                    let ids: HashSet<&str> =
                        results.iter().map(|result| result.id.as_str()).collect();
                    if pending.is_empty() || ids.len() != results.len() || ids != pending {
                        return Err(invalid);
                    }
                    pending.clear();
                }
                Message::User { parts } | Message::Assistant { parts, .. } => {
                    if !pending.is_empty()
                        || (parts.is_empty() && matches!(message, Message::User { .. }))
                    {
                        return Err(invalid);
                    }
                    for part in parts {
                        match part {
                            Part::Text { .. } => {}
                            Part::Image { image } => {
                                images += 1;
                                if !matches!(message, Message::User { .. })
                                    || images > 8
                                    || !matches!(
                                        image.media_type.as_str(),
                                        "image/jpeg" | "image/png"
                                    )
                                {
                                    return Err(invalid);
                                }
                                let decoded = STANDARD.decode(&image.data).map_err(|_| invalid)?;
                                let signature = match image.media_type.as_str() {
                                    "image/png" => decoded.starts_with(b"\x89PNG\r\n\x1a\n"),
                                    _ => decoded.starts_with(b"\xff\xd8\xff"),
                                };
                                if !signature {
                                    return Err(invalid);
                                }
                            }
                            Part::Picture { image } => {
                                images += 1;
                                if !matches!(message, Message::User { .. })
                                    || images > 8
                                    || !(22..=64).contains(&image.picture.len())
                                    || !image.picture.bytes().all(|b| {
                                        b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')
                                    })
                                {
                                    return Err(invalid);
                                }
                            }
                            Part::ToolCall { tool_call } => {
                                if !matches!(message, Message::Assistant { .. })
                                    || tool_call.id.is_empty()
                                    || tool_call.id.len() > 128
                                    || !valid_name(&tool_call.name)
                                    || !tool_call.input.is_object()
                                    || !pending.insert(tool_call.id.as_str())
                                {
                                    return Err(invalid);
                                }
                            }
                        }
                    }
                }
            }
        }
        if !pending.is_empty() {
            return Err(invalid);
        }
        Ok(())
    }
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}
