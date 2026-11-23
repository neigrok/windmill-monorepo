use ai_domain::*;

fn price() -> ModelPrice {
    ModelPrice {
        provider: Provider::Anthropic,
        model: "test".to_owned(),
        tokens: Some(TokenRates {
            input: NanoUsd::new(2000).unwrap(),
            output: NanoUsd::new(10000).unwrap(),
            cache_write: NanoUsd::new(2500).unwrap(),
            cache_write_1h: NanoUsd::new(4000).unwrap(),
            cache_read: NanoUsd::new(200).unwrap(),
        }),
        long_prompt: Some((
            200_000,
            TokenRates {
                input: NanoUsd::new(4000).unwrap(),
                output: NanoUsd::new(15000).unwrap(),
                cache_write: NanoUsd::new(5000).unwrap(),
                cache_write_1h: NanoUsd::new(8000).unwrap(),
                cache_read: NanoUsd::new(400).unwrap(),
            },
        )),
        audio_per_minute: Some(NanoUsd::new(17_000_000).unwrap()),
        audio_billing_verified: false,
        source: "test".to_owned(),
        checked_at: "2026-11-15".to_owned(),
    }
}

fn grant(id: i64, start: i64, end: i64, source: GrantSource) -> Grant {
    Grant {
        id,
        reference: format!("reference_{id}"),
        account_id: "account".to_owned(),
        source,
        period: Period::new(start, end).unwrap(),
        closed_at: None,
        amount: NanoUsd::new(7_000_000_000).unwrap(),
        spent: NanoUsd::ZERO,
        held: NanoUsd::ZERO,
    }
}

fn call(capability: Capability) -> Call {
    Call {
        id: 1,
        principal: Principal::Account("account".to_owned()),
        caller_id: CallerId::new("test_call_identifier_0001".to_owned()).unwrap(),
        capability,
        tier: Tier::One,
        requested: ModelClass::Medium,
        route: ModelRoute {
            provider: Provider::Anthropic,
            model: "test".to_owned(),
            served: ModelClass::Medium,
        },
        price_version: "test".to_owned(),
        label: "other".to_owned(),
        client: Client::Web,
        state: CallState::Dispatched,
        reservation: NanoUsd::new(17_000_000).unwrap(),
        charged: None,
        original_charge: None,
        max_tokens: Some(100),
        usage: None,
        audio_bytes: 0,
        audio_seconds: 0,
        turns: 0,
        slices: 1,
        provider_request_id: None,
        stop: None,
        code: None,
        created_at: 0,
        ended_at: None,
    }
}

#[test]
fn exact_money_and_checked_boundaries() {
    for (source, nanos, decimal) in [
        ("0", 0, "0"),
        ("0.000000001", 1, "0.000000001"),
        ("7.000000000", 7_000_000_000, "7"),
        ("9223372036.854775807", i64::MAX, "9223372036.854775807"),
    ] {
        let money = NanoUsd::from_usd(source).unwrap();
        assert_eq!((money.nanos(), money.usd()), (nanos, decimal.to_owned()));
        assert_eq!(NanoUsd::from_usd(&money.usd()), Ok(money));
    }
    for invalid in [
        "",
        "-1",
        "+1",
        "1e3",
        ".1",
        "1.",
        "0.0000000001",
        "9223372036.854775808",
        "NaN",
        " 1",
    ] {
        assert_eq!(NanoUsd::from_usd(invalid), Err(StaticCode::InvalidRequest));
    }
    assert_eq!(
        NanoUsd::new(i64::MAX)
            .unwrap()
            .checked_add(NanoUsd::new(1).unwrap()),
        Err(StaticCode::InvalidRequest)
    );
    assert_eq!(
        NanoUsd::new(17_000_000)
            .unwrap()
            .ratio_ceil(1, 60)
            .unwrap()
            .usd(),
        "0.000283334"
    );
    assert_eq!(
        NanoUsd::new(i64::MAX)
            .unwrap()
            .remaining(NanoUsd::new(i64::MAX).unwrap(), NanoUsd::new(1).unwrap()),
        Ok(NanoUsd::ZERO)
    );
}

