# subscriptions

The wire shapes of Windmill One's subscription state ([subscriptions.md](../../../docs/foundation/subscriptions.md)
§5). Each file is a golden fixture: every side that writes or reads the shape checks itself against it.

| File | Shape | Written by | Read by |
|---|---|---|---|
| `entitlement.json` | `EntitlementResponse` (§5.2): one `Entitlement` per environment | the subscription service | the backend's follower and claim door |
| `feed.json` | pages of `GET /internal/v1/feed` (§5.2) | the subscription service | the backend's follower |
| `account.json` | `GET /internal/v1/accounts/{accountId}` (§5.2): the entitlement and each subscription bound to the account, with its periods and events | the subscription service | operators |
| `internal-app-store-claim.json` | `POST /internal/v1/app-store/claims` (§5.2): the request and each answer | the backend's claim door (request), the service (answers) | the service (request), the backend's claim door (answers) |
| `internal-subscription-refresh.json` | `POST /internal/v1/subscriptions/{subscriptionId}/refresh` (§5.2): the id the path names and each answer | the service (answers) | operators |
| `subscription.json` | `SubscriptionResponse` of `GET /v1/subscription` (§5.3) | the backend | iOS, web |
| `app-store-claim.json` | `POST /v1/subscription/app-store/claims` (§5.3): the request and each answer | iOS (request), the backend (answers) | the backend (request), iOS (answers) |

Each file holds `examples`, a list of `{name, body}`; the feed adds each page's `request` (`after`,
`limit`), the account read each read's `request` (`accountId`), and the claim and refresh files add the one
`request` and each answer's `status`. A name is a state a
reader must handle; a test names the example it checks.

`generate.py` writes every file from one modelled ledger, so a change is made there, never in the JSON:
regenerate with `python3 generate.py`, and `python3 check.py` must pass. `check.py` holds the shapes
and the spec's rules. Subscriptions CI (`.github/workflows/subscriptions.yml`) runs
`python3 generate.py --check`, which fails when a file is not what the generator writes, and
`python3 check.py` on every change here. Both need only Python 3's standard library.

- Every key is always present: an absent value is `null`, an empty list `[]`.
- Instants are epoch milliseconds; amounts are decimal strings with an ISO 4217 currency, written
  with that currency's minor units: `12.00` USD, `1800` JPY, `3.990` KWD.
- Ids and the feed's `epoch` are UUIDs in their canonical spelling: lowercase hex, hyphenated, as
  `3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61`. A door that takes an id in its path takes only that
  spelling: `GET /internal/v1/accounts/{accountId}` answers 400 `{"code":"invalid_account_id"}` to an
  upper-case, braced, unhyphenated or `urn:uuid:` one. No fixture holds a store transaction id, a
  signed payload, an account hint or an email.
- The `entitlement.json` examples are entitlements the feed carries (`active` is the one at `seq` 3,
  `revoked` at 16, `sandbox_active` at 13, `grace` at 19, `on_hold` at 20, `cancelled_access_continues`
  at 25, `expired` at 26, `never_subscribed` at 27), plus three no page reaches:
  `sandbox_active_production_expired`, `charged_twice` and `charged_by_two_stores`.
- The feed pages of epoch `c09a3ab3-…` chain into one ledger of 27 events: each page's `after` is the
  last `seq` of the one before, `seq` 8 is skipped, and `from_zero` ends inside the transaction a
  claim recorded (`bound` at 6, its `period_recorded` at 7). `ledger_restored` is the same read after
  a restore: a new `epoch` and a `latestSeq` below the reader's cursor.
- A feed entry's `entitlement` is the account's entitlement after the transaction that recorded the
  entry, so entries recorded together carry the same one; it is `null` exactly when `accountId` is.
  `period` is present exactly on `period_recorded`, `period_refunded` and `period_refund_reversed`.
- The `account.json` examples are the feed's accounts read from its ledger: `expired` is the buyer's at
  `seq` 26, `claimed_then_refunded` the claimant's and `sandbox` the tester's from seq 16 on, and
  `holds_nothing` the buyer's after the erasure at 27. Each subscription carries the entitlement's fields
  of it, then `environment`, `boundAt`, `boundBy`, its `periods` by start as their newest events state
  them, and every event of it as the feed carries it, `{seq, type, occurredAt, recordedAt, accountId,
  period}`, whichever account each was told under.
- The claim examples belong to the feed's claim: `internal-app-store-claim.json` answers `seq` 7 and
  the entitlement it carries, and `app-store-claim.json` answers the `SubscriptionResponse` that copy
  shows. `internal-subscription-refresh.json` refreshes the buyer's subscription once the feed is told, and
  answers its newest event's `seq`.
- A refusal is `{code}`, and each file has one example of every refusal its door answers. Every 503 of the
  internal claim and the refresh means the same to a reader, try again later; its code, `unavailable`,
  `store_unavailable` or `store_api_unavailable`, tells an operator why.
