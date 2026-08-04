# Echoes

## The idea

An echo is your journal remembering for you.

You write tonight. The journal reaches back and shows you what you wrote before about the same
thing — the older passage itself, and how long ago. That is the whole feature. It does not conclude,
advise, or grade. It only ever says: *you thought about this before, here it is.*

1 January: "i want to learn c++."
1 May: "i like c++."

The May page carries an echo pointing at 1 January. Maybe he'd forgotten he ever planned it. If he
leaned toward C++ nine other times across five years, those show too — not as a verdict, as dated
passages he can read. That is what makes it useful when he's deciding something.

### What an echo is

- **Reaching back, never tracking forward.** The trigger is always a page you wrote. The journal
  never speaks on its own initiative.
- **Always pointing at text that exists.** Every echo is a pair of real passages. Nothing is
  inferred about what you didn't write.
- **Persistent and walkable.** An echo belongs to its page. Scroll back a month, find an echo on
  that page reaching two months further back, open *that* page, find its echo reaching a year back.
  The journal becomes navigable through its own resonances.
- **Plural.** Show what was found, up to ten. Never a total — see *Rules*.
- **Compounding.** More history means better candidates. The feature is worth more in year three
  than year one, and that is honest.

### What an echo is not

Deliberately absent, and to stay absent:

- No claim that something ended, resolved, or stopped.
- No claim that something you said you'd do went undone.
- No arc, no "you've changed", no before/after judgement.
- No mood scores, no categories, no counts of anything the reader can't see and check.

These were considered and cut. Each requires reasoning from the *absence* of writing, and absence
in a journal means a dozen things the journal cannot distinguish — the subject resolved, or became
unwriteable, or moved to therapy, or the person died, or the writer simply stopped writing. A
feature that reasons from silence will, on a schedule, tell someone their live struggle is over.

**But note what reaching back does not escape.** Placing two dated passages together is itself a
rhetorical act. "Told Marta I'd stop drinking. Meant it this time." surfaced under tonight's "Two
glasses and then the rest of the bottle" makes no claim and delivers a verdict. There is no
operation that produces the kind juxtaposition (C++) and not the cruel one; they are the same
operation with different inputs. The design does not solve this — it *bounds* it: both passages are
the user's own, both are on screen, the arrangement is chronological rather than argued, and the
selection rules below stop the cruel case arriving ten times on the worst night of someone's year.

## Owner decisions

| Decision | Value |
|---|---|
| Where it computes | Server-side (the server holds the journal anyway, for sync) |
| Minimum age gap | **7 days** — a page younger than a week is not an echo |
| How many shown | **Up to 10** per page |
| Persistence | **Persisted and navigable** — echoes are a durable property of a page |
| Quality vs. cost | **Quality wins.** Vendor inference permitted under a no-retention agreement |

## Pipeline

Nightly, for each page whose body changed since its last derivation:

```
1  segment    page body                    → passages                  [pure]
2  embed      each passage                 → vector                    [Embedder]
3  reconcile  new passages vs. old         → carry span_id forward      [pure]
4  retrieve   stratified by age band       → ~40 candidates             [repo]
5  select     dedup, quota, diversify      → ≤12 for curation           [pure]
6  curate     tonight's + candidates       → related pairs + speaker    [Curator]
7  persist    ≤10 echoes, replacing the page's prior set                [repo]
```

**Embedder** turns a passage into a vector. A self-hosted bge-small-class model is sufficient —
measured pair-similarity on a single-author journal corpus has median 0.464 and sd 0.091, so the
space does *not* degenerate on one-author prose. Do not buy a bigger embedder before the selection
rules below are in place; the failure mode is repetition dominating the top of the ranking, not
everything looking alike.

**Curator** is one call per changed page. It sees tonight's passages and the selected candidates and
returns, per pair, whether they genuinely relate — plus `speaker: self | other` for each candidate.
**It writes no copy and asserts nothing.** Its job is to reject candidates that share vocabulary
without sharing subject, and to reject candidates that are about someone else's life rather than the
writer's. Model: `claude-opus-5`.

