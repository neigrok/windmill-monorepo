use ai_domain::*;
use ai_storage::Ledger;

struct Database {
    url: String,
    name: String,
    admin: sqlx::PgPool,
}

impl Database {
    async fn new() -> Option<Self> {
        let source = std::env::var("AI_TEST_DATABASE_URL").ok()?;
        let admin = sqlx::PgPool::connect(&source).await.unwrap();
        let name = format!("ai_ledger_{}", uuid::Uuid::new_v4().simple());
        sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
            .execute(&admin)
            .await
            .unwrap();
        let mut url = url::Url::parse(&source).unwrap();
        url.set_path(&name);
        Some(Self {
            url: url.to_string(),
            name,
            admin,
        })
    }

    async fn finish(self, ledger: Ledger) {
        drop(ledger);
        sqlx::query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1")
            .bind(&self.name)
            .execute(&self.admin)
            .await
            .unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP DATABASE {}", self.name)))
            .execute(&self.admin)
            .await
            .unwrap();
        self.admin.close().await;
    }
}

fn account(name: &str, plan: Plan) -> Identity {
    Identity {
        principal: Principal::Account(name.to_owned()),
        plan,
        owner_grant: false,
        installation: None,
        client: Client::Web,
    }
}

fn text(identity: &Identity, name: &str, input: u64, output: u32) -> Admission {
    Admission {
        identity: identity.clone(),
        caller_id: CallerId::new(format!("call_identifier_{name:0>12}")).unwrap(),
        label: "other".to_owned(),
        requested: ModelClass::Small,
        reservation: Reservation::Text(TextBudget {
            input_tokens: input,
            max_tokens: output,
            min_tokens: None,
            cache: false,
        }),
    }
}

fn admitted(outcome: AdmissionOutcome) -> Call {
    match outcome {
        AdmissionOutcome::Admitted(call) => call,
        AdmissionOutcome::Existing(_) => panic!("new call required"),
    }
}

fn settlement(charge: Charge) -> Settlement {
    Settlement {
        charge,
        stop: Some(Stop::Completed),
        code: None,
        provider_request_id: None,
    }
}

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
    let Some(database) = Database::new().await else {
        return;
    };
    let ledger = Ledger::connect(&database.url, tiers(), prices())
        .await
        .unwrap();
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
    database.finish(ledger).await;
}

#[tokio::test]
async fn concurrent_different_calls_cannot_oversubscribe_and_pins_survive_rollover() {
    let Some(database) = Database::new().await else {
        return;
    };
    let ledger = Ledger::connect(&database.url, tiers(), prices())
        .await
        .unwrap();
    assert!(ledger.acquire_lock().await.unwrap());
    let identity = account("concurrent", Plan::None);
    let now = Period::month(1_794_700_800_000).unwrap().end - 1;
    let (left, right) = tokio::join!(
        ledger.admit(text(&identity, "left", 100, 100), now),
        ledger.admit(text(&identity, "right", 100, 100), now)
    );
    let call = match (left, right) {
        (Ok(call), Err(StaticCode::ConcurrencyExhausted))
        | (Err(StaticCode::ConcurrencyExhausted), Ok(call)) => admitted(call),
        _ => panic!("one call must be refused"),
    };
    ledger.dispatch(call.id, now).await.unwrap();
    ledger
        .settle(
            call.id,
            settlement(Charge::Usage(TokenUsage {
                input: 100,
                output: 10,
                ..TokenUsage::default()
            })),
            now + 1,
        )
        .await
        .unwrap();
    let previous = ledger.allowance(&identity, now).await.unwrap();
    let next = ledger.allowance(&identity, now + 1).await.unwrap();
    assert_eq!(
        (
            previous.used.nanos(),
            previous.reserved.nanos(),
            next.used.nanos(),
            next.reserved.nanos()
        ),
        (150_000, 0, 0, 0)
    );
    database.finish(ledger).await;
}

