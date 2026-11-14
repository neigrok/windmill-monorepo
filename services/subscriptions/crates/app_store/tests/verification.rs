use std::time::{Duration, SystemTime, UNIX_EPOCH};

use app_store::verification::{
    AccountToken, Environment, Notification, Refusal, RenewalInfo, SignedDataVerifier,
    TransactionId, TransactionInfo,
};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use rcgen::{
    BasicConstraints, CertificateParams, CustomExtension, DistinguishedName, DnType, IsCa, Issuer,
    KeyPair, PKCS_ECDSA_P256_SHA256, PKCS_ECDSA_P384_SHA384, date_time_ymd,
};
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair};
use serde_json::{Value, json};
use time::OffsetDateTime;

struct ChainShape {
    root_not_after: OffsetDateTime,
    intermediate_not_after: OffsetDateTime,
    intermediate_is_ca: bool,
    intermediate_marked: bool,
    leaf_not_after: OffsetDateTime,
    leaf_marked: bool,
    leaf_names_its_issuer: bool,
}

impl Default for ChainShape {
    fn default() -> Self {
        Self {
            root_not_after: date_time_ymd(2040, 1, 1),
            intermediate_not_after: date_time_ymd(2036, 1, 1),
            intermediate_is_ca: true,
            intermediate_marked: true,
            leaf_not_after: date_time_ymd(2028, 1, 1),
            leaf_marked: true,
            leaf_names_its_issuer: true,
        }
    }
}

struct TestChain {
    root: Vec<u8>,
    intermediate: Vec<u8>,
    leaf: Vec<u8>,
    leaf_key: EcdsaKeyPair,
}

impl TestChain {
    fn issue(shape: ChainShape) -> Self {
        let certificate = |name: &str,
                           is_ca: IsCa,
                           valid: (OffsetDateTime, OffsetDateTime),
                           marker: Option<&[u64]>| {
            let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
            params.distinguished_name = DistinguishedName::new();
            params.distinguished_name.push(DnType::CommonName, name);
            params.is_ca = is_ca;
            (params.not_before, params.not_after) = valid;
            params.custom_extensions = marker
                .map(|oid| CustomExtension::from_oid_content(oid, vec![0x05, 0x00]))
                .into_iter()
                .collect();
            params
        };

        let root_key = KeyPair::generate_for(&PKCS_ECDSA_P384_SHA384).unwrap();
        let root_params = certificate(
            "Windmill Test Root",
            IsCa::Ca(BasicConstraints::Unconstrained),
            (date_time_ymd(2020, 1, 1), shape.root_not_after),
            None,
        );
        let root = root_params.self_signed(&root_key).unwrap();

        let intermediate_key = KeyPair::generate_for(&PKCS_ECDSA_P384_SHA384).unwrap();
        let intermediate_params = certificate(
            "Windmill Test Intermediate",
            match shape.intermediate_is_ca {
                true => IsCa::Ca(BasicConstraints::Constrained(0)),
                false => IsCa::ExplicitNoCa,
            },
            (date_time_ymd(2021, 1, 1), shape.intermediate_not_after),
            shape
                .intermediate_marked
                .then_some(&[1, 2, 840, 113635, 100, 6, 2, 1]),
        );
        let intermediate = intermediate_params
            .signed_by(&intermediate_key, &Issuer::new(root_params, root_key))
            .unwrap();

        let leaf_issuer = match shape.leaf_names_its_issuer {
            true => Issuer::new(intermediate_params, intermediate_key),
            false => Issuer::new(
                certificate(
                    "Windmill Test Other Intermediate",
                    IsCa::Ca(BasicConstraints::Constrained(0)),
                    (date_time_ymd(2021, 1, 1), shape.intermediate_not_after),
                    None,
                ),
                intermediate_key,
            ),
        };
        let leaf_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let leaf = certificate(
            "Windmill Test Leaf",
            IsCa::ExplicitNoCa,
            (date_time_ymd(2025, 1, 1), shape.leaf_not_after),
            shape
                .leaf_marked
                .then_some(&[1, 2, 840, 113635, 100, 6, 11, 1]),
        )
        .signed_by(&leaf_key, &leaf_issuer)
        .unwrap();

        Self {
            root: root.der().to_vec(),
            intermediate: intermediate.der().to_vec(),
            leaf: leaf.der().to_vec(),
            leaf_key: EcdsaKeyPair::from_pkcs8(
                &ECDSA_P256_SHA256_FIXED_SIGNING,
                &leaf_key.serialize_der(),
                &SystemRandom::new(),
            )
            .unwrap(),
        }
    }

