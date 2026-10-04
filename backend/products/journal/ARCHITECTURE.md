# Windmill Journal — backend architecture

Product canon: `docs/design/journal/journal.md`. Layering rules: `backend/CLAUDE.md`.
`STRUCTURE.md` holds the dependency rule.

Journal has `domain/ · ports/ · application/ · adapters/{http,json,postgres,llm,email}` and mounts
its REST routes through `journal::registerRoutes(app, JournalDeps&)`. The engine binding contract is
[engine.md A.3](../../../docs/foundation/engine.md#a3-journal), with in-place adoption in Appendix D.
`JOURNAL_ENGINE_WRITES` defaults off: `PageService` uses `PgJournalRepository` until it is enabled,
then sends normalized REST saves through `JournalDoor` and `ServerCall`. The internal claim and
first-run state doors also use server-origin admission; they add no REST resource. iOS is the first
engine surface. Web keeps its REST door and its existing wire contract. `/v1/sync` is unmounted.

## Scope

The backend owns four things:

1. **Pages** — durable, per-user, one row per local day.
2. **Nudges** — at most one a day, fired at an instant the device computed.
3. **Echoes** — passage-level reaching-back across a corpus. Spec: `ECHOES.md`.
4. **Entitlement** — one predicate, `Entitlements::hasWindmillOne`.

Semantic search, threads, the writing rhythm and sharing stay on the device.

### Privacy

- Journal does not import `platform/domain/Access.h`. There is no visibility to parse.
- Every query is `… WHERE user_id = $1` with the authenticated caller.
- A page nobody owns and a page somebody else owns return the same 404.

## Layout

```
backend/products/journal/
  domain/        Page (+ Score · Source · LocalDate) · NudgePlan
                 Passage · SpanReconcile · EchoSelection          (pure, no I/O)
  ports/         JournalRepository · NudgeRepository · NudgeMailSender
                 EchoRepository · Segmenter (+ RuleSegmenter) · Embedder · Curator · Transcriber
  application/   PageService (+ PageWatcher) · NudgeSweep
                 EchoSweep · EchoDerivations · WarmEchoRepository · EchoExplainer
  adapters/
    http/        JournalApi · NudgeApi · EchoApi · VoiceApi
    json/        PageJson — the REST page wire shape, both directions
    postgres/    PgJournalRepository · PgEchoRepository · PgNudgeRepository
    llm/         HttpEmbedder · AnthropicSegmenter · AnthropicCurator · OpenAiTranscriber,
                 each beside a Null… that reports unconfigured so its feature is dark
    email/       ResendNudgeSender
  routes.{h,cpp} journal::registerRoutes(app, JournalDeps&)
  ECHOES.md      the echo pipeline's spec
```

The weekly readout and the year view are client read models
(`web/src/products/journal/zoom/weekReadout.js`).

## Data model

DDL lives once, in `db/schema.sql` under `-- ── Journal ──`. Tables:

| Table | Holds |
|---|---|
| `journal_page` | one page per `(user_id, day)` — body, mood, energy, source, HLC stamp. The key is the writer's local ISO day, not a minted id |
| `journal_page_revision` | superseded bodies, invisible and pruned inside the accepting save transaction |
| `journal_span` | one segmented passage: text, byte span, float32 vector, and a `span_id` carried across re-derivation |
| `journal_echo` | one kept pair, keyed `(user, trigger_span_id, match_span_id)`, `check (match_day < trigger_day)` |
| `journal_echo_dismissal` | "not useful", keyed on the content hash of both passages, so it survives an edit and a re-segmentation |
| `journal_echo_offer_dismissal` | "not now", keyed on the day — it retires the asking, not the echoes |
| `journal_echo_signal` | `opened \| useful \| not_useful` on the span pair, carrying the cosine, relation and curator_version that produced it |
| `journal_page_curation` | what the last pass over a page decided, and against which stamps |
| `journal_nudge` | per-user settings: enabled, channel, device-materialised `next_due_at` + `slot_day`, `paused_until`, `suppressed`, pause digest |
| `journal_nudge_day` | the daily decision ledger, PK `(user_id, slot_day)` |

Domain types (`domain/Page.h`): `LocalDate` (validated ISO day), `Score` (a validated 0…10 that
both scales share — `Page::mood` and `Page::energy` are `std::optional<Score>`, where no value is
"never answered" and `Score{0}` is the answer zero), `Source` (typed | spoken), `Page`,
`kMaxPageBytes` = 128 KB. There are no titles, folders or tags in the model.

## Pages

`PageService` holds `JournalRepository&`, an optional `PageWatcher*` and an optional `JournalWriteDoor*`.
Reads (`page`, `range`, `since`, `all`) pass through. With `JOURNAL_ENGINE_WRITES` off, `write` upserts
and returns the winning row; enabled, it admits `journal.savePage` and captures that winner under the
scope lock before commit. `JournalFeed` announces only committed winning page changes.

Convergence is last-writer-wins per day on an HLC stamp minted by the device's `HlcClock`, with no
CRDT. `PgJournalRepository::save` locks the day `FOR UPDATE`, compares the full stamp
(`ms`, `counter`, `actor`), and stores only when the incoming one strictly dominates; a tie keeps
what is stored. The guard makes a replayed offline write idempotent and order-independent.

Every greater-stamp update over a non-empty body puts the outgoing body in
`journal_page_revision`, including an update with identical words or only changed scores. The row
keeps the outgoing page's full stamp, and `superseded_at` is server time. An empty outgoing body,
an ignored stale write and a tie add no revision. The same transaction prunes to 10 revisions per
day, 500 rows and 8 MB per user, 90 days; pruning runs when that save inserts a revision. Account
deletion also cascades to these rows. There is no page-delete route; saving an empty body keeps
the day's resource, scores and source as that incoming full page specifies.

### Engine binding contract

The engine adopts `journal_page` and `journal_page_revision` in place, scoped by their existing
`user_id`. A page has the engine envelope, server-written `body` text, server-written `mood`,
`energy` and `source` registers, and a server-written `documentStamp` register. The register's value
is the page's legacy HLC, represented by `stamp_ms`, `stamp_counter` and `stamp_actor`; its engine
register stamp is separate. Legacy HLC values, including `0:0:` and future values accepted by REST,
must not enter the platform clock. `updated_at` remains the REST `updatedAt` projection; it is not
replaced in a REST reply by the engine's `rc` or `ru`.

`journal.savePage(day, body, mood, energy, source, stamp)` saves one full page. Under the scope lock,
it compares `stamp` strictly to the stored `documentStamp`. An absent day accepts even the unset
stamp. A stale or equal stamp writes nothing and succeeds with the stored winner. A greater stamp
replaces all page fields together at the server's envelope stamp. The command emits the engine's
internal `{text,replace:true,archiveNonempty:true,archive:metadata}` operation for `body`, keeping
the outgoing head only when its body is non-empty. It replaces the writer's words without merging a competing
page. The operation archives a non-empty outgoing body even when its text is identical, and advances
its text revision with the accepted save. The stored body is never marked as a conflict merge.

Appendix D specifies the unique engine revision mapping for retained audit rows and the current
head. Backfill preserves bodies, legacy stamps, `superseded_at` and `updated_at`; it neither
re-runs curation nor announces a page save. After adoption, the accepting command updates the
legacy columns and revision trail in the admitting transaction. Only a committed winning save
notifies `PageWatcher`, with the winning body length, as `PageService::write` does.

`JOURNAL_WRITE_FREEZE` defaults off. Enabled, every journal mutation and admin sweep door returns
503 with `code:"journal-frozen"`; the echo queue, echo repair pass and nudge pass do no work. The
read-only echo diagnostic uses stored passages and skips vendor derivation while frozen. The shared
Resend suppression door also refuses changes to journal nudge state. An engine writer refuses
503 `journal-not-adopted` when legacy pages or revisions remain unadopted, when adoption schema is
absent, or when a marker lacks its scope. It rolls back instead of creating an empty history scope.
A fresh account's markerless scope is checked against its admitted row metadata, seq and digest;
ranked state registers may remain unset until written.

Before enabling engine writes, the adoption and its rehearsal gates must pass. Each account is
adopted once under the write freeze shared with gym in one owner-chosen window, and the second
run changes no row. Both products' adoption gates must pass and their admitted writers must be
installed before the shared freeze ends. Every REST read door must
return identical bytes across adoption under the target engine reader used by both frozen snapshots;
the separate main-vs-off differential verifies the original switches-off reader. `feed` must recompute to the stored digest and round-trip
the form `apply` stores. The live echo queue, echo repair sweep and nudge sweep must be quiescent
for that comparison, as well as the mutation doors, since their outside-engine tables affect REST
reads. Once enabled, web PUTs are server-origin `journal.savePage` intents; iOS saves use the
replica command. The native-only `journal.claimPage` command transfers an anonymous kept page on
sign-in, preserving A.3's account-first text concatenation and unanswered-score fallback. Its
`claimId` receipt makes retries idempotent; a changed raw payload under that claim id is
`claim-conflict`. It adds no REST endpoint. Pages and their text revisions cross the engine. The
remaining journal tables keep their current writers and REST routes.

### First-run and claim rules

Appendix D fixes `firstRunPolicy = retire-existing`. An account with written pages has all four
`journalState` fields retired and sees no re-onboarding. Mood and energy are visible on first
open, unasked. The privacy fact is "Only you. No prompts, no fields, nothing to fill in — write a
line or a page." The quiet Keep invitation appears only after the scale invitation is answered
or dismissed, one invitation at a time; signed-in pages never show Keep. Native first run writes
today's page only; past days remain read-only, as on web.

Sign-in with signed-out pages asks **Add/Discard** when the account already holds pages, on web
and native; an empty account adopts silently. **Known divergence, fix owed:** web's
`pageStore.js` `claimAnonymousDrafts` silently auto-claims even into an occupied account. This is
a defect requiring a separate web change to ask Add/Discard before adoption, following canon and
engine §7.10. The REST wire contract stays unchanged.

| Feature | Engine ownership for the iOS first run |
|---|---|
| Kept page, body, mood, energy, source | The page record carries the durable result in signed-in and signed-out writing; the engine's account and anonymous-replica rules govern its destination. |
| Superseded text | The adopted revision table carries the engine's body revisions and the bounded invisible safety trail; it has no first-run history UI. |
| Echoes, passages, vectors, curation and feedback | Stay on their current tables and REST: segmentation, retrieval and curation are server computations, and the first-run save needs no echo entity. Their page reads continue to use the adopted legacy projection. |
| Nudge settings, schedule, delivery and mail secrets | Stay on their current tables and REST: first-run writing does not require replicating the schedule or delivery ledger. The materialized knock and server delivery retain their current contract. |
| Transcription | Stays one-shot REST: no persisted audio or page exists until the writer saves the resulting text. `source` on that page is sufficient durable provenance. |
| Ink notes, prompts, writing presentation, first-kept acknowledgments | Device presentation and the first-run client contract in A.3; none is a server-derived journal table or a new REST resource. |

## Nudges

The device computes the next knock instant and PATCHes it as `next_due_at` plus the local day it
belongs to (`slot_day`). The server stores that instant and fires at it, and needs no timezone. A
row with no `next_due_at` sits outside the sweep's partial index, so unset means never send; the
`adaptive` field in the settings read is whether an instant is stored.

`domain/NudgePlan.h` is the pure decision — gates in order: `paused` → `tooLate`
(`kNudgeTooLateMs`, six hours) → `alreadyWrote` → send. There is no lapse or streak branch.

`NudgeSweep` derives from `MailSweep<NudgeDueUser, NudgeDecision>`
(`platform/application/MailSweep.h`), which owns the decide → claim → send pass, the `SweepMutex`
advisory lock (dedup, not correctness), the arming gate and the per-user crash guard. Journal
supplies `dueNow`, `decideFor`, `verdictOf`, `claim`, `close`, `send` and `storePause`.

Rules:

- `journal_nudge_day` is a decision ledger, not a send log. Its PK is the "at most one per day"
  mutex; never compare timestamps at read time.
- A row whose `sent_at` is null must never be auto-retried.
- `claimDay` re-checks eligibility inside its own transaction and clears `next_due_at` in the same
  breath, so the served instant cannot fire twice.
- The sweep runs on its own `trantor` loop, never a drogon request loop.
- Mail leaves only when `JOURNAL_NUDGE_ENABLED` is on AND the user is named in
  `JOURNAL_NUDGE_ALLOWLIST` (empty means nobody). The gate is consulted at send time, never at
  decide time.

The only channel is transactional email (Resend). The `channel` column carries the choice; web push
has no port.

## Echoes

[ECHOES.md](ECHOES.md) owns the derivation pipeline, selection rules, persistence, scheduling and
budgets. `PageWatcher` connects page saves to debounced `EchoDerivations`; `EchoSweep` repairs the
corpus every six hours. Embedding stays on the self-hosted sidecar; curation sends passages to
Anthropic. Curation requires a zero-retention, no-training agreement and privacy copy naming the
processor. Echoes are available to every signed-in writer.

## Entitlement

One subscription — Windmill One — across roadmap, journal and gym:

```cpp
const bool subscribed = entitlements.hasWindmillOne(caller, email);
```

`Entitlements` (`platform/application/Entitlements.h`) wraps the Paddle mirror and the
`grantsAccess` rule. **Voice** asks for a subscription before any audio is touched and consumes
the active AI allowance. **Echoes** are automatic for every signed-in writer, serve full passages,
and consume only an internal passive-work budget.

## HTTP surface

Keep routes remain REST, including page reads until their separate cleanup. The Retire route is
marked with `registerLegacyWriteHandler`. `LEGACY_REST_WRITES_RETIRED` defaults off; only `1`
enables it. When enabled, PUT page returns 410
`{"error":"This version of the app can no longer save; update it.","code":"client-update-required"}`
before authentication, parsing or data access. The owner sets the fixed retirement date; none is
configured yet. Replacements follow [engine A.3](../../../docs/foundation/engine.md).

| Method | Path | Fate | Engine replacement / retained purpose |
|---|---|---|---|
| GET | `/v1/journal/page/{date}` | Keep | Owner: one page. |
| PUT | `/v1/journal/page/{date}` | Retire | `journal.savePage`; anonymous adoption uses `journal.claimPage`. |
| GET | `/v1/journal/pages` | Keep | Owner: all pages, inclusive from/to range, or HLC delta feed via since/limit (default 500, cap 1000); no search query. |
| GET | `/v1/journal/export` | Keep | Owner: every page, JSON. |
| GET | `/v1/journal/nudge` | Keep | Owner: settings read (`enabled`, `channel`, `adaptive`, `nextDueAt`, `armed`, `suppressed`). |
| PATCH | `/v1/journal/nudge` | Keep | Owner: settings change (`enabled`, `channel`, `nextDueAt`, `slotDay`, `pausedUntil`). |
| POST | `/v1/journal/nudge/pause` | Keep | Mail secret: pause nudges; always 204. |
| POST | `/v1/journal/nudge/unsubscribe` | Keep | Mail secret: unsubscribe; always 204. |
| POST | `/v1/admin/journal/nudge/sweep` | Keep | Admin token: rehearsal (`dryRun`/`asOfMs`). |
| GET | `/v1/journal/echoes` | Keep | Owner: echoes in a from/to range plus pagesWritten. |
| POST | `/v1/journal/echoes/{triggerDay}/offer/dismiss` | Keep | Owner: retire an offer while keeping every echo. |
| POST | `/v1/journal/echoes/{triggerDay}/dismiss` | Keep | Owner: dismiss every pairing on one page. |
| POST | `/v1/journal/echoes/{triggerDay}/{matchDay}/dismiss` | Keep | Owner: dismiss one passage pair. |
| POST | `/v1/journal/echoes/{triggerDay}/{matchDay}/useful` | Keep | Owner: positive echo signal. |
| POST | `/v1/journal/echoes/{triggerDay}/{matchDay}/opened` | Keep | Owner: echo opened signal. |
| GET | `/v1/admin/journal/echo/explain/{day}` | Keep | Admin token + owner: explain that owner's derivation without writes. |
| POST | `/v1/admin/journal/echo/sweep` | Keep | Admin token: repair pass (`sinceMs`/`rejudge`). |
| POST | `/v1/journal/transcribe` | Keep | Owner, Windmill One: one-shot voice → `{text}`. |

Register the offer-dismissal route **before** the `{matchDay}` pair route. Drogon matches in
registration order and `{matchDay}` binds the literal `offer`. Do not sort that block.

Pair and page dismissal write content-hash dismissals and `not_useful` signals; offer dismissal
keeps every pairing. Every signal and dismissal door answers 204 however many times it is pressed.
With legacy writes enabled, session-authenticated routes resolve identity via `callerUserOf`/`callerOf`,
401 early, and scope
queries to that caller with no visibility parameter. Mail pause and unsubscribe use only their
mail secret and answer 204 even when it matches nothing. There is no search route, thread route,
share route, page-delete route or MCP `ToolHost`.

### REST translation into the engine

With the retirement switch off, REST keeps its responses, status codes and normalization. Its error
bodies are exactly
`{"error":"<sentence>"}`. The new freeze and engine-availability refusals additionally carry a
machine `code`; the freeze is checked before authentication or parsing. The REST builder otherwise
authenticates and parses before admission, then builds the normalized full-page command. All
winner reads, stale/equal checks and command construction that depend on the current row occur
under the scope lock. Engine result envelopes, revisions, conflict flags and write maps are not
added to REST responses.

| REST request or outcome | Engine translation / preserved response |
|---|---|
| `GET /v1/journal/page/{date}` | Owner-scoped read of the adopted row; 200 with `{day,body,mood,energy,source,stamp,updatedAt}`. Null scores stay null and zero stays zero. Missing day: 404 `nothing written`. A stored empty page still answers 200. |
| `PUT /v1/journal/page/{date}` | Build `journal.savePage` after `parsePageWrite`; accepted save, stale save and equal-stamp retry all answer 200 with the winning page in the same shape as GET. No 201, 204 or conflict response for an ordinary page save. |
| PUT omitted fields | Full replacement defaults: `body:""`, `mood:null`, `energy:null`, `source:"typed"`, `stamp:"0:0:"`. Unknown fields, an input `day` and input `updatedAt` do not change the addressed day or server receipt time. |
| PUT scores and source | Each score is kept only when JsonCpp `isInt()` and `Score::from` accept it; absent, null, non-integer or outside 0…10 becomes null. Only `source:"spoken"` becomes spoken; every other parsed source string becomes typed. These are normalized before the engine's strict domains apply. |
| Invalid page address | Calendar validation, including leap days and years 0001…9999, precedes storage: 400 `bad date`. The registry's address pattern is a shape bound, not the calendar validator. |
| PUT with no JSON document | 400 `expected json`. |
| PUT with an unreadable page or malformed HLC | 400 `could not read that page`; non-object JSON and invalid `body`/`source`/`stamp` conversions take this path. |
| PUT body over 131,072 UTF-8 bytes / engine `too-large` | 413 `that page is too long to store`, before storage, watcher or revision capture, even if its stamp would lose. |
| Page GET, PUT, list or export without a caller | 401 `sign in to open your journal`, before date, cursor or JSON validation. |
| `GET /v1/journal/pages?since=<hlc>&limit=<n>` | This branch takes precedence over `from`/`to` when `since` is nonempty. 200 `{pages:[…]}`, using full legacy HLC strictly greater than the cursor. With engine writes off, the original query orders by `(stamp_ms,stamp_counter,stamp_actor)` only. Engine reads add `day` to make same-stamp cohorts deterministic through adoption and page updates. The cursor remains the HLC, so advancing it past a limited same-stamp cohort still excludes every page with that stamp. Default limit 500; a fully parsed positive integer caps at 1000; other limits use 500. Bad HLC: 400 `bad cursor`. This is not an engine seq cursor. |
| `GET /v1/journal/pages?from=<day>&to=<day>` | Selected only when both values are nonempty and there is no nonempty `since`. 200 `{pages:[…]}`, inclusive endpoints, ascending day. Invalid endpoint: 400 `bad date`; a reversed valid range is empty. |
| `GET /v1/journal/pages` or only one range endpoint | 200 `{pages:[…]}` containing all stored days, ascending day. A lone endpoint and a limit without `since` are ignored. |
| `GET /v1/journal/export` | 200 `{pages:[…]}`, all stored days ascending day, with the same page wire shape; revisions remain invisible. |
| `GET /v1/journal/echoes?from=&to=` | Stays REST over echo tables and the adopted page projection. 200 `{pages,pagesWritten,floorWaived}`; empty endpoints default to 0001-01-01 / 9999-12-31. Invalid dates: 400 `bad date`; missing caller: 401 `sign in to read your echoes`. |
| Echo pair/page dismiss, offer dismiss, useful, opened | Stay outside admission; owner/date validation stays unchanged, then 204 on first call or retry, including a missing pairing. Missing caller: 401 `sign in to dismiss an echo`, `sign in to retire an offer`, `sign in to mark an echo useful`, or `sign in`, respectively. Invalid date: 400 `bad date`. |
| `GET/PATCH /v1/journal/nudge` | Stay REST over nudge tables; 200 `{enabled,channel,adaptive,nextDueAt?,armed,suppressed}`. GET without a row defaults off. Missing caller: 401 `sign in to read your nudge` / `sign in to change your nudge`; PATCH parse/type/arming refusals stay the 400/403 sentences below. |
| `POST /v1/journal/nudge/pause` / `unsubscribe` | Stay outside admission. Pause reads `Authorization: Bearer <secret>` and pauses a matched account for seven days; unsubscribe reads query `t` and disables it. Both always return empty 204, including an absent or wrong secret. |
| `POST /v1/journal/transcribe` | Remains one-shot REST, no page mutation: 200 `{text}` or the ordered voice refusals below. A later page save carries the resulting text and `source:"spoken"`. |
| Admin echo/nudge doors | Stay outside admission, retain their report shapes and validation below. |

The echo response's pages are newest trigger day first, matches newest match day first. Each page
has `{day,entitled:true,offerRetired,matches}`; each match has
`{day,isSelf,source,useful,text,withheldWords:0,occurrenceHint?}`. `pagesWritten` counts bodies whose
trimmed space/tab/CR/LF content is nonempty; it does not count an empty page or one carrying only
scores. `floorWaived` is the account owner's entitlement predicate. Nudge `wroteToday` instead
tests row existence, including a blank page. Adoption preserves both queries.

Nudge PATCH rejects a non-object document with 400 `send the nudge fields to change`. Present
fields require their existing types: 400 `enabled must be true or false`, `channel must be a
string`, `nextDueAt must be a millisecond timestamp`, `slotDay must be YYYY-MM-DD`, or
`pausedUntil must be a millisecond timestamp`. Channel strings are stored as supplied. An enabled
setting outside the arming allowlist is 403 `nudges aren't switched on for this account yet`.
Only a PATCH explicitly carrying `enabled:true` lifts provider suppression.

Both admin families check `x-admin-token`, falling back to query `token` only when the header is
empty; an unset or wrong configured token is 403 `admin token required`. Nudge sweep preserves
400 `dryRun must be true or false` / `asOfMs must be a millisecond timestamp`, and 409 `asOfMs is
refused while nudges are enabled`; a nonzero admitted `asOfMs` forces a dry run. Its 200 report is
`{ran,due,claimed,sent,failed,held,wouldSend,skipped,errors}`. Echo sweep preserves 400 `sinceMs must
be a millisecond timestamp`, its `sinceMs` account window and `rejudge=1|true`; its 200 report is
`{usersScanned,pagesDerived,triggersSkippedRefrain,passagesEmbedded,echoesWritten,pagesFailed,
inboundEnqueued,pagesOverBudget,pagesRefused,unitsDiscarded,usersOverAiBudget}`. Echo explain
additionally requires the caller's owner session (401 `sign in as the owner of the page`), rejects
invalid dates with 400 `bad date`, and keeps the diagnostic 200 response described in `ECHOES.md`.

## Voice

Transcription is bought from an ASR vendor (`OpenAiTranscriber`), behind `ports/Transcriber.h`:
`configured()` plus one asynchronous `transcribe(user, audio, mimeType, done)`. `done` fires exactly
once, on any thread, and `nullopt` is a vendor failure distinct from an empty transcript.

`VoiceApi` settles everything refusable before the upload, in this order: 401 signed out · 403 not
a subscriber · 503 no vendor wired · 400 no audio · 413 past `kMaxAudioBytes` (6 MB) · 429 past the
account's trailing-30-day AI allowance · 503 busy (`kVoiceInFlightPerAccount` 2,
`kVoiceInFlightTotal` 8) · 429 past `kVoiceBytesPerDay` (30 MB). A vendor failure is 502, never
`200 {"text":""}`.

