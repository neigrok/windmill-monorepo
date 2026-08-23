# Echoes

An echo is the journal reaching back: a page saved tonight paired with older passages of the
writer's own about the same thing, each shown as the passage itself plus how long ago it was
written.

## What an echo is

- **Reaching back only.** The trigger is always a page the writer saved; `check (match_day <
  trigger_day)` makes reaching forward unrepresentable.
- **Always real text.** Every echo is a pair of passages that exist in the archive.
- **Persistent and walkable.** An echo belongs to its page, so a page reached through one echo
  carries its own.
- **Plural, capped.** Up to 10 per page.

Never inferred: that something ended, resolved or went undone; arcs or before/after judgements; mood
scores, categories, or counts of anything the reader cannot see and check.

## Rules that hold

1. **An echo may only assert something the reader can check from what is on screen.** Enforced by a
   shared low-frequency lexical anchor between the two passages: no anchor, no echo, whatever the
   cosine says.
2. **Nothing is inferred from absence.** Never render an empty "no echoes" state, and never present
   a list as *the* times. A total may be shown only when every item it counts is on screen and
   tappable; a truncated list gets no number.
3. **A quote is re-located by text in the live page at render, or not shown.**

## Pipeline

For each page whose body changed, whose corpus moved under it, or whose pipeline version moved:

```
1  segment    page body                    → idea units                     [Segmenter]
2  embed      each passage                 → vector                         [Embedder]
3  reconcile  new passages vs. old         → carry span_id forward          [pure]
4  retrieve   stratified by age band       → candidates                     [repo]
5  select     dedup, quota, diversify      → ≤10 per trigger, ≤10 per page  [pure]
6  curate     tonight's + candidates       → related pairs + speaker        [Curator]
7  persist    ≤10 echoes, replacing the page's prior set                    [repo]
```

**Segmenter** (`ports/Segmenter.h`) cuts the page into idea units, one vendor call per page whose
body moved. `AnthropicSegmenter` runs `claude-sonnet-5` at effort `low`. Without an Anthropic key the
composition root wires `RuleSegmenter` (`segment`, `SegmentRules{minWords = 6, maxSentences = 3}`,
pure); that deploy has no curator either, so no echo can arrive from it.

**Embedder** turns a passage into a vector; a self-hosted bge-small-class model.

**Curator** (`AnthropicCurator`, `claude-sonnet-5` at effort `low`) is one call per changed page. It
sees tonight's passages and the selected candidates and returns, per pair, whether they genuinely
relate plus `speaker: self | other`. It writes no copy: its job is to reject candidates that share
vocabulary without sharing subject, and candidates about someone else's life. It grades every pairing
on the absolute `relation` scale below and **anything under its floor (0.6) is not shown**. The
prompt names the case that band is made of: a shared state — feeling rested, feeling ill, being
tired, a good evening — is two evenings, not an echo.

If any of the three boundaries is unconfigured the pass is a no-op and no echo is written.

## Delivery

- **Live derivation** — `application/EchoDerivations` drains its queue every second and calls
  `EchoSweep::derivePage` for one page, the one a writer just saved. This is the only way anyone
  receives an echo.
- **Repair pass** — `EchoSweep::run`, on a six-hour heartbeat over the last 24 hours of activity:
  inbound reverse edges, corpus-stamp backfill, pages a vendor blip failed, and derivations the
  per-page cap deferred.

The trigger is `PageService::write` via a `PageWatcher`. A write that lost the last-writer-wins guard
changes nothing and announces nothing. `pageSaved` never derives on the request thread: it does map
bookkeeping under a short mutex and returns, and derivation runs on `EchoDerivations`' own trantor
thread.

`LiveDerivationRules`:

| Knob | Value | Meaning |
|---|---|---|
| `quietMs` | 8,000 | quiet time after the last save before the page derives |
| `materialBytes` | 400 | …unless this much new text arrived since the pending entry opened |
| `perPageDaily` | 4 | past it the page is **deferred**: nothing written, no stamp moved, repair pass takes it |
| `dailyWindowMs` | 24 h | the rolling window opens at the page's first derivation, so no timezone is named |
| `pendingPerUser` | 5 pages | past it a save is not queued at all; the page's stamps never moved, so it stays owed |
| `perUserDaily` | 40 | derivations per account per rolling day |

