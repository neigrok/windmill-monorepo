use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{
        Message, client::IntoClientRequest, http::HeaderValue, protocol::WebSocketConfig,
    },
};

use crate::{
    Certainty, FailureCode, FailureKind, MAX_AUDIO_FRAME, MAX_PROVIDER_FRAME, ProviderFailure,
    Secret, request_id,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiveAuth {
    Bearer,
    ApiKey,
}

pub struct LiveConfig {
    pub url: String,
    pub key: Secret,
    pub auth: LiveAuth,
    pub model: String,
    pub delay: String,
}

pub struct LiveClient {
    config: LiveConfig,
}

pub const LIVE_WRITE_TIMEOUT: Duration = Duration::from_secs(1);

pub struct LiveSession {
    socket: Option<WebSocketStream<MaybeTlsStream<TcpStream>>>,
    model: String,
    delay: String,
    audio_started: bool,
    closed: bool,
    pub request_id: Option<String>,
}

pub enum LiveEvent {
    Committed {
        item_id: String,
        previous_item_id: Option<String>,
    },
    Text {
        item_id: String,
        delta: String,
    },
    Completed {
        item_id: String,
        text: String,
    },
    Failed {
        item_id: Option<String>,
        failure: ProviderFailure,
    },
    Closed,
}

impl LiveClient {
    pub fn new(config: LiveConfig) -> Result<Self, ProviderFailure> {
        let url = reqwest::Url::parse(&config.url).map_err(|_| ProviderFailure::configuration())?;
        if !matches!(url.scheme(), "wss" | "ws")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || url
                .query_pairs()
                .filter(|(name, value)| name == "intent" && value == "transcription")
                .count()
                != 1
            || url.query_pairs().any(|(name, _)| name != "intent")
            || config.model.is_empty()
            || config.model.len() > 128
            || !matches!(
                config.delay.as_str(),
                "minimal" | "low" | "medium" | "high" | "xhigh"
            )
        {
            return Err(ProviderFailure::configuration());
        }
        Ok(Self { config })
    }

    pub async fn open(&self) -> Result<LiveSession, ProviderFailure> {
        let open = async {
            let mut request = self
                .config
                .url
                .as_str()
                .into_client_request()
                .map_err(|_| ProviderFailure::configuration())?;
            let (header, value) = match self.config.auth {
                LiveAuth::Bearer => (
                    "authorization",
                    format!("Bearer {}", self.config.key.expose()),
                ),
                LiveAuth::ApiKey => ("api-key", self.config.key.expose().to_owned()),
            };
            let mut value =
                HeaderValue::from_str(&value).map_err(|_| ProviderFailure::configuration())?;
            value.set_sensitive(true);
            request.headers_mut().insert(header, value);
            let config = WebSocketConfig::default()
                .max_message_size(Some(MAX_PROVIDER_FRAME))
                .max_frame_size(Some(MAX_PROVIDER_FRAME));
            let (socket, response) = connect_async_with_config(request, Some(config), true)
                .await
                .map_err(|error| {
                    if let tokio_tungstenite::tungstenite::Error::Http(response) = error {
                        return ProviderFailure::status(
                            response.status().as_u16(),
                            request_id(
                                response
                                    .headers()
                                    .get("x-request-id")
                                    .and_then(|header| header.to_str().ok()),
                            ),
                            response.body().as_deref().unwrap_or_default(),
                        );
                    }
                    ProviderFailure::new(
                        FailureCode::ProviderUnavailable,
                        Certainty::Unconsumed,
                        FailureKind::Connect,
                    )
                })?;
            let id = request_id(
                response
                    .headers()
                    .get("x-request-id")
                    .and_then(|header| header.to_str().ok()),
            );
            let mut session = LiveSession {
                socket: Some(socket),
                model: self.config.model.clone(),
                delay: self.config.delay.clone(),
                audio_started: false,
                closed: false,
                request_id: id,
            };
            session.send_config(None).await?;
            loop {
                let message = session
                    .socket
                    .as_mut()
                    .ok_or_else(ProviderFailure::protocol)?
                    .next()
                    .await
                    .ok_or_else(ProviderFailure::protocol)?
                    .map_err(|_| ProviderFailure::protocol())?;
                match message {
                    Message::Text(text) => {
                        let value: Value =
                            serde_json::from_str(&text).map_err(|_| ProviderFailure::protocol())?;
                        match value["type"].as_str() {
                            Some("session.updated") => {
                                let settings = &value["session"];
                                if settings["type"] != "transcription"
                                    || settings["audio"]["input"]["transcription"]["model"]
                                        != session.model
                                    || !settings["audio"]["input"]["turn_detection"].is_null()
                                {
                                    return Err(ProviderFailure::protocol());
                                }
                                return Ok(session);
                            }
                            Some("session.created") => {}
                            Some("error") => {
                                return Err(ProviderFailure::new(
                                    FailureCode::ProviderUnavailable,
                                    Certainty::Unconsumed,
                                    FailureKind::ProviderError,
                                ));
                            }
                            _ => return Err(ProviderFailure::protocol()),
                        }
                    }
                    Message::Ping(_) => session.flush().await?,
                    Message::Pong(_) => {}
                    _ => return Err(ProviderFailure::protocol()),
                }
            }
        };
        match tokio::time::timeout(Duration::from_secs(10), open).await {
            Ok(Ok(session)) => Ok(session),
            Ok(Err(mut failure)) => {
                failure.code = FailureCode::ProviderUnavailable;
                failure.certainty = Certainty::Unconsumed;
                Err(failure)
            }
            Err(_) => Err(ProviderFailure::new(
                FailureCode::ProviderUnavailable,
                Certainty::Unconsumed,
                FailureKind::Timeout,
            )),
        }
    }
}

impl LiveSession {
    pub fn is_closed(&self) -> bool {
        self.closed || self.socket.is_none()
    }

    async fn send(&mut self, message: Message) -> Result<(), ProviderFailure> {
        let mut socket = self.socket.take().ok_or_else(ProviderFailure::protocol)?;
        match tokio::time::timeout(LIVE_WRITE_TIMEOUT, socket.send(message)).await {
            Ok(Ok(())) => {
                self.socket = Some(socket);
                Ok(())
            }
            Ok(Err(_)) => {
                self.closed = true;
                Err(ProviderFailure::new(
                    FailureCode::ProviderFailed,
                    Certainty::Assumed,
                    FailureKind::Transport,
                ))
            }
            Err(_) => {
                self.closed = true;
                Err(ProviderFailure::new(
                    FailureCode::ProviderFailed,
                    Certainty::Assumed,
                    FailureKind::Timeout,
                ))
            }
        }
    }

    async fn flush(&mut self) -> Result<(), ProviderFailure> {
        let mut socket = self.socket.take().ok_or_else(ProviderFailure::protocol)?;
        match tokio::time::timeout(LIVE_WRITE_TIMEOUT, socket.flush()).await {
            Ok(Ok(())) => {
                self.socket = Some(socket);
                Ok(())
            }
            Ok(Err(_)) => {
                self.closed = true;
                Err(ProviderFailure::new(
                    FailureCode::ProviderFailed,
                    Certainty::Assumed,
                    FailureKind::Transport,
                ))
            }
            Err(_) => {
                self.closed = true;
                Err(ProviderFailure::new(
                    FailureCode::ProviderFailed,
                    Certainty::Assumed,
                    FailureKind::Timeout,
                ))
            }
        }
    }

    async fn send_config(&mut self, keywords: Option<&[String]>) -> Result<(), ProviderFailure> {
        let mut value = json!({"type":"session.update","session":{"type":"transcription","audio":{"input":{"format":{"type":"audio/pcm","rate":24000},"transcription":{"model":self.model,"delay":self.delay},"turn_detection":null}}}});
        if let Some(keywords) = keywords {
            value["session"]["audio"]["input"]["transcription"]["keywords"] = json!(keywords);
        }
        self.send(Message::Text(value.to_string().into())).await
    }

    pub async fn context(&mut self, keywords: &[String]) -> Result<(), ProviderFailure> {
        if self.closed
            || self.audio_started
            || keywords.len() > 256
            || keywords.iter().any(|word| {
                word.is_empty() || word.len() > 256 || word.contains(['<', '>', '\r', '\n'])
            })
        {
            return Err(ProviderFailure::protocol());
        }
        self.send_config(Some(keywords)).await
    }

    pub async fn send_audio(&mut self, pcm: &[u8]) -> Result<(), ProviderFailure> {
        if self.closed
            || pcm.is_empty()
            || !pcm.len().is_multiple_of(2)
            || pcm.len() > MAX_AUDIO_FRAME
        {
            return Err(ProviderFailure::protocol());
        }
        self.audio_started = true;
        let value = json!({"type":"input_audio_buffer.append","audio":STANDARD.encode(pcm)});
        self.send(Message::Text(value.to_string().into())).await
    }

    pub async fn commit(&mut self) -> Result<(), ProviderFailure> {
        if self.is_closed() {
            return Err(ProviderFailure::protocol());
        }
        self.send(Message::Text(
            "{\"type\":\"input_audio_buffer.commit\"}".into(),
        ))
        .await
    }

    pub async fn next_event(&mut self) -> Result<LiveEvent, ProviderFailure> {
        if self.is_closed() {
            return Ok(LiveEvent::Closed);
        }
        loop {
            let Some(message) = self
                .socket
                .as_mut()
                .ok_or_else(ProviderFailure::protocol)?
                .next()
                .await
            else {
                self.closed = true;
                return Ok(LiveEvent::Closed);
            };
            match message.map_err(|_| {
                ProviderFailure::new(
                    FailureCode::ProviderFailed,
                    Certainty::Assumed,
                    FailureKind::Transport,
                )
            })? {
                Message::Text(text) => {
                    let value: Value =
                        serde_json::from_str(&text).map_err(|_| ProviderFailure::protocol())?;
                    if let Some(event) = parse_event(value)? {
                        return Ok(event);
                    }
                }
                Message::Ping(_) => self.flush().await?,
                Message::Pong(_) => {}
                Message::Close(_) => {
                    self.closed = true;
                    return Ok(LiveEvent::Closed);
                }
                _ => return Err(ProviderFailure::protocol()),
            }
        }
    }

    pub async fn close(&mut self) -> Result<(), ProviderFailure> {
        if self.is_closed() {
            return Ok(());
        }
        self.closed = true;
        let Some(mut socket) = self.socket.take() else {
            return Ok(());
        };
        tokio::time::timeout(LIVE_WRITE_TIMEOUT, socket.close(None))
            .await
            .map_err(|_| {
                ProviderFailure::new(
                    FailureCode::ProviderFailed,
                    Certainty::Assumed,
                    FailureKind::Timeout,
                )
            })?
            .map_err(|_| ProviderFailure::protocol())
    }
}

fn parse_event(value: Value) -> Result<Option<LiveEvent>, ProviderFailure> {
    let kind = value["type"]
        .as_str()
        .ok_or_else(ProviderFailure::protocol)?;
    if matches!(
        kind,
        "session.updated"
            | "session.created"
            | "rate_limits.updated"
            | "conversation.item.created"
            | "conversation.item.added"
            | "conversation.item.done"
    ) {
        return Ok(None);
    }
    if kind == "error" {
        return Ok(Some(LiveEvent::Failed {
            item_id: None,
            failure: ProviderFailure::new(
                FailureCode::ProviderFailed,
                Certainty::Assumed,
                FailureKind::ProviderError,
            ),
        }));
    }
    if !matches!(
        kind,
        "input_audio_buffer.committed"
            | "conversation.item.input_audio_transcription.delta"
            | "conversation.item.input_audio_transcription.completed"
            | "conversation.item.input_audio_transcription.failed"
    ) {
        return Ok(None);
    }
    let item_id = value["item_id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 256)
        .ok_or_else(ProviderFailure::protocol)?
        .to_owned();
    let event = match kind {
        "input_audio_buffer.committed" => {
            let previous_item_id = match value.get("previous_item_id") {
                None | Some(Value::Null) => None,
                Some(Value::String(id)) if !id.is_empty() && id.len() <= 256 => Some(id.clone()),
                _ => return Err(ProviderFailure::protocol()),
            };
            LiveEvent::Committed {
                item_id,
                previous_item_id,
            }
        }
        "conversation.item.input_audio_transcription.delta" => LiveEvent::Text {
            item_id,
            delta: value["delta"]
                .as_str()
                .ok_or_else(ProviderFailure::protocol)?
                .to_owned(),
        },
        "conversation.item.input_audio_transcription.completed" => LiveEvent::Completed {
            item_id,
            text: value["transcript"]
                .as_str()
                .ok_or_else(ProviderFailure::protocol)?
                .to_owned(),
        },
        _ => LiveEvent::Failed {
            item_id: Some(item_id),
            failure: ProviderFailure::new(
                FailureCode::ProviderFailed,
                Certainty::Assumed,
                FailureKind::ProviderError,
            ),
        },
    };
    Ok(Some(event))
}