#[test]
fn calendar_boundaries_are_utc_and_leap_safe() {
    assert_eq!(
        Period::month(0).unwrap(),
        Period {
            start: 0,
            end: 2_678_400_000
        }
    );
    assert_eq!(
        Period::month(1_709_251_200_000).unwrap(),
        Period {
            start: 1_709_251_200_000,
            end: 1_711_929_600_000
        }
    );
    let february = Period::month(1_706_745_600_000).unwrap();
    assert_eq!(february.end - february.start, 29 * 86_400_000);
    assert_eq!(
        Period::day(86_400_000).unwrap(),
        Period {
            start: 86_400_000,
            end: 172_800_000
        }
    );
    assert_eq!(Period::month(i64::MAX), Err(StaticCode::InvalidRequest));
}

#[test]
fn admission_chooses_largest_cap_and_preserves_refusal_order() {
    let request = TextBudget {
        input_tokens: 100,
        max_tokens: 1000,
        min_tokens: Some(100),
        cache: true,
    };
    let budgets = [
        (
            NanoUsd::new(3_000_000).unwrap(),
            StaticCode::SubjectExhausted,
        ),
        (
            NanoUsd::new(2_000_000).unwrap(),
            StaticCode::FreeMonthExhausted,
        ),
        (
            NanoUsd::new(1_500_000).unwrap(),
            StaticCode::FreeDayExhausted,
        ),
    ];
    let (cap, reserve) = price().reserve_text(request, 16000, &budgets).unwrap();
    assert_eq!((cap, reserve.usd()), (108, "0.001495".to_owned()));
    assert_eq!(
        price().reserve_text(
            TextBudget {
                min_tokens: Some(109),
                ..request
            },
            16000,
            &budgets
        ),
        Err(StaticCode::FreeDayExhausted)
    );
    assert_eq!(
        price().reserve_text(
            request,
            16000,
            &[
                (NanoUsd::ZERO, StaticCode::SubjectExhausted),
                (NanoUsd::ZERO, StaticCode::FreeMonthExhausted)
            ]
        ),
        Err(StaticCode::SubjectExhausted)
    );
    assert_eq!(
        price().reserve_text(
            TextBudget {
                input_tokens: u64::MAX,
                ..request
            },
            16000,
            &budgets
        ),
        Err(StaticCode::InvalidRequest)
    );
    assert_eq!(
        price().reserve_text(
            TextBudget {
                max_tokens: 2001,
                min_tokens: Some(2001),
                ..request
            },
            2000,
            &budgets
        ),
        Err(StaticCode::InvalidRequest)
    );
}

#[test]
fn prices_every_usage_category_and_long_prompt_independently() {
    assert_eq!(
        price()
            .text_cost(TokenUsage {
                input: 10,
                output: 20,
                cache_write: 30,
                cache_write_1h: 40,
                cache_read: 50
            })
            .unwrap()
            .usd(),
        "0.000465"
    );
    assert_eq!(
        price()
            .text_cost(TokenUsage {
                input: 200_001,
                output: 1,
                ..TokenUsage::default()
            })
            .unwrap()
            .usd(),
        "0.800019"
    );
}

#[test]
fn grants_are_idempotent_and_only_same_source_overlaps_conflict() {
    let existing = grant(1, 100, 200, GrantSource::Subscription);
    let request = Fund {
        reference: existing.reference.clone(),
        account_id: "account".to_owned(),
        plan: Plan::One,
        period: existing.period,
    };
    assert_eq!(
        request.decide(Some(&existing), &[]),
        Ok(GrantOutcome::Replay)
    );
    assert_eq!(
        Fund {
            account_id: "other".to_owned(),
            ..request
        }
        .decide(Some(&existing), &[]),
        Ok(GrantOutcome::Conflict)
    );
    let request = Fund {
        reference: "second".to_owned(),
        account_id: "account".to_owned(),
        plan: Plan::One,
        period: Period::new(150, 250).unwrap(),
    };
    assert_eq!(
        request.decide(None, std::slice::from_ref(&existing)),
        Ok(GrantOutcome::Conflict)
    );
    assert_eq!(
        request.decide(None, &[grant(2, 100, 300, GrantSource::Owner)]),
        Ok(GrantOutcome::Ok)
    );
    let mut closed = existing.clone();
    closed.closed_at = Some(existing.close_at(150).unwrap());
    assert_eq!(closed.close_at(180), Ok(150));
    assert_eq!(
        request.decide(None, &[closed.clone()]),
        Ok(GrantOutcome::Ok)
    );
    assert_eq!(
        closed.reopen_outcome(&[grant(3, 150, 250, GrantSource::Subscription)]),
        GrantOutcome::Conflict
    );
    assert_eq!(
        closed.reopen_outcome(&[grant(3, 150, 250, GrantSource::Owner)]),
        GrantOutcome::Ok
    );
    assert_eq!(
        (
            owner_grant(false, false, 24, 25),
            owner_grant(false, false, 25, 25),
            owner_grant(true, false, 25, 25)
        ),
        (
            OwnerGrantDecision::Fund,
            OwnerGrantDecision::Cap,
            OwnerGrantDecision::Existing
        )
    );
}