The corresponding `error` sentences, without a `code`, are `sign in to talk`, `talk is part of
Windmill One`, `voice is not available right now`, `no audio`, `that take is too long to
transcribe`, `talk has had its turn for now`, `voice is busy right now`, and `talk has had its turn
for today`. Vendor failure is 502 `the transcriber could not answer`. A successful empty transcript
is still 200 `{text:""}`; failure and silence remain distinct.

The handler does not wait on the vendor: it hands its callback to the transcriber and returns, and
the reply is written from the transcriber's loop. `VoiceRation` is in memory and best-effort; the
hard ceilings are the ledger-backed account allowance and the process fuse
(`platform/domain/AiFuse.h`).

Rules:

- Audio lives only in the request buffer. It is never persisted and never logged.
- The vendor must be on a zero-retention, no-training agreement, and the voice copy names the
  processor.
- Transcription may format (punctuation, casing, paragraph breaks, dropped filler) and must never
  reword, summarize or improve. Keep any vendor "smart-format" mode off.
- `transcribe` produces no page. It returns text; the client writes it into today's page with
  `source = spoken`.

## What the device owns

| On-device | Consequence for the backend |
|---|---|
| Semantic search — passage-level chunking, bi-encoder retrieve + cross-encoder rerank, HyDE expansion, all in a worker over IndexedDB embeddings | No endpoint takes a query |
| Threads — live clustering over the same vectors, never stored | No table, no route |
| The rhythm — histogram, learning, confidence | Only the derived `next_due_at` + `slot_day` cross |
| Sharing, export-to-post, gallery | No share entity exists |
| MCP | Journal exposes no `ToolHost` |