    fn x5c(&self) -> [&[u8]; 3] {
        [&self.leaf, &self.intermediate, &self.root]
    }

    fn sign(&self, payload: &Value) -> String {
        jws("ES256", &self.x5c(), &self.leaf_key, payload)
    }

    fn verifier(&self) -> SignedDataVerifier {
        SignedDataVerifier::new(&[&self.root], "works.windmill.app", || {
            UNIX_EPOCH + Duration::from_millis(1_793_491_260_000)
        })
        .unwrap()
    }
}

fn jws(alg: &str, x5c: &[&[u8]], key: &EcdsaKeyPair, payload: &Value) -> String {
    let chain: Vec<String> = x5c.iter().map(|der| STANDARD.encode(der)).collect();
    let header = URL_SAFE_NO_PAD.encode(json!({ "alg": alg, "x5c": chain }).to_string());
    let signing_input = format!("{header}.{}", URL_SAFE_NO_PAD.encode(payload.to_string()));
    let signature = key
        .sign(&SystemRandom::new(), signing_input.as_bytes())
        .unwrap();
    format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature.as_ref())
    )
}

#[test]
fn a_notification_signed_under_the_trusted_root_verifies_with_the_transaction_and_renewal_info_inside_it()
 {
    let chain = TestChain::issue(ChainShape::default());
    let transaction = chain.sign(&json!({
        "transactionId": "2000000000000002",
        "originalTransactionId": "2000000000000001",
        "webOrderLineItemId": "2000000000000003",
        "bundleId": "works.windmill.app",
        "productId": "works.windmill.one.monthly",
        "type": "Auto-Renewable Subscription",
        "purchaseDate": 1_793_491_200_000_i64,
        "originalPurchaseDate": 1_790_812_800_000_i64,
        "expiresDate": 1_796_083_200_000_i64,
        "signedDate": 1_793_491_260_000_i64,
        "environment": "Sandbox",
        "storefront": "USA",
        "price": 11_990,
        "currency": "USD",
        "appAccountToken": "6f9d0c2e-4b1a-4c8e-9f3d-2a7b5e1c0d84",
        "inAppOwnershipType": "PURCHASED",
        "transactionReason": "RENEWAL",
        "isUpgraded": false
    }));
    let renewal_info = chain.sign(&json!({
        "originalTransactionId": "2000000000000001",
        "productId": "works.windmill.one.monthly",
        "autoRenewProductId": "works.windmill.one.monthly",
        "autoRenewStatus": 1,
        "isInBillingRetryPeriod": false,
        "renewalDate": 1_796_083_200_000_i64,
        "renewalPrice": 11_990,
        "currency": "USD",
        "signedDate": 1_793_491_260_000_i64,
        "environment": "Sandbox"
    }));
    let notification = chain.sign(&json!({
        "notificationType": "DID_RENEW",
        "notificationUUID": "0b4d6a52-8c1e-4f7a-a3b9-5d2e8f1c6a07",
        "version": "2.0",
        "signedDate": 1_793_491_260_000_i64,
        "data": {
            "appAppleId": 6_400_000_000_i64,
            "bundleId": "works.windmill.app",
            "bundleVersion": "72",
            "environment": "Sandbox",
            "status": 1,
            "signedTransactionInfo": transaction,
            "signedRenewalInfo": renewal_info
        }
    }));

    let verified = chain.verifier().verify_notification(&notification);

    let expected = Notification {
        notification_uuid: "0b4d6a52-8c1e-4f7a-a3b9-5d2e8f1c6a07".to_owned(),
        notification_type: "DID_RENEW".to_owned(),
        subtype: None,
        signed_date: Some(1_793_491_260_000),
        environment: Environment::Sandbox,
        status: Some(1),
        transaction: Some(TransactionInfo {
            transaction_id: TransactionId::new("2000000000000002"),
            original_transaction_id: TransactionId::new("2000000000000001"),
            bundle_id: "works.windmill.app".to_owned(),
            product_id: "works.windmill.one.monthly".to_owned(),
            product_type: Some("Auto-Renewable Subscription".to_owned()),
            purchase_date: 1_793_491_200_000,
            original_purchase_date: Some(1_790_812_800_000),
            expires_date: Some(1_796_083_200_000),
            signed_date: Some(1_793_491_260_000),
            environment: Environment::Sandbox,
            storefront: Some("USA".to_owned()),
            price: Some(11_990),
            currency: Some("USD".to_owned()),
            app_account_token: Some(AccountToken::new("6f9d0c2e-4b1a-4c8e-9f3d-2a7b5e1c0d84")),
            in_app_ownership_type: Some("PURCHASED".to_owned()),
            transaction_reason: Some("RENEWAL".to_owned()),
            offer_type: None,
            offer_discount_type: None,
            is_upgraded: Some(false),
            revocation_date: None,
            revocation_reason: None,
        }),
        renewal_info: Some(RenewalInfo {
            original_transaction_id: TransactionId::new("2000000000000001"),
            product_id: Some("works.windmill.one.monthly".to_owned()),
            auto_renew_product_id: Some("works.windmill.one.monthly".to_owned()),
            auto_renew_status: Some(1),
            expiration_intent: None,
            is_in_billing_retry_period: Some(false),
            grace_period_expires_date: None,
            price_increase_status: None,
            renewal_date: Some(1_796_083_200_000),
            renewal_price: Some(11_990),
            currency: Some("USD".to_owned()),
            offer_type: None,
            signed_date: Some(1_793_491_260_000),
            environment: Environment::Sandbox,
        }),
    };
    assert!(verified == Ok(expected), "refused: {:?}", verified.err());
}