If either boundary is unconfigured, the pass is a quiet no-op and no echo is written.

### Segmentation

Deterministic and pure. **Line breaks are hard passage boundaries** (`journal_page.body` keeps soft
line breaks), then split within a line to land at roughly one to three sentences. This matters: a
large fraction of nightly journalers write bare lists with no terminal punctuation, and sentence
splitting alone turns three unrelated items into one mush passage.

Pages with `source = 'spoken'` have no reliable sentence boundaries — segment those on ASR pause
boundaries where available, otherwise fixed overlapping windows.

Merge any passage under ~6 words into its neighbour. Measured: passages of ≤5 words have a mean hub
score of 18.4 versus 7.4 for ≥10 words — fragments are universal attractors.

Embed each passage **with one sentence of surrounding context**, and store the span separately for
quoting. Measured: bare "tired." matches every other "tired."; with its neighbouring sentence it
matches the right kind of tired.

### Passage identity

**`(day, ord)` is a coordinate, not an identity.** Insert a sentence at the top of a page and every
ordinal shifts. That silently re-points every inbound echo to the wrong sentence — and the render
guard cannot catch it, because the wrong text *does* locate in the live body.

So each passage carries a stable `span_id`, minted at first derivation. On re-derivation, match old
passages to new ones by text (exact → whitespace-normalised → high cosine) and **carry `span_id`
forward for survivors**, minting only for genuinely new text. Echoes reference `span_id`, not
position.

Dismissals live in their own table keyed on the **content hash of both passages**, so they survive
re-derivation, re-segmentation, and a segmenter version bump. A dismissed echo returning is the most
trust-destroying failure this feature has; the user told it to fade.

### Retrieval — stratified, not flat

Take top-k from each age band rather than a global top-N:

| Band | k |
|---|---|
| 7–30 days | 8 |
| 1–3 months | 8 |
| 3–12 months | 8 |
| 1–3 years | 8 |
| 3 years+ | 8 |

Same cost, and it directly serves the intent: *"they may have forgotten they ever planned it"* is a
function of age, so old passages must compete against their own era rather than against last
Tuesday. A flat top-30 on a dense corpus fills with recent structural near-duplicates and the 1
January passage never surfaces.

Retrieve **per trigger passage** with a per-passage quota, not one pooled budget per page —
otherwise one loud passage takes every slot and the rest of the night is starved.

### Selection — the rules that stop the mirror

Pure, deterministic, no model. These exist because the previous design's rate limit was accidentally
doing safety work, and removing it exposed what retrieval does during a hard stretch: someone writing
nightly through the worst month of their life otherwise receives ten near-copies of last week, every
night, forever.

1. **Trigger gate.** `crowd(t) = |{c : cos(t,c) > 0.80}|`. If `crowd(t) ≥ 5`, the passage is a
   refrain ("tired again", "long day") — emit nothing for it. Measured: "tired again today" has 22
   candidates above 0.80; every genuine echo trigger has 0–6.
2. **Family collapse.** Cluster candidates at cos ≥ 0.85 (single-link); keep the **oldest** member
   as representative, carrying family size. Cap at 10 *families*, not 10 passages.
3. **Drop restatements.** `cos ≥ 0.97` to the trigger is not a memory.
4. **Recency quota.** At most 2 of the shown set from the last 30 days.
5. **Spread.** At most 2 from any single calendar month.
6. **Guarantee the earliest.** The oldest qualifying passage always gets a slot. The whole thesis is
   *"you may have forgotten you ever planned it"* — the first time is the payload, and nothing else
   in the ranking protects it.

Then score the survivors:

```
score = z(t, c) + α·log(1 + age_days/30) − β·log(1 + family_size) − γ·max cos(c, selected)
        α ≈ 0.15   β ≈ 0.25   γ ≈ 0.50
z(t, c) = (cos(t,c) − μ_t) / σ_t   over this trigger's own candidate background
```

