# Windmill Journal — backend architecture

The journal product's backend. Product canon: `docs/design/journal/journal.md` and the
Windmill · Journal Figma file (`pC6ciOUnfLmI42oMihd7l3`). Layering rules: `backend/CLAUDE.md`.
`STRUCTURE.md` holds the one dependency rule.

Journal mirrors roadmap's shape — `domain/ · ports/ · application/ · adapters/{http,json,postgres,llm,email}` —
and plugs in through one seam: `journal::registerRoutes(app, JournalDeps&)`.

## Scope

The backend owns four things:

1. **Pages** — durable, per-user, one row per local day.
2. **Nudges** — at most one a day, fired at an instant the device computed.
3. **Echoes** — passage-level reaching-back across a corpus. Spec: `ECHOES.md`.
4. **Entitlement** — one predicate, `Entitlements::hasWindmillOne`.

Everything else stays on the device: semantic search (no query endpoint exists), threads
(derived clusters, no table), the writing rhythm (only the derived next instant crosses), and
sharing (no share entity, no visibility column, no public route).

### Privacy is structural

- Journal does not import `platform/domain/Access.h`. There is no visibility to parse.
- Every query is `… WHERE user_id = $1` with the authenticated caller. No parameter can widen it.
- A page nobody owns and a page somebody else owns return the same 404.
- Adding sharing would be a schema change, not a flag flip.

## Layout

```
backend/products/journal/
  domain/        Page (+ Mood · Energy · Source · LocalDate) · NudgePlan
                 Passage · SpanReconcile · EchoSelection          (pure, no I/O)
  ports/         JournalRepository · NudgeRepository · NudgeMailSender
                 EchoRepository · Segmenter (+ RuleSegmenter) · Embedder · Curator · Transcriber
  application/   PageService (+ PageWatcher) · NudgeSweep
                 EchoSweep · EchoDerivations · WarmEchoRepository · EchoExplainer
  adapters/
    http/        JournalApi · NudgeApi · EchoApi · VoiceApi
    json/        PageJson — the page wire shape, both directions, spoken by all three surfaces
    postgres/    PgJournalRepository · PgEchoRepository · PgNudgeRepository
    llm/         HttpEmbedder · AnthropicSegmenter · AnthropicCurator · OpenAiTranscriber,
                 each beside a Null… that reports unconfigured so its feature is simply dark
    email/       ResendNudgeSender
  routes.{h,cpp} journal::registerRoutes(app, JournalDeps&)
  ECHOES.md      the echo pipeline's spec
```

The weekly readout and the year view are client read models
(`web/src/products/journal/zoom/weekReadout.js`), assembled from pages the device already holds.
There is no `WeekService` here.

## Data model

DDL lives once, in `db/schema.sql` under `-- ── Journal ──`. Tables:

| Table | Holds |
|---|---|
| `journal_page` | one page per `(user_id, day)` — body, mood, energy, source, HLC stamp. The key is the writer's local ISO day, not a minted id |
| `journal_page_revision` | superseded bodies, append-only, invisible; never a merge UI |
| `journal_span` | one segmented passage: text, byte span, float32 vector, and a `span_id` carried across re-derivation |
| `journal_echo` | one kept pair, keyed `(user, trigger_span_id, match_span_id)`, `check (match_day < trigger_day)` — reaching forward is unrepresentable |
| `journal_echo_dismissal` | "not useful", keyed on the CONTENT hash of both passages, so it survives an edit, a re-segmentation and a segmenter bump |
| `journal_echo_offer_dismissal` | "not now", keyed on the DAY — it retires the asking, not the echoes |
| `journal_echo_signal` | `opened \| useful \| not_useful` on the span pair, carrying the cosine, relation and curator_version that produced it |
| `journal_page_curation` | what the last pass over a page decided, and against which stamps |
| `journal_nudge` | per-user settings: enabled, channel, device-materialised `next_due_at` + `slot_day`, `paused_until`, `suppressed`, pause digest |
| `journal_nudge_day` | the daily decision ledger, PK `(user_id, slot_day)` |

Domain types (`domain/Page.h`): `LocalDate` (validated ISO day), `Mood` (none + five steps),
`Energy` (none + three), `Source` (typed | spoken), `Page`, `kMaxPageBytes` = 128 KB. There are no
titles, folders or tags in the model, so none can be persisted.

## Pages