#[tokio::test]
async fn grants_replay_overlap_close_reopen_owner_cap_and_source_precedence() {
    let Some(database) = Database::new().await else {
        return;
    };
    let mut table = tiers();
    table.owner_grants_max = 1;
    let ledger = Ledger::connect(&database.url, table, prices())
        .await
        .unwrap();
    assert!(ledger.acquire_lock().await.unwrap());
    let now = 1_794_700_800_000;
    let month = Period::month(now).unwrap();
    let mut owner = account("owner", Plan::One);
    owner.owner_grant = true;
    assert!(matches!(
        ledger.prepare(&owner, now).await.unwrap().events.as_slice(),
        [LedgerEvent::OwnerGrant { outcome: "ok" }]
    ));
    assert!(ledger.prepare(&owner, now).await.unwrap().events.is_empty());
    let mut other = account("other", Plan::One);
    other.owner_grant = true;
    assert!(matches!(
        ledger.prepare(&other, now).await.unwrap().events.as_slice(),
        [LedgerEvent::OwnerGrant {
            outcome: "owner_grant_cap"
        }]
    ));
    assert_eq!(
        ledger.allowance(&other, now).await.unwrap().tier,
        Tier::Free
    );
    let request = || Fund {
        reference: format!("5:owner:{}", month.start),
        account_id: "owner".to_owned(),
        plan: Plan::One,
        period: month,
    };
    let (left, right) = tokio::join!(ledger.fund(request(), now), ledger.fund(request(), now));
    assert!(matches!(
        (left.unwrap(), right.unwrap()),
        (GrantOutcome::Ok, GrantOutcome::Replay) | (GrantOutcome::Replay, GrantOutcome::Ok)
    ));
    assert_eq!(
        ledger.allowance(&owner, now).await.unwrap().period,
        AllowancePeriod::BillingPeriod
    );
    let reference = request().reference;
    assert_eq!(
        ledger
            .fund(
                Fund {
                    account_id: "other".to_owned(),
                    ..request()
                },
                now
            )
            .await
            .unwrap(),
        GrantOutcome::Conflict
    );
    assert_eq!(
        ledger.close(&reference, now + 10).await.unwrap(),
        GrantOutcome::Ok
    );
    assert_eq!(
        ledger.close(&reference, now + 100).await.unwrap(),
        GrantOutcome::Ok
    );
    assert_eq!(
        ledger
            .fund(
                Fund {
                    reference: "next".to_owned(),
                    account_id: "owner".to_owned(),
                    plan: Plan::One,
                    period: Period::new(now + 10, month.end).unwrap()
                },
                now
            )
            .await
            .unwrap(),
        GrantOutcome::Ok
    );
    assert_eq!(
        ledger.reopen(&reference).await.unwrap(),
        GrantOutcome::Conflict
    );
    assert_eq!(
        ledger.close("unknown", now).await.unwrap(),
        GrantOutcome::NotFound
    );
    assert_eq!(
        ledger.reopen("unknown").await.unwrap(),
        GrantOutcome::NotFound
    );
    let mut free = owner.clone();
    free.plan = Plan::None;
    free.owner_grant = false;
    assert_eq!(ledger.allowance(&free, now).await.unwrap().tier, Tier::Free);
    assert_eq!(
        ledger
            .principal(&owner.principal, now, None)
            .await
            .unwrap()
            .grants
            .len(),
        3
    );
    database.finish(ledger).await;
}

