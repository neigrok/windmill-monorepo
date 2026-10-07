# Windmill Journal — backend architecture

Product canon: `docs/design/journal/journal.md`. Layering rules: `backend/CLAUDE.md`.
`STRUCTURE.md` holds the dependency rule.

Journal has `domain/ · ports/ · application/ · adapters/{http,json,postgres,llm,email}`, mounts its
REST routes through `journal::registerRoutes(app, JournalDeps&)`, and binds the sync engine in
`sync/` under the contract of [engine.md A.3](../../../docs/foundation/engine.md#a3-journal); its
production tables were adopted in place (engine Appendix D). The engine is the only writer of
pages: web and iOS save through `journal.savePage` and `journal.claimPage` on `/v1/sync`, which
`windmill_server` always mounts, and no server door writes a page. REST serves page reads, echoes,
nudges and transcription.

## Scope

The backend owns four things:

1. **Pages** — durable, per-user, one row per local day.
2. **Nudges** — at most one a day, fired at an instant the device computed.
3. **Echoes** — passage-level reaching-back across a corpus. Spec: `ECHOES.md`.
4. **Entitlement** — one predicate, `Entitlements::hasWindmillOne`.

Semantic search, threads, the writing rhythm and sharing stay on the device.

### Privacy

- Journal data is private to its account; it has no visibility setting.
- Every query is `… WHERE user_id = $1` with the authenticated caller.
- A page nobody owns and a page somebody else owns return the same 404.

## Layout

```
backend/products/journal/
  domain/        Page (+ Score · Source · LocalDate) · NudgePlan
                 Passage · SpanReconcile · EchoSelection          (pure, no I/O)
  ports/         JournalRepository · PageWatcher · NudgeRepository · NudgeMailSender
                 EchoRepository · Segmenter (+ RuleSegmenter) · Embedder · Curator · Transcriber
  application/   NudgeSweep
                 EchoSweep · EchoDerivations · WarmEchoRepository · EchoExplainer
  adapters/
    http/        JournalApi · NudgeApi · EchoApi · VoiceApi
    json/        PageJson — the REST page read shape
    postgres/    PgJournalRepository · PgEchoRepository · PgNudgeRepository
    llm/         HttpEmbedder · AnthropicSegmenter · AnthropicCurator · OpenAiTranscriber ·
                 UnconfiguredModels (NullCurator, NullEmbedder, NullTranscriber)
    email/       ResendNudgeSender
  sync/          JournalRules · JournalProduct (registry + binding) · JournalState ·
                 PgJournal · JournalFeed; its notes are sync/README.md
  routes.{h,cpp} journal::registerRoutes(app, JournalDeps&)
  ECHOES.md      the echo pipeline's spec
```

The weekly readout and the year view are client read models
(`web/src/products/journal/zoom/weekReadout.js`).

## Data model

DDL lives once, in `db/schema.sql` under `-- ── Journal ──`. Tables:

| Table | Holds |
|---|---|
| `journal_page` | one page per `(user_id, day)` — body, mood, energy, source, the writer's document stamp, and the engine envelope (`seq`, `rc`, `ru`, a stamp per register, the body's text revision). The key is the writer's local ISO day, not a minted id |
| `journal_page_revision` | superseded bodies, invisible, each with its outgoing document stamp, archive time and engine text revision (`engine_rev`), pruned inside the admitting transaction |
| `journal_sync_state` | the account's `journalState`: four ranked first-run fields and their stamps |
| `journal_claim_receipts` | one row per `journal.claimPage` claim id: its arguments digest, day and the document stamp it wrote |
| `journal_content_clock` | the account's content clock, from which a claim stamps its page |
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
"never answered" and `Score{0}` is the answer zero), `Source` (typed | spoken), `Page`. A body holds
at most 131,072 bytes (`kMaxPageBytes`, `sync/JournalRules.h`). There are no titles, folders or
tags in the model.

## Pages

`JournalRepository` only reads (`load`, `range`, `since`, `all`): `JournalApi` serves the REST page
reads from it and the echo explainer reads a page through it. A page changes only when the engine
admits one of the two commands below; an intent carrying a `page` delta is refused `invalid`.

Convergence is last-writer-wins per day on the document stamp `{ms, counter, actor}` the writing
device mints, with no CRDT. `journal.savePage` compares the incoming stamp with the stored one under
the scope lock and replaces the page only when the incoming stamp is strictly greater; a tie keeps
what is stored. The guard makes a replayed offline save idempotent and order-independent.