`PageService` holds `JournalRepository&` and an optional `PageWatcher*`. Reads (`page`, `range`,
`since`, `all`) pass through; `write` upserts and returns the winning row, so a client that lost a
race is handed the body that won.

Convergence is last-writer-wins per day on an HLC stamp minted by the device's `HlcClock` — no
CRDT. The write is one guarded upsert:

```sql
ON CONFLICT (user_id, day) DO UPDATE SET …
  WHERE (EXCLUDED.stamp_ms, EXCLUDED.stamp_counter) > (journal_page.stamp_ms, journal_page.stamp_counter)
```

Offline writing works because the device queues stamped writes and replays them; the guard makes
replay idempotent and order-independent.

When the update overwrites a non-empty body, the outgoing body lands in `journal_page_revision` in
the same transaction. That table is bounded on the write path (`PgJournalRepository::pruneRevisions`):
10 revisions per day, 500 rows and 8 MB per user, 90 days. The 90 days is a bound on accumulation,
not a retention promise — someone who stops writing keeps what their last write left, under the
other caps. Nothing else in the product deletes from that table.

## Nudges

The device owns the histogram, the learning and the confidence. It computes one scalar — the next
knock instant — and PATCHes it as `next_due_at` plus the local day it belongs to (`slot_day`). The
server stores that instant and fires at it, and needs no timezone for journal at all. A row with no
`next_due_at` sits outside the sweep's partial index, so "unknown means never send" needs no special
case; the `adaptive` field in the settings read is simply whether an instant is stored.

`domain/NudgePlan.h` is the pure decision — gates in order: `paused` → `tooLate`
(`kNudgeTooLateMs`, six hours) → `alreadyWrote` → send. There is no lapse or streak branch, and the
mail is one fixed line, so a decision to send carries no copy to get wrong.

`NudgeSweep` derives from `MailSweep<NudgeDueUser, NudgeDecision>`
(`platform/application/MailSweep.h`), which owns the DECIDE → CLAIM → SEND pass, the `SweepMutex`
advisory lock (dedup, not correctness), the arming gate and the per-user crash guard. Journal
supplies `dueNow`, `decideFor`, `verdictOf`, `claim`, `close`, `send` and `storePause`.

Rules:

- `journal_nudge_day` is a decision ledger, not a send log. Its PK is the "at most one per day"
  mutex; never compare timestamps at read time.
- A row whose `sent_at` is null must never be auto-retried. A lost nudge costs nothing, a duplicate
  costs trust.
- `claimDay` re-checks eligibility inside its own transaction and clears `next_due_at` in the same
  breath, so the served instant cannot fire twice.
- The sweep runs on its own `trantor` loop, never a drogon request loop.
- Mail leaves only when `JOURNAL_NUDGE_ENABLED` is on AND the user is named in
  `JOURNAL_NUDGE_ALLOWLIST` (empty means nobody). The gate is consulted at SEND time, never at
  decide time, so the ledger keeps recording while nobody can receive.

The only channel is transactional email (`EmailSender::sendJournalNudge`, Resend). The `channel`
column carries the choice; web push has no port.

## Echoes

`ECHOES.md`, beside this file, is the spec: pipeline, selection rules, data model, cost and gates.

What belongs here:

- Echoes are derived **on the writer's save**. `PageService` announces it on `PageWatcher`;
  `EchoDerivations` debounces (8 s quiet, or 400 bytes of new text) and derives on its own thread,
  capped at 4 derivations per page and 40 per user in a rolling day, 5 pending entries per user.
  A `WarmEchoRepository` keeps the second derivation of an evening from re-loading the corpus.
- `EchoSweep` runs every six hours as the **repair** path: inbound reverse edges, corpus-stamp
  backfill, failed pages, deferred derivations. Nobody receives an echo through it.
- The **entitlement is asked in the read**, not in the sweep: the sweep derives for everyone and
  `EchoApi` decides how much of a passage a reader is handed. A non-subscriber is still served that
  echoes exist, how many, how far back, and the opening words of the nearest passage — none of which
  a gated sweep could answer.
- `HttpEmbedder` talks to the self-hosted `services/embedder` sidecar, running the same bge-small
  weights the browser downloads for on-device search. Page text does not leave for an embedding.
  It does leave for the curator, which is Anthropic's — that call needs the zero-retention,
  no-training agreement and the privacy copy that names it.