#[test]
fn a_transaction_a_phone_hands_over_verifies_on_its_own() {
    let chain = TestChain::issue(ChainShape::default());
    let transaction = chain.sign(&json!({
        "transactionId": "2000000000000001",
        "originalTransactionId": "2000000000000001",
        "bundleId": "works.windmill.app",
        "productId": "works.windmill.one.monthly",
        "type": "Auto-Renewable Subscription",
        "purchaseDate": 1_790_812_800_000_i64,
        "expiresDate": 1_793_491_200_000_i64,
        "signedDate": 1_793_491_260_000_i64,
        "environment": "Production",
        "offerType": 1,
        "offerDiscountType": "FREE_TRIAL",
        "revocationDate": 1_791_000_000_000_i64,
        "revocationReason": 0
    }));

    let verified = chain.verifier().verify_transaction(&transaction);

    let expected = TransactionInfo {
        transaction_id: TransactionId::new("2000000000000001"),
        original_transaction_id: TransactionId::new("2000000000000001"),
        bundle_id: "works.windmill.app".to_owned(),
        product_id: "works.windmill.one.monthly".to_owned(),
        product_type: Some("Auto-Renewable Subscription".to_owned()),
        purchase_date: 1_790_812_800_000,
        original_purchase_date: None,
        expires_date: Some(1_793_491_200_000),
        signed_date: Some(1_793_491_260_000),
        environment: Environment::Production,
        storefront: None,
        price: None,
        currency: None,
        app_account_token: None,
        in_app_ownership_type: None,
        transaction_reason: None,
        offer_type: Some(1),
        offer_discount_type: Some("FREE_TRIAL".to_owned()),
        is_upgraded: None,
        revocation_date: Some(1_791_000_000_000),
        revocation_reason: Some(0),
    };
    assert!(verified == Ok(expected), "refused: {:?}", verified.err());
}

