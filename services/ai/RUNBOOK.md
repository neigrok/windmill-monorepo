# Operating the AI service

The [architecture](ARCHITECTURE.md) explains ownership and recovery. The
[contract](../../docs/foundation/ai-service.md) defines every refusal and wire shape. Production
provisioning, image pins, proxy routes and backups belong to the
[deployment runbook](../../backend/deploy/README.md).

## Build and local checks

Run from `services/ai`. Rustup reads the pinned toolchain. Tests use simulated providers and never
need a provider key. Set `AI_TEST_DATABASE_URL` to a disposable PostgreSQL cluster whose test role
may create databases before running the complete suite. The database cases create separate test
databases; the full suite requires PostgreSQL.

```sh
./check-dependencies.sh
cargo fmt --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build --locked --bin windmill-ai
python3 tests/operations/process_review.py --binary target/debug/windmill-ai -v
```

Bound the complete run with the test runner's timeout; CI also has job deadlines. For checks that
need no database, run `cargo test -p ai-domain -p ai-providers --locked`. The process probes also
need `psql`, `pg_dump` and `openssl` on the path.

Build and probe the shipping image from the same directory:

```sh
docker build -t windmill-ai:local .
bash tests/operations/image_smoke.sh windmill-ai:local
```

The image probe creates and removes its own network and containers, publishes no host port, and
keeps caller admission closed. CI runs this same script.

The wire corpus and pass vectors live in `packages/api-contract/ai`. From the repository root, run
`python3 packages/api-contract/ai/passes/generate.py --check`,
`python3 packages/api-contract/ai/wire/generate.py --check` and
`python3 packages/api-contract/ai/check.py`. The checker validates states and required fields
separately from serialization tests.

## Start locally

Create a separate `windmill_ai` database and login role; do not point the service at the product or
subscription database. Migrations run before the listeners open. Store local configuration in
the ignored `.env.local`, load it into the environment, then run:

```sh
cargo run --locked -p ai-server --bin windmill-ai
```

| Variable | Meaning |
|---|---|
| `AI_ENVIRONMENT` | `development` locally; `production` on the host |
| `AI_DATABASE_URL` | The AI role's PostgreSQL URL |
| `AI_PUBLIC_ADDRESS` | Public listener, default `0.0.0.0:8084` |
| `AI_INTERNAL_ADDRESS` | Internal listener, default `0.0.0.0:8085` |
| `AI_PASS_KEYS` | JSON object mapping key IDs to unpadded base64url Ed25519 public keys; `{}` admits nobody |
| `AI_CARRY_KEY` | Unpadded base64url encoding of 32 random bytes |
| `AI_FUNDING_SECRET` | A secret of at least 32 characters for grant operations |
| `AI_OPERATOR_SECRET` | A different secret of at least 32 characters for inspection and correction |
| `AI_ANTHROPIC_KEY` | Optional service-owned text provider key |
| `AI_OPENAI_KEY` | Optional service-owned live transcription key |
| `AI_AZURE_KEY`, `AI_AZURE_URL`, `AI_AZURE_DEPLOYMENT` | Azure credentials, WebSocket endpoint and deployment when the tier table selects Azure |
| `AI_ANTHROPIC_URL`, `AI_OPENAI_URL` | Provider endpoints; production defaults are built in |
| `SENTRY_DSN`, `SENTRY_RELEASE` | Reporting destination and source revision |

Unencrypted provider endpoints are accepted only on loopback in development. Do not put a private
signing key in the server environment. Only the offline signer needs `AI_PASS_PRIVATE_KEY`; its
input is the exact JSON payload on stdin and its argument is the key ID:

```sh
cargo run --locked -p ai-pass-signer --bin pass_signer -- test-local < payload.json
```

The signer prints a credential: consume it locally, never paste it into logs, issues or reports.
The published development key in the pass corpus cannot open production, including under an alias.
A dark local service needs no signing or provider key. Both `/health` routes should return
`{"status":"ready"}`; an unauthenticated public call returns `pass_missing`. An internal path on
the public port returns 404.

## Investigate a call

Use the internal listener over the container network. Supply the operator bearer through a secret
environment or a private client configuration, never in a shared command transcript. Public
requests use passes; neither internal bearer works as a public pass.

1. Start with the caller's `callId`. Read `GET /internal/v1/calls?callId=<callId>` with the operator
   secret. If `nextBeforeId` is non-null, pass it as `before` on the next request. Match the
   principal only within this protected response; logs intentionally contain neither identifier.
2. Read `GET /internal/v1/calls/<id>` using the service's numeric ID. It reports the pinned tier,
   model, price version, reservation, usage, state and charge. Find the completion log by this ID.