`z`, not raw cosine: measured top-1 cosine across triggers runs p10 0.594 → p50 0.704 → p90 0.889,
so a single global threshold is meaningless. The distance term exists because **the card sells
distance and nothing else ranked on it.**

### Re-derivation, deletion, and the reverse edge

A page's echoes are a function of its body *and* of the corpus. Three consequences:

**Outbound.** When a page's body changes, its passages and echoes are recomputed and replace the
previous set — never appended. Persistence is **additive within that**: a previously-persisted echo
whose passage still locates is kept, because the curator is non-deterministic and a typo fix must
not silently destroy a chain the user has walked.

**Inbound.** When page X's passages change, enqueue re-derivation for every page holding an echo
into X (`WHERE match_day = X`). Without this, fixing one typo in a January page permanently kills
every echo pointing at it, and the graph decays with the user's own care for their archive. Budget
the queue — a 300-page cleanup pass must drain over several nights, not bill in one.

**Backfill.** A user-level corpus stamp, bumped whenever any page's passages change. A page's echo
set is stale when computed against an older stamp; stale pages re-run *retrieval* (free) and only
call the curator when the candidate set actually changed. Without this the owner's own example fails
for anyone who backfills: write "i like c++" on 1 May, then add the 1 January page on 3 May, and the
May page never learns January exists.

**Deletion** propagates at both layers: the stored passage text is re-located in the live body at
render (not found → not rendered), *and* passage rows whose text no longer occurs are deleted at the
next sweep. Re-location prefers the stored `[lo, hi)` and uses the text to verify it, falling back to
the nearest occurrence — never a bare first-occurrence search, which mis-anchors on repeated
sentences. Match exactly; do not case-fold or fuzzy-match, because every forgiving normalisation
weakens the redaction guarantee.

## Data model

```sql
create table journal_span (
  user_id       uuid not null references users(id) on delete cascade,
  span_id       bigint not null,        -- stable identity, carried across re-derivation
  day           date not null,
  ord           int  not null,          -- position; a coordinate, never an identity
  lo            int  not null,          -- char span in the page body [lo, hi)
  hi            int  not null,
  text          text not null,
  text_sha256   bytea not null,
  vector        bytea not null,         -- float32 or int8-quantized; NOT ::text (see Cost)
  embed_version text not null,          -- retrieval never compares across versions
  body_stamp_ms bigint not null,
  primary key (user_id, span_id)
);
create index journal_span_page on journal_span (user_id, day, ord);

create table journal_echo (
  user_id         uuid not null references users(id) on delete cascade,
  trigger_day     date not null,
  trigger_span_id bigint not null,
  match_day       date not null,
  match_span_id   bigint not null,
  cosine          real not null,        -- the retrieval signal
  relation        real not null,        -- the curator's judgement; never compared across calls
  curator_version text not null,
  prompt_hash     text not null,
  created_at      timestamptz not null default now(),
  primary key (user_id, trigger_span_id, match_span_id),
  check (match_day < trigger_day)
);
create index journal_echo_page    on journal_echo (user_id, trigger_day);
create index journal_echo_inbound on journal_echo (user_id, match_day);

create table journal_echo_dismissal (
  user_id      uuid not null references users(id) on delete cascade,
  trigger_hash bytea not null,
  match_hash   bytea not null,
  created_at   timestamptz not null default now(),
  primary key (user_id, trigger_hash, match_hash)
);

create table journal_page_curation (
  user_id       uuid not null references users(id) on delete cascade,
  day           date not null,
  body_stamp_ms bigint not null,
  corpus_stamp  bigint not null,
  status        text not null,          -- ok | empty_ok | transport | rate_limited
                                        -- | truncated | schema_invalid | refused
  attempts      int  not null default 0,
  last_error    text,
  updated_at    timestamptz not null default now(),
  primary key (user_id, day)
);
```

`CHECK (match_day < trigger_day)` makes reaching forward unrepresentable rather than merely
unimplemented. `journal_echo_inbound` is what makes reverse-edge re-derivation a lookup rather than
a scan. `journal_page_curation` is what stops a page that failed at 02:14 from being echo-less
forever — **never advance `body_stamp_ms` on a failed curate**; the shipped vector path advances it
on completion and porting that idiom naively loses the page permanently.

