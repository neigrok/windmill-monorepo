# Windmill subscription service

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, definitions (`D-n`),
invariants (`INV-n`) and rulings (`R-n`) are numbered so reviews, code and roadmap nodes can cite them.

## §0 Status and scope

**Status:** Specified, not built. `services/subscriptions/` holds the Rust workspace with its four crates
empty; nothing runs and nothing is deployed. Windmill One cannot be bought on any surface. The C++
backend mirrors Paddle subscriptions (`backend/platform/adapters/paddle`) and
`Entitlements::hasWindmillOne` reads that mirror; this document specifies what replaces it. The build
order and its owner gates live in the Windmill One roadmap tree, which the dogfood tree
(`t_9362d9bc883e0a1e`) opens from the node `windmill-one-subscription-service`.

**Scope:** One service owns every fact about a paid Windmill One subscription: which store sold it,
when it started, each period paid for, whether it renews and when the next charge falls, whether it
is cancelled, paused, in payment trouble, refunded or ended. It serves App Store subscriptions first.
Its model already carries what Google Play and Paddle need (§3.5), so adding a store adds an adapter
and no column.

**Out of scope:** What Windmill One unlocks stays with each product behind
`Entitlements::hasWindmillOne`. The AI allowance ledger stays in the backend
([USD AI allowances](../../backend/AI_ALLOWANCES.md)); this service supplies the paid periods that fund
it (§6.3). Owner access is not a subscription and stays in `Entitlements::isOwner`.

## §1 Why a separate service

Paid state is the one part of Windmill where a defect takes money for nothing or gives the product
away. It is kept apart so that:

- a backend deploy or crash never loses a store notification, and a defect here never stops sync;
- the code that verifies store signatures and decides access is small enough to review whole;
- it holds its own database, which no product code can join against;
- every state it ever reported can be replayed from what the stores sent.

It is written in Rust. It runs as its own container on the production host beside `server` and
`embedder`, with its own image, workflow and health check.

## §2 Vocabulary

- **D-1 Store.** The seller that bills the customer: `app_store`, `play_store` or `paddle`. This is the
  answer to "which platform does the subscription belong to"; it is named *store* because `platform`
  names the product-neutral layer of this repository.
- **D-2 Environment.** `production` or `sandbox`, as the store states it. Every record carries it.
- **D-3 Subscription.** One store subscription lineage for one plan: an App Store
  `originalTransactionId`, a Play purchase-token lineage, a Paddle `sub_…`.
- **D-4 Period.** One stretch `[start, end)` the customer paid for or was granted, as the store states
  it, with the store transaction that created it, its price and currency, and its refund time while the
  store has taken the money back. A renewal's period starts where the previous one ends, not at the
  instant the store charged it, so the periods of one subscription never overlap.
