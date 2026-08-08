# Echoes

> **Provenance, because the commit trail does not say so.** This feature was built in one wave but
> landed inside two commits whose messages describe unrelated appearance work, because a parallel
> process committed the shared index while this was in flight:
>
> - **`c5ff152`** *"journal: one control for light or dark, and it is the one in settings"* — the
>   schema, port and adapter, `Passage` / `SpanReconcile` / `EchoSelection`, the rewritten
>   `EchoSweep`, `EchoApi`, the curator, the embedder sidecar, and the first web surface.
> - **`3c9906e`** *"web: one appearance, chosen once, and journal stops carrying its own switch"* —
>   the API-gap round: `occurrenceHint`, `pagesWritten`, and the page-level dismissal.
>
> Both were already pushed when this was noticed, so the history is not being rewritten. Anyone
> bisecting for when echoes arrived should look there and not trust either subject line.

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
5  select     dedup, quota, diversify      → ≤10 per trigger, ≤10 per page  [pure]
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

Merge any passage under ~6 words into its neighbour. Measured: passages of ≤5 words have a mean hub
score of 18.4 versus 7.4 for ≥10 words — fragments are universal attractors.

Everything above is built (`domain/Passage.h` — `segment` is one pure function of the body, with
`SegmentRules{minWords = 6, maxSentences = 3}`). The next two paragraphs are **designed, not
built**, and are kept because both are still the right answer, not because either is running.

**Designed, not built — a spoken page segments exactly like a typed one.** The intent: pages with
`source = 'spoken'` have no reliable sentence boundaries, so segment those on ASR pause boundaries
where available and otherwise on fixed overlapping windows. Neither half can be built as it stands.
There are no pause boundaries to read — `ports/Transcriber.h` hands back a finished `Transcript`
and nothing else, so "where available" is never — and overlapping windows change what a *quote* is,
from a sentence to a slice, which the surface and the dismissal hashes both key on. It needs a
decision before it needs code. `DuePage` deliberately carries no `source` field: it was plumbed
from the page row through the port and read by nothing, which is a claim that this rule ships.

**Designed, not built — a passage is embedded as itself.** The intent: embed each passage with one
sentence of surrounding context and store the span separately for quoting. Measured: bare "tired."
matches every other "tired."; with its neighbouring sentence it matches the right kind of tired.
Today `EchoSweep` embeds `passage.text` and stores that same text. Building it is not a small
change — what is embedded stops being what is quoted, so it is an `embed_version` bump and a
re-embed of every corpus, and retrieval reads one version only by design.

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

1. **Trigger gate.** `crowd(t) = |{c : cos(t,c) >= 0.80}|`, excluding the trigger's own row. If `crowd(t) ≥ 5`, the passage is a
   refrain ("tired again", "long day") — emit nothing for it. Measured: "tired again today" has 22
   candidates above 0.80; every genuine echo trigger has 0–6.
2. **Family collapse.** Cluster candidates at cos ≥ 0.85 (single-link); keep the **oldest** member
   as representative, carrying family size. Cap at 10 *families*, not 10 passages.
3. **Drop restatements.** `cos ≥ 0.97` to the trigger is not a memory.
4. **Recency quota.** At most 2 of the shown set from the last 30 days.
5. **Spread.** At most 2 from any single calendar month.
6. **Cap the page, not just the trigger.** Every rule above bounds ONE trigger passage's
   pairings. A page with eight triggering passages would otherwise carry eighty echoes, so the
   sweep takes the page's ten best by score — the only place a whole page is in view.
7. **Guarantee the earliest.** The oldest qualifying passage always gets a slot. The whole thesis is
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
  curator_version text not null,        -- model/effort/prompt-digest — the prompt's identity is IN it
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

