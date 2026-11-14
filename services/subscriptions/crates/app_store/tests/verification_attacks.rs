use std::time::{Duration, UNIX_EPOCH};

use app_store::verification::{InvalidRoots, Refusal, SignedDataVerifier};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use rcgen::string::PrintableString;
use rcgen::{
    BasicConstraints, CertificateParams, CustomExtension, DistinguishedName, DnType, DnValue, IsCa,
    Issuer, KeyPair, PKCS_ECDSA_P256_SHA256, PKCS_ECDSA_P384_SHA384, date_time_ymd,
};
use ring::rand::SystemRandom;
use ring::signature::{
    ECDSA_P256_SHA256_FIXED_SIGNING, ECDSA_P384_SHA384_FIXED_SIGNING, EcdsaKeyPair,
};
use serde_json::{Value, json};
use x509_parser::prelude::{FromDer, X509Certificate};

const REAL_LEAF: &[u8] = include_bytes!("../../../tests/fixtures/app_store/apple-leaf.cer");
const REAL_G6: &[u8] = include_bytes!("../../../tests/fixtures/app_store/apple-intermediate.cer");
const REAL_G3: &[u8] = include_bytes!("../roots/AppleRootCA-G3.cer");
const GO_IAP_RENEWAL: &str =
    include_str!("../../../tests/fixtures/app_store/go-iap-renewal-info.jws");

const NOW_MS: i64 = 1_794_614_400_000;
const IN_REAL_LEAF_VALIDITY: i64 = 1_794_614_400_000;
const GO_IAP_SIGNED_DATE: i64 = 1_684_822_778_492;

const RECEIPT_SIGNER: &[u64] = &[1, 2, 840, 113635, 100, 6, 11, 1];
const WWDR: &[u64] = &[1, 2, 840, 113635, 100, 6, 2, 1];

fn windmill() -> SignedDataVerifier {
    SignedDataVerifier::windmill(|| UNIX_EPOCH + Duration::from_millis(NOW_MS as u64))
}

fn apple_name(common_name: &str, unit: &str) -> DistinguishedName {
    let mut name = DistinguishedName::new();
    name.push(DnType::CommonName, common_name);
    name.push(DnType::OrganizationalUnitName, unit);
    name.push(DnType::OrganizationName, "Apple Inc.");
    name.push(
        DnType::CountryName,
        DnValue::PrintableString(PrintableString::try_from("US").unwrap()),
    );
    name
}

fn plain_name(common_name: &str) -> DistinguishedName {
    let mut name = DistinguishedName::new();
    name.push(DnType::CommonName, common_name);
    name
}

fn params(name: DistinguishedName, ca: bool, marker: Option<&[u64]>) -> CertificateParams {
    let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
    params.distinguished_name = name;
    params.is_ca = match ca {
        true => IsCa::Ca(BasicConstraints::Unconstrained),
        false => IsCa::ExplicitNoCa,
    };
    params.not_before = date_time_ymd(2020, 1, 1);
    params.not_after = date_time_ymd(2035, 1, 1);
    params.custom_extensions = marker
        .map(|oid| CustomExtension::from_oid_content(oid, vec![0x05, 0x00]))
        .into_iter()
        .collect();
    params
}

fn ring_key(key: &KeyPair) -> EcdsaKeyPair {
    EcdsaKeyPair::from_pkcs8(
        &ECDSA_P256_SHA256_FIXED_SIGNING,
        &key.serialize_der(),
        &SystemRandom::new(),
    )
    .unwrap()
}

fn subject(der: &[u8]) -> Vec<u8> {
    X509Certificate::from_der(der)
        .unwrap()
        .1
        .subject()
        .as_raw()
        .to_vec()
}

fn issuer(der: &[u8]) -> Vec<u8> {
    X509Certificate::from_der(der)
        .unwrap()
        .1
        .issuer()
        .as_raw()
        .to_vec()
}

fn raw_jws(header: &str, payload: &str, key: &EcdsaKeyPair) -> String {
    let signing_input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header),
        URL_SAFE_NO_PAD.encode(payload)
    );
    let signature = key
        .sign(&SystemRandom::new(), signing_input.as_bytes())
        .unwrap();
    format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature.as_ref())
    )
}

fn header(alg: &str, x5c: &[&[u8]]) -> String {
    let chain: Vec<String> = x5c.iter().map(|der| STANDARD.encode(der)).collect();
    json!({ "alg": alg, "x5c": chain }).to_string()
}

fn jws(x5c: &[&[u8]], key: &EcdsaKeyPair, payload: &Value) -> String {
    raw_jws(&header("ES256", x5c), &payload.to_string(), key)
}

fn transaction(signed_date: i64, environment: &str, bundle_id: &str) -> Value {
    json!({
        "transactionId": "2000000000000009",
        "originalTransactionId": "2000000000000009",
        "bundleId": bundle_id,
        "productId": "works.windmill.one.monthly",
        "purchaseDate": signed_date,
        "expiresDate": signed_date + 2_592_000_000_i64,
        "signedDate": signed_date,
        "environment": environment
    })
}

