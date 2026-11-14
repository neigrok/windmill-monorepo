use std::fs;
use std::time::{Duration, UNIX_EPOCH};

use app_store::verification::{Environment, SignedDataVerifier};
use app_store_test_signer::{Description, TEST_ROOT, sign};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use uuid::Uuid;

fn decode(jws: &str) -> (Value, Value) {
    let segment = |index: usize| -> Value {
        let encoded = jws.split('.').nth(index).unwrap();
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap()
    };
    (segment(0), segment(1))
}

#[test]
fn every_test_payload_verifies_under_the_test_root_and_apples_root_refuses_it_and_each_payload_inside_it()
 {
    let now = UNIX_EPOCH + Duration::from_millis(1_794_614_400_000);
    let under_test_root =
        SignedDataVerifier::new(&[TEST_ROOT], "works.windmill.app", move || now).unwrap();
    let under_apples_root = SignedDataVerifier::windmill(move || now);
    let mut files: Vec<_> = fs::read_dir(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/app_store/test-payloads"
    ))
    .unwrap()
    .map(|entry| entry.unwrap().path())
    .filter(|path| {
        path.extension()
            .is_some_and(|extension| extension == "json")
    })
    .collect();
    files.sort();

    let outcomes: Vec<String> = files
        .iter()
        .map(|path| {
            let name = path.file_name().unwrap().to_str().unwrap();
            let description: Description =
                serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
            let is_transaction = matches!(description, Description::Transaction(_));
            let signed = sign(description, now).unwrap();
            if is_transaction {
                let verified = under_test_root
                    .verify_transaction(&signed)
                    .unwrap_or_else(|refusal| panic!("{name} refused: {refusal}"));
                let refused = under_apples_root.verify_transaction(&signed).err().unwrap();
                return format!(
                    "{name},transaction {} {:?},{refused}",
                    verified.transaction_id.expose(),
                    verified.environment,
                );
            }

            let verified = under_test_root
                .verify_notification(&signed)
                .unwrap_or_else(|refusal| panic!("{name} refused: {refusal}"));
            let transaction = verified.transaction.as_ref().unwrap();
            let renewal_info = verified.renewal_info.as_ref().unwrap();
            let (_, payload) = decode(&signed);
            // A renewal info only arrives nested; verify_transaction runs the same chain check on it before reading any field.
            let refused = [
                under_apples_root.verify_notification(&signed).err(),
                under_apples_root
                    .verify_transaction(payload["data"]["signedTransactionInfo"].as_str().unwrap())
                    .err(),
                under_apples_root
                    .verify_transaction(payload["data"]["signedRenewalInfo"].as_str().unwrap())
                    .err(),
            ]
            .map(|refusal| refusal.map_or("verified".to_owned(), |refusal| refusal.to_string()));
            format!(
                "{name},{} {} status {} {:?} with transaction {} {:?} and renewal info {:?},{}",
                verified.notification_type,
                verified.subtype.as_deref().unwrap_or("-"),
                verified.status.unwrap(),
                verified.environment,
                transaction.transaction_id.expose(),
                transaction.environment,
                renewal_info.environment,
                refused.join(" "),
            )
        })
        .collect();

    assert_eq!(
        outcomes.join("\n"),
        "\
expired.json,EXPIRED VOLUNTARY status 2 Sandbox with transaction 2000000000000002 Sandbox and renewal info Sandbox,untrusted_chain untrusted_chain untrusted_chain
payment-failed-into-grace.json,DID_FAIL_TO_RENEW GRACE_PERIOD status 4 Sandbox with transaction 2000000000000002 Sandbox and renewal info Sandbox,untrusted_chain untrusted_chain untrusted_chain
purchase-transaction.json,transaction 2000000000000001 Sandbox,untrusted_chain
refund-reversed.json,REFUND_REVERSED - status 1 Sandbox with transaction 2000000000000002 Sandbox and renewal info Sandbox,untrusted_chain untrusted_chain untrusted_chain
refunded.json,REFUND - status 5 Sandbox with transaction 2000000000000002 Sandbox and renewal info Sandbox,untrusted_chain untrusted_chain untrusted_chain
renewal-turned-off.json,DID_CHANGE_RENEWAL_STATUS AUTO_RENEW_DISABLED status 1 Sandbox with transaction 2000000000000002 Sandbox and renewal info Sandbox,untrusted_chain untrusted_chain untrusted_chain
renewed.json,DID_RENEW - status 1 Sandbox with transaction 2000000000000002 Sandbox and renewal info Sandbox,untrusted_chain untrusted_chain untrusted_chain
started.json,SUBSCRIBED INITIAL_BUY status 1 Sandbox with transaction 2000000000000001 Sandbox and renewal info Sandbox,untrusted_chain untrusted_chain untrusted_chain"
    );
}