3. Read `GET /internal/v1/principals/<kind>/<id>` for that principal's budgets, grants, bindings and
   calls. Use `GET /internal/v1/budgets` for the free pools and provider fuses.

A refused call has no ledger row. Investigate its bounded refusal code and time window instead.
`subject_exhausted` names the principal's own allowance; `free_day_exhausted` and
`free_month_exhausted` name shared budgets; `funding_required` means the effective tier lacks the
capability. `paused` names an open provider fuse. A positive allowance does not mean a particular
request's reservation fits.

`reserved` has not been sent. `dispatched` may have reached the provider. `settled` uses measured
usage; `unconsumed` costs zero; `assumed` spends the reservation. A null charge in a streamed answer
means the settlement response window expired, so read the durable call again after storage recovers.
Never send a new call ID merely to retrieve an answer already paid for: use the result route. A
410 result means the in-memory answer expired or was lost; it does not refund or replay the call.

## Correct an assumed call

List `GET /internal/v1/calls?state=assumed&since=<epoch-ms>` and follow all pages. Establish the true
cost from the provider's accounting using the protected provider request ID. Do not infer a refund
from a missing transcript or a disconnected caller.

Send `POST /internal/v1/calls/<id>/correct` with `{"charged":"<exact USD>"}` and the operator
secret. Read the call and its budgets again. The original charge remains visible; only the
difference moves through the original pinned budgets. Repeating the same correction is safe.
Funding credentials cannot use this route. Do not repair sums with direct SQL.

## Fund, close and reopen

The funding bearer can use only the grant routes. Fund with
`PUT /internal/v1/grants/<reference>` and
`{"accountId":"<opaque id>","plan":"one","period":{"start":<ms>,"end":<ms>}}`.
Keep the funding reference stable on retries. `replay` confirms the same account and period;
`conflict` funds nothing and needs investigation at the funding source.

Close with `POST .../<reference>/close` and `{"closedAt":<ms>}`. Reopen with
`POST .../<reference>/reopen`. An unknown reference returns `not_found`. A reopen that overlaps
another subscription grant returns `conflict`. Closing capacity never moves an already admitted
call into another grant. These routes manage subscription grants; owner grants are created only
by verified owner access under the monthly cap.

## Change policy or rotate credentials

Change tier limits, model mappings and prices through a reviewed configuration diff. Record the
source and date for every rate and provider count bound, advance the price version when rates
change, run the policy and accounting tests, then build a new image. A price is per token or per
minute as its field states; do not paste a per-million-token price into a per-token field.

Rotate a pass key by pinning the new public key before the issuer signs under it. Keep the old
public key through its last pass's expiry, then remove it. Production rejects `test-` key IDs and
every published test-key fingerprint. Treat every production private signing key as spending access.

Rotate a provider key only in this service's secrets, then restart on the reviewed configuration.
An empty provider key leaves its capability unavailable. Azure is selected by a tier-table change;
there is no automatic failover. Changing the carry key makes earlier carry unreadable; callers'
visible message parts remain usable, subject to the provider accepting rebuilt history.

## Shutdown, recovery and acceptance

SIGTERM closes admission, cuts live sessions through their normal accounting close, and allows text
calls to finish for `DRAIN`. Existing result reads remain available during the drain. Container stop
grace must exceed `DRAIN`; CI checks that relationship. A forced kill loses memory-only results and
leaves the next startup sweep to settle abandoned calls conservatively.

When PostgreSQL is unavailable, new work fails closed. Existing provider reads continue, and their
accounting owners retry settlement. Losing the advisory-lock session disables mutations until
ownership is restored. A second process cannot serve while another holds that lock. Restore the
AI database independently using its own backup; no product database join is needed.

Before admitting people, complete the roadmap's real-provider acceptance gates with explicitly
authorized spending: text, tool continuation, schema output, truncation and disconnect checks;
live audio rounding and billing comparison at OpenAI and Azure; production health, isolation,
logs and Sentry; and delivery of the owner's alert rules. The price book records whether the
transcription billing rule has been checked against a real bill. Local simulated-provider tests
establish no claim about that bill or production alert delivery.

Configure alerts for `budget.threshold`, `provider.fuse`, assumed accounting, reservation excess,
owner funding refusal, provider credential refusal and `provider.busy`. The last reports a
three-minute busy streak with gaps no longer than a minute, and resets after recovery or a longer
gap. Database errors use static `ledger.*` operations and are reported at most once per operation
per minute. Test each with harmless controlled fixtures
and confirm delivery with the owner. Never include a prompt, pass, principal ID or provider key in
the acceptance record.
