# End-to-end checks

| File | What it drives |
| --- | --- |
| `auth_differential.py` | `origin/main`'s server beside this branch's, comparing auth responses byte for byte (below) |
| `differential_harness.py` | what a differential shares: throwaway databases, `psql`, and the `origin/main` baseline build |
| `deployment_conformance.mjs` | what engine.md asks of a deployment, directly and through the production Caddyfile |
| `deploy_auth_env_test.py` | that `deploy.yml` forwards the native-auth settings |
| `sync_probe.sh` | the sync engine against `windmill_server_probe` |
| `sync_probe_scoped.mjs` | scoped predictions and receipts against `windmill_server_probe`, driven by the production browser engine: lost replies retried by the same replica and replayed by a new one, the three capture commands, a guarded write, and convergence of every scope |
| `sync_probe_references.mjs` | typed references (E-8) against `windmill_server_probe`, driven by the production browser engine: a sprout answered with the subtree its step already owns carries its queued tree, overlay and grandchild work there, the grandchild's stored `parent` keeps its step, an adopted tag takes a queued mark's key, and every scope converges |
| `sync_probe_undo.mjs` | Undo of an act (K-3) against `windmill_server_probe`, driven by the production browser engine: an opted act's Undo restores both of its scopes through the restore commands across a lost reply, an edit queued after an Undo wins, `probe.unbranch` undoes a branch over the engine's evidence, a held removal cancelled in place is redone, a tag born by an act that keeps no journal and removed before either was sent comes back with the removal's Undo, and every scope converges |
| `sync_roadmap_door.mjs` | roadmap's server door against `windmill_server` with `ROADMAP_ENGINE_ENABLED=1` and its MCP's shared bearer (`WINDMILL_MCP_TOKEN`, `WINDMILL_MCP_USER`): MCP plants a roadmap and steps under requestIds and sends each again, which writes nothing; the browser engine pulls them, and the fork route's copy, sent twice under one requestId, is one copy and reaches it by sync; every scope converges |
| `sync_roadmap_coach.mjs` | Roadmap Coach's records against `windmill_server` with `ROADMAP_ENGINE_ENABLED=1` and its MCP's shared bearer, driven by roadmap's domain on the kit over two browser engines of one account and one of another, each request at the registry's schema: a conversation one browser writes reaches the other and no other account; MCP's `delete_tree` takes it, with its messages, from a browser that never touched the roadmap, and a conversation about every roadmap stays |
| `sync_roadmap_coach_signed_out.mjs` | a signed-out person's Roadmap Coach records at sign-in, against `windmill_server` with `ROADMAP_ENGINE_ENABLED=1`, driven by roadmap's domain on the kit over browser engines that start with no account: a roadmap, a conversation whose turn ended and a pending proposal made signed out reach none of the server until sign-in; Add sends them and the account's own browser draws them, the proposal still pending on the roadmap's id; Discard leaves nothing of them on the server, the account's browser or the browser that discarded them |
| `sync_roadmap.mjs` | roadmap on the sync engine against `windmill_server` with `ROADMAP_ENGINE_ENABLED=1`, driven by the production browser engine under the composed registry: a roadmap with a step carrying a link, a subtree the server plants, a root's visibility and its branch's reach, a kind's recolour, and a step's delete ending its subtree's standing; every scope converges |
| `roadmap_read_models.mjs` | roadmap's read models against `windmill_server` with `ROADMAP_ENGINE_ENABLED=1`, driven by the production browser engine: a roadmap with a subtree, marks and a rename, read back through the activity feed (one line a gesture, by its owner, at the roadmap's seq), the progress a stranger is shown (a step complete because its subtree is, dated when the server received its mark, and what the subtree came to) and the share pages; a deleted owning step hides its subtree |
| `roadmap_adoption.mjs` | production's roadmaps after their adoption, against `windmill_server` with `ROADMAP_ENGINE_ENABLED=1` over a database `windmill_roadmap_adopt` adopted from `test/platform/infra/roadmap_adopt_fixture.sql`, driven by the production browser engine: the owner pulls their roadmaps as adopted, steps in today's order and every scope matching the server's digest; a change lands with the roadmap's seq above its old head and the activity keeping the rooms' lines before it; a reader reads the public roadmap and their own mark, never the owner's pointer |
| `sync_epoch_restore.mjs` | real dump/restore and epoch rotation in both reconnect orders; production-server replicas replay independent/dependent work and retain wrong-incarnation notices; the test-clock composition also covers two starts that joined one session, their shared delete, and applied removals with and without an older acknowledgement |
| `coach_live.py` | opt-in real-provider text setup and independent free/One photo flows on disposable accounts, including USD settlement, ownership, replay and telemetry; `backend/RUNNING.md` names the paid-run controls |
| `anonymous_coach.py` | installation-scoped goal/program/photo, immutable replay, account isolation, bind attribution, individual/global USD pools, first-party events and privacy; supports a local deterministic provider or the manual paid verification below |
| `anonymous_coach_test.py` | maximum accepted photo preserves PNG pixels and stays below the host's in-memory body threshold |
| `journal_echo.sh`, `journal_nudge.sh` | journal echoes and nudges against the local stack |

