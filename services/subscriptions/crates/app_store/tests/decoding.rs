use std::fs;
use std::path::{Path, PathBuf};

use app_store::decoding::{Decoded, PeriodStatement, decode, decode_claim};
use app_store::verification::{
    AccountToken, Environment, Notification, RenewalInfo, TransactionInfo,
};
use domain::{
    AccountHint, Accounts, Instant, Ledger, Money, Observation, ObservedPeriod, PeriodId, Span,
    Status, SubscriptionId, observe,
};
use serde_json::{Value, json};

#[test]
fn every_app_store_vector_passes() {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/vectors/app_store");
    let mut vectors: Vec<PathBuf> = fs::read_dir(&directory)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", directory.display()))
        .map(|entry| entry.expect("a readable directory entry").path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    vectors.sort();
    assert!(
        vectors.len() >= 112,
        "{} holds {} vectors, fewer than the ones written",
        directory.display(),
        vectors.len()
    );

    let failures: Vec<String> = vectors
        .iter()
        .filter_map(|vector| run(vector).err())
        .collect();
    assert!(
        failures.is_empty(),
        "{} of {} vectors failed\n\n{}",
        failures.len(),
        vectors.len(),
        failures.join("\n\n")
    );
}

// The adapter and the domain together: a cancel time Apple states once survives the expiry, which cannot state it.
#[test]
fn a_cancel_time_stated_once_survives_the_notifications_that_cannot_state_it() {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/vectors/app_store");
    let mut ledger = Ledger::default();
    for name in [
        "did_renew.json",
        "did_change_renewal_status_auto_renew_disabled.json",
        "consumption_request.json",
        "expired_voluntary.json",
    ] {
        let vector = read(&directory.join(name));
        let Decoded::Observation { observation, .. } =
            decode(&notification(field(&vector, "notification")))
        else {
            panic!("{name} decodes into an observation");
        };
        let observation = observation.mint_ids(SubscriptionId::new("subscription"), |period| {
            PeriodId::new(format!("period-{}", period.transaction.as_str()))
        });
        let accounts = Accounts {
            hint: AccountHint::Absent,
            claim: None,
        };
        let change = observe(ledger.clone(), observation, accounts).expect("no claim is refused");
        ledger.subscription = Some(change.subscription);
    }

    let subscription = ledger
        .subscription
        .expect("the ledger holds the subscription");
    assert!(subscription.status.state.is_expired());
    assert!(!subscription.status.renewal.auto_renew);
    assert_eq!(
        subscription.status.renewal.cancel_requested_at.map(iso),
        Some("2027-02-10T08:00:00Z".to_owned())
    );
}

fn run(path: &Path) -> Result<(), String> {
    let name = path.file_name().expect("a file name").to_string_lossy();
    let vector = read(path);
    let produced = match (vector.get("notification"), vector.get("claim")) {
        (Some(notification_fields), None) => {
            exactly(&vector, &["note", "notification", "expect"]);
            decoded_json(decode(&notification(notification_fields)))
        }
        (None, Some(transaction_fields)) => {
            exactly(&vector, &["note", "claim", "expect"]);
            match decode_claim(&transaction(transaction_fields)) {
                Ok(statement) => json!({ "periodStatement": statement_json(&statement) }),
                Err(unsupported) => json!({ "unsupported": unsupported.code() }),
            }
        }
        _ => panic!("{name} holds a notification or a claim, not both"),
    };
    compare(&name, field(&vector, "expect"), &produced)
}

fn read(path: &Path) -> Value {
    let text = fs::read_to_string(path).expect("a readable vector");
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} is not JSON: {error}", path.display()))
}

// The verified notification as SignedDataVerifier hands it over, its transaction and renewal info in Apple's own names.
fn notification(value: &Value) -> Notification {
    exactly(
        value,
        &[
            "notificationType",
            "subtype",
            "signedDate",
            "environment",
            "status",
            "transaction",
            "renewalInfo",
        ],
    );
    Notification {
        notification_uuid: "3b8f2c41-6d0e-4a57-9c13-8e2f7a6b5d90".to_owned(),
        notification_type: text(value, "notificationType").to_owned(),
        subtype: optional(value, "subtype"),
        signed_date: optional(value, "signedDate"),
        environment: serde_json::from_value::<Environment>(field(value, "environment").clone())
            .expect("Production or Sandbox"),
        status: optional(value, "status"),
        transaction: (!field(value, "transaction").is_null())
            .then(|| transaction(field(value, "transaction"))),
        renewal_info: optional::<RenewalInfo>(value, "renewalInfo"),
    }
}

fn transaction(value: &Value) -> TransactionInfo {
    serde_json::from_value(value.clone())
        .unwrap_or_else(|error| panic!("{value} is not a JWSTransactionDecodedPayload: {error}"))
}

