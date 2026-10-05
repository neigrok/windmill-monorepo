# Android sync foundation

A1 provides the Kotlin sync engine, domain kit and gym domain surface. The Gradle build enforces
client and kit corpus coverage, mandatory properties, replay fault coverage, schema freshness and
strict layering. A2 now composes that engine into the shipping gym, migrates the device stores and
uses engine account decisions. See [A2 verification](A2_VERIFICATION.md) for the current app gates.

## A1 module baseline

There are 12 Gradle projects: eight JVM modules, Android `:sync-engine`, and `:app`, `:platform`,
`:gym`. Kotlin source lines below include comments and blanks, exclude build output, and include
generated schema. The schema generator and its tests contain 356 Python lines.

| Module | Main lines | Test lines |
|---|---:|---:|
| `:sync-core` | 1491 | 0 |
| `:sync-api` | 121 | 239 |
| `:sync-schema` | 1669 | 0 |
| `:sync-engine` | 3252 | 2496 |
| `:sync-testing` | 1758 | 1469 |
| `:sync-model-server` | 1298 | 82 |
| `:domain-kit` | 1075 | 470 |
| `:domain-kit-testing` | 752 | 651 |
| `:gym:domain` | 1014 | 1226 |
| Total | 12430 | 6633 |

SyncAPI's public surface is unchanged from `c1e1125b`. `ActionRunner` now requires an injected
`ActionContext`: the synchronous pure kit reads its nesting flag through that port. The testing
coroutine-context element and entry helper live in `:domain-kit-testing`; the shipping adapter is
`gym/store/GymActionContext.kt`. Child contexts copy the flag, dispatcher hops retain it, and
independent entries are isolated. No coroutine owner exception is used.

The engine has normalized device, stable replica-handle, row-set, row/reference, spent, cursor,
known-scope, outbox/touch, notice and device-row storage. Staging swaps and forgetting/purging
release row sets atomically; deletion follows in bounded transactions. A fair lock serializes
writes. Each pull chunk rechecks its replica, subscription/known scope and requested cursor inside the
transaction. Pull chunks, settling slices and push result batches adapt to measured writer time,
including metadata persistence and commit. The crash hook stops after a durable transaction,
before publication; a body failure still rolls back. Corpus crash budgets use deterministic slices.
Deleting the last device key removes its empty product map, matching journal vectors and SQLite.

Records views expose loading/loaded states, retain their last snapshot on a same-account read failure,
retry, share weak cached identities and update affected records. Each refresh covers an invalidation
version and replica; an advance before acquiring the writer forces a full read. Publication stays
under the writer lock. Replica/account transitions clear cached record snapshots before a new read,
including failed reads. HTTP hello/push/pull and bounded live frames
use strict JSON, account checks and cancellation. The runtime owns sender/puller/live workers,
request deadlines, server waits, backoff, heartbeat, holds, subscriptions and cleanup. Sign-in/out
sessions pin decisions, account and hold generation. Lineage, fork guards, reidentification, epoch
changes, refusal folding, restamping, write maps and command-result/device hooks are transactional.

The release timer retries recoverable commit failures after a fixed, bounded one-second delay and
preserves cancellation. Removal predictions stamp life dead, retain a minted/derived record's born,
and carry no born for keyed records. Seven deterministic public-path regressions cover the queued
partial-refresh/sign-out race, clearing snapshots when the new account's read fails, three failed
release transactions followed by a real push, shutdown during release backoff, and ActionRunner
removals through ApplyProposal, CorrectSession and a non-wholePut keyed test binding. Each removal
case checks offline drawn state, server acceptance/settling and refusal rollback. The seven tests
failed before their fixes.

Keyed predictions carry the drawn life when their presence does not change, matching Swift.
Refusal and held Undo fold commands whose predictions inherit the source's life, including
transitive predictions, while preserving unrelated intent deltas. Four public-path regressions
cover intent and predicted deletions, restored confirmed-alive rows, records views and notices.

The JVM model server implements probe, gym and journal bindings. Step mode drives the production
engine's sender/result batches and puller/page chunks/settling, with virtual clocks and transport.
Step mode leaves sender waits pending until the caller advances its virtual clock; timed-out pulls
retry, and live/pull answers remain bound to the requested replica across lineage changes. Live
channels close on replica renewal, leave, authentication pause and shutdown.

Gym consumes registry v5/minimum 4. The model server authors routine revision/original count,
proposal base revision/name/change count, note content time and immutable Coach creation snapshots.
The gym domain decodes that metadata without including it in client fields, plans or guards;
`RoutineCreation` is an independent read-only entity. Note positions are dense ranks from zero;
held notes keep their stored rank until removal is released.

