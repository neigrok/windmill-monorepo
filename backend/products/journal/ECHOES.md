# Echoes

An echo pairs a saved journal page with older passages from the same writer. It shows the original
text and the time between the two pages. Echoes are automatic for signed-in writers; passive
vendor spend has its own allowance.

## Product contract

- Matches reach backward: `match_day < trigger_day`.
- Both passages must share a low-frequency lexical anchor. Similar vectors alone are insufficient.
- Do not infer resolutions, life events or patterns from absent entries. A total is valid only when
  every item it counts is visible and reachable. A named page may say that it has no echo.
- Re-locate every quote by exact text in the live page before rendering it. Do not render a quote
  that no longer exists; compute the visible count after this check.
- A page carries at most ten cards, with at most one card per past day. Echoes remain attached to
  their pages, including when the reader reaches a page through another echo.

## Pipeline

`EchoSweep::derive` performs these steps:

1. Segment a changed body into idea units.
2. Reconcile units against stored passages to retain their `span_id` identities.
3. Embed passages without a reusable vector.
4. Retrieve older candidates across age bands.
5. Select candidates using deterministic rules, dismissals and page limits.
6. Ask the curator whether each pair relates and whether it concerns the writer.
7. Persist spans, verdicts and the versions actually stored.

The ports are `Segmenter`, `Embedder`, `Curator` and `EchoRepository`. The domain owns passage
boundaries, identity reconciliation and selection. Adapters own vendor calls and Postgres.

`AnthropicSegmenter` and `AnthropicCurator` use the model and effort configured by the composition
root. Without a vendor key, the root supplies `RuleSegmenter` and an unconfigured curator; no echo
pass runs. The embedder is the self-hosted multilingual sidecar described in
[its runbook](../../../services/embedder/README.md). Browser search maintains a separate index.
All three ports must be configured for a pass to run.

### Segmentation and identity

`atomsOf` cuts deterministic byte spans. The model returns only atom start indices, such as
`{"starts":[1,3,4]}`; passage text always comes from the original body. The grammar handles line
breaks, terminators, semicolons, colons, spaced dashes, inline list markers and commas in long atoms.
Change `kAtomGrammarVersion` when that grammar changes.

`unitsFrom` repairs duplicate, unordered and out-of-range starts. An empty start list for a page
with multiple atoms is a failure, so that page remains due. `unitsDiscarded` reports unusable
indices. Empty pages and a single short atom require no vendor call.

Segmentation is reused when the stored raw-body digest and segmenter version match. A missing
digest is unknown and requires a new cut. A page with no stored spans is revisited, but an empty
body needs no vendor call. Spoken and typed pages use the same segmentation path.

`SpanReconcile` matches whitespace-normalized text, preserving `span_id` for surviving passages;
duplicates match in document order. `(day, ord)` is only a coordinate. Vector reuse additionally
requires byte-identical passage text and the current embedding version. Dismissals use the content
hashes of both passages, so they survive re-segmentation.

### Retrieval and selection

`SelectionRules` in `domain/EchoSelection.h` is the source of defaults. `selectForPage` is shared by
the sweep and the explain endpoint.

1. Retrieve the best `perBand` candidates at least `minDayGap` days older, separately from the
   7–30 day, 1–3 month, 3–12 month, 1–3 year and 3+ year bands.
2. Suppress a refrain when its neighbor count reaches
   `max(refrainCrowd, ceil(refrainShare * historySize))`.
3. Drop identical normalized text and pairs above the restatement threshold.
4. Require a shared uncommon word. Tokenization uses Unicode code points and case folding;
   `AnchorVocabulary` counts document frequency in the writer's passages. Below `vocabularyFloor`,
   only the built-in English common-word list applies.
5. Collapse similar candidates into families, represented by their oldest member; apply recency
   and calendar-month quotas, while guaranteeing the oldest qualifying candidate a slot.
6. Apply dismissals, keep the highest-scoring pairings per past day, then apply the page cap.

The trace records each candidate's fate: selected, not retrieved, restatement, no anchor, family
member, recency quota, month quota, outranked, dismissed, same day or page cap.

The curator sees candidates chronologically without their cosine scores. It returns a relation
score and `speaker: self | other`, never display copy. Its floor is 0.6: shared themes or generic
states alone do not qualify. Model, effort, prompt digest and relation floor are part of its version.

### Re-derivation and deletion

`replaceEchoes` removes pairings with missing spans and pairings actively rejected by the curator,
`no_anchor` or `restatement`. Losing a quota, family selection or page cap does not retract a
previously accepted echo. A vendor refusal clears all echoes for that trigger page.

The repair pass follows inbound references when a matched page changes, bounded by
`SweepBudget::inboundPerPage`. A fingerprint of the writer's span corpus also reopens stale pages
when passages change or disappear. A page with unchanged body bytes reuses its units and vectors.

`journal_page_curation` stores three versions:

| Version | Invalidates |
|---|---|
| `segment_version` | passage boundaries |
| `embed_version` | vectors |
| `judge_version` | curator verdicts and `SelectionRules` |

`judgeVersion` includes every selection knob. Add a new knob to its digest. For an algorithm change
not represented by those values, the admin sweep accepts `rejudge=1`. Rejudging reuses stored cuts
and matching vectors; changed bodies or absent spans still require segmentation.

