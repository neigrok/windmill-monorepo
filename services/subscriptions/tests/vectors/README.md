# Domain vectors

Each file is one lifecycle story from [subscriptions.md](../../../../docs/foundation/subscriptions.md):
a list of steps, each handing `observe` (§3.4) one observation, or `erase` (§6.4) one account's erasure, and
stating in full what it must produce. Every implementation of the domain passes them; the Rust harness is
[`crates/domain/tests/vectors.rs`](../../crates/domain/tests/vectors.rs).

A file is `{story, steps}`. Every key of a step is always present, with `null` or `[]` when empty. An observation
step holds:

| Key | Holds |
|---|---|
| `note` | What the step tells. |
| `observation` | D-5: `lineage`, `observedAt`, `ownership` (`purchased` or `shared`), `status` with the stated fields of §3.1 flat, and `periods`, the store transactions it states. |
| `hint` | The observation's account hint as the caller resolved it (§4): `"absent"`, `"erased"` or `{"live": accountId}`. |
| `claim` | `null`, or `{claimant, at}` for a claim door call, the claimant as the caller resolved it against the erased accounts: `"erased"` or `{"live": accountId}`. |
| `expect` | `{"refusal": code}`, or the change: the `subscription` (§3.1, with `accessUntil` and the binding), the `periods` it writes (`written`) or restates (`restated`), each with `leftWith`, its `events` in order and `hintForStore`. |
| `entitlements` | Each account's entitlement folded over every subscription the story holds after the step: a `production` and a `sandbox` block of `{plan, accessUntil, governing, others}`, naming subscriptions by id. |

An erasure step holds `note`, `entitlements` as above, `erasure`, `{accountId, at}`, the account the backend erased
and when, and `expect`, the change it makes of each lineage holding anything of the account, in the order of their
subscriptions' ids: `[]` when there is none, as when the erasure is repeated.

A period's `leftWith` is `null` while its events follow its subscription's binding, the account that paid for it
once a new purchase moved its subscription to another (R-11), or `"no_one"` once the account that held it or paid
for it was erased (§6.4).

Instants are written as UTC ISO 8601 (`2027-01-01T10:00:00Z`); the domain counts epoch milliseconds. A
story mints its ids from the store's own: `sub-<storeSubscriptionId>` and `period-<transaction>`.