-- "Not now". Keyed on the DAY, not on content — the offer belongs to the page, not to a pairing.
create table journal_echo_offer_dismissal (
  user_id    uuid not null references users(id) on delete cascade,
  day        date not null,
  created_at timestamptz not null default now(),
  primary key (user_id, day)
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
| `GET /v1/journal/echoes?from=&to=` | echoes on pages in the range, grouped by page, owner only |
| `POST /v1/journal/echoes/:triggerDay/dismiss` | "Not useful" — retire every pairing on this page |
| `POST /v1/journal/echoes/:triggerDay/:matchDay/dismiss` | retire one passage pair |
| `POST /v1/journal/echoes/:triggerDay/offer/dismiss` | "Not now" — retire the offer for this page |
| `POST /v1/journal/echoes/:triggerDay/:matchDay/opened` | the relevance signal (see *Measurement*) |
| `POST /v1/admin/journal/echo/sweep` | operator rehearsal of one pass, admin token |

"Not useful" is **panel-level on the surface, so it is one request** — nine matches must not cost
nine round trips, each able to fail on its own and leave a page half faded. Both dismissal doors
write the same content-hash key, and both answer 204 however many times they are pressed.

**"Not now" is a different answer and costs the reader nothing.** It retires the *offer*, never the
echoes: the page keeps every match and its honest cut, and only stops selling. Two decisions in its
shape are deliberate and should not be tidied away:

- **It is server-side, not a device flag.** "We asked you to pay and you said not now" is precisely
  the answer that has to survive the trip to another device. A `localStorage` flag means the same
  person is asked again on their phone, which is manufactured nagging and the mission rule forbids it.
- **It keys on the DAY, not on a passage hash** — unlike both dismissal doors, and on purpose. The
  offer belongs to the page, not to any pairing on it, so re-deriving or rewriting the page must not
  put the question back. Aligning it with `journal_echo_dismissal` "for consistency" would restore
  exactly the nagging the first point rules out.

The read carries the answer back per page as `offerRetired`, so the surface never has to remember
it locally — which was the whole problem.

**Route order is load-bearing.** `/:triggerDay/offer/dismiss` must be registered *before*
`/:triggerDay/:matchDay/dismiss`: drogon matches these in registration order and `{matchDay}` binds
the literal `offer` quite happily, so the swapped order answers a decline with `400 bad date`.
Measured against the running server, not reasoned about.

The read sends passage **text and ISO days**, never an offset — the client re-locates by text and
formats distance itself. Offsets are byte counts and the browser slices UTF-16 code units; the two
diverge on the first non-ASCII character in a page, and a codepoint offset diverges again at the
first emoji. What the read does send, per match, is `occurrenceHint`: **which occurrence of that
text the passage is** — 0 for the first in the match page's body, 1 for the second. It has no
encoding in it to disagree about, and it is what stops a page saying "i don't know." twice from
anchoring the quote to the wrong one. It stays a hint: absent when the body has moved under the
passage, absent under the honest cut (the text served there is a prefix), and always subordinate to
the text check, which is what actually decides whether the quote is shown.

The read also carries `pagesWritten` at the top level — how many pages the reader has words on.
The ~20-page corpus floor below is a rule about the whole corpus, and the browser cannot count
pages it has not synced, so the floor is unenforceable unless the server states it.

**`firstEchoEver` is not derivable and is not served.** `journal_echo.created_at` records when a
row was *written*, not when anyone *saw* it, and the once-ever card is about the second. Nothing
here records delivery — `opened` is logged, not tabled — so the honest options are a `seen` record
the client writes once, or no card. A device-local flag is not one of them: it cannot know an echo
already arrived on another device.

### Entitlement — moved, and this needs the owner's ruling

Previously: checked in the sweep, so a non-subscriber's table stayed empty. *Absent, not locked.*

The design canon supersedes this. Its "honest cut" state shows a non-subscriber the mark, the count,
the **real opening words** of the nearest passage, the withheld word count, and every match's date
and distance. That cannot be served from an empty table, so **the sweep runs for everyone and the
gate moves to the read layer** — entitled serves full text, unentitled serves a prefix plus
`withheldWords`.

Two consequences the owner should weigh rather than inherit:

- **Cost.** Computing for every user, not only subscribers, multiplies the nightly embed and curate
  spend by the free-to-paid ratio.
- **Feel.** "Absent, not locked" hid the feature entirely; the honest cut instead shows someone
  their own words and withholds the rest of them. It is arguably the more honest of the two — it
  tells the truth about what exists rather than concealing it — but it is a different promise, and
  the mission rule ("no dark patterns") deserves a deliberate answer rather than a default.

**Built so the answer is a policy flip, not a rebuild:** the sweep is entitlement-blind (it does
ask a per-user AI COST ceiling since 2026-08-09 — a spend brake is not an entitlement, and an
over-budget user is SKIPPED for that pass rather than failed, so their pages stay due) and the
serialiser owns the cut. Reverting to absent-not-locked is one branch in the read path.

## The surface

**A mark on a page, not a notification.** Opening the page is the user's act — the design's own
principle is that the journal never speaks on its own initiative, and an unrequested modal on open
is speaking on its own initiative even when the content is reactive. It also avoids framing tonight's
entry with last night's retrieval before the user has written.

The canon defines six states — the mark at rest, the honest cut, the panel of all matches, walking
back, the desktop margin panel, and the One sheet — plus a once-ever first-echo card. It is
authoritative for the surface; what follows is only what the backend must honour.

- **Newest first**, oldest at the bottom, matching every other list in the journal. *(I argued the
  opposite — oldest-first reads as reach, newest-first as accumulation — and the canon overruled it
  on consistency grounds. Recorded so the reasoning survives; it is one function to invert.)*
- **Distance is rendered client-side from the two ISO days**, in the canon's own units — "five months
  ago" on tonight's page, "eight months earlier" on a walked page, "1 yr 2 mo" in the desktop
  margin. Not days: nobody thinks in 212 of them. The "ago"/"earlier" split by position is the
  canon's, and it is the right instinct — "ago" is deictic and false on any page but tonight's.
- **The count renders only when every counted match is on screen.** "9 times, back to 1 January
  2024" is honest exactly when all nine are listed and tappable, and dishonest the moment it
  summarises something the reader cannot check. Truncated list, no total.
- **`count` is computed after re-location succeeds**, so the mark and the card can never disagree
  about how many there are.
- **No marks below a ~20-page corpus floor** — and no offer either. A journal with nothing to reach
  back into should not advertise reaching back.
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

## Migration — done, and it took two waves rather than one

This replaced the shipped page-level cosine implementation. The list below was written before the
build as a checklist of every line the wave would make false. **Everything on it is now executed**,
but not in one wave, and that is worth recording: the build wave (`c5ff152` / `3c9906e`) did the
code and the schema, and left three items standing for weeks — a dead domain module with passing
tests around it, an e2e script written against a table that no longer existed, and the doc a reader
opens *before* touching this product. The repair wave paid them. The house rule is "fix it in the
same wave that made it false", and this file is the evidence of what it costs when you don't: the
checklist was correct, complete, and ignored.

- ✔ `domain/EchoFinder.{h,cpp}` + `test/products/journal/domain/EchoFinderTest.cpp` — **deleted in
  the repair wave.** They survived the build wave with green tests around them, which is the worst
  shape a dead module can be in: a reader greps `EchoFinder`, finds it passing, and believes
  whole-page cosine is how echoes work
- ✔ `application/EchoSweep.cpp` + `test/products/journal/application/EchoSweepTest.cpp`
- ✔ `adapters/postgres/PgEchoRepository.cpp`, `adapters/http/EchoApi.cpp` + `EchoApiTest.cpp`
- ✔ `ports/EchoRepository.h`; `test/products/journal/Fakes.h` (gained a `Curator` fake)
- ✔ `test/e2e/journal_echo.sh` — **rewritten in the repair wave.** The build wave left it seeding
  `journal_echo` with `trigger_lo` / `match_hi` / `score`, columns the same wave dropped, so the
  script could only ever fail at its first `psql`
- ✔ `db/schema.sql` — `journal_page_vector` → `journal_span`; `journal_echo` re-keyed
- ✔ `web/src/products/journal/echoes/**` — the surface, rebuilt as its own feature package beside
  `search/` and `zoom/`. The old root-level `EchoCard.jsx` and `useEchoes.js` are gone; quotes are
  re-located by text against the live body rather than sliced by stored offset
- ✔ `ARCHITECTURE.md` §5.1–5.4, the `journal_echo` row of its entity table, and **§5.2's "rows are
  never deleted"**, which this design contradicts (`replaceEchoes` deletes and rewrites) —
  **all three in the repair wave.** §5 now points here rather than describing a system that is gone

**Closed, and it was never open.** An earlier draft of this spec flagged `GET /v1/journal/vectors`
as a coupling to resolve — the docs described it as seeding the on-device search index from
`journal_page_vector`. It does not exist: no route, no handler, no repository method, and nothing in
`web/src` calls it. The browser builds its own index. Dropping `journal_page_vector` therefore broke
nothing. `ARCHITECTURE.md` §8.2 and its endpoint table both carried it as real and now carry it
struck through, marked never built.

## Rules that hold

1. **An echo may only assert something the user can check from what is on screen.** Not merely
   *evidenced* — *checkable*. Two pronoun-only passages ("he was awful again tonight", written 18
   months apart about different men) present maximal apparent evidence for a relation and zero
   checkable evidence. Enforcement: require at least one shared low-frequency lexical anchor between
   the two passages. No anchor, no echo, whatever the cosine says. The C++ case passes on "c++".
2. **Nothing is ever inferred from absence.** No predicate reads a gap; the `CHECK` forbids forward
   reach. Corollary for the surface: never render an empty "no echoes" state, and never present a
   list as *the* times. A total may be shown only when every item it counts is on screen and
   tappable; a truncated list gets no number.
3. **A quote is re-located and verified in the live page at render, or not shown.** Verified means
   the span's text still hashes to what the echo was built from — locating alone is not enough,
   because after an edit the wrong text locates successfully.

## Known follow-ups in the build

Not defects, and neither blocks anything. Recorded so the next reader finds them here rather than
rediscovering them.

1. **The pair-level dismiss is shaped unlike its two neighbours.** `dismissPage` and `dismissOffer`
   are each one statement; the pair door instead reads the page back through `echoesFor` to turn two
   days into a span pair, then writes one row per match. Bounded (one page's matches) and correct,
   and it needlessly recomputes the anchoring hints it throws away. The tidy version is a
   `dismissPair(user, triggerDay, matchDay)` on the repository, replacing today's span-id `dismiss`.
   Deliberately deferred: the surface is being rebuilt against v2 of the design and the churn buys
   nothing this week.
2. **`EchoRepository::dismiss` has exactly one production caller** and exists only to serve the
   above. It goes away with it.

## Filed back to design

Three things the canon does not yet answer, recorded here so they are not lost between the two
documents. None blocks the build; each needs a designer's decision before ship.

1. **No slot for attribution.** A passage the writer *copied down* — a pasted message, a lyric, a
   line said to them in session — is verbatim page text and locates perfectly, so nothing in the
   pipeline can catch it. Same for a passage from an unedited voice transcript. Surfacing either
   under "you wrote this" is a false attribution the reader cannot falsify. The card header is
   `date · distance` with nowhere to say otherwise. The backend supplies `isSelf` and `source`; the
   surface needs somewhere to put them.
2. **A stray verdict inside the E4 frame.** The walked-page mock renders *"Two years of the same
   idea, and the oldest one is eleven words long."* That is a conclusion about the writer, which
   every rule in both documents forbids. It reads like a caption that drifted inside the device
   frame. **Not being built** pending confirmation.
3. **Ordering was overruled and should be a conscious choice.** The canon runs newest-first for
   consistency with every other list in the journal. Read top-down, oldest-first says *reach*
   ("this goes back to 2024") and newest-first says *accumulation* ("and again, and again") — the
   same rows, opposite rhetoric. Consistency is a good reason; it should just be the reason chosen,
   not the reason defaulted to.

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
| median age of shown echoes | ≥90 days — the card sells distance ("five months ago") |
| hubness: max share of a user's pages any one passage appears on | ≤5% |

Persist the **"Read it"** tap alongside dismissals, with cosine, z, family size and age attached.
It is already on screen and currently thrown away; within a month it is a real relevance dataset,
collected honestly from a button the user was already pressing.