Only `ok`, `empty_ok` and `refused` settle a page and advance its derivation stamps. Transport,
rate-limit, truncation and schema failures leave it due. A refusal reopens only on a body edit or
pipeline version change, not corpus movement. Version claims are recorded after the corresponding
spans are stored. `attempts` is diagnostic and does not implement backoff.

## Scheduling and limits

`PageService::write` notifies `EchoDerivations` only after an accepted write. The watcher queues work
under a short mutex; derivation runs on its own thread, round-robin across accounts. The queue drains
every second. `LiveDerivationRules` defaults are:

| Limit | Default |
|---|---|
| Quiet time after save | 8 seconds |
| New text that bypasses quiet time | 400 bytes |
| Derivations per page per rolling day | 4 |
| Derivations per account per rolling day | 40 |
| Pending pages per account | 5 |

Deferred and unqueued pages remain due. A six-hour repair heartbeat scans accounts active in the
last 24 hours, with 40 pages per account, 20 inbound pages per changed page and ten echoes per page.

`Entitlements::sweepAllowanceFor` limits passive `echo.segment` and `echo.curate` spend to an internal
$2 per account per rolling 30 days. Over-budget work is skipped without advancing stamps. Voice
transcription uses the active AI allowance instead. `ai_usage` records vendor usage and outcomes;
use it to measure cost and cache use.

`WarmEchoRepository` caches a corpus per account and embedding version for 15 minutes. Span writes
update the cache; a different embedding version evicts it, and a load that races a write is not
cached. The repository returns at most the newest 20,000 passages. Older passages remain stored but
cannot be retrieved by this projection.

## Persistence

[The schema](../../db/schema.sql) defines the tables and constraints:

| Table | Purpose |
|---|---|
| `journal_span` | stable passage IDs, offsets, text/body digests, vectors and embedding version |
| `journal_echo` | accepted span pairs, relation, cosine, speaker and curator version |
| `journal_echo_dismissal` | retired pairs keyed by both content hashes |
| `journal_echo_signal` | opened/useful/not-useful feedback with the judged model version |
| `journal_echo_offer_dismissal` | a page's retired offer |
| `journal_page_curation` | body/corpus stamps, pipeline versions, outcome and attempts |

Vectors are little-endian float32 `bytea`. There is no thread table or inferred lifecycle. Relations
are recomputed from the passages.

## API

| Route | Purpose |
|---|---|
| `GET /v1/journal/echoes?from=&to=` | owner-only page echoes |
| `POST /v1/journal/echoes/{triggerDay}/offer/dismiss` | retire the offer |
| `POST /v1/journal/echoes/{triggerDay}/dismiss` | retire every pairing on a page |
| `POST /v1/journal/echoes/{triggerDay}/{matchDay}/dismiss` | retire a past-day pairing |
| `POST /v1/journal/echoes/{triggerDay}/{matchDay}/useful` | positive feedback |
| `POST /v1/journal/echoes/{triggerDay}/{matchDay}/opened` | record opening the older page |
| `POST /v1/admin/journal/echo/sweep` | repair pass; admin token required; accepts `sinceMs` and `rejudge` |
| `GET /v1/admin/journal/echo/explain/{day}` | read-only explanation; admin token and owner session required |

Register `offer/dismiss` before `{matchDay}/dismiss`, or Drogon binds `offer` as a date. Pair and
page dismissal routes write content-hash dismissals and `not_useful` signals and return 204 on retry.

The read returns `{pages, pagesWritten, floorWaived}`. Pages carry `day`, `entitled`, `offerRetired`
and `matches`; matches carry `day`, `isSelf`, `source`, `useful`, `text`, `withheldWords` and optional
`occurrenceHint`. Full text is served to all signed-in writers; compatibility fields remain
`entitled: true` and `withheldWords: 0`. The occurrence hint is subordinate to the exact-text check
and is absent when the body changed under the stored span.

The explain endpoint writes nothing. It always embeds the page's passages, calls the curator only
with `curate=1`, and re-segments with `recut=1`. Query parameters include every selection knob,
`echoesPerPage` and `nearest`; malformed values fall back to defaults. The response reports the
actual rules, due state, pipeline versions, corpus size and selection trace.

## Client contract

Render newest matches first, calculate distance from the ISO days, and suppress marks below the
corpus floor unless `floorWaived` is true. Label non-self and spoken passages separately. Marks
appear in page focus, not canvas zoom. Avoid revisiting a day already in the current echo chain,
show depth and provide a route home. There is no pending-state endpoint or progress spinner.

## Known limits and evaluation

- Reusing an unchanged vector also preserves a malformed but well-shaped result. Re-embedding it
  requires an embedding version change; there is no per-passage repair command.
- The corpus fingerprint includes body stamps, so a mood-only save can reopen other pages for
  curation even when their candidates did not change. Candidate-set comparison is not implemented.
- Cache coherence is local to one process; another replica's writes may remain unseen for 15 minutes.
- Atom boundaries cannot split short unpunctuated thoughts. Browser search still uses an English
  embedding model even when the archive contains another language.
- Human quality evaluation is pending: retrieval recall@40 on at least 100 labeled pairs should
  reach 0.90 for pairs older than three months and 0.60 for different-word pairs; kept-echo precision
  should reach 0.85. `journal_echo_signal` records feedback with the curator version.
