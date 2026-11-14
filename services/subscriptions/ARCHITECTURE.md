# Windmill subscription service — architecture

The service that owns every fact about a paid Windmill One subscription. Specification:
[subscriptions.md](../../docs/foundation/subscriptions.md). The repository's layout and its own
dependency rule are in [STRUCTURE.md](../../STRUCTURE.md); this file holds the service's.

The Rust workspace and its four crates exist. `app_store` verifies App Store signed payloads (below);
the other three crates are empty. Nothing runs and nothing is deployed: `subscriptions`, the server
binary, exits at once.

## Crates

| Crate | What it is for (spec §9) |
|---|---|
| `domain` | D-1…D-9, `observe`, `grantsAccess` and the entitlement fold; no I/O, no async |
| `app_store` | signature verification, notification and transaction decoding into observations, the App Store Server API client |
| `storage` | Postgres: the inbox, subscriptions, periods, events and the feed read |
| `server` | the composition root, built as the binary `subscriptions`: both listeners, the sweep, configuration |

Every crate inherits `[workspace.lints]`, which forbids `unsafe` code.

## Dependency rule

- `domain` depends on no crate at all. The only exceptions are its dev-dependencies, which build
  tests and never the service, and the crates named in `DOMAIN_ALLOWED_CRATES` at the top of
  `check-dependencies.sh`, which is empty. An I/O library cannot reach the domain without a
  reviewed change to that line.
- `app_store` and `storage` depend on `domain` and not on each other. A later store is one more crate
  beside `app_store`, with the same edges.
- `server` depends on `domain`, `app_store` and `storage`.

`check-dependencies.sh` reads `cargo metadata` and fails, naming each offending edge, when a normal
or build dependency between the crates is not one of the five edges above, or when `domain` has a
normal or build dependency outside its allowlist.

## App Store signature verification

`app_store::verification::SignedDataVerifier` believes an App Store signed payload only when every
rule below holds. The payload can be a notification, the signed transaction and renewal info inside
it, or a signed transaction a phone hands to the claim door. A payload that breaks a rule is refused
with a `Refusal`, whose `code()` is the only thing a log line carries about it.

| # | Rule | Refusal code |
|---|---|---|
| 1 | Compact JWS; header and payload decode as JSON of Apple's shape | `malformed` |
| 2 | Header `alg` is `ES256` | `algorithm` |
| 3 | Header `x5c` holds exactly three certificates (leaf, intermediate, root) | `chain_length` |
| 4 | Leaf and intermediate are base64 DER certificates with nothing trailing | `certificate` |
| 5 | A pinned root issued the intermediate, and the intermediate, a CA, issued the leaf: issuer name equals the issuer's subject, and the ECDSA signature (P-256 or P-384, SHA-256 or SHA-384) verifies under the issuer's key. `x5c[2]` is not read; the pinned root stands in its place | `untrusted_chain` |
| 6 | The leaf carries Apple's receipt-signing extension `1.2.840.113635.100.6.11.1`, the intermediate Apple's WWDR extension `1.2.840.113635.100.6.2.1` | `apple_marker` |
| 7 | Leaf, intermediate and root are each inside their validity at the payload's `signedDate`, or at the clock's time when the payload states none | `certificate_validity` |
| 8 | The ES256 signature verifies under the leaf's P-256 key | `signature` |
| 9 | `bundleId` is the expected one. A notification states it in `data`, `summary` or `appData`; a renewal info states none | `bundle_id` |
| 10 | `environment` is one the verifier accepts, and a nested transaction or renewal info states its notification's environment | `environment` |

Only then is the payload decoded into Apple's fields: `Notification`, `TransactionInfo` and
`RenewalInfo`. These types implement no `Debug`, so no log line or panic message can format a
transaction id or an account token.

`SignedDataVerifier::windmill(clock)` is the production configuration: the pinned Apple root, the
bundle id `works.windmill.app`, and the environments `Production` and `Sandbox`.
`SignedDataVerifier::new(roots, environments, bundle_id, clock)` takes any of them; the tests in
`crates/app_store/tests/verification.rs` sign under a chain they generate. Only a verifier built
with `new` and a test root accepts `Xcode` or `LocalTesting` (spec §8).

### Where the rules come from

The rules follow Apple's App Store Server Library: Python `e5ffded5c`, Java `6bce52abe`, Node
`b71d9c70a`, Swift `d4a93113d`.