struct ForgedApple {
    root: Vec<u8>,
    intermediate: Vec<u8>,
    leaf: Vec<u8>,
    leaf_key: EcdsaKeyPair,
}

fn forged_apple_chain() -> ForgedApple {
    let root_key = KeyPair::generate_for(&PKCS_ECDSA_P384_SHA384).unwrap();
    let root_params = params(
        apple_name("Apple Root CA - G3", "Apple Certification Authority"),
        true,
        None,
    );
    let root = root_params.self_signed(&root_key).unwrap();
    let intermediate_key = KeyPair::generate_for(&PKCS_ECDSA_P384_SHA384).unwrap();
    let intermediate_params = params(
        apple_name(
            "Apple Worldwide Developer Relations Certification Authority",
            "G6",
        ),
        true,
        Some(WWDR),
    );
    let intermediate = intermediate_params
        .signed_by(&intermediate_key, &Issuer::new(root_params, root_key))
        .unwrap();
    let leaf_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
    let leaf = params(
        apple_name(
            "Prod ECC Mac App Store and iTunes Store Receipt Signing",
            "Apple Worldwide Developer Relations",
        ),
        false,
        Some(RECEIPT_SIGNER),
    )
    .signed_by(
        &leaf_key,
        &Issuer::new(intermediate_params, intermediate_key),
    )
    .unwrap();
    ForgedApple {
        root: root.der().to_vec(),
        intermediate: intermediate.der().to_vec(),
        leaf: leaf.der().to_vec(),
        leaf_key: ring_key(&leaf_key),
    }
}

struct OwnChain {
    root: Vec<u8>,
    intermediate: Vec<u8>,
    leaf: Vec<u8>,
    leaf_key: EcdsaKeyPair,
}

impl OwnChain {
    fn issue(label: &str) -> Self {
        let root_key = KeyPair::generate_for(&PKCS_ECDSA_P384_SHA384).unwrap();
        let root_params = params(plain_name(&format!("{label} Root")), true, None);
        let root = root_params.self_signed(&root_key).unwrap();
        let intermediate_key = KeyPair::generate_for(&PKCS_ECDSA_P384_SHA384).unwrap();
        let intermediate_params = params(
            plain_name(&format!("{label} Intermediate")),
            true,
            Some(WWDR),
        );
        let intermediate = intermediate_params
            .signed_by(&intermediate_key, &Issuer::new(root_params, root_key))
            .unwrap();
        let leaf_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let leaf = params(
            plain_name(&format!("{label} Leaf")),
            false,
            Some(RECEIPT_SIGNER),
        )
        .signed_by(
            &leaf_key,
            &Issuer::new(intermediate_params, intermediate_key),
        )
        .unwrap();
        Self {
            root: root.der().to_vec(),
            intermediate: intermediate.der().to_vec(),
            leaf: leaf.der().to_vec(),
            leaf_key: ring_key(&leaf_key),
        }
    }

    fn x5c(&self) -> [&[u8]; 3] {
        [&self.leaf, &self.intermediate, &self.root]
    }

    fn sign(&self, payload: &Value) -> String {
        jws(&self.x5c(), &self.leaf_key, payload)
    }

    fn sign_raw(&self, payload: &str) -> String {
        raw_jws(&header("ES256", &self.x5c()), payload, &self.leaf_key)
    }

    fn verifier(&self) -> SignedDataVerifier {
        verifier_trusting(&[&self.root])
    }
}

fn verifier_trusting(roots: &[&[u8]]) -> SignedDataVerifier {
    SignedDataVerifier::new(roots, "works.windmill.app", || {
        UNIX_EPOCH + Duration::from_millis(NOW_MS as u64)
    })
    .unwrap()
}

fn attacker_key() -> EcdsaKeyPair {
    ring_key(&KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap())
}

#[test]
fn a_self_signed_chain_wearing_apples_exact_names_is_refused() {
    let forged = forged_apple_chain();
    assert_eq!(issuer(&forged.intermediate), subject(REAL_G3));
    assert_eq!(subject(&forged.intermediate), subject(REAL_G6));
    assert_eq!(issuer(&forged.leaf), subject(REAL_G6));
    let payload = transaction(IN_REAL_LEAF_VALIDITY, "Production", "works.windmill.app");

    let own_root_in_x5c = jws(
        &[&forged.leaf, &forged.intermediate, &forged.root],
        &forged.leaf_key,
        &payload,
    );
    let real_root_in_x5c = jws(
        &[&forged.leaf, &forged.intermediate, REAL_G3],
        &forged.leaf_key,
        &payload,
    );

    assert_eq!(
        windmill().verify_transaction(&own_root_in_x5c).err(),
        Some(Refusal::Untrusted)
    );
    assert_eq!(
        windmill().verify_transaction(&real_root_in_x5c).err(),
        Some(Refusal::Untrusted)
    );
}

