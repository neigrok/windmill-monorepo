use ai_domain::StaticCode;
use ai_providers::TextRequest;
use ai_server::{config::PICTURE_HOLD, pictures::Pictures};
use serde_json::json;
use std::time::{Duration, Instant};

fn request(id: &str) -> TextRequest {
    TextRequest::parse(json!({"model":"small","messages":[{"role":"user","parts":[{"image":{"picture":id}}]}],"output":{"maxTokens":20}}).to_string().as_bytes()).unwrap()
}

#[test]
fn pictures_are_principal_scoped_idempotent_and_expire_after_last_reference() {
    let pictures = Pictures::default();
    let now = Instant::now();
    let id = "pictureabcdefghijklmn0";
    pictures
        .put(
            "account:a".into(),
            id.into(),
            "image/jpeg".into(),
            vec![255, 216, 255, 1],
            now,
        )
        .unwrap();
    pictures
        .put(
            "account:a".into(),
            id.into(),
            "image/jpeg".into(),
            vec![255, 216, 255, 2],
            now,
        )
        .unwrap();
    assert_eq!(
        pictures.resolve("account:b", &mut request(id), now),
        Err(StaticCode::PictureGone)
    );
    let mut resolved = request(id);
    pictures
        .resolve(
            "account:a",
            &mut resolved,
            now + PICTURE_HOLD - Duration::from_secs(1),
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(&resolved.messages).unwrap(),
        json!([{"role":"user","parts":[{"image":{"mediaType":"image/jpeg","data":"/9j/AQ=="}}]}])
    );
    pictures.prune(now + PICTURE_HOLD);
    assert!(
        pictures
            .resolve("account:a", &mut request(id), now + PICTURE_HOLD)
            .is_ok()
    );
    pictures.prune(now + PICTURE_HOLD * 2);
    assert_eq!(
        pictures.resolve("account:a", &mut request(id), now + PICTURE_HOLD * 2),
        Err(StaticCode::PictureGone)
    );
    assert_eq!(
        Pictures::default().resolve("account:a", &mut request(id), now),
        Err(StaticCode::PictureGone)
    );
}

#[test]
fn quotas_evict_oldest_and_missing_reference_never_renews_a_partial_request() {
    let pictures = Pictures::new(5000, 7500);
    let now = Instant::now();
    for (principal, id, at) in [
        ("a", "pictureabcdefghijklmn0", 0),
        ("b", "pictureabcdefghijklmn0", 1),
        ("a", "pictureabcdefghijklmn1", 2),
        ("a", "pictureabcdefghijklmn2", 3),
    ] {
        pictures
            .put(
                principal.into(),
                id.into(),
                "image/jpeg".into(),
                {
                    let mut bytes = vec![0; 2048];
                    bytes[..3].copy_from_slice(&[255, 216, 255]);
                    bytes
                },
                now + Duration::from_secs(at),
            )
            .unwrap();
    }
    assert_eq!(
        pictures.resolve(
            "a",
            &mut request("pictureabcdefghijklmn0"),
            now + Duration::from_secs(4)
        ),
        Err(StaticCode::PictureGone)
    );
    assert!(
        pictures
            .resolve(
                "b",
                &mut request("pictureabcdefghijklmn0"),
                now + Duration::from_secs(4)
            )
            .is_ok()
    );
    pictures
        .put(
            "c".into(),
            "pictureabcdefghijklmn0".into(),
            "image/jpeg".into(),
            {
                let mut bytes = vec![0; 2048];
                bytes[..3].copy_from_slice(&[255, 216, 255]);
                bytes
            },
            now + Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(
        pictures.resolve(
            "a",
            &mut request("pictureabcdefghijklmn1"),
            now + Duration::from_secs(6)
        ),
        Err(StaticCode::PictureGone)
    );
    let mut partial = request("pictureabcdefghijklmn2");
    let ai_providers::Message::User { parts } = &mut partial.messages[0] else {
        panic!("user expected")
    };
    parts.push(ai_providers::Part::Picture {
        image: ai_providers::Picture {
            picture: "pictureabcdefghijklmn9".into(),
        },
    });
    assert_eq!(
        pictures.resolve("a", &mut partial, now + PICTURE_HOLD),
        Err(StaticCode::PictureGone)
    );
    assert_eq!(
        pictures.resolve(
            "a",
            &mut request("pictureabcdefghijklmn2"),
            now + PICTURE_HOLD + Duration::from_secs(3)
        ),
        Err(StaticCode::PictureGone)
    );
}

#[test]
fn strict_picture_references_preserve_inline_images_and_reject_mixed_shapes() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../packages/api-contract/ai/wire/fixtures.json"
    ))
    .unwrap();
    for key in ["textRequest", "textPictureRequest"] {
        assert!(TextRequest::parse(fixture[key].to_string().as_bytes()).is_ok());
    }
    for image in [
        json!({"picture":"short"}),
        json!({"picture":"pictureabcdefghijklmn0","data":"/9j/"}),
        json!({"picture":"pictureabcdefghijklmn0","mediaType":"image/jpeg"}),
    ] {
        let mut value = fixture["textPictureRequest"].clone();
        value["messages"][0]["parts"][1]["image"] = image;
        assert!(TextRequest::parse(value.to_string().as_bytes()).is_err());
    }
    let pictures = Pictures::default();
    assert_eq!(
        pictures.put(
            "a".into(),
            "pictureabcdefghijklmn0".into(),
            "image/png".into(),
            vec![255, 216, 255],
            Instant::now()
        ),
        Err(StaticCode::InvalidRequest)
    );
    assert_eq!(
        pictures.put(
            "a".into(),
            "pictureabcdefghijklmn0".into(),
            "image/jpeg".into(),
            vec![0; ai_server::config::MAX_PICTURE + 1],
            Instant::now()
        ),
        Err(StaticCode::TooLarge)
    );
}