The drain deals round-robin across accounts, not in queue order: one drain thread serves everybody.

`Entitlements::sweepAllowanceFor` is the per-user AI spend ceiling, asked once per user on both
paths. Over budget is **skipped**, not failed: stamps never advance and the page stays owed.

No pending state is served — no progress route, no spinner. The client re-reads on its own.

### A refusal is final

A curator call returning `stop_reason: refusal` is the one failure that **settles** the page
(`isSettled`, `ports/EchoRepository.h`). Every other failure — transport, rate limit, truncation,
unreadable answer — leaves both stamps where they were, so the page comes back as owed. A refusal
advances both stamps, and `duePages` / `duePage` additionally never reopen a row whose status is
`refused` on corpus movement. Only an edit to that body, or a pipeline version bump, reopens it.

A refused page ends carrying no echoes: `derive` calls `clearEchoes`, and step 3 has already replaced
that page's spans.

Nothing is shown to the reader about any of this. The count lives in
`EchoSweepReport::pagesRefused`, apart from `pagesFailed`, and in `journal_page_curation.status`.

### Warm corpus cache

`application/WarmEchoRepository` is an `EchoRepository` decorator holding the user's vector corpus
warm, per (user, embedding version), for 15 minutes.

- `replaceSpans` returns what it stored, so the warm copy is spliced rather than dropped.
- A write under a **different** embedding version drops the entry outright.
- A load that raced a write is returned to its caller and not kept.
- It is exact only **within one process**. A span written by a second replica is invisible for at
  most the TTL.
- `corpusOf` serves at most `kCorpusSpans` (20,000) passages, the most recent. Past that the oldest
  days stop being reachable by an echo; nothing is deleted and no page is refused.

### Segmentation

The page is cut into **idea units**: one thought as its writer would count it.

**The model answers in NUMBERS, never in text.** The page is cut deterministically into **atoms** —
line breaks are hard boundaries, then one sentence each, nothing merged (`atomsOf`) — and the atoms
are numbered and shown to the model, which replies only with the atom each idea unit STARTS at
(`{"starts":[1,3,4]}`). Units are runs of consecutive atoms, so they tile the page, and a unit's
bytes come from the atom offsets. **The model is never given a place to put text**, so misquoting the
writer stops being a thing to detect and becomes a thing that cannot happen.

It shipped the other way round for a few hours — the model returned unit strings and `locateUnits`
searched the body for each, discarding what was not there byte for byte. That check was sound and is
still what the storage-reuse path uses to re-find stored units in a live body, but it makes a
violation *detectable* where the numbers make it *impossible*.

**A wrong answer is repaired, not refused** (`unitsFrom`). Out of range, out of order, duplicated,
missing the opening 1 — all fixed deterministically, and `dropped` counts what could not be used.
This is only safe because the answer is numbers: any partition of a page's own sentences is made of
that page's own bytes, so the worst a confused reply can do is group thoughts badly. Refusing the
page instead would trade a real echo for a cosmetic failure. A reply that is not a list of integers
at all is still a failed call, and the page stays owed.

**The known limit of atoms:** a unit boundary can only fall where the deterministic splitter found
one. A line with no sentence punctuation is one atom and cannot be cut, where the free-text scheme
could have split it. Diaries do write like that; this is the trade the numbers bought.

**The vendor is not asked when there is nothing to decide.** No atoms is an empty page; ONE atom has
no boundary to choose, so it is stored whole without a call. Measured on a real diary: one page in
six is a single line.

`EchoSweepReport::unitsDiscarded` counts repaired indices; above zero on an ordinary night it means
the model is answering about a page it did not read properly.

**The segmenter is asked only when the body moved** (`DuePage::bodyMoved`, computed in SQL). Those
other passes read the units back out of storage.