#[test]
fn a_leaf_of_my_own_naming_apples_real_intermediate_is_refused() {
    let forged = forged_apple_chain();
    assert_eq!(issuer(&forged.leaf), subject(REAL_G6));

    let verified = windmill().verify_transaction(&jws(
        &[&forged.leaf, REAL_G6, REAL_G3],
        &forged.leaf_key,
        &transaction(IN_REAL_LEAF_VALIDITY, "Production", "works.windmill.app"),
    ));

    assert_eq!(verified.err(), Some(Refusal::Untrusted));
}

#[test]
fn apples_real_chain_with_a_payload_signed_by_my_key_is_refused_at_the_signature() {
    let verified = windmill().verify_transaction(&jws(
        &[REAL_LEAF, REAL_G6, REAL_G3],
        &attacker_key(),
        &transaction(IN_REAL_LEAF_VALIDITY, "Production", "works.windmill.app"),
    ));

    assert_eq!(verified.err(), Some(Refusal::Signature));
}

#[test]
fn every_rearrangement_of_apples_real_certificates_is_refused() {
    let key = attacker_key();
    let payload = transaction(IN_REAL_LEAF_VALIDITY, "Production", "works.windmill.app");
    let mut leaf_with_trailing_byte = REAL_LEAF.to_vec();
    leaf_with_trailing_byte.push(0);
    let cases: Vec<(&str, Vec<&[u8]>, Refusal)> = vec![
        (
            "intermediate as leaf, root as intermediate",
            vec![REAL_G6, REAL_G3, REAL_G3],
            Refusal::Certificate,
        ),
        (
            "root as intermediate",
            vec![REAL_LEAF, REAL_G3, REAL_G3],
            Refusal::Untrusted,
        ),
        (
            "duplicated leaf",
            vec![REAL_LEAF, REAL_LEAF, REAL_G3],
            Refusal::Untrusted,
        ),
        (
            "leaf and intermediate swapped",
            vec![REAL_G6, REAL_LEAF, REAL_G3],
            Refusal::Certificate,
        ),
        (
            "root as leaf",
            vec![REAL_G3, REAL_G6, REAL_G3],
            Refusal::Certificate,
        ),
        (
            "four certificates",
            vec![REAL_LEAF, REAL_G6, REAL_G3, REAL_G3],
            Refusal::ChainLength,
        ),
        (
            "two certificates",
            vec![REAL_LEAF, REAL_G6],
            Refusal::ChainLength,
        ),
        ("no certificates", vec![], Refusal::ChainLength),
        (
            "trailing byte after the leaf",
            vec![&leaf_with_trailing_byte, REAL_G6, REAL_G3],
            Refusal::Certificate,
        ),
    ];

    let outcomes: Vec<(&str, Option<Refusal>)> = cases
        .iter()
        .map(|(name, x5c, _)| {
            (
                *name,
                windmill()
                    .verify_transaction(&jws(x5c, &key, &payload))
                    .err(),
            )
        })
        .collect();

    let expected: Vec<(&str, Option<Refusal>)> = cases
        .iter()
        .map(|(name, _, refusal)| (*name, Some(*refusal)))
        .collect();
    assert_eq!(outcomes, expected);
}

#[test]
fn x5c_entries_in_another_base64_dialect_are_refused() {
    let key = attacker_key();
    let payload =
        transaction(IN_REAL_LEAF_VALIDITY, "Production", "works.windmill.app").to_string();
    assert_eq!(REAL_G6.len() % 3, 2);
    let dialects = [
        STANDARD_NO_PAD.encode(REAL_G6),
        URL_SAFE.encode(REAL_G6),
        format!(" {}", STANDARD.encode(REAL_G6)),
    ];

    let outcomes: Vec<Option<Refusal>> = dialects
        .iter()
        .map(|leaf| {
            let header = json!({
                "alg": "ES256",
                "x5c": [STANDARD.encode(REAL_LEAF), leaf, STANDARD.encode(REAL_G3)]
            });
            windmill()
                .verify_transaction(&raw_jws(&header.to_string(), &payload, &key))
                .err()
        })
        .collect();

    assert_eq!(outcomes, vec![Some(Refusal::Certificate); 3]);
}

#[test]
fn x5c_root_slot_is_never_read_as_apples_libraries_also_skip_it() {
    let chain = OwnChain::issue("Slot");
    let header = json!({
        "alg": "ES256",
        "x5c": [STANDARD.encode(&chain.leaf), STANDARD.encode(&chain.intermediate), "not a certificate"]
    });
    let jws = raw_jws(
        &header.to_string(),
        &transaction(NOW_MS, "Production", "works.windmill.app").to_string(),
        &chain.leaf_key,
    );

    assert!(chain.verifier().verify_transaction(&jws).is_ok());
}