- **D-5 Observation.** A verified statement by a store of one subscription's whole state at one
  instant (`observedAt`, the store's own stamp). Every adapter produces observations and nothing else.
- **D-6 Event.** A normalized fact recorded when an observation changes a subscription. Events are
  append-only and ordered by `seq`.
- **D-7 Binding.** The link from a subscription to one Windmill account.
- **D-8 Entitlement.** The per-account answer derived from its bound subscriptions, one per
  environment: whether the account holds Windmill One there, until when, and the subscription that
  governs it.
- **D-9 Plan.** What was bought. One value exists: `windmill_one`.

## §3 The model

### §3.1 Subscription

| Group | Field | Meaning |
|---|---|---|
| Identity | `id` | The service's own UUID. |
| | `store`, `environment`, `storeSubscriptionId` | D-1, D-2, D-3. Unique together. |
| | `plan`, `productId`, `billingInterval` | D-9, the store's SKU, and an ISO 8601 duration (`P1M`). |
| Binding | `accountId`, `boundAt`, `boundBy` | D-7. `boundBy` is `purchase` or `claim`. Null until bound. |
| Lifecycle | `state` | §3.2. |
| | `startedAt` | The first purchase of this lineage. |
| | `currentPeriod` | The start and end of the period in force (D-4). |
| | `accessUntil` | The instant paid access ends unless the store says otherwise (§3.3). Null when the state grants none. |
| | `endedAt`, `endReason` | Set in `expired` and `revoked`: `cancelled`, `billing`, `price_change_declined`, `product_unavailable`, `replaced`, `refunded`, `chargeback`, `sharing_removed`, `unknown`. |
| Renewal | `autoRenew` | Whether the store will charge again. |
| | `nextChargeAt`, `nextCharge` | When and how much (`amount`, `currency`) the store will charge next. Null when `autoRenew` is false, and in `grace`, `on_hold`, `paused`, `expired` and `revoked`, where the store states no next charge. |
| | `nextProductId` | A plan change that takes effect at renewal. |
| Cancellation | `cancelRequestedAt` | When the customer turned renewal off. Cleared if they turn it back on. |
| Payment trouble | `paymentFailedAt`, `graceEndsAt` | When a renewal charge first failed, and until when the store keeps access open. |
| Pause | `pauseScheduledFor`, `pausedAt`, `resumesAt` | A pause asked for, in force, and its end. |
| Offer | `offerKind`, `offerEndsAt` | `free_trial`, `introductory`, `promotional`, `offer_code`, `win_back`, or none. |
| Price | `price`, `storefront` | The current period's `amount` and `currency`, and the store's country. |
| Bookkeeping | `observedAt` | `observedAt` of the newest observation applied. |
| | `verifiedAt` | The last time the service pulled this subscription's state from the store. |

Amounts are decimal strings with an ISO 4217 currency. Instants are epoch milliseconds on every wire.

### §3.2 States

| State | Meaning | Access |
|---|---|---|
| `active` | The current period is paid or granted. | yes |
| `grace` | A renewal charge failed; the store retries and keeps access open until `graceEndsAt`. | yes |
| `on_hold` | A renewal charge failed; the store retries with access closed. | no |
| `paused` | The customer paused it; it resumes at `resumesAt`. | no |
| `expired` | It ended. | no |
| `revoked` | The store took the money back or withdrew the purchase. | no |

A trial is `active` with `offerKind = free_trial`. A cancellation that has not yet taken effect is
`active` with `autoRenew = false` and `cancelRequestedAt` set. A pause that has not begun is `active`
with `pauseScheduledFor` set. `expired` and `revoked` are left only by a new store purchase on the
same lineage, which returns the subscription to `active` and records `started` again.

### §3.3 Access

- **INV-1.** `grantsAccess(subscription, now)` is `accessUntil != null && now < accessUntil`. It is a
  pure function of the record and a clock, and the only definition of paid access in the system.
- **INV-2.** `accessUntil` is `graceEndsAt` in `grace`. In `active` it is `currentPeriod.end`, plus
  `RENEWAL_SLACK` when `autoRenew` is true. It is null in every other state.
- `RENEWAL_SLACK` is 24 hours in production and zero in sandbox. A store charges a renewal before the
  period ends and reports the result; the slack bounds how long a customer whose renewal went through
  can wait on a late report. A paying customer never loses access to this service's downtime shorter
  than the slack, and a failed renewal the service has not heard of gives away at most the slack of
  access. The slack extends access only; periods fund the AI allowance (§6.3).
- **INV-3.** Access ends by the clock alone. No delivery, sweep or process has to run for an
  entitlement to lapse.

### §3.4 Observation and events

The domain has one write: `observe(subscription | none, observation) → (subscription, events)`.

- **INV-4 Idempotent.** Applying an observation twice changes nothing and records nothing.
- **INV-5 Stale-safe.** An observation older than the record's `observedAt` changes no field of the
  subscription. It still adds a period the ledger lacks, and its statement of a period's refund time
  applies when it is newer than the statement that last set or cleared that refund time.
- **INV-6 Convergent.** For any order of any set of observations, the resulting subscription equals the
  one the newest observation alone produces, and the resulting set of periods is the union, each
  period's refund time as its newest statement gives it.
- **INV-7.** A period is identified by its store transaction and written once. Afterwards only its
  refund time changes: set when the store takes the money back, cleared when the store reverses that.

Events: `started`, `renewed`, `renewal_turned_off`, `renewal_turned_on`, `payment_failed`,
`payment_recovered`, `pause_scheduled`, `paused`, `resumed`, `plan_change_scheduled`, `plan_changed`,
`period_extended`, `expired`, `revoked`, `revocation_reversed`, `updated`, `bound`, `unbound`, and the
three period events `period_recorded`, `period_refunded` and `period_refund_reversed`. Each carries
`seq`, `type`, `occurredAt` (the store's time), `recordedAt`, `subscriptionId` and `accountId`; a period
event also carries its period.

- **INV-8.** Events are appended under one lock, so `seq` order is commit order and a reader that has
  seen `seq = n` has seen every event below it. `seq` increases and may skip numbers.
- **INV-13.** Each change to a period records one period event, whatever state events the same
  observation records or does not: `period_recorded` when the period is written, `period_refunded`
  when its refund time is set, `period_refund_reversed` when it is cleared. Binding a subscription
  records `period_recorded` again under the new account for each period written before the binding,
  carrying its refund time as it stands, so a period written while the subscription was unbound still
  reaches its account. A period written by the observation that binds is recorded once, under the
  account. Lifecycle events never carry a period; period events are the only ones that do.
- **INV-14.** An observation that changes a field the entitlement carries (§5.2) records at least one
  event. When no event above names the change, as with `grace` turning `on_hold`, a new price or a
  redeemed offer, it records `updated`.

### §3.5 What each store supplies

| Concept | App Store | Play Store | Paddle |
|---|---|---|---|
| Lineage (D-3) | `originalTransactionId` | purchase token, chained by `linkedPurchaseToken` | `sub_…` |
| Account hint | `appAccountToken` set at purchase | `obfuscatedExternalAccountId` | `custom_data.user_id` |
| How state arrives | signed notification carrying the latest transaction and renewal info | a Pub/Sub hint, then a read of the subscription | webhook carrying the subscription |
| `grace` | billing grace period | grace period | `past_due` |
| `on_hold` | billing retry without grace | account hold | — |
| `paused` | — | paused | `paused` |
| `revoked` | revoked status | revoked, voided purchase | refund or chargeback adjustment |
| Cancel pending | `autoRenewStatus = 0` | cancelled, not yet expired | `scheduled_change: cancel` |

A cell with a dash is a state that store never reports.

A refund states a fact about the period its transaction paid for: it sets that period's refund time
(INV-7), and a reversed refund clears it. The subscription's state in the same observation is the one
the store states for the subscription, never inferred from the refund, so a refund of an earlier
period leaves a running subscription `active` (§8).

## §4 Binding

- **INV-9.** A subscription binds to at most one account. A binding ends only by account erasure
  (§6.4) or an operator transfer, and both record an event.
- **At purchase.** The app passes the signed-in account's id as the store's account hint. The first
  verified observation carrying a hint binds the subscription to the account it names. A hint that
  names an erased account (§6.4) counts as no hint.
- **By claim.** The app posts the store's signed transaction through the backend (§5.3). The service
  verifies it and binds an unbound subscription to the caller. A claim for a subscription already
  bound to the caller succeeds without change. A claim for one bound to another account, or whose
  account hint names another account that is not erased, is refused with `bound_to_another_account`
  (R-3). A claim for an unbound subscription whose hint names an erased account binds it to the
  caller (R-9).
- A later observation whose hint differs never rebinds.
- An unbound subscription is recorded in full and entitles no one.
- Only a purchase its buyer owns binds. A subscription the store reports as shared or assigned to
  the device's Apple account is recorded and entitles no one.
- When a claim binds a subscription whose hint is absent or names an erased account, the service
  writes the caller's id to the store as the hint (the App Store's Set App Account Token), so the
  store's later statements name the account.

## §5 Doors

The service listens on two ports. The public port is the only one the proxy forwards to, so an
internal route cannot be exposed by a path rule.

### §5.1 Public: store doors

`POST /v1/stores/app-store/notifications` receives App Store Server Notifications V2 for both
environments; the environment is read from the verified payload. The door is a fixed pipeline:

1. Read a bounded body.
2. Verify the signed payload and the signed transaction and renewal info inside it: each certificate
   chain to the pinned Apple root certificates, each signature, that the bundle id is
   `works.windmill.app`, and that the environment is `Production` or `Sandbox`.
3. Insert the signed payload into the inbox keyed by the notification's UUID. A duplicate answers 200.
4. Build the observation and apply it (§3.4) in one transaction with its periods, events and binding.
5. Answer 200.

A failure at 1–2 answers 4xx and stores nothing. Once step 3 commits the door answers 200 whatever
step 4 does: an unprocessed inbox row is retried by the sweep (§7), so recovery never waits on the
store's redelivery schedule. Apple redelivers a production notification five times over a week and a
sandbox notification never. Later stores add `/v1/stores/play-store/notifications` and
`/v1/stores/paddle/notifications` with the same shape.

### §5.2 Internal: the backend's doors

Reached only on the container network, with a bearer secret the backend holds.

| Route | Purpose |
|---|---|
| `GET /internal/v1/feed?after=<seq>&limit=<n>` | A page of at most `limit` events after `seq`, in `seq` order; `limit` is at most 500. |
| `GET /internal/v1/accounts/{accountId}` | The entitlement, every bound subscription, their periods and events. |
| `POST /internal/v1/app-store/claims` | `{accountId, signedTransaction}` → `{seq, entitlement}`, or a refusal (§4). |
| `POST /internal/v1/subscriptions/{id}/refresh` | Pull this subscription's state from its store now. |
| `DELETE /internal/v1/accounts/{accountId}` | Record the account as erased and unbind everything it holds (§6.4). |

The shapes are golden fixtures in
[`packages/api-contract/subscriptions`](../../packages/api-contract/subscriptions/README.md), one example
per state a reader must handle; the service and the backend each check themselves against them.

`EntitlementResponse` is `{accountId, production, sandbox}`: one `Entitlement` for each environment
(D-2). An `Entitlement` is `{plan, accessUntil, governing, others}`, folded over the account's
subscriptions in that environment alone:

- `governing` is the subscription whose state grants access (its `accessUntil` is not null) with the
  latest `accessUntil`; when none grants access, the one with the latest `observedAt`. Ties go to the
  smaller `subscriptionId`. It is null when the account holds no subscription in that environment.
- `plan` and `accessUntil` are the governing subscription's, null when it grants no access.
- `others` lists every other subscription that is not `expired` or `revoked`, ordered by
  `subscriptionId`, so a client can say that a person is being charged twice.
- `governing` and each entry of `others` carry `subscriptionId`, `store`, `state`, `startedAt`,
  `currentPeriod` (`{start, end}`), `accessUntil`, `autoRenew`, `nextChargeAt`, `nextCharge`
  (`{amount, currency}`), `nextProductId`, `cancelRequestedAt`, `paymentFailedAt`, `graceEndsAt`,
  `pauseScheduledFor`, `pausedAt`, `resumesAt`, `offerKind`, `offerEndsAt`, `endedAt` and `endReason`,
  as §3.1 defines them.

A feed page is `{epoch, entries, latestSeq}`. `epoch` is a UUID minted when the ledger is created and
replaced when the ledger is restored from a backup, so a cursor means something only within its
epoch (§6.1). `latestSeq` is the newest event the ledger holds. A page may end inside the entries of
one transaction; each entry carries the entitlement after its transaction, so a reader that stops
there holds a correct copy.

A feed entry is one event (§3.4) with the subscription's `store`, `environment` and `offerKind`,
`period` on a period event (`{id, start, end, price, offerKind, refundedAt}`, `id` being the service's
own), and `entitlement`, the account's `EntitlementResponse` after the transaction that recorded the
event, null exactly when the event names no account.

The internal claim answers 200 with `{seq, entitlement}`: the caller's `EntitlementResponse` after the
claim, and the `seq` of the claimed subscription's newest event, which is the claim's last event when
it recorded any. It refuses with `{code}`: 409 `bound_to_another_account`, 400 `invalid_transaction`.

### §5.3 What a person's device calls

Devices never call this service. The backend authenticates the caller and serves:

- `GET /v1/subscription` → `SubscriptionResponse`, answered from the backend's own copy (§6.1): one
  `Entitlement` of the account (§5.2), with `environment`, naming which one it is; `allowlisted`,
  whether the account is on the sandbox allowlist, so its sandbox purchases count (§6.2); `manage`
  (`{"store": "app_store", "url": "https://apps.apple.com/account/subscriptions"}`, the governing
  subscription's store, null when there is none); `purchasable`, the stores this account may buy
  through now; and `offer`. The `Entitlement` shown is the production one, unless the account is on
  the sandbox allowlist and its sandbox `Entitlement` grants access while its production one does
  not. An account off the allowlist never sees its sandbox `Entitlement`. An owner's `Entitlement` is
  chosen the same way.
- `offer` is what a month of Windmill One funds, which the buy sheet shows:
  `{"aiAllowance": {"amount": "7.00", "currency": "USD"}}`, read from the backend's configuration
  (`AI_ONE_PERIOD_USD`, [USD AI allowances](../../backend/AI_ALLOWANCES.md)). It is non-null exactly
  when `purchasable` is non-empty. The free allowance is neither sent nor shown beside it.
- **INV-12.** A surface offers a buy control for a store only when `purchasable` names it.
  `purchasable` is empty while the account has Windmill One (§6.1, owners included), and while the
  `Entitlement` shown holds any subscription that is not `expired` or `revoked` (in `grace`, `on_hold`
  or `paused`, or with a cancellation pending), so no surface offers one account a second live
  subscription. Otherwise a store is listed only while the backend's configuration opens the paid line
  on it. Every store is closed by default, so opening the line is one switch the owner sets and can
  unset. An app whose purchases land in sandbox (a TestFlight or Xcode build) offers a buy control
  only when `allowlisted` is true as well, so no one buys a sandbox subscription that counts for
  nothing.
- `POST /v1/subscription/app-store/claims` with `AppStoreClaimRequest` `{signedTransaction}`, forwarded
  to §5.2 with the caller's account id. On the service's 200 the door asks the follower to reach the
  answer's `seq` (§6.1), waits for it at most 5 s, and answers 200 with the `SubscriptionResponse`
  from the copy; a wait that runs out answers from the copy as it stands. Otherwise it answers
  `{code}`: 409 `bound_to_another_account`, 400 `invalid_transaction` for a transaction that does not
  verify, 503 `subscriptions_unavailable` when the service cannot be reached.
- A device finishes the transaction on 200 and 409. On 400 and 503 it keeps the transaction
  unfinished and claims it again at its next launch. A 400 for a transaction StoreKit verified is
  reported to Sentry by the device.

## §6 The backend's half

### §6.1 Following the feed

A backend worker reads `/internal/v1/feed` from its stored epoch and cursor. For each page, in one
transaction, it replaces each named account's row in `account_entitlements` with the entry's
`EntitlementResponse`, both environments included, applies funding (§6.3) and advances the cursor.
Once it reaches `latestSeq` it reads again at most 5 s later, or at once when the claim door asks for
a `seq` it has not reached (§5.3).

- `Entitlements::hasWindmillOne` is `isOwner(email) || now < production.accessUntil ||
  (allowlisted(account) && now < sandbox.accessUntil)` over the account's row (§6.2).
- A funding call (§6.3) answers `Ok` or `Replay`, and the entry is done; or `Conflict`, an expected
  refusal: it is logged under `subscription.fund` with code `conflict` and reported to Sentry as a
  warning, since paid money is left unfunded, and the page commits with the cursor past it. Any other
  failure rolls the page back and is reported to Sentry as an error, and the page is read again.
- A page whose `epoch` differs from the stored one, or whose `latestSeq` is below the cursor, means the
  ledger was restored. The follower reports it to Sentry and rebuilds the copy from zero under the new
  epoch (INV-11).
- **INV-10.** No request path of the backend calls this service to decide access. With the service
  down, every entitlement keeps answering from the copy and lapses on time (INV-3).
- **INV-11.** The copy is rebuilt whole by reading the feed from zero. The old copy answers until the
  rebuilt one replaces it, and an account the feed no longer names keeps no row.

### §6.2 Sandbox

A sandbox subscription costs its buyer nothing. In production it entitles an account only when that
account is on the backend's sandbox allowlist (the team's testers and the account given to App
Review). For every other account it is recorded in the copy's sandbox `Entitlement`, grants nothing
(§6.1) and is never shown (§5.3). A sandbox period funds no grant; an allowlisted account it entitles
is funded as owner access is. (R-6)

### §6.3 Funding the AI allowance

Subscription state alone funds nothing; the period events of the feed do. A grant's reference is its
period's `id`, so no store id reaches the backend. (R-4, R-5)

- A `period_recorded` entry that names an account, for a production period with a positive captured
  price and no `refundedAt`, funds one grant spanning the period through `AiBudgetService::fund`. Any
  other `period_recorded` funds nothing: `grace` adds no period, a free-trial period carries no
  payment, and a refunded period was paid back.
- `fund` answers `Replay` to a period it already funded for that account, whatever the grant's
  `closedAt`, so a rebuild (INV-11) funds nothing twice. It answers `Conflict` to a period already
  funded for another account (an operator transfer, or erasure and a claim by another account), which
  is not funded again, and to a period that overlaps a grant the account holds. §6.1 says what the
  follower does with each answer.
- A `period_refunded` entry closes the grant whose reference is the period's `id`: its `closedAt`
  becomes `min(end, refundedAt)`. A closed grant funds nothing after `closedAt` and counts toward the
  overlap rule only until `closedAt`; spent capacity is not recovered. A close for a grant that does
  not exist changes nothing.
- A `period_refund_reversed` entry reopens that grant by clearing its `closedAt`. A reopen that would
  overlap another grant of the account answers `Conflict` and leaves the grant closed.
- An account that holds Windmill One through a subscription and has no funded grant in force, as in
  `grace`, in the renewal slack or after a `Conflict`, is admitted under the free signed-in
  allowance.

### §6.4 Account erasure

`DELETE /v1/me` closes an account with a 30-day grace in which a sign-in brings it back whole; from
`closesMs` the close is final, and the account is erased by the first sign-in that meets it or by
`ClosedAccountSweep` ([accounts](../../backend/AUTH.md)). Until then its subscriptions stay bound, so
an account that comes back finds them as it left them. The erasure of a finally closed account calls
`DELETE /internal/v1/accounts/{accountId}`: the service records the account as erased, so a hint
naming it never binds again (§4), its subscriptions are unbound and its entitlement ends. The backend
records that call in the erasure's own transaction and repeats it until the service answers, so a
service outage never leaves a subscription bound to an erased account. The periods and events stay,
keyed by store ids that name no person. The store goes on charging until the customer cancels there,
so the close flow MUST say so before it proceeds, and name where to cancel.

## §7 The sweep

One worker, hourly:

1. Process inbox rows not yet applied.
2. Pull the store's state for every subscription whose `accessUntil` falls within the next hour or
   has passed while its state still grants access or is `on_hold`.
3. Pull every subscription not `expired` or `revoked` whose `verifiedAt` is older than seven days. A
   pull that changes the record means a notification was missed: it is logged as `drift` and
   reported.
4. After downtime, read the store's notification history since the newest inbox row and feed what is
   missing through §5.1 step 3 onward.

## §8 App Store adapter

- Products: one subscription group, *Windmill One*, holding one monthly auto-renewable product.
  Family Sharing is off. (R-1)
- Purchase on iOS uses StoreKit 2 with `appAccountToken` set to the account id. The app shows a buy
  control only to a signed-in account, and only as INV-12 allows. (R-2) A TestFlight or Xcode build
  buys in sandbox, so it also needs `allowlisted` (INV-12).
- After a verified purchase or a restore, the app posts the transaction's signed representation to
  the claim door and finishes the transaction as §5.3 says.
- A period's bounds are the dates its transaction states for the stretch it pays for (D-4), not the
  instant Apple charged it. Which transaction fields carry them waits on confirmation against sandbox
  in m3-verify-sandbox-lifecycle.
- A `REFUND` or `REVOKE` notification states a fact about the transaction it carries: it sets that
  period's refund time, and `REFUND_REVERSED` clears it. The subscription's state in that observation
  comes from the notification's renewal info; when the refunded transaction is not the subscription's
  latest, the adapter pulls the subscription's status instead of inferring the state. Both wait on
  confirmation in m3-decode and m3-verify-sandbox-lifecycle.
- What the app shows about a subscription comes from `GET /v1/subscription`, never from the device's
  own StoreKit state, so every surface agrees.
- Server reads use the App Store Server API with an in-app purchase key: subscription statuses,
  transaction history, notification history (180 days in production, 30 in sandbox) and the test
  notification. The environment of a call is the one the verified transaction states.
- A signed transaction whose environment is `Xcode` or `LocalTesting` is not signed by Apple. The
  claim door refuses it unless the deployment is configured with a test root, which production never
  is.
- A notification type the adapter does not map is kept in the inbox, logged as `unsupported` and
  reported; it changes nothing.
- The transaction's `price` and `currency` are what the plan screen shows and what decides whether a
  period was paid. Revenue is read from Apple's sales reports, not from them.
- Billing Grace Period is enabled in App Store Connect for production and sandbox. (R-7)

## §9 Structure

```text
services/subscriptions/
  Cargo.toml              the workspace
  ARCHITECTURE.md         what is built, the dependency rule and how it is checked
  crates/
    domain/               D-1…D-9, observe, grantsAccess, the entitlement fold; no I/O, no async
    app_store/            signature verification, notification and transaction decoding into
                          observations, the App Store Server API client. Apple publishes no Rust
                          library, so this crate is the whole integration
    storage/              Postgres: inbox, subscriptions, periods, events, the feed read
    server/               the composition root: both listeners, the sweep, configuration
  migrations/
  tests/
    vectors/              observation sequences with the subscription, periods and events they
                          must produce
    fixtures/app_store/   signed payloads recorded from sandbox
```

`domain` depends on no other crate. `app_store` and `storage` depend on `domain` and not on each
other. A later store is one more crate beside `app_store`. The clock, the store's root certificates and
the store's API are constructor arguments, so tests sign their own payloads under a test root and
run the whole pipeline with no network.

Storage is a database of its own, `windmill_subscriptions`, in the host's Postgres with its own role.
The backend's role cannot read it.

## §10 Observability

- Every write logs one structured line: operation, store, environment, outcome or refusal code,
  duration. Operations: `store.notification`, `store.claim`, `store.refresh`, `account.unbind`,
  `sweep.inbox`, `sweep.due`, `sweep.drift`, `sweep.history`.
- Unexpected failures report to Sentry under those names. A signature that does not verify is a
  logged refusal, not an Issue. `drift` reports as a warning.
- The backend's follower logs `subscription.follow` per page and `subscription.fund` per funding call
  with its outcome (`ok`, `replay`) or refusal code (`conflict`, reported as a warning). It reports a
  cursor that has not advanced while the service reports newer events, and a page whose epoch or
  `latestSeq` starts a rebuild (§6.1).
- The backend's claim door logs `subscription.claim` with its outcome or refusal code; a wait for the
  follower that runs out is logged as `copy_behind`.
- A renewal, a failed charge and a refund happen with no device present, so no client can emit them.
  The follower records them as product events in the store the `/v1/events` intake writes and
  forwards from: `subscription_started`, `subscription_renewed`, `subscription_renewal_turned_off`,
  `subscription_payment_failed`, `subscription_expired`, `subscription_revoked`, each with `store`,
  `environment` and `offerKind`. The intake accepts only client batches today; the server-origin
  write is part of this build.
- Each device emits the steps a person takes: the buy control shown, purchase started, purchase
  completed, cancelled or failed, claim accepted or refused, restore, and manage opened.
- Nothing logs or reports a signed payload, a transaction id, an account hint or an email.

## §11 Rulings

The owner's rulings. R-1 to R-7 and R-9 are settled; R-8 is open, and its row holds what this
document assumes until it is ruled.

| | Question | Ruling |
|---|---|---|
| R-1 | Price, period and sharing on the App Store | One monthly product at the App Store price point nearest $12. No annual product. Family Sharing off. Windmill enrols in the App Store Small Business Program. |
| R-2 | Must a person sign in to buy? | Yes. Windmill One belongs to an account. Everything free stays usable signed out. |
| R-3 | A purchase restored under a different Windmill account | Refused, naming that it belongs to another account. No silent transfer. |
| R-4 | A free trial | None. The free monthly allowance is the trial, and an unpaid period funds nothing. |
| R-5 | A refund | Access and the remaining funded allowance end when the store reports it. Spent allowance is not recovered. |
| R-6 | Sandbox purchases against production | Entitle allowlisted accounts only (§6.2). |
| R-7 | A failed renewal | The 16-day Billing Grace Period is enabled. Access continues in `grace`; no new allowance is funded until the charge succeeds. |
| R-8 | Two live subscriptions on one account | Open. Assumed: both are recorded; access is one; the account screen says the person is charged twice and where to cancel. Applies already to two Apple Accounts bound to one Windmill account, and to every second store. |
| R-9 | A subscription whose account hint names an erased account | Binds to the account that claims it; the erased account no longer exists. R-3 still refuses a claim against a live account. |