#[tokio::test]
async fn bindings_share_in_flight_and_keep_monthly_contributions_after_retention() {
    let Some(database) = Database::new().await else {
        return;
    };
    let ledger = Ledger::connect(&database.url, tiers(), prices())
        .await
        .unwrap();
    assert!(ledger.acquire_lock().await.unwrap());
    let now = 1_794_700_800_000;
    let installation = Identity {
        principal: Principal::Installation("device".to_owned()),
        plan: Plan::None,
        owner_grant: false,
        installation: None,
        client: Client::Ios,
    };
    let call = admitted(
        ledger
            .admit(text(&installation, "device", 100_000, 10), now)
            .await
            .unwrap(),
    );
    ledger.dispatch(call.id, now).await.unwrap();
    let mut identity = account("account", Plan::None);
    identity.installation = Some("device".to_owned());
    assert!(matches!(
        ledger
            .prepare(&identity, now)
            .await
            .unwrap()
            .events
            .as_slice(),
        [LedgerEvent::InstallationBind { outcome: "ok" }]
    ));
    let allowance = ledger.allowance(&identity, now).await.unwrap();
    assert_eq!(
        (allowance.code, allowance.reserved),
        (StaticCode::ConcurrencyExhausted, call.reservation)
    );
    assert_eq!(
        ledger
            .lookup(&identity.principal, &call.caller_id)
            .await
            .unwrap()
            .unwrap()
            .id,
        call.id
    );
    assert!(matches!(
        ledger
            .admit(text(&installation, "blocked", 0, 1), now)
            .await,
        Err(StaticCode::DeviceBound)
    ));
    let mut contradicted = account("different", Plan::None);
    contradicted.installation = Some("device".to_owned());
    assert!(matches!(
        ledger
            .prepare(&contradicted, now)
            .await
            .unwrap()
            .events
            .as_slice(),
        [LedgerEvent::InstallationBind {
            outcome: "binding_contradiction"
        }]
    ));
    ledger
        .settle(
            call.id,
            settlement(Charge::Usage(TokenUsage {
                input: 100_000,
                ..TokenUsage::default()
            })),
            now + 1,
        )
        .await
        .unwrap();
    assert_eq!(
        ledger
            .allowance(&identity, now + 1)
            .await
            .unwrap()
            .used
            .nanos(),
        100_000_000
    );
    assert_eq!(
        ledger
            .allowance(&contradicted, now + 1)
            .await
            .unwrap()
            .used
            .nanos(),
        0
    );
    assert_eq!(
        ledger
            .sweep(&[], now + 1 + 90 * 86_400_000)
            .await
            .unwrap()
            .deleted,
        1
    );
    assert!(ledger.call(call.id).await.unwrap().is_none());
    assert_eq!(
        ledger
            .allowance(&identity, now + 1)
            .await
            .unwrap()
            .used
            .nanos(),
        100_000_000
    );
    assert_eq!(
        ledger
            .allowance(&identity, Period::month(now).unwrap().end)
            .await
            .unwrap()
            .used
            .nanos(),
        0
    );
    database.finish(ledger).await;
}

#[tokio::test]
async fn live_slices_are_retry_safe_and_final_cost_is_not_charged_twice() {
    let Some(database) = Database::new().await else {
        return;
    };
    let ledger = Ledger::connect(&database.url, tiers(), prices())
        .await
        .unwrap();
    assert!(ledger.acquire_lock().await.unwrap());
    let now = 1_794_700_800_000;
    let identity = account("speaker", Plan::One);
    ledger
        .fund(
            Fund {
                reference: "subscription".to_owned(),
                account_id: "speaker".to_owned(),
                plan: Plan::One,
                period: Period::month(now).unwrap(),
            },
            now,
        )
        .await
        .unwrap();
    let call = admitted(
        ledger
            .admit(
                Admission {
                    identity: identity.clone(),
                    caller_id: CallerId::new("live_call_identifier_001".to_owned()).unwrap(),
                    label: "talk".to_owned(),
                    requested: ModelClass::Small,
                    reservation: Reservation::Transcription,
                },
                now,
            )
            .await
            .unwrap(),
    );
    ledger.dispatch(call.id, now).await.unwrap();
    let progress = LiveProgress {
        slice: 2,
        audio_bytes: 48_002 * 30,
        audio_seconds: 60,
        turns: 30,
    };
    let (left, right) = tokio::join!(
        ledger.extend_live(call.id, progress.clone(), now + 60_000),
        ledger.extend_live(call.id, progress.clone(), now + 60_000)
    );
    assert_eq!(
        (
            left.unwrap().reservation.nanos(),
            right.unwrap().reservation.nanos()
        ),
        (34_000_000, 34_000_000)
    );
    let allowance = ledger.allowance(&identity, now + 60_000).await.unwrap();
    assert_eq!(
        (allowance.used.nanos(), allowance.reserved.nanos()),
        (17_000_000, 17_000_000)
    );
    assert_eq!(
        ledger
            .fuse(Provider::OpenAi, now + 60_000)
            .await
            .unwrap()
            .spent
            .nanos(),
        17_000_000
    );
    let result = ledger
        .settle(
            call.id,
            settlement(Charge::Audio {
                bytes: 48_002 * 31,
                seconds: 62,
                turns: 31,
            }),
            now + 62_000,
        )
        .await
        .unwrap();
    assert_eq!(result.charged.nanos(), 17_566_667);
    let replay = ledger
        .settle(call.id, settlement(Charge::Assumed), now + 63_000)
        .await
        .unwrap();
    assert_eq!((replay.charged.nanos(), replay.replay), (17_566_667, true));
    let allowance = ledger.allowance(&identity, now + 63_000).await.unwrap();
    assert_eq!(
        (allowance.used.nanos(), allowance.reserved.nanos()),
        (17_566_667, 0)
    );
    assert_eq!(
        ledger
            .fuse(Provider::OpenAi, now + 63_000)
            .await
            .unwrap()
            .spent
            .nanos(),
        17_566_667
    );
    assert_eq!(
        ledger
            .fuse(Provider::OpenAi, now + 3_661_000)
            .await
            .unwrap()
            .spent
            .nanos(),
        17_566_667
    );
    assert_eq!(
        ledger
            .fuse(Provider::OpenAi, now + 3_662_000)
            .await
            .unwrap()
            .spent
            .nanos(),
        0
    );
    let second = admitted(
        ledger
            .admit(
                Admission {
                    identity: identity.clone(),
                    caller_id: CallerId::new("live_call_identifier_002".to_owned()).unwrap(),
                    label: "talk".to_owned(),
                    requested: ModelClass::Small,
                    reservation: Reservation::Transcription,
                },
                now + 64_000,
            )
            .await
            .unwrap(),
    );
    ledger.dispatch(second.id, now + 64_000).await.unwrap();
    ledger.close("subscription", now + 65_000).await.unwrap();
    assert!(matches!(
        ledger.extend_live(second.id, progress, now + 66_000).await,
        Err(StaticCode::FundingRequired)
    ));
    ledger
        .settle(
            second.id,
            settlement(Charge::Audio {
                bytes: 48_000,
                seconds: 1,
                turns: 1,
            }),
            now + 66_000,
        )
        .await
        .unwrap();
    database.finish(ledger).await;
}