#[test]
fn every_other_algorithm_is_refused_before_any_key_is_used() {
    let payload =
        transaction(IN_REAL_LEAF_VALIDITY, "Production", "works.windmill.app").to_string();
    let x5c: [&[u8]; 3] = [REAL_LEAF, REAL_G6, REAL_G3];
    let leaf_spki = X509Certificate::from_der(REAL_LEAF)
        .unwrap()
        .1
        .public_key()
        .subject_public_key
        .data
        .to_vec();
    let hmac = |alg: &str, secret: &[u8]| {
        let signing_input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header(alg, &x5c)),
            URL_SAFE_NO_PAD.encode(&payload)
        );
        let tag = ring::hmac::sign(
            &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret),
            signing_input.as_bytes(),
        );
        format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(tag.as_ref()))
    };
    let unsigned = |alg: &str| {
        format!(
            "{}.{}.",
            URL_SAFE_NO_PAD.encode(header(alg, &x5c)),
            URL_SAFE_NO_PAD.encode(&payload)
        )
    };
    let attempts = [
        unsigned("none"),
        unsigned("None"),
        hmac("HS256", &leaf_spki),
        hmac("HS256", REAL_LEAF),
        raw_jws(&header("ES384", &x5c), &payload, &attacker_key()),
        raw_jws(&header("es256", &x5c), &payload, &attacker_key()),
        raw_jws(&header("ES256 ", &x5c), &payload, &attacker_key()),
    ];

    let outcomes: Vec<Option<Refusal>> = attempts
        .iter()
        .map(|jws| windmill().verify_transaction(jws).err())
        .collect();

    assert_eq!(outcomes, vec![Some(Refusal::Algorithm); 7]);
}

#[test]
fn a_leaf_with_a_p384_key_is_refused_before_its_signature_is_tried() {
    let root_key = KeyPair::generate_for(&PKCS_ECDSA_P384_SHA384).unwrap();
    let root_params = params(plain_name("P384 Root"), true, None);
    let root = root_params.self_signed(&root_key).unwrap();
    let intermediate_key = KeyPair::generate_for(&PKCS_ECDSA_P384_SHA384).unwrap();
    let intermediate_params = params(plain_name("P384 Intermediate"), true, Some(WWDR));
    let intermediate = intermediate_params
        .signed_by(&intermediate_key, &Issuer::new(root_params, root_key))
        .unwrap();
    let leaf_key = KeyPair::generate_for(&PKCS_ECDSA_P384_SHA384).unwrap();
    let leaf = params(plain_name("P384 Leaf"), false, Some(RECEIPT_SIGNER))
        .signed_by(
            &leaf_key,
            &Issuer::new(intermediate_params, intermediate_key),
        )
        .unwrap();
    let ring_leaf_key = EcdsaKeyPair::from_pkcs8(
        &ECDSA_P384_SHA384_FIXED_SIGNING,
        &leaf_key.serialize_der(),
        &SystemRandom::new(),
    )
    .unwrap();
    let signed = raw_jws(
        &header("ES256", &[leaf.der(), intermediate.der(), root.der()]),
        &transaction(NOW_MS, "Production", "works.windmill.app").to_string(),
        &ring_leaf_key,
    );

    let verified = verifier_trusting(&[root.der()]).verify_transaction(&signed);

    assert_eq!(verified.err(), Some(Refusal::Certificate));
}

#[test]
fn reshaped_compact_serialisations_of_a_valid_jws_are_refused() {
    let chain = OwnChain::issue("Shape");
    let valid = chain.sign(&transaction(NOW_MS, "Production", "works.windmill.app"));
    let (header_segment, rest) = valid.split_once('.').unwrap();
    let (payload_segment, signature_segment) = rest.split_once('.').unwrap();
    let signature = URL_SAFE_NO_PAD.decode(signature_segment).unwrap();
    let der_signature = {
        let integer = |bytes: &[u8]| {
            let trimmed: Vec<u8> = bytes
                .iter()
                .copied()
                .skip_while(|byte| *byte == 0)
                .collect();
            let mut encoded = if trimmed[0] & 0x80 != 0 {
                vec![0]
            } else {
                vec![]
            };
            encoded.extend(trimmed);
            let mut out = vec![0x02, encoded.len() as u8];
            out.extend(encoded);
            out
        };
        let mut body = integer(&signature[..32]);
        body.extend(integer(&signature[32..]));
        let mut out = vec![0x30, body.len() as u8];
        out.extend(body);
        out
    };
    let padded = |segment: &str| format!("{segment}{}", "=".repeat((4 - segment.len() % 4) % 4));
    let reshaped = [
        format!("{valid}\n"),
        format!(" {valid}"),
        format!("{valid}."),
        format!("{header_segment}.{payload_segment}.{signature_segment}.{signature_segment}"),
        format!("{header_segment}.{payload_segment}"),
        format!("{header_segment}..{signature_segment}"),
        format!(
            "{}.{payload_segment}.{signature_segment}",
            padded(header_segment)
        ),
        format!(
            "{header_segment}.{}.{signature_segment}",
            padded(payload_segment)
        ),
        format!(
            "{header_segment}.{payload_segment}.{}",
            padded(signature_segment)
        ),
        format!(
            "{header_segment}.{payload_segment}.{}",
            STANDARD.encode(&signature)
        ),
        format!(
            "{header_segment}.{payload_segment}.{}",
            URL_SAFE_NO_PAD.encode(&der_signature)
        ),
        String::new(),
        "..".to_owned(),
    ];
    assert!(chain.verifier().verify_transaction(&valid).is_ok());

    let accepted: Vec<&String> = reshaped
        .iter()
        .filter(|jws| **jws != valid)
        .filter(|jws| chain.verifier().verify_transaction(jws).is_ok())
        .collect();

    assert_eq!(accepted, Vec::<&String>::new());
}