#[test]
fn expanded_picture_budget_counts_every_reference_and_inline_image_before_renewal() {
    use ai_providers::{Image, MAX_TEXT_BODY, Message, Part};
    use ai_server::config::MAX_PICTURE;
    use base64::{Engine, engine::general_purpose::STANDARD};

    for inline in [false, true] {
        let pictures = Pictures::default();
        let now = Instant::now();
        let id = "pictureabcdefghijklmn0";
        let mut bytes = vec![0; MAX_PICTURE];
        bytes[..3].copy_from_slice(&[255, 216, 255]);
        pictures
            .put("a".into(), id.into(), "image/jpeg".into(), bytes, now)
            .unwrap();
        let mut expanded = request(id);
        let Message::User { parts } = &mut expanded.messages[0] else {
            panic!("user expected")
        };
        let first = parts[0].clone();
        if inline {
            parts.push(first);
            let mut bytes = vec![0; 3 * 1024 * 1024];
            bytes[..3].copy_from_slice(&[255, 216, 255]);
            parts.push(Part::Image {
                image: Image {
                    media_type: "image/jpeg".into(),
                    data: STANDARD.encode(bytes),
                },
            });
        } else {
            parts.resize(8, first);
        }
        let before = serde_json::to_value(&expanded).unwrap();
        assert!(serde_json::to_vec(&expanded).unwrap().len() < MAX_TEXT_BODY);
        assert_eq!(
            pictures.resolve(
                "a",
                &mut expanded,
                now + PICTURE_HOLD - Duration::from_secs(1)
            ),
            Err(StaticCode::InvalidRequest)
        );
        assert_eq!(serde_json::to_value(&expanded).unwrap(), before);
        assert_eq!(
            pictures.resolve("a", &mut request(id), now + PICTURE_HOLD),
            Err(StaticCode::PictureGone)
        );
    }
}

#[test]
fn missing_picture_precedes_expansion_refusal_without_mutation_or_renewal() {
    use ai_providers::{Message, Part, Picture};
    let pictures = Pictures::default();
    let now = Instant::now();
    let id = "pictureabcdefghijklmn0";
    let mut bytes = vec![0; ai_server::config::MAX_PICTURE];
    bytes[..3].copy_from_slice(&[255, 216, 255]);
    pictures
        .put("a".into(), id.into(), "image/jpeg".into(), bytes, now)
        .unwrap();
    let mut expanded = request(id);
    let Message::User { parts } = &mut expanded.messages[0] else {
        panic!("user expected")
    };
    parts.resize(7, parts[0].clone());
    parts.push(Part::Picture {
        image: Picture {
            picture: "pictureabcdefghijklmn1".into(),
        },
    });
    let before = serde_json::to_value(&expanded).unwrap();
    assert_eq!(
        pictures.resolve(
            "a",
            &mut expanded,
            now + PICTURE_HOLD - Duration::from_secs(1)
        ),
        Err(StaticCode::PictureGone)
    );
    assert_eq!(serde_json::to_value(&expanded).unwrap(), before);
    assert_eq!(
        pictures.resolve("a", &mut request(id), now + PICTURE_HOLD),
        Err(StaticCode::PictureGone)
    );
}