Two obligations fall out of on-device search:

1. Web's page replication uses `GET /v1/journal/pages?since=<hlc>`; the browser search index,
   offline cache and year cache ride it. iOS's page replication uses the engine binding contract,
   with no obligation to reuse the browser's index or cache implementation.
2. The browser's embedding weights are served from Windmill's origin, versioned and
   immutable-cached, never from a public CDN.

## Composition & wiring

`products/journal/routes.h` declares `JournalDeps`; `platform/infra/main.cpp` fills it.

- Journal arms three threads in `main.cpp` — `journalNudgeSweep->start()`,
  `journalEchoSweep->start()`, `journalEchoDerivations->start()` — each its own trantor loop.
- Every vendor edge is chosen there and nowhere else, on the presence of an environment variable:
  `HttpEmbedder` (`JOURNAL_EMBEDDER_URL`) or `NullEmbedder`, `AnthropicCurator` or `NullCurator`,
  `AnthropicSegmenter` or `RuleSegmenter`, `OpenAiTranscriber` or `NullTranscriber`. The curator and
  the segmenter share `ANTHROPIC_API_KEY`. Without the required echo boundaries the echo pass writes
  nothing; an unconfigured transcription boundary answers `POST /transcribe` with 503.
- `JOURNAL_NUDGE_ADMIN_TOKEN` and `JOURNAL_ECHO_ADMIN_TOKEN` each close one rehearsal door. Unset
  means 403 to everyone.
- **CMake:** `windmill_journal` (core: `domain/ + application/`) links `windmill_platform`; the
  Pg/http adapters fold into the same library, as roadmap's do.
- **Tests:** `test/products/journal/{domain,application,adapters}` mirrors the tree. Every test file
  must be named by hand in `CMakeLists.txt`; one that is not in a list never runs.
- **CI portability:** calendar work belongs in Postgres via `AT TIME ZONE`, never C++ calendar
  functions. pqxx row mappers are `template <typename Row>` (`row_ref` on macOS, `row` on Linux). A
  green local build is not a green CI — watch `gh run` after a backend push, then probe prod.
