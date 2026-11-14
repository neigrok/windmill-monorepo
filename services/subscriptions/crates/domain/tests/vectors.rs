use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use domain::{
    AccountEntitlement, AccountHint, AccountId, Accounts, BillingInterval, Change, Claim,
    EndReason, Ending, Entitlement, Environment, Event, Instant, Ledger, Lineage, Money, NewIds,
    NextCharge, Observation, ObservedPeriod, Offer, OfferKind, Ownership, Period, PeriodChange,
    PeriodId, Plan, ProductId, Renewal, Span, State, Status, Store, StoreSubscriptionId,
    StoreTransactionId, Storefront, Subscription, SubscriptionId, observe,
};
use serde_json::{Value, json};

#[test]
fn every_vector_passes() {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/vectors");
    let mut stories: Vec<PathBuf> = fs::read_dir(&directory)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", directory.display()))
        .map(|entry| entry.expect("a readable directory entry").path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    stories.sort();
    assert!(
        stories.len() >= 20,
        "{} holds {} vectors, fewer than the stories written",
        directory.display(),
        stories.len()
    );

    let failures: Vec<String> = stories
        .iter()
        .filter_map(|story| tell(story).err())
        .collect();
    assert!(
        failures.is_empty(),
        "{} of {} vectors failed\n\n{}",
        failures.len(),
        stories.len(),
        failures.join("\n\n")
    );
}

// Runs one story step by step; each step's ids are minted from the store's own ids so a reader can
// follow them: `sub-<storeSubscriptionId>` and `period-<transaction>`.
fn tell(path: &Path) -> Result<(), String> {
    let name = path.file_name().expect("a file name").to_string_lossy();
    let story: Value = serde_json::from_str(&fs::read_to_string(path).expect("a readable vector"))
        .unwrap_or_else(|error| panic!("{name} is not JSON: {error}"));
    exactly(&story, &["story", "steps"]);
    let mut ledgers: HashMap<Lineage, Ledger> = HashMap::new();

    for (index, step) in list(&story, "steps").iter().enumerate() {
        let place = format!("{name} step {}", index + 1);
        exactly(
            step,
            &[
                "note",
                "observation",
                "hint",
                "claim",
                "expect",
                "entitlements",
            ],
        );
        let observation = observation(field(step, "observation"));
        let accounts = Accounts {
            hint: hint(field(step, "hint")),
            claim: claim(field(step, "claim")),
        };
        let ids = NewIds::for_observation(
            &observation,
            SubscriptionId::new(format!(
                "sub-{}",
                observation.lineage.store_subscription_id.as_str()
            )),
            |period| PeriodId::new(format!("period-{}", period.transaction.as_str())),
        );
        let lineage = observation.lineage.clone();
        let ledger = ledgers.get(&lineage).cloned().unwrap_or_default();

        match observe(ledger.clone(), observation, accounts, ids) {
            Ok(change) => {
                compare(&place, field(step, "expect"), &change_json(&change))?;
                let Change {
                    subscription,
                    periods,
                    ..
                } = change;
                let mut ledger = ledger;
                ledger.subscription = Some(subscription);
                for period_change in periods {
                    match period_change {
                        PeriodChange::Written(period) => ledger.periods.push(period),
                        PeriodChange::Restated(period) => {
                            let held = ledger
                                .periods
                                .iter_mut()
                                .find(|held| held.id == period.id)
                                .expect("a restated period is held");
                            *held = period;
                        }
                    }
                }
                ledgers.insert(lineage, ledger);
            }
            Err(refusal) => compare(
                &place,
                field(step, "expect"),
                &json!({ "refusal": refusal.name() }),
            )?,
        }

        for expected in list(step, "entitlements") {
            let account_id = AccountId::new(text(expected, "accountId"));
            let at = instant(field(expected, "at"));
            let subscriptions = ledgers
                .values()
                .filter_map(|ledger| ledger.subscription.clone())
                .collect();
            let entitlement = AccountEntitlement::of(account_id, subscriptions, at);
            compare(
                &format!("{place}, entitlement at {}", iso(at)),
                expected,
                &entitlement_json(&entitlement, at),
            )?;
        }
    }
    Ok(())
}

fn compare(place: &str, expected: &Value, produced: &Value) -> Result<(), String> {
    if expected == produced {
        return Ok(());
    }
    let mut differences = Vec::new();
    differ("", expected, produced, &mut differences);
    Err(format!(
        "{place}:\n  {}\nproduced in full:\n{}",
        differences.join("\n  "),
        serde_json::to_string_pretty(produced).expect("JSON renders")
    ))
}

fn differ(path: &str, expected: &Value, produced: &Value, differences: &mut Vec<String>) {
    match (expected, produced) {
        (Value::Object(expected), Value::Object(produced)) => {
            let mut keys: Vec<&String> = expected.keys().chain(produced.keys()).collect();
            keys.sort();
            keys.dedup();
            for key in keys {
                let (expected, produced) = (
                    expected.get(key).unwrap_or(&Value::Null),
                    produced.get(key).unwrap_or(&Value::Null),
                );
                differ(&format!("{path}.{key}"), expected, produced, differences);
            }
        }
        (Value::Array(expected), Value::Array(produced)) if expected.len() == produced.len() => {
            for (index, (expected, produced)) in expected.iter().zip(produced).enumerate() {
                differ(&format!("{path}[{index}]"), expected, produced, differences);
            }
        }
        _ if expected != produced => {
            differences.push(format!("{path}: expected {expected}, produced {produced}"))
        }
        _ => {}
    }
}

fn observation(value: &Value) -> Observation {
    exactly(
        value,
        &["lineage", "observedAt", "ownership", "status", "periods"],
    );
    let lineage = field(value, "lineage");
    exactly(lineage, &["store", "environment", "storeSubscriptionId"]);
    Observation {
        lineage: Lineage {
            store: named(Store::from_name, text(lineage, "store")),
            environment: named(Environment::from_name, text(lineage, "environment")),
            store_subscription_id: StoreSubscriptionId::new(text(lineage, "storeSubscriptionId")),
        },
        observed_at: instant(field(value, "observedAt")),
        ownership: named(Ownership::from_name, text(value, "ownership")),
        status: status(field(value, "status")),
        periods: list(value, "periods")
            .iter()
            .map(|period| {
                exactly(
                    period,
                    &[
                        "transaction",
                        "start",
                        "end",
                        "price",
                        "offerKind",
                        "refundedAt",
                    ],
                );
                ObservedPeriod {
                    transaction: StoreTransactionId::new(text(period, "transaction")),
                    span: Span {
                        start: instant(field(period, "start")),
                        end: instant(field(period, "end")),
                    },
                    price: money(field(period, "price")),
                    offer_kind: optional_text(period, "offerKind")
                        .map(|kind| named(OfferKind::from_name, kind)),
                    refunded_at: optional_instant(field(period, "refundedAt")),
                }
            })
            .collect(),
    }
}

fn status(value: &Value) -> Status {
    exactly(
        value,
        &[
            "plan",
            "productId",
            "billingInterval",
            "startedAt",
            "state",
            "currentPeriod",
            "autoRenew",
            "nextChargeAt",
            "nextCharge",
            "nextProductId",
            "cancelRequestedAt",
            "paymentFailedAt",
            "graceEndsAt",
            "pauseScheduledFor",
            "pausedAt",
            "resumesAt",
            "endedAt",
            "endReason",
            "offerKind",
            "offerEndsAt",
            "price",
            "storefront",
        ],
    );
    let ending = || Ending {
        at: instant(field(value, "endedAt")),
        reason: named(EndReason::from_name, text(value, "endReason")),
    };
    let state = match text(value, "state") {
        "active" => State::Active {
            pause_scheduled_for: optional_instant(field(value, "pauseScheduledFor")),
        },
        "grace" => State::Grace {
            payment_failed_at: instant(field(value, "paymentFailedAt")),
            grace_ends_at: instant(field(value, "graceEndsAt")),
        },
        "on_hold" => State::OnHold {
            payment_failed_at: instant(field(value, "paymentFailedAt")),
        },
        "paused" => State::Paused {
            paused_at: instant(field(value, "pausedAt")),
            resumes_at: optional_instant(field(value, "resumesAt")),
        },
        "expired" => State::Expired(ending()),
        "revoked" => State::Revoked(ending()),
        other => panic!("{other} is not a state"),
    };
    for (key, rendered) in state_fields(&state) {
        assert_eq!(
            field(value, key),
            &rendered,
            "{key} does not fit the state {} in {value}",
            state.name()
        );
    }
    let next_charge = match (
        optional_instant(field(value, "nextChargeAt")),
        field(value, "nextCharge"),
    ) {
        (None, Value::Null) => None,
        (Some(at), price) if !price.is_null() => Some(NextCharge {
            at,
            price: money(price),
        }),
        _ => panic!("nextChargeAt and nextCharge are stated together in {value}"),
    };
    let offer = optional_text(value, "offerKind").map(|kind| Offer {
        kind: named(OfferKind::from_name, kind),
        ends_at: optional_instant(field(value, "offerEndsAt")),
    });
    assert!(
        offer.is_some() || field(value, "offerEndsAt").is_null(),
        "offerEndsAt without an offerKind in {value}"
    );
    Status {
        plan: named(Plan::from_name, text(value, "plan")),
        product_id: ProductId::new(text(value, "productId")),
        billing_interval: BillingInterval::new(text(value, "billingInterval")),
        started_at: instant(field(value, "startedAt")),
        state,
        current_period: span(field(value, "currentPeriod")),
        renewal: Renewal {
            auto_renew: field(value, "autoRenew")
                .as_bool()
                .unwrap_or_else(|| panic!("autoRenew is not a bool in {value}")),
            next_charge,
            next_product_id: optional_text(value, "nextProductId").map(ProductId::new),
            cancel_requested_at: optional_instant(field(value, "cancelRequestedAt")),
        },
        offer,
        price: money(field(value, "price")),
        storefront: Storefront::new(text(value, "storefront")),
    }
}

fn hint(value: &Value) -> AccountHint {
    match value {
        Value::String(hint) if hint == "absent" => AccountHint::Absent,
        Value::String(hint) if hint == "erased" => AccountHint::Erased,
        Value::Object(_) => {
            exactly(value, &["live"]);
            AccountHint::Live(AccountId::new(text(value, "live")))
        }
        other => panic!("{other} is not a hint: \"absent\", \"erased\" or {{\"live\": accountId}}"),
    }
}

fn claim(value: &Value) -> Option<Claim> {
    if value.is_null() {
        return None;
    }
    exactly(value, &["accountId", "at"]);
    Some(Claim {
        account_id: AccountId::new(text(value, "accountId")),
        at: instant(field(value, "at")),
    })
}

fn change_json(change: &Change) -> Value {
    json!({
        "subscription": subscription_json(&change.subscription),
        "periods": change.periods.iter().map(|period_change| match period_change {
            PeriodChange::Written(period) => json!({ "written": period_json(period) }),
            PeriodChange::Restated(period) => json!({ "restated": period_json(period) }),
        }).collect::<Vec<_>>(),
        "events": change.events.iter().map(event_json).collect::<Vec<_>>(),
        "hintForStore": change.hint_for_store.as_ref().map(AccountId::as_str),
    })
}

fn subscription_json(subscription: &Subscription) -> Value {
    let status = &subscription.status;
    let binding = subscription.binding.as_ref();
    let mut rendered = json!({
        "id": subscription.id.as_str(),
        "store": subscription.lineage.store.name(),
        "environment": subscription.lineage.environment.name(),
        "storeSubscriptionId": subscription.lineage.store_subscription_id.as_str(),
        "plan": status.plan.name(),
        "productId": status.product_id.as_str(),
        "billingInterval": status.billing_interval.as_str(),
        "accountId": binding.map(|binding| binding.account_id.as_str()),
        "boundAt": binding.map(|binding| iso(binding.bound_at)),
        "boundBy": binding.map(|binding| binding.bound_by.name()),
        "state": status.state.name(),
        "startedAt": iso(status.started_at),
        "currentPeriod": span_json(status.current_period),
        "accessUntil": optional_iso(subscription.access_until()),
        "autoRenew": status.renewal.auto_renew,
        "nextChargeAt": optional_iso(status.renewal.next_charge.as_ref().map(|charge| charge.at)),
        "nextCharge": status.renewal.next_charge.as_ref().map(|charge| money_json(&charge.price)),
        "nextProductId": status.renewal.next_product_id.as_ref().map(ProductId::as_str),
        "cancelRequestedAt": optional_iso(status.renewal.cancel_requested_at),
        "offerKind": status.offer.as_ref().map(|offer| offer.kind.name()),
        "offerEndsAt": optional_iso(status.offer.as_ref().and_then(|offer| offer.ends_at)),
        "price": money_json(&status.price),
        "storefront": status.storefront.as_str(),
        "observedAt": iso(subscription.observed_at),
    });
    for (key, value) in state_fields(&status.state) {
        rendered[key] = value;
    }
    rendered
}

fn state_fields(state: &State) -> [(&'static str, Value); 7] {
    [
        (
            "pauseScheduledFor",
            optional_iso(state.pause_scheduled_for()).into(),
        ),
        (
            "paymentFailedAt",
            optional_iso(state.payment_failed_at()).into(),
        ),
        ("graceEndsAt", optional_iso(state.grace_ends_at()).into()),
        ("pausedAt", optional_iso(state.paused_at()).into()),
        ("resumesAt", optional_iso(state.resumes_at()).into()),
        (
            "endedAt",
            optional_iso(state.ending().map(|ending| ending.at)).into(),
        ),
        (
            "endReason",
            state.ending().map(|ending| ending.reason.name()).into(),
        ),
    ]
}

fn period_json(period: &Period) -> Value {
    json!({
        "id": period.id.as_str(),
        "transaction": period.transaction.as_str(),
        "start": iso(period.span.start),
        "end": iso(period.span.end),
        "price": money_json(&period.price),
        "offerKind": period.offer_kind.map(OfferKind::name),
        "refundedAt": optional_iso(period.refunded_at),
        "observedAt": iso(period.observed_at),
    })
}

fn event_json(event: &Event) -> Value {
    json!({
        "type": event.kind.name(),
        "occurredAt": iso(event.occurred_at),
        "subscriptionId": event.subscription_id.as_str(),
        "accountId": event.account_id.as_ref().map(AccountId::as_str),
        "period": event.kind.period().map(period_json),
    })
}

fn entitlement_json(entitlement: &AccountEntitlement, at: Instant) -> Value {
    let block = |entitlement: &Entitlement| {
        json!({
            "plan": entitlement.plan().map(Plan::name),
            "accessUntil": optional_iso(entitlement.access_until),
            "governing": entitlement.governing.as_ref().map(|governing| governing.id.as_str()),
            "others": entitlement.others.iter().map(|other| other.id.as_str()).collect::<Vec<_>>(),
        })
    };
    json!({
        "accountId": entitlement.account_id.as_str(),
        "at": iso(at),
        "production": block(&entitlement.production),
        "sandbox": block(&entitlement.sandbox),
    })
}

fn span(value: &Value) -> Span {
    exactly(value, &["start", "end"]);
    Span {
        start: instant(field(value, "start")),
        end: instant(field(value, "end")),
    }
}

fn span_json(span: Span) -> Value {
    json!({ "start": iso(span.start), "end": iso(span.end) })
}

fn money(value: &Value) -> Money {
    exactly(value, &["amount", "currency"]);
    Money::new(text(value, "amount"), text(value, "currency"))
        .unwrap_or_else(|| panic!("{value} is not money"))
}

fn money_json(money: &Money) -> Value {
    json!({ "amount": money.amount(), "currency": money.currency() })
}

fn exactly(value: &Value, keys: &[&str]) {
    let object = value
        .as_object()
        .unwrap_or_else(|| panic!("{value} is not an object"));
    let mut present: Vec<&str> = object.keys().map(String::as_str).collect();
    let mut wanted = keys.to_vec();
    present.sort_unstable();
    wanted.sort_unstable();
    assert_eq!(present, wanted, "the keys of {value}");
}

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value
        .get(key)
        .unwrap_or_else(|| panic!("{key} is missing from {value}"))
}

fn list<'a>(value: &'a Value, key: &str) -> &'a Vec<Value> {
    field(value, key)
        .as_array()
        .unwrap_or_else(|| panic!("{key} is not a list in {value}"))
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    field(value, key)
        .as_str()
        .unwrap_or_else(|| panic!("{key} is not text in {value}"))
}

