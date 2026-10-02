# Production write differentials

## Journal

`journal_write_differential.py --mode off-vs-on --bin-dir /path/to/build` compares the production composition with
`JOURNAL_ENGINE_WRITES=0` against the admitted writer after journal backfill. It creates and drops
two isolated databases and runs `windmill_server_test_clock` on free ports in 18950–18999. The
legacy side uses plain `schema.sql`; the admitted side additionally uses `journal_sync.sql`.
`--maintenance-db` needs CREATE DATABASE permission; `--image` uses the tested CI builder for both
servers and the backfill. Cleanup stops every server and drops every database even after failure.

`--mode main-vs-off --drogon-prefix /path/to/pinned/drogon` is a local pre-merge gate, not a CI step.
It builds `origin/main`'s `windmill_server` in its own build directory from a temporary worktree
owned by a shared mirror, using the same baseline builder and cleanup as gym. The identical test
clock header and its server compile definition are the only baseline changes; the SHA and patch
remain in the temporary evidence directory. B runs this branch's test server with both journal
switches off. Both databases use plain `schema.sql` with identical data. The full unfrozen REST
sequence must compare byte-for-byte with zero allowed differences; admission audits, unadopted
refusals and the freeze sequence run only in off-vs-on. Cleanup removes the baseline worktree and
mirror as well as both servers and databases.
Before seeding, this mode disables `journal_page` autovacuum in both disposable databases so
independently timed automatic analysis cannot change the planner's order within HLC ties.

The main-vs-off gate includes separate reverse-inserted and later-updated equal-HLC cohorts. The
later cohort is updated through real REST saves in reverse day order. Each compares complete
since reads, limit=1 and limit=2 responses and strict cursor exclusion. Cohort membership and
stamps are asserted, while the baseline determines the tie order. Each limit=1 baseline must pick
a different day from the day-ascending tie-break, ensuring these fixtures expose the regression.
The report retains the observed full and limited orders. Off-engine reads keep main's three-HLC
column query exactly; admitted reads add the day tie-break.

Both servers explicitly set the journal/gym engine and freeze switches, vendor keys, echo embedder,
owner list, nudge arming and admin tokens. They share the controlled C++ clock file and identical
disposable SQL clocks used by the gym differential. Every paired request advances both clocks by
1,000 ms and compares status, body and application headers exactly. No body values, timestamps,
JSON formatting, field order, numeric encodings or generated identities are normalized. Each
Content-Length is checked independently. Only Date, Connection and Keep-Alive are excluded.
Comparator regression cases reject timestamp, field order, numeric encoding, array order, ETag,
framing and switch drift. Immutability checks include each row's `xmin` and `ctid`, so a no-op
UPDATE cannot pass as unchanged.

The seed includes written, blank, empty and revisions-only accounts; null and zero scores; spoken
source; `0:0:` and future content stamps; duplicate stamps; duplicate revision bodies; expired
revisions and archive-time ties; echo pairs, nudge suppression and mail secrets. A dedicated
1,002-page account crosses the HLC-since default 500 and maximum 1000 limits, numeric parsing
boundaries and strict cursor endpoints before writes and under freeze. Before writes, the
backfill's dry run and second run must leave all journal and sync rows unchanged. The independent
frozen-source envelope audit and corruption rejection gate run immediately after adoption. After
admitted writes, `--audit-current` independently checks feed digests, high sequences and real
null-cursor boots.

The sequence covers every registered journal write route and retries it with the same request ID:
page replacement/defaults/normalization, strict stale and equal-stamp losses, HLC actor ties,
calendar and UTF-8 byte limits, score-only and duplicate-body revisions, blank-page transitions,
first admissions, every echo feedback/offer route, nudge settings/suppression/pause/unsubscribe,
admin echo/nudge sweeps and transcription's signed-out, free-account and unconfigured-vendor
refusals. Echo derivation and transcription vendors stay unconfigured; paid vendor successes are
covered by their adapter tests. Every read route follows writes, including range, export,
HLC-since precedence/limits and operator diagnostics. Retained legacy revision projections also
compare exactly, including pruning to ten per day and removing expired history after insertion.

Both servers restart with `JOURNAL_WRITE_FREEZE=1`; every registered mutation must return exactly
503 `journal-frozen`, including malformed and unauthenticated requests. Reads still compare and
all journal/sync rows must remain unchanged. A real signed shared Resend suppression webhook is
also checked before and during freeze; its frozen 503 changes no suppression row. Source route
inventory makes any uncovered read, write or frozen mutation fail. The production composition
must return 404 for `/v1/sync/hello`.
A separate admitted-side check confirms two `journal-not-adopted` refusals leave an unadopted
account and its absent scope unchanged before adopting it.

There are **no intended D-level differences** in either journal differential. The two 503
safety cases apply only while frozen or before account adoption and are asserted separately.
Failure bodies, migration/audit reports and server logs remain in the printed temporary evidence
directory. CI's Postgres job runs off-vs-on alongside gym's.

## Legacy authentication

`auth_differential.py` compares `origin/main` with the current production composition using two
throwaway Postgres databases and persistent raw HTTP sockets on ports 18870–18871. It builds the
baseline in an isolated shared mirror unless `--main-bin` supplies an already built baseline:

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
exist in its database. Logout and failure cookies have no substitutions. Comparator tests reject
body reformatting, cookie attribute changes, reordered lines and broader entropy normalization.

