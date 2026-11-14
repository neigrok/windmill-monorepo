# Windmill subscription service — architecture

The service that owns every fact about a paid Windmill One subscription. Specification:
[subscriptions.md](../../docs/foundation/subscriptions.md). The repository's layout and its own
dependency rule are in [STRUCTURE.md](../../STRUCTURE.md); this file holds the service's.

The Rust workspace and its four crates exist; `domain`, `app_store` and `storage` are empty.
`subscriptions`, the server binary, answers health on both of its listeners (see [Server](#server)).
Nothing is deployed.

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
