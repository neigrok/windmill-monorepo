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
