use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ring::signature::{self, EcdsaVerificationAlgorithm, UnparsedPublicKey};
use x509_parser::asn1_rs::{Oid, oid};
use x509_parser::certificate::X509Certificate;
use x509_parser::oid_registry::{
    OID_EC_P256, OID_KEY_TYPE_EC_PUBLIC_KEY, OID_NIST_EC_P384, OID_SIG_ECDSA_WITH_SHA256,
    OID_SIG_ECDSA_WITH_SHA384,
};
use x509_parser::prelude::FromDer;

use super::{InvalidRoots, Refusal};

const RECEIPT_SIGNER: Oid<'static> = oid!(1.2.840.113635.100.6.11.1);
const WWDR_INTERMEDIATE: Oid<'static> = oid!(1.2.840.113635.100.6.2.1);

static CERTIFICATE_SIGNATURES: [(Oid<'static>, Oid<'static>, &EcdsaVerificationAlgorithm); 4] = [
    (
        OID_SIG_ECDSA_WITH_SHA256,
        OID_EC_P256,
        &signature::ECDSA_P256_SHA256_ASN1,
    ),
    (
        OID_SIG_ECDSA_WITH_SHA384,
        OID_EC_P256,
        &signature::ECDSA_P256_SHA384_ASN1,
    ),
    (
        OID_SIG_ECDSA_WITH_SHA256,
        OID_NIST_EC_P384,
        &signature::ECDSA_P384_SHA256_ASN1,
    ),
    (
        OID_SIG_ECDSA_WITH_SHA384,
        OID_NIST_EC_P384,
        &signature::ECDSA_P384_SHA384_ASN1,
    ),
];

pub(super) struct TrustedRoots(Vec<Vec<u8>>);

impl TrustedRoots {
    pub(super) fn new(certificates: &[&[u8]]) -> Result<Self, InvalidRoots> {
        let usable = |der: &&[u8]| {
            parse(der).is_some_and(|root| {
                curve(&root).is_some_and(|root_curve| {
                    CERTIFICATE_SIGNATURES
                        .iter()
                        .any(|(_, curve, _)| *curve == root_curve)
                })
            })
        };
        if certificates.is_empty() || !certificates.iter().all(usable) {
            return Err(InvalidRoots);
        }
        Ok(Self(certificates.iter().map(|der| der.to_vec()).collect()))
    }

    pub(super) fn verify_chain(&self, x5c: &[String], signed_at: i64) -> Result<Vec<u8>, Refusal> {
        let [leaf, intermediate, _root] = x5c else {
            return Err(Refusal::ChainLength);
        };
        let leaf_der = STANDARD.decode(leaf).map_err(|_| Refusal::Certificate)?;
        let intermediate_der = STANDARD
            .decode(intermediate)
            .map_err(|_| Refusal::Certificate)?;
        let leaf = parse(&leaf_der).ok_or(Refusal::Certificate)?;
        let intermediate = parse(&intermediate_der).ok_or(Refusal::Certificate)?;
        if !curve(&leaf).is_some_and(|leaf_curve| leaf_curve == OID_EC_P256) {
            return Err(Refusal::Certificate);
        }

        let roots: Vec<X509Certificate> = self.0.iter().filter_map(|der| parse(der)).collect();
        let root = roots
            .iter()
            .find(|root| issued_by(&intermediate, root))
            .ok_or(Refusal::Untrusted)?;
        let intermediate_is_ca = matches!(
            intermediate.basic_constraints(),
            Ok(Some(constraints)) if constraints.value.ca
        );
        if !intermediate_is_ca || !issued_by(&leaf, &intermediate) {
            return Err(Refusal::Untrusted);
        }

        if !has_extension(&leaf, &RECEIPT_SIGNER)
            || !has_extension(&intermediate, &WWDR_INTERMEDIATE)
        {
            return Err(Refusal::AppleMarker);
        }

        let signed_at_seconds = signed_at.div_euclid(1000);
        let valid_when_signed = [&leaf, &intermediate, root].into_iter().all(|certificate| {
            let validity = certificate.validity();
            validity.not_before.timestamp() <= signed_at_seconds
                && signed_at_seconds <= validity.not_after.timestamp()
        });
        if !valid_when_signed {
            return Err(Refusal::Validity);
        }

        Ok(leaf.public_key().subject_public_key.data.to_vec())
    }
}

fn parse(der: &[u8]) -> Option<X509Certificate<'_>> {
    match X509Certificate::from_der(der) {
        Ok(([], certificate)) => Some(certificate),
        _ => None,
    }
}

fn curve<'a>(certificate: &'a X509Certificate) -> Option<Oid<'a>> {
    let key = &certificate.public_key().algorithm;
    if key.algorithm != OID_KEY_TYPE_EC_PUBLIC_KEY {
        return None;
    }
    key.parameters.as_ref()?.as_oid().ok()
}

fn issued_by(certificate: &X509Certificate, issuer: &X509Certificate) -> bool {
    let Some(issuer_curve) = curve(issuer) else {
        return false;
    };
    let Some((_, _, algorithm)) = CERTIFICATE_SIGNATURES.iter().find(|(signature, curve, _)| {
        *signature == certificate.signature_algorithm.algorithm && *curve == issuer_curve
    }) else {
        return false;
    };
    certificate.issuer().as_raw() == issuer.subject().as_raw()
        && UnparsedPublicKey::new(*algorithm, &issuer.public_key().subject_public_key.data)
            .verify(
                certificate.tbs_certificate.as_ref(),
                &certificate.signature_value.data,
            )
            .is_ok()
}

fn has_extension(certificate: &X509Certificate, oid: &Oid) -> bool {
    certificate
        .extensions()
        .iter()
        .any(|extension| extension.oid == *oid)
}
