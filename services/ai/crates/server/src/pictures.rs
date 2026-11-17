use crate::{Service, authenticate, body, config::*, principal_key, read_rate, refusal, reject};
use ai_domain::{CallerId, StaticCode};
use ai_providers::{Image, MAX_TEXT_BODY, Message, Part, TextRequest};
use axum::{
    extract::{Path, Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Instant,
};

struct PicturePayload {
    media_type: String,
    bytes: Vec<u8>,
}

struct HeldPicture {
    payload: Arc<PicturePayload>,
    touched: Instant,
    order: u64,
    weight: usize,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<(String, String), HeldPicture>,
    order: u64,
}

pub struct Pictures {
    cache: Mutex<Cache>,
    per_principal: usize,
    total: usize,
}

impl Default for Pictures {
    fn default() -> Self {
        Self::new(PICTURES_PER_PRINCIPAL, PICTURES_TOTAL)
    }
}

impl Pictures {
    pub fn new(per_principal: usize, total: usize) -> Self {
        Self {
            cache: Mutex::new(Cache::default()),
            per_principal,
            total,
        }
    }

    pub fn prune(&self, now: Instant) {
        self.cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .retain(|_, value| now.saturating_duration_since(value.touched) < PICTURE_HOLD);
    }

    pub fn put(
        &self,
        principal: String,
        id: String,
        media_type: String,
        bytes: Vec<u8>,
        now: Instant,
    ) -> Result<(), StaticCode> {
        if bytes.len() > MAX_PICTURE {
            return Err(StaticCode::TooLarge);
        }
        let valid = match media_type.as_str() {
            "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
            _ => false,
        };
        if !valid {
            return Err(StaticCode::InvalidRequest);
        }
        let weight = bytes.capacity()
            + principal.capacity()
            + id.capacity()
            + media_type.capacity()
            + std::mem::size_of::<((String, String), HeldPicture)>()
            + std::mem::size_of::<PicturePayload>()
            + 2 * std::mem::size_of::<usize>()
            + 64;
        if weight > self.per_principal || weight > self.total {
            return Err(StaticCode::Busy);
        }
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        cache
            .entries
            .retain(|_, value| now.saturating_duration_since(value.touched) < PICTURE_HOLD);
        let key = (principal.clone(), id);
        if cache.entries.contains_key(&key) {
            return Ok(());
        }
        loop {
            let own: usize = cache
                .entries
                .iter()
                .filter(|(key, _)| key.0 == principal)
                .map(|(_, value)| value.weight)
                .sum();
            let all: usize = cache.entries.values().map(|value| value.weight).sum();
            let own_full = own + weight > self.per_principal;
            if !own_full && all + weight <= self.total {
                break;
            }
            let oldest = cache
                .entries
                .iter()
                .filter(|(key, _)| !own_full || key.0 == principal)
                .min_by_key(|(_, value)| (value.touched, value.order))
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                cache.entries.remove(&oldest);
            } else {
                return Err(StaticCode::Busy);
            }
        }
        cache.order += 1;
        let order = cache.order;
        cache.entries.insert(
            key,
            HeldPicture {
                payload: Arc::new(PicturePayload { media_type, bytes }),
                touched: now,
                order,
                weight,
            },
        );
        Ok(())
    }

    pub fn resolve(
        &self,
        principal: &str,
        request: &mut TextRequest,
        now: Instant,
    ) -> Result<(), StaticCode> {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        cache
            .entries
            .retain(|_, value| now.saturating_duration_since(value.touched) < PICTURE_HOLD);
        let mut payloads = HashMap::new();
        for message in &request.messages {
            if let Message::User { parts } = message {
                for part in parts {
                    if let Part::Picture { image } = part {
                        let picture = cache
                            .entries
                            .get(&(principal.to_owned(), image.picture.clone()))
                            .ok_or(StaticCode::PictureGone)?;
                        payloads
                            .entry(image.picture.clone())
                            .or_insert_with(|| Arc::clone(&picture.payload));
                    }
                }
            }
        }
        let mut image_bytes = 0usize;
        for message in &request.messages {
            if let Message::User { parts } = message {
                for part in parts {
                    let size = match part {
                        Part::Image { image } => image.data.len(),
                        Part::Picture { image } => {
                            base64::encoded_len(payloads[&image.picture].bytes.len(), true)
                                .ok_or(StaticCode::InvalidRequest)?
                        }
                        _ => continue,
                    };
                    image_bytes = image_bytes
                        .checked_add(size)
                        .filter(|total| *total <= MAX_TEXT_BODY)
                        .ok_or(StaticCode::InvalidRequest)?;
                }
            }
        }
        for id in payloads.keys() {
            if let Some(picture) = cache.entries.get_mut(&(principal.to_owned(), id.clone())) {
                picture.touched = now;
            }
        }
        drop(cache);
        let images: HashMap<_, _> = payloads
            .into_iter()
            .map(|(id, payload)| {
                (
                    id,
                    Image {
                        media_type: payload.media_type.clone(),
                        data: STANDARD.encode(&payload.bytes),
                    },
                )
            })
            .collect();
        for message in &mut request.messages {
            if let Message::User { parts } = message {
                for part in parts {
                    if let Part::Picture { image } = part {
                        *part = Part::Image {
                            image: images[&image.picture].clone(),
                        };
                    }
                }
            }
        }
        Ok(())
    }
}

pub async fn upload(
    State(service): State<Arc<Service>>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let identity = match authenticate(&service, request.headers()).await {
        Ok(identity) => identity,
        Err(code) => return refusal(code, None),
    };
    if !read_rate(&service, &identity) {
        return reject(
            &service,
            &identity,
            StaticCode::RateLimited,
            "picture.upload",
        )
        .await;
    }
    if service.drain.is_cancelled() {
        return reject(&service, &identity, StaticCode::Busy, "picture.upload").await;
    }
    if CallerId::new(id.clone()).is_err() {
        return reject(
            &service,
            &identity,
            StaticCode::InvalidRequest,
            "picture.upload",
        )
        .await;
    }
    let media_types: Vec<_> = request
        .headers()
        .get_all(header::CONTENT_TYPE)
        .iter()
        .collect();
    let media_type = match media_types.as_slice() {
        [value] if value.as_bytes() == b"image/jpeg" || value.as_bytes() == b"image/png" => {
            value.to_str().unwrap_or_default().to_owned()
        }
        _ => {
            return reject(
                &service,
                &identity,
                StaticCode::InvalidRequest,
                "picture.upload",
            )
            .await;
        }
    };
    let bytes = match body(request, MAX_PICTURE).await {
        Ok(bytes) => bytes,
        Err(code) => return reject(&service, &identity, code, "picture.upload").await,
    };
    match service.pictures.put(
        principal_key(&identity.principal),
        id,
        media_type,
        bytes.to_vec(),
        Instant::now(),
    ) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(code) => reject(&service, &identity, code, "picture.upload").await,
    }
}
