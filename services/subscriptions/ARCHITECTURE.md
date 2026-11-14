# Windmill subscription service — architecture

The service that owns every fact about a paid Windmill One subscription. Specification:
[subscriptions.md](../../docs/foundation/subscriptions.md). The repository's layout and its own
dependency rule are in [STRUCTURE.md](../../STRUCTURE.md); this file holds the service's.

The Rust workspace and its four crates exist and are empty. Nothing runs and nothing is deployed:
`subscriptions`, the server binary, exits at once.

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
3. Mint `NewIds` for the observation: a subscription id and one period id for each period it states.
   `observe` uses the ones it needs.
4. Persist the returned `Change` in one transaction: the subscription, each written or restated
   period, and the events in order, which the ledger stamps with `seq` and `recordedAt`. A `Refusal`
   persists nothing.
5. After the commit, write `hint_for_store`, when present, to the store as the account hint.

`verifiedAt` is the sweep's bookkeeping: storage stamps it when it applies a pull, and the domain's
subscription leaves it out, since no single observation can state it (INV-6).

`tests/vectors/` holds the lifecycle stories every implementation of the domain passes, and
`crates/domain/tests/vectors.rs` runs them. `crates/domain/tests/observe.rs` holds the property tests
of INV-4, INV-5 and INV-6.

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