The network simulator covers all required faults and engine paths, served-principal isolation,
active-replica announcements, every seat's draining, admission/view equality, caps, digests, access
and non-resurrection. Journal fuzz independently tracks document winners through reordered saves,
claim replay/conflict, blanks and future content, and checks full pages, digests, clocks and audit
retention after every admission. Neither simulator implements client reconciliation.

Telemetry defaults to no-op, uses bounded 64-event drop-oldest queues and a 2s cooperative sink
deadline, and never waits in the writer. Only operation/outcome enums and allowlisted static codes
are emitted; no content, token, account or raw exception message enters events. Storage, transport,
lifecycle/cancel and shutdown expose injected hooks. Diagnostic/testing histories retain at most
1024 entries. Delivery may drop events on overflow/shutdown. The app supplies Sentry/event adapters
through `Telemetry`.

## A1 gate baseline

The following counts record the foundation commit; current A2 results live in
[A2 verification](A2_VERIFICATION.md).

Run from `apps/android`, with `ANDROID_HOME` pointing to the SDK:

```sh
export JAVA_HOME="$HOME/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_SENTRY_DSN=https://local-check@telemetry.invalid/1
./gradlew build --max-workers=4
./gradlew :sync-testing:conformance :sync-testing:serverCorpus :domain-kit-testing:corpus --max-workers=4
python3 tools/schema_gen.py --check
```

| Gate | Verified result |
|---|---|
| Full build | `./gradlew --max-workers=4 build`: green in 2m6s; 463 tasks (13 executed, 450 up-to-date). App/platform/gym debug+release assembly and normal lint pass. |
| Client corpus | 52/52 files, 740/740 cases, 0 unclaimed. All seven protocol transcripts generate requests through Engine, use actual model replies, and compare client returns and final devices/ended/server state. JSONL transcripts each count once. |
| Server corpus | 27 server-role files / 748 cases, plus 7 protocol transcripts. |
| Kit corpus | 12/12 files, 475/475 cases, 0 unclaimed. Gym domain corpus: 5/5 files, 56 cases. |
| API and engine | API 13/13; engine 134/134 per debug/release variant, 0 skips/errors/failures. Includes native SQLite on SDK26/27/28/29/35 and transport/runtime failure paths. |
| Kit and model units | Kit 24/24; kit-testing 507/507; gym-domain 62/62; model-server 5/5. |
| Test execution | Sync-testing: 1494/1494 ordinary tests + 258/258 mandatory-property tests, 0 skips/errors/failures. App: 35/35 and platform: 92/92 per variant; gym: 1264 tests per variant, 12 existing ignored tests each, 0 failures. |
| Properties | P1/P3/P4/P5/P6/P7/P8: 128 distinct seeds each. P1: 147456 law assertions; P3: compares drawn after each result and pull; P4: 32768 admissions; P5: 32768 order assertions; P6: 32768 digest assertions; P7: 16384 merges / 43582 token-occurrence checks; P8: frozen-server-clock recovery under holds, undo, retire, keyed carriers, orphans, later writes, epochs and 409. |
| Network replay | 128 seeds × 128 steps / 130425 entries checked; all 56 events produced. Five seeds × 128 steps × 2 runs pass deterministic equality. Thirty 60×60 coverage surveys (first seeds 1,1001,…,29001) pass with 0 misses; minimum mean producing seeds: 22.533333333333335 (floor 10). |
| Journal replay | 60 seeds × 160 steps: 9600 steps, 4829 replica / 4771 server origins; 7 journal paths plus 4 failure events. 118 rollbacks, 136 committed crashes, 109 unauthorized replies, 624 lost replies. Thirty 60×160 coverage surveys pass with 0 misses; minimum mean producing seeds: 51.56666666666667. Deterministic replay passes. |
| Layering | Each suite 4/4; 5 deterministic modules / 376 compiled classes / 0 findings. 12 projects / 8 JVM modules; 8 rejected model attacks each. Root owner attacks: 55 denied / 5 allowed; kit: 56 denied / 5 allowed. JVM engine artifact: 194 classes / 0 Android references. |
| Schema | `--check`: 3 files / 0 stale; generator tests 9/9. |
| Independent oracle | JCS: 4096 random finite IEEE-754 patterns + 24 integer/format boundaries / 0 differences; patterns: 13 accepted / 31 rejected / 6 whole values. Six subprocess tests cover stalled I/O, bounded draining, limits, exit, crash and startup failure. |