#[test]
fn settlement_releases_hold_and_records_whole_excess() {
    let mut call = call(Capability::Text);
    call.reservation = NanoUsd::new(100).unwrap();
    let change = call
        .settlement(
            Charge::Usage(TokenUsage {
                input: 1,
                ..TokenUsage::default()
            }),
            &price(),
            NanoUsd::ZERO,
            call.reservation,
        )
        .unwrap();
    assert_eq!(
        (
            change.state,
            change.cost.nanos(),
            change.spent_delta,
            change.held_delta,
            change.excess.nanos()
        ),
        (CallState::Settled, 2000, 2000, -100, 1900)
    );
    let change = call
        .settlement(Charge::Assumed, &price(), NanoUsd::ZERO, call.reservation)
        .unwrap();
    assert_eq!(
        (
            change.state,
            change.cost.nanos(),
            change.spent_delta,
            change.held_delta
        ),
        (CallState::Assumed, 100, 100, -100)
    );
    call.state = CallState::Reserved;
    assert!(matches!(
        call.settlement(Charge::Assumed, &price(), NanoUsd::ZERO, call.reservation),
        Err(StaticCode::Conflict)
    ));
    assert_eq!(
        call.settlement(
            Charge::Unconsumed,
            &price(),
            NanoUsd::ZERO,
            call.reservation
        )
        .unwrap()
        .cost,
        NanoUsd::ZERO
    );
}

#[test]
fn live_slices_price_rounded_turns_and_move_only_incremental_cost() {
    assert_eq!(rounded_audio_seconds(&[48_002, 48_002, 0]), Ok(4));
    let mut call = call(Capability::Transcription);
    let progress = LiveProgress {
        slice: 2,
        audio_bytes: 48_002 * 30,
        audio_seconds: 60,
        turns: 30,
    };
    let slice = progress
        .reserve(
            &call,
            &price(),
            LiveCapacity {
                applied: NanoUsd::ZERO,
                held: call.reservation,
                grant_active: true,
                fuse_open: false,
                budgets: &[NanoUsd::new(1_000_000_000).unwrap()],
            },
        )
        .unwrap();
    assert_eq!(
        (
            slice.reservation.nanos(),
            slice.cost.nanos(),
            slice.spent_delta,
            slice.held_delta
        ),
        (34_000_000, 17_000_000, 17_000_000, 0)
    );
    call.slices = 2;
    call.reservation = slice.reservation;
    call.audio_bytes = progress.audio_bytes;
    call.audio_seconds = 60;
    call.turns = 30;
    assert!(progress.is_replay(&call));
    let change = call
        .settlement(
            Charge::Audio {
                bytes: 48_002 * 31,
                seconds: 62,
                turns: 31,
            },
            &price(),
            slice.cost,
            slice.held,
        )
        .unwrap();
    assert_eq!(
        (change.cost.nanos(), change.spent_delta, change.held_delta),
        (17_566_667, 566_667, -17_000_000)
    );
    assert!(matches!(
        LiveProgress {
            slice: 3,
            ..progress
        }
        .reserve(
            &call,
            &price(),
            LiveCapacity {
                applied: slice.cost,
                held: slice.held,
                grant_active: false,
                fuse_open: false,
                budgets: &[NanoUsd::new(1_000_000_000).unwrap()]
            }
        ),
        Err(StaticCode::FundingRequired)
    ));
    assert_eq!(
        validate_audio(48_002, 3, 1),
        Err(StaticCode::InvalidRequest)
    );
    call.slices = 55;
    call.reservation = NanoUsd::new(935_000_000).unwrap();
    call.audio_bytes = 48_002 * 1620;
    call.audio_seconds = 3240;
    call.turns = 1620;
    let progress = LiveProgress {
        slice: 56,
        audio_bytes: 48_002 * 1650,
        audio_seconds: 3300,
        turns: 1650,
    };
    assert_eq!(
        progress
            .reserve(
                &call,
                &price(),
                LiveCapacity {
                    applied: NanoUsd::new(918_000_000).unwrap(),
                    held: NanoUsd::new(17_000_000).unwrap(),
                    grant_active: true,
                    fuse_open: false,
                    budgets: &[NanoUsd::new(1_000_000_000).unwrap()]
                }
            )
            .unwrap()
            .reservation
            .nanos(),
        952_000_000
    );
}