`journal_page_curation` records three version strings on every settled pass, and both due-ness
queries compare them against what the running build would produce (`PipelineVersions`). Three
strings rather than one, because they go stale differently:

| column | what moved | what it costs |
|---|---|---|
| `segment_version` | the segmenter's prompt or model | the page is **cut** again — a vendor call, so it reports as `bodyMoved` |
| `embed_version` | the embedding model | the units still stand; only their vectors are worthless |
| `judge_version` | the curator's prompt/effort, or **any `SelectionRules` knob** (folded to eight characters by `rulesTag`) | units and vectors stand; only the verdicts are stale |

The columns default to empty, so a row written before them reads as derived by a pipeline that is not
the current one and re-derives over the following passes at the ordinary per-user budget.

**Add a knob to `SelectionRules` and add it to `rulesTag`, or that knob ships silently.** No version
string covers a change to the selection *algorithm* rather than to its knobs; that is what
`POST /v1/admin/journal/echo/sweep?rejudge=1` is for. It takes every page of every scanned writer
instead of the ones the stamps owe, and re-cuts nothing (every page reports as body-unmoved), so it
costs the embedder and the curator and never the segmenter.

A spoken page is cut exactly like a typed one: `ports/Transcriber.h` hands back a finished
`Transcript` with no pause boundaries, and `DuePage` carries no `source` field.

### Passage identity

`(day, ord)` is a coordinate, not an identity. Each passage carries a stable `span_id`, minted from
`journal_span_id_seq` at first derivation. On re-derivation `domain/SpanReconcile` matches old
passages to new by whitespace-normalised text, carries `span_id` forward for survivors, and mints
only for new text; duplicated text within one page is matched in document order. Echoes reference
`span_id`, never position.

Dismissals key on the **content hash of both passages**, so they survive re-derivation,
re-segmentation and a segmenter version bump.

### Retrieval

`stratify` takes the corpus at least `minDayGap` days older than the trigger, then top-`perBand` by
cosine from each age band — 7–30 d, 1–3 mo, 3–12 mo, 1–3 y, 3 y+ — so an old passage competes against
its own era. Retrieval runs **per trigger passage** with a per-passage quota, never one pooled budget
per page.

### Selection

Pure and deterministic, no model (`domain/EchoSelection.h`). `SelectionRules` holds every knob and
nothing else may hardcode these numbers.

1. **Trigger gate.** `crowd(t) = |{c : cos(t,c) >= refrainRadius}|`, excluding the trigger's own row.
   At `crowd(t) >= refrainCrowd` the passage is a refrain and emits nothing.
2. **Drop restatements.** `cos >= restatement` to the trigger is not a memory.
3. **Anchor.** No shared low-frequency word, no echo. `AnchorVocabulary::of` counts document
   frequency over the corpus's passages; a word carried by at least `commonShare` of them is the
   writer's own, not an anchor, and under `vocabularyFloor` passages only the built-in English list
   applies.
4. **Family collapse.** Cluster candidates at `cos >= familyRadius` (single-link); keep the **oldest**
   member as representative, carrying family size. The cap is on families, not passages.
5. **Recency quota.** At most `maxRecent` of the shown set from the last 30 days.
6. **Spread.** At most `maxPerMonth` from any single calendar month.
7. **Guarantee the earliest.** The oldest qualifying candidate takes a slot over the quotas and over
   the score.
8. **Dismissals and the page cap.** `selectForPage` drops pairings the reader retired, then takes the
   page's `SweepBudget::echoesPerPage` best by score — every rule above bounds one trigger only.

Survivors are scored:

```
score = z(t, c) + α·log(1 + age_days/30) − β·log(1 + family_size) − γ·max cos(c, selected)
        α = distanceWeight 0.15   β = familyPenalty 0.25   γ = diversityPenalty 0.50
z(t, c) = (cos(t,c) − μ_t) / σ_t   over this trigger's own candidate background
```