The shipping Coach continuation test awaits its asynchronous answer becoming visible before
checking the retained conversation/request identity. Compose idleness does not track the store's
IO work; the wait is bounded and retains the original visibility assertion.

`check` depends on full client/server conformance, mandatory properties and layering; ordinary tests
also enforce every client file, replay invariants and coverage surveys. The kit check includes its
strict corpus and layering. The existing Android CI workflow's `./gradlew build` runs the same gates;
no CMake or Docker target owns these modules. Hosted Linux CI was not run: this task permits local
commits and forbids pushing.

## Interpretations and discrepancies

- Generate full gym+journal composition v5/minVersion 4; production automatic subscriptions remain
  gym-only. Journal client vectors and fuzz are mandatory. The corpus README includes
  `journal/claim-edit.json`, which §11.1's table omits; the client runner therefore counts 52 files.
- The runner guard follows Kotlin's coroutine context through an injected pure port. It cannot
  discover CoroutineContext from a synchronous function while obeying §2.3's owner denial; the
  actual context adapter belongs at the permitted boundary. No SyncAPI change or layering exception.
- NFC's one-method class needs both `Normalizer` and `Normalizer$Form`; the spec owner table omits
  the latter. Invokedynamic exceptions name only actual bootstrap owners.
- JSON follows Swift's depth-128, duplicate-key, surrogate, UTF-8 and nonzero-underflow checks.
  JCS keys sort by UTF-16; byte ordering uses UTF-8 without NFC normalization. NFC belongs to kit
  text values. Registry integers use Long; mint length must also fit Kotlin Int allocations.
  Schema-valid but unsatisfiable domains are retained, matching reference validation.
- Fractional quantum whose reciprocal overflows is rejected like JS; Swift Quantum currently
  accepts Infinity through rounding. Other quantum arithmetic follows the binary64 oracle.
- API26/27 use DELETE rollback journal + FULL durability because those framework versions cannot
  configure every WAL connection's synchronous mode. API28/29 use FULL OpenParams; newer APIs use
  per-connection FULL. Native tests cover the selected SDKs.
- Write maps retain Swift's keyed guard IDs and base-text key rewriting. JS `rewriteEntry` omits
  both; suspected reference omissions because later guards/base-unknown recovery need resolved IDs.
  No supplied vector distinguishes them. No executed shared vector is believed wrong.
- Removal predictions follow the kit's existing `Prediction.remove` mapping: Delete for
  minted/derived identities and Put(false) for keyed life. Swift and Kotlin carry inherited life
  and fold it on refusal/Undo. JS `reference/client/commit.js:67` omits removals' dead life;
  that reference gap remains outside the Android territory. Keyed predictions
  are tested with a non-wholePut binding because the registry
  correctly prohibits commands predicting wholePut types. Shared registries/vectors and SyncAPI
  are unchanged by the fix pass.
- `LEAVE_DEBOUNCE_MS` applies to web tabs. Android process-level leave releases holds immediately
  and makes one bounded best-effort push. Product liveHint is injected and defaults false.
- Journal fuzz seeds old/future content and revision history through server-origin saves, rather
  than the CPP_ONLY backfill adapters. A1 introduces no store migration.

## Remaining and verification limits

A2 implements product lifecycle, transport/token/fork-guard/telemetry composition, UI and device
store migration. Its installed-app evidence and limits are recorded separately. Nightly replay
against the real backend/Postgres remains unwired; its CI workflow is outside this territory.
Physical power loss and Android writer latency were not verified in the A1 gate. Hosted Linux CI
was not run because pushing is forbidden. Native Robolectric SQLite
and MockWebServer cover transactional failure,
close/reopen, cancelled requests, stalled output, bounded queues and shutdown. Coroutine deadlines
require cooperative suspension; synchronous commit bodies cannot be preempted.

Whole-repository searches found no external Kotlin consumer of changed runtime/testing surfaces.
All ActionRunner construction sites and test display consumers were updated. Wire/schema/corpus
formats and SyncAPI are unchanged. Outside-territory documentation inventories remain for their
owners: root `CLAUDE.md:11`, `STRUCTURE.md:33`, `STRUCTURE.md:106` and the model-server module inventory in
`docs/foundation/domain-kit.md:166`/`:182`; A2 observability/flow inventory
belongs in `docs/ANDROID_OBSERVABILITY.md`. R118's delivery notes in
`docs/foundation/engine.md:3235` still describe Kotlin's v5 work as pending, and its Swift consumer
inventory at `:3244` predates the current Swift v5 implementation; those shared notes are outside
the Android territory.
