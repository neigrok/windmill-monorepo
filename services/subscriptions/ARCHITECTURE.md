# Windmill subscription service — architecture

The service that owns every fact about a paid Windmill One subscription. Specification:
[subscriptions.md](../../docs/foundation/subscriptions.md). The repository's layout and its own
dependency rule are in [STRUCTURE.md](../../STRUCTURE.md); this file holds the service's.

The Rust workspace, its four crates and one tool exist. `domain` models the subscription and folds
the stores' observations into it ([Domain](#domain)); `app_store` verifies App Store signed payloads
([below](#app-store-signature-verification)), decodes them into observations
([App Store decoding](#app-store-decoding)) and calls the App Store Server API
([App Store Server API](#app-store-server-api)), and the tool `app_store_test_signer` signs them under a
chain only tests trust ([App Store test signer](#app-store-test-signer)); `storage` keeps the ledger,
the service's own database: it migrates it, keeps what the stores sent, applies observations in one
transaction each and reads the feed and each account ([Storage](#storage)); `subscriptions`, the server
binary, opens the ledger before it listens, answers health on both of its listeners, keeps and applies the
App Store's notifications on its public one, serves the backend the feed, the account read, the claim, the
refresh and an account's erasure behind a bearer secret on its internal one, applies every minute what the inbox holds unsettled and
writes the hints claims owe the App Store, logs every request and reports to Sentry ([Server](#server)).
In production the public listener answers `GET /health` and the App Store notification door, and 404s
every other path; no App Store Connect setting sends notifications to the door yet, and no deployment holds
the in-app purchase key the claim and the refresh need, so both answer 503 there. Backend CI publishes
its image beside the server's; every deploy provisions its database and brings the service up, on a
new image only when the commit changes what it is built from
([deploy README](../../backend/deploy/README.md#the-subscription-service)).

## Crates

| Crate | What it is for (spec §9) |
|---|---|
| `domain` | D-1…D-9, `observe`, `erase`, `grantsAccess` and the entitlement fold; no I/O, no async |
| `app_store` | signature verification, notification and transaction decoding into observations, the App Store Server API client |
| `storage` | Postgres: the inbox, subscriptions, periods, events and the feed read |
| `server` | the composition root, built as the binary `subscriptions`: both listeners, the sweep, configuration |

`crates/` holds the service and nothing else. `tools/` holds the workspace's other crates, which the
service never runs: `app_store_test_signer` ([below](#app-store-test-signer)). Every crate inherits
`[workspace.lints]`, which forbids `unsafe` code.

## Dependency rule

- `domain` depends on no crate at all. The only exceptions are its dev-dependencies, which build
  tests and never the service, and the crates named in `DOMAIN_ALLOWED_CRATES` at the top of
  `check-dependencies.sh`, which is empty. An I/O library cannot reach the domain without a
  reviewed change to that line.
- `app_store` and `storage` depend on `domain` and not on each other. A later store is one more crate
  beside `app_store`, with the same edges.
- `server` depends on `domain`, `app_store` and `storage`.
- `app_store_test_signer` depends on no crate of the workspace, and no crate depends on it but
  through dev-dependencies, so no build of `subscriptions` contains it.

`check-dependencies.sh` reads `cargo metadata` and fails, naming each offending edge, when a normal
or build dependency between the crates is not one of the five edges above, or when `domain` has a
normal or build dependency outside its allowlist. It also fails when `serde_json` resolves with other
features in the binary (`cargo tree -p server -e features,normal`) than in the workspace's tests
(`cargo tree --workspace -e features`): a dev-dependency's feature reaches every test build, so a body the
binary writes in one key order would pass tests that write it in another. The server's own `serde_json` takes
`preserve_order`, so a body keeps the order it is written in.

## Domain

`domain` holds every rule about a subscription's lifecycle, as pure functions of values: no I/O, no
clock, no randomness. Its files, by kind:

| File | Holds |
|---|---|
| `values.rs` | Instants (epoch milliseconds), spans, money, the text ids and the closed names: `Store`, `Environment`, `Plan`. `Money::from_units` writes an amount a store counts in units (Apple's milliunits) with its currency's ISO 4217 minor units, keeping any digit beyond them. A store's ids, `StoreSubscriptionId` and `StoreTransactionId`, and `AccountId`, the account a store's hint names, print as `(redacted)` in `Debug`, so no log line or panic message formats one (spec §10) |
| `subscription.rs` | The record: `Subscription`, its `Status` as the newest observation stated it, a `State` that carries only its own facts, `Period` and whom its events are told under once its binding moved on (`LeftWith`), and access (`access_until`, `grants_access`) |
| `observe.rs` | `Observation`, what a caller hands `observe`, the `Change` it returns, `Event` and `Refusal` |
| `erasure.rs` | `erase`, the domain's step for an account's erasure (§6.4), for one lineage, returning a `Change` as `observe` does |
| `entitlement.rs` | `AccountEntitlement`, one `Entitlement` block per environment, folded from the ledger alone, and the subscriptions it carries: each environment's governing one and its others, which fold into the same entitlement again |

The action that applies an observation, `storage`'s apply ([Writing](#writing)), calls `observe` once:

1. Load the lineage's `Ledger`: its subscription, if any, and its periods.
2. Resolve the observation's account hint against the erased accounts into an `AccountHint`, and pass
   the claim when a claim door calls.
3. Mint the observation's ids with `Observation::mint_ids`: a subscription id and one period id for
   each period it states. `observe` uses the ones it needs.
4. Persist the returned `Change` in one transaction: the subscription, each written or restated
   period, the events in order, which the ledger stamps with `seq` and `recordedAt`, and
   `hint_for_store`, when present, as a hint the ledger owes the store. A `Refusal` persists nothing.
5. After the commit, the sweep writes each owed hint to its store and clears it ([The sweep](#the-sweep)).

`verifiedAt` is the sweep's bookkeeping: storage stamps it when it applies a pull, and the domain's
subscription leaves it out, since no single observation can state it (INV-6).

`cancelRequestedAt` follows its own statements, as a period's refund time does. A statement that
renewal is on, or off since a stated instant, gives it; the newest such statement wins whatever the
order of arrival, renewal on outranking a turn-off stated at the same instant, and the subscription
keeps that statement's stamp as `cancellation_observed_at`. Statements stamped alike therefore order
by their content with the cancel time aside (INV-6). A statement that renewal is off without
saying since when, as most of the App Store's are, leaves the cancel time as it stands, and a turn-off
that arrives after a newer statement fills it in and records `updated`.

A period's `left_with` says whom its events are told under once its subscription's binding moved on
without it; a period without one follows the binding. `observe` records `unbound` only when a new
purchase moves an ended lineage to another account (R-11): that move leaves each period the ledger holds
with the account that paid for it, `LeftWith::Account`, so a later event of the period, as its refund, is
told under that account. A claim by an erased account, resolved by the caller as `Claimant::Erased`, is
refused with `account_erased` before any other rule of §4.

`erase(ledger, account, at)` is the step for an account's erasure (§6.4), for one lineage. A subscription
bound to the account is unbound and records `unbound` under it at the erasure's instant; every period the
account held or paid for, the one a move left with it too, is restated `LeftWith::NoOne`, so no later
event of it names an account. It answers `None` when the lineage holds nothing of the account, as on an
erasure repeated. A binding of an unbound subscription records again only the periods that follow it
(INV-13): one left with an account or with no one stays theirs, so an account that claims an erased
account's subscription (R-9) is told the periods paid since the erasure and none before.

Known limits:

- A period from before an R-11 move that the ledger first hears of after it is recorded under the new
  account, since the domain keeps no history of bindings.
- An ended lineage that is unbound, never bound or unbound by an erasure, and bought again with a hint
  binds by the ordinary rule: at `startedAt`, with the earlier periods that follow its binding recorded
  again (INV-13).

`tests/vectors/` holds the lifecycle stories every implementation of the domain passes, observations and
erasures, and `crates/domain/tests/vectors.rs` runs them. `crates/domain/tests/observe.rs` holds the property tests
of INV-4, INV-5 and INV-6 and one that replays the feed through §6.3's funding in any order;
`crates/domain/tests/entitlement.rs` those of the fold: an entitlement folded again over the subscriptions it
carries is the same, and it carries every subscription in force and one governing one for each environment.

## App Store signature verification

`app_store::verification::SignedDataVerifier` believes an App Store signed payload only when every
rule below holds. The payload can be a notification, the signed transaction and renewal info inside
it, a signed transaction a phone hands to the claim door, or the transaction and renewal info of a status the
App Store Server API answers a pull with. A payload that breaks a rule is refused
with a `Refusal`, whose `code()` is the only thing a log line carries about it.

| # | Rule | Refusal code |
|---|---|---|
| 1 | Compact JWS whose header decodes as JSON | `malformed` |
| 2 | Header `alg` is `ES256` | `algorithm` |
| 3 | `signedDate` is no later than the clock's time plus 60 seconds; a payload stating none is taken as signed at the clock's time. It is read here and judged once rule 9 holds | `signed_in_future` |
| 4 | Header `x5c` holds exactly three certificates (leaf, intermediate, root) | `chain_length` |
| 5 | Leaf and intermediate are base64 DER certificates with nothing trailing, and the leaf's key is `id-ecPublicKey` on P-256 | `certificate` |
| 6 | A pinned root issued the intermediate, and the intermediate, a CA, issued the leaf: issuer name equals the issuer's subject, and the ECDSA signature (P-256 or P-384, SHA-256 or SHA-384) verifies under the issuer's key. `x5c[2]` is not read; the pinned root stands in its place | `untrusted_chain` |
| 7 | The leaf carries Apple's receipt-signing extension `1.2.840.113635.100.6.11.1`, the intermediate Apple's WWDR extension `1.2.840.113635.100.6.2.1` | `apple_marker` |
| 8 | Leaf, intermediate and root are each inside their validity at the signing time of rule 3 | `certificate_validity` |
| 9 | The ES256 signature verifies under the leaf's key | `signature` |
| 10 | The payload decodes into Apple's fields, with `environment` `Production` or `Sandbox`. `Xcode` and `LocalTesting` cannot be represented, so a payload stating them is refused here | `malformed` |
| 11 | `bundleId` is the expected one. A notification states it, with its environment, in `data`, `summary`, `appData` or `unclaimInfo`, or in `externalPurchaseToken`, whose environment is `Sandbox` when its `externalPurchaseId` starts with `SANDBOX` and `Production` otherwise; a renewal info states none | `bundle_id` |
| 12 | A nested transaction or renewal info states its notification's environment | `environment` |

Rules 1 to 9 read nothing of the payload but `signedDate`. `Refusal::after_signature` says whether a
refusal came once the signature held, so that the store signed what it refuses: true of rules 3, 11 and
12. The decoded types are `Notification`,
`TransactionInfo` and `RenewalInfo`, and none implements `Debug`. Transaction ids and original
transaction ids are `TransactionId`, and the app account token is `AccountToken`. Neither type
implements `Debug` or `Display`; code reads them only through `expose()`, so no log line or panic
message can format one. A notification's UUID stays a plain string: it names a notification, not a
purchase or a person, and spec §5.1 keys the inbox by it.

Validity is judged at `signedDate`, and nothing checks revocation. A payload signed under a leaf
whose key had leaked could therefore be backdated into that leaf's validity. The notification door
refuses a `signedDate` older than eight days ([below](#the-app-store-notification-door)), and the claim
door reads the subscription's state from the App Store Server API rather than trust the transaction it is
handed ([The claim and refresh doors](#the-claim-and-refresh-doors)).

`verify_status(environment, signed)` verifies a pulled entry, a `server_api::SignedStatus`, into a
`SubscriptionStatus`: its transaction by rules 1 to 11, its renewal info by rules 1 to 10, and both stating
the environment asked for, or `environment` (rule 12). Apple's answer around the entry is not signed, so
`SubscriptionStatus` carries only what the two payloads and the entry's `status` say.

`SignedDataVerifier::windmill(clock)` is the production configuration: the pinned Apple root and the
bundle id `works.windmill.app`. `SignedDataVerifier::windmill_also_trusting(test_root, clock)` adds one
root, which the server takes only in a test deployment ([Configuration](#configuration)).
`SignedDataVerifier::new(roots, bundle_id, clock)` takes other roots and another bundle id; the tests in `crates/app_store/tests/` sign under chains they generate, and
`app_store_test_signer` signs under the committed test chain ([below](#app-store-test-signer)). No
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
  `verifyAndDecodeRenewalInfo` in each library, the external purchase token's environment included.
  `unclaimInfo` is newer than those commits; it is read as Apple's
  [unclaimInfo](https://developer.apple.com/documentation/appstoreservernotifications/unclaiminfo)
  page shows it, with its own `bundleId` and `environment`.

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
notification type. `decode(&Notification)` reads a verified notification,
`decode_claim(&TransactionInfo)` a transaction a phone hands to the claim door, and
`decode_status(&SubscriptionStatus)` a status a pull reads. All three are pure: no I/O, no clock.
`decode` answers one `Decoded`:

| Outcome | What it holds | What the caller does |
|---|---|---|
| `Observation` | An `Observation` of the subscription's whole state, and the transaction's `appAccountToken` as an `AccountToken` | Resolves the token against the erased accounts into the `AccountHint`, then applies it with `observe` |
| `AwaitsStatus` | A `PeriodStatement`: the lineage, `observedAt`, ownership, the account token, the one period the transaction states, and the cancel time when the notification states one; and why, an `Awaiting` | Keeps the notification unsettled, postponed an hour at a time, for a pull of the subscription's status to give its state and then apply the period, and the cancel time, with the notification's own stamp; the door pulls no status for a notification yet. `latest_unconfirmed` is also reported to Sentry |
| `Silent` | `test` or `renewal_extension_summary`: Apple states nothing about any subscription | Settles the notification with the code and logs it |
| `Unsupported` | A code: what Windmill does not sell, or a field that decides access or money it cannot read | Keeps the notification in the inbox settled with the code, logs `unsupported` with it, reports it; nothing changes |

`decode_claim` answers a `PeriodStatement` stamped at the transaction's own `signedDate`, or
`Unsupported`; the claim door takes only the lineage from it, and the state from a pull (above).

`decode_status` reads a pulled status as the notifications that concern the latest transaction are read
(`SUBSCRIBED` and its row below): Apple's status holds the subscription's latest transaction by definition.
Its `observedAt` is the earlier of the transaction's and the renewal info's `signedDate`, the instants Apple
signed them in answering, and a status stating neither is `incomplete`. One whose transaction the renewal
info does not confirm as the latest answers `AwaitsStatus` with `latest_unconfirmed`, which the door takes
as a pull that failed.

Only the subscription's latest transaction states its state, and a transaction is the latest when
its `expiresDate` is the renewal info's `renewalDate`. When it is not, the outcome is `AwaitsStatus`,
so the state is pulled rather than inferred (spec §8):

| `Awaiting` | When |
|---|---|
| `earlier_transaction` | A type that may concern any transaction (`REFUND`, `REFUND_REVERSED`, `REVOKE` and the rest of the first row below) carries one that expires before the `renewalDate`, as a refund of an earlier month |
| `latest_unconfirmed` | Anything else that fails the test: a type whose transaction is the latest by Apple's definition (`SUBSCRIBED`, `DID_RENEW`, `DID_FAIL_TO_RENEW`, `GRACE_PERIOD_EXPIRED`, `EXPIRED`, `DID_CHANGE_RENEWAL_STATUS`, `RENEWAL_EXTENDED`), a transaction that expires after the `renewalDate`, or a renewal info without `renewalDate` or missing whole. It means Apple's payload broke the rule the adapter rests on, so the door reports it |

### Types and subtypes

| `notificationType`, `subtype` | Outcome |
|---|---|
| `SUBSCRIBED` `INITIAL_BUY`, `RESUBSCRIBE`; `DID_RENEW`, `DID_RENEW` `BILLING_RECOVERY`; `DID_CHANGE_RENEWAL_PREF`, with `UPGRADE` or `DOWNGRADE`; `OFFER_REDEEMED`, with `UPGRADE` or `DOWNGRADE`; `DID_FAIL_TO_RENEW`, with `GRACE_PERIOD`; `GRACE_PERIOD_EXPIRED`; `EXPIRED`, with `VOLUNTARY`, `BILLING_RETRY`, `PRICE_INCREASE` or `PRODUCT_NOT_FOR_SALE`; `PRICE_INCREASE` `PENDING`, `ACCEPTED`; `REFUND_DECLINED`; `REVOKE`; `CONSUMPTION_REQUEST`; `RENEWAL_EXTENDED`; `RENEWAL_EXTENSION` `FAILURE` | The observation its data states, or `AwaitsStatus` |
| `DID_CHANGE_RENEWAL_STATUS`, with `AUTO_RENEW_ENABLED`, `AUTO_RENEW_DISABLED` or none | The same, and the cancel time |
| `REFUND` | The same, its transaction refunded |
| `REFUND_REVERSED` | The same, its transaction's refund cleared |
| `TEST`; `RENEWAL_EXTENSION` `SUMMARY` | `Silent` |
| `DID_CHANGE_RENEWAL_PREF` `INCREASE_QUANTITY`, `DECREASE_QUANTITY`; `REFUND` `SEATS`; `UNCLAIM_SEATS` | `seats` |
| `ONE_TIME_CHARGE` | `one_time_charge` |
| `EXTERNAL_PURCHASE_TOKEN` `CREATED`, `ACTIVE_TOKEN_REMINDER`, `UNREPORTED` | `external_purchase` |
| `METADATA_UPDATE`, `MIGRATION`, `PRICE_CHANGE`, the Advanced Commerce API's | `advanced_commerce` |
| `RESCIND_CONSENT` | `parental_consent` |
| Any other type, or a subtype Apple does not document for its type | `unknown_type` |

A transaction can also make a mapped type unsupported, for what Windmill does not sell:
`one_time_charge` when its `type` is a consumable, a non-consumable or a non-renewing subscription,
`commitment_plan` when its `billingPlanType` is `MONTHLY`, `unknown_product` for any product but
Windmill One's.

### What refuses and what degrades

State and access are decided only by the fields that decide them, and only those can make a mapped
notification unsupported: `incomplete` when the notification's `signedDate`, its transaction, the
transaction's `expiresDate`, `price` or `currency`, the `status`, the `autoRenewStatus`, or the
`gracePeriodExpiresDate` of a grace is missing; `unknown_value` when the status or `autoRenewStatus`
is a value Apple does not document, the price is negative or the currency no ISO 4217 code in any
case; `inconsistent` when the renewal info is another lineage's; and `incomplete` also when the
`originalTransactionId` or the `transactionId` holds NUL, which no text the ledger keeps can hold.
Every other field degrades, so a refund or an expiry is never dropped for a field access does not
depend on:

| Field Apple leaves out or names in a way it does not document | Reads as |
|---|---|
| `inAppOwnershipType` | `shared`, which binds to no one: only a purchase its buyer is shown to own binds (§4) |
| `type` | Nothing: Windmill One's product id says what was sold |
| `billingPlanType` other than `MONTHLY` | Nothing |
| `originalPurchaseDate` | `startedAt` is the transaction's `purchaseDate` |
| `storefront`, or one holding NUL | `storefront` null |
| `autoRenewProductId` holding NUL | `nextProductId` null |
| `renewalPrice` or the renewal info's `currency`, or an amount they do not make | `nextCharge` null |
| `offerType`, or `offerType` 1 without `offerDiscountType` | No offer kind |
| `revocationType` Apple does not document (one left out reads by ownership, below) | End reason `unknown`; the period is refunded only by a `REFUND` |
| `revocationDate` of a status 5 | Ended, and for a `REFUND` refunded, at the notification's `signedDate`, the latest the refund can have happened |
| `expirationIntent` | The `EXPIRED` subtype's reason, else `unknown` |

### Fields

| Domain | From Apple |
|---|---|
| Lineage | `app_store`, the verified payload's `environment`, the transaction's `originalTransactionId` |
| `observedAt` | The notification's `signedDate`; for a claim, the transaction's |
| Ownership | `inAppOwnershipType` `PURCHASED` is `purchased`; anything else, `FAMILY_SHARED` and `ASSIGNED` among them, `shared` |
| Account hint | The transaction's `appAccountToken`, a candidate the caller resolves |
| `plan`, `billingInterval` | `productId` `works.windmill.app.one.monthly` is `windmill_one`, `P1M` |
| `productId`, `startedAt` | The transaction's `productId` and `originalPurchaseDate` |
| `currentPeriod`, and the period | `[purchaseDate, expiresDate)` of the transaction, keyed by its `transactionId`, at its price and offer |
| `state` | `status`: 1 `active`, 2 `expired`, 3 `on_hold`, 4 `grace`, 5 `revoked` |
| `paymentFailedAt` | The end of the period that did not renew |
| `graceEndsAt` | `gracePeriodExpiresDate` |
| `endedAt`, `endReason` in `expired` | The end of the last period; `expirationIntent` 1 `cancelled`, 2 `billing`, 3 `price_change_declined`, 4 `product_unavailable`, 5 `unknown` |
| `endedAt`, `endReason` in `revoked` | `revocationDate`; `revocationType` `REFUND_FULL` or `REFUND_PRORATED` is `refunded`, `FAMILY_REVOKE` or `ASSIGNMENT_REVOKE` `sharing_removed`, and with none stated a purchase is `refunded` and a shared one `sharing_removed` |
| A period's `refundedAt` | Set by a `REFUND`, cleared by a `REFUND_REVERSED`, whatever the transaction carries; for any other type, the `revocationDate` of a revocation that is `refunded`. A `REFUND_PRORATED` refunds the period as a full refund does: the funded grant closes at the refund (spec §6.3) |
| `autoRenew` | `autoRenewStatus` 1 or 0 |
| `nextChargeAt`, `nextCharge` | The period's end; `renewalPrice` and the renewal info's `currency`. None while `priceIncreaseStatus` is 0: without consent to a price increase Apple ends the subscription rather than charge. `observe` drops it unless the subscription is active and renewing |
| `nextProductId` | `autoRenewProductId` when it is not the transaction's `productId` |
| `cancelRequestedAt` | The `signedDate` of `DID_CHANGE_RENEWAL_STATUS` whose renewal info has renewal off. No other notification and no status pull says when, so they state none and the domain keeps the time ([Domain](#domain)) |
| `offerKind` | `offerType` 1 with `offerDiscountType` `FREE_TRIAL` is `free_trial`, with `PAY_AS_YOU_GO` or `PAY_UP_FRONT` `introductory`; 2 `promotional`; 3 `offer_code`; 4 `win_back`; 5, a retention offer, `promotional`, since the domain names no retention kind |
| `offerEndsAt` | The period's end, unless renewal is on and the renewal info states the same `offerType` for the next period, when it is not known yet |
| `price` | `price` in milliunits and `currency`, its code in any case, written with the currency's ISO 4217 minor units by `Money::from_units`: 12000 USD is `12.00`, 1800000 JPY `1800`, 3990 KWD `3.990`; a digit beyond them is kept |
| `storefront` | `storefront` |

An `expired` subscription ends with its last period in every statement of it, since Apple states no
instant for the end of billing retry; `paymentFailedAt` is that period's end, since no statement
after the failure says when it failed.

`Decoded` and `PeriodStatement` carry the account token as `AccountToken` and implement no `Debug`,
and the domain's store ids print redacted. The crate logs nothing; the door logs the outcome's code,
`Awaiting::code`, `Silence::code` or `Unsupported::code`.

The vectors in `tests/vectors/app_store/` pin one outcome for every type and subtype above, every
row of the fields, every field that refuses and every one that degrades;
`crates/app_store/tests/decoding.rs` runs them, and folds a cancel time through the expiry that
cannot state it.

### Waits on the sandbox

m3-verify-sandbox-lifecycle confirms these against payloads Apple signs:

- A renewal's `purchaseDate` is the previous period's end, not the instant Apple charged it (D-4).
  Should it be the charge, a period's start has to come from the previous transaction's
  `expiresDate`.
- A `REFUND` of an earlier month carries that month's transaction with its `revocationDate` and
  `status` 1, and a `REFUND` of the latest carries `status` 5.
- `renewalDate` equals the latest transaction's `expiresDate` to the millisecond, also after
  `RENEWAL_EXTENDED`, which states the extended `expiresDate` on the latest transaction, and after a
  `REFUND` of the latest. Where it does not, the notification answers `AwaitsStatus` and
  `latest_unconfirmed` is reported; this check gates the paid line.
- The renewal info's `offerType` is the next renewal's offer.
- `revocationType` is stated on a refunded transaction.
- A pulled status's transaction and renewal info are signed when Apple answers the pull, so the pull is
  stamped then. Should Apple answer with payloads signed earlier, a pull older than the ledger's newest
  statement changes nothing but the binding and the periods (INV-5).

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
[priceIncreaseStatus](https://developer.apple.com/documentation/appstoreservernotifications/priceincreasestatus),
[billingPlanType](https://developer.apple.com/documentation/appstoreservernotifications/billingplantype),
[price](https://developer.apple.com/documentation/appstoreservernotifications/price),
[renewalPrice](https://developer.apple.com/documentation/appstoreservernotifications/renewalprice),
[renewalDate](https://developer.apple.com/documentation/appstoreservernotifications/renewaldate),
[gracePeriodExpiresDate](https://developer.apple.com/documentation/appstoreservernotifications/graceperiodexpiresdate),
[signedDate](https://developer.apple.com/documentation/appstoreservernotifications/signeddate).

## App Store Server API

`app_store::server_api::AppStoreApi` is the async trait the server's doors call, behind `Arc<dyn AppStoreApi>` so
tests substitute an in-memory fake with no HTTP. `ServerApi` implements it over HTTPS with Windmill's in-app
purchase key, an `ApiKey`: its issuer id, its key id, and its private key, a P-256 key in PKCS#8 as the `.p8` file
App Store Connect hands out holds it in PEM (`PrivateKey`, whose `Debug` prints `PrivateKey(redacted)`). Each
request carries a JSON Web Token of its own as its bearer, signed ES256 with that key: the header `alg` `ES256`,
`kid` the key id and `typ` `JWT`; the claims `iss` the issuer id, `iat` the clock's time in seconds, `exp` five
minutes later (Apple takes at most an hour), `aud` `appstoreconnect-v1` and `bid` `works.windmill.app`, the bundle
id the verifier pins.

| Call | Request | What it answers |
|---|---|---|
| `subscription_status(environment, original_transaction_id)` | Get All Subscription Statuses, `GET /inApps/v1/subscriptions/{originalTransactionId}` | The lineage's entry among every subscription Apple lists for its customer, as a `SignedStatus`: its `status`, and its transaction and renewal info as Apple signed them, unverified |
| `set_app_account_token(environment, original_transaction_id, token)` | Set App Account Token, `PUT /inApps/v1/transactions/{originalTransactionId}/appAccountToken` with `{"appAccountToken": token}` | Nothing: Apple names the token in the lineage's current transaction and every renewal after it |
| `transaction_history(environment, transaction_id, revision)` | Get Transaction History v2, `GET /inApps/v2/history/{transactionId}` with optional `?revision=` | A `TransactionHistoryPage`: unverified `signed_transactions`, optional `revision` cursor, and `has_more` |
| `notification_history(environment, request, pagination_token)` | Get Notification History, `POST /inApps/v1/notifications/history` with optional `?paginationToken=` and JSON `NotificationHistoryRequest` (`startDate`, `endDate`, optional `notificationType`, `notificationSubtype`, `onlyFailures`, `transactionId`) | A `NotificationHistoryPage`: `entries` (each an unverified `signed_payload` and its `send_attempts`), optional `pagination_token`, and `has_more` |
| `request_test_notification(environment)` / `test_notification_status(environment, token)` | Request a Test Notification (`POST /inApps/v1/notifications/test`) and Get Test Notification Status (`GET /inApps/v1/notifications/test/{testNotificationToken}`) | A `TestNotificationToken` (redacted `Debug`, no `Display`) and a `TestNotificationStatus` holding the unverified `signed_payload` and its `send_attempts` |

Every type that carries a signed payload, transaction id, cursor or test notification token either omits `Debug`
(`SignedStatus`) or prints redacted (`PrivateKey`, `TransactionHistoryPage`, `NotificationHistoryRequest`,
`NotificationHistoryEntry`, `NotificationHistoryPage`, `TestNotificationToken`, `TestNotificationStatus`). Each
delivery attempt's `sendAttemptResult` maps into the closed `SendAttemptResult` enum (`Unknown` for any new Apple
code), so no arbitrary network string reaches logs.

The environment picks the host, `Hosts::apple()`: `https://api.storekit.apple.com` for production and
`https://api.storekit-sandbox.apple.com` for sandbox; a test deployment hands both one address of its own
([Configuration](#configuration)). Path segments are percent-encoded through `Url::path_segments_mut`, and empty
or dot path segments (`""`, `"."`, `".."`), empty cursors, or invalid `NotificationHistoryRequest` filter
combinations (`start_date > end_date`, empty filter strings, `notification_subtype` without `notification_type`, or
`notification_type` beside `transaction_id`) fail before any request is sent with `ApiFailure::BadRequest`. A
request ends within 3 s, connecting included, under the internal listener's request bound; it follows no redirect,
and no error message Apple sends is read. An answer that is not a success is one `ApiFailure`, whose `code` is all
a line carries. Each code starts `api_`, so none reads as the verifier's or the ledger's code beside it in a line,
a Sentry fingerprint or a throttle's slot:

| `ApiFailure` | `code` | When | Of the API |
|---|---|---|---|
| `Unreachable` | `api_unreachable` | No answer within 3 s: nothing listened, the connection broke or Apple stalled | yes |
| `Unauthorized` | `api_unauthorized` | 401: Apple refused the token, so the key, its id or its issuer is not the one App Store Connect issued | yes |
| `RateLimited` | `api_rate_limited` | 429 | yes |
| `ServerError` | `api_server_error` | A 5xx, or a 404 whose `errorCode` Apple names retryable: 4040002, 4040004 or 4040006 | yes |
| `NotFound` | `api_not_found` | Any other 404, or a status answer that lists no entry for the lineage | no |
| `BadRequest` | `api_bad_request` | Any other answer that is not a success, a redirect among them, or an invalid request input | no |
| `Malformed` | `api_malformed` | A success whose body is not the shape Apple documents, or `hasMore: true` with no cursor or the same cursor passed in | no |

`of_the_api()` is true of a failure any request would meet now, whatever it asks: the sweep stops writing
hints at one rather than try each ([The sweep](#the-sweep)). The client verifies nothing it pulls: the door
hands each entry to `SignedDataVerifier::verify_status` ([above](#app-store-signature-verification)), then
to `decode_status` ([App Store decoding](#app-store-decoding)). `crates/app_store/tests/server_api.rs` runs
all five operations against an Apple served on a local port: the token's header, claims and signature, each
environment's host, query and path encoding, redacted `Debug`, `Arc<dyn AppStoreApi>`, and the failure each
answer comes to.

The calls, hosts, token and error codes follow Apple's App Store Server API reference:
[Get All Subscription Statuses](https://developer.apple.com/documentation/appstoreserverapi/get-all-subscription-statuses),
[Set App Account Token](https://developer.apple.com/documentation/appstoreserverapi/set-app-account-token),
[Get Transaction History](https://developer.apple.com/documentation/appstoreserverapi/get-transaction-history),
[Get Notification History](https://developer.apple.com/documentation/appstoreserverapi/get-notification-history),
[Request a Test Notification](https://developer.apple.com/documentation/appstoreserverapi/request-a-test-notification),
[Get Test Notification Status](https://developer.apple.com/documentation/appstoreserverapi/get-test-notification-status),
[StatusResponse](https://developer.apple.com/documentation/appstoreserverapi/statusresponse),
[LastTransactionsItem](https://developer.apple.com/documentation/appstoreserverapi/lasttransactionsitem) and
[Generating JSON Web Tokens for API requests](https://developer.apple.com/documentation/appstoreserverapi/generating-json-web-tokens-for-api-requests),
and the retryable 404s
[AccountNotFoundRetryableError](https://developer.apple.com/documentation/appstoreserverapi/accountnotfoundretryableerror),
[AppNotFoundRetryableError](https://developer.apple.com/documentation/appstoreserverapi/appnotfoundretryableerror) and
[OriginalTransactionIdNotFoundRetryableError](https://developer.apple.com/documentation/appstoreserverapi/originaltransactionidnotfoundretryableerror).

## App Store test signer

`app_store_test_signer` signs App Store notifications and transactions under a test chain, for tests
and for local and CI runs that drive a purchase, a renewal or a refund without Apple. The chain is
committed in [`tests/fixtures/app_store/test-chain/`](tests/fixtures/app_store/test-chain/README.md):
a P-384 root, a P-384 intermediate carrying Apple's WWDR marker and a P-256 leaf carrying Apple's
receipt-signing marker, with the leaf's key. A verifier built with `SignedDataVerifier::new` or
`SignedDataVerifier::windmill_also_trusting` and that root believes what it signs, and so does a local or
CI service whose `SUBSCRIPTIONS_APP_STORE_TEST_ROOT` names it ([Configuration](#configuration));
`SignedDataVerifier::windmill` refuses it with `untrusted_chain`.

The binary reads a description on stdin and writes the signed payload on stdout: a compact JWS, or for a
status response its JSON with each payload inside it signed:

```sh
cargo run -q -p app_store_test_signer < tests/fixtures/app_store/test-payloads/renewed.json
```

The library behind it, for Rust tests, is `sign(description, now)`, with the root as `TEST_ROOT`.

A description is a JSON object holding one key, `notification`, `transaction` or `statusResponse`, whose
value is that payload as Apple's documentation shows it decoded; a `statusResponse` is the App Store Server
API's answer to Get All Subscription Statuses, which a test's own Apple serves. A notification's
`data.signedTransactionInfo` and `data.signedRenewalInfo`, and those of each entry of a status response's
`data[].lastTransactions`, may hold decoded objects too; each is signed and put back as its JWS. Every
JWS has the header `alg` `ES256` with an `x5c` of leaf, intermediate and root, and is signed with the
leaf's key. A field the description leaves out takes the value below, in the objects the description
has; the signer adds no object, such as a `data` to a notification without one. A field it states is
signed as stated, so a test can also sign what the verifier must refuse.

| Payload | Field | Value when left out |
|---|---|---|
| notification | `notificationUUID` | a new random UUID: each signing is a new notification, and posting one JWS twice is a redelivery |
| notification | `version` | `2.0` |
| notification's `data` | `environment`, `bundleId` | `Sandbox`, `works.windmill.app` |
| nested transaction | `environment`, `bundleId` | its notification's |
| nested renewal info | `environment` | its notification's |
| standalone transaction | `environment`, `bundleId` | `Sandbox`, `works.windmill.app` |
| status response | `environment`, `bundleId` | `Sandbox`, `works.windmill.app` |
| status entry's transaction | `environment`, `bundleId` | its response's |
| status entry's renewal info | `environment` | its response's |
| each payload signed | `signedDate` | the signing time |

A date Apple states in epoch milliseconds (`signedDate`, `purchaseDate`, `originalPurchaseDate`,
`expiresDate`, `revocationDate`, `renewalDate`, `gracePeriodExpiresDate`,
`recentSubscriptionStartDate`) is written either in milliseconds or as `now` with an optional offset
in days, hours or minutes, such as `now+30d`, `now-2h` or `now+15m`, counted from the signing time.
Any other string is refused, naming its field. The committed descriptions, one for each moment of a
subscription the later checks drive, are listed in
[`test-payloads/README.md`](tests/fixtures/app_store/test-payloads/README.md).

It is a crate of its own rather than a cargo feature of `app_store`, so the dependency rule, which
`check-dependencies.sh` enforces, keeps it out of `subscriptions`: a normal or build edge to it is not
one of the five allowed. A feature would keep it out only while nothing in a build turned the feature
on. It lives in `tools/`, not `crates/`, because it is not part of the service: its frames and lines
are not the service's own in Sentry (`telemetry::SERVICE_CRATES`). Its tests verify what it signs
through `app_store`, a dev-dependency.

## Storage

### The database

The ledger lives in a database of its own, `windmill_subscriptions`, in the host's Postgres, owned by a
role of the same name (spec §9). Where the deploy has provisioned it, rules at the head of the
cluster's `pg_hba.conf` turn the backend's role, `windmill`, away from it on every path, the cluster's
own socket included; its own role needs its password on both paths and reaches no other database. A
`pg_hba.conf` rule binds a superuser, which `windmill` is and which `REVOKE CONNECT` would not stop; what
a superuser set on reaching the database can still do is listed in the deploy README. The rules are
`backend/deploy/subscriptions-db/pg_hba.conf`; how they, the role and the database are provisioned,
backed up and restored is in the
[deploy README](../../backend/deploy/README.md#the-subscription-database).

`storage::Ledger::open` connects and brings the schema up to the newest migration before it returns,
so no `Ledger` exists over an older schema. It holds at most `Ledger::CONNECTIONS`, 8, and gives a connection 5 s to
open. `Ledger::check` gives the database 2 s to answer, on a connection of its own, so writers waiting
on a lock with every connection of the pool never cost the health check its answer.

### Migrations

`migrations/` holds every schema change as `NNNN_<what>.sql`, applied in order, each in a transaction
of its own, and recorded in `_sqlx_migrations`. `sqlx::migrate!` embeds them in the binary at compile
time, so no build reads a database and no image carries the files; `crates/storage/build.rs` rebuilds
the crate when one is added. A merged migration is never edited: the ledger records each one's
checksum, and a database whose record differs from the binary's, or that holds a migration the binary
does not have, is refused as `migration`. An image older than the database's newest migration
therefore does not start.

| Migration | What it creates |
|---|---|
| `0001_ledger.sql` | `ledger`: one row, whose `epoch` (a UUID) is minted when the ledger is created and replaced when it is restored (spec §5.2) |
| `0002_inbox.sql` | `now_millis()`, the database's clock in epoch milliseconds, and `inbox` |
| `0003_subscriptions.sql` | `subscriptions` and `periods` |
| `0004_events.sql` | `ledger.latest_seq`, `events`, their index by subscription and `entitlement_subscriptions` |
| `0005_erased_accounts.sql` | `erased_accounts` |
| `0006_store_hints.sql` | `store_hints` |
| `0007_store_hint_attempts.sql` | `store_hints.attempts`, `next_attempt_at` and `abandoned_at` |
| `0008_left_with_no_one.sql` | `periods.left_with_no_one`, `events.period_left_with_no_one`, and the index of `periods` by `left_with` |

### Records

Every instant is epoch milliseconds, the unit the domain and every wire count in; the ledger's own
stamps (`received_at`, `settled_at`, `recorded_at`, `erased_at`) are the database's clock, read through
`now_millis()`. Ids are `uuid`. Each closed name is checked against the domain's set, a state's facts
are present exactly in that state (§3.2), and an amount is a decimal string beside its ISO 4217 code,
so the database holds no value the domain cannot read back. Store ids are kept plain, because the App
Store Server API is called with the original transaction id; the domain types that carry them print
redacted (spec §10).

| Table | Holds |
|---|---|
| `inbox` | Each notification a store door kept, keyed by `(store, notification_id)`, with its environment and the signed payload as received. `settled_at` and `outcome` are set together, once: `applied`, a refusal's code, the code a door settles a notification with when it states nothing to apply, or `failed`. `attempts` counts the applies that failed for a reason a retry cannot change, and `next_attempt_at` is when the next may run |
| `subscriptions` | One row per lineage, unique by `(store, environment, store_subscription_id)`: every field of the domain's `Subscription`, and `verified_at` |
| `periods` | One row per store transaction of a lineage. Only `refunded_at`, `observed_at` and whom it is left with change after it is written (INV-7): `left_with`, the account that paid for it once a new purchase moved its subscription (R-11), or `left_with_no_one` once the account that held or paid for it was erased (§6.4), never both |
| `events` | Append-only, keyed by `seq`. Each row keeps its subscription's store, environment and offer kind as the transaction that recorded it left them, and a period event its period as the event states it, so the feed reads no other table's current state |
| `entitlement_subscriptions` | For each event that names an account, the subscriptions that account's entitlement carries as the transaction left them, each environment's governing one and every other in force: what the event's entitlement folds over. An event keeps at most one ended subscription for each environment, however many its account held, and every one in force, as the feed serves them with it. A copy holding more of the account's subscriptions folds into the same entitlement |
| `erased_accounts` | The accounts the backend erased (§6.4), each with `erased_at`, when the ledger first recorded it |
| `store_hints` | The account hints the ledger owes the stores, each with its lineage: written in the transaction that binds a subscription by claim, cleared once the store has taken it, dropped once the subscription is bound to another account, and dropped in the transaction that erases its account (§4, §6.4). `attempts` counts the store's refusals of it, `next_attempt_at` is when it may be written again, and `abandoned_at` is set at the fifth, after which it is never written |

### Writing

`Ledger`'s write methods are what the doors and the sweep call:

| Method | What it does |
|---|---|
| `receive(notification)` | Keeps a verified notification and answers `Receipt::Kept` with a `KeptNotification`. When the inbox holds one by that store's id already it changes nothing and answers `Receipt::Duplicate`, carrying the `KeptNotification` while it is not settled, so the door can apply a redelivery at once (spec §5.1 step 3) |
| `apply_notification(kept, observed)` | Applies the observation a kept notification states and settles the notification in the same transaction. A notification settled already answers `AlreadySettled`, so the door and every retry of the sweep together apply it once. An apply that fails for a reason a retry cannot change (a value the database refuses, SQLSTATE classes 22, 23 and 42, or a row it cannot read) counts against the notification, which then waits 1, 2, 4 and 8 hours before the next attempt and is settled `failed` at the fifth |
| `apply(observed)` | Applies the observation of a claim or a pull |
| `settle(kept, code)` | Settles a notification that states nothing to apply with the code of what it was; a settled notification keeps its first outcome |
| `postpone(kept, by_millis)` | Leaves a kept notification unsettled and out of `unsettled` for that long: one that waits on what no retry brings sooner, such as its subscription's status. A redelivery still hands it back |
| `unsettled(limit)` | The kept notifications not yet settled and not waiting after a failed attempt or a postponement, the longest kept first: what the sweep applies (§7 step 1) |
| `store_hints(limit)`, `clear_store_hint(hint)` | The account hints owed to the stores, the longest owed first: each whose subscription is bound to its account. Clearing one once its store took it; a hint owed since to another account stays |
| `forget_stale_store_hints()` | Drops every hint no longer owed, its subscription bound to another account since, and answers how many |
| `count_store_hint_refusal(hint)` | Counts a refusal by the store a retry cannot change: the hint waits 1, 2, 4 and 8 hours, and the fifth settles it abandoned, which it answers |
| `erase_account(account)` | The erasure of §6.4, in one transaction: below. It answers an `Erasure`: whether this call recorded the account first, `erased_at`, each lineage it changed with its events' seqs, and how many owed hints it dropped. An erasure repeated changes nothing and answers the first `erased_at` |

Only the ledger makes a `KeptNotification`, so nothing applies a notification the inbox does not hold.
`Observed` is what a caller hands over: the observation; the account its hint names, as a UUID, so a
door reads a store's token that is not one as no hint; the claim, when a claim door calls; and
`pulled_at`, when the service read the state from the store's API. `verified_at` is the newest
`pulled_at` applied.

Every write that changes a kept notification's inbox row, `apply_notification`, `settle`, `postpone` and a
failed attempt counted, holds the notification's advisory lock first, so the door, a redelivery and the sweep
apply it once, and a settlement, a postponement or a count beside an apply waits for the apply to end.
`receive` inserts the row and changes none: a second `receive` of one notification that arrives before the
first commits waits for it, once.

Every write, the inbox's among them, begins `read committed` whatever the database's default, since the
seq lock needs each statement to see what committed before it. It holds a notification's, an account's, a
lineage's or the seq queue's lock ([below](#the-seq-lock)) before it changes what the lock guards, and waits
5 s at most for those locks, all of them together, counted from its start: a lock is held for milliseconds,
so a longer wait means its holder stalled, and the write answers `busy` rather than hold a connection behind
it. Each is an advisory lock, which Postgres grants in one step, taken in a statement of its own once
`lock_timeout` is set to what is left of the 5 s, and set so again once it is granted. A row's lock, which
Postgres grants in as many steps as there are writers in line for the row, a write takes only under the
advisory lock guarding the row: a subscription, its periods and the hint owed for it under its lineage's, an
inbox row under its notification's, the `ledger` row under the seq queue. Only a writer that went around
that lock can hold the row, and the write waits for one such writer at most what is left of its 5 s. Each of its statements runs at most 10 s
(`statement_timeout`), which ends a statement stalled for any other reason, so no write holds a connection
past it. An apply is one transaction, the action of [Domain](#domain):

1. Hold the claiming account and the hinted account, each a shared advisory lock, and resolve each:
   erased when `erased_accounts` names the account, live otherwise.
2. Lock the lineage with an advisory lock keyed by it, which also covers a lineage nothing has written
   yet, lock its row `for no key update`, and load its `domain::Ledger`.
3. Mint a subscription id and one period id per stated period, random UUIDs, and call `observe`. A
   `Refusal` writes nothing.
4. Write the subscription when it differs from the one held, each period written or restated,
   `verified_at` when the state was pulled, and the hint owed to the store when the change binds by
   claim. A change that moves the binding, as a new purchase does (R-11), drops each hint owed for the
   subscription to another account. A replay writes no row (INV-4).
5. Take the events' seqs under the seq lock ([below](#the-seq-lock)), read the subscriptions of each
   account the events name and fold its entitlement, append the events, then copy beside them the
   subscriptions each account's entitlement carries, in one statement for each account.
6. For a notification, settle its inbox row. Commit.

`Applied::Recorded` holds the `Change`, the seq of each of its events, and `newest_seq`, the seq of the
subscription's newest event once the transaction commits, read under the lineage's lock when the change
records none. A claim retried after its answer was lost replays, and answers the same `newest_seq` and
`{seq, entitlement}` (§5.2); the hint it owes the store stays in `store_hints` until the sweep has
written it. A commit whose answer never arrives fails as `outcome_unknown`, never `ledger_unreachable`, since
the transaction may have committed.

An erasure is one transaction too:

1. Hold the account's advisory lock alone, record it in `erased_accounts` unless it is there, and read its
   `erased_at`.
2. Read the lineages holding anything of it, a subscription bound to it, a period `left_with` it or a
   hint owed for it, in the order of `(store, environment, store_subscription_id)`, and lock each as an
   apply does, in that order.
3. Call `domain::erase` for each and write what it changes: the subscription unbound, its periods
   restated with no one.
4. Drop every hint owed to a store for the account. Each is in a lineage step 2 locked, since no hint is
   owed to an account while its lock is held alone.
5. Take the seqs of every change's events under the seq lock and append them, each `unbound` with the
   subscriptions the account's entitlement carries as the transaction leaves it, none. Commit.

Only a move away from the account changes what a lineage holds of it between steps 2 and 3, and a lineage
moved away still holds the periods the account paid for, so the read of step 2 finds every lineage the
erasure changes. Two erasures lock the lineages they share in the same order.

Locks are taken in one order, a notification, then accounts, then lineages, then the seq queue and the seq
lock, and an erasure holds its account's lock alone, so no binding to an account commits beside its erasure.
A write that locks several lineages, an erasure or the drop of stale hints, takes them in the order of
`(store, environment, store_subscription_id)`. The store hint sweep's writes hold lineages alone: a clear and
a refusal counted hold the hint's, and the drop of stale hints reads their lineages first, holds each, and
drops a lineage's hint only if it is still stale under the lock.
The row lock is `for no key update` because a transaction holding the seq lock inserts entitlement rows whose foreign
key takes a key-share lock on each subscription the account's entitlement carries, which `for update` refuses: the two
transactions would deadlock.

### The seq lock

A transaction takes its events' seqs by updating the `ledger` row, `latest_seq = latest_seq + n`, and
holds that row's lock until it commits. No transaction takes a seq while another that took one has not
committed, so seq order is commit order and a reader that has seen `seq = n` has seen every event below
it (INV-8). The seq and the lock are one statement, and `events.seq` has no default, so no event can
take a seq without the lock, as one could beside an advisory lock around a sequence. Every write that
records an event waits for that one row, so each waits first in the seq queue, an advisory lock taken just
before it, and reaches the row only once no other write holds it: `lock_timeout` bounds the whole wait.
Waiting for the row itself, a write second in line would wait in two steps, its place in line and then the
holder's end, each bounded apart, and so up to twice what is left of its lock bound. A rolled-back
transaction rolls the counter back with it, so the ledger leaves no gap of its own; readers still allow
one (§5.2). `recordedAt` is the database's clock read in the same statement, one instant for the
transaction's events, rising with seq as long as the clock does. Each account's subscriptions are read
after the lock is taken, so they include every transaction committed before. The copy beside the events is taken
from the rows as they stand once the events are in: while the lock is held only a write that records no event
commits, and such a write changes nothing an entitlement carries (INV-14), so the copy carries what the fold read.

### Reading

| Method | What it answers |
|---|---|
| `feed(after, limit)` | A `FeedPage`, `{epoch, entries, latest_seq}`, read in one repeatable-read snapshot: at most `limit` events after the seq `after`, in seq order. A `FeedEntry` holds the domain's `Event`, its `seq` and `recorded_at`, the subscription's store, environment and offer kind, and the entitlement, `AccountEntitlement::of` the account over the subscriptions stored with the event, absent exactly when the event names no account (§5.2) |
| `lineage(lineage)` | What the ledger holds for one lineage: its subscription, if any, and its periods |
| `subscription(id)` | The subscription the ledger keeps under its own id, if any, as a refresh names it |
| `entitlement(account)` | The account's entitlement as the ledger holds it now |
| `account(account)` | An `AccountRecord`, read in one repeatable-read snapshot: each subscription bound to the account, ordered by id, with its periods by start and every event of it in seq order as a `RecordedEvent` (`seq`, `recorded_at`, the domain's `Event`), whichever account the event was told under; and the entitlement folded over those subscriptions |

### Failures

A database failure is a `StorageError`: a code and, where the server sent one, its SQLSTATE. The
server's message is never kept, because it can quote a statement or a value. A ledger nothing answers is
`ledger_unreachable`, not the App Store Server API's `api_unreachable`, under any operation that meets both.

| Code | When |
|---|---|
| `ledger_unreachable` | no connection within its bound: nothing listens, the network refused or TLS failed |
| `busy` | after start, no connection within 5 s, because every connection is in use or the database opened no new one, or a write not granted its locks within 5 s of its start (`55P03`); the health check, on a connection of its own, tells a busy ledger from an unreachable one |
| `outcome_unknown` | a commit's answer never arrived: the transaction may have committed, and a retry shows which |
| `refused` | the server would not let the role in: a `pg_hba.conf` rule (`28000`), a wrong password (`28P01`), no such database (`3D000`) |
| `migration` | the schema could not be brought up to the binary's, or the database holds a migration the binary does not |
| `unreadable` | a row this build cannot read: a name outside its closed set, or a fact its state requires missing |
| `database` | anything else the database answered, such as a deadlock (`40P01`), a connection the server ended (`57P01`) or a write's statement past its 10 s (`57014`) |

`storage::DatabaseUrl` reads a `postgres://` or `postgresql://` URL. Its query may carry only `host`
(a host or a unix socket directory), `port`, `user`, `dbname` and `sslmode`: the driver logs any other
parameter with its value, and the URL holds the role's password. Neither its `Debug` nor any error
repeats it.

## Server

`crates/server` holds six modules, `config`, `internal`, `listeners`, `store_doors`, `sweep` and
`telemetry`, and the binary `subscriptions`, whose `main.rs` reads the configuration, starts telemetry,
builds the App Store verifier and, while the in-app purchase key is set, the App Store Server API client,
opens the ledger, and serves both listeners and runs the sweep until a signal. `store_doors` keeps its
work through the App Store Server API — the claim, the refresh, the hint writes, and the
`test-notification` CLI runner — in `store_doors/server_api.rs`.

Running `subscriptions test-notification <sandbox|production>` reads only the App Store API key variables
(`AppStoreApiConfig::from_environment`), without opening the ledger or starting either listener, asks Apple for a
test notification, polls its delivery status, writes one `store.test_notification` JSON line carrying only
allowlisted fields (`outcome`, `code`, `send_attempt_result`, `attempts`, `duration_ms`), and exits 0 when Apple
reports `success` or 1 otherwise. It never prints the token, signed payload, key, or raw Apple error text.

### Configuration

Read once at start. An empty value counts as unset. A missing required value, a malformed value, an
address naming a host that does not resolve or a refused combination stops the start with exit code 1 and
one log line naming the variable, never its value.

| Variable | Required | Meaning |
|---|---|---|
| `SUBSCRIPTIONS_PUBLIC_ADDRESS` | yes | Socket address of the public listener, such as `0.0.0.0:8082`, or a host and port whose name resolves at start; of several addresses, as `localhost` has, it binds the first IPv4 |
| `SUBSCRIPTIONS_INTERNAL_ADDRESS` | yes | The same for the internal listener, such as `0.0.0.0:8083`; production names `subscriptions-internal:8083`, the service's alias on the one compose network the backend shares with it, so the listener binds that network alone |
| `SUBSCRIPTIONS_DATABASE_URL` | yes | The ledger's database, as a `storage::DatabaseUrl` ([Storage](#failures)), such as `postgresql://windmill_subscriptions:<password>@db:5432/windmill_subscriptions` |
| `SENTRY_ENVIRONMENT` | yes | The deployment's name, such as `production`; Sentry files every report and log under it |
| `SENTRY_DSN` | no | Where Sentry reports go; unset turns Sentry off, logged once at start |
| `SENTRY_RELEASE` | no | The build's git sha, attached to every report |
| `WINDMILL_LOG_LEVEL` | no | The lowest level written to stdout: `trace`, `debug`, `info` (default), `warn`, `error` or `fatal`, in any case, the words the backend reads; `fatal` reads as `error`. sqlx's own lines stay at `warn` or above, because below it they carry the server's raw error text |
| `SENTRY_LOG_LEVEL` | no | The same words: the lowest level of the service's own lines sent to Sentry as Logs; default `info` |
| `SUBSCRIPTIONS_PANIC_ROUTE_ENABLED` | no | `true` adds `GET /debug/panic` to the internal listener; refused unless `SENTRY_ENVIRONMENT`, trimmed and in any case, is `local`, `development`, `test` or `ci` |
| `SUBSCRIPTIONS_APP_STORE_TEST_ROOT` | no | The path of a DER certificate the App Store door trusts beside Apple's root, such as the test chain's `tests/fixtures/app_store/test-chain/root.cer`; refused unless `SENTRY_ENVIRONMENT` is one of the same four. A file that is no P-256 or P-384 certificate stops the start with `SUBSCRIPTIONS_APP_STORE_TEST_ROOT names no certificate to trust`. Unset, the door trusts Apple's root alone |
| `SUBSCRIPTIONS_APP_STORE_API_ISSUER_ID` | no | The issuer id App Store Connect shows beside the in-app purchase key the App Store Server API is called with ([App Store Server API](#app-store-server-api)) |
| `SUBSCRIPTIONS_APP_STORE_API_KEY_ID` | no | That key's id |
| `SUBSCRIPTIONS_APP_STORE_API_PRIVATE_KEY` | no | That key's `.p8` file as it is: a P-256 private key in PKCS#8 PEM, `-----BEGIN PRIVATE KEY-----` to `-----END PRIVATE KEY-----`, its line breaks kept or left out. Anything else stops the start with `SUBSCRIPTIONS_APP_STORE_API_PRIVATE_KEY is malformed` |
| `SUBSCRIPTIONS_APP_STORE_API_TEST_URL` | no | An `http` or `https` address answering the App Store Server API for both environments, such as an Apple a local run serves itself; refused unless `SENTRY_ENVIRONMENT` is one of the four test deployments. Unset, the client calls Apple's hosts |
| `SUBSCRIPTIONS_INTERNAL_TOKEN` | no | The bearer secret of the internal doors ([below](#internal-doors)), the one the backend sends: at least 32 characters, none a space or a control character; production's is 64 lowercase hex. Unset, every internal door answers 401; the `starting` line says whether it is set |

The three variables of the key are set together. With any of them unset the App Store Server API is off: the
claim and the refresh answer 503 `store_api_unavailable`, the hints claims owe stay owed, and the service
starts, warning `<variable> is not set, so the App Store Server API is off` for each one unset beside one that
is set.

### Start

The App Store verifier is built before the ledger opens, and the ledger opens before either listener
binds, so no door ever answers over an older schema. The `starting` line says whether
`app_store_test_root` is trusted, whether the App Store Server API is on (`app_store_api`), and whether it
calls an Apple of a test's own (`app_store_api_test_url`). A ledger
that does not open stops the start with exit code 1, one line `ledger.open failed` carrying its
`code` and `sqlstate`, and a Sentry Issue ([Logs and Sentry](#logs-and-sentry)). A ledger that
opens writes `ledger open` with its `epoch`.

### Listeners

The image listens on 8082 (public) and 8083 (internal), beside the backend's 8080 and the embedder's
8081, and speaks HTTP/1.1. Each listener builds its own router, so a route on the internal listener
does not exist on the public one and answers 404 there. In production Caddy forwards `/v1/stores/*` to
the public port and nothing else, and the internal listener binds the service's address on
`internal-doors`, a compose network only the backend shares, so no other container reaches it.

| Listener | Route | Answer |
|---|---|---|
| public | `GET /health` | 200 `{"status":"ready"}` while the ledger answers `Ledger::check`, else 503 `{"status":"unavailable"}` |
| public | `POST /v1/stores/app-store/notifications` | the App Store notification door ([below](#the-app-store-notification-door)) |
| internal | `GET /health` | the same; the image's `HEALTHCHECK` asks it, at the address `SUBSCRIPTIONS_INTERNAL_ADDRESS` names |
| internal | `GET /internal/v1/feed`, `GET /internal/v1/accounts/{accountId}` | the backend's reads, behind the bearer secret ([below](#internal-doors)) |
| internal | `DELETE /internal/v1/accounts/{accountId}` | an account's erasure, behind the same secret ([below](#internal-doors)) |
| internal | `POST /internal/v1/app-store/claims`, `POST /internal/v1/subscriptions/{subscriptionId}/refresh` | the claim and the refresh, behind the same secret ([below](#the-claim-and-refresh-doors)) |
| internal | `GET /debug/panic` | panics, only while `SUBSCRIPTIONS_PANIC_ROUTE_ENABLED` is `true` |

`listeners::Bounds` holds what a client may take on a listener, `Listener::bounds` each one's:

| Bound | Public | Internal | Past it |
|---|---|---|---|
| request head | 5 s | 5 s | the connection closes without an answer |
| request, body and handler | 5 s | 12 s | 503 `{"error":"timeout"}` |
| request body | 64 KiB | 64 KiB | 413, before any handler reads it |

The internal doors write the ledger, so their request waits past every bound a write keeps, 5 s for its locks and
10 s for a statement ([Writing](#writing)): a stalled ledger answers a door's own 503 `{"code":"unavailable"}`, and
a write that commits late answers as it came to, before the listener's timeout does.

A handler runs only while its client waits: a client that leaves cancels it. A door whose work must
outlive its request, as the App Store notification door's, the claim's, the refresh's and the erasure's does,
spawns that work as a pipeline of its own.

Both listeners answer health the same way because every door reads or writes the ledger. The routers
take what they ask as a `listeners::Readiness`, which `Ledger` is, so a test hands them a fake, and each
takes the doors it serves beside health as a `Router`, which `main.rs` builds: the public one
`store_doors::router`, the internal one `internal::doors`, whose reads and erasure it takes as an
`internal::BackendLedger`, which `Ledger` is too, and beside them `store_doors::internal_router`, the claim and the refresh, all behind
one bearer layer.

SIGTERM or SIGINT stops both listeners from accepting and the sweep after the row it is applying. Each
open connection then finishes its request within the bounds above, the App Store door waits for the
deliveries it is applying, and the ledger's connections close once nothing holds one, for at most 6 s
together. Past that bound the service logs `stopped with requests still in flight` with
`abandoned_deliveries`, and reports `store.notification` `abandoned` when there were any: what they kept
the next start's sweep applies, and what they had not kept yet Apple sends again; Sentry's last flush takes at most
1 s more and the send in progress at most 2 s, so the process exits 0 inside Docker's 10 s, whether or
not Sentry answers.

### The App Store notification door

`store_doors::AppStoreDoor` serves `POST /v1/stores/app-store/notifications`: App Store Server
Notifications V2 from both environments, the environment being the verified payload's, as the fixed
pipeline of spec §5.1. The handler hands each delivery to a task of its own and waits only for its
answer, so neither a client that leaves nor a request past its bound cancels a delivery once its payload
is verified.

1. **Body.** The listener's bound, 64 KiB, holds `{"signedPayload": "<JWS>"}`. A notification signed
   under the test chain is about 15 KB, and Apple's chain is a third larger.
2. **Verify.** `verify_notification` verifies the payload with the transaction and renewal info inside
   it ([rules](#app-store-signature-verification)), on the blocking pool and at most one payload per core
   at a time, so payloads nobody signed cost no more than the cores the service has. A delivery whose
   client leaves before its payload is verified keeps nothing, and the verification it started keeps
   its turn until it ends. The door adds two rules of its own:
   the `notificationUUID` holds no NUL, which no text the ledger keeps can hold, and the `signedDate` is
   at most eight days old.
3. **Keep.** `Ledger::receive` keeps the signed payload in the inbox under the `notificationUUID`, once.
4. **Apply.** `decode` decides ([App Store decoding](#app-store-decoding)). An `Observation` is applied
   by `apply_notification`, in the transaction that settles the notification, with the transaction's
   `appAccountToken` as the hint when it reads as a UUID and no hint otherwise (spec §4). `Silent` and
   `Unsupported` settle the notification with their code. `AwaitsStatus` postpones it an hour
   (`Ledger::postpone`), since the door pulls no status for a notification yet. A redelivery of a
   notification the inbox holds unsettled applies it at once, from the inbox's own copy, verified again
   when the delivered bytes differ from it; one the inbox holds settled changes nothing.
5. **Answer.** 200 once the inbox holds the notification, whatever step 4 does, and before it runs: what
   step 4 leaves unsettled, the sweep applies ([below](#the-sweep)).

At most four applies run at once, the notification door's, the claim's, the refresh's and the sweep's
together: half the ledger's
`Ledger::CONNECTIONS`, so keeping a notification always finds a connection. A burst waits for its turn
in memory rather than at the pool's 5 s bound for a connection.

Applies of one subscription take its lineage's lock in the order they reach it, not the order their
notifications arrived: one answered before the next arrives can still be applied after it, as when the
store delivers out of order. The subscription and its periods end as the newest statement says either
way (spec INV-6); the events record what each apply found, so a refund whose reversal was applied first
records neither.

| Answer | When |
|---|---|
| 200, no body | The inbox holds the notification, kept by this delivery or an earlier one |
| 400 `{"error":"refused"}` | Steps 1 and 2 refused it, and nothing is kept. The line carries why |
| 503 `{"error":"unavailable"}` | The inbox could not keep it, or its client left before it was verified |
| 403 | From the edge, not the service: a client outside Apple's 17.0.0.0/8 ([deploy README](../../backend/deploy/README.md#the-subscription-service)) |
| 413 | A body over 64 KiB, refused by the listener |

Every answer but 200 makes Apple send a production notification again, 1, 12, 24, 48 and 72 hours after
each failed attempt, 157 hours in all; it sends a sandbox notification once. Apple's notification
history keeps one signed payload for a notification and its send attempts, so a retry is taken to carry
the payload as first signed, and eight days covers the schedule with a day and a half for Apple's own
delays. Since nothing checks revocation, eight days is also how long a leaf's key can still sign after
its certificate expires.

Each delivery writes one `store.notification` line when its pipeline ends, inside its request's span:
`operation`, `store`, `environment` once known, `outcome`, `code`, `sqlstate` from the database,
`answered` (the status it answered), `redelivered` once kept (true when the inbox held it already),
`payload_differs` on a redelivery, `events` when applied, `duration_ms`, and `sentry_event_id` when
reported. It names no notification, payload, transaction or account.

A refusal is one of two kinds. Before the signature holds (`body`, `malformed`, `algorithm`,
`chain_length`, `certificate`, `untrusted_chain`, `apple_marker`, `certificate_validity`, `signature`)
the payload could be anyone's, and the line is all there is. After it (`signed_in_future`, `bundle_id`,
`environment`, `notification_uuid`, `signed_too_long_ago`) the store signed what the door refuses, so
the line is a warning and Sentry hears of it as a warning, at most once in ten minutes for each code.
The door's own two refusals carry the `environment`; the verifier's do not, since it answers a refusal
without its payload.

| `outcome` | `code` | Level | Reported |
|---|---|---|---|
| `refused` | before the signature held | `info` | no (spec §10) |
| `refused` | after it | `warn` | a warning, throttled |
| `left` | | `info` | no |
| `not_kept` | the `StorageError`'s | `error` | yes |
| `duplicate` | | `info` | no |
| `applied` | | `info` | no |
| `settled` | `test`, `renewal_extension_summary`, or the domain's refusal | `info` | no |
| `unsupported` | the decoder's | `error` | yes |
| `unverifiable` | the verifier's: the inbox's copy of a redelivery no longer verifies, and is settled with it | `error` | yes |
| `awaits_status` | `earlier_transaction` | `warn` | no |
| `awaits_status` | `latest_unconfirmed` | `error` | yes: its lineage stalls until a status pull |
| `apply_failed` | the `StorageError`'s | `error` | yes; the notification stays unsettled for the sweep |

```json
{"timestamp":"2026-11-14T23:52:52.621412Z","level":"INFO","message":"store.notification","operation":"store.notification","store":"app_store","environment":"sandbox","outcome":"applied","answered":200,"redelivered":false,"events":3,"duration_ms":59.9,"span":{"listener":"public","method":"POST","request_id":"564630692fb444819f57d08ad157a5bc","route":"/v1/stores/app-store/notifications","name":"request"}}
```

A report is `telemetry::report` under `store.notification` and the line's `code`, carrying the request's
`listener`, `route` and `request_id` tags.

### The claim and refresh doors

`store_doors::internal_router` serves the backend's two writes on the internal listener, behind its bearer
secret ([Internal doors](#internal-doors)). Each runs as a task of its own, so a client that leaves cancels
neither its apply nor its line, and both take the state they apply from the App Store Server API
([App Store Server API](#app-store-server-api)), never from what they are handed. A pull is one pipeline:
`subscription_status` for the lineage in its environment, `verify_status` on the blocking pool as a
notification's payloads are verified, `decode_status`, and the observation it gives applied by
`Ledger::apply` with the transaction's `appAccountToken` as the hint when it reads as a UUID, and
`pulled_at`, the door's clock, which becomes `verifiedAt`. Apple picks the entry by an id it does not sign, so
an observation of a lineage other than the one asked for is refused as `inconsistent`.

`POST /internal/v1/app-store/claims` (spec §5.2), `{accountId, signedTransaction}`:

1. **Request.** The body is the request, and `accountId` a UUID in its canonical spelling.
2. **Verify.** `verify_transaction` believes the signed transaction as Apple's
   ([rules](#app-store-signature-verification)), under Apple's root and in a test deployment the test root,
   and `decode_claim` reads its lineage.
3. **Pull** the lineage's state, as above.
4. **Apply** it with the claim, the caller's account at the door's clock: `observe` binds an unbound
   subscription to the caller, records `bound` and the periods again under the account, and owes the store
   the account as its hint when the purchase carried none or named an erased account; a claim of a
   subscription bound to the caller changes nothing; one bound to another account, or whose hint names a
   live other, is refused, as is a claim by an erased account; a purchase the store reports shared binds to
   no one (spec §4).
5. **Answer** `{seq, entitlement}`: `Applied::Recorded.newest_seq`, the claimed subscription's newest
   event, and the caller's entitlement read after the commit. A claim retried after its answer was lost
   replays, recording nothing, and answers the same `seq`.

`POST /internal/v1/subscriptions/{subscriptionId}/refresh` pulls the state of the subscription the ledger
keeps under that id, a UUID in its canonical spelling, applies it as above without a claim, and answers
`{seq}`, the subscription's newest event. It binds only as any observation's hint does (§4).

| Answer | Claim | Refresh |
|---|---|---|
| 200 | `{seq, entitlement}` | `{seq}` |
| 400 `{"code":"invalid_request"}` | the body is not `{accountId, signedTransaction}` | |
| 400 `{"code":"invalid_account_id"}` | `accountId` is not a canonical UUID | |
| 400 `{"code":"invalid_subscription_id"}` | | the id is not a canonical UUID |
| 400 `{"code":"invalid_transaction"}` | the transaction does not verify, or is of what Windmill does not sell | |
| 404 `{"code":"unknown_subscription"}` | | the ledger keeps no subscription under the id |
| 409 `{"code":"bound_to_another_account"}`, `{"code":"account_erased"}` | the domain's refusal (§4) | |
| 503 `{"code":"store_api_unavailable"}` | the deployment holds no in-app purchase key ([Configuration](#configuration)) | the same, or the subscription's store has no API client |
| 503 `{"code":"store_unavailable"}` | the pull gave no state to apply | the same |
| 503 `{"code":"unavailable"}` | the ledger did not apply it, or did not read the entitlement after it | the ledger did not read the subscription or apply the state |

Every 503 means the same to the backend: try again later, as a phone keeps the transaction unfinished and
claims it again at its next launch (§5.3).

Each claim writes one `store.claim` line, and each refresh one `store.refresh` line, inside its request's
span: `operation`, `store`, `environment` once known, `outcome`, `code`, `sqlstate` from the database,
`answered`, `events` when applied, `duration_ms`, and `sentry_event_id` when reported. It names no account,
transaction, subscription or payload.

| `outcome` | `code` | Level | Reported |
|---|---|---|---|
| `applied` | | `info` | no |
| `refused` | `bound_to_another_account`, `account_erased`, `unknown_subscription`, or a verifier's refusal before the signature held | `info` | no |
| `refused` | `invalid_request`, `invalid_account_id`, `invalid_subscription_id`, a verifier's refusal after the signature held, or the decoder's code | `warn` | no |
| `store_api_unavailable` | | `warn` | no |
| `pull_failed` | the `ApiFailure`'s, the verifier's, `inconsistent`, or the decoder's | `error` | yes, at most once in ten minutes for each code |
| `apply_failed`, `read_failed`, `entitlement_unread` | the `StorageError`'s | `error` | yes |

`crates/server/tests/store_doors_server_api.rs` drives both doors through the internal router against an
Apple served on a local port.

Known limit: a claim records the periods its pull states, the latest transaction's; a claimed transaction
older than it adds no period of its own until the notification history read (spec §7 step 4) exists.

### The sweep

`sweep::Sweep` is the worker of spec §7: two steps, each passing once at start, so what the last run kept and
left unsettled is applied first, then a minute after each pass (`sweep::EVERY`, which `main.rs` hands it).
`InboxSweep`, step 1, and `StoreHintSweep`, the hints claims owe the stores, run on clocks of their own, the
hint step as a task of its own: the inbox's step reads only the ledger, and never waits on a store's API, however
slowly it answers or however many hints it refuses. At SIGTERM each step stops between two rows, and the sweep returns
once both have. Steps 2 to 4 are not built.

`InboxSweep` reads `Ledger::unsettled` 100
rows at a time and applies each through the door's own step 4 (`AppStoreDoor::apply_kept`), from the
inbox's copy, which it verifies again, without the door's age rule. A copy that no longer verifies, as one
kept under a test root a deployment has stopped trusting, is settled with the verifier's code. A pass goes
on to the next page while the last one moved any row; one whose every row failed ends, and the next pass
tries again. A notification the inbox holds for a store no door of this build serves is postponed an hour.

Each pass writes one `sweep.inbox` line: `rows`, and for each outcome its count (`applied`, `settled`,
`awaiting`, `duplicate`, `failed`, `refused` for unsupported or unverifiable ones, `without_door`), then
`code` and `sqlstate` of the first reported, `duration_ms` and `sentry_event_id`. It is at `error` when
the pass reports, at `debug` when it met no row and at `info` otherwise. A failure, an unsupported
notification, an unverifiable copy, an unconfirmed latest transaction and an inbox the pass cannot read
report under `sweep.inbox` and their code, at most once in ten minutes for each.

`StoreHintSweep` writes the account hints the ledger owes the stores (spec §4) through each store's door
(`AppStoreDoor::store_hints_due`, `AppStoreDoor::write_store_hint`). A pass:

1. **Drops** every hint no longer owed (`Ledger::forget_stale_store_hints`): its subscription is bound to
   another account since. An account's erasure drops its hints itself ([Writing](#writing)). No account's id
   reaches a store for a subscription it does not hold.
2. **Reads** `Ledger::store_hints` 100 at a time, the longest owed first, but for hints waiting after a
   refusal or abandoned.
3. **Writes** each as the lineage's app account token (Set App Account Token), and clears it once Apple took
   it (`Ledger::clear_store_hint`).

What Apple answers decides what becomes of the hint:

- A failure of the API as a whole (`ApiFailure::of_the_api`: Apple does not answer, refuses the key, limits
  the rate or fails itself) counts against no hint and ends the pass; the next pass writes the hint again.
- A refusal of this hint (`api_not_found`, `api_bad_request`, `api_malformed`) counts against it
  (`Ledger::count_store_hint_refusal`), as a notification's failed apply does: it waits 1, 2, 4, then 8 hours,
  and the fifth refusal settles it abandoned, never written again and reported once.
- A ledger that does not record the answer ends the pass; the hint stays owed, and a hint Apple took is
  written again, which sets the same token.

Without the in-app purchase key it reads nothing, and every hint stays owed. The sweep is the one writer of
hints: a claim answers without waiting on Apple, a write that fails is retried by the same step as the first,
and no hint is written twice at once. A binding that moves while a hint's write is in flight, in the
milliseconds between its read and Apple's answer, is the one way the old account's id can still reach Apple.

Each hint written writes one `store.hint` line: `operation`, `store`, `environment`, `outcome`, `code`,
`sqlstate`, `duration_ms` and `sentry_event_id`; a pass that drops hints writes one line of `outcome`
`forgotten` with their count, `hints`. No line names an account or a transaction.

| `outcome` | `code` | Level | Reported |
|---|---|---|---|
| `written` | | `info` | no |
| `forgotten` | none; `hints` counts the hints a pass dropped | `info` | no |
| `refused` | the `ApiFailure`'s: Apple refused this hint, which waits | `warn` | no |
| `abandoned` | the `ApiFailure`'s: the fifth refusal | `error` | yes, once for each hint |
| `write_failed` | the `ApiFailure`'s: the API failed as a whole | `error` | yes, at most once in ten minutes for each code |
| `unrecorded` | the `StorageError`'s: the ledger did not record what Apple answered | `error` | yes, the same |
| `unread` | the `StorageError`'s: the owed hints could not be dropped or read | `error` | yes, the same |

### Internal doors

`internal` holds the backend's reads and an account's erasure (spec §5.2), each over the ledger as
`internal::BackendLedger` reaches it, and `internal::doors` merges them with the store doors' claim and refresh
([above](#the-claim-and-refresh-doors)) under one bearer layer; the internal router serves
them, so none exists on the public listener. Each is behind the bearer secret: a request without
`Authorization: Bearer <secret>`, with another secret, or reaching a service started without one answers
401 `{"code":"unauthorized"}` with `WWW-Authenticate: Bearer`, and says nothing of which. The secret is compared in time that depends on the
lengths alone. `/health` asks for none, for the image's `HEALTHCHECK`.

| Route | Answer |
|---|---|
| `GET /internal/v1/feed?after=<seq>&limit=<n>` | 200, `Ledger::feed(after, limit)` as `feed.json` shows a page. Both are required, `after` from 0 and `limit` from 1 to 500; any other query is 400 `{"code":"invalid_query"}` |
| `POST /internal/v1/app-store/claims`, `POST /internal/v1/subscriptions/{subscriptionId}/refresh` | the claim and the refresh ([above](#the-claim-and-refresh-doors)), as `internal-app-store-claim.json` and `internal-subscription-refresh.json` show each answer |
| `DELETE /internal/v1/accounts/{accountId}` | `Ledger::erase_account` ([Writing](#writing)), as `internal-account-erasure.json` shows each answer: 204 with no body whether it unbound anything or the account was erased already, 400 `{"code":"invalid_account_id"}` for an id as the read below refuses it, before the ledger is reached, and 503 `{"code":"unavailable"}` when the ledger did not answer, which the backend tries again. It runs as a task of its own, so a backend that leaves cancels neither the erasure nor its line |
| `GET /internal/v1/accounts/{accountId}` | 200, `Ledger::account` as `account.json` shows it: `{entitlement, subscriptions}`, the entitlement, and each subscription bound to the account with the entitlement's fields of it, then `environment`, `boundAt`, `boundBy`, `periods` as the feed carries a period, and `events`, each `{seq, type, occurredAt, recordedAt, accountId, period}`. An id that is not a UUID in its canonical spelling, lowercase and hyphenated, is 400 `{"code":"invalid_account_id"}`; an account the ledger holds nothing of answers its empty entitlement and `[]` |

A read the ledger does not answer is 503 `{"code":"unavailable"}` and an Issue under `feed.read` or
`account.read`, and an erasure under `account.unbind` ([Logs and Sentry](#logs-and-sentry)); the backend reads
or erases again. The wire shapes are `internal/responses.rs`, each written from the ledger's own types.
`crates/server/tests/contract.rs` serves every example of `feed.json`, `entitlement.json` and `account.json`
from the ledger's types, writes every refusal and 200 of `internal-app-store-claim.json`,
`internal-subscription-refresh.json` and `internal-account-erasure.json` from the doors' own, and compares the
bodies byte for byte, key order included. It also tells the feed's story through `Ledger::apply`, every
transaction up to seq 26, then the erasure at seq 27 through its door, twice, and checks every page of it,
the four account reads of it, the claim's answer, first and retried, and both erasures' answers against the
fixtures.

### Logs and Sentry

Every line on stdout is one JSON object. Each request writes one line when it ends: `listener`,
`method` (a method outside the standard nine is `other`), `route` (the route template, or
`unmatched`), `status`, `outcome`, `duration_ms` and `request_id`. `outcome` is `answered`,
`panicked`, `timed_out`, or `cancelled` when the client left first; a cancelled line has no `status`.
The line reads no header, body or raw path. A 5xx line is at `error`, a 4xx or cancelled line at
`warn`, a ready health answer and an answered feed read at `debug`, since a probe and the backend's
follower ask every few seconds forever, and anything else at `info`:

```json
{"timestamp":"2026-11-14T10:58:01.163207Z","level":"ERROR","message":"request","listener":"internal","method":"GET","route":"/debug/panic","status":500,"outcome":"panicked","duration_ms":4.3,"request_id":"8244ce4ef07341ff85532a1d8dfc7cf9"}
```

A health check the ledger does not answer also writes `ledger did not answer` at `warn`, with
`operation` `ledger.check`, the failure's `code` and `sqlstate`, inside the request's span.
The App Store door writes one `store.notification` line per delivery
([above](#the-app-store-notification-door)), one `store.claim` line per claim and one `store.refresh` line
per refresh ([above](#the-claim-and-refresh-doors)), and the sweep one `store.hint` line per hint it writes
([The sweep](#the-sweep)). Each read an internal door has the ledger answer writes `feed.read` or
`account.read`, inside the request's span, with `operation`, `outcome` `ok` and its `entries` or
`subscriptions`; a feed page without entries writes it at `debug`, any other at `info`. A refused read
writes its request line alone. Each erasure writes one `account.unbind` line inside the request's span, with
`operation`, `outcome`, `answered` and `duration_ms`: `erased`, or `already_erased` for an account the ledger
had recorded, at `info` with how many subscriptions it `unbound`, `periods` it left with no one, `hints_dropped`
and `events` it recorded; `refused` with `code` `invalid_account_id` at `info`; `ledger_failed` with the
failure's `code` and `sqlstate` at `error`, reported. No line names an account, the query or the secret.

Lines from every crate of the workspace (`telemetry::SERVICE_CRATES`) also go to Sentry as Logs; a
vendor's lines stay on stdout. A line at `error` creates no Issue. Issues come from explicit
reports, each logged with the event's `sentry_event_id` (absent while Sentry is off):

- `telemetry::report` reports an unexpected failure of a named operation (spec §10), at `error`, or at
  `warning` for what is worth knowing of without being one. Its message is the operation, such as
  `ledger.open`; its tags are `operation`, `code` and, from the database, `sqlstate`; one Issue gathers
  each operation and code. It answers the event's id, which the caller's own line carries, as the
  door's `store.notification` line does. A `telemetry::Throttle` reports each operation and code at
  most once an interval, for what can recur as often as something outside the service likes.
  `telemetry::report_failure` reports and writes `<operation> failed` at `error`, for `ledger.open`,
  `feed.read` and `account.read`; an erasure the ledger did not answer is reported under `account.unbind` and
  its code, its own line carrying the event's id.
- A panic after start is reported with its location and stack and without its message, and logged as
  `panic`. The stack ends at
the panicking frame, and the service's crates are its in-app frames. A panic inside a request also
carries that request's span in its line and its `listener`, `route` and `request_id` as tags, and the
request answers 500 `{"error":"internal"}` while the listener keeps answering.

### Run

[backend/RUNNING.md](../../backend/RUNNING.md#the-subscription-service) runs it locally beside the
backend, with the test root, posts it a notification the test signer signs, and claims it against an Apple
the run serves itself.

Its internal doors answer 401 until `SUBSCRIPTIONS_INTERNAL_TOKEN` names a secret, such as
`openssl rand -hex 32` makes. The backend follows the feed once its `.env` holds the same secret and
`SUBSCRIPTIONS_INTERNAL_URL=http://127.0.0.1:8083`.

The image builds from this directory and sets both addresses itself; `SENTRY_RELEASE`, a build
argument, is the commit Backend CI builds it from. A container reaches the host's Postgres over TCP,
so it needs a URL with a host and a role that may sign in over it; the deploy README
[runs the production compose](../../backend/deploy/README.md#run-it-locally) with a local image beside
its database:

```sh
docker build --build-arg SENTRY_RELEASE="$(git rev-parse HEAD)" -t windmill-subscriptions .
```

## Toolchain

`rust-toolchain.toml` pins Rust 1.99.1 with rustfmt and Clippy; `rustup toolchain install`, run in
this directory, installs it. `Cargo.lock` is committed, and Clippy and the tests run with `--locked`.
The `Dockerfile` builds on the `rust` image of the same release and fails when the two differ.

## Checks

`.github/workflows/subscriptions.yml` runs these on every change under `services/subscriptions/`
other than Markdown, and on changes to the workflow. Backend CI calls it as well, and publishes the
image only once it passes. Locally, from `services/subscriptions/`:

```sh
./check-dependencies.sh
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

`check-dependencies.sh` needs `jq` and runs from any directory.

The tests that need Postgres, in `crates/storage/tests/` and `crates/server/tests/` (`contract.rs`,
`internal.rs`, `store_doors.rs` and `store_doors_server_api.rs`), run only where
`SUBSCRIPTIONS_TEST_DATABASE_URL` names a database whose role may create databases; each test creates
an empty one beside it and drops it after. Without the variable they are compiled as ignored, so the
summary counts them as not run. Against the local Homebrew Postgres:

```sh
SUBSCRIPTIONS_TEST_DATABASE_URL="postgresql:///postgres?host=/tmp" cargo test --locked
```

The check job runs them against a Postgres 16 service. A second job builds the image and runs it
twice beside a Postgres of its own. First it must migrate the empty database, become healthy, answer
ready on both listeners, answer 404 for an internal path on the public port and exit 0 on SIGTERM.
Then, with a Sentry that accepts and never answers and three panics waiting to send, `docker stop`
must exit 0 within 10 s.