fn optional_text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    let field = field(value, key);
    (!field.is_null()).then(|| {
        field
            .as_str()
            .unwrap_or_else(|| panic!("{key} is not text in {value}"))
    })
}

fn named<T>(from_name: fn(&str) -> Option<T>, name: &str) -> T {
    from_name(name).unwrap_or_else(|| panic!("{name} is not one of the closed names"))
}

// Vectors write instants as UTC ISO 8601 (`2027-01-01T10:00:00Z`); the domain counts epoch milliseconds.
fn instant(value: &Value) -> Instant {
    fn malformed(written: &str) -> ! {
        panic!("{written} is not YYYY-MM-DDTHH:MM:SS[.mmm]Z")
    }
    let written = value
        .as_str()
        .unwrap_or_else(|| panic!("{value} is not an instant"));
    let (date, time) = written
        .strip_suffix('Z')
        .and_then(|rest| rest.split_once('T'))
        .unwrap_or_else(|| malformed(written));
    let number = |digits: &str| digits.parse::<i64>().unwrap_or_else(|_| malformed(written));
    let date: Vec<i64> = date.split('-').map(number).collect();
    let (clock, millis) = time
        .split_once('.')
        .map_or((time, 0), |(clock, millis)| (clock, number(millis)));
    let clock: Vec<i64> = clock.split(':').map(number).collect();
    let (&[year, month, day], &[hours, minutes, seconds]) = (date.as_slice(), clock.as_slice())
    else {
        malformed(written)
    };
    let millis = days_from_civil(year, month, day) * 86_400_000
        + ((hours * 60 + minutes) * 60 + seconds) * 1000
        + millis;
    let instant = Instant::from_epoch_millis(millis);
    assert_eq!(
        iso(instant),
        written,
        "{written} is not a canonical instant"
    );
    instant
}

fn optional_instant(value: &Value) -> Option<Instant> {
    (!value.is_null()).then(|| instant(value))
}

fn iso(instant: Instant) -> String {
    let millis = instant.epoch_millis();
    let (year, month, day) = civil_from_days(millis.div_euclid(86_400_000));
    let of_day = millis.rem_euclid(86_400_000);
    let seconds = of_day / 1000;
    let clock = format!(
        "{:02}:{:02}:{:02}",
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60
    );
    match of_day % 1000 {
        0 => format!("{year:04}-{month:02}-{day:02}T{clock}Z"),
        fraction => format!("{year:04}-{month:02}-{day:02}T{clock}.{fraction:03}Z"),
    }
}

fn optional_iso(instant: Option<Instant>) -> Option<String> {
    instant.map(iso)
}

// Howard Hinnant's civil calendar algorithms, proleptic Gregorian.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    (year_of_era + era * 400 + i64::from(month <= 2), month, day)
}