#[test]
fn ten_thousand_reservations_are_maximal_and_never_exceed_any_budget() {
    let mut seed = 0x6174_6f6d_6963_u64;
    for _ in 0..10_000 {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let input = seed % 10_000;
        let maximum = (seed.rotate_left(13) % 16_000 + 1) as u32;
        let minimum = (seed.rotate_left(29) % u64::from(maximum) + 1) as u32;
        let money = NanoUsd::new((seed.rotate_left(7) % 200_000_000) as i64).unwrap();
        let request = TextBudget {
            input_tokens: input,
            max_tokens: maximum,
            min_tokens: Some(minimum),
            cache: seed & 1 == 0,
        };
        match price().reserve_text(request, 16_000, &[(money, StaticCode::SubjectExhausted)]) {
            Ok((cap, reservation)) => {
                assert!((minimum..=maximum).contains(&cap));
                assert!(reservation <= money);
                if cap < maximum {
                    assert_eq!(
                        price().reserve_text(
                            TextBudget {
                                min_tokens: Some(cap + 1),
                                ..request
                            },
                            16_000,
                            &[(money, StaticCode::SubjectExhausted)]
                        ),
                        Err(StaticCode::SubjectExhausted)
                    );
                }
            }
            Err(code) => assert_eq!(code, StaticCode::SubjectExhausted),
        }
    }
}

#[test]
fn a_persons_pool_name_has_one_limit_and_background_work_stays_below_the_fuse() {
    let row = TierRule {
        tier: Tier::Anonymous,
        amount: NanoUsd::new(1_000_000).unwrap(),
        month_pool: Some(PoolRule {
            name: "shared".to_owned(),
            limit: NanoUsd::new(2_000_000).unwrap(),
        }),
        day_pool: Some(PoolRule {
            name: "shared".to_owned(),
            limit: NanoUsd::new(1_000_000).unwrap(),
        }),
        in_flight: 1,
        calls_per_minute: 30,
        output_ceiling: 2000,
        text: [ModelClass::Large, ModelClass::Medium, ModelClass::Small],
        transcription: false,
    };
    let mut table = TierTable {
        rows: vec![
            row.clone(),
            TierRule {
                tier: Tier::Free,
                ..row.clone()
            },
            TierRule {
                tier: Tier::One,
                month_pool: None,
                day_pool: None,
                transcription: true,
                ..row.clone()
            },
            TierRule {
                tier: Tier::Background,
                month_pool: Some(PoolRule {
                    name: "shared".to_owned(),
                    limit: NanoUsd::new(5_000_000).unwrap(),
                }),
                text: [ModelClass::Medium, ModelClass::Medium, ModelClass::Small],
                ..row
            },
        ],
        models: [ModelClass::Large, ModelClass::Medium, ModelClass::Small]
            .into_iter()
            .map(|class| TextModel {
                class,
                provider: Provider::Anthropic,
                model: "test".to_owned(),
            })
            .collect(),
        transcription: LiveModel {
            provider: Provider::Anthropic,
            model: "test".to_owned(),
            delay: "low".to_owned(),
        },
        labels: vec!["other".to_owned()],
        owner_grants_max: 25,
        hourly_fuse: NanoUsd::new(1_000_000).unwrap(),
        background_hour: NanoUsd::new(500_000).unwrap(),
    };
    let book = PriceBook {
        version: "test".to_owned(),
        models: vec![price()],
    };
    assert_eq!(table.validate(&book), Ok(()));
    table.rows[1].month_pool.as_mut().unwrap().limit = NanoUsd::new(3_000_000).unwrap();
    assert_eq!(table.validate(&book), Err(StaticCode::InvalidRequest));
    table.rows[1].month_pool.as_mut().unwrap().name = "independent".to_owned();
    assert_eq!(table.validate(&book), Ok(()));
    table.background_hour = table.hourly_fuse;
    assert_eq!(table.validate(&book), Err(StaticCode::InvalidRequest));
    table.background_hour = NanoUsd::ZERO;
    assert_eq!(table.validate(&book), Err(StaticCode::InvalidRequest));
    table.background_hour = NanoUsd::new(500_000).unwrap();
    table.rows.pop();
    assert_eq!(table.validate(&book), Err(StaticCode::InvalidRequest));
}