Defaults: `minDayGap` 7, `shown` 10, `refrainRadius` 0.80, `refrainCrowd` 5, `familyRadius` 0.85,
`restatement` 0.97, `perBand` 8, `maxRecent` 2, `maxPerMonth` 2, `commonShare` 0.25,
`vocabularyFloor` 8. `SweepBudget`: `pagesPerUser` 40, `inboundPerPage` 20, `echoesPerPage` 10.

`selectForPage` returns its pairings *and* a `TriggerTrace` per trigger carrying every candidate's
`Fate`: `selected · not_retrieved · restatement · no_anchor · family_member · recency_quota ·
month_quota · outranked · dismissed · page_cap`. `EchoSweep::derive` and the tuning door call the
same function.

### Re-derivation, deletion, the reverse edge

**Outbound.** When a page's body changes, its passages and echoes are recomputed. The replacement is
additive: `replaceEchoes` deletes rows whose trigger or match passage no longer exists, plus the
pairings this pass **actively refused** (`CuratedEchoes::refused`). Two things refuse: the curator,
asked again and answering no; and selection, for a reason intrinsic to the pair — `no_anchor` or
`restatement`. Both hold whatever else is in the corpus that night.

Everything else is kept. A quota, a family, the page cap and a refrain are contingent on the other
candidates that night, and a pairing retrieval never handed over was never looked at, so silence
about a row must never read as a refusal of it.

**A vendor refusal is the one case that clears a page outright** (`clearEchoes`).

**Inbound.** When page X's passages change, every page holding an echo into X (`where match_day = X`)
is enqueued for re-derivation. This is the repair pass's work and not the live path's: the walk is
unbounded, and `SweepBudget::inboundPerPage` bounds it per page.

**Backfill.** A user-level corpus stamp is bumped whenever any page's passages change. A page whose
echoes were computed against an older stamp is stale: it re-runs retrieval and only calls the curator
when the candidate set actually changed.

**Deletion** propagates at both layers: stored passage text is re-located in the live body at render
(not found → not rendered), and a day's passage rows are replaced wholesale at the next derivation.
Match exactly; no case-folding, no fuzzy matching.

## Data model

`db/schema.sql` is authoritative. The tables:

| Table | Key | Holds |
|---|---|---|
| `journal_span` | `(user_id, span_id)` | one passage: `day`, `ord`, byte span `[lo, hi)`, text, `text_sha256` of the normalised text, `vector` as little-endian float32 `bytea`, `embed_version`, `body_stamp_ms` |
| `journal_echo` | `(user_id, trigger_span_id, match_span_id)` | one kept pair: `cosine`, `relation`, `match_is_self`, `curator_version`; `check (match_day < trigger_day)` |
| `journal_echo_dismissal` | `(user_id, trigger_hash, match_hash)` | the reader retired a pairing |
| `journal_echo_signal` | `(user_id, trigger_span_id, match_span_id, kind)` | `opened` / `useful` / `not_useful`, with the `cosine`, `relation` and `curator_version` of the pairing judged |
| `journal_echo_offer_dismissal` | `(user_id, day)` | "not now" — the offer, not the echoes |
| `journal_page_curation` | `(user_id, day)` | `body_stamp_ms`, `corpus_stamp`, `segment_version`, `embed_version`, `judge_version`, `status`, `attempts`, `last_error` |

Indexes that carry the design: `journal_span_page (user_id, day, ord)` for the page read,
`journal_span_hash (user_id, text_sha256)` for the dismissal join, `journal_echo_page
(user_id, trigger_day)` for the read endpoint, `journal_echo_inbound (user_id, match_day)` for the
reverse edge, `journal_echo_signal_page (user_id, trigger_day, kind)` for the `useful` flag on read.

`status` is `ok | empty_ok | transport | rate_limited | truncated | schema_invalid | refused`. `ok`,
`empty_ok` and `refused` advance both stamps; the rest do not. **Never advance `body_stamp_ms` on a
failed curate.** `attempts` counts consecutive unsettled failures and is a diagnostic — nothing backs
off on it.

