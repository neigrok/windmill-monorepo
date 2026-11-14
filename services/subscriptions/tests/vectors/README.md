# Observation vectors

Each file is one lifecycle story from [subscriptions.md](../../../../docs/foundation/subscriptions.md):
a list of steps, each handing `observe` (§3.4) one observation and stating in full what it must produce.
Every implementation of the domain passes them; the Rust harness is
[`crates/domain/tests/vectors.rs`](../../crates/domain/tests/vectors.rs).

A file is `{story, steps}`. Every key of a step is always present, with `null` or `[]` when empty:

| Key | Holds |
|---|---|
| `note` | What the step tells. |
| `observation` | D-5: `lineage`, `observedAt`, `ownership` (`purchased` or `shared`), `status` with the stated fields of §3.1 flat, and `periods`, the store transactions it states. |
| `hint` | The observation's account hint as the caller resolved it (§4): `"absent"`, `"erased"` or `{"live": accountId}`. |
| `claim` | `null`, or `{accountId, at}` for a claim door call. |
| `expect` | `{"refusal": code}`, or the change: the `subscription` (§3.1, with `accessUntil` and the binding), the `periods` it writes (`written`) or restates (`restated`), its `events` in order and `hintForStore`. |
| `entitlements` | Each account's entitlement folded over every subscription the story holds after the step: a `production` and a `sandbox` block of `{plan, accessUntil, governing, others}`, naming subscriptions by id. |

Instants are written as UTC ISO 8601 (`2027-01-01T10:00:00Z`); the domain counts epoch milliseconds. A
story mints its ids from the store's own: `sub-<storeSubscriptionId>` and `period-<transaction>`.
