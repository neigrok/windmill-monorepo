# Windmill subscription service — architecture

The service that owns every fact about a paid Windmill One subscription. Specification:
[subscriptions.md](../../docs/foundation/subscriptions.md). The repository's layout and its own
dependency rule are in [STRUCTURE.md](../../STRUCTURE.md); this file holds the service's.

The Rust workspace and its four crates exist. `domain` models the subscription and folds the stores'
observations into it ([Domain](#domain)); `app_store` verifies App Store signed payloads
([below](#app-store-signature-verification)) and decodes them into observations
([App Store decoding](#app-store-decoding)); `subscriptions`, the server binary, answers health on
both of its listeners, logs every request and reports to Sentry ([Server](#server)); `storage` is
empty. Nothing is deployed.

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

## Domain

`domain` holds every rule about a subscription's lifecycle, as pure functions of values: no I/O, no
clock, no randomness. Its files, by kind:

| File | Holds |
|---|---|
| `values.rs` | Instants (epoch milliseconds), spans, money, the text ids and the closed names: `Store`, `Environment`, `Plan` |
| `subscription.rs` | The record: `Subscription`, its `Status` as the newest observation stated it, a `State` that carries only its own facts, `Period`, and access (`access_until`, `grants_access`) |
| `observe.rs` | `Observation`, what a caller hands `observe`, the `Change` it returns, `Event` and `Refusal` |
| `entitlement.rs` | `AccountEntitlement`, one `Entitlement` block per environment, folded from the ledger alone |

The action that applies an observation calls `observe` once:

1. Load the lineage's `Ledger`: its subscription, if any, and its periods.
2. Resolve the observation's account hint against the erased accounts into an `AccountHint`, and pass
   the claim when a claim door calls.
3. Mint the observation's ids with `Observation::mint_ids`: a subscription id and one period id for
   each period it states. `observe` uses the ones it needs.
4. Persist the returned `Change` in one transaction: the subscription, each written or restated
   period, and the events in order, which the ledger stamps with `seq` and `recordedAt`. A `Refusal`
   persists nothing.
5. After the commit, write `hint_for_store`, when present, to the store as the account hint.

`verifiedAt` is the sweep's bookkeeping: storage stamps it when it applies a pull, and the domain's
subscription leaves it out, since no single observation can state it (INV-6).

`cancelRequestedAt` follows its own statements, as a period's refund time does. A statement that
renewal is on, or off since a stated instant, gives it; the newest such statement wins whatever the
order of arrival, renewal on outranking a turn-off stated at the same instant, and the subscription
keeps that statement's stamp as `cancellation_observed_at`. A statement that renewal is off without
saying since when, as most of the App Store's are, leaves the cancel time as it stands, and a turn-off
that arrives after a newer statement fills it in and records `updated`.

`observe` records `unbound` only when a new purchase moves an ended lineage to another account
(R-11). Account erasure (§6.4) unbinds every subscription an account holds and records `unbound` for
each; the domain has no step for it yet, and the erasure node adds one beside `observe`.

Known limits:

- A period from before an R-11 move that the ledger first hears of after it is recorded under the new
  account, since the domain keeps no history of bindings.
- An ended lineage never bound and bought again with a hint binds by the ordinary rule: at `startedAt`,
  with its earlier periods recorded again (INV-13).

`tests/vectors/` holds the lifecycle stories every implementation of the domain passes, and
`crates/domain/tests/vectors.rs` runs them. `crates/domain/tests/observe.rs` holds the property tests
of INV-4, INV-5 and INV-6 and one that replays the feed through §6.3's funding in any order.

## App Store signature verification

`app_store::verification::SignedDataVerifier` believes an App Store signed payload only when every
rule below holds. The payload can be a notification, the signed transaction and renewal info inside
it, or a signed transaction a phone hands to the claim door. A payload that breaks a rule is refused
with a `Refusal`, whose `code()` is the only thing a log line carries about it.

| # | Rule | Refusal code |
|---|---|---|
| 1 | Compact JWS whose header decodes as JSON | `malformed` |
| 2 | Header `alg` is `ES256` | `algorithm` |
| 3 | `signedDate` is no later than the clock's time plus 60 seconds; a payload stating none is taken as signed at the clock's time | `signed_in_future` |
| 4 | Header `x5c` holds exactly three certificates (leaf, intermediate, root) | `chain_length` |
| 5 | Leaf and intermediate are base64 DER certificates with nothing trailing, and the leaf's key is `id-ecPublicKey` on P-256 | `certificate` |
| 6 | A pinned root issued the intermediate, and the intermediate, a CA, issued the leaf: issuer name equals the issuer's subject, and the ECDSA signature (P-256 or P-384, SHA-256 or SHA-384) verifies under the issuer's key. `x5c[2]` is not read; the pinned root stands in its place | `untrusted_chain` |
| 7 | The leaf carries Apple's receipt-signing extension `1.2.840.113635.100.6.11.1`, the intermediate Apple's WWDR extension `1.2.840.113635.100.6.2.1` | `apple_marker` |
| 8 | Leaf, intermediate and root are each inside their validity at the signing time of rule 3 | `certificate_validity` |
| 9 | The ES256 signature verifies under the leaf's key | `signature` |
| 10 | The payload decodes into Apple's fields, with `environment` `Production` or `Sandbox`. `Xcode` and `LocalTesting` cannot be represented, so a payload stating them is refused here | `malformed` |
| 11 | `bundleId` is the expected one. A notification states it in `data`, `summary` or `appData`; a renewal info states none | `bundle_id` |
| 12 | A nested transaction or renewal info states its notification's environment | `environment` |

Rules 1 to 9 read nothing of the payload but `signedDate`. The decoded types are `Notification`,
`TransactionInfo` and `RenewalInfo`, and none implements `Debug`. Transaction ids and original
transaction ids are `TransactionId`, and the app account token is `AccountToken`. Neither type
implements `Debug` or `Display`; code reads them only through `expose()`, so no log line or panic
message can format one. A notification's UUID stays a plain string: it names a notification, not a
purchase or a person, and spec §5.1 keys the inbox by it.

Validity is judged at `signedDate`, and nothing checks revocation. A payload signed under a leaf
whose key had leaked could therefore be backdated into that leaf's validity. Each door must bound
the age of the payloads it accepts, and the claim door must re-read the subscription's state from the
App Store Server API rather than trust the transaction it is handed.

`SignedDataVerifier::windmill(clock)` is the production configuration: the pinned Apple root and the
bundle id `works.windmill.app`. `SignedDataVerifier::new(roots, bundle_id, clock)` takes other roots
and another bundle id; the tests in `crates/app_store/tests/` sign under chains they generate. No
verifier accepts `Xcode` or `LocalTesting` (spec §8).

### Where the rules come from

The rules follow Apple's App Store Server Library: Python `e5ffded5c`, Java `6bce52abe`, Node
`b71d9c70a`, Swift `d4a93113d`.

- Rules 4–8 follow Node `jws_verification.ts`: `verifyJWT`, `verifyCertificateChainWithoutCaching`
  and `checkDates`. The OIDs match Swift's `AppStoreOIDPolicy` in `ChainVerifier.swift` and Java's
  `AppleExtensionCertPathChecker.java`. The P-256 leaf key matches Swift's `ChainVerifier.verify`,
  which refuses a leaf whose key does not convert to `P256.Signing.PublicKey`.
- The date in rule 8 is what all four libraries use with online checks off:
  - Swift `ChainVerifier.verify` (`validationTime`)
  - Java `SignedDataVerifier.decodeSignedObject`
  - Python `SignedDataVerifier._decode_signed_object`
  - Node `verifyJWT`

  A payload signed while its leaf was valid therefore keeps verifying after the leaf expires. Validity
  bounds are inclusive and allow no clock skew, and they cover all three certificates, as Swift's
  `RFC5280Policy` checks them (`ExpiryPolicy.swift` in swift-certificates). Node allows 60 seconds
  either side.
- Rule 3 is this service's own: none of Apple's libraries refuses a future `signedDate`. Its
  60-second allowance is Node's `MAX_SKEW`.
- Rule 2 follows Swift's `EXPECTED_ALGORITHM`, Java's `decodeSignedObject` and Python's
  `_decode_signed_object`.
- Rules 10–12 follow `verifyAndDecodeNotification`, `verifyAndDecodeTransaction` and
  `verifyAndDecodeRenewalInfo` in each library.

Where this verifier differs from Apple's:

- **Online checks.** Apple's optional online mode adds OCSP and checks validity at the current time.
  This verifier makes no network call.
- **Environments.** It accepts both `Production` and `Sandbox`, where Apple's verifier takes exactly
  one. It therefore requires nested payloads to state their notification's environment, which a
  one-environment verifier guarantees by construction.
- **Xcode and LocalTesting.** For these environments Apple's libraries skip verification. Here they
  cannot be represented. A real StoreKit-testing payload is refused as `malformed` at rule 3, because
  its dates are fractional.
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

## App Store decoding

`app_store::decoding` is the one place Apple's vocabulary is translated; nothing behind it knows a
notification type. `decode(&Notification)` reads a verified notification, and
`decode_claim(&TransactionInfo)` a transaction a phone hands to the claim door. Both are pure: no
I/O, no clock. `decode` answers one `Decoded`:

| Outcome | What it holds | What the caller does |
|---|---|---|
| `Observation` | An `Observation` of the subscription's whole state, and the transaction's `appAccountToken` as an `AccountToken` | Resolves the token against the erased accounts into the `AccountHint`, then applies it with `observe` |
| `AwaitsStatus` | A `PeriodStatement`: the lineage, `observedAt`, ownership, the account token and the one period the transaction states | Pulls the subscription's status from the App Store Server API, then applies the period with its own stamp |
| `Silent` | `test` or `renewal_extension_summary`: Apple states nothing about any subscription | Logs the code |
| `Unsupported` | A code: what Windmill does not sell or a payload it cannot read | Keeps the notification in the inbox, logs `unsupported` with the code, reports it; nothing changes |

`decode_claim` answers a `PeriodStatement` stamped at the transaction's own `signedDate`, or
`Unsupported`; the claim door takes the state from a pull, never from the transaction (above).

Only the subscription's latest transaction states its state, and a transaction is the latest when
its `expiresDate` is the renewal info's `renewalDate`. A notification about another transaction, a
`REFUND`, `REVOKE` or `REFUND_REVERSED` of an earlier month, answers `AwaitsStatus` with that
transaction's period, refunded or not, so the state is pulled rather than inferred (spec §8).

### Types and subtypes

| `notificationType`, `subtype` | Outcome |
|---|---|
| `SUBSCRIBED` `INITIAL_BUY`, `RESUBSCRIBE`; `DID_RENEW`, `DID_RENEW` `BILLING_RECOVERY`; `DID_CHANGE_RENEWAL_PREF`, with `UPGRADE` or `DOWNGRADE`; `OFFER_REDEEMED`, with `UPGRADE` or `DOWNGRADE`; `DID_FAIL_TO_RENEW`, with `GRACE_PERIOD`; `GRACE_PERIOD_EXPIRED`; `EXPIRED`, with `VOLUNTARY`, `BILLING_RETRY`, `PRICE_INCREASE` or `PRODUCT_NOT_FOR_SALE`; `PRICE_INCREASE` `PENDING`, `ACCEPTED`; `REFUND`; `REFUND_REVERSED`; `REFUND_DECLINED`; `REVOKE`; `CONSUMPTION_REQUEST`; `RENEWAL_EXTENDED`; `RENEWAL_EXTENSION` `FAILURE` | The observation its data states, or `AwaitsStatus` |
| `DID_CHANGE_RENEWAL_STATUS`, with `AUTO_RENEW_ENABLED`, `AUTO_RENEW_DISABLED` or none | The same, and the cancel time |
| `TEST`; `RENEWAL_EXTENSION` `SUMMARY` | `Silent` |
| `DID_CHANGE_RENEWAL_PREF` `INCREASE_QUANTITY`, `DECREASE_QUANTITY`; `REFUND` `SEATS`; `UNCLAIM_SEATS` | `seats` |
| `ONE_TIME_CHARGE` | `one_time_charge` |
| `EXTERNAL_PURCHASE_TOKEN` `CREATED`, `ACTIVE_TOKEN_REMINDER`, `UNREPORTED` | `external_purchase` |
| `METADATA_UPDATE`, `MIGRATION`, `PRICE_CHANGE`, the Advanced Commerce API's | `advanced_commerce` |
| `RESCIND_CONSENT` | `parental_consent` |
| Any other type, or a subtype Apple does not document for its type | `unknown_type` |

A transaction can also make a mapped type unsupported: `one_time_charge` when its `type` is not
`Auto-Renewable Subscription`, `commitment_plan` when its `billingPlanType` is `MONTHLY`,
`unknown_product` for any product but Windmill One's. A payload that lacks what Apple documents for
it is `incomplete`; one that contradicts itself, a renewal info of another lineage, `inconsistent`;
one with a value Apple does not document (a status, ownership, offer or revocation type, a negative
price) `unknown_value`. An expiration intent Apple does not document is no such value: it reads as the
end reason `unknown`.

The verifier refuses `UNCLAIM_SEATS` and `EXTERNAL_PURCHASE_TOKEN` at rule 11, since neither carries
a `data` object, so neither reaches `decode` today and the door answers them 4xx.

### Fields

| Domain | From Apple |
|---|---|
| Lineage | `app_store`, the verified payload's `environment`, the transaction's `originalTransactionId` |
| `observedAt` | The notification's `signedDate`; for a claim, the transaction's |
| Ownership | `inAppOwnershipType`: `PURCHASED` is `purchased`; `FAMILY_SHARED` and `ASSIGNED` are `shared`, which binds to no one (§4) |
| Account hint | The transaction's `appAccountToken`, a candidate the caller resolves |
| `plan`, `billingInterval` | `productId` `works.windmill.app.one.monthly` is `windmill_one`, `P1M` |
| `productId`, `startedAt` | The transaction's `productId` and `originalPurchaseDate` |
| `currentPeriod`, and the period | `[purchaseDate, expiresDate)` of the transaction, keyed by its `transactionId`, at its price and offer |
| `state` | `status`: 1 `active`, 2 `expired`, 3 `on_hold`, 4 `grace`, 5 `revoked` |
| `paymentFailedAt` | The end of the period that did not renew |
| `graceEndsAt` | `gracePeriodExpiresDate` |
| `endedAt`, `endReason` in `expired` | The end of the last period; `expirationIntent` 1 `cancelled`, 2 `billing`, 3 `price_change_declined`, 4 `product_unavailable`, otherwise `unknown` |
| `endedAt`, `endReason` in `revoked` | `revocationDate`; `revocationType` `REFUND_FULL` or `REFUND_PRORATED` is `refunded`, `FAMILY_REVOKE` or `ASSIGNMENT_REVOKE` `sharing_removed`, and with none stated a purchase is `refunded` and a shared one `sharing_removed` |
| A period's `refundedAt` | `revocationDate` of a revocation that is `refunded`; none when the transaction states none, as after `REFUND_REVERSED` |
| `autoRenew` | `autoRenewStatus` 1 or 0 |
| `nextChargeAt`, `nextCharge` | The period's end; `renewalPrice` and the renewal info's `currency`. `observe` drops it unless the subscription is active and renewing |
| `nextProductId` | `autoRenewProductId` when it is not the transaction's `productId` |
| `cancelRequestedAt` | The `signedDate` of `DID_CHANGE_RENEWAL_STATUS` whose renewal info has renewal off. No other notification and no status pull says when, so they state none and the domain keeps the time ([Domain](#domain)) |
| `offerKind` | `offerType` 1 with `offerDiscountType` `FREE_TRIAL` is `free_trial`, with `PAY_AS_YOU_GO` or `PAY_UP_FRONT` `introductory`; 2 `promotional`; 3 `offer_code`; 4 `win_back`; 5, a retention offer, `promotional`, since the domain names no retention kind |
| `offerEndsAt` | The period's end, unless renewal is on and the renewal info states the same `offerType` for the next period, when it is not known yet |
| `price` | `price` in milliunits and `currency`, with two decimals and a third only when Apple states one: 12000 USD is `12.00`, 1800000 JPY `1800.00` |
| `storefront` | `storefront` |

An `expired` subscription ends with its last period in every statement of it, since Apple states no
instant for the end of billing retry; `paymentFailedAt` is that period's end for the same reason.

`Decoded` and `PeriodStatement` carry the account token as `AccountToken` and implement no `Debug`.
The crate logs nothing; the door logs the outcome's code.

The vectors in `tests/vectors/app_store/` pin one outcome for every type and subtype above, and for
each branch of the fields; `crates/app_store/tests/decoding.rs` runs them, and folds a cancel time
through the expiry that cannot state it.

### Waits on the sandbox

m3-verify-sandbox-lifecycle confirms these against payloads Apple signs:

- A renewal's `purchaseDate` is the previous period's end, not the instant Apple charged it (D-4).
  Should it be the charge, a period's start has to come from the previous transaction's
  `expiresDate`.
- A `REFUND` of an earlier month carries that month's transaction with its `revocationDate` and
  `status` 1, and a `REFUND` of the latest carries `status` 5.
- `renewalDate` equals the latest transaction's `expiresDate` to the millisecond, also after
  `RENEWAL_EXTENDED`, which states the extended `expiresDate` on the latest transaction. If it does
  not, every notification answers `AwaitsStatus`.
- The renewal info's `offerType` is the next renewal's offer.
- `revocationType` is stated on a refunded transaction.

### Where the mapping comes from

Apple's App Store Server Notifications reference, read on 2026-11-14:
[notificationType](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype),
[subtype](https://developer.apple.com/documentation/appstoreservernotifications/subtype),
[status](https://developer.apple.com/documentation/appstoreservernotifications/status),
[responseBodyV2DecodedPayload](https://developer.apple.com/documentation/appstoreservernotifications/responsebodyv2decodedpayload),
[data](https://developer.apple.com/documentation/appstoreservernotifications/data),
[JWSTransactionDecodedPayload](https://developer.apple.com/documentation/appstoreservernotifications/jwstransactiondecodedpayload),
[JWSRenewalInfoDecodedPayload](https://developer.apple.com/documentation/appstoreservernotifications/jwsrenewalinfodecodedpayload),
[expirationIntent](https://developer.apple.com/documentation/appstoreservernotifications/expirationintent),
[revocationType](https://developer.apple.com/documentation/appstoreservernotifications/revocationtype),
[inAppOwnershipType](https://developer.apple.com/documentation/appstoreservernotifications/inappownershiptype),
[offerType](https://developer.apple.com/documentation/appstoreservernotifications/offertype),
[offerDiscountType](https://developer.apple.com/documentation/appstoreservernotifications/offerdiscounttype),
[autoRenewStatus](https://developer.apple.com/documentation/appstoreservernotifications/autorenewstatus),
[billingPlanType](https://developer.apple.com/documentation/appstoreservernotifications/billingplantype),
[price](https://developer.apple.com/documentation/appstoreservernotifications/price),
[renewalPrice](https://developer.apple.com/documentation/appstoreservernotifications/renewalprice),
[renewalDate](https://developer.apple.com/documentation/appstoreservernotifications/renewaldate),
[gracePeriodExpiresDate](https://developer.apple.com/documentation/appstoreservernotifications/graceperiodexpiresdate),
[signedDate](https://developer.apple.com/documentation/appstoreservernotifications/signeddate).

## Server

`crates/server` holds three modules, `config`, `listeners` and `telemetry`, and the binary
`subscriptions`, whose `main.rs` reads the configuration, starts telemetry and serves both listeners
until a signal.

### Configuration

Read once at start. An empty value counts as unset. A missing required value, a malformed value or a
refused combination stops the start with exit code 1 and one log line naming the variable, never its
value.

| Variable | Required | Meaning |
|---|---|---|
| `SUBSCRIPTIONS_PUBLIC_ADDRESS` | yes | Socket address of the public listener, such as `0.0.0.0:8082` |
| `SUBSCRIPTIONS_INTERNAL_ADDRESS` | yes | Socket address of the internal listener, such as `0.0.0.0:8083` |
| `SENTRY_ENVIRONMENT` | yes | The deployment's name, such as `production`; Sentry files every report and log under it |
| `SENTRY_DSN` | no | Where Sentry reports go; unset turns Sentry off, logged once at start |
| `SENTRY_RELEASE` | no | The build's git sha, attached to every report |
| `WINDMILL_LOG_LEVEL` | no | The lowest level written to stdout: `trace`, `debug`, `info` (default), `warn`, `error` or `fatal`, in any case, the words the backend reads; `fatal` reads as `error` |
| `SENTRY_LOG_LEVEL` | no | The same words: the lowest level of the service's own lines sent to Sentry as Logs; default `info` |
| `SUBSCRIPTIONS_PANIC_ROUTE_ENABLED` | no | `true` adds `GET /debug/panic` to the internal listener; refused unless `SENTRY_ENVIRONMENT`, trimmed and in any case, is `local`, `development`, `test` or `ci` |

### Listeners

The image listens on 8082 (public) and 8083 (internal), beside the backend's 8080 and the embedder's
8081, and speaks HTTP/1.1. Each listener builds its own router, so a route on the internal listener
does not exist on the public one and answers 404 there.

| Listener | Route | Answer |
|---|---|---|
| public | `GET /health` | 200 `{"status":"ready"}` |
| internal | `GET /health` | 200 `{"status":"ready"}`; the image's `HEALTHCHECK` asks it |
| internal | `GET /debug/panic` | panics, only while `SUBSCRIPTIONS_PANIC_ROUTE_ENABLED` is `true` |

`listeners::Bounds` holds what a client may take on either listener:

| Bound | Value | Past it |
|---|---|---|
| request head | 5 s | the connection closes without an answer |
| request, body and handler | 5 s | 503 `{"error":"timeout"}` |
| request body | 64 KiB | 413, before any handler reads it |

A handler runs only while its client waits: a client that leaves cancels it. A door whose work must
outlive its request, such as the App Store notification door, spawns that work as a pipeline of its
own.

SIGTERM or SIGINT stops both listeners from accepting. Each open connection then finishes its request
within the bounds above, for at most 6 s; Sentry's last flush takes at most 1 s more and the send in
progress at most 2 s, so the process exits 0 inside Docker's 10 s, whether or not Sentry answers.

### Logs and Sentry

Every line on stdout is one JSON object. Each request writes one line when it ends: `listener`,
`method` (a method outside the standard nine is `other`), `route` (the route template, or
`unmatched`), `status`, `outcome`, `duration_ms` and `request_id`. `outcome` is `answered`,
`panicked`, `timed_out`, or `cancelled` when the client left first; a cancelled line has no `status`.
The line reads no header, body or raw path. A 5xx line is at `error`, a 4xx or cancelled line at
`warn`, a ready health answer at `debug` and anything else at `info`:

```json
{"timestamp":"2026-11-14T10:58:01.163207Z","level":"ERROR","message":"request","listener":"internal","method":"GET","route":"/debug/panic","status":500,"outcome":"panicked","duration_ms":4.3,"request_id":"8244ce4ef07341ff85532a1d8dfc7cf9"}
```

Lines from every crate of the workspace (`telemetry::SERVICE_CRATES`) also go to Sentry as Logs; a
vendor's lines stay on stdout. A line at `error` creates no Issue. Issues come from explicit
reports: a panic after start is reported with its location and stack and without its message, and
logged as `panic` with the event's `sentry_event_id` (absent while Sentry is off). The stack ends at
the panicking frame, and the service's crates are its in-app frames. A panic inside a request also
carries that request's span in its line and its `listener`, `route` and `request_id` as tags, and the
request answers 500 `{"error":"internal"}` while the listener keeps answering.

### Run

```sh
SUBSCRIPTIONS_PUBLIC_ADDRESS=127.0.0.1:8082 SUBSCRIPTIONS_INTERNAL_ADDRESS=127.0.0.1:8083 \
  SENTRY_ENVIRONMENT=local cargo run --bin subscriptions
```

The image builds from this directory and sets both addresses itself:

```sh
docker build --build-arg SENTRY_RELEASE="$(git rev-parse HEAD)" -t windmill-subscriptions .
docker run --rm -p 8082:8082 -p 8083:8083 -e SENTRY_ENVIRONMENT=local windmill-subscriptions
```

## Toolchain

`rust-toolchain.toml` pins Rust 1.99.1 with rustfmt and Clippy; `rustup toolchain install`, run in
this directory, installs it. `Cargo.lock` is committed, and Clippy and the tests run with `--locked`.
The `Dockerfile` builds on the `rust` image of the same release and fails when the two differ.

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

A second job builds the image and runs it twice. First it must become healthy, answer ready on both
listeners, answer 404 for an internal path on the public port and exit 0 on SIGTERM. Then, with a
Sentry that accepts and never answers and three panics waiting to send, `docker stop` must exit 0
within 10 s.
