use std::time::Duration;

use ai_providers::{
    Certainty, FailureCode, LiveAuth, LiveClient, LiveConfig, LiveEvent, LiveSession, Secret,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{net::TcpListener, sync::mpsc};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
    },
};

#[test]
fn live_content_has_no_debug_or_display() {
    static_assertions::assert_not_impl_any!(LiveConfig: std::fmt::Debug, std::fmt::Display);
    static_assertions::assert_not_impl_any!(LiveEvent: std::fmt::Debug, std::fmt::Display);
    static_assertions::assert_not_impl_any!(LiveSession: std::fmt::Debug, std::fmt::Display);
}

#[tokio::test]
#[allow(clippy::result_large_err)]
async fn openai_and_azure_send_pcm_without_language_hints_and_preserve_item_order() {
    for auth in [LiveAuth::Bearer, LiveAuth::ApiKey] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "ws://{}/v1/realtime?intent=transcription",
            listener.local_addr().unwrap()
        );
        let (tx, mut rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket =
                accept_hdr_async(socket, move |request: &Request, response: Response| {
                    assert_eq!(
                        request.uri().to_string(),
                        "/v1/realtime?intent=transcription"
                    );
                    match auth {
                        LiveAuth::Bearer => {
                            assert_eq!(request.headers()["authorization"], "Bearer test-key");
                            assert!(!request.headers().contains_key("api-key"));
                        }
                        LiveAuth::ApiKey => {
                            assert_eq!(request.headers()["api-key"], "test-key");
                            assert!(!request.headers().contains_key("authorization"));
                        }
                    }
                    Ok(response)
                })
                .await
                .unwrap();
            let config: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            tx.send(config.clone()).unwrap();
            socket
                .send(Message::Text(
                    json!({"type":"session.updated","session":config["session"]})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            for _ in 0..3 {
                let message = socket.next().await.unwrap().unwrap();
                tx.send(serde_json::from_str(message.to_text().unwrap()).unwrap())
                    .unwrap();
            }
            for event in [
                json!({"type":"input_audio_buffer.committed","item_id":"one","previous_item_id":null}),
                json!({"type":"input_audio_buffer.committed","item_id":"two","previous_item_id":"one"}),
                json!({"type":"conversation.item.input_audio_transcription.delta","item_id":"two","content_index":0,"delta":"Sec"}),
                json!({"type":"conversation.item.input_audio_transcription.completed","item_id":"two","content_index":0,"transcript":"Second"}),
                json!({"type":"conversation.item.input_audio_transcription.completed","item_id":"one","content_index":0,"transcript":"First"}),
            ] {
                socket
                    .send(Message::Text(event.to_string().into()))
                    .await
                    .unwrap();
            }
            while let Some(Ok(message)) = socket.next().await {
                if message.is_close() {
                    break;
                }
            }
        });
        let model = if auth == LiveAuth::ApiKey {
            "my-deployment"
        } else {
            "gpt-live-transcribe"
        };
        let client = LiveClient::new(LiveConfig {
            url,
            key: Secret::new("test-key".into()),
            auth,
            model: model.into(),
            delay: "low".into(),
        })
        .unwrap();
        let mut session = client.open().await.unwrap();
        let settings = json!({"type":"session.update","session":{"type":"transcription","audio":{"input":{"format":{"type":"audio/pcm","rate":24000},"transcription":{"model":model,"delay":"low"},"turn_detection":null}}}});
        assert_eq!(rx.recv().await.unwrap(), settings);
        session.context(&["Windmill".into()]).await.unwrap();
        session.send_audio(&[0, 1, 2, 3]).await.unwrap();
        session.commit().await.unwrap();
        let mut context = settings;
        context["session"]["audio"]["input"]["transcription"]["keywords"] = json!(["Windmill"]);
        assert_eq!(rx.recv().await.unwrap(), context);
        assert_eq!(
            rx.recv().await.unwrap(),
            json!({"type":"input_audio_buffer.append","audio":"AAECAw=="})
        );
        assert_eq!(
            rx.recv().await.unwrap(),
            json!({"type":"input_audio_buffer.commit"})
        );
        assert!(
            matches!(session.next_event().await.unwrap(),LiveEvent::Committed{item_id,previous_item_id} if item_id=="one" && previous_item_id.is_none())
        );
        assert!(
            matches!(session.next_event().await.unwrap(),LiveEvent::Committed{item_id,previous_item_id} if item_id=="two" && previous_item_id.as_deref()==Some("one"))
        );
        assert!(
            matches!(session.next_event().await.unwrap(),LiveEvent::Text{item_id,delta} if item_id=="two" && delta=="Sec")
        );
        assert!(
            matches!(session.next_event().await.unwrap(),LiveEvent::Completed{item_id,text} if item_id=="two" && text=="Second")
        );
        assert!(
            matches!(session.next_event().await.unwrap(),LiveEvent::Completed{item_id,text} if item_id=="one" && text=="First")
        );
        assert!(session.context(&["late".into()]).await.is_err());
        assert!(session.send_audio(&[0]).await.is_err());
        assert!(session.send_audio(&[]).await.is_err());
        assert!(session.send_audio(&vec![0; 65538]).await.is_err());
        session.close().await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn malformed_provider_event_fails_without_exposing_error_text() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "ws://{}/realtime?intent=transcription",
        listener.local_addr().unwrap()
    );
    let task = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
        let config: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        socket
            .send(Message::Text(
                json!({"type":"session.updated","session":config["session"]})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        socket.send(Message::Text(json!({"type":"conversation.item.input_audio_transcription.completed","item_id":"one","transcript":3,"message":"PRIVATE_EVENT_CONTENT"}).to_string().into())).await.unwrap();
    });
    let client = LiveClient::new(LiveConfig {
        url,
        key: Secret::new("test".into()),
        auth: LiveAuth::Bearer,
        model: "gpt-live-transcribe".into(),
        delay: "low".into(),
    })
    .unwrap();
    let mut session = client.open().await.unwrap();
    let failure = match session.next_event().await {
        Err(failure) => failure,
        Ok(_) => panic!("accepted malformed transcript"),
    };
    assert_eq!(
        (failure.code, failure.certainty),
        (FailureCode::ProviderFailed, Certainty::Assumed)
    );
    assert!(!format!("{failure:?}").contains("PRIVATE_EVENT_CONTENT"));
    task.await.unwrap();
}

#[test]
fn session_configuration_cannot_smuggle_a_model_or_identity_into_query() {
    for url in [
        "wss://example.test/v1/realtime?model=gpt-live-transcribe",
        "wss://example.test/v1/realtime?intent=transcription&user=private",
        "wss://key@example.test/v1/realtime?intent=transcription",
        "wss://example.test/v1/realtime?intent=transcription&intent=transcription",
    ] {
        assert!(
            LiveClient::new(LiveConfig {
                url: url.into(),
                key: Secret::new("test".into()),
                auth: LiveAuth::Bearer,
                model: "gpt-live-transcribe".into(),
                delay: "low".into()
            })
            .is_err()
        );
    }
}