## Gym

`gym_write_differential.py --bin-dir /path/to/build` creates two throwaway Postgres databases,
seeds identical accounts and authentication (RUNNING.md §5), starts two real server
processes built from the production composition on free loopback ports in 18900–18949, and backfills B
before enabling its engine doors.
A uses only `schema.sql`; B also uses `gym_sync.sql`. All processes and databases are removed in
`finally`, including failed runs. `--maintenance-db` supplies a Postgres URL with CREATE DATABASE
permission. The local build must include `windmill_server_test_clock`; production
`windmill_server` never honours the test clock environment. CI passes the tested builder to `--image`;
the script starts both server containers
with host networking and runs the same backfill binary in that image. CI runs off-vs-on;
main-vs-off is a local gate using a temporary baseline worktree.

Before B is adopted, the legacy server creates and corrects an imported workout and deletes one
of its sets. Its exact rows and legacy receipts are copied into B. The sequence replays that
import and correction over both doors, including the deleted set, proving that C.5 receipts still
answer the same way after backfill. Conditional session reads also compare 304s and require a
changed ETag after a correction with unchanged set count.

The sequence covers routine creation/replacement/order/deletion, custom and seed renames with
aliases, all session and set writes (including corrections and deletions after finish), imports,
notes and ordering, bodyweight ordering and recreation, whole preferences, proposal replacement,
supersession, both settlement decisions and their conflicts. It also exercises workout/log shares,
attachment upload, generation stop, conversation deletion, and the unconfigured Coach refusal.
Every write is retried with the same identity, JSON-RPC ID and X-Request-Id. Those headers do not
invent a platform idempotency contract: gym uses its caller-minted resource IDs and correction
`requestId`. REST writes are followed by reads of all aggregate collections; MCP reads include
single/batch session history, reviews, last-time and statistics. The served MCP catalog and source
write route inventory must be fully covered or the run fails. New Coach generation requires a
vendor key and is intentionally unconfigured here; its route's real 404 is covered.

`--mode main-vs-off --drogon-prefix /path/to/pinned/drogon` builds `origin/main`'s
`windmill_server` in its own build directory from a temporary Git worktree. The worktree
belongs to a temporary shared mirror, so the source repository's Git metadata stays untouched.
The harness copies the identical test clock header and enables its compile definition on the
baseline server; these are the only baseline source changes, saved as an evidence patch beside
the baseline SHA. B uses this branch's test server with both switches off. Both databases use
plain `schema.sql`; the full sequence, including the D1/D2 scenarios and all Coach paths that
need no vendor key, must compare equally with zero allowed differences. Cleanup removes the
worktree, mirror, processes and databases even after failure.

Both modes use one clock file for C++ and one clock value in each disposable PostgreSQL database.
The harness advances this clock by exactly 1,000 ms before each paired request, updates both
SQL clocks, then sends both requests without changing time between them. A harness-owned
`public.now()` and explicit `search_path=public,pg_catalog` control SQL defaults and calls to
`now()`; this function and clock table exist only in these disposable databases. No production
schema or clock implementation changes. Seed timestamps, all persisted timestamps, history
event times and projection `asOf` compare exactly. Observed persisted timestamps must also never
move backwards. Regression tests reject seed drift, opposite timestamp changes, backwards
changes, and accidentally enabling the second server in the main comparison.

Comparison preserves JSON key order, whitespace, array order, numeric encoding, error text and
the text JSON inside MCP results. It substitutes only independently random values generated by
the requests: MCP transport session IDs, newly minted note IDs, and share tokens (including
references in URLs). These use paired stable aliases, mapped back for subsequent requests;
caller IDs stay exact. Pairing must remain one-to-one, generated values must have equal lengths,
and replays must preserve each alias. This allows independent entropy while detecting changed
identity, reuse, ordering, replay stability, caller identity or token-format length. No timestamps
are normalised. Binary attachment bodies remain byte-exact.

Application headers, ETag and Content-Length compare exactly; each Content-Length is independently
checked against the received body. Date, Connection and Keep-Alive are excluded because Drogon's
transport wall clock and connection budgets run outside the injected application clock. They cannot
mask application timestamps or response body/framing differences, which are checked independently.
The explicit D1/D2 rulings validate each body's length independently because their asserted
business differences produce different body lengths; D1 also asserts each differing status's
expected content type. Failure evidence includes both comparison
bodies and the server logs in the printed temporary directory.

Owner rulings have explicit assertions, followed by collection reads:

- D1: recreating a deleted routine or note succeeds in A; B returns 409 `routine-id-taken` or
  `note-id-taken`, on both initial call and retry. The recreated A row is removed before reads
  resume, so both stores converge again.
- D2: retrying a start that joined a finished workout while another is open answers the current
  open workout in A; B answers the original joined workout. Both retries must match that ruling;
  subsequent reads still match because B creates no extra workout.
- D3: door/replica weigh-in ordering requires a replica. This test has no replica, so D3 cannot
  arise; the ordinary newer/older `recordedAt` door behavior is compared exactly.