- Rules 3–7 follow Node `jws_verification.ts`: `verifyJWT`, `verifyCertificateChainWithoutCaching`
  and `checkDates`. The OIDs match Swift's `AppStoreOIDPolicy` in `ChainVerifier.swift` and Java's
  `AppleExtensionCertPathChecker.java`.
- The date in rule 7 is what all four libraries use with online checks off:
  - Swift `ChainVerifier.verify` (`validationTime`)
  - Java `SignedDataVerifier.decodeSignedObject`
  - Python `SignedDataVerifier._decode_signed_object`
  - Node `verifyJWT`

  A payload signed while its leaf was valid therefore keeps verifying after the leaf expires. Validity
  bounds are inclusive and allow no clock skew, and they cover all three certificates, as Swift's
  `RFC5280Policy` checks them (`ExpiryPolicy.swift` in swift-certificates). Node allows 60 seconds
  either side.
- Rule 2 follows Swift's `EXPECTED_ALGORITHM`, Java's `decodeSignedObject` and Python's
  `_decode_signed_object`.
- Rules 9–10 follow `verifyAndDecodeNotification`, `verifyAndDecodeTransaction` and
  `verifyAndDecodeRenewalInfo` in each library.

Where this verifier differs from Apple's:

- **Online checks.** Apple's optional online mode adds OCSP and checks validity at the current time.
  This verifier makes no network call.
- **Environments.** It accepts a set of environments where Apple's verifier takes exactly one. It
  therefore requires nested payloads to state their notification's environment, which a
  one-environment verifier guarantees by construction.
- **Xcode and LocalTesting.** For these environments Apple's libraries skip verification. This
  verifier always verifies the chain. A real StoreKit-testing payload carries one self-signed
  certificate, so it is refused with `chain_length`.
- **App Apple ID.** It does not compare `appAppleId`, which Apple's libraries check on production
  notifications. The bundle id, under Apple's signature, already names the app.
- **External purchase.** A notification carrying only `externalPurchaseToken` is refused with
  `bundle_id`. That notification belongs to the External Purchase API, which Windmill does not use.

### The pinned root

`crates/app_store/roots/AppleRootCA-G3.cer` is Apple Root CA - G3: an ECDSA P-384 root, serial
`2DC5FC88D2C54B95`, valid 2014-04-30 to 2039-04-30, SHA-256
`63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179`. That fingerprint was checked
against three sources:

- the certificate downloaded from [Apple PKI](https://www.apple.com/certificateauthority/), which
  publishes no fingerprints;
- Apple's [list of root certificates in iOS 26 and macOS 26](https://support.apple.com/en-eg/126047),
  trust store 2025082000;
- the macOS system root keychain.

The test `the_pinned_root_is_apple_root_ca_g3` pins the file's bytes to that fingerprint. Apple's
App Store signing intermediate, WWDR G6, is issued by G3. Apple's other roots, G2 and Apple Inc. Root,
are RSA, and this verifier checks only ECDSA chains, so they are not pinned.

### Why it is built here

It runs on crates whose job is narrow:

- `x509-parser` parses the certificates;
- `ring` checks every certificate and payload signature;
- `base64` and `serde_json` decode the payload.

The chain is fixed at three certificates, so the verifier needs no path building and can be read
whole. `ring` was in scope of Cure53's 2020 audit of ring, webpki and rustls. RustCrypto's `p256`
and `p384` state that they have never been independently audited.

The community crate `app-store-server-library` was not used. It ports Apple's libraries faithfully,
but it validates the chain with `x509-validator`, a crate its author first published in 2026 that
has no audit. The check this service rests on would sit in that crate. It also brings an App Store
Server API client, `chrono`, `serde_with` and `uuid`, which the verifier does not need.

## Toolchain

`rust-toolchain.toml` pins Rust 1.99.1 with rustfmt and Clippy; `rustup toolchain install`, run in
this directory, installs it. `Cargo.lock` is committed, and Clippy and the tests run with `--locked`.

## Checks

`.github/workflows/subscriptions.yml` runs these on every change under `services/subscriptions/`
other than Markdown, and on changes to the workflow. Locally, from `services/subscriptions/`:

```sh
./check-dependencies.sh
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

`check-dependencies.sh` needs `jq` and runs from any directory.