## Layering

```
domain/       Passage         body → passages                        (pure)
              Reconcile       old spans + new → span_id carry-forward (pure)
              Stratify        candidates → age-banded selection       (pure)
              Select          dedup, quota, spread, score             (pure)
ports/        Embedder · Curator · EchoRepository
application/  EchoSweep       the seven steps, top to bottom
adapters/     PgEchoRepository · <Embedder impl> · AnthropicCurator
```

No thread table. No lifecycle. No identifier that must stay semantically stable across years — the
relation between two passages is recomputed from the passages themselves.

## API

| Route | Purpose |
|---|---|
| `GET /v1/journal/echoes?from=&to=` | echoes on pages in the range, owner only |
| `POST /v1/journal/echoes/:trigger/:match/dismiss` | retire one passage pair |
| `POST /v1/admin/journal/echo/sweep` | operator rehearsal of one pass, admin token |

Entitlement stays where it is: checked in the sweep, so a non-subscriber's table is simply empty.
Absent, not locked.

## The surface

**A mark on a page, not a notification.** Opening the page is the user's act — the design's own
principle is that the journal never speaks on its own initiative, and an unrequested modal on open
is speaking on its own initiative even when the content is reactive. It also avoids framing tonight's
entry with last night's retrieval before the user has written.

- **Anchor the mark to the trigger passage**, not the page. Then both halves of the relation are on
  screen, in context, without ever building a before/after diptych.
- **Oldest first.** Read top-down, a list becomes reach ("this goes back to 2024"). Newest-first, the
  same data becomes accumulation ("and again, and again"). Same rows, opposite rhetoric.
- **Render ~3, the rest behind an expand.** A stack of ten is a verdict; three with a door is a door.
- **"212 days earlier"**, computed from the trigger day — not "ago", which is deictic and wrong on
  every page but tonight's.
- **Label non-self passages** — `speaker: other` renders as *"something you copied down, 14 Feb"*.
  Presence is not the harm; misattribution is. Same for `source = 'spoken'`: *"from your voice note"*,
  because quoting an ASR mishearing as the user's own sentence is a fabrication they cannot falsify.
- **No marks at canvas zoom.** Mark density is a function of verbosity and lexical distinctiveness,
  not significance — a glowing articulate month beside a bare grieving one is an assertion nobody
  wrote. Page focus only.