fn optional<T: serde::de::DeserializeOwned>(value: &Value, key: &str) -> Option<T> {
    serde_json::from_value(field(value, key).clone())
        .unwrap_or_else(|error| panic!("{key} in {value} does not decode: {error}"))
}

fn decoded_json(decoded: Decoded) -> Value {
    match decoded {
        Decoded::Observation {
            observation,
            account_token,
        } => json!({
            "observation": observation_json(&observation),
            "accountToken": account_token.as_ref().map(AccountToken::expose),
        }),
        Decoded::AwaitsStatus {
            statement,
            awaiting,
        } => json!({
            "awaitsStatus": statement_json(&statement),
            "awaiting": awaiting.code(),
        }),
        Decoded::Silent(silence) => json!({ "silent": silence.code() }),
        Decoded::Unsupported(unsupported) => json!({ "unsupported": unsupported.code() }),
    }
}

fn observation_json(observation: &Observation) -> Value {
    json!({
        "lineage": {
            "store": observation.lineage.store.name(),
            "environment": observation.lineage.environment.name(),
            "storeSubscriptionId": observation.lineage.store_subscription_id.as_str(),
        },
        "observedAt": iso(observation.observed_at),
        "ownership": observation.ownership.name(),
        "status": status_json(&observation.status),
        "periods": observation.periods.iter().map(period_json).collect::<Vec<_>>(),
    })
}

fn statement_json(statement: &PeriodStatement) -> Value {
    json!({
        "lineage": {
            "store": statement.lineage.store.name(),
            "environment": statement.lineage.environment.name(),
            "storeSubscriptionId": statement.lineage.store_subscription_id.as_str(),
        },
        "observedAt": iso(statement.observed_at),
        "ownership": statement.ownership.name(),
        "period": period_json(&statement.period),
        "accountToken": statement.account_token.as_ref().map(AccountToken::expose),
        "cancelRequestedAt": statement.cancel_requested_at.map(iso),
    })
}

fn status_json(status: &Status) -> Value {
    let state = &status.state;
    json!({
        "plan": status.plan.name(),
        "productId": status.product_id.as_str(),
        "billingInterval": status.billing_interval.as_str(),
        "startedAt": iso(status.started_at),
        "state": state.name(),
        "currentPeriod": span_json(status.current_period),
        "autoRenew": status.renewal.auto_renew,
        "nextChargeAt": status.renewal.next_charge.as_ref().map(|charge| iso(charge.at)),
        "nextCharge": status.renewal.next_charge.as_ref().map(|charge| money_json(&charge.price)),
        "nextProductId": status.renewal.next_product_id.as_ref().map(|product| product.as_str()),
        "cancelRequestedAt": status.renewal.cancel_requested_at.map(iso),
        "paymentFailedAt": state.payment_failed_at().map(iso),
        "graceEndsAt": state.grace_ends_at().map(iso),
        "pauseScheduledFor": state.pause_scheduled_for().map(iso),
        "pausedAt": state.paused_at().map(iso),
        "resumesAt": state.resumes_at().map(iso),
        "endedAt": state.ending().map(|ending| iso(ending.at)),
        "endReason": state.ending().map(|ending| ending.reason.name()),
        "offerKind": status.offer.as_ref().map(|offer| offer.kind.name()),
        "offerEndsAt": status.offer.as_ref().and_then(|offer| offer.ends_at).map(iso),
        "price": money_json(&status.price),
        "storefront": status.storefront.as_ref().map(|storefront| storefront.as_str()),
    })
}

fn period_json(period: &ObservedPeriod) -> Value {
    json!({
        "transaction": period.transaction.as_str(),
        "start": iso(period.span.start),
        "end": iso(period.span.end),
        "price": money_json(&period.price),
        "offerKind": period.offer_kind.map(|kind| kind.name()),
        "refundedAt": period.refunded_at.map(iso),
    })
}

fn span_json(span: Span) -> Value {
    json!({ "start": iso(span.start), "end": iso(span.end) })
}

fn money_json(money: &Money) -> Value {
    json!({ "amount": money.amount(), "currency": money.currency() })
}

fn compare(name: &str, expected: &Value, produced: &Value) -> Result<(), String> {
    if expected == produced {
        return Ok(());
    }
    let mut differences = Vec::new();
    differ("", expected, produced, &mut differences);
    Err(format!(
        "{name}:\n  {}\nproduced in full:\n{}",
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

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    field(value, key)
        .as_str()
        .unwrap_or_else(|| panic!("{key} is not text in {value}"))
}

// Expectations write instants as UTC ISO 8601 (`2027-01-01T10:00:00Z`); Apple and the domain count epoch milliseconds.
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

// Howard Hinnant's civil calendar algorithm, proleptic Gregorian.
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