#[tokio::test]
async fn thresholds_cross_once_and_excess_is_fully_spent() {
    let Some(database) = Database::new().await else {
        return;
    };
    let mut table = tiers();
    for row in &mut table.rows {
        if let Some(pool) = row.month_pool.as_mut() {
            pool.limit = NanoUsd::new(100_000).unwrap();
        }
        if let Some(pool) = row.day_pool.as_mut() {
            pool.limit = NanoUsd::new(100_000).unwrap();
        }
    }
    let ledger = Ledger::connect(&database.url, table, prices())
        .await
        .unwrap();
    assert!(ledger.acquire_lock().await.unwrap());
    let now = 1_794_700_800_000;
    let identity = account("thresholds", Plan::None);
    let call = admitted(
        ledger
            .admit(text(&identity, "one", 0, 1), now)
            .await
            .unwrap(),
    );
    let mut events = ledger
        .drain_events()
        .await
        .unwrap()
        .into_iter()
        .map(|event| match event {
            LedgerEvent::Threshold { percent, .. } => percent,
            _ => panic!("threshold only"),
        })
        .collect::<Vec<_>>();
    events.sort();
    assert_eq!(events, vec![50, 50]);
    ledger
        .settle(call.id, settlement(Charge::Unconsumed), now + 1)
        .await
        .unwrap();
    let call = admitted(
        ledger
            .admit(text(&identity, "two", 0, 1), now + 2)
            .await
            .unwrap(),
    );
    assert!(ledger.drain_events().await.unwrap().is_empty());
    ledger.dispatch(call.id, now + 2).await.unwrap();
    let result = ledger
        .settle(
            call.id,
            settlement(Charge::Usage(TokenUsage {
                output: 40,
                ..TokenUsage::default()
            })),
            now + 3,
        )
        .await
        .unwrap();
    assert_eq!(
        (result.charged.nanos(), result.excess.nanos()),
        (200_000, 131_000)
    );
    let mut events = ledger
        .drain_events()
        .await
        .unwrap()
        .into_iter()
        .map(|event| match event {
            LedgerEvent::Threshold { percent, .. } => percent,
            _ => panic!("threshold only"),
        })
        .collect::<Vec<_>>();
    events.sort();
    assert_eq!(events, vec![80, 80, 95, 95]);
    assert_eq!(
        ledger.allowance(&identity, now + 3).await.unwrap().code,
        StaticCode::FreeMonthExhausted
    );
    ledger
        .settle(call.id, settlement(Charge::Assumed), now + 4)
        .await
        .unwrap();
    assert!(ledger.drain_events().await.unwrap().is_empty());
    database.finish(ledger).await;
}