#[test]
fn duplicate_json_keys_are_refused_wherever_they_appear() {
    let chain = OwnChain::issue("Duplicates");
    let x5c: Vec<String> = chain.x5c().iter().map(|der| STANDARD.encode(der)).collect();
    let x5c = serde_json::to_string(&x5c).unwrap();
    let transaction_with = |extra: &str| {
        format!(
            r#"{{"transactionId":"1","originalTransactionId":"1","productId":"p","purchaseDate":{NOW_MS},"signedDate":{NOW_MS},{extra}}}"#
        )
    };
    let in_header = raw_jws(
        &format!(r#"{{"alg":"none","alg":"ES256","x5c":{x5c}}}"#),
        &transaction_with(r#""bundleId":"works.windmill.app","environment":"Production""#),
        &chain.leaf_key,
    );
    let header_x5c_twice = raw_jws(
        &format!(r#"{{"alg":"ES256","x5c":[],"x5c":{x5c}}}"#),
        &transaction_with(r#""bundleId":"works.windmill.app","environment":"Production""#),
        &chain.leaf_key,
    );
    let bundle_twice = chain.sign_raw(&transaction_with(
        r#""bundleId":"works.windmill.app","bundleId":"com.other.app","environment":"Production""#,
    ));
    let bundle_twice_reversed = chain.sign_raw(&transaction_with(
        r#""bundleId":"com.other.app","bundleId":"works.windmill.app","environment":"Production""#,
    ));
    let environment_twice = chain.sign_raw(&transaction_with(
        r#""bundleId":"works.windmill.app","environment":"Xcode","environment":"Production""#,
    ));
    let signed_date_twice = chain.sign_raw(&format!(
        r#"{{"transactionId":"1","originalTransactionId":"1","productId":"p","purchaseDate":{NOW_MS},"signedDate":1,"signedDate":{NOW_MS},"bundleId":"works.windmill.app","environment":"Production"}}"#
    ));
    let notification_data = |data: &str| {
        chain.sign_raw(&format!(
            r#"{{"notificationType":"TEST","notificationUUID":"u","signedDate":{NOW_MS},"data":{{{data}}}}}"#
        ))
    };
    let flattened_bundle_twice = notification_data(
        r#""bundleId":"com.other.app","environment":"Production","bundleId":"works.windmill.app""#,
    );
    let flattened_environment_twice = notification_data(
        r#""bundleId":"works.windmill.app","environment":"Xcode","environment":"Production""#,
    );
    let data_twice = chain.sign_raw(&format!(
        r#"{{"notificationType":"TEST","notificationUUID":"u","signedDate":{NOW_MS},"data":{{"bundleId":"com.other.app","environment":"Production"}},"data":{{"bundleId":"works.windmill.app","environment":"Production"}}}}"#
    ));

    let verifier = chain.verifier();
    let outcomes = [
        verifier.verify_transaction(&in_header).err(),
        verifier.verify_transaction(&header_x5c_twice).err(),
        verifier.verify_transaction(&bundle_twice).err(),
        verifier.verify_transaction(&bundle_twice_reversed).err(),
        verifier.verify_transaction(&environment_twice).err(),
        verifier.verify_transaction(&signed_date_twice).err(),
        verifier.verify_notification(&flattened_bundle_twice).err(),
        verifier
            .verify_notification(&flattened_environment_twice)
            .err(),
        verifier.verify_notification(&data_twice).err(),
    ];

    assert_eq!(outcomes, [Some(Refusal::Malformed); 9]);
}

#[test]
fn bundle_ids_that_only_resemble_windmills_are_refused() {
    let chain = OwnChain::issue("Bundle");
    let lookalikes = [
        "works.windmill.app ",
        " works.windmill.app",
        "works.windmill.app.evil",
        "evil.works.windmill.app",
        "works.windmill.ap",
        "Works.Windmill.App",
        "works.windmill.app\u{0}",
        "works.windmill.app\n",
        "works\u{2024}windmill\u{2024}app",
        "works.windmill.\u{0430}pp",
        "",
    ];

    let outcomes: Vec<Option<Refusal>> = lookalikes
        .iter()
        .map(|bundle| {
            chain
                .verifier()
                .verify_transaction(&chain.sign(&transaction(NOW_MS, "Production", bundle)))
                .err()
        })
        .collect();

    assert_eq!(outcomes, vec![Some(Refusal::BundleId); lookalikes.len()]);
}

#[test]
fn environments_spelled_any_other_way_are_refused() {
    let chain = OwnChain::issue("Environment");
    let spellings = [
        "production",
        "PRODUCTION",
        " Production",
        "Production ",
        "Production\u{0}",
        "sandbox",
        "Sandbox\n",
        "",
        "Xcode",
        "LocalTesting",
    ];

    let outcomes: Vec<Option<Refusal>> = spellings
        .iter()
        .map(|environment| {
            chain
                .verifier()
                .verify_transaction(&chain.sign(&transaction(
                    NOW_MS,
                    environment,
                    "works.windmill.app",
                )))
                .err()
        })
        .collect();

    assert_eq!(outcomes, vec![Some(Refusal::Malformed); spellings.len()]);
}

#[test]
fn signed_dates_of_every_odd_shape_are_refused_or_fall_back_to_the_clock() {
    let chain = OwnChain::issue("Dates");
    let with_signed_date = |signed_date: &str| {
        chain.sign_raw(&format!(
            r#"{{"transactionId":"1","originalTransactionId":"1","bundleId":"works.windmill.app","productId":"p","purchaseDate":{NOW_MS},"signedDate":{signed_date},"environment":"Production"}}"#
        ))
    };
    let verifier = chain.verifier();

    let outcomes = [
        verifier.verify_transaction(&with_signed_date("-1")).err(),
        verifier.verify_transaction(&with_signed_date("0")).err(),
        verifier
            .verify_transaction(&with_signed_date(&i64::MAX.to_string()))
            .err(),
        verifier
            .verify_transaction(&with_signed_date(&i64::MIN.to_string()))
            .err(),
        verifier
            .verify_transaction(&with_signed_date("18446744073709551615"))
            .err(),
        verifier
            .verify_transaction(&with_signed_date(&format!("\"{NOW_MS}\"")))
            .err(),
        verifier
            .verify_transaction(&with_signed_date("1.7946144e12"))
            .err(),
        verifier.verify_transaction(&with_signed_date("null")).err(),
    ];

    assert_eq!(
        outcomes,
        [
            Some(Refusal::Validity),
            Some(Refusal::Validity),
            Some(Refusal::SignedInFuture),
            Some(Refusal::Validity),
            Some(Refusal::Malformed),
            Some(Refusal::Malformed),
            Some(Refusal::Malformed),
            None,
        ]
    );
}

#[test]
fn a_backdated_signed_date_lets_a_leaf_that_expired_in_2023_pass_every_certificate_check_today() {
    let (old_header, _) = GO_IAP_RENEWAL.split_once('.').unwrap();
    let old_header: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(old_header).unwrap()).unwrap();
    let old_leaf = STANDARD
        .decode(old_header["x5c"][0].as_str().unwrap())
        .unwrap();
    let not_after = X509Certificate::from_der(&old_leaf)
        .unwrap()
        .1
        .validity()
        .not_after
        .timestamp();
    assert_eq!(not_after, 1_695_523_833);
    let forged = |signed_date: i64| {
        jws(
            &[&old_leaf, REAL_G6, REAL_G3],
            &attacker_key(),
            &transaction(signed_date, "Production", "works.windmill.app"),
        )
    };

    let backdated = windmill()
        .verify_transaction(&forged(GO_IAP_SIGNED_DATE))
        .err();
    let honest = windmill().verify_transaction(&forged(NOW_MS)).err();

    assert_eq!(backdated, Some(Refusal::Signature));
    assert_eq!(honest, Some(Refusal::Validity));
}

#[test]
fn a_real_apple_signature_from_another_app_verifies_and_is_then_refused_by_shape() {
    let verifier = windmill();

    let as_transaction = verifier.verify_transaction(GO_IAP_RENEWAL.trim()).err();
    let as_notification = verifier.verify_notification(GO_IAP_RENEWAL.trim()).err();

    assert_eq!(as_transaction, Some(Refusal::Malformed));
    assert_eq!(as_notification, Some(Refusal::Malformed));
}

#[test]
fn a_real_apple_jws_with_its_payload_rewritten_is_refused_at_the_signature() {
    let (header_segment, rest) = GO_IAP_RENEWAL.trim().split_once('.').unwrap();
    let (payload_segment, signature_segment) = rest.split_once('.').unwrap();
    let mut payload: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload_segment).unwrap()).unwrap();
    payload["transactionId"] = json!("2000000335310644");
    payload["bundleId"] = json!("works.windmill.app");
    payload["purchaseDate"] = payload["signedDate"].clone();
    let rewritten = format!(
        "{header_segment}.{}.{signature_segment}",
        URL_SAFE_NO_PAD.encode(payload.to_string())
    );

    let verified = windmill().verify_transaction(&rewritten);

    assert_eq!(verified.err(), Some(Refusal::Signature));
}

#[test]
fn the_high_s_twin_of_a_real_apple_signature_also_verifies() {
    let p256_order: [u8; 32] = [
        0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        0xFF, 0xBC, 0xE6, 0xFA, 0xAD, 0xA7, 0x17, 0x9E, 0x84, 0xF3, 0xB9, 0xCA, 0xC2, 0xFC, 0x63,
        0x25, 0x51,
    ];
    let (signing_input, signature_segment) = GO_IAP_RENEWAL.trim().rsplit_once('.').unwrap();
    let signature = URL_SAFE_NO_PAD.decode(signature_segment).unwrap();
    let mut twin = signature[..32].to_vec();
    let mut borrow = 0_i16;
    let mut negated_s = [0_u8; 32];
    for index in (0..32).rev() {
        let difference = p256_order[index] as i16 - signature[32 + index] as i16 - borrow;
        borrow = i16::from(difference < 0);
        negated_s[index] = (difference + 256 * borrow) as u8;
    }
    twin.extend(negated_s);
    let twin_jws = format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(&twin));
    assert_ne!(twin_jws, GO_IAP_RENEWAL.trim());

    let original = windmill().verify_transaction(GO_IAP_RENEWAL.trim()).err();
    let malleated = windmill().verify_transaction(&twin_jws).err();

    assert_eq!(original, Some(Refusal::Malformed));
    assert_eq!(malleated, Some(Refusal::Malformed));
}