Every accepted save over a non-empty body archives the outgoing body in `journal_page_revision`,
including a save with identical words or only changed scores. The row keeps the outgoing page's
document stamp, and `superseded_at` is the admission's server time. An empty outgoing body, an
ignored stale save and a tie add no revision. The same transaction prunes to 10 revisions per day,
500 rows and 8 MiB per user, 90 days; pruning runs when that admission archives a revision. Account
deletion also removes these rows. No command deletes a page; saving an empty body keeps the day's
row, with the scores and source that save carries.

### The engine binding

`sync/` binds `page`, keyed by its local day, over `journal_page`, and the `journalState` singleton
over `journal_sync_state`; each row carries the engine envelope. A page has the `body` text field and
the `mood`, `energy`, `source` and `documentStamp` registers. The value of `documentStamp` is the
writer's content stamp, stored in `stamp_ms`, `stamp_counter` and `stamp_actor`; its engine register
stamp is separate, and no content stamp, the unset one or a future one included, enters the platform
clock. Every admitted page change writes `updated_at` from the row's `ru`, which the REST reads serve
as `updatedAt`.

`journal.savePage(day, body, mood, energy, source, stamp)` saves one full page. An absent day accepts
even the unset stamp. A stale or equal stamp writes nothing and succeeds. A greater stamp replaces all
page fields together at the server's envelope stamp. The command writes `body` as an internal text
replacement that archives a non-empty outgoing head, even when its text is identical, and advances
its text revision. It replaces the writer's words without merging a competing page, and the stored
body is never marked as a conflict merge.

`journal.claimPage(day, body, mood, energy, source, claimId)` moves a page written signed-out into
the account at sign-in, keeping A.3's account-first concatenation: the account's text, a blank line,
then the signed-out text. When either is blank the other stands, and when the signed-out text already
contains the account's trimmed text it stands alone. An unanswered score falls back to the account's,
and the page is stamped from the account's content clock with actor `srv`. The `claimId` (1–128
bytes) receipt makes retries idempotent; a changed raw payload under that claim id is
`claim-conflict`. A joined body over the cap is `too-large`. Both commands refuse a day that is not a
calendar day `invalid`.

`JournalFeed` wraps the engine's live feed: after each commit it publishes the change to the live
sockets, then hands every changed page to the `PageWatcher`, `EchoDerivations`, with its body's byte
length. A failure of either is reported under `sync.publish` and leaves the admission committed.
Pages and their text revisions cross the engine; the remaining journal tables keep their own
writers and REST routes.

### First-run and claim rules

Engine D.4 fixes `firstRunPolicy = retire-existing`: an account that had written pages at the
adoption has all four `journalState` fields retired and sees no re-onboarding. Mood and energy are
visible on first open, unasked. The privacy fact is "Only you. No prompts, no fields, nothing to
fill in — write a line or a page." The quiet Keep invitation appears only after the scale
invitation is answered or dismissed, one invitation at a time; signed-in pages never show Keep.
Native first run writes today's page only; past days remain read-only, as on web.

Sign-in with signed-out pages asks **Add/Discard** when the account already holds pages, on web
and native, by the engine's sign-in lineage rule (engine §7.10); an empty account takes them
silently.

| Feature | Engine ownership for the iOS first run |
|---|---|
| Kept page, body, mood, energy, source | The page record carries the durable result in signed-in and signed-out writing; the engine's account and anonymous-replica rules govern its destination. |
| Superseded text | `journal_page_revision` carries the engine's body revisions, the bounded invisible safety trail; it has no first-run history UI. |
| Echoes, passages, vectors, curation and feedback | Stay on their current tables and REST: segmentation, retrieval and curation are server computations, and the first-run save needs no echo entity. They read pages from `journal_page`. |
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
budgets. `JournalFeed` hands each committed page to `EchoDerivations`, the `PageWatcher`, which
debounces derivation; `EchoSweep` repairs the corpus every six hours. Embedding stays on the
self-hosted sidecar; curation sends passages to Anthropic. Curation requires a zero-retention,
no-training agreement and privacy copy naming the processor. Echoes are available to every
signed-in writer.

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

