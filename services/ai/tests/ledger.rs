use ai_domain::*;
use ai_storage::Ledger;

fn tiers() -> TierTable {
    let month_pool = PoolRule {
        name: "free".to_owned(),
        limit: NanoUsd::new(100_000_000_000).expect("fixed money"),
    };
    let day_pool = PoolRule {
        name: "free".to_owned(),
        limit: NanoUsd::new(5_000_000_000).expect("fixed money"),
    };
    TierTable {
        rows: vec![
            TierRule {
                tier: Tier::Anonymous,
                amount: NanoUsd::new(250_000_000).expect("fixed money"),
                month_pool: Some(month_pool.clone()),
                day_pool: Some(day_pool.clone()),
                in_flight: 1,
                calls_per_minute: 30,
                output_ceiling: 2000,
                text: [ModelClass::Medium, ModelClass::Medium, ModelClass::Small],
                transcription: false,
            },
            TierRule {
                tier: Tier::Free,
                amount: NanoUsd::new(500_000_000).expect("fixed money"),
                month_pool: Some(month_pool),
                day_pool: Some(day_pool),
                in_flight: 1,
                calls_per_minute: 30,
                output_ceiling: 16000,
                text: [ModelClass::Large, ModelClass::Medium, ModelClass::Small],
                transcription: false,
            },
            TierRule {
                tier: Tier::One,
                amount: NanoUsd::new(7_000_000_000).expect("fixed money"),
                month_pool: None,
                day_pool: None,
                in_flight: 2,
                calls_per_minute: 60,
                output_ceiling: 16000,
                text: [ModelClass::Large, ModelClass::Medium, ModelClass::Small],
                transcription: true,
            },
        ],
        models: vec![
            TextModel {
                class: ModelClass::Large,
                provider: Provider::Anthropic,
                model: "claude-opus-5".to_owned(),
            },
            TextModel {
                class: ModelClass::Medium,
                provider: Provider::Anthropic,
                model: "claude-sonnet-5".to_owned(),
            },
            TextModel {
                class: ModelClass::Small,
                provider: Provider::Anthropic,
                model: "claude-haiku-4-5".to_owned(),
            },
        ],
        transcription: LiveModel {
            provider: Provider::OpenAi,
            model: "gpt-live-transcribe".to_owned(),
            delay: "medium".to_owned(),
        },
        labels: vec!["other".to_owned()],
        owner_grants_max: 25,
        hourly_fuse: NanoUsd::new(20_000_000_000).expect("fixed money"),
    }
}

fn prices() -> PriceBook {
    PriceBook {
        version: "test-1".to_owned(),
        models: [
            (
                Provider::Anthropic,
                "claude-opus-5",
                Some((5000, 25000, 6250, 10000, 500)),
                None,
            ),
            (
                Provider::Anthropic,
                "claude-sonnet-5",
                Some((2000, 10000, 2500, 4000, 200)),
                None,
            ),
            (
                Provider::Anthropic,
                "claude-haiku-4-5",
                Some((1000, 5000, 1250, 2000, 100)),
                None,
            ),
            (
                Provider::OpenAi,
                "gpt-live-transcribe",
                None,
                Some(17_000_000),
            ),
        ]
        .into_iter()
        .map(|(provider, model, tokens, audio)| ModelPrice {
            provider,
            model: model.to_owned(),
            tokens: tokens.map(|(input, output, cache_write, cache_write_1h, cache_read)| {
                TokenRates {
                    input: NanoUsd::new(input).unwrap(),
                    output: NanoUsd::new(output).unwrap(),
                    cache_write: NanoUsd::new(cache_write).unwrap(),
                    cache_write_1h: NanoUsd::new(cache_write_1h).unwrap(),
                    cache_read: NanoUsd::new(cache_read).unwrap(),
                }
            }),
            long_prompt: None,
            audio_per_minute: audio.map(|amount| NanoUsd::new(amount).unwrap()),
            audio_billing_verified: false,
            source: "https://example.test/prices".to_owned(),
            checked_at: "2026-11-15".to_owned(),
        })
        .collect(),
    }
}

#[tokio::test]
async fn admission_is_atomic_and_dispatch_is_once() {
    let Ok(url) = std::env::var("AI_TEST_DATABASE_URL") else {
        return;
    };
    let ledger = Ledger::connect(&url, tiers(), prices()).await.unwrap();
    assert!(ledger.acquire_lock().await.unwrap());
    let identity = Identity {
        principal: Principal::Account(uuid::Uuid::new_v4().to_string()),
        plan: Plan::None,
        owner_grant: false,
        installation: None,
        client: Client::Web,
    };
    let request = || Admission {
        identity: identity.clone(),
        caller_id: CallerId::new("atomic_call_identifier_01".to_owned()).unwrap(),
        label: "other".to_owned(),
        requested: ModelClass::Small,
        reservation: Reservation::Text(TextBudget {
            input_tokens: 10,
            max_tokens: 10,
            min_tokens: None,
            cache: false,
        }),
    };
    let (left, right) = tokio::join!(
        ledger.admit(request(), 1_794_700_800_000),
        ledger.admit(request(), 1_794_700_800_000)
    );
    let left = left.unwrap();
    let right = right.unwrap();
    let (first, replay) = match (left, right) {
        (AdmissionOutcome::Admitted(a), AdmissionOutcome::Existing(b))
        | (AdmissionOutcome::Existing(b), AdmissionOutcome::Admitted(a)) => (a, b),
        _ => panic!("exactly one reservation"),
    };
    assert_eq!(first.id, replay.id);
    let (first_dispatch, second_dispatch) = tokio::join!(
        ledger.dispatch(first.id, 1_794_700_800_001),
        ledger.dispatch(first.id, 1_794_700_800_001)
    );
    assert!(matches!(
        (first_dispatch, second_dispatch),
        (Ok(()), Err(StaticCode::Conflict)) | (Err(StaticCode::Conflict), Ok(()))
    ));
    let settled = ledger
        .settle(
            first.id,
            Settlement {
                charge: Charge::Usage(TokenUsage {
                    input: 10,
                    output: 5,
                    ..TokenUsage::default()
                }),
                stop: Some(Stop::Completed),
                code: None,
                provider_request_id: Some("request_test_1".to_owned()),
            },
            1_794_700_800_100,
        )
        .await
        .unwrap();
    assert_eq!(settled.charged.usd(), "0.000035");
    let allowance = ledger
        .allowance(&identity, 1_794_700_800_101)
        .await
        .unwrap();
    assert_eq!(
        (
            allowance.used.usd(),
            allowance.reserved.usd(),
            allowance.remaining.usd()
        ),
        ("0.000035".to_owned(), "0".to_owned(), "0.499965".to_owned())
    );
}