#[test]
fn nested_payloads_are_checked_on_their_own_chain_bundle_and_environment() {
    let outer = OwnChain::issue("Outer");
    let stranger = OwnChain::issue("Stranger");
    let notification = |signer: &OwnChain, transaction: String| {
        signer.sign(&json!({
            "notificationType": "DID_RENEW",
            "notificationUUID": "u",
            "signedDate": NOW_MS,
            "data": {
                "bundleId": "works.windmill.app",
                "environment": "Sandbox",
                "signedTransactionInfo": transaction
            }
        }))
    };
    let renewal_notification = |renewal: String| {
        outer.sign(&json!({
            "notificationType": "DID_RENEW",
            "notificationUUID": "u",
            "signedDate": NOW_MS,
            "data": {
                "bundleId": "works.windmill.app",
                "environment": "Sandbox",
                "signedRenewalInfo": renewal
            }
        }))
    };
    let only_outer = outer.verifier();
    let both = verifier_trusting(&[&outer.root, &stranger.root]);
    let sandbox = transaction(NOW_MS, "Sandbox", "works.windmill.app");

    let outcomes = [
        only_outer
            .verify_notification(&notification(&outer, stranger.sign(&sandbox)))
            .err(),
        both.verify_notification(&notification(&outer, stranger.sign(&sandbox)))
            .err(),
        only_outer
            .verify_notification(&notification(
                &outer,
                outer.sign(&transaction(NOW_MS, "Sandbox", "com.other.app")),
            ))
            .err(),
        only_outer
            .verify_notification(&notification(
                &outer,
                outer.sign(&transaction(NOW_MS, "Production", "works.windmill.app")),
            ))
            .err(),
        only_outer
            .verify_notification(&notification(
                &outer,
                outer.sign(&transaction(NOW_MS, "Xcode", "works.windmill.app")),
            ))
            .err(),
        only_outer
            .verify_notification(&renewal_notification(outer.sign(&json!({
                "originalTransactionId": "1",
                "signedDate": NOW_MS,
                "environment": "Production"
            }))))
            .err(),
        only_outer
            .verify_notification(&renewal_notification(stranger.sign(&json!({
                "originalTransactionId": "1",
                "signedDate": NOW_MS,
                "environment": "Sandbox"
            }))))
            .err(),
        only_outer
            .verify_notification(&notification(
                &outer,
                notification(&outer, outer.sign(&sandbox)),
            ))
            .err(),
    ];

    assert_eq!(
        outcomes,
        [
            Some(Refusal::Untrusted),
            None,
            Some(Refusal::BundleId),
            Some(Refusal::Environment),
            Some(Refusal::Malformed),
            Some(Refusal::Environment),
            Some(Refusal::Untrusted),
            Some(Refusal::Malformed),
        ]
    );
}

