# subscriptions

The wire shapes of Windmill One's subscription state ([subscriptions.md](../../../docs/foundation/subscriptions.md)
§5). Each file is a golden fixture: every side that writes or reads the shape checks itself against it.

| File | Shape | Written by | Read by |
|---|---|---|---|
| `entitlement.json` | `EntitlementResponse` (§5.2): one `Entitlement` per environment | the subscription service | the backend's follower and claim door |
| `feed.json` | pages of `GET /internal/v1/feed` (§5.2) | the subscription service | the backend's follower |
| `internal-app-store-claim.json` | `POST /internal/v1/app-store/claims` (§5.2): the request and each answer | the backend's claim door (request), the service (answers) | the service (request), the backend's claim door (answers) |
| `subscription.json` | `SubscriptionResponse` of `GET /v1/subscription` (§5.3) | the backend | iOS, web |
| `app-store-claim.json` | `POST /v1/subscription/app-store/claims` (§5.3): the request and each answer | iOS (request), the backend (answers) | the backend (request), iOS (answers) |

Each file holds `examples`, a list of `{name, body}`; the feed adds each page's `request` (`after`,
`limit`), and the claim files add the one `request` and each answer's `status`. A name is a state a
reader must handle; a test names the example it checks.

- Every key is always present: an absent value is `null`, an empty list `[]`.
- Instants are epoch milliseconds; amounts are decimal strings with an ISO 4217 currency.
- Ids and the feed's `epoch` are UUIDs. No fixture holds a store transaction id, a signed payload, an
  account hint or an email.
- The `entitlement.json` examples are entitlements the feed carries (`active` is the one at `seq` 3,
  `revoked` at 15, `sandbox_active` at 13, `grace` at 18, `on_hold` at 19, `cancelled_access_continues`
  at 24, `expired` at 25, `never_subscribed` at 26), plus three no page reaches:
  `sandbox_active_production_expired`, `charged_twice` and `charged_by_two_stores`.
- The feed pages of epoch `c09a3ab3-…` chain into one ledger of 26 events: each page's `after` is the
  last `seq` of the one before, `seq` 8 is skipped, and `from_zero` ends inside the transaction a
  claim recorded (`bound` at 6, its `period_recorded` at 7). `ledger_restored` is the same read after
  a restore: a new `epoch` and a `latestSeq` below the reader's cursor.
- A feed entry's `entitlement` is the account's entitlement after the transaction that recorded the
  entry, so entries recorded together carry the same one; it is `null` exactly when `accountId` is.
  `period` is present exactly on `period_recorded`, `period_refunded` and `period_refund_reversed`.
- The claim examples belong to the feed's claim: `internal-app-store-claim.json` answers `seq` 7 and
  the entitlement it carries, and `app-store-claim.json` answers the `SubscriptionResponse` that copy
  shows.
