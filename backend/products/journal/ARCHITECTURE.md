# Windmill Journal — backend architecture

The second room in the superapp. Trees are how you plan what to do; Journal is how you notice
what happened. This document designs the **backend** for it. The product canon lives in the
claude.ai Design project (`Windmill Journal — System.dc.html`, `guidelines/journal.md`); this
file is what a developer needs that isn't visible in a screen.

Read `STRUCTURE.md` for the one rule (platform is product-neutral; products depend on platform,
never the reverse; products never depend on each other) and `backend/CLAUDE.md` for the layering.
Journal mirrors the roadmap product's shape exactly — `domain/ · ports/ · application/ ·
adapters/{http,postgres}` — and plugs in through one seam: `journal::registerRoutes(app, deps)`.

---

## 0. The shape of the problem — a deliberately small backend

**North star.** The mission is self-growth *with ease* and a *nice feeling* about the product —
mission-driven, not money-driven. Every choice below serves that: instant and offline where it
counts, private by construction, gentle (never scored, never scolded), and honest about where your
words go. Cost/usage mechanics are deliberately not designed here.

The instinct is that a journaling product is a big backend. It isn't. Almost everything the
product *feels* like it does happens on the device, by design, for privacy. The backend's job is
narrow and load-bearing, and the first architectural act is to draw that line and defend it.

**What the backend owns (the whole surface):**

1. **Pages** — durable, per-user, one row per local day. The account of record so a page
   survives a device, restores after eviction, and converges across two devices. (§3)
2. **Nudges** — a daily, at-most-one delivery, sent at a time the *device* learned. A pure sweep
   over `(now, database)`, cloned almost verbatim from the roadmap reminder engine. (§4)
3. **Echoes** — the deep reading-across. A nightly pass across a subscriber's whole corpus,
   computed for them without being asked. The only reason the backend touches an inference model. (§5)
4. **Entitlement** — one question: is this a **Windmill One** subscriber? Two lines, one shared
   platform predicate read by all three products. (§6)

**What the backend deliberately does NOT do — it stays on the device (§8):**

- **Search** is semantic and on-device. Embeddings are computed in a worker and cached in
  IndexedDB; a feeling never leaves the phone to find a passage. The backend has no search route.
- **Threads** are derived clusters, never stored as user input. No thread table, no tagging API.
- **The rhythm** — the histogram of when you write, the learning, the confidence — never leaves
  the device. The server learns *nothing* about when you write; it is handed only the single next
  knock-instant the device computed. (This is the pivot of the whole nudge design — §4.1.)
- **Transcription** is on-device (Web Speech); the backend receives finished text with
  `source = spoken`. Audio never reaches a Windmill server. (§8.4)
- **Sharing** does not exist — structurally. There is no visibility column, no share entity, no
  public route. Every read and write is scoped to `WHERE user_id = :caller` and there is no code
  path that takes a non-owner. (§0.1)

Everything below serves that division. When a feature could live on either side, it lives on the
device unless the backend is the *only* place it can be correct (a nightly corpus pass; a nudge
that must fire while the phone is asleep; the page from a year ago the device no longer caches).

### 0.1 Privacy is structural, not enforced

Roadmap has a `Visibility` axis and a `canRead(caller, owner, visibility)` gate because a tree can
be private, unlisted, or public. **Journal has none of that, and its absence is the enforcement.**

- Journal does **not** import `platform/domain/Access.h`. There is no visibility to parse.
- Every query is `… WHERE user_id = $1` with the authenticated caller. A page is legible to
  exactly one account and there is no parameter that could widen it.
- No route renders a share view; every `/journal/*` position 404s for anyone but the owner
  (the canon: "No route is public"). The 404 is the same one an absent page returns — a private
  page is byte-identical to a page that never existed, to any other caller.
- The data model has **no share entity, so sharing cannot be built by accident.** Adding it later
  would be a visible, deliberate schema change, not a flag flip.

This is the roadmap's own lesson (private trees deny byte-identically to absent) taken to its
strict conclusion: Journal removes the axis rather than defaulting it closed.

---

## 1. Where it lives — and a naming decision

```
backend/products/journal/
  domain/        Page · Mood · Energy · WeekReadout · EchoFinder · NudgePlan   (pure, no I/O)
  ports/         JournalRepository · EchoRepository · NudgeRepository · Embedder
  application/   PageService · WeekService · EchoSweep · NudgeSweep
  adapters/
    http/        JournalApi (pages, week, export) · NudgeApi (settings, pause)
    postgres/    PgJournalRepository · PgEchoRepository · PgNudgeRepository
    llm/         (Embedder impl — only if server-side embeddings ship; see §5.4)
  routes.{h,cpp} journal::registerRoutes(app, JournalDeps&)
```

**Naming: the module is `journal`, not `notes`.** The scaffold reserved `products/notes/`, but the
designed product is *Journal* in every artifact — routes are `/journal`, tables are `journal_*`,
and the vocabulary section of the canon explicitly bans the words *note/notes/log*. "A newcomer
should infer where things live from folder names" (CLAUDE.md) argues for the product's real name.

> **Recommendation:** rename `backend/products/notes/` → `backend/products/journal/` and
> `web/src/products/notes/` → `web/src/products/journal/` (both are one-file scaffolds today —
> a README and a `ComingSoon`-style stub). Update `STRUCTURE.md` and the root `CLAUDE.md` product
> list. This design assumes the `journal` name throughout.

---

## 2. The data model

The canon's §06 "Data" is the contract. Four tables, one flat `db/schema.sql` section
(`-- ── Journal ──`), idempotent DDL (`create table if not exists` + `alter … add column if not
exists`), `<product>_*` naming, digest-at-rest secrets, `on delete cascade` from `users`.

### 2.1 Domain types (`domain/Page.h`)

Ids follow the platform `Id<Tag>` phantom-typedef style. Journal's natural key is not a minted id
but **(user, day)** — the day *is* the key, exactly as the canon says ("date local ISO, one per
day, the key"). So the domain leans on `UserId` (platform) and a `LocalDate` value type; pages
carry no synthetic id.

```cpp
namespace wm {

// A calendar day in the writer's own zone, "YYYY-MM-DD". Not an instant — the page for a day is
// the same page whether it's opened at 23:04 or 00:10, and the zone is the device's, never UTC.
class LocalDate {
public:
  explicit LocalDate(std::string iso);        // throws InvalidPage on a malformed date
  const std::string& iso() const;
};

enum class Mood { none, m1, m2, m3, m4, m5 };  // one hue, five steps — a scale, not five colours
enum class Energy { none, e1, e2, e3 };
enum class Source { typed, spoken };

// The unit of the whole product. Plain data; the invariants that matter (a valid date, a mood in
// range) are guarded where the value types are constructed, not here.
struct Page {
  UserId user;
  LocalDate day;
  std::string body;          // plain text, soft line breaks kept
  Mood mood = Mood::none;
  Energy energy = Energy::none;
  Source source = Source::typed;
  Hlc stamp;                 // LWW version — see §3.2
  std::uint64_t updatedAtMs = 0;
  bool operator==(const Page&) const = default;
};

}
```

`Mood`/`Energy`/`Source` get free inline `toString`/`parse*` helpers colocated in the header, in
the roadmap style. There are **no titles, no folders, no tags** — none appear in the model, so
none can be persisted.

### 2.2 Tables

```sql
-- ── Journal (products/journal) ───────────────────────────────────────────────────────────────
-- One page per user per LOCAL day; the (user, day) pair IS the key. No id is minted, nothing is
-- shared (no visibility column exists, on purpose — the product cannot share a page), and every
-- read is scoped to the owner. Convergence across a user's own devices is last-writer-wins on an
-- HLC stamp (stamp_ms, stamp_counter), the same register node_progress and trees.title already
-- use. body is plain text with soft line breaks kept; mood/energy are nullable-by-zero.
create table if not exists journal_page (
  user_id       uuid not null references users(id) on delete cascade,
  day           date not null,                    -- the writer's local ISO day, the key
  body          text not null default '',
  mood          smallint not null default 0 check (mood between 0 and 5),      -- 0 = not set
  energy        smallint not null default 0 check (energy between 0 and 3),    -- 0 = not set
  source        text not null default 'typed',    -- typed | spoken
  stamp_ms      bigint not null default 0,         -- HLC physical ms  ┐ the LWW guard; a write
  stamp_counter bigint not null default 0,         -- HLC counter      ┘ never goes backwards
  updated_at    timestamptz not null default now(),
  primary key (user_id, day)
);
-- the canvas read: a user's pages oldest→newest, or a date range for a window/the week
create index if not exists journal_page_user_day on journal_page (user_id, day);

-- Superseded bodies, append-only, invisible. A safety net for the one lossy case LWW admits:
-- the same day edited on two offline devices, where the loser's text would otherwise vanish.
-- Never surfaced as a merge UI (the canvas is one continuous surface); kept only so "nothing
-- written is ever withdrawn" holds literally. Prunable by age. See §3.3.
create table if not exists journal_page_revision (
  user_id     uuid not null references users(id) on delete cascade,
  day         date not null,
  body        text not null,
  stamp_ms    bigint not null default 0,
  stamp_counter bigint not null default 0,
  superseded_at timestamptz not null default now()
);
create index if not exists journal_page_revision_key on journal_page_revision (user_id, day);

-- ── Journal echoes (Windmill One, computed server-side, nightly) ─────────────────────────────
-- An echo is Journal noticing that today repeats something written months ago. Produced only by
-- the nightly EchoSweep, only for subscribers. trigger_day is the page that prompted it; match_day
-- is the older page; the char spans locate the resonant passage in each; score is stored but
-- shown only as presence (never a number). "absent, not locked" for non-subscribers falls out of
-- this table simply being empty for them. dismissed retires an offer/echo for that page (client-set).
create table if not exists journal_echo (
  user_id      uuid not null references users(id) on delete cascade,
  trigger_day  date not null,
  match_day    date not null,
  trigger_span int4range not null,
  match_span   int4range not null,
  score        real not null default 0,
  created_at   timestamptz not null default now(),
  primary key (user_id, trigger_day, match_day)
);
create index if not exists journal_echo_trigger on journal_echo (user_id, trigger_day);

-- Per-page embedding used ONLY by the nightly echo pass (NOT search — search embeds on-device).
-- Stored as float4[] and matched in-memory by the pure EchoFinder; no pgvector dependency. Null
-- vector = not yet embedded. Recomputed when a page's body changes (stamp advances).
create table if not exists journal_page_vector (
  user_id       uuid not null references users(id) on delete cascade,
  day           date not null,
  vector        real[] not null,
  body_stamp_ms bigint not null default 0,     -- the page stamp this vector was computed from
  created_at    timestamptz not null default now(),
  primary key (user_id, day)
);

-- ── Journal nudges (one a day at most; the time is the DEVICE's, not ours) ───────────────────
-- Mirrors reminder_subscription/reminder_week exactly, with two differences: the slot is DAILY
-- (dedup key is the local day), and next_due_at is materialized by the DEVICE from its local
-- rhythm — the server never learns when you write, it is handed the next instant and the local
-- day that instant belongs to. slot_day is the "did they already write today?" key. Below 7 days
-- of data the device sends adaptive=false and no next_due_at (adaptive off; the panel says so).
create table if not exists journal_nudge (
  user_id      uuid primary key references users(id) on delete cascade,
  enabled      boolean not null default false,
  channel      text not null default 'email',   -- email | push | inapp (push = installed PWA only)
  next_due_at  timestamptz,                      -- device-materialized; NULL ⇒ never send
  slot_day     date,                             -- the LOCAL day next_due_at belongs to
  paused_until timestamptz,                      -- "pause for a week" — one tap
  suppressed   boolean not null default false,   -- hard bounce / spam complaint (wave 2)
  pause_digest text not null default '',         -- emailed pause-link credential, digest at rest
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
-- the sweep's whole question: the few rows that can be due right now
create index if not exists journal_nudge_due on journal_nudge (next_due_at)
  where enabled and not suppressed and next_due_at is not null;
create unique index if not exists journal_nudge_pause on journal_nudge (pause_digest)
  where pause_digest <> '';

-- A DECISION LEDGER, not a send log (the reminder_week lesson, verbatim). The PK (user_id,
-- slot_day) IS the "at most one per day" mutex — never enforced by comparing timestamps at read
-- time. A row whose sent_at is null must NEVER be auto-retried: a lost nudge costs nothing, a
-- duplicate costs trust. decision = sent|skipped; reason = ok|already-wrote|paused|too-late|held.
create table if not exists journal_nudge_day (
  user_id   uuid not null references users(id) on delete cascade,
  slot_day  date not null,
  decision  text not null,
  reason    text not null,
  sent_at   timestamptz,
  decided_at timestamptz not null default now(),
  primary key (user_id, slot_day)
);

-- (A per-user voice-minutes meter for vendor cost control is a LATER, out-of-scope addition — a
-- small journal_voice_usage(user_id, period, seconds_used) table behind the same subscription gate.
-- Not built now: the mission is the feature, not the metering. See §6 and §8.1.)
```

Mapping back to the canon's §06 Data:

| Canon field | Where it lives |
|---|---|
| Page: date / body / mood / energy / source / updatedAt | `journal_page` (date = `day`, the key) |
| Echo: pageId / matchPageId / span / score | `journal_echo` (trigger_day / match_day / spans / score) |
| Rhythm: histogram / window / confidence | **nowhere on the server** — device-local; only `next_due_at` + `slot_day` cross (§4.1) |

---

## 3. Capability 1 — Pages: the canvas as convergent per-day storage

### 3.1 The read/write surface

`PageService` is a thin orchestrator holding `JournalRepository&` (the roadmap `ProgressService`
shape: load → domain → repo write, no separate `Batch` type — the upsert *is* the write seam).

```cpp
struct JournalRepository {
  virtual ~JournalRepository() = default;
  virtual std::optional<Page> load(const UserId&, const LocalDate&) = 0;
  virtual std::vector<Page> range(const UserId&, const LocalDate& from, const LocalDate& to) = 0;
  virtual std::vector<Page> all(const UserId&) = 0;                 // export
  virtual PageWrite save(const Page& incoming) = 0;                 // LWW upsert; see §3.2
};

enum class PageWrite { stored, superseded, ignoredStale };          // what the guard decided
```

The domain does almost nothing here on write — a page is a text blob, not a graph. The only
domain rule is the LWW comparison, and that is enforced in one SQL statement (below), so
`PageService::write` is: build the incoming `Page` from the request, stamp it, `save`, and reply
with the resolved page (so a client that lost a race sees the winning body immediately). Reads
(`page`, `range`, `all`) are pass-throughs. This is genuinely a CRUD slice — the complexity all
sits in the two features that follow.

### 3.2 Sync & offline — last-writer-wins per day, no CRDT

The roadmap's convergent editing is a full CRDT-over-websocket engine (HLC-stamped per-field LWW
registers, an append-only op log, in-memory rooms broadcasting subgraph deltas, presence at
20 Hz). **Journal reuses none of it.** That stack is node/edge/kind-shaped end to end and
roadmap-specific; a journal page is single-user and single-blob-per-day, so the only conflict is
*one user, two devices, same day*, and last-writer-wins converges it deterministically.

The write is one guarded upsert, exactly like `node_progress` (which the repo already describes as
"a last-writer-wins register per node"):

```sql
INSERT INTO journal_page (user_id, day, body, mood, energy, source, stamp_ms, stamp_counter, updated_at)
VALUES ($1::uuid, $2::date, $3, $4, $5, $6, $7, $8, now())
ON CONFLICT (user_id, day) DO UPDATE
  SET body = EXCLUDED.body, mood = EXCLUDED.mood, energy = EXCLUDED.energy,
      source = EXCLUDED.source, stamp_ms = EXCLUDED.stamp_ms,
      stamp_counter = EXCLUDED.stamp_counter, updated_at = now()
  WHERE (EXCLUDED.stamp_ms, EXCLUDED.stamp_counter) > (journal_page.stamp_ms, journal_page.stamp_counter);
```

The stamp is an **HLC** (`platform/domain/Ids.h`), minted by the device's `HlcClock`. Reusing the
HLC — not a bare `updated_at` — buys deterministic convergence when two devices' wall clocks
disagree, and reuses primitives already in the codebase (`Hlc`, `parseHlc`, `toString`, `Lww<T>`
in `platform/domain/Crdt.h`). Offline writing works because the device queues stamped writes and
replays them on reconnect; the guard makes replay idempotent and order-independent. The canon's
"offline · saved here" is a client state — nothing on the server blocks on the network.

### 3.3 The one lossy case, made safe

LWW discards the loser when the same day is edited offline on two devices. The brand promise —
"nothing written is ever withdrawn" — argues we should not silently drop text. So the `DO UPDATE`
path, when it overwrites a non-empty body, first copies the outgoing body into
`journal_page_revision` (a trigger, or a two-statement transaction in the adapter). This is a
**safety net, never a UI**: the canon is emphatic that the canvas is one continuous surface with
no merge/conflict affordance. Revisions are invisible, prunable by age, and exist only so a
support path (or a future "you have another version of this day" whisper, if the design ever wants
one) can recover text. *Recommended but severable* — ship pages without it and add it in wave 2 if
the two-device case proves real.

### 3.4 The week & the year — mostly the client's, one thin server read

The weekly readout (§8 of the canon) and the year view are **read models the client assembles**
from pages it already has — mood/energy series, recurring words (a pure count), the zoomed dot
grid. The backend does not compute them. The *one* thing the client cannot do is the "resurfaced
entry from a year ago": the device caches only the last 60 days offline, so the year-ago page must
come from the server. That is served by the ordinary page read:

```
GET /v1/journal/page/2025-07-20   →  the page for that date (owner only), for the resurface slot
```

If we later decide the week should be server-assembled (e.g. to avoid the client ever holding a
year of pages), it becomes a pure `WeekReadout` domain function over `range(user, weekStart,
weekEnd)` plus the year-ago `load` — a clean two-phase action (load recent → domain → load
year-ago → domain). The week is **free** (per pricing), so it carries no entitlement gate. Left as
client-side for v1; the server exposes only range/point reads.

---

## 4. Capability 2 — Nudges: a daily sweep at a time the device chose

Cloned from the roadmap reminder engine (`domain/Reminders.h`, `application/ReminderSweep.h`,
`ports/ReminderRepository.h`) almost verbatim, with the weekly slot swapped for a daily one and
"has ready steps" swapped for "has already written today". The engine's spine transfers whole:
**a self-owned 15-minute ticker thread, no schedule state in the process, and DECIDE → CLAIM →
SEND ordering with the ledger PK as the dedup mutex.**

### 4.1 The pivot: the rhythm stays on the device; only the knock-instant crosses

The canon says two things that seem to fight: nudges are *adaptive* — "the product learns the hour
you actually write and knocks then" — and the rhythm is *local*, "never leaves the device". They
reconcile cleanly once you separate the **learning** from the **firing**:

- The **device** owns the histogram (24×30), the learning, and the confidence. It computes the one
  scalar that matters — the next knock instant — and PATCHes it to the server as `next_due_at`
  (a UTC timestamp) plus the local day it belongs to (`slot_day`). The histogram never crosses.
- The **server** stores that instant and fires at it. It learns *nothing* about when you write; it
  is the reminder engine's "`next_due_at` is the only thing the sweep queries," except the device
  materializes it instead of Postgres `AT TIME ZONE`.
- Because the device supplies both the instant and its local day, **the server needs no timezone
  for Journal at all** (reminders store `iana_tz` only to re-materialize a fixed weekly slot in
  SQL; Journal's slot is adaptive, re-materialized by the device each time it learns).
- Below 7 days of data the device sends `adaptive=false` and no `next_due_at`; the row's partial
  index excludes it, and "adaptive is off, the panel says so" falls out with no special case.

This is the honest reading of "rhythm local": what stays is the *pattern*; what crosses is the
single derived time a server must know to knock while the phone is asleep.

### 4.2 The pure decision (`domain/NudgePlan.h`)

A first-match-wins gate pipeline, no clock/DB/mailer reachable — the `Reminders::decide` shape:

```cpp
enum class NudgeOutcome { send, skip };
enum class SkipReason { none, alreadyWrote, paused, tooLate };

struct NudgeCandidate {
  UserId user;
  LocalDate slotDay;
  std::uint64_t slotInstantMs;
  std::uint64_t nowMs;
  bool wroteToday;          // a page exists for slotDay
  bool paused;              // paused_until in the future
};

struct NudgeDecision { NudgeOutcome outcome; SkipReason reason; };

// Gates, in order: paused → tooLate (>Nh past the instant) → alreadyWrote → else send.
// Note what is ABSENT: there is no "you lapsed" branch. The engine never nudges about a gap
// (canon §7), and the copy is fixed and lapse-agnostic — the prompt never travels in the body.
NudgeDecision decide(const NudgeCandidate&, std::uint64_t nowMs);
```

"Quiet if I already wrote" is the `alreadyWrote` gate; the fact is one indexed read
(`SELECT 1 FROM journal_page WHERE user_id=$1 AND day=$slotDay`). "Never congratulate someone for
showing up" and "never nudge about a lapse" are guaranteed by the decision having no success/lapse
vocabulary at all — the mail is a single fixed line ("The house is quiet. Three minutes?").

### 4.3 The sweep (`application/NudgeSweep.h`)

Same skeleton as `ReminderSweep::run` — a `pg_try_advisory_lock` work lock (dedup, not
correctness), a batched `dueNow`, then per user DECIDE → CLAIM → SEND:

```cpp
for (const DueUser& due : nudges_.dueNow(nowMs, kBatch)) {
  NudgeDecision decision = decideFor(due, nowMs);               // load wroteToday/paused + decide()
  if (!nudges_.claimDay(due.user, due.slotDay, decision)) continue;  // PK-mutex; lost race = silent
  if (decision.outcome == NudgeOutcome::skip) continue;
  if (!arming_.allows(due.user)) { nudges_.closeDay(..., held); continue; }   // dark-launch gate
  MintedToken pause = tokens_.mint();
  bool ok = deliver(due, pauseLink(pause.secret));             // email now; push in wave 2
  if (ok) nudges_.setPauseDigest(due.user, pause.digest);
  nudges_.closeDay(due.user, due.slotDay, ok ? sent : failed);
}
```

`claimDay` is the reminder claim verbatim: an `INSERT … WHERE EXISTS (re-check enabled / not
paused / not deleted) ON CONFLICT (user_id, slot_day) DO NOTHING RETURNING`, advancing nothing
(the device owns the next instant; the claim only records the decision and clears `next_due_at` so
the same instant can't fire twice). The sweep owns its own `trantor::EventLoopThread` — **never a
drogon request loop** — and is armed by one line in `main.cpp`: `journalSweep->start();`.

### 4.4 Channels

The only channel that exists today is transactional email (`EmailSender`, Resend). Adding a nudge
is one method on the port and one template binding:

```cpp
// platform/ports/EmailSender.h  — a fourth method beside sendMagicLink/sendForkLink/sendReminder
virtual void sendJournalNudge(const Email& to, const JournalNudgeMail& mail,
                              std::function<void(bool)> done) = 0;
```

`JournalNudgeMail` is fully pre-rendered (the one fixed line + `settingsUrl` + `pauseUrl` +
`unsubscribeUrl`), and `ResendEmailSender` gains one `send(…, "journal-nudge", …)`. **Push is a
new port that does not exist yet** — the canon reserves push for the installed PWA only ("in a
browser tab they can't [reach you]"), so v1 ships **email + in-app**, and a `WebPush` port
(VAPID + a `push_subscription` table keyed by endpoint digest) is a scoped wave-2 addition. The
`channel` column already carries the choice so the schema doesn't move when push lands.

### 4.5 Settings & pause — the reminder doors, renamed

```
GET   /v1/journal/nudge            getSettings   → { enabled, channel, adaptive, nextDueAt?, armed }
PATCH /v1/journal/nudge            patchSettings ← { enabled?, channel?, nextDueAt?, slotDay?, pausedUntil? }
POST  /v1/journal/nudge/pause      pause (uncredentialed; bearer = the secret in the user's mail; 204)
POST  /v1/journal/nudge/unsubscribe  RFC 8058 one-click (secret in query, POST-only)
POST  /v1/admin/journal/nudge/sweep  operator rehearsal (JOURNAL_NUDGE_ADMIN_TOKEN; dryRun/asOfMs)
```

`patchSettings` is where the device pushes the learned `nextDueAt`/`slotDay`; the server validates
and stores, never inspects the rhythm behind it. Pause/unsubscribe reuse the digest-at-rest,
credential-in-the-mail pattern (sessions/magic-links/reminder pause).

---

## 5. Capability 3 — Echoes: the one paid thing, computed nightly

An echo is Journal noticing that today repeats something written months ago, and saying so with
the older line. It is the only feature that puts the backend in front of an inference model, and —
with voice — one of Journal's two Windmill One features.

### 5.1 Why nightly, and what that decides

The canon leaves this open (§ "Still open" 3): nightly batch vs on-write. **Recommended: nightly
batch.** An echo is "a pass across your whole corpus, computed for you without being asked" — it is
inherently a corpus operation, cost and latency both point to nightly, and the server can't depend
on a device being online to trigger it. The consequence the canon names is accepted: an echo
**cannot** appear in the session that wrote the page that triggered it — it surfaces the next time
you open, which suits a product about looking back rather than reacting.

### 5.2 The sweep (`application/EchoSweep.h`)

A second self-owned ticker, fired once per night (not every 15 min), pure over `(now, database)`:

```
for each subscriber with pages changed since their last echo pass:
  load the user's page vectors (journal_page_vector)                 [repo]
  for each recently-changed page → EchoFinder.match(page, corpus)    [pure domain]
  persist the resulting echo rows                                    [repo upsert]
```

Entitlement is checked at the top of each user's turn (`findFor(user, email)` + `grantsAccess`),
so **the gate is "do we compute", not "do we show"**:

- **Not subscribed → no rows.** "Echo marks are absent, not locked" falls out of the table being
  empty; there is no locked/blurred state to render because there is nothing to hide. The "one offer
  card per page, dismissible with Not now" is entirely client-side (a local dismissal per page).
- **Subscription lapses → stop computing, keep what exists.** The sweep skips non-subscribers; existing
  `journal_echo` rows are never deleted. "Nothing written is ever withdrawn" holds literally.

### 5.3 The match is pure domain (`domain/EchoFinder.h`)

The interesting logic stays in the domain layer, dependency-light, over already-loaded vectors —
no pgvector, no I/O:

```cpp
struct EchoCandidate { LocalDate day; std::vector<float> vector; std::string body; };

struct EchoMatch {
  LocalDate matchDay;
  std::pair<int,int> triggerSpan;   // char range in the trigger page
  std::pair<int,int> matchSpan;     // char range in the older page
  float score;
};

// Cosine over the corpus, older pages only, best above threshold, min day-gap so yesterday isn't
// an "echo". Returns at most one match per trigger (the canon shows one "you said it before").
std::optional<EchoMatch> match(const EchoCandidate& trigger,
                               const std::vector<EchoCandidate>& corpus, EchoRules rules);
```

Corpora are small (hundreds of pages per user), so an in-memory cosine pass per night is trivial
and keeps the DB free of a vector extension. If corpora ever grow past comfort, `journal_page_
vector.vector` becomes a `pgvector` column and the match moves to an ANN query — a localized swap
behind the same `EchoRepository`.

### 5.4 Embeddings and the "Only you" line — a real decision

Echoes need a server-side embedding per page (search embeds separately on-device; the two spaces
are deliberate — different trust boundaries, and the server can't reach the device's IndexedDB).
The `Embedder` port keeps the domain clean:

```cpp
struct Embedder {
  virtual ~Embedder() = default;
  virtual bool configured() const = 0;                              // false ⇒ echoes simply don't run
  virtual std::vector<float> embed(const std::string& body) = 0;    // may be async in the impl
};
```

**The honesty question the design must answer out loud:** page bodies are *already* stored on the
Windmill server (they must be — sync, restore, the year-ago resurface all require it), so echoes
add no new class of stored data. But computing an embedding via a **third-party** API would send
page text to that vendor — which sits uneasily under "Only you". Two options:

1. **Server-controlled embedding model (recommended).** A small self-hosted embedding model
   (an adapter over an internal endpoint) so page text never leaves infrastructure Windmill
   controls. Honors the brand at the cost of running the model.
2. **Vendor embedding API** under a strict no-training / no-retention data agreement, documented
   in the privacy copy.

The `Embedder` port makes this swappable and testable (a fake returns fixed vectors); the choice
is a product/privacy call, not a code constraint. It is the same "new power, not a re-sold
default" test the canon applies — and it should be resolved before echoes ship, alongside the
pricing coupling in §10.

---

## 6. Capability 4 — Entitlement: one subscription, read by every product

There is **one** subscription — **Windmill One** — across roadmap, journal, and gym. This is the
brand's stated model ("one account and one subscription"), so entitlement is a single, product-
neutral axis, not a per-product plan. Journal does **not** invent its own `Plan`; it asks the one
question the whole brand asks:

```cpp
// The single entitlement axis. Product-neutral, so it belongs in platform (platform/domain/Billing.h),
// read identically by journal echoes/voice, roadmap tending, and anything gym adds later.
const std::optional<PaddleSubscription> sub = subscriptions_.findFor(caller, email);
const bool subscribed = sub && grantsAccess(sub->status);   // grantsAccess: active|trialing|past_due
```

`subscribed` is the whole gate. Journal's premium surfaces — **echoes** (computed only for
subscribers; §5) and **voice** (checked before calling the ASR vendor; §8.1) — read exactly this
boolean, the same one roadmap's premium surfaces read. One subscription, one predicate, three
products. (The roadmap code's local `enum class Plan { free, pro }` is really a *metering* detail
sitting behind this same `grantsAccess`; Journal doesn't need its own.)

Everything else — pages, mood/energy, the canvas and zoom, **search**, threads, trends, the week,
nudges, and export — asks nothing of billing at all.

**Usage tuning is deliberately out of scope here.** How much each feature costs us, per-user
allowances, minutes caps, cost control — none of that is designed now. The mission is cool,
effortless products; a subscriber simply *has* the premium features. Metering is a later ops
concern that bolts on behind this same `subscribed` gate without changing the product (§10). The
one honest note that remains: the canon lists voice under "Free, forever", and it is now a
Windmill One feature — a small copy/`pricing.md` update, not a silent gate (§10.8a).

---

## 7. HTTP surface — positions are URLs, but the API is small

The canon's routes (`/journal`, `/journal/2026-07-20`, `/journal/search`, `/journal/thread/…`,
`/journal/week/…`, `/journal/year/…`) are **client routes** — a position is a URL, resolved in the
SPA/PWA. They do not each map to a backend endpoint. The backend surface is only what the client
genuinely cannot do itself:

| Method & path | Purpose | Auth |
|---|---|---|
| `GET /v1/journal/page/:date` | one page (incl. the year-ago resurface) | owner only |
| `GET /v1/journal/pages?since=&limit=` | delta feed: pages changed after an HLC cursor, ascending, paged — the one read that feeds sync, the offline cache, *and* the on-device search index (§8.2) | owner only |
| `GET /v1/journal/pages?from=&to=` | a date range (a window, the week) | owner only |
| `PUT /v1/journal/page/:date` | write a page (LWW upsert; carries the HLC stamp) | owner only |
| `WS /v1/journal/transcribe` | streaming voice → live transcript deltas; audio ephemeral, discarded on success (§8.1) | owner only |
| `POST /v1/journal/transcribe` | one-shot voice → `{ text }` (the robust v1 before streaming) | owner only |
| `GET /v1/journal/vectors?since=` | *(search accelerator)* server echo-vectors to seed the on-device index; never takes a query (§8.2) | owner only |
| `GET /v1/journal/echoes?from=&to=` | echoes for a range (empty for non-subscribers) | owner only |
| `POST /v1/journal/echoes/:day/dismiss` | retire an echo/offer for a page (client-set) | owner only |
| `GET /v1/journal/export` | all pages, JSON (client renders markdown) | owner only |
| `GET/PATCH /v1/journal/nudge` + pause/unsubscribe | nudge settings & pause (§4.5) | owner only / mail-secret |
| `POST /v1/admin/journal/nudge/sweep` | operator rehearsal | admin token |

Every non-admin route resolves identity via the shared `callerUserOf`/`callerOf` seam, 401s
early, and — the structural-privacy point — is scoped to that caller with no visibility parameter.
There is **no search route, no thread route, no share route** (§8).

---

## 8. What the backend does not build — and why

| On-device, not backend | Why |
|---|---|
| **Semantic search** | The query and the match run in a worker over on-device embeddings; "nothing is sent anywhere to search." No query endpoint, ever — but the backend still *supplies* the corpus feed and the model weights (see §8.2). |
| **Threads** | Derived clusters over the on-device embeddings; "never stored as user input," no tagging UI. No table, no route (rides on §8.2's obligations). |
| **The rhythm** | Histogram + learning + confidence stay local; only the derived `next_due_at` crosses (§4.1). |
| **Sharing / export-to-post / gallery** | No share entity exists, structurally (§0.1). |
| **MCP tools** | The agent does not read your pages (canon §12). Journal exposes **no** `ToolHost` — which also sidesteps the "`McpServer` binds a single ToolHost" limitation entirely. Journal has no MCP surface, on purpose. |

This table is not a backlog. Each row is a deliberate non-feature that the architecture should
make *hard to add by accident* — the strongest guarantee is the absent route and the absent table.
But two features live near this line and deserve more than it: **search**, which stays routeless yet
still needs the backend as a supplier (§8.2), and **voice**, which — on closer reading of where the
canon actually draws its privacy line — turns out to be a genuine server-side backend feature, not
a non-feature at all (§8.1). The next two subsections make both honest.

### 8.1 Voice input — DECIDED: bought from a vendor, part of Windmill One

Not self-hosted. We **buy** transcription from an ASR vendor (Deepgram / AssemblyAI / Groq-Whisper /
OpenAI); it's a **Windmill One** feature. This gets the big-model quality that makes *"say it however
it comes out → clean prose"* real (the P4/P5 WOW) with zero GPU infra to run. Two consequences the
design states out loud rather than papers over — and both are about the *experience*, not the money:

**Privacy — audio now leaves to a third party.** Self-hosting would have kept audio on infra we
control; buying means it goes to the **vendor**. So *"Audio discarded"* / *"Only you"* rests on a
**contractual** guarantee, acceptable **only** with a vendor on a **zero-retention, no-training**
agreement (Deepgram, AssemblyAI both offer this), and the voice-path copy should name the processor
rather than imply *"only you"*. The browser's Web Speech API stays rejected: it ships audio to
Google/Apple with no such contract. This matters to the mission — the *nice feeling* depends on the
product being honest about where your voice goes.

**Canon — voice was "Free, forever"; it's now a Windmill One feature.** A small copy/`pricing.md`
update so the surface doesn't advertise voice as free while it's a subscriber feature (§10.8a). Not
a money mechanic — just keeping the product truthful.

The engine itself:

```cpp
// ports/Transcriber.h — a thin seam over whichever vendor we buy from; the adapter holds the key.
struct Transcriber {
  virtual ~Transcriber() = default;
  virtual bool configured() const = 0;                    // false ⇒ Talk absent (no vendor wired)
  virtual std::function<void()> transcribeStream(         // opus frames in → transcript deltas out
      std::function<void(const AudioFrame&)> feed,
      std::function<void(const Transcript&, bool final)> onText) = 0;
};
```

```
WS  /v1/journal/transcribe    (Windmill One; owner-authed) — streaming voice → live transcript deltas
POST /v1/journal/transcribe   (Windmill One; owner-authed) — one-shot opus/webm → { "text": "…" }
```

Two ways to move the bytes; pick by what the vendor supports. **Client-direct (preferred):** our
server confirms `subscribed`, mints a short-lived scoped vendor token, and the client streams
**straight to the vendor** — audio never touches a Windmill server at all, and the discard promise
is wholly the vendor's zero-retention contract (Deepgram supports this). **Server proxy (fallback):**
client → our `WS`/`POST` → vendor, when the vendor can't mint client tokens; then the audio only
ever lives in an utterance-scoped buffer, `unlink`ed on every exit path, never durable, never
logged, destroyed before the final transcript is acked. Either way `subscribed` is checked *before*
any audio reaches the vendor — not to meter, just so Talk is a subscriber feature. The streaming
plumbing has repo precedent: `AnthropicComposer` already streams a model over a raw trantor TLS
connection on its own loop thread (`composeStream`) — the same shape.

`transcribe` produces **no page** — it returns text only; the client drops it into today's page via
the normal `PUT` with `source = spoken`. Transcription stays orthogonal to persistence.

**The faithful-transcription rule (the one that serves the mission).** Journal *"never interprets"*
(§12): the pipeline may **format** (punctuation, casing, paragraph breaks, drop filler) but must
**never reword, summarize, or improve** — your words stay yours. Prefer the vendor's plain
transcript + deterministic formatting; keep any vendor "smart-format"/summarize mode **off**.

> **Later, not now:** because we buy per-second, some cost control (a generous allowance, abuse
> guards) will eventually sit behind the same `subscribed` gate. It changes nothing the user feels
> and is explicitly out of scope for this design — deliver the cool feature first.

### 8.2 Search — an elite on-device semantic engine (DECIDED: on-device)

**Decision (locked):** interactive semantic search runs **on the device**. Not because it's the
safe choice — because at a journal's data scale it is the *faster and more impressive* one, and it
keeps "Nothing is sent anywhere to search" (P3) literally true. The heavy server-side vector engine
still exists, but for the passive intelligence (echoes, patterns, cross-time), not for the search
box. This is two hard engines, each where it's strongest — not one easy one.

**Why on-device is the WOW, quantified.** A journal is small: ten years of daily writing is ~3,650
pages, ~15–20k passage vectors at 384 dims. Brute-force cosine over that is a few million
multiply-adds — **sub-millisecond** in WASM/SIMD; no ANN index is even required (a WASM HNSW is a
later optimization, not a need). The query embedding is one small-transformer forward pass on
WebGPU, ~5–15ms. Total **under one frame, offline, query never leaving the device.** A server
round-trip would *add* 50–200ms of network to save compute we didn't need — slower exactly where
the user feels it. The flex is real transformer inference in the browser flying the canvas to the
passage before you finish typing, not a REST call to a vector database.

**What runs on the device (the client owns this engine; it is not backend, but it is the spec the
backend is built to feed):**

- **Passage-level** chunking + embedding, so a hit is a *sentence* with its char span — the canon's
  "flies the canvas to that spot with its neighbours intact", never a detail view.
- **Bi-encoder retrieve → cross-encoder rerank** on the top-k: the quality jump over naive cosine,
  and what makes "a feeling finds the passage that never used the word" actually land.
- **HyDE query expansion** — embed a hypothetical answer to the feeling, not just the words typed.
  This is the P3 magic ("felt behind" → the passage about everyone seeming further along).
- **"Why it matched"** derived from the nearest labeled thread centroid ("close to · dread about
  the review"), computed locally.
- **Threads** = live clustering (HDBSCAN/k-means) over the same on-device vectors; never stored,
  no tagging UI, add no backend obligation of their own.

None of that is a backend service. The backend is not the searcher; it is the **supplier**, and it
owes the on-device engine exactly three things — none of which is a search API:

1. **The corpus, feedably.** To search a feeling across a whole journal, the device must first hold
   and embed every page — the canon's "reading your pages · one time · [progress]". That is a
   **full-history pull**, then cheap **incremental deltas** forever after. The page reads already
   in §7 cover it, with one refinement: the range read takes a **`since` cursor on the LWW stamp**,
   not just dates, so the on-device index re-embeds only pages changed since it last synced:

   ```
   GET /v1/journal/pages?since=<hlc-stamp>&limit=…   →  pages with stamp > cursor, ascending, paged
   ```

   This same delta feed maintains the search index, the offline cache, and the year cache — one
   read, three consumers. It is a sync feed, not a search feed: it never takes a query.

2. **The embedding model, first-party.** On-device embedding needs model weights *in the browser*.
   If the worker fetched them from a public CDN/HuggingFace at first search, that fetch itself would
   leak "this user just opened search, at this time" to a third party — undercutting the very
   promise. So the weights must be a **versioned, first-party static asset** served from Windmill's
   origin and service-worker-cached. That is a hosting obligation (ship the weights, version them,
   set immutable cache headers), not a service — but it is real, and it is the difference between
   "on-device" and "on-device except for the part that tells Google you searched".

3. **One embedding model, two run locations, two stores — and a first-run accelerator.** Use the
   *same* embedding model for on-device search and server-side echoes (both first-party, obligation
   2). They keep **separate stores** — the server can't read the device's IndexedDB, and search
   must work **offline** whether or not the nightly server pass has run — but sharing the *model*
   puts both in the same vector space, which unlocks the WOW on first run:

   > **Seed the device index from the server.** The canon's "reading your pages · one time" is the
   > one slow moment in on-device search — embedding a long back-catalog on a phone. Because echoes
   > already embedded that corpus server-side in the *same* space, the server can ship those vectors
   > down (`GET /v1/journal/vectors?since=…`, owner-only) to **seed** the index, so the device
   > embeds only what the server hasn't yet, and first search is near-instant instead of a progress
   > bar. The **query is still embedded and matched entirely on-device** — nothing about the search
   > leaves — so the P3 promise holds; only already-stored page vectors come down, and page bodies
   > were already on the device via sync. This is opt-in per the design's progress-line moment, and
   > it is the difference between a good first run and a magic one.

   **Threads** ride entirely on the on-device vectors (clustering, never stored) — so, like search,
   they are backed by obligations 1–2 and add no obligation of their own.

Net: search adds **zero endpoints that take a query**, and exactly one API refinement (the `since`
cursor) plus one hosting duty (first-party model weights). The searcher is the device; the backend
is the honest supplier that lets it stay one.

---

## 9. Composition & wiring

Journal plugs in exactly like roadmap — its own `Deps` struct, its own `registerRoutes`, its own
sweep armed in `main.cpp`.

```cpp
// products/journal/routes.h
struct JournalDeps {
  std::shared_ptr<JournalRepository> pages;
  std::shared_ptr<PageService> pageService;
  std::shared_ptr<EchoRepository> echoes;
  std::shared_ptr<NudgeRepository> nudges;
  std::shared_ptr<NudgeSweep> nudgeSweep;
  std::shared_ptr<AuthService> authService;
  std::shared_ptr<SubscriptionRepository> subscriptions;
  std::shared_ptr<TokenGenerator> tokens;
  std::shared_ptr<Clock> clock;
  std::string nudgeAdminToken;
};

void registerRoutes(drogon::HttpAppFramework& app, const JournalDeps& deps);
```

```cpp
// platform/infra/main.cpp — beside the roadmap block, mirror shape
auto journalPages  = std::make_shared<PgJournalRepository>(databaseUrl);
auto journalEchoes = std::make_shared<PgEchoRepository>(databaseUrl);
auto journalNudges = std::make_shared<PgNudgeRepository>(databaseUrl);
auto pageService   = std::make_shared<PageService>(*journalPages);
auto nudgeSweep    = std::make_shared<NudgeSweep>(*journalNudges, *journalPages, *email, *tokens, nudgeArming);
auto echoSweep     = std::make_shared<EchoSweep>(*journalEchoes, *journalPages, *embedder, *subscriptions);
nudgeSweep->start();                              // one line = one new heartbeat thread
echoSweep->start();

JournalDeps journalDeps{ .pages = journalPages, .pageService = pageService, .echoes = journalEchoes,
                         .nudges = journalNudges, .nudgeSweep = nudgeSweep, .authService = authService,
                         .subscriptions = subscriptions, .tokens = tokens, .clock = systemClock,
                         .nudgeAdminToken = getenv("JOURNAL_NUDGE_ADMIN_TOKEN") ?: "" };
journal::registerRoutes(app, journalDeps);
```

- **CMake:** add a `windmill_journal` library (core: `domain/ + application/`), linking
  `windmill_platform`; fold the Pg/http adapters in under the same `Drogon_FOUND AND libpqxx_FOUND`
  guard the roadmap adapters use, so the pure core + its tests stand up without the vendor edges.
- **Schema:** one `-- ── Journal ──` section in `db/schema.sql`; idempotent; no separate file (the
  repo keeps one flat schema).
- **Tests:** `test/products/journal/{domain,application,adapters}` mirroring the tree, full
  assertions. The high-value pure targets: `EchoFinder` (cosine, day-gap, spans), `decide`
  (every gate, especially the absent lapse branch), and the LWW guard (stale write ignored,
  newer wins, superseded body captured). Fakes for `JournalRepository`/`Embedder`/`EmailSender`
  substitute freely (constructor injection, no patching).
- **CI portability (the standing gotcha):** any calendar work belongs in Postgres via
  `AT TIME ZONE`, never C++ calendar functions (mac vs Linux diverge); pqxx row mappers are
  `template <typename Row>` (the `row_ref` vs `row` split); a green local build is not green CI —
  watch `gh run` after the backend push, then probe prod.

---

## 10. Open decisions — resolved, with the ones that aren't mine flagged

The canon's four "Still open", plus the backend's own, with recommendations:

1. **Does a page seal at midnight?** *No* (canon's current answer, kept). The current day's page
   stays editable; a new day's page is created lazily on first write after midnight (device local
   day). The server enforces nothing here — the day is whatever local date the client stamps, and
   the (user, day) key does the rest. No cron, no sealing job.
2. **Echoes — nightly or on-write?** *Nightly* (§5.1). Accept that an echo can't appear in the
   session that triggered it.
3. **Sync conflict safety.** *LWW per day + an invisible revision trail* (§3.2–3.3). No CRDT text.
   The revision trail is recommended but severable to wave 2.
4. **Push channel.** *Not v1.* Ship email + in-app; the `channel` column reserves the choice so a
   `WebPush` port + `push_subscription` table drops in without a schema move.
5. **Embeddings — same buy-not-host posture as voice.** Given the decision not to self-host ASR,
   the honest default is that echo/search embeddings are also **bought** (a vendor embedding API),
   not self-hosted. Same requirement as voice then: a **zero-retention / no-training** vendor, since
   page text leaves to it, and the privacy copy names the processor. The `Embedder` port keeps a
   self-hosted swap open if the brand ever wants page text to never leave, but that is not the
   direction chosen. (Supersedes the earlier "server-controlled model" lean in §5.4.)
6. **Entitlement is one subscription — Windmill One — read by all three products** (§6). Not a
   per-product plan; not per-feature metering. Echoes and voice are simply subscriber features
   behind one shared `subscribed` predicate (`grantsAccess` over the single subscription), the same
   one roadmap reads. The canon's old "Pro = a bigger tending allowance" framing is superseded by
   the brand's one-account-one-subscription model. Usage tuning / cost control is explicitly
   **out of scope now** — mission first, money mechanics later, behind the same gate.
7. **Module rename `notes → journal`** (§1). Recommended; a one-file scaffold move across two
   surfaces plus the two structure docs.
8. **Voice — DECIDED: bought from a zero-retention ASR vendor, a Windmill One feature** (§8.1). No
   self-hosting, no metering designed now. Confirm `subscribed` *before* audio reaches the vendor;
   prefer client-direct via an ephemeral vendor token (server proxy only if the vendor can't mint
   one); faithful transcription only (no rewrite); `POST` first, streaming `WS` next. One consequence
   to own: audio leaves to a third party, so the vendor **must** be zero-retention/no-training and
   the voice copy names the processor rather than implying "only you".
8a. **Voice copy — voice moves from "Free" to Windmill One.** The canon lists voice → transcript
   under *"Free, forever"* (§05); it's now a subscriber feature. A small copy/`pricing.md` update so
   the surface stays truthful before the voice wave ships. Not a money mechanic — an honesty fix.
9. **Search — DECIDED on-device** (§8.2). An elite in-browser semantic engine (WebGPU embeddings,
   passage-level, bi-encoder + cross-encoder rerank, HyDE, live threads). The backend stays
   routeless for queries and owes three things: the `?since=` delta feed (one feed for sync,
   offline cache, and the search index), first-party embedding-model weights, and — the
   accelerator — an owner-only `vectors?since=` seed feed so first search is near-instant.
   No endpoint ever takes a query.

---

## 11. Build phasing

Each wave goes through the gauntlet (adversarial review of the diff → one fix pass → e2e on the
local stack → push), the way the working agreement requires.

- **Wave 1 — Pages.** `domain/Page`, `JournalRepository` + `PgJournalRepository` (LWW upsert),
  `PageService`, `JournalApi` (page/pages/put/export), schema section, `journal::registerRoutes`,
  `JournalDeps` in main.cpp. The canvas persists, syncs, restores. Everything free. No echoes,
  no nudges. This alone makes Journal a real product.
- **Wave 2 — Nudges.** `domain/NudgePlan` (`decide`), `NudgeRepository` + `PgNudgeRepository`,
  `NudgeSweep` (own ticker), `NudgeApi` (settings/pause/unsubscribe/admin-sweep), the
  `sendJournalNudge` method + Resend template. The device pushes its learned `nextDueAt`; the
  footer promise ("The house is quiet. Three minutes?") comes true. Ships dark behind an arming
  allowlist, like the roadmap reminder wave.
- **Wave 3 — Echoes + Voice (Windmill One).** `Embedder` port + vendor adapter, `journal_page_vector`,
  `domain/EchoFinder`, `EchoRepository` + `PgEchoRepository`, `EchoSweep` (nightly, subscriber-gated),
  `journal_echo`, echo read/dismiss routes; and the `Transcriber` seam + `POST /transcribe` behind
  the shared `subscribed` gate. The two subscriber features land together since they share the
  entitlement check and the zero-retention-vendor requirement.
- **Later — streaming voice `WS`** (live captions), **Web push**, and a `journal_page_revision`
  trail if the two-device case proves real.

The order is deliberate: the private, offline-first canvas is the product; the reading-across and
voice come last, after the promise under them (privacy, "nothing withdrawn", honest-about-vendors)
is already true in the code.