#[test]
fn trusted_roots_on_curves_other_than_p256_or_p384_are_refused() {
    let curve_oid_p384 = [0x06, 0x05, 0x2B, 0x81, 0x04, 0x00, 0x22];
    let swap_curve = |last_byte: u8| {
        let mut root = REAL_G3.to_vec();
        let at = root
            .windows(curve_oid_p384.len())
            .position(|window| window == curve_oid_p384)
            .unwrap();
        root[at + 6] = last_byte;
        root
    };
    let secp521r1 = swap_curve(0x23);
    let secp256k1 = swap_curve(0x0A);

    let constructed = [
        SignedDataVerifier::new(&[REAL_G3], "x", || UNIX_EPOCH).err(),
        SignedDataVerifier::new(&[&secp521r1], "x", || UNIX_EPOCH).err(),
        SignedDataVerifier::new(&[&secp256k1], "x", || UNIX_EPOCH).err(),
    ];

    assert_eq!(constructed, [None, Some(InvalidRoots), Some(InvalidRoots)]);
}

#[test]
fn a_refusal_formats_as_its_code_alone() {
    let chain = OwnChain::issue("Format");
    let refusal = chain
        .verifier()
        .verify_transaction(&chain.sign(&transaction(
            NOW_MS,
            "Production",
            "6f9d0c2e-4b1a-4c8e-9f3d-2a7b5e1c0d84",
        )))
        .err()
        .unwrap();

    assert_eq!(
        (format!("{refusal}"), format!("{refusal:?}")),
        ("bundle_id".to_owned(), "BundleId".to_owned())
    );
}