`relation` is an absolute score defined by the curator's prompt: 0.9+ the same specific thing,
0.6–0.8 that thing seen later, 0.3–0.5 the same theme and not the same subject. `AnthropicCurator`
drops anything under its floor (0.6) and stores the grade as given. `z` and `family_size` are
computed in `domain/EchoSelection` and persisted nowhere.

## Layering

```
domain/       Passage         body → atoms, unitsFrom, locateUnits     (pure)
              SpanReconcile   old spans + new → span_id carry-forward  (pure)
              EchoSelection   stratify, select, selectForPage, traces  (pure)
ports/        Segmenter · Embedder · Curator · EchoRepository
application/  EchoSweep            the seven steps — derivePage (live) · run (repair)
              EchoDerivations      saves → derivations: debounce, caps, its own thread
              EchoExplain          one page's derivation, for its reasons, persisting nothing
              WarmEchoRepository   the corpus held warm, per user, behind the port
adapters/     postgres/PgEchoRepository · llm/HttpEmbedder · llm/AnthropicCurator
              llm/AnthropicSegmenter · http/EchoApi
```

No thread table and no lifecycle: the relation between two passages is recomputed from the passages
themselves.

## API

| Route | Purpose |
|---|---|
| `GET /v1/journal/echoes?from=&to=` | echoes on pages in the range, grouped by page, owner only |
| `POST /v1/journal/echoes/{triggerDay}/offer/dismiss` | retire the offer for this page |
| `POST /v1/journal/echoes/{triggerDay}/dismiss` | retire every pairing on this page |
| `POST /v1/journal/echoes/{triggerDay}/{matchDay}/dismiss` | retire one passage pair |
| `POST /v1/journal/echoes/{triggerDay}/{matchDay}/useful` | the positive signal, one pairing |
| `POST /v1/journal/echoes/{triggerDay}/{matchDay}/opened` | the walk back to the older page, recorded |
| `POST /v1/admin/journal/echo/sweep` | run one repair pass, admin token; `sinceMs` in body or query |
| `GET /v1/admin/journal/echo/explain/{day}` | what a derivation of that page decides right now, rule by rule — admin token AND a signed-in owner |

**Route order is load-bearing.** `/{triggerDay}/offer/dismiss` is registered before
`/{triggerDay}/{matchDay}/dismiss`: drogon matches in registration order and `{matchDay}` binds the
literal `offer`, so the swapped order answers a decline with `400 bad date`.

Both dismissal doors write the same content-hash key, both record the `not_useful` signal, and both
answer 204 however many times they are pressed. The panel-level door is one request for the whole
page. A dismissal says two separate things with different lifetimes — the pair is retired (content
hash, survives a rewrite) and the pairing was wrong (span-keyed judgement) — so it is two rows in two
tables.

The read answers `{ pages: [{ day, entitled, offerRetired, matches: [...] }], pagesWritten,
floorWaived }`. Per match: `day`, `isSelf`, `source`, `useful`, `text`, `withheldWords`, and
`occurrenceHint` where it applies.

- **Text and ISO days, never an offset.** The client re-locates by text and formats distance itself.
- **`occurrenceHint`** is which occurrence of that text the passage is (0 for the first). It is
  absent when the body moved under the passage and absent under the honest cut, and it is always
  subordinate to the text check.
- **`pagesWritten`** is how many pages the reader has words on; the corpus floor is a rule about the
  whole corpus and the browser cannot count pages it has not synced.
- **`floorWaived`** is true for the owner account (`Entitlements::isOwner`), because below the floor
  the client draws nothing at all.
- **`useful` and `offerRetired` are served, not device-local**, and `useful` is served on both sides
  of the honest cut.

### The tuning door

`GET /v1/admin/journal/echo/explain/{day}` runs one page's derivation for its reasons and writes
nothing — no span row, no echo row, no curation or corpus stamp — so it never settles a page the live
path still owes.

- **Two credentials.** The admin token opens the door; the session says whose journal it is. It
  explains the caller's own page only.
- **It spends.** The embedder is called for the page's passages every time. The curator is called
  only for `?curate=1`.