#[test]
fn a_payload_with_one_altered_byte_is_refused() {
    let chain = TestChain::issue(ChainShape::default());
    let verifier = chain.verifier();
    let signed = chain.sign(&json!({
        "transactionId": "2000000000000001",
        "originalTransactionId": "2000000000000001",
        "bundleId": "works.windmill.app",
        "productId": "works.windmill.one.monthly",
        "purchaseDate": 1_790_812_800_000_i64,
        "signedDate": 1_793_491_260_000_i64,
        "environment": "Production"
    }));
    let [header, payload, signature]: [&str; 3] =
        signed.split('.').collect::<Vec<_>>().try_into().unwrap();
    let payload = String::from_utf8(URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
    let altered = payload.replacen(
        "\"originalTransactionId\":\"2000000000000001\"",
        "\"originalTransactionId\":\"2000000000000009\"",
        1,
    );
    let tampered = format!("{header}.{}.{signature}", URL_SAFE_NO_PAD.encode(&altered));

    assert!(verifier.verify_transaction(&signed).is_ok());
    assert_ne!(altered, payload);
    assert_eq!(
        verifier.verify_transaction(&tampered).err(),
        Some(Refusal::Signature)
    );
}

#[test]
fn a_payload_signed_under_a_foreign_chain_is_refused() {
    let trusted = TestChain::issue(ChainShape::default());
    let foreign = TestChain::issue(ChainShape::default());
    let transaction = foreign.sign(&json!({
        "transactionId": "2000000000000001",
        "originalTransactionId": "2000000000000001",
        "bundleId": "works.windmill.app",
        "productId": "works.windmill.one.monthly",
        "purchaseDate": 1_790_812_800_000_i64,
        "signedDate": 1_793_491_260_000_i64,
        "environment": "Production"
    }));

    let verified = trusted.verifier().verify_transaction(&transaction);

    assert_eq!(verified.err(), Some(Refusal::Untrusted));
}

#[test]
fn a_leaf_issued_under_another_intermediate_is_refused() {
    let trusted = TestChain::issue(ChainShape::default());
    let foreign = TestChain::issue(ChainShape::default());
    let transaction = jws(
        "ES256",
        &[&foreign.leaf, &trusted.intermediate, &trusted.root],
        &foreign.leaf_key,
        &json!({
            "transactionId": "2000000000000001",
            "originalTransactionId": "2000000000000001",
            "bundleId": "works.windmill.app",
            "productId": "works.windmill.one.monthly",
            "purchaseDate": 1_790_812_800_000_i64,
            "signedDate": 1_793_491_260_000_i64,
            "environment": "Production"
        }),
    );

    let verified = trusted.verifier().verify_transaction(&transaction);

    assert_eq!(verified.err(), Some(Refusal::Untrusted));
}

#[test]
fn a_leaf_naming_another_issuer_is_refused_though_the_intermediates_key_signed_it() {
    let chain = TestChain::issue(ChainShape {
        leaf_names_its_issuer: false,
        ..ChainShape::default()
    });
    let transaction = chain.sign(&json!({
        "transactionId": "2000000000000001",
        "originalTransactionId": "2000000000000001",
        "bundleId": "works.windmill.app",
        "productId": "works.windmill.one.monthly",
        "purchaseDate": 1_790_812_800_000_i64,
        "signedDate": 1_793_491_260_000_i64,
        "environment": "Production"
    }));

    let verified = chain.verifier().verify_transaction(&transaction);

    assert_eq!(verified.err(), Some(Refusal::Untrusted));
}

#[test]
fn a_payload_whose_leaf_had_expired_when_it_was_signed_is_refused() {
    let chain = TestChain::issue(ChainShape {
        leaf_not_after: date_time_ymd(2026, 6, 1),
        ..ChainShape::default()
    });
    let notification = chain.sign(&json!({
        "notificationType": "TEST",
        "notificationUUID": "0b4d6a52-8c1e-4f7a-a3b9-5d2e8f1c6a07",
        "signedDate": 1_793_491_260_000_i64,
        "data": { "bundleId": "works.windmill.app", "environment": "Production" }
    }));

    let verified = chain.verifier().verify_notification(&notification);

    assert_eq!(verified.err(), Some(Refusal::Validity));
}

#[test]
fn a_payload_signed_after_its_intermediate_or_root_expired_is_refused() {
    let transaction = json!({
        "transactionId": "2000000000000001",
        "originalTransactionId": "2000000000000001",
        "bundleId": "works.windmill.app",
        "productId": "works.windmill.one.monthly",
        "purchaseDate": 1_790_812_800_000_i64,
        "signedDate": 1_793_491_260_000_i64,
        "environment": "Production"
    });
    let expired_intermediate = TestChain::issue(ChainShape {
        intermediate_not_after: date_time_ymd(2026, 6, 1),
        ..ChainShape::default()
    });
    let expired_root = TestChain::issue(ChainShape {
        root_not_after: date_time_ymd(2026, 6, 1),
        ..ChainShape::default()
    });

    assert_eq!(
        expired_intermediate
            .verifier()
            .verify_transaction(&expired_intermediate.sign(&transaction))
            .err(),
        Some(Refusal::Validity)
    );
    assert_eq!(
        expired_root
            .verifier()
            .verify_transaction(&expired_root.sign(&transaction))
            .err(),
        Some(Refusal::Validity)
    );
}

#[test]
fn without_a_signing_date_the_clock_decides_whether_the_leaf_is_valid() {
    let chain = TestChain::issue(ChainShape {
        leaf_not_after: date_time_ymd(2026, 6, 1),
        ..ChainShape::default()
    });
    let transaction = chain.sign(&json!({
        "transactionId": "2000000000000001",
        "originalTransactionId": "2000000000000001",
        "bundleId": "works.windmill.app",
        "productId": "works.windmill.one.monthly",
        "purchaseDate": 1_772_323_200_000_i64,
        "environment": "Production"
    }));
    let verifier_at = |millis: u64| {
        SignedDataVerifier::new(&[&chain.root], "works.windmill.app", move || {
            UNIX_EPOCH + Duration::from_millis(millis)
        })
        .unwrap()
    };

    assert!(
        verifier_at(1_772_323_200_000)
            .verify_transaction(&transaction)
            .is_ok()
    );
    assert_eq!(
        verifier_at(1_793_491_200_000)
            .verify_transaction(&transaction)
            .err(),
        Some(Refusal::Validity)
    );
}

#[test]
fn a_payload_for_another_bundle_id_is_refused() {
    let chain = TestChain::issue(ChainShape::default());
    let notification = chain.sign(&json!({
        "notificationType": "TEST",
        "notificationUUID": "0b4d6a52-8c1e-4f7a-a3b9-5d2e8f1c6a07",
        "signedDate": 1_793_491_260_000_i64,
        "data": { "bundleId": "com.example.other", "environment": "Production" }
    }));

    let verified = chain.verifier().verify_notification(&notification);

    assert_eq!(verified.err(), Some(Refusal::BundleId));
}

#[test]
fn a_payload_whose_environment_is_xcode_or_local_testing_is_refused_even_when_its_signature_holds()
{
    let chain = TestChain::issue(ChainShape::default());
    let transaction_in = |environment: &str| {
        chain.sign(&json!({
            "transactionId": "2000000000000001",
            "originalTransactionId": "2000000000000001",
            "bundleId": "works.windmill.app",
            "productId": "works.windmill.one.monthly",
            "purchaseDate": 1_790_812_800_000_i64,
            "signedDate": 1_793_491_260_000_i64,
            "environment": environment
        }))
    };
    let verifier = chain.verifier();

    let outcomes = [
        verifier
            .verify_transaction(&transaction_in("Sandbox"))
            .err(),
        verifier.verify_transaction(&transaction_in("Xcode")).err(),
        verifier
            .verify_transaction(&transaction_in("LocalTesting"))
            .err(),
    ];

    assert_eq!(
        outcomes,
        [None, Some(Refusal::Malformed), Some(Refusal::Malformed)]
    );
}

#[test]
fn a_payload_signed_later_than_the_clock_allows_is_refused() {
    let chain = TestChain::issue(ChainShape::default());
    let transaction_signed_at = |signed_date: i64| {
        chain.sign(&json!({
            "transactionId": "2000000000000001",
            "originalTransactionId": "2000000000000001",
            "bundleId": "works.windmill.app",
            "productId": "works.windmill.one.monthly",
            "purchaseDate": 1_790_812_800_000_i64,
            "signedDate": signed_date,
            "environment": "Production"
        }))
    };
    let verifier = chain.verifier();

    let within_a_minute = verifier
        .verify_transaction(&transaction_signed_at(1_793_491_320_000))
        .err();
    let past_a_minute = verifier
        .verify_transaction(&transaction_signed_at(1_793_491_320_001))
        .err();

    assert_eq!(
        (within_a_minute, past_a_minute),
        (None, Some(Refusal::SignedInFuture))
    );
}

#[test]
fn a_nested_transaction_with_a_bad_signature_is_refused_inside_a_good_notification() {
    let chain = TestChain::issue(ChainShape::default());
    let impostor = TestChain::issue(ChainShape::default());
    let transaction = jws(
        "ES256",
        &chain.x5c(),
        &impostor.leaf_key,
        &json!({
            "transactionId": "2000000000000002",
            "originalTransactionId": "2000000000000001",
            "bundleId": "works.windmill.app",
            "productId": "works.windmill.one.monthly",
            "purchaseDate": 1_793_491_200_000_i64,
            "signedDate": 1_793_491_260_000_i64,
            "environment": "Production"
        }),
    );
    let notification = chain.sign(&json!({
        "notificationType": "DID_RENEW",
        "notificationUUID": "0b4d6a52-8c1e-4f7a-a3b9-5d2e8f1c6a07",
        "signedDate": 1_793_491_260_000_i64,
        "data": {
            "bundleId": "works.windmill.app",
            "environment": "Production",
            "signedTransactionInfo": transaction
        }
    }));

    let verified = chain.verifier().verify_notification(&notification);

    assert_eq!(verified.err(), Some(Refusal::Signature));
}

#[test]
fn a_nested_renewal_info_with_a_bad_signature_is_refused_inside_a_good_notification() {
    let chain = TestChain::issue(ChainShape::default());
    let impostor = TestChain::issue(ChainShape::default());
    let renewal_info = jws(
        "ES256",
        &chain.x5c(),
        &impostor.leaf_key,
        &json!({
            "originalTransactionId": "2000000000000001",
            "autoRenewStatus": 1,
            "signedDate": 1_793_491_260_000_i64,
            "environment": "Production"
        }),
    );
    let notification = chain.sign(&json!({
        "notificationType": "DID_CHANGE_RENEWAL_STATUS",
        "subtype": "AUTO_RENEW_ENABLED",
        "notificationUUID": "0b4d6a52-8c1e-4f7a-a3b9-5d2e8f1c6a07",
        "signedDate": 1_793_491_260_000_i64,
        "data": {
            "bundleId": "works.windmill.app",
            "environment": "Production",
            "signedRenewalInfo": renewal_info
        }
    }));

    let verified = chain.verifier().verify_notification(&notification);

    assert_eq!(verified.err(), Some(Refusal::Signature));
}

#[test]
fn a_nested_transaction_from_another_environment_is_refused() {
    let chain = TestChain::issue(ChainShape::default());
    let transaction = chain.sign(&json!({
        "transactionId": "2000000000000002",
        "originalTransactionId": "2000000000000001",
        "bundleId": "works.windmill.app",
        "productId": "works.windmill.one.monthly",
        "purchaseDate": 1_793_491_200_000_i64,
        "signedDate": 1_793_491_260_000_i64,
        "environment": "Production"
    }));
    let notification = chain.sign(&json!({
        "notificationType": "DID_RENEW",
        "notificationUUID": "0b4d6a52-8c1e-4f7a-a3b9-5d2e8f1c6a07",
        "signedDate": 1_793_491_260_000_i64,
        "data": {
            "bundleId": "works.windmill.app",
            "environment": "Sandbox",
            "signedTransactionInfo": transaction
        }
    }));

    let verified = chain.verifier().verify_notification(&notification);

    assert_eq!(verified.err(), Some(Refusal::Environment));
}

#[test]
fn a_summary_notification_names_its_app_in_the_summary() {
    let chain = TestChain::issue(ChainShape::default());
    let notification = chain.sign(&json!({
        "notificationType": "RENEWAL_EXTENSION",
        "subtype": "SUMMARY",
        "notificationUUID": "0b4d6a52-8c1e-4f7a-a3b9-5d2e8f1c6a07",
        "signedDate": 1_793_491_260_000_i64,
        "summary": {
            "requestIdentifier": "5d0f7c1a-6e2b-4a93-8c4d-1f7e9b2a3c56",
            "bundleId": "works.windmill.app",
            "environment": "Production",
            "succeededCount": 3,
            "failedCount": 0
        }
    }));

    let verified = chain.verifier().verify_notification(&notification);

    let expected = Notification {
        notification_uuid: "0b4d6a52-8c1e-4f7a-a3b9-5d2e8f1c6a07".to_owned(),
        notification_type: "RENEWAL_EXTENSION".to_owned(),
        subtype: Some("SUMMARY".to_owned()),
        signed_date: Some(1_793_491_260_000),
        environment: Environment::Production,
        status: None,
        transaction: None,
        renewal_info: None,
    };
    assert!(verified == Ok(expected), "refused: {:?}", verified.err());
}

#[test]
fn a_chain_missing_the_intermediate_is_refused() {
    let chain = TestChain::issue(ChainShape::default());
    let transaction = jws(
        "ES256",
        &[&chain.leaf, &chain.root],
        &chain.leaf_key,
        &json!({
            "transactionId": "2000000000000001",
            "originalTransactionId": "2000000000000001",
            "bundleId": "works.windmill.app",
            "productId": "works.windmill.one.monthly",
            "purchaseDate": 1_790_812_800_000_i64,
            "signedDate": 1_793_491_260_000_i64,
            "environment": "Production"
        }),
    );

    let verified = chain.verifier().verify_transaction(&transaction);

    assert_eq!(verified.err(), Some(Refusal::ChainLength));
}

#[test]
fn a_leaf_without_apples_receipt_signing_marker_is_refused() {
    let chain = TestChain::issue(ChainShape {
        leaf_marked: false,
        ..ChainShape::default()
    });
    let transaction = chain.sign(&json!({
        "transactionId": "2000000000000001",
        "originalTransactionId": "2000000000000001",
        "bundleId": "works.windmill.app",
        "productId": "works.windmill.one.monthly",
        "purchaseDate": 1_790_812_800_000_i64,
        "signedDate": 1_793_491_260_000_i64,
        "environment": "Production"
    }));

    let verified = chain.verifier().verify_transaction(&transaction);

    assert_eq!(verified.err(), Some(Refusal::AppleMarker));
}

#[test]
fn an_intermediate_without_apples_developer_relations_marker_is_refused() {
    let chain = TestChain::issue(ChainShape {
        intermediate_marked: false,
        ..ChainShape::default()
    });
    let transaction = chain.sign(&json!({
        "transactionId": "2000000000000001",
        "originalTransactionId": "2000000000000001",
        "bundleId": "works.windmill.app",
        "productId": "works.windmill.one.monthly",
        "purchaseDate": 1_790_812_800_000_i64,
        "signedDate": 1_793_491_260_000_i64,
        "environment": "Production"
    }));

    let verified = chain.verifier().verify_transaction(&transaction);

    assert_eq!(verified.err(), Some(Refusal::AppleMarker));
}

#[test]
fn an_intermediate_that_is_not_a_certificate_authority_is_refused() {
    let chain = TestChain::issue(ChainShape {
        intermediate_is_ca: false,
        ..ChainShape::default()
    });
    let transaction = chain.sign(&json!({
        "transactionId": "2000000000000001",
        "originalTransactionId": "2000000000000001",
        "bundleId": "works.windmill.app",
        "productId": "works.windmill.one.monthly",
        "purchaseDate": 1_790_812_800_000_i64,
        "signedDate": 1_793_491_260_000_i64,
        "environment": "Production"
    }));

    let verified = chain.verifier().verify_transaction(&transaction);

    assert_eq!(verified.err(), Some(Refusal::Untrusted));
}

#[test]
fn a_header_naming_another_algorithm_is_refused() {
    let chain = TestChain::issue(ChainShape::default());
    let transaction = jws(
        "ES384",
        &chain.x5c(),
        &chain.leaf_key,
        &json!({
            "transactionId": "2000000000000001",
            "originalTransactionId": "2000000000000001",
            "bundleId": "works.windmill.app",
            "productId": "works.windmill.one.monthly",
            "purchaseDate": 1_790_812_800_000_i64,
            "signedDate": 1_793_491_260_000_i64,
            "environment": "Production"
        }),
    );

    let verified = chain.verifier().verify_transaction(&transaction);

    assert_eq!(verified.err(), Some(Refusal::Algorithm));
}

#[test]
fn the_pinned_root_is_apple_root_ca_g3() {
    let root = include_bytes!("../roots/AppleRootCA-G3.cer");

    let fingerprint = ring::digest::digest(&ring::digest::SHA256, root);

    let hex: String = fingerprint
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(
        hex,
        "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179"
    );
}

#[test]
fn apples_real_chain_passes_every_certificate_check_while_its_leaf_is_valid() {
    let leaf = include_bytes!("../../../tests/fixtures/app_store/apple-leaf.cer");
    let intermediate = include_bytes!("../../../tests/fixtures/app_store/apple-intermediate.cer");
    let root = include_bytes!("../roots/AppleRootCA-G3.cer");
    let transaction_signed_at = |signed_date: i64| {
        let chain: Vec<String> = [&leaf[..], &intermediate[..], &root[..]]
            .iter()
            .map(|der| STANDARD.encode(der))
            .collect();
        let header = URL_SAFE_NO_PAD.encode(json!({ "alg": "ES256", "x5c": chain }).to_string());
        let payload = URL_SAFE_NO_PAD.encode(
            json!({
                "transactionId": "2000000000000001",
                "originalTransactionId": "2000000000000001",
                "bundleId": "works.windmill.app",
                "productId": "works.windmill.one.monthly",
                "purchaseDate": signed_date,
                "signedDate": signed_date,
                "environment": "Production"
            })
            .to_string(),
        );
        format!("{header}.{payload}.{}", URL_SAFE_NO_PAD.encode([0_u8; 64]))
    };
    let verifier =
        SignedDataVerifier::windmill(|| UNIX_EPOCH + Duration::from_millis(1_830_297_600_000));

    assert_eq!(
        verifier
            .verify_transaction(&transaction_signed_at(1_761_955_200_000))
            .err(),
        Some(Refusal::Signature)
    );
    assert_eq!(
        verifier
            .verify_transaction(&transaction_signed_at(1_825_027_200_000))
            .err(),
        Some(Refusal::Validity)
    );
}

#[test]
#[ignore = "no payload signed by Apple is recorded yet: recording one takes an App Store Connect sandbox purchase"]
fn a_payload_recorded_from_apple_verifies() {
    let recorded = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/app_store/sandbox-notification.jws"
    ))
    .unwrap();

    let verified =
        SignedDataVerifier::windmill(SystemTime::now).verify_notification(recorded.trim());

    assert_eq!(
        verified.map(|notification| notification.environment),
        Ok(Environment::Sandbox)
    );
}