#[test]
fn a_leaf_whose_key_names_another_curve_is_refused() {
    let root_key = KeyPair::generate_for(&PKCS_ECDSA_P384_SHA384).unwrap();
    let root_params = params(plain_name("Curve Root"), true, None);
    let root = root_params.self_signed(&root_key).unwrap();
    let intermediate_key = KeyPair::generate_for(&PKCS_ECDSA_P384_SHA384).unwrap();
    let intermediate_pkcs8 = intermediate_key.serialize_der();
    let intermediate_params = params(plain_name("Curve Intermediate"), true, Some(WWDR));
    let intermediate = intermediate_params
        .signed_by(&intermediate_key, &Issuer::new(root_params, root_key))
        .unwrap();
    let leaf_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
    let leaf = params(plain_name("Curve Leaf"), false, Some(RECEIPT_SIGNER))
        .signed_by(
            &leaf_key,
            &Issuer::new(intermediate_params, intermediate_key),
        )
        .unwrap();
    let parsed = X509Certificate::from_der(leaf.der()).unwrap().1;
    let p256_oid = [0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07];
    let mut tbs = parsed.tbs_certificate.as_ref().to_vec();
    let at = tbs
        .windows(p256_oid.len())
        .position(|window| window == p256_oid)
        .unwrap();
    tbs[at + 9] = 0x01;
    let signature = EcdsaKeyPair::from_pkcs8(
        &ring::signature::ECDSA_P384_SHA384_ASN1_SIGNING,
        &intermediate_pkcs8,
        &SystemRandom::new(),
    )
    .unwrap()
    .sign(&SystemRandom::new(), &tbs)
    .unwrap();
    let der_length = |length: usize| match length {
        0..=127 => vec![length as u8],
        128..=255 => vec![0x81, length as u8],
        _ => vec![0x82, (length >> 8) as u8, length as u8],
    };
    let algorithm = [
        0x30, 0x0A, 0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04, 0x03, 0x03,
    ];
    let mut bit_string = vec![0x03];
    bit_string.extend(der_length(signature.as_ref().len() + 1));
    bit_string.push(0);
    bit_string.extend(signature.as_ref());
    let mut body = tbs;
    body.extend(algorithm);
    body.extend(bit_string);
    let mut relabelled_leaf = vec![0x30];
    relabelled_leaf.extend(der_length(body.len()));
    relabelled_leaf.extend(body);
    let relabelled = X509Certificate::from_der(&relabelled_leaf).unwrap().1;
    assert_eq!(
        relabelled
            .public_key()
            .algorithm
            .parameters
            .as_ref()
            .unwrap()
            .as_oid()
            .unwrap()
            .to_id_string(),
        "1.2.840.10045.3.1.1"
    );

    let verified = verifier_trusting(&[root.der()]).verify_transaction(&jws(
        &[&relabelled_leaf, intermediate.der(), root.der()],
        &ring_key(&leaf_key),
        &transaction(NOW_MS, "Production", "works.windmill.app"),
    ));

    assert_eq!(verified.err(), Some(Refusal::Certificate));
}

#[test]
fn a_real_storekit_testing_transaction_is_refused_as_malformed() {
    let xcode =
        include_str!("../../../tests/fixtures/app_store/storekit-testing-transaction.jws").trim();
    let test_root = OwnChain::issue("Xcode");
    let trusting_a_test_root = SignedDataVerifier::new(
        &[&test_root.root],
        "com.example.naturelab.backyardbirds.example",
        || UNIX_EPOCH + Duration::from_millis(NOW_MS as u64),
    )
    .unwrap();

    let outcomes = [
        windmill().verify_transaction(xcode).err(),
        trusting_a_test_root.verify_transaction(xcode).err(),
    ];

    assert_eq!(outcomes, [Some(Refusal::Malformed); 2]);
}