- **Every `SelectionRules` knob is a query parameter**, plus `echoesPerPage`, `nearest`, `curate` and
  `recut`. A malformed value falls back to the configured default rather than 400ing; the rules the
  run actually used travel back in the answer.
- **`recut=1`** cuts the page again instead of reading back stored units — a second vendor call.
- **`nearest=N`** reports the N closest passages retrieval never handed over as `not_retrieved`. It
  costs one extra cosine pass over the corpus per trigger, which is why the live path asks for none.

The answer also states whether the page is **due** at all, the embedding version and how many corpus
passages are stored under it, the segmenter's passages, and what the page carries today.

## Entitlement

Echo marks are locked, not hidden. A non-subscriber sees the mark, the count, the real opening words
of the passage (`kFreeWords` = 8), the withheld word count, and every match's date and distance.

**The sweep is entitlement-blind and the gate lives in the read layer**: `EchoApi::listEchoes` asks
`Entitlements::hasWindmillOne` once and the serialiser serves either full text or a prefix plus
`withheldWords`.

What the lock may never become:

- no blurred or scrambled text standing in for words that exist;
- no fake preview — every character shown is a character the reader wrote;
- no manufactured count of what they are missing, and no count of anything they cannot check;
- no urgency, no expiry, no social-proof nudges.

Deriving for every user rather than only subscribers multiplies embed and curate spend by the
free-to-paid ratio; `sweepAllowanceFor` is the brake.

## The surface

A mark on a page, not a notification. The canon defines the states; what the backend requires:

- Newest first, oldest at the bottom.
- Distance is rendered client-side from the two ISO days.
- `count` is computed after re-location succeeds, so the mark and the card cannot disagree.
- No marks and no offer below the corpus floor, unless the server says `floorWaived`.
- Label non-self passages: `isSelf: false` and `source: 'spoken'` each get their own line of copy.
- No marks at canvas zoom. Page focus only.
- Chain hygiene: never offer a day already visited in this session; show depth; offer a way home.

## Cost and scale

The cosine arithmetic is free; the corpus load is not. Vectors are stored as `bytea` float32, 12.3 MB
at 8,000 passages × 384 dims. Select vectors without page bodies. Brute force is correct at this
scale; `pgvector` is the escape hatch behind the repository, and `WarmEchoRepository` amortises the
load across an evening's derivations.

Curator: ~2,600 input tokens, and output is the expensive half — thinking is on by default on this
family and bills as output, so `effort` is the only real cost lever.

Segmenter: one call per page whose body moved, so it also runs on pages that end up proposing
nothing. Its input is the page and its output is the page again, so it bills roughly two page-lengths
per call.

Four traps, each producing a silent failure:

- **`max_tokens` caps thinking + response together.** A curator sized around its JSON output
  truncates mid-JSON.
- **Check `stop_reason` before reading `content`** — a refusal is HTTP 200 with empty or partial
  content, and reaches the sweep as `refused`, which settles the page.
- **Do not disable thinking to save money** — lower `effort` instead. On Sonnet 5 `adaptive` is the
  only on-mode.
- **Use structured outputs** (`output_config.format`) — it eliminates the schema-invalid branch.

The system prompt does not cache: Sonnet 5's minimum cacheable prefix is 1024 tokens and the prompt
is ~800, so the `cache_control` marker is a no-op (`cache_creation_input_tokens: 0`). Keep it
byte-stable regardless — the curator folds its prompt digest into `curator_version`.

Present candidates to the curator **chronologically, without their cosine scores**.

## Quality gates

None of these has been run; `journal_echo_signal` is the collection apparatus and it is empty.
`curator_version` rides along on every row, so the dataset separates model vintages by that column.

| Gate | Threshold |
|---|---|
| recall@40 of retrieval, per age band, on ≥100 hand-labelled pairs | ≥0.90 above 3 months |
| recall@40 on **different-words** pairs specifically | ≥0.60 |
| curator precision on kept echoes, human-judged | ≥0.85 |