- The curator records every call to `ai_usage`, and `EchoSweep` asks a per-user cost ceiling before
  curating, skipping an over-budget user for that pass rather than failing them.

## Entitlement

One subscription — Windmill One — across roadmap, journal and gym:

```cpp
const bool subscribed = entitlements.hasWindmillOne(caller, email);
```

`Entitlements` (`platform/application/Entitlements.h`) wraps the Paddle mirror and the
`grantsAccess` rule, so no product re-derives it. Journal's two subscriber surfaces are **echoes**
(asked in the read) and **voice** (asked before any audio is touched). Pages, mood/energy, the
canvas and zoom, search, threads, trends, the week, nudges and export ask nothing of billing.

## HTTP surface

The canon's `/journal/*` positions are client routes resolved in the SPA. The backend surface is
only what the client cannot do itself.

| Method & path | Purpose | Auth |
|---|---|---|
| `GET /v1/journal/page/:date` | one page | owner |
| `GET /v1/journal/pages?since=&limit=` | delta feed: pages with a stamp past an HLC cursor, ascending, `limit` default 500 and capped at 1000. One read feeds sync, the offline cache and the on-device search index; it never takes a query | owner |
| `GET /v1/journal/pages?from=&to=` | a date range (a window, the week) | owner |
| `GET /v1/journal/pages` | every page | owner |
| `PUT /v1/journal/page/:date` | LWW upsert carrying the HLC stamp. A body past `kMaxPageBytes` is 413, before storage and before the revision trail | owner |
| `POST /v1/journal/transcribe` | one-shot voice → `{ text }` | owner, Windmill One |
| `GET /v1/journal/echoes?from=&to=` | every echo on the pages in a range, grouped by page, plus `pagesWritten`. Entitlement decides how much of a passage comes back | owner |
| `POST /v1/journal/echoes/:triggerDay/offer/dismiss` | "Not now" — retire the upgrade offer on this page, keeping every echo | owner |
| `POST /v1/journal/echoes/:triggerDay/dismiss` | "Not useful" — retire every pairing on this page in one request | owner |
| `POST /v1/journal/echoes/:triggerDay/:matchDay/dismiss` | retire one passage pair | owner |
| `POST /v1/journal/echoes/:triggerDay/:matchDay/useful` | the reader's explicit positive answer | owner |
| `POST /v1/journal/echoes/:triggerDay/:matchDay/opened` | the weaker "Read it" signal | owner |
| `GET /v1/journal/export` | every page, JSON (the client renders markdown) | owner |
| `GET/PATCH /v1/journal/nudge` | settings. GET answers `{ enabled, channel, adaptive, nextDueAt?, armed, suppressed }`; PATCH takes `{ enabled?, channel?, nextDueAt?, slotDay?, pausedUntil? }` and is where the device pushes the instant it computed | owner |
| `POST /v1/journal/nudge/pause` · `/unsubscribe` | the credential is the secret in the user's mail; POST-only; 204 either way | mail secret |
| `POST /v1/admin/journal/nudge/sweep` | operator rehearsal (`dryRun`/`asOfMs`) | `JOURNAL_NUDGE_ADMIN_TOKEN` |
| `GET /v1/admin/journal/echo/explain/:day` | one page's derivation run for its reasons, writing nothing; explains the signed-in caller's own page | admin token + owner |
| `POST /v1/admin/journal/echo/sweep` | operator rehearsal of one repair pass. Its one knob is `sinceMs`; there is no "as of" instant, because a pass judges pages against the stamps the corpus carries, never against a clock | `JOURNAL_ECHO_ADMIN_TOKEN` |

Register the offer-dismissal route **before** the `{matchDay}` pair route. Drogon matches in
registration order and `{matchDay}` binds the literal `offer`. Do not sort that block.

Both dismissal doors write the same content-hash key, and every signal door answers 204 however
many times it is pressed. Every non-admin route resolves identity via `callerUserOf`/`callerOf`,
401s early, and is scoped to that caller with no visibility parameter. There is no search route, no
thread route, no share route, and no MCP `ToolHost`.

## Voice

Transcription is bought from an ASR vendor (`OpenAiTranscriber`), behind `ports/Transcriber.h`:
`configured()` plus one asynchronous `transcribe(user, audio, mimeType, done)`. `done` fires exactly
once, on any thread, and `nullopt` is a vendor failure distinct from an empty transcript.