#[tokio::test]
async fn corrections_keep_original_charge_and_cannot_clear_a_new_hour_fuse() {
    let Some(database) = Database::new().await else {
        return;
    };
    let mut table = tiers();
    table.hourly_fuse = NanoUsd::new(50_000).unwrap();
    let ledger = Ledger::connect(&database.url, table, prices())
        .await
        .unwrap();
    assert!(ledger.acquire_lock().await.unwrap());
    let now = 1_794_700_800_000;
    let identity = account("correction", Plan::None);
    let old = admitted(
        ledger
            .admit(text(&identity, "old", 0, 1), now)
            .await
            .unwrap(),
    );
    ledger.dispatch(old.id, now).await.unwrap();
    ledger
        .settle(old.id, settlement(Charge::Assumed), now + 1)
        .await
        .unwrap();
    assert!(
        ledger
            .fuse(Provider::Anthropic, now + 2)
            .await
            .unwrap()
            .paused
    );
    assert!(matches!(
        ledger.admit(text(&identity, "paused", 0, 1), now + 2).await,
        Err(StaticCode::Paused)
    ));
    let later = now + 3_660_000;
    let current = admitted(
        ledger
            .admit(text(&identity, "current", 0, 1), later)
            .await
            .unwrap(),
    );
    ledger.dispatch(current.id, later).await.unwrap();
    ledger
        .settle(current.id, settlement(Charge::Assumed), later + 1)
        .await
        .unwrap();
    let result = ledger
        .correct(old.id, NanoUsd::ZERO, later + 2)
        .await
        .unwrap();
    assert!(!result.replay);
    assert!(
        ledger
            .correct(old.id, NanoUsd::ZERO, later + 3)
            .await
            .unwrap()
            .replay
    );
    let call = ledger.call(old.id).await.unwrap().unwrap();
    assert_eq!(
        (
            call.charged.unwrap().nanos(),
            call.original_charge.unwrap().nanos()
        ),
        (0, 69_000)
    );
    let fuse = ledger.fuse(Provider::Anthropic, later + 3).await.unwrap();
    assert_eq!((fuse.spent.nanos(), fuse.paused), (69_000, true));
    assert_eq!(
        ledger
            .allowance(&identity, later + 3)
            .await
            .unwrap()
            .used
            .nanos(),
        69_000
    );
    database.finish(ledger).await;
}

#[tokio::test]
async fn session_lock_loss_fails_closed_and_restart_sweeps_only_orphans() {
    let Some(database) = Database::new().await else {
        return;
    };
    let ledger = Ledger::connect(&database.url, tiers(), prices())
        .await
        .unwrap();
    assert!(ledger.acquire_lock().await.unwrap());
    let second = Ledger::connect(&database.url, tiers(), prices())
        .await
        .unwrap();
    assert!(!second.acquire_lock().await.unwrap());
    let now = 1_794_700_800_000;
    let first_identity = account("first", Plan::None);
    let second_identity = account("second", Plan::None);
    let reserved = admitted(
        ledger
            .admit(text(&first_identity, "reserved", 0, 1), now)
            .await
            .unwrap(),
    );
    let dispatched = admitted(
        ledger
            .admit(text(&second_identity, "dispatched", 0, 1), now)
            .await
            .unwrap(),
    );
    ledger.dispatch(dispatched.id, now).await.unwrap();
    assert!(
        ledger
            .sweep(&[reserved.id, dispatched.id], now + 1)
            .await
            .unwrap()
            .events
            .is_empty()
    );
    let control = sqlx::PgPool::connect(&database.url).await.unwrap();
    sqlx::query("SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())").execute(&control).await.unwrap();
    assert!(!ledger.lock_alive().await);
    assert!(matches!(
        ledger
            .admit(text(&first_identity, "failclosed", 0, 1), now + 2)
            .await,
        Err(StaticCode::AccountingUnavailable)
    ));
    assert!(second.acquire_lock().await.unwrap());
    let sweep = second
        .sweep(&[reserved.id, dispatched.id], now + 2)
        .await
        .unwrap();
    assert_eq!(sweep.events.len(), 2);
    assert_eq!(
        second.call(reserved.id).await.unwrap().unwrap().state,
        CallState::Unconsumed
    );
    assert_eq!(
        second.call(dispatched.id).await.unwrap().unwrap().state,
        CallState::Assumed
    );
    assert_eq!(
        second
            .allowance(&second_identity, now + 2)
            .await
            .unwrap()
            .reserved,
        NanoUsd::ZERO
    );
    assert!(!ledger.acquire_lock().await.unwrap());
    control.close().await;
    drop(ledger);
    database.finish(second).await;
}