#[test]
fn a_subscription_start_is_signed_as_apple_sends_it_with_its_dates_counted_from_the_signing() {
    let now = 1_794_614_400_000_i64;
    let day = 86_400_000_i64;
    let description = serde_json::from_str(include_str!(
        "../../../tests/fixtures/app_store/test-payloads/started.json"
    ))
    .unwrap();

    let signed = sign(description, UNIX_EPOCH + Duration::from_millis(now as u64)).unwrap();

    let (header, mut notification) = decode(&signed);
    let (transaction_header, transaction) = decode(
        notification["data"]["signedTransactionInfo"]
            .as_str()
            .unwrap(),
    );
    let (renewal_info_header, renewal_info) =
        decode(notification["data"]["signedRenewalInfo"].as_str().unwrap());
    let notification_uuid = notification["notificationUUID"]
        .as_str()
        .unwrap()
        .to_owned();
    notification["data"]["signedTransactionInfo"] = "<signed transaction>".into();
    notification["data"]["signedRenewalInfo"] = "<signed renewal info>".into();
    let test_chain_header = json!({
        "alg": "ES256",
        "x5c": [
            STANDARD.encode(include_bytes!("../../../tests/fixtures/app_store/test-chain/leaf.cer")),
            STANDARD.encode(include_bytes!("../../../tests/fixtures/app_store/test-chain/intermediate.cer")),
            STANDARD.encode(include_bytes!("../../../tests/fixtures/app_store/test-chain/root.cer")),
        ]
    });
    assert_eq!(
        [header, transaction_header, renewal_info_header],
        [
            test_chain_header.clone(),
            test_chain_header.clone(),
            test_chain_header
        ]
    );
    assert_eq!(
        Uuid::parse_str(&notification_uuid).map(|uuid| uuid.get_version_num()),
        Ok(4)
    );
    assert_eq!(
        notification,
        json!({
            "notificationType": "SUBSCRIBED",
            "subtype": "INITIAL_BUY",
            "notificationUUID": notification_uuid,
            "version": "2.0",
            "signedDate": now,
            "data": {
                "bundleId": "works.windmill.app",
                "environment": "Sandbox",
                "status": 1,
                "signedTransactionInfo": "<signed transaction>",
                "signedRenewalInfo": "<signed renewal info>"
            }
        })
    );
    assert_eq!(
        transaction,
        json!({
            "transactionId": "2000000000000001",
            "originalTransactionId": "2000000000000001",
            "webOrderLineItemId": "2000000000000101",
            "bundleId": "works.windmill.app",
            "productId": "works.windmill.app.one.monthly",
            "subscriptionGroupIdentifier": "21000001",
            "type": "Auto-Renewable Subscription",
            "purchaseDate": now,
            "originalPurchaseDate": now,
            "expiresDate": now + 30 * day,
            "quantity": 1,
            "storefront": "USA",
            "storefrontId": "143441",
            "price": 11990,
            "currency": "USD",
            "appAccountToken": "6f9d0c2e-4b1a-4c8e-9f3d-2a7b5e1c0d84",
            "inAppOwnershipType": "PURCHASED",
            "transactionReason": "PURCHASE",
            "signedDate": now,
            "environment": "Sandbox"
        })
    );
    assert_eq!(
        renewal_info,
        json!({
            "originalTransactionId": "2000000000000001",
            "productId": "works.windmill.app.one.monthly",
            "autoRenewProductId": "works.windmill.app.one.monthly",
            "autoRenewStatus": 1,
            "isInBillingRetryPeriod": false,
            "renewalDate": now + 30 * day,
            "renewalPrice": 11990,
            "currency": "USD",
            "recentSubscriptionStartDate": now,
            "appAccountToken": "6f9d0c2e-4b1a-4c8e-9f3d-2a7b5e1c0d84",
            "signedDate": now,
            "environment": "Sandbox"
        })
    );
}