Each shell and Node script's header names its prerequisites and how to run it.

## Anonymous Coach

`backend.yml` has a manual `verify_live_anonymous_coach` input. It builds the selected commit and
runs one goal, one program and one photo generation against the actual provider using the existing
CI secret, each on a fresh $0.25 lifetime installation. It checks each installation's actual cost
and debt, exact source targets for program/photo, durable replay without another call, no account
training/image writes, bind attribution and local telemetry delivery. There are no automatic model
retries. The verification dispatch publishes no image and retains only bounded `results.json`;
synthetic credentials and private collector data are removed. Keep `verify_live_coach` false.

Local verification uses an isolated database named `wm_anonymous_coach_*`, the production server on
8088, the harness provider on 8097 and the existing TLS observer on 9443. `prepare` creates disposable
accounts, certificates and an installation HMAC key. Start `fixture` and `observe`, configure the
server's `COACH_ANTHROPIC_BASE_URL=http://127.0.0.1:8097`, enable USD allowances/installations and use direct
proxy mode. Then run `verify --provider fixture` with the same database and evidence directory.
The fixture accepts a valid 1 MiB PNG, records only provider metadata, injects charged truncation and
an unknown transport outcome, and exercises a shared free-budget pause. Never reset a fixture while
a native verification client is using it.

The restore harness writes its test clock to a sibling file and renames it atomically. Concurrent
server requests must always read a complete timestamp; truncating the live file can fail a request
and its clock-dependent error response before the next timestamp is written.

## Authentication differential

`auth_differential.py` compares `origin/main` with the current production composition using two
throwaway Postgres databases and persistent raw HTTP sockets on ports 18870–18871. Its databases,
`psql` calls and baseline build come from `differential_harness.py`. Each side's database is built
from its own tree's `db/schema.sql`: the baseline's from `origin/main`, the current server's from
this tree. It builds the baseline in an isolated shared mirror unless `--main-bin` supplies an
already built baseline:

```sh
python3 backend/test/e2e/auth_differential.py \
  --bin-dir /path/to/current/build \
  --main-bin /path/to/origin-main/windmill_server
```

The baseline must have the identical test-only `SystemClock.h` and `WM_TEST_CLOCK=1` instrumentation;
the current build uses `windmill_server_test_clock`. `--drogon-prefix` supplies the pinned Drogon
prefix when the harness builds the baseline. `--maintenance-db` supplies a local Postgres URL with
CREATE DATABASE permission. Both servers and both databases are removed even on failure; server
cleanup resolves listeners by their allocated ports.

The sequence covers email requests for web and `door=app`, malformed inputs, rate limits,
unconfigured-provider failure, successful link/code verification, the legacy cookie transport
options, unknown/expired credentials, wrong-code attempt exhaustion, replay, logout and token
replay after logout. Every case runs with HTTP host-only cookies and HTTPS live/retired domains.
No email provider is contacted: request persistence is checked, then the newest stored code digest
is replaced with a known fixture for verification. Successful provider delivery is outside this
local comparison. Native `sessionTransport=bearer` is a new opt-in and is outside the legacy corpus.

Status and body bytes compare exactly. Set-Cookie field lines retain their original header case,
spacing, attribute order, scope, flags and line endings; only the independently minted 43-byte live
session secret is substituted. The minted secret must authenticate the same seeded account and
exist in its database. Logout and failure cookies have no substitutions.
Comparator tests reject body reformatting, cookie attribute changes, reordered lines and broader
entropy normalization.
