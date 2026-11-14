# subscriptions

The wire shapes of Windmill One's subscription state ([subscriptions.md](../../../docs/foundation/subscriptions.md)
§5). Each file is a golden fixture: every side that writes or reads the shape checks itself against it.

| File | Shape | Written by | Read by |
|---|---|---|---|
| `entitlement.json` | `EntitlementResponse` (§5.2) | the subscription service | the backend |
| `feed.json` | a page of `GET /internal/v1/feed` (§5.2) | the subscription service | the backend's follower |
| `subscription.json` | `SubscriptionResponse` of `GET /v1/subscription` (§5.3) | the backend | iOS, web |
| `app-store-claim.json` | `POST /v1/subscription/app-store/claims` (§5.3): the request and each answer | iOS | the backend |

Each file holds `examples`, a list of `{name, body}` (the claim file adds the request and each answer's
`status`). A name is a state a reader must handle; a test names the example it checks.

- Every key is always present: an absent value is `null`, an empty list `[]`.
- Instants are epoch milliseconds; amounts are decimal strings with an ISO 4217 currency.
- Ids are UUIDs. No fixture holds a store transaction id, a signed payload, an account hint or an email.
- `feed.json`'s `entitlement` in an entry is the account's entitlement after the transaction that recorded
  the entry, so entries recorded together carry the same one; it is `null` exactly when `accountId` is.
  `period` is present exactly on `period_recorded` and `period_refunded`.