#[test]
fn a_standalone_transaction_states_the_sandbox_windmills_bundle_and_its_signing_time() {
    let now = 1_794_614_400_000_i64;
    let description = serde_json::from_value(json!({
        "transaction": {
            "transactionId": "2000000000000001",
            "originalTransactionId": "2000000000000001",
            "productId": "works.windmill.app.one.monthly",
            "purchaseDate": "now-1h",
            "expiresDate": "now+15m"
        }
    }))
    .unwrap();

    let signed = sign(description, UNIX_EPOCH + Duration::from_millis(now as u64)).unwrap();

    assert_eq!(
        decode(&signed).1,
        json!({
            "transactionId": "2000000000000001",
            "originalTransactionId": "2000000000000001",
            "productId": "works.windmill.app.one.monthly",
            "purchaseDate": now - 3_600_000,
            "expiresDate": now + 900_000,
            "bundleId": "works.windmill.app",
            "environment": "Sandbox",
            "signedDate": now
        })
    );
}

#[test]
fn what_a_description_states_is_signed_as_stated_and_a_nested_payload_takes_its_notifications_environment_and_bundle()
 {
    let now = UNIX_EPOCH + Duration::from_millis(1_794_614_400_000);
    let description = serde_json::from_value(json!({
        "notification": {
            "notificationType": "DID_RENEW",
            "notificationUUID": "0b4d6a52-8c1e-4f7a-a3b9-5d2e8f1c6a07",
            "signedDate": 1_794_610_800_000_i64,
            "data": {
                "bundleId": "com.example.other",
                "environment": "Production",
                "signedTransactionInfo": {
                    "transactionId": "2000000000000002",
                    "originalTransactionId": "2000000000000001",
                    "productId": "works.windmill.app.one.monthly",
                    "purchaseDate": 1_794_610_800_000_i64,
                    "signedDate": 1_794_610_800_000_i64
                },
                "signedRenewalInfo": {
                    "originalTransactionId": "2000000000000001",
                    "autoRenewStatus": 1
                }
            }
        }
    }))
    .unwrap();

    let signed = sign(description, now).unwrap();

    let (_, notification) = decode(&signed);
    let (_, transaction) = decode(
        notification["data"]["signedTransactionInfo"]
            .as_str()
            .unwrap(),
    );
    let (_, renewal_info) = decode(notification["data"]["signedRenewalInfo"].as_str().unwrap());
    assert_eq!(
        [
            &notification["notificationUUID"],
            &notification["signedDate"],
            &notification["data"]["bundleId"],
            &notification["data"]["environment"],
        ],
        [
            &json!("0b4d6a52-8c1e-4f7a-a3b9-5d2e8f1c6a07"),
            &json!(1_794_610_800_000_i64),
            &json!("com.example.other"),
            &json!("Production"),
        ]
    );
    assert_eq!(
        transaction,
        json!({
            "transactionId": "2000000000000002",
            "originalTransactionId": "2000000000000001",
            "productId": "works.windmill.app.one.monthly",
            "purchaseDate": 1_794_610_800_000_i64,
            "signedDate": 1_794_610_800_000_i64,
            "bundleId": "com.example.other",
            "environment": "Production"
        })
    );
    assert_eq!(
        renewal_info,
        json!({
            "originalTransactionId": "2000000000000001",
            "autoRenewStatus": 1,
            "signedDate": 1_794_614_400_000_i64,
            "environment": "Production"
        })
    );
    let verified = SignedDataVerifier::new(&[TEST_ROOT], "com.example.other", move || now)
        .unwrap()
        .verify_notification(&signed)
        .map(|notification| notification.environment);
    assert_eq!(verified, Ok(Environment::Production));
}

#[test]
fn a_date_written_neither_in_milliseconds_nor_from_now_is_refused_naming_its_field() {
    let description = serde_json::from_value(json!({
        "notification": {
            "notificationType": "DID_RENEW",
            "data": {
                "signedTransactionInfo": {
                    "transactionId": "2000000000000002",
                    "expiresDate": "now+30"
                }
            }
        }
    }))
    .unwrap();

    let refused = sign(description, UNIX_EPOCH).unwrap_err();

    assert_eq!(
        refused.to_string(),
        "expiresDate is \"now+30\": a date is milliseconds since the epoch, or now with an optional offset in days, hours or minutes, such as now+30d, now-2h or now+15m"
    );
}