- **Chain hygiene:** never offer a day already visited in this session; show depth ("four pages back
  — March 2024"); always offer a way home. A maximum-similarity walk with no floor converges on
  whatever the user has written about most, which for some people is rumination.

## Cost and scale

Measured, not estimated, at 8,000 passages × 384 dims with the shipped wire format:

| | |
|---|---|
| cosine scan, 8 probes | **14 ms** |
| parse back (`strtof`) | 73 ms |
| serialize (`snprintf %.9g`) | 419 ms |
| **wire bytes, Postgres text arrays** | **39.6 MB per user per night** |

The arithmetic is free; the corpus load is not. Store vectors as `bytea` float32 (12.3 MB) or int8-
quantized (3.1 MB, ~0.5% recall cost — the on-device search path already quantizes, so the precedent
exists). Select vectors without page bodies. Brute force is correct at this scale and keeps exact
recall measurable; `pgvector` is the escape hatch behind the repository if corpora outgrow it.

Curator: ~2,600 input tokens, and **output is the expensive half** — on Opus 5 thinking is on by
default at effort `high`, and thinking bills as output. Roughly $0.02–0.09 per page depending on
effort. Sweep the effort levels and measure the quality delta before defaulting; the low end is
unusually strong on this model and this is fundamentally a "reject the vocabulary twins" task.

Four Opus 5 traps, each of which produces a silent failure:

- **`max_tokens` caps thinking + response together.** A curator sized around its JSON output will
  truncate mid-JSON now that thinking is on by default.
- **Check `stop_reason` before reading `content`** — a refusal is HTTP 200 with empty or partial
  content. Consider `fallbacks: "default"`.
- **Do not disable thinking to save money** — lower `effort` instead. Disabled thinking can leak
  `<thinking>` tags into the response and break JSON parsing.
- **Use structured outputs** (`output_config.format`) — it eliminates the schema-invalid branch.

Cache the system prompt: Opus 5's minimum cacheable prefix is 512 tokens, so an ~800-token system
prompt caches at ~0.1× on reads. Keep it byte-stable; never interpolate per-request content into it.

Present candidates **chronologically, without their cosine scores** — sorted by score, the curator
inherits the retriever's prior and ratifies the top of the list, which is frequently the vocabulary
twin it exists to reject.

## Migration

Replaces the shipped page-level cosine implementation. Landing it invalidates:

- `domain/EchoFinder.{h,cpp}` + `test/products/journal/domain/EchoFinderTest.cpp`
- `application/EchoSweep.cpp` + `test/products/journal/application/EchoSweepTest.cpp`
- `adapters/postgres/PgEchoRepository.cpp`, `adapters/http/EchoApi.cpp` + `EchoApiTest.cpp`
- `ports/EchoRepository.h`; `test/products/journal/Fakes.h` (needs a `Curator` fake)
- `test/e2e/journal_echo.sh`
- `db/schema.sql` — `journal_page_vector` → `journal_span`; `journal_echo` re-keyed
- `web/src/products/journal/{EchoCard.jsx,useEchoes.js}` — plural, page-anchored, chainable, and
  `EchoCard`'s `body.slice(lo, hi)` becomes verified re-location
- `ARCHITECTURE.md` §5.1–5.4, the `journal_echo` row of the entity table at §265, and **§5.2's "rows
  are never deleted"**, which this design contradicts

`GET /v1/journal/vectors` (§8.2) seeds the on-device search index from `journal_page_vector`, which
this removes. **Open:** serve span vectors instead (likely better for search too), or keep page
vectors solely for search. Decide before the migration.

## Rules that hold

1. **An echo may only assert something the user can check from what is on screen.** Not merely
   *evidenced* — *checkable*. Two pronoun-only passages ("he was awful again tonight", written 18
   months apart about different men) present maximal apparent evidence for a relation and zero
   checkable evidence. Enforcement: require at least one shared low-frequency lexical anchor between
   the two passages. No anchor, no echo, whatever the cosine says. The C++ case passes on "c++".
2. **Nothing is ever inferred from absence.** No predicate reads a gap; the `CHECK` forbids forward
   reach. Corollary for the surface: never render an empty "no echoes" state, and never present a
   list as *the* times — it is the closest ten, and no total is ever computed or shown.
3. **A quote is re-located and verified in the live page at render, or not shown.** Verified means
   the span's text still hashes to what the echo was built from — locating alone is not enough,
   because after an edit the wrong text locates successfully.

## Before a paying user sees this

| Gate | Threshold |
|---|---|
| recall@40 of retrieval, per age band, on ≥100 hand-labelled pairs | ≥0.90 above 3 months |
| recall@40 on **different-words** pairs specifically | ≥0.60 — the half the product exists for |
| curator precision on kept echoes, human-judged | ≥0.85 |
| curator "none" rate on 40 labelled no-echo nights | ≥0.80 |
| curator self-consistency, 5 runs, Jaccard on kept set | ≥0.90 |
| identity-survival suite (append / insert-top / insert-mid / delete / split / merge / segmenter bump) | **100%** |
| render-time re-locate failure rate, and 0% mis-anchored | <2% |
| corpus load per user per night | <5 MB, <1 s |
| median age of shown echoes | ≥90 days — the card says "212 days earlier" |
| hubness: max share of a user's pages any one passage appears on | ≤5% |

Persist the **"Read it"** tap alongside dismissals, with cosine, z, family size and age attached.
It is already on screen and currently thrown away; within a month it is a real relevance dataset,
collected honestly from a button the user was already pressing.