`VoiceApi` settles everything refusable before the upload, in this order: 401 signed out · 403 not
a subscriber · 503 no vendor wired · 400 no audio · 413 past `kMaxAudioBytes` (6 MB) · 429 past the
account's trailing-30-day AI allowance · 503 busy (`kVoiceInFlightPerAccount` 2,
`kVoiceInFlightTotal` 8) · 429 past `kVoiceBytesPerDay` (30 MB). A vendor failure is 502, never
`200 {"text":""}`.

The handler does not wait on the vendor: it hands its callback to the transcriber and returns, and
the reply is written from the transcriber's loop. `VoiceRation` is in memory and best-effort — the
hard ceilings are the ledger-backed account allowance and the process fuse
(`platform/domain/AiFuse.h`).

Rules:

- Audio lives only in the request buffer. It is never persisted and never logged.
- The vendor must be on a zero-retention, no-training agreement, and the voice copy names the
  processor rather than implying "only you". The browser's Web Speech API is rejected: it ships
  audio to Google/Apple with no such contract.
- Transcription may **format** (punctuation, casing, paragraph breaks, dropped filler) and must
  never reword, summarize or improve. Keep any vendor "smart-format" mode off.
- `transcribe` produces no page. It returns text; the client writes it into today's page with
  `source = spoken`.

## What the device owns

| On-device | Consequence for the backend |
|---|---|
| Semantic search — passage-level chunking, bi-encoder retrieve + cross-encoder rerank, HyDE expansion, all in a worker over IndexedDB embeddings | No endpoint ever takes a query. The backend is the supplier only |
| Threads — live clustering over the same vectors, never stored | No table, no route |
| The rhythm — histogram, learning, confidence | Only the derived `next_due_at` + `slot_day` cross |
| Sharing, export-to-post, gallery | No share entity exists |
| MCP | Journal exposes no `ToolHost`; the agent does not read pages |

The two obligations that fall out of on-device search:

1. **The corpus, feedably** — `GET /v1/journal/pages?since=<hlc>` is the whole sync surface, and the
   search index, offline cache and year cache all ride it.
2. **First-party model weights** — the browser's embedding weights are served from Windmill's
   origin, versioned and immutable-cached. Fetching them from a public CDN would leak "this user
   just opened search" to a third party.

## Composition & wiring

`products/journal/routes.h` declares `JournalDeps`; `platform/infra/main.cpp` fills it. What neither
file says in one place:

- Journal arms three threads in `main.cpp` — `journalNudgeSweep->start()`,
  `journalEchoSweep->start()`, `journalEchoDerivations->start()` — each its own trantor loop, never
  a drogon request loop.
- Every vendor edge is chosen there and nowhere else, on the presence of an environment variable:
  `HttpEmbedder` (`JOURNAL_EMBEDDER_URL`) or `NullEmbedder`, `AnthropicCurator` or `NullCurator`,
  `AnthropicSegmenter` or `RuleSegmenter`, `OpenAiTranscriber` or `NullTranscriber`. The curator and
  the segmenter share `ANTHROPIC_API_KEY`. An unwired boundary is a quiet
  no-op, never an error: the echo pass writes nothing and `POST /transcribe` answers 503.
- `JOURNAL_NUDGE_ADMIN_TOKEN` and `JOURNAL_ECHO_ADMIN_TOKEN` each close one rehearsal door. Unset
  means 403 to everyone.
- **CMake:** `windmill_journal` (core: `domain/ + application/`) links `windmill_platform`; the
  Pg/http adapters sit under the same `Drogon_FOUND AND libpqxx_FOUND` guard roadmap uses, so the
  pure core and its tests stand up without the vendor edges.
- **Tests:** `test/products/journal/{domain,application,adapters}` mirrors the tree. The high-value
  pure targets are `segment`/`reconcile`/`select`, `decide` (every nudge gate, especially the absent
  lapse branch) and the LWW guard. Every test file must be named by hand in `CMakeLists.txt`; one
  that is not in a list never runs.
- **CI portability:** calendar work belongs in Postgres via `AT TIME ZONE`, never C++ calendar
  functions. pqxx row mappers are `template <typename Row>` (`row_ref` on macOS, `row` on Linux). A
  green local build is not a green CI — watch `gh run` after a backend push, then probe prod.

## Open items

- Web push: no `WebPush` port and no `push_subscription` table. The `channel` column reserves the
  choice.
- Streaming voice (live captions) has no port and no route.