Every route below is REST over a session, a mail secret or an admin token, and none writes a page:
pages are written through `/v1/sync` (above).

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/journal/page/{date}` | Owner: one page. |
| GET | `/v1/journal/pages` | Owner: all pages, inclusive from/to range, or HLC delta feed via since/limit (default 500, cap 1000); no search query. |
| GET | `/v1/journal/export` | Owner: every page, JSON. |
| GET | `/v1/journal/nudge` | Owner: settings read (`enabled`, `channel`, `adaptive`, `nextDueAt`, `armed`, `suppressed`). |
| PATCH | `/v1/journal/nudge` | Owner: settings change (`enabled`, `channel`, `nextDueAt`, `slotDay`, `pausedUntil`). |
| POST | `/v1/journal/nudge/pause` | Mail secret: pause nudges; always 204. |
| POST | `/v1/journal/nudge/unsubscribe` | Mail secret: unsubscribe; always 204. |
| POST | `/v1/admin/journal/nudge/sweep` | Admin token: run the nudge pass now; `dryRun` decides without sending, and `asOfMs` dry-runs it at another instant. |
| GET | `/v1/journal/echoes` | Owner: echoes in a from/to range plus pagesWritten. |
| POST | `/v1/journal/echoes/{triggerDay}/offer/dismiss` | Owner: retire an offer while keeping every echo. |
| POST | `/v1/journal/echoes/{triggerDay}/dismiss` | Owner: dismiss every pairing on one page. |
| POST | `/v1/journal/echoes/{triggerDay}/{matchDay}/dismiss` | Owner: dismiss one passage pair. |
| POST | `/v1/journal/echoes/{triggerDay}/{matchDay}/useful` | Owner: positive echo signal. |
| POST | `/v1/journal/echoes/{triggerDay}/{matchDay}/opened` | Owner: echo opened signal. |
| GET | `/v1/admin/journal/echo/explain/{day}` | Admin token + owner: explain that owner's derivation without writes. |
| POST | `/v1/admin/journal/echo/sweep` | Admin token: repair pass (`sinceMs`/`rejudge`). |
| POST | `/v1/journal/transcribe` | Owner, Windmill One: one-shot voice → `{text}`. |

Register the offer-dismissal route **before** the `{matchDay}` pair route. Drogon matches in
registration order and `{matchDay}` binds the literal `offer`. Do not sort that block.

Pair and page dismissal write content-hash dismissals and `not_useful` signals; offer dismissal
keeps every pairing. Every signal and dismissal door answers 204 however many times it is pressed.
Session-authenticated routes resolve identity via `callerUserOf`/`callerOf`, 401 early, and scope
queries to that caller with no visibility parameter. Mail pause and unsubscribe use only their
mail secret and answer 204 even when it matches nothing. There is no page-write, page-delete,
search, thread or share route, and no MCP `ToolHost`.

### REST responses

Error bodies are exactly `{"error":"<sentence>"}`, with no machine `code`.

| Request | Response |
|---|---|
| `GET /v1/journal/page/{date}` | Owner-scoped read; 200 with `{day,body,mood,energy,source,stamp,updatedAt}`. Null scores stay null and zero stays zero. Missing day: 404 `nothing written`. A stored empty page still answers 200. |
| Invalid page address | Calendar validation, including leap days and years 0001…9999: 400 `bad date`. |
| Page GET, list or export without a caller | 401 `sign in to open your journal`, before date or cursor validation. |
| `GET /v1/journal/pages?since=<hlc>&limit=<n>` | This branch takes precedence over `from`/`to` when `since` is nonempty. 200 `{pages:[…]}`, the pages whose full document stamp is strictly greater than the cursor, ordered by `(stamp_ms,stamp_counter,stamp_actor)` and then `day`, so a same-stamp cohort pages the same way on every read. The cursor remains the HLC, so advancing it past a limited same-stamp cohort still excludes every page with that stamp. Default limit 500; a fully parsed positive integer caps at 1000; other limits use 500. Bad HLC: 400 `bad cursor`. This is not an engine seq cursor. |
| `GET /v1/journal/pages?from=<day>&to=<day>` | Selected only when both values are nonempty and there is no nonempty `since`. 200 `{pages:[…]}`, inclusive endpoints, ascending day. Invalid endpoint: 400 `bad date`; a reversed valid range is empty. |
| `GET /v1/journal/pages` or only one range endpoint | 200 `{pages:[…]}` containing all stored days, ascending day. A lone endpoint and a limit without `since` are ignored. |
| `GET /v1/journal/export` | 200 `{pages:[…]}`, all stored days ascending day, with the same page wire shape; revisions remain invisible. |
| `GET /v1/journal/echoes?from=&to=` | Reads the echo tables and `journal_page`. 200 `{pages,pagesWritten,floorWaived}`; empty endpoints default to 0001-01-01 / 9999-12-31. Invalid dates: 400 `bad date`; missing caller: 401 `sign in to read your echoes`. |
| Echo pair/page dismiss, offer dismiss, useful, opened | Owner and date validation, then 204 on first call or retry, including a missing pairing. Missing caller: 401 `sign in to dismiss an echo`, `sign in to retire an offer`, `sign in to mark an echo useful`, or `sign in`, respectively. Invalid date: 400 `bad date`. |
| `GET/PATCH /v1/journal/nudge` | Read and write the nudge tables; 200 `{enabled,channel,adaptive,nextDueAt?,armed,suppressed}`. GET without a row defaults off. Missing caller: 401 `sign in to read your nudge` / `sign in to change your nudge`; PATCH parse/type/arming refusals are the 400/403 sentences below. |
| `POST /v1/journal/nudge/pause` / `unsubscribe` | Pause reads `Authorization: Bearer <secret>` and pauses a matched account for seven days; unsubscribe reads query `t` and disables it. Both always return empty 204, including an absent or wrong secret. |
| `POST /v1/journal/transcribe` | One-shot, no page mutation: 200 `{text}` or the ordered voice refusals below. A later page save carries the resulting text and `source:"spoken"`. |
| Admin echo/nudge doors | The report shapes and validation below. |

The echo response's pages are newest trigger day first, matches newest match day first. Each page
has `{day,entitled:true,offerRetired,matches}`; each match has
`{day,isSelf,source,useful,text,withheldWords:0,occurrenceHint?}`. `pagesWritten` counts bodies whose
trimmed space/tab/CR/LF content is nonempty; it does not count an empty page or one carrying only
scores. `floorWaived` is the account owner's entitlement predicate. Nudge `wroteToday` instead
tests row existence, including a blank page.

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

1. Web and iOS replicate pages through the engine (`/v1/sync`); the browser's search index and
   year view read its replica, and iOS has no obligation to reuse the browser's index.
2. The browser's embedding weights are served from Windmill's origin, versioned and
   immutable-cached, never from a public CDN.

## Composition & wiring

`products/journal/routes.h` declares `JournalDeps`; `platform/infra/main.cpp` fills it.

- `platform/infra/SyncProducts` binds `PgJournal` into the sealed gym + journal catalog, and
  `main.cpp` makes `JournalFeed`, over `EchoDerivations` and the live feed, the engine's change feed.
- Journal arms three threads in `main.cpp` — `journalNudgeSweep->start()`,
  `journalEchoSweep->start()`, `journalEchoDerivations->start()` — each its own trantor loop.
- Every vendor edge is chosen there and nowhere else, on the presence of an environment variable:
  `HttpEmbedder` (`JOURNAL_EMBEDDER_URL`) or `NullEmbedder`, `AnthropicCurator` or `NullCurator`,
  `AnthropicSegmenter` or `RuleSegmenter`, `OpenAiTranscriber` or `NullTranscriber`. The curator and
  the segmenter share `ANTHROPIC_API_KEY`. Without the required echo boundaries the echo pass writes
  nothing; an unconfigured transcription boundary answers `POST /transcribe` with 503.
- `JOURNAL_NUDGE_ADMIN_TOKEN` guards the nudge sweep door and `JOURNAL_ECHO_ADMIN_TOKEN` the echo
  sweep and explain doors. Unset means 403 to everyone.
- **CMake:** `windmill_journal` (core: `domain/ + application/`) links `windmill_platform`; the
  Pg/http adapters fold into the same library, as roadmap's do.
- **Tests:** `test/products/journal/{domain,application,adapters,sync}` mirrors the tree. Every test file
  must be named by hand in `CMakeLists.txt`; one that is not in a list never runs.
- **CI portability:** calendar work belongs in Postgres via `AT TIME ZONE`, never C++ calendar
  functions. pqxx row mappers are `template <typename Row>` (`row_ref` on macOS, `row` on Linux). A
  green local build is not a green CI — watch `gh run` after a backend push, then probe prod.