#[tokio::test]
async fn settlement_transaction_failure_rolls_back_money_and_retries_once() {
    let Some(database) = Database::new().await else {
        return;
    };
    let ledger = Ledger::connect(&database.url, tiers(), prices())
        .await
        .unwrap();
    assert!(ledger.acquire_lock().await.unwrap());
    let now = 1_794_700_800_000;
    let identity = account("failure", Plan::None);
    let call = admitted(
        ledger
            .admit(text(&identity, "failure", 0, 1), now)
            .await
            .unwrap(),
    );
    ledger.dispatch(call.id, now).await.unwrap();
    let control = sqlx::PgPool::connect(&database.url).await.unwrap();
    sqlx::query("CREATE FUNCTION reject_settlement() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''test failure''; END'").execute(&control).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_settlement BEFORE UPDATE ON ai_calls FOR EACH ROW WHEN (NEW.state = 'settled') EXECUTE FUNCTION reject_settlement()").execute(&control).await.unwrap();
    assert!(matches!(
        ledger
            .settle(
                call.id,
                settlement(Charge::Usage(TokenUsage {
                    output: 1,
                    ..TokenUsage::default()
                })),
                now + 1
            )
            .await,
        Err(StaticCode::AccountingUnavailable)
    ));
    let allowance = ledger.allowance(&identity, now + 1).await.unwrap();
    assert_eq!(
        (allowance.used.nanos(), allowance.reserved.nanos()),
        (0, 69_000)
    );
    assert_eq!(
        ledger.call(call.id).await.unwrap().unwrap().state,
        CallState::Dispatched
    );
    assert_eq!(
        ledger
            .fuse(Provider::Anthropic, now + 1)
            .await
            .unwrap()
            .spent
            .nanos(),
        0
    );
    sqlx::query("DROP TRIGGER reject_settlement ON ai_calls")
        .execute(&control)
        .await
        .unwrap();
    sqlx::query("DROP FUNCTION reject_settlement()")
        .execute(&control)
        .await
        .unwrap();
    ledger
        .settle(
            call.id,
            settlement(Charge::Usage(TokenUsage {
                output: 1,
                ..TokenUsage::default()
            })),
            now + 2,
        )
        .await
        .unwrap();
    let allowance = ledger.allowance(&identity, now + 2).await.unwrap();
    assert_eq!(
        (allowance.used.nanos(), allowance.reserved.nanos()),
        (5_000, 0)
    );
    control.close().await;
    database.finish(ledger).await;
}

#[tokio::test]
async fn settlement_uses_immutable_rates_when_a_new_process_loads_another_book() {
    let Some(database) = Database::new().await else {
        return;
    };
    let ledger = Ledger::connect(&database.url, tiers(), prices())
        .await
        .unwrap();
    assert!(ledger.acquire_lock().await.unwrap());
    let now = 1_794_700_800_000;
    let identity = account("price_pin", Plan::None);
    let call = admitted(
        ledger
            .admit(text(&identity, "pricepin", 10, 10), now)
            .await
            .unwrap(),
    );
    ledger.dispatch(call.id, now).await.unwrap();
    let control = sqlx::PgPool::connect(&database.url).await.unwrap();
    sqlx::query("SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())").execute(&control).await.unwrap();
    assert!(!ledger.lock_alive().await);
    let mut changed = prices();
    changed.version = "test-2".to_owned();
    for model in &mut changed.models {
        if let Some(tokens) = model.tokens.as_mut() {
            tokens.input = NanoUsd::new(1_000_000).unwrap();
            tokens.output = NanoUsd::new(1_000_000).unwrap();
        }
    }
    let next = Ledger::connect(&database.url, tiers(), changed)
        .await
        .unwrap();
    assert!(next.acquire_lock().await.unwrap());
    let result = next
        .settle(
            call.id,
            settlement(Charge::Usage(TokenUsage {
                input: 10,
                output: 5,
                ..TokenUsage::default()
            })),
            now + 1,
        )
        .await
        .unwrap();
    assert_eq!(result.charged.nanos(), 35_000);
    assert_eq!(
        next.call(call.id).await.unwrap().unwrap().price_version,
        "test-1"
    );
    control.close().await;
    drop(ledger);
    database.finish(next).await;
}
