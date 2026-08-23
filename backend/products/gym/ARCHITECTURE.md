# Windmill Gym — backend architecture

The third room in the superapp. Roadmap is the plan you set, journal is the day you noticed,
gym is the rep you did. This document designs the **backend** for it — written before any code,
the way `products/journal/ARCHITECTURE.md` was, because the four decisions that cost a migration
later (exercise identity, session snapshots, set kinds, canonical units) are all schema decisions
and this is where they get taken.

The product thinking lives in `docs/PRODUCT_LOG.md` ("Gym — the third product").

Read `STRUCTURE.md` for the one rule (platform is product-neutral; products depend on platform,
never the reverse; products never depend on each other). Gym mirrors the journal product's shape
exactly — `domain/ · ports/ · application/ · adapters/{json,postgres,http}` — and plugs in
through one seam: `gym::registerRoutes(app, deps)`.

---

## 0. The shape of the problem — a log, not a fitness app

**North star.** The mission is self-growth; gym's slice of it is progressive overload made
effortless. The product is for a lifter who follows a written program — barbell-shaped, 3–5
sessions a week, the same movements for months, weight going up in small steps. Everything the
product *feels* like it does (the ladder, the one-tap set, the rest countdown, workout mode)
happens on the device. The backend's job is narrow and load-bearing:

**What the backend owns (the whole surface):**

1. **The durable set write** — the single feature without which none of this is a training log.
   A set bound to an account, idempotent under retry. Since W3 (2026-08-12) a lifter can also
   **correct** one: the row is rewritten in place and the version it replaced is kept in
   `gym_set_revisions`, so `gym_sets` still means *one row per set that currently stands* and
   nothing anybody logged is destroyed (§2.3, §2.7). Lift protects data with more
   code than it presents data with, and still ships a path that deletes a user's entire history
   to recover from a corrupt store. Server-as-truth is not a feature of gym; it is the reason
   gym exists here. (§3)
2. **Exercise identity** — a seeded catalog of stable ids. Every structural bug in Lift traces
   to one line: an exercise is a display string. (§4)
3. **The reads the device can't fake** — the training log (sessions + sets back), last-time
   prefill, the finish, a movement's record, the statistics engine, the export, and the coach
   share. (§5)
4. **The wedge — shipped.** Gym's sixteen MCP tools on `windmill.works/mcp`, behind the platform's
   grant gate: `gym:read` answers questions, `gym:write` **records what happened and proposes changes
   to the program**, `gym:delete` destroys a workout or a coach link and **proposes** destructive
   changes to the program, and **none of the three implies another**. Every tool goes through
   the same services the REST handlers use (`TrainingService`, `CatalogService`, `ProgramService`),
   never a repository — and acts **as** the caller, so an agent is one more owner-scoped client and never an admin. There is no coach here —
   there is the lifter's own agent, and Ask (§12) for a lifter who has none. (§6, §8)
5. **The proposal ledger — shipped W6, 2026-08-12.** An agent reads this log and never writes to the
   program: a change to a day that already stands arrives as a typed field-level diff that does
   nothing until the lifter taps Apply. It is one object with a `source` column, because W7's Ask
   mints through it too. (§2.9, §6)

**What the backend deliberately does NOT do — it stays on the device:**

- **The weight ladder** (±1/±2.5 under 20 kg, ±2.5/±5 under 50, ±2.5/±10 above, bands read off the
  **magnitude**, and a step that lightens the load sized by the band just below it) is
  presentation. Retiered 2026-08-11 so the **fine** button is the program step and the **coarse**
  button is a plate change; the mined tiers put ±2 and ±5 in the middle band, which left the
  +2.5 kg step a barbell program is written in two taps away at every load its lifter trains at. Lift's best code — and Lift pasted it into three targets and let them drift.
  Gym's rule was "exactly **one** module," which held only while there was one language; it is
  now one module *per language* — JS, Swift, Kotlin — all three answering
  `packages/api-contract/gym-ladder.json` as a test (§11.5). The server only stores what was logged plus each exercise's default step. Same
  for comma-as-decimal parsing, sticky carry-forward, tap-to-type.
- **The rest timer** — a countdown against a target with a Notification-API alert is device
  behavior; the server reserves the target column (§2.5) and stores the wall-clock timestamps
  the device already writes.
- **Workout mode** — Wake Lock, no chrome, the 48-pt number. Client.
- **Sharing is one door beside the log, never a stance on it.** This bullet used to read
  "sharing does not exist — structurally", inheriting journal's §0.1 whole, and gym no longer
  inherits it whole: a lifter can hand one finished workout to a coach. What was load-bearing about
  that refusal is kept intact and is the reason the share is shaped the way it is:
  **there is still no visibility column, and not one of the routes that already existed changed.**
  Every one of them is still `WHERE user_id = :caller`, and absent is still byte-identical to
  forbidden on all of them. The one reader who is not the owner comes in through a **separate
  table** (`gym_session_shares`, §2.6) and one unauthenticated route that reads nothing else — so
  sharing cannot be reached by accident from any existing query, because no existing query names
  that table. A share is one session, expiring, revocable, and carries nothing about the account.
  What stays cut: a visibility column, a public profile, a gallery, a social share sheet, and
  anything discoverable without the token. The strength-tree brand bet is untouched, because
  **gym publishes, gym never imports**: it will emit an achievement or a paste-grammar tree the
  user hands to roadmap — coupling by the account and the user's own hand, never a cross-product
  read.
- **One agent path with two doors.** Gym ships a **catalog**, and whatever talks to it reaches this
  log only through those tools, under a grant: the lifter's own Claude over MCP, or **Ask** (§12) for
  someone who has no agent. It is not a SECOND system — same tools, same service, same ownership
  rules, and a run-scope narrower than any MCP connection's. Still cut: streaming (no SSE parser)
  and any chat that speaks first. **The conversation table is no longer cut** — W11 (§12.6) reversed
  W7's stateless Ask by the owner's ruling, because a conversation about your bench plateau is worth
  more in six weeks than it was that evening.
- **It reads. It proposes. It never writes to your program.** Every gym mutation an agent can make
  declares itself `record` or `intent` (`domain/Proposal.h`), and the split is by what class of
  object it touches. **A mutation that records something that already happened executes immediately,
  at every door** — a set, a workout starting or ending, a movement, a new day of the program. **A
  mutation that changes something that will happen mints a proposal that does nothing until the
  lifter taps Apply.** A lifter saying "log 100×5" is using the agent as a transcription device: the
  bar is already back on the rack, the consequence is visible in the room within seconds, and
  confirming a fact is theatre. A rewritten Tuesday speaks to a tired future person in a room where
  the conversation that caused it is gone, and Apply is the only UI that decision will ever have. A
  grant is standing consent to a *class*, given before the content of the act is imaginable; Apply is
  situated consent to a diff you can read, and the two are not substitutes under the usage this
  product sells — scheduled agents, forty-step plans skimmed once, subagents. **It is a predicate and
  not a table**, so a mutation invented in 2027 is classified by what it does rather than by whether
  somebody remembered to add it to a list. **The enforcement point is the tool layer**, because that
  is the only place gym can tell an agent from a hand: `ProgramService::replaceRoutine` is
  `PUT /v1/gym/routines/{id}` and is unreachable from `GymTools`, and there is **no apply tool at any
  grant level** — Apply is not a capability, it is a human act (§2.9, §6).

**Billing in gym is one predicate, and today it gates nothing.** The log is free — every route in §6
answers a signed-in lifter whether or not they pay — and since W7 so is **Ask**. Windmill One cannot
be BOUGHT (`paidPlansOpen()` is a hardcoded `false` and `BillingApi` 503s while no Paddle price id is
configured), so a locked Ask offering an upgrade would advertise a purchase that answers 503: a dark
pattern by accident, and the trade this brand's mission forecloses. What bounds Ask instead is a
plainly-worded daily limit (§12) and the platform's own dollar ceilings. **The gate is one predicate
away**: `AskService::ask` already reads `Entitlements::aiAllowanceFor`, which reads the plan to pick
the ceiling, so arming it is a `hasWindmillOne` refusal on that line and nothing else moves. No plan
enum, no tier arithmetic, no second gate.

---

## 1. Where it lives — and the namespacing decision

```
backend/products/gym/
  ARCHITECTURE.md            this file
  domain/Training.h/.cpp     ids · enums · Exercise · Session · Set · PlanSnapshot ·
                             InvalidTraining · codecs · defaultStepKg ·
                             the auto-close rule · the share's lifetime       (pure, no I/O)
  domain/Routine.h/.cpp      Routine · RoutineEntry · revision · snapshotOf   (pure, no I/O)
  domain/Proposal.h/.cpp     the record/intent predicate · RoutineProposal ·
                             the typed diff · what applying makes true         (pure, no I/O)
  domain/Review.h/.cpp       e1RM · the three record rules · the comparison   (pure, no I/O)
  domain/Statistics.h/.cpp   the per-movement line · the standing bests       (pure, no I/O)
  domain/Record.h/.cpp       a movement's record — chart · ladder · tiles     (pure, no I/O)
  domain/ReadReceipt.h/.cpp  what a read SERVED, counted by id: sets · sessions · weeks (pure)
  ports/LogRepository.h      sessions · sets · revisions · the coach share, + its DTOs
  ports/CatalogRepository.h  the seeds, an account's movements, names and aliases
  ports/ProgramRepository.h  routines + the proposal ledger (one port: one transaction writes both)
  ports/AskThreadRepository.h  Ask's threads and turns
  ports/PreferencesRepository.h  the settings row
  ports/AskAgent.h           Ask's port: AskTurn · AskStep · AskAnswer
  application/TrainingService.h/.cpp   the log: start/append/fixSet/finish/log/detail/lastTime/
                                       review/discard/statistics/movementRecord/export/share
  application/CatalogService.h/.cpp    catalog · createExercise · renameExercise
  application/ProgramService.h/.cpp    routines + the proposal ledger (propose · apply · dismiss)
  application/ThreadService.h/.cpp     Ask's threads: read · delete · export · the three writes Ask makes
  application/PreferencesService.h/.cpp  the settings document, read (defaults) and written whole
                                       (one service per port; none depends on another)
  application/AskService.h/.cpp   AskTools (reads + the two proposal mints) + Ask's refusal ladder
  adapters/
    json/TrainingJson.h/.cpp      the cross-surface wire codec
    csv/TrainingCsv.h/.cpp        the export's framing, and nothing else
    postgres/PgGymRows.h          what the five adapters share: instantFrom · the movement-row
                                  join · namesVisibleMovement — and nothing else
    postgres/PgLogRepository.h/.cpp · PgCatalogRepository · PgProgramRepository ·
             PgAskThreadRepository · PgPreferencesRepository        one adapter per port
    http/TrainingApi.h/.cpp       the log's routes — sessions · sets · last · stats · the CSV of
                                  sets · the coach share (the one adapter that takes appBaseUrl)
    http/CatalogApi.h/.cpp        the movements — list · create · rename · record
    http/ProgramApi.h/.cpp        routines + the proposal ledger, incl. THE TAP
    http/PreferencesApi.h/.cpp    the settings document, read and written whole
    http/ThreadsApi.h/.cpp        Ask's threads — list · read · delete · CSV
                                  (one adapter per port; TrainingApi.h holds the status ladder)
    http/AskApi.h/.cpp            POST /v1/gym/ask — the one conditional route
    mcp/GymToolCatalog.h/.cpp     the sixteen declarations + the handshake paragraph
    mcp/GymTools.h/.cpp           the dispatch behind them, over Training/Catalog/ProgramService
    llm/AnthropicAsk.h/.cpp       Ask's prompt, its opening read, and its one vendor call
                                  (the LOOP is platform's: adapters/llm/AgentLoop.h)
  routes.h/.cpp              gym::GymDeps + gym::registerRoutes(app, deps)
```

**Everything lives in `namespace wm::gym`.** Journal pays a prefix tax (`NudgeSkipReason`,
`echoCosine`, `JournalNudgeMail`) because its types sit directly in `wm` beside roadmap's, and
`main.cpp` includes both products in one TU. Gym declines to inherit that: inside the module a
set is `Set`, a session is `Session`; at a call site it is `gym::Set`, which reads exactly
right. Id tags are gym's own (`ExerciseTag`, `SessionTag`, `SetTag` → `ExerciseId`, `SessionId`,
`SetId` via the platform `Id<Tag>` template) — the same minting pattern roadmap and journal use,
just nested one namespace deeper. `routes.h` declares `gym::GymDeps` and
`gym::registerRoutes`, colliding with nothing.

Five ports, five services, five HTTP adapters cut along the same seams — and one `routes.cpp` that
mounts them, so a route's method, path and reason are still read in one column. Gym is still a
single bounded store — the catalog, the plan and
the log live or die together (a routine entry references a movement, a session freezes a routine, a
set references both a session and a movement) — so the ports are cut by AGGREGATE, not by consumer: the log (sessions, sets, revisions, the coach
share, which reads a session in the statement that mints it), the catalog, the program (routines
AND the proposal ledger, because `replaceRoutine` supersedes pending proposals in the same
transaction and a store holding them in two ports would hold that lock order twice), Ask's threads,
and the settings row. The reason is not the port file — one port with section headers read fine —
but the three files that grew in lockstep behind it: the Postgres adapter, the in-memory fake and
the Pg test file, which every wave added hundreds of lines to and which could only split cleanly
along a port seam. What the split is NOT is table ownership: the log's reads still join the catalog
to print a movement, the program's mint checks a movement against the catalog's predicate, a thread
reads its proposals — the schema's cascades cross the seams and the fake keeps one shared store
(`FakeGymStore`) so every cross-aggregate rule is written once. Each adapter's preamble says what it
still reads from another aggregate's tables; the three helpers more than one adapter needs live in
`PgGymRows.h`, and that header refuses to grow.

---

## 2. The data model — annotated SQL, each rule traced to a Lift bug

One idempotent `-- ── Gym (products/gym) ──` section appended to `backend/db/schema.sql`
(the whole file re-runs on every deploy under `ON_ERROR_STOP=1`; every statement must be
re-runnable). Tables are `gym_*`, singular, `user_id uuid references users(id) on delete
cascade` everywhere — account deletion is the cascade, as in journal. **All date/time work
stays in SQL** (`to_timestamp`, `extract(epoch …)`); instants cross the wire and the domain as
epoch-ms `uint64`; no C++ calendar function is ever consulted (the mac/CI split).

### 2.1 `gym_exercises` — identity before analytics

```sql
-- The identity table. id is a STABLE slug ('back-squat'), never renamed, never displayed;
-- name is the mutable display string. That separation IS the fix for Lift's worst bug family:
-- rename forked history, a typo forked history, 'Bench press' vs 'Bench Press' were two lifts
-- forever, and the coach could only address exercises by exact string. Here a rename is a
-- metadata edit on one row and every set keeps pointing at the same id.
-- Seeded with 64 movements in this migration (ON CONFLICT DO NOTHING — re-runnable, and user
-- edits to name survive redeploys). created_by NULL marks a seed; a movement a lifter creates
-- (POST /v1/gym/exercises) lands as a row with created_by = the owner, visible only to them.
-- A SEED row is GLOBAL — one row shared by every account on this server — so a rename of one is a
-- line in gym_exercise_names below and never an UPDATE here.
create table if not exists gym_exercises (
  id          text primary key,
  name        text not null,
  pattern     text not null check (pattern in
                ('squat','hinge','press','pull','carry','core','isolation')),
  equipment   text not null check (equipment in
                ('barbell','dumbbell','machine','cable','bodyweight','kettlebell')),
  step_kg     numeric(4,2) not null default 2.5,   -- per-movement increment, seeded and on the wire.
                                                   -- READ BY NOTHING as of 2026-08-11: the ladder
                                                   -- retier took the fine step from the load band
                                                   -- (±2.5 above 20 kg) rather than from here, so
                                                   -- this column is reserved and not yet load-bearing
  created_by  uuid references users(id) on delete cascade,   -- null = catalog seed
  created_at  timestamptz not null default now()
);

-- What a lifter calls a SEEDED movement, per account. `UPDATE gym_exercises SET name` on a seed
-- renames Back Squat for EVERY lifter on the server, and this table is the whole of why that
-- statement is never written for one. Every read that returns a movement name coalesces this over
-- the seed's — the catalog, the log row's movement list, the record page, the export, the coach
-- share (resolved against the OWNER of the shared workout) and the MCP projections that ride on
-- them. Renaming back to the seed's own name DELETES the line rather than storing a copy of it.
create table if not exists gym_exercise_names (
  user_id     uuid not null references users(id) on delete cascade,
  exercise_id text not null references gym_exercises(id) on delete cascade,
  name        text not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, exercise_id)
);

-- What this account USED to call a movement (W10), seeds and its own alike. The whole promise of a
-- rename is that nothing is lost, and the picker searches these beside the current name — so the
-- word in a lifter's hands on Tuesday still finds the movement they renamed on Sunday. A ROW rather
-- than a column beside the name above, for two reasons that each rule the column out alone: that
-- table holds a line only for a SEED an account renamed, while a movement the lifter created has
-- none, and a lifter renames more than once. The name is part of the key, which is what makes
-- renaming BACK a delete of one row rather than a stale alias shadowing the truth in the picker.
-- The rename caps the list at kMaxAliases (5): this row set ships on the catalog read.
create table if not exists gym_exercise_aliases (
  user_id     uuid not null references users(id) on delete cascade,
  exercise_id text not null references gym_exercises(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, exercise_id, name)
);
```

The seed is 64 movements across the seven patterns (the flat `legs`-vs-three-arm-buckets
lopsidedness of Lift's taxonomy is refused; pattern is the only classification, and the cut
muscle-group volume feature stays cut). Steps by equipment: barbell 2.5 (smallest plate pair),
dumbbell 2.0 (rack gap), machine 5.0 (pin), cable 2.5, bodyweight 2.5 (belt plate — and
negative weight is legal for band-assisted work), kettlebell 4.0. `dip`, `pull-up` and
`muscle-up` are distinct ids with "weighted" expressed by load, not identity — that keeps the
phase-3 strength-tree chain (dip → weighted dip → muscle-up) expressible from logged sets.

### 2.2 `gym_sessions` — the client-minted id is the idempotency key

```sql
-- A session is started by the device with a CLIENT-MINTED id ('ses_<hex>'). The id IS the
-- idempotency key: a double-tapped Start, an offline replay, a retried POST all conflict on
-- the PK and no-op — Lift minted a phantom session from a double-tap and needed a guard
-- nobody wrote for a year. One open session per user is enforced by the partial unique index,
-- not by application memory: starting while another is open JOINS the open session, unless the
-- caller states it will not join (§11.4), in which case the no-op is reported as a refusal.
-- plan is a FROZEN jsonb copy of the routine at start, composed by the SERVER from its own
-- routine row and never by a client (null = ad-hoc). Lift stored templateId
-- + a copied name, so it could say what you did and never what you were supposed to do, and
-- editing a template mid-workout rewrote the program's past. A snapshot is what makes
-- phase-3 plan-vs-actual possible at all. routine_id is informational (set null on delete);
-- the snapshot is the truth.
create table if not exists gym_sessions (
  id          text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  routine_id  text references gym_routines(id) on delete set null,
  plan        jsonb,
  started_at  timestamptz not null,
  finished_at timestamptz,
  closed_by   text check (closed_by in ('finish', 'stale'))   -- who closed it (§3.2, the fourth rule); NULL = a row from before, read as finish
);
create index if not exists gym_sessions_log on gym_sessions (user_id, started_at desc);
create unique index if not exists gym_sessions_one_open on gym_sessions (user_id)
  where finished_at is null;
```

`started_at`/`finished_at` are client wall-clock instants — offline logging means the device's
clock is the only honest one, and this is the owner's own data.

### 2.3 `gym_sets` — the product, one row at a time

```sql
-- The unit of the whole product: ONE ROW PER SET THAT CURRENTLY STANDS, written by one device at a
-- time. A correction rewrites the row and keeps what it replaced in gym_set_revisions (§2.7), so
-- every read of this table stays exactly what it was — the tonnage, the marks, the records, the
-- chart, the prefill and the export all recompute off the live rows and none of them projects a
-- chain. Nothing to converge, so no HLC and no lattice — the client-minted id ('set_<hex>') makes
-- the background-flush queue replayable (ON CONFLICT DO NOTHING), which is all offline needs.
-- kind / rpe / note land NOW though their UI is phase 2 — Lift's lesson is that this is a
-- schema decision, not a feature decision: a warmup must not count toward volume, and
-- band-assisted work logs NEGATIVE kg, which naive volume = weight × reps silently subtracts
-- from every total (Lift shipped exactly that). The volume contribution of a set kind is a
-- domain decision and the finish surface took it: WORKING sets only, and a warmup, a drop and a
-- failure count toward nothing (products/gym/domain/Review.h). The storage is decided here.
-- set_number is server-assigned max+1 per (session, exercise) — not count+1, and that choice is
-- what made W3's delete safe to build: deleting set 2 of 3 leaves 1 and 3, and count+1 would then
-- mint a second 3 (a bug Lift's own spec had backwards). Nothing RENUMBERS after a delete: a gap is
-- honest and the number a set was logged under is not a lifter's to rewrite.
-- max+1 is only unique if two appends to one session cannot read the same max, and READ COMMITTED
-- lets them: a parallel flush of six sets minted four "set 1"s. The invariant is held by a
-- FOR UPDATE on the session row taken as its own statement before the insert (§3.3) — appends to
-- one session serialize behind it. No unique index on (session_id, exercise_id, set_number): the
-- lock already makes the duplicate unreachable, and an index would be a second arbiter over a
-- column that now legitimately holds gaps.
create table if not exists gym_sets (
  id           text primary key,
  session_id   text not null references gym_sessions(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  exercise_id  text not null references gym_exercises(id),
  set_number   int  not null check (set_number >= 1),
  weight_kg    numeric(6,2) not null check (weight_kg between -500 and 500),
  reps         int  not null check (reps between 1 and 500),
  kind         text not null default 'working' check (kind in
                 ('warmup','working','drop','failure')),
  rpe          numeric(3,1) check (rpe between 1 and 10),
  note         text not null default '',
  completed_at timestamptz not null
);
create index if not exists gym_sets_session  on gym_sets (session_id, set_number);
-- the prefill read and every per-exercise history: newest sets of one movement, one index
create index if not exists gym_sets_history  on gym_sets (user_id, exercise_id, completed_at desc);
```

Canonical unit is **kg, at rest and on the wire**. `numeric(6,2)`, never float, so 72.5 is
72.5 forever; the C++ domain carries `double`, and the one place it aggregates — the finish
surface's e1RM — rounds to the single decimal the screen prints *before* it compares anything, so
float noise can never mint a record (§3.1). There is no lb column and no unit-preference row — a second untested ladder doubles the surface of the one
thing that must be perfect, and the named user is not American.

### 2.4 `gym_routines` + `gym_routine_entries` — the plan, relational

```sql
-- The plan. Entries are RELATIONAL, not a JSON blob — Lift persisted per-set pyramid targets as
-- an opaque blob ("the database can never query or aggregate it") and decode failures silently
-- returned [], losing the program. The one legitimate blob is the session's frozen snapshot
-- (§2.2), which is a copy by definition.
create table if not exists gym_routines (
  id          text primary key,                     -- client-minted 'rt_<hex>'
  user_id     uuid not null references users(id) on delete cascade,
  name        text not null,
  position    int  not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists gym_routines_user on gym_routines (user_id, position);
-- The concurrency token (W6, 2026-08-12), load-bearing twice over: it is what an agent's proposal is
-- minted AGAINST, and it is what stops the mid-session "Save 87.5 to Push A" — a full
-- read-modify-write PUT — from silently destroying that base. A PUT that moves the document or the
-- name moves this number and supersedes every pending proposal in the same transaction; one that
-- lands the bytes already standing moves neither (§2.9).
alter table gym_routines add column if not exists revision int not null default 1;

create table if not exists gym_routine_entries (
  routine_id       text not null references gym_routines(id) on delete cascade,
  position         int  not null check (position >= 1),
  exercise_id      text not null references gym_exercises(id),
  target_sets      int  check (target_sets between 1 and 20),                   -- null = open
  target_reps      int  check (target_reps between 1 and 100),                  -- null = max
  target_weight_kg numeric(6,2) check (target_weight_kg between -500 and 500),  -- null = last time
  rest_seconds     int check (rest_seconds between 15 and 900),                 -- null = client default
  primary key (routine_id, position)
);
-- target_reps was `not null default 8` until routines met the chin-up, and target_sets was
-- `not null default 3` until a routine could be SAVED WHILE INCOMPLETE (W10); the run carries no
-- ALTER machinery, so each change is its own pair of idempotent statements beside the table.
alter table gym_routine_entries alter column target_reps drop not null;
alter table gym_routine_entries alter column target_reps drop default;
alter table gym_routine_entries alter column target_sets drop not null;
alter table gym_routine_entries alter column target_sets drop default;

-- The creation row of the routine's history (§M30's `9 Aug · created by you · 4 movements`), and
-- both are nullable because a day made before W10 cannot be asked what it was: created_entries is
-- how many lines the day was BUILT with — stored, because counting today's document would be a
-- different number the moment the lifter edits it — and created_door is the agent door that made
-- it, null meaning the lifter's own hand.
alter table gym_routines add column if not exists created_entries int;
alter table gym_routines add column if not exists created_door text
  check (created_door in ('mcp','ask'));
```

The same movement twice in one routine — bench heavy, then bench back-off — is two rows with
two positions. Lift collapsed them into one set counter with `uniquingKeysWith`; here the
key is position, so the legitimate program is representable by construction. `rest_seconds`
is the target the device's own rest timer counts down.

**Four of the entry's columns mean something by being null**, and two of them came late.
`target_sets` is the newest: §M's third door onto a routine is a lifter copying a program out of a
notebook at the kitchen table, and a day like that is **savable while it is still incomplete** — a
line with no target at all is `open`, and it asks at the rack. It is the ABSENCE and never a zero,
which would be a target of nothing; `Routine` refuses reps or a load beside it, because half a
target is a line no screen here can draw. `target_reps` came the wave before: the canon draws
`Chin-up 3 × max` on three screens, and a required rep target could not express that line at all — no number stands in for "as many as you can", since 0 is out of range and
1 is a single. So the absence *is* the target, everywhere it travels: the column, the entity, the
frozen snapshot, the wire, and the `max` every surface draws. A null target weight is "whatever you
did last time" and a null rest falls back to the lifter's global rest target (§2.8), under the same
rule — inherited by the surface running the timer, never filled in here, so the column and the wire
both stay null.

**A routine is written as a whole document**, on the create and on the replace alike: the row and
its entries land in **one transaction**, so a routine holding no entries is not a state the store
can be left in, and a replace deletes the run and lays it down again. Churning the entries costs no
identity — an entry has none, its key *is* its position — and it is what makes a reorder, an
insertion and a deletion one write instead of three verbs the editor would have to sequence
correctly. Positions are dense and 1-based, checked by the `Routine` constructor against the order
the entries arrived in: one rule refusing a gap, a duplicate and a shuffle at once.

### 2.5 The plan snapshot shape

When a session starts from a routine, `gym_sessions.plan` freezes:

```json
{ "routine": "Upper A",
  "entries": [ { "exerciseId": "bench-press", "sets": 3, "reps": 8,
                 "weightKg": 82.5, "restSeconds": 180 } ] }
```

Every field of a line but `exerciseId` is omitted when the routine named none — `reps` included,
which is the frozen half of §2.4's `3 × max`, and `sets`, which is the frozen half of its `open`:
a session started under a half-built routine has to be able to say *you decide* about a movement,
and a snapshot that filled the number in is where that would have been lost.

**The server composes it, always** — from its own routine row, inside `TrainingService::start`. A
client-composed snapshot would freeze whatever that client last read, which is exactly the staleness
the snapshot exists to prevent; and a start naming a routine the caller cannot read is `404 no such
routine` rather than a session quietly started ad-hoc. Frozen at start; mid-session changes are
session-scoped, and an offer to write one back into the routine is a **client** surface issuing an
ordinary `PUT /v1/gym/routines/{id}` — the server never infers it, never auto-writes it and never
asks. Postgres can still query jsonb when plan-vs-actual wants it — a snapshot is a copy, not a
blind spot.

In C++ it is a typed `PlanSnapshot` on the `Session` (it was a raw `std::string planJson` until
routines shipped, when nothing had ever written the column). One codec pair in
`adapters/json/TrainingJson` serializes it, and **both** edges go through it — the jsonb column and
the wire — so the stored object and the one a client reads back are byte-identical and cannot drift.
The read half clamps rather than throws, because it reads what storage holds: `routine` is a name
only when it is a string (the same rule the prefill's `jsonb_typeof(plan->'routine') = 'string'`
applies, and the reason it applies it), and a plan that is not an object is no plan at all.

### 2.6 `gym_session_shares` — the coach share, in its own table

```sql
create table if not exists gym_session_shares (
  session_id  text primary key references gym_sessions(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  token       text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
```

**Why a table and not a `visibility` column on `gym_sessions`** — this is the decision a future
reader will otherwise undo, so it is written down here rather than implied. A column puts a stance
on every session row, and the moment one exists every read in the product has to be re-decided in
terms of it: every `WHERE user_id = :caller` query becomes a place where a gate can be forgotten,
and the property §0 is built on — *absent is byte-identical to forbidden* — stops being structural
and becomes something every one of those queries has to keep agreeing about, forever, as more of
them are written. A separate table leaves all of them exactly as they were and adds **one** door
beside them. Sharing is then
unreachable by accident, because no existing query names this table; the whole share feature is
three methods on the port, and deleting the table would delete the feature and nothing else.

**`session_id` is the primary key**, which is what makes the mint idempotent: tapping Share twice
sends one link rather than two capabilities a lifter would have to revoke separately. A share that
has already **expired** is replaced rather than returned — re-sharing a workout a month later is a
new capability, not the resurrection of one that ended — and the guard on that `DO UPDATE` reads
the instant the caller passed, never the database's own clock, so one clock decides both halves of
the write.

**The token is minted by the server** (the platform `TokenGenerator`, the same mint behind a
session cookie) and never accepted from a client, because a client that picks its own share token
picks a guessable one. Unlike a session or a magic link it is **stored in the clear rather than as
a digest**, and that is a deliberate trade with a stated cost: the mint must hand back the *same*
link on a repeat, which a digest cannot do. What a database leak would expose here is a set of live
links, each to one workout, each expiring and revocable by its owner, none naming the
account behind it — where the same leak against `wm_session` would expose nothing at all.

**Revocation is deleting the row.** Nothing is marked, nothing is swept, and a revoked token
resolves to the same nothing an invented one does from the very next request. The row rides the
session's `on delete cascade`, so a discarded workout leaves no live link pointing at a session
that is gone, and it is in `PgAccountFootprint`'s owned list in `main.cpp` — a live coach link is
data, and an account holding one is not empty.

### 2.7 `gym_set_revisions` — what a correction replaced (W3, 2026-08-12)

```sql
create table if not exists gym_set_revisions (
  revision_id  bigserial primary key,
  set_id       text not null,                                        -- deliberately NO foreign key
  session_id   text not null references gym_sessions(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  exercise_id  text not null references gym_exercises(id),
  set_number   int  not null,
  weight_kg    numeric(6,2) not null,
  reps         int  not null,
  kind         text not null,
  rpe          numeric(3,1),
  note         text not null default '',
  completed_at timestamptz not null,
  deleted      boolean not null default false,
  replaced_at  timestamptz not null default now()
);
create index if not exists gym_set_revisions_set on gym_set_revisions (set_id, replaced_at);
```

**The ruling, and why it is not append-a-superseding-row.** The instinct — and an advisory board's
recommendation — was to keep `gym_sets` append-only and correct a set by appending a superseding row
with a tombstone. That was refused on **blast radius**: a superseding row means *every* read of sets
must project — filter the superseded, resolve the chain — and that is session detail, the log's
marks, the record page, the review, the statistics, the prefill, the CSV export and every MCP
projection. Ten-odd queries, each one a chance to forget, paid forever on every future read, to buy
a property nothing needs; and a forgotten projection shows a lifter a set twice, or a number they
corrected weeks ago. So: **a correction UPDATEs the set row and appends the prior version here; a
delete moves the row here whole, marked `deleted`.** `gym_sets` keeps its one meaning, every
existing read is untouched and correct by construction, and what append-only was actually protecting
is preserved where it belongs — **nothing a lifter logged is ever destroyed.**

**Nothing shows this table to a lifter, and that is deliberate rather than unfinished.** There is no
trash, no recovery route, and no copy anywhere in this repo that promises a set back — §G18 draws
none, and the wave that built this swept the tree for the older `Trash — recoverable for 30 days`
line and found no copy of it here. **That line is still drawn in the G3 brief, which moved into this
repo on 2026-08-23 as `docs/design/gym/briefs/04-G3-the-log.md`** — so correcting it is no longer
blocked on anyone else, and it has not been corrected yet. Until it is, the canon promises a
door this product does not have. The table exists so the sentence above is true, not so a screen can
offer an undo it would then have to keep honest.

**One write reads it, and it reads one column.** An append asks whether the id it carries names a set
this account DELETED, because a delete has to survive a replay of the POST that logged the set
(§3.3). That is not a door back: it hands nothing over, it refuses.

**`set_id` carries no foreign key** because a deleted set's row is gone from `gym_sets` and the whole
point of this table is to outlive it. `session_id` and `user_id` keep theirs, so closing an account
takes these rows and **discarding a workout takes its revisions too** — which is what keeps
`discard_session`'s own promise ("Permanent — nothing keeps a copy") true. The columns carry no
`CHECK`s: this is a copy of what a row already was, and a constraint tightened on `gym_sets` later
must never make the history of a set unwritable. `revision_id` is the one id in gym the server
mints — a kept row is not something a client names, because nothing names it at all.

**Both writes keep their copy in the same statement that moves the row** (`PgLogRepository`),
so there is no instant in which a version is gone and unkept: the delete's `DELETE … RETURNING`
feeds the `INSERT`, and the correction's data-modifying CTE copies the row beside the `UPDATE` —
**only where the row actually moves.** `{}` is a legal fix and a resent identical fix is what a
client does with a lost reply, so an unconditional copy would grow a version per retry standing for
a change nobody made; the CTE carries an `IS DISTINCT FROM` guard and a write that replaced nothing
keeps nothing.

**One lock order, taken by all three writes that change what a workout holds: the session row first,
its set rows after.** `insertSet`, `updateSet` and `deleteSet` each open with an owner-scoped
`SELECT … FROM gym_sessions … FOR UPDATE` as their own statement, and that one line buys three
things. Under READ COMMITTED a statement's snapshot is taken when it begins, so a correction that
both copied the row and rewrote it in one statement would copy the version it read *before* waiting
on a racing correction's lock — and that correction's value would leave the log with nothing keeping
it; locked first, the second statement reads fresh. An append replaying a POST while a delete of the
same id commits is decidable rather than a coin toss: either the append lands and the delete removes
it, or the delete commits and the append is refused by the revisions read. And the order is uniform,
so nothing deadlocks — `gym_set_revisions` carries a foreign key to `gym_sessions`, so every copy
already asks that session row for a `KEY SHARE`, and a writer that took a set row *first* would close
the cycle. The `DELETE` still takes the set's own row lock and re-evaluates the row it waited for,
which is how a delete racing a correction keeps the value that correction wrote.

### 2.8 `gym_preferences` — the settings section, and the one table that is not the log (W4, 2026-08-12)

```sql
create table if not exists gym_preferences (
  user_id         uuid primary key references users(id) on delete cascade,
  units           text not null default 'kg' check (units in ('kg','lb')),
  rest_seconds    int check (rest_seconds between 15 and 900),   -- null = no timer
  rest_sound      boolean not null default true,
  confirm_haptic  boolean not null default true,
  confirm_sound   boolean not null default false,
  updated_at      timestamptz not null default now()
);
```

§I's rows, one row per account. **Units are a display transform and nothing else** — §9.4's
canonical-kg decision is untouched by this table and cannot be reached by it. There is no `lb`
column here or anywhere in the schema; every weight in gym is kilograms, forever, and switching to
`lb` changes what a screen prints. `PreferencesApiTest` proves it end to end: an account that sets `lb`
before it logs anything gets the same kilogram back from the session read, the log row's tonnage and
the CSV cell, and switching back leaves all three byte-identical.

**EQUIPMENT LEFT THIS TABLE ON 2026-08-13**, and it is a product decision rather than a defect
found. `bar_weight_kg` and `plates_kg` were an inventory a lifter had to keep correct in order to be
served a loading readout under every numeral — and gyms are more or less the same, while this
product's job is to guide a program and track what was done. So the readout went from three
surfaces, the two settings rows above it went, the `gym-plate-readout` golden was retired
(`packages/api-contract/README.md`) and the columns are DROPPED by `schema.sql` rather than left
standing: a column nothing reads is the same lie as a stale comment. `get_preferences` went with
them (§6) — a vague name agents reached for at the top of any turn, answering with an inventory
that no longer exists.

Every value is **account-level**, and each for its own reason: a lifter reads in one unit
everywhere, and the rest target is their program's. The confirmation pair is the one worth stating
out loud — it records the lifter's INTENT and each surface honours what it can (a native haptic
where there is one, a sound where there is not), so a surface with no Vibration API says so where
the row is drawn instead of moving a toggle that does nothing.

Three decisions worth the ink:

- **Defaults live on the columns AND in `domain/Preferences.h`, and must agree.** A lifter who never
  opens this screen holds no row and is served the domain's copy — kg, the rest timer **off**,
  confirmation on wherever a platform has one. Off, because a timer nobody asked for that starts
  beeping in a gym is the kind of thing this product does not do. `PgPreferencesRepositoryTest` pins the
  two copies together by inserting a row with nothing but an owner and reading back the domain's
  document.
- **`rest_seconds` is NULL by default and null MEANS something** — no timer — exactly as a routine
  line's absent target weight means "whatever you did last time". Its band is the band a routine
  line already carries, read from one pair of constants (`kMinRestSeconds` / `kMaxRestSeconds`,
  `domain/Training.h`), so the global dial and the program cannot ask for waits the other refuses.
- **It is NOT in `PgAccountFootprint`'s owned list**, and `main.cpp` carries the reason beside that
  list. The list decides whether the link door may DELETE an account, so a table on it must be data
  the account holds; settings are how a room is set up, never the artifact in it. Listing it would
  also break the door the way `gym_exercises`' seeds nearly did — a client writing the document on
  first paint would report every account on the server non-empty forever.

The write is a **whole-document `PUT`**, the shape a routine travels in and for the shape's own
reason: the settings screen renders every row from one value it already holds, so it always has the
whole document to send back. A `PATCH` would have to make "omitted" and "cleared" different things
on `restSeconds` — the one field whose absence already means something — which is the `rpeNamed`
two-field wart, applied to the field the whole wave is about. Its cost is the honest one and it is
stated rather than hidden: two devices with the screen open at once, and the later write wins the
whole document. That is also exactly the ordering the claim replay wants (§11.7).

Every refusal carries a machine `code`, which is a tighter rule than the rest of the HTTP surface
keeps and earns it for a different reason than the correction's does: several independent values
arrive at once, so a screen told only "could not read that" could not say which row to send the
lifter back to. `preferences-unreadable` · `unknown-unit` · `rest-target`, and the entity is what
raises each of them — refused at construction, like every other value in this product.

### 2.9 `gym_proposals` + `gym_proposal_changes` — what an agent may ask for (W6, 2026-08-12)

```sql
create table if not exists gym_proposals (
  id            text primary key,                   -- client-minted 'prop_<hex>', the idempotency key
  routine_id    text not null references gym_routines(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  intent        text not null check (intent in ('revise','remove')),
  base_revision int  not null,
  base_name     text not null,
  proposed_name text not null,
  summary       text not null default '',
  changes       int  not null default 0,            -- `Apply all N`: rows + rename + reorder
  state         text not null check (state in ('pending','applied','dismissed','superseded')),
  door          text not null check (door in ('mcp','ask')),
  connection    text not null default '',
  agent         text not null default '',
  created_at    timestamptz not null,
  settled_at    timestamptz,
  -- W11: which conversation minted it, and `set null` is §12.6's whole delete rule.
  thread_id     text references gym_ask_threads(id) on delete set null
);
create unique index if not exists gym_proposals_one_pending
  on gym_proposals (routine_id, door, connection) where state = 'pending';

create table if not exists gym_proposal_changes (
  proposal_id         text not null references gym_proposals(id) on delete cascade,
  position            int  not null check (position >= 1),
  user_id             uuid not null references users(id) on delete cascade,
  kind                text not null check (kind in ('kept','added','removed','retargeted')),
  exercise_id         text not null references gym_exercises(id),
  before_sets int, before_reps int, before_weight_kg numeric(6,2), before_rest_seconds int,
  after_sets  int, after_reps  int, after_weight_kg  numeric(6,2), after_rest_seconds  int,
  primary key (proposal_id, position)
);
```

`thread_id` is W11's addition and it is null in two cases that mean the same thing to every reader:
a proposal from the MCP door, which had no conversation, and one whose thread the lifter has since
deleted. There is nothing there to open, either way (§12.6).

**The rows are the DOCUMENT as well as the DIFF, and that is the one structural decision here.** Rows
`1..k` are the run the routine takes on, in order — `kept`, `added` and `retargeted` alike — and rows
`k+1..n` are the lines the proposal takes away. So a proposal has exactly one stored representation:
the field-level diff a lifter reads on §D14 (`sets 5 × 5 → 5 × 3`, `− Cable Fly · removed from the
routine`) and the document an Apply writes are the same rows read two ways, and they cannot drift
apart the way a stored diff beside a stored document would. `domain/Proposal.h`'s constructor is what
keeps the reading safe: the removals come last or the entity refuses to exist.

**Apply is atomic and it applies against `base_revision`.** A proposal is frozen at mint the way a
session's plan snapshot is — the base revision AND the base name — and the write lands only while
`gym_routines.revision` still equals it. A routine that moved since is **superseded, never merged
over the top**, and that comparison is made in exactly ONE place: the store, under its own lock,
because only a lock decides a race. `ProgramService::apply` loads the proposal, loads the routine and
hands the domain's `appliedTo` result down; it deliberately re-decides none of the store's facts,
because one fact decided in two layers is how the two come to be decided in two orders.

**The revision moves when the DOCUMENT or the NAME moves, and not otherwise.** The lifter's own
`PUT /v1/gym/routines/{id}` that changes either one moves it and supersedes every pending proposal on
that routine **in the same transaction**, which is exactly what stops the mid-session "Save 87.5 to
Push A" from destroying a base underneath a card somebody is about to tap. A PUT that lands the bytes
already standing — an editor saving on close, the logger writing the whole document back to change a
weight it did not change — moves nothing and settles nothing: killing a lifter's card for a save that
did nothing is the ledger deciding for them. Neither does a drag up the routines screen, because
`position` is not part of any proposal (`appliedTo` keeps the base's own).

**One pending proposal per (routine, door, connection).** A newer one from the same door and
connection supersedes the older, which keeps a lifter's Today from filling with an agent's second
thoughts; another door's — or another agent's on the same account — stands, because two of those are
two things to decide and losing one because the other spoke second would be the ledger deciding for
them. A superseded proposal is **not deleted** — applied, dismissed
and superseded alike stay as a dated record on the routine, which is the History section §B6 draws:
*"Kept on the routine as a dated record — the program's history, not a toast that disappears."*
**For as long as the routine stands**, and that is the honest end of the sentence: `routine_id`
cascades, so an applied REMOVAL takes the whole ledger with it, the applied rows included (below).

**`door` / `connection` / `agent` are provenance, and they are COLUMNS rather than a fork.** *"A
change appeared in my Tuesday and I cannot tell whether it was my Claude or Windmill's own chat"* is the
exact mental-model failure this design exists to prevent, and W7's Ask mints through this same object
with `door = 'ask'`. **`connection` and `agent` come from the transport, not from gym:**
`ToolCaller` (`platform/domain/ToolScope.h`) carries the account, the grant and a `ToolConnection`
— over OAuth the client id and the name the client registered under (`OAuthService::resolveAccessToken`,
capped at registration to 64 printable characters); over an MCP key the key's public id and the name
the person minted it under (`McpKeyService::resolveKey`, capped at 60) — and the MCP door of
`GymTools::callTool` copies both onto the `ProposalSource`, which is what sharpened the unique index
above from "per door" to "per connection" with no index change (2026-08-15). Ask stores both empty
because its door is the whole identity, and so does a caller with no connection behind it (stdio's
configured user); the wire omits either field when empty and a card renders a fallback rather than an
empty string where a model's name should be.

**Nothing a proposal touches is a logged set or a frozen plan snapshot.** The change rows carry
targets and nothing else, and applying one writes `gym_routines` + `gym_routine_entries` and no other
table. A `removed` line's *41 logged sets kept* is counted at READ time against the live log, never
stored — a count frozen at the mint would be wrong by the time anybody read it.

**Proposals have no anonymous story.** Every route is owner-scoped and 401s before it reads anything,
so there is nothing here for the anonymous claim replay to carry.

**What `Apply all N` counts, and it is what the `noChange` refusal is decided off.** Every row that
moves, one for a renamed routine, and **one for a run the proposal reorders** — because the change
rows are the document, so a reorder is a change they express by their order and in no other way. A
day is trained top to bottom, so *"move squats to the front"* is a real proposal; counting it zero
answered it *"that document is what the routine already says"*, which was false about the only thing
that refusal claimed to know.

**A SPENT PROPOSAL ID SPLITS THREE WAYS, and conflating any two of them is how a mint lies.**
Another account's id is `idTaken` — the caller learns it is spent and never whose. The caller's own
id carrying the SAME document is the replay a lost reply deserves, and the stored proposal comes back
untouched. The caller's own id carrying a DIFFERENT document is `idReused`, refused: answering it
with the stored proposal would throw the new diff away and hand back a receipt reading *"this
proposal is waiting in the lifter's app"* about an idea the caller never sent — §2's unforgivable
defect running backwards, and the exact shape `create_routine` already refuses. `isReplayOf`
(`domain/Proposal.h`) is the comparison, and it compares what the CALLER sent: never the state a
lifter has since moved it to, never the `loggedSets` counted on the way out.

**Every mint refusal returns before the commit**, which is a rule about the ORDER of the statements
rather than about style. The supersede that clears the pending slot runs inside the mint's own
transaction, so a refusal decided after it would commit that settle and roll nothing back — the
lifter's card gone off Today, nothing replacing it, behind a message reading *"mint a different one
and send it again"*. The id is resolved first, before a row moves.

**Two refusals that are decided above the store, and both are product rules.** A document identical
to what the routine already says is refused at the mint (`noChange`) — a card reading `Apply all 0`
is a notification about nothing, in an app that has no notifications on purpose. And an applied
REMOVAL leaves no proposal to read back: the routine's `on delete cascade` takes the ledger with it,
so a second tap on a slow connection answers `404 no such proposal` rather than replaying. That is
the honest shape rather than an oversight — a day that has left the program has no editor to draw a
History section in, exactly as it had none before this ledger existed — and a client treats a 404
after its own apply of a removal as the removal having landed.

**The change rows carry no CHECKs on their target columns**, for the reason `gym_set_revisions`
carries none: this is a copy of what a line asked for, and a bound tightened on
`gym_routine_entries` later must never make an already-minted proposal unreadable. The entity
refuses out-of-band values at the mint, which is where a proposal a lifter could not apply is
stopped — before it ever reaches their screen, rather than at the one moment they had decided to
trust it.

Both tables are in `PgAccountFootprint`'s owned list in `main.cpp`: what somebody suggested for a
lifter's program and what that lifter decided about it is their data.

---

### 2.10 `gym_ask_threads` + `gym_ask_turns` — Ask's past (W11, 2026-08-13)

```sql
create table if not exists gym_ask_threads (
  id         text primary key,                  -- client-minted 'thr_<hex>', the idempotency key
  user_id    uuid not null references users(id) on delete cascade,
  title      text not null,                     -- THE FIRST MESSAGE, VERBATIM, written once
  created_at timestamptz not null,
  asked_at   timestamptz not null               -- the newest turn: what the list sorts and dates by
);

create table if not exists gym_ask_turns (
  thread_id   text not null references gym_ask_threads(id) on delete cascade,
  position    int  not null check (position >= 1),
  user_id     uuid not null references users(id) on delete cascade,
  from_lifter boolean not null,
  text        text not null,                    -- as sent, byte for byte
  said_at     timestamptz not null,
  primary key (thread_id, position)
);
```

Both tables are on `PgAccountFootprint`'s owned list (`platform/infra/main.cpp`): a conversation is
the lifter's own words, and an account holding one is not empty. There is **no outcome column** —
that is derived from `gym_proposals` on every read, and §12.6 says why. The turns are written a PAIR
AT A TIME and only once an answer has landed, so a question nobody answered is never a *turn* — but
the **thread row lands first**, before the model runs, because a proposal minted mid-conversation
points at it. So a thread holding no turns is a real state: it exists for the whole of every
in-flight ask, `discardEmptyThread` takes it back when the run dies, and it survives a process that
died in between. Every read and the export carry such a thread as itself, with nothing under it.

## 3. Capability 1 — the durable set write

### 3.1 Domain (`domain/Training.h`)

```cpp
namespace wm::gym {

struct InvalidTraining : std::runtime_error { ... };   // the product's one error type;
                                                       // thrown at construction boundaries, caught in HTTP → 400

enum class Pattern   { squat, hinge, press, pull, carry, core, isolation };
enum class Equipment { barbell, dumbbell, machine, cable, bodyweight, kettlebell };
enum class SetKind   { warmup, working, drop, failure };

struct Exercise { ExerciseId id; std::string name; Pattern pattern; Equipment equipment;
                  double stepKg; bool custom; };

struct Session  { SessionId id; UserId user; std::uint64_t startedAtMs;
                  std::optional<std::uint64_t> finishedAtMs;
                  std::optional<RoutineId> routine;
                  std::optional<PlanSnapshot> plan; };   // absent = ad-hoc

struct Set      { SetId id; SessionId session; ExerciseId exercise; int setNumber;
                  double weightKg; int reps; SetKind kind; std::optional<double> rpe;
                  std::string note; std::uint64_t completedAtMs; };

struct PlanEntry    { ExerciseId exercise; std::optional<int> sets;   // absent = open (§2.4)
                      std::optional<int> reps;
                      std::optional<double> weightKg; std::optional<int> restSeconds; };
struct PlanSnapshot { std::string routineName; std::vector<PlanEntry> entries; };   // §2.5

double defaultStepKg(Equipment);   // the seed's own table: barbell 2.5 · dumbbell 2.0 · machine 5.0
                                   // · cable 2.5 · bodyweight 2.5 · kettlebell 4.0

// domain/Routine.h — the plan, beside the log rather than inside it
struct RoutineEntry { int position; ExerciseId exercise;
                      std::optional<int> targetSets;      // absent = `open` (§2.4)
                      std::optional<int> targetReps;      // absent = `max` (§2.4)
                      std::optional<double> targetWeightKg; std::optional<int> restSeconds; };
struct Routine      { RoutineId id; UserId user; std::string name; int position;
                      std::vector<RoutineEntry> entries;
                      std::optional<std::uint64_t> lastTrainedAtMs; };   // derived, absent = never

PlanSnapshot snapshotOf(const Routine&);   // the copy the server freezes at start

// domain/Review.h — the finish surface's whole judgement, pure and clock-free
std::optional<double> e1rm(double weightKg, int reps);   // Epley; ONLY for weightKg > 0

struct PriorMark      { ExerciseId exercise; double weightKg; int reps; std::uint64_t atMs; };
struct SessionHistory { std::vector<PriorMark> marks; std::optional<Session> previous;
                        std::vector<Set> previousSets; };   // what the port hands the rule

enum class RecordKind { e1rm, heaviest, repsAtWeight };     // declared in PREFERENCE order
struct PersonalRecord  { RecordKind kind; ExerciseId exercise; double value; double weightKg;
                         int reps; double previous; std::uint64_t previousAtMs; };
struct TopSet          { double weightKg; int reps; int sets; };
struct AgainstMovement { ExerciseId exercise; TopSet now; std::optional<TopSet> before;
                         std::optional<PlanEntry> planned; };
struct Against         { SessionId session; std::string routineName; std::uint64_t startedAtMs;
                         std::vector<AgainstMovement> movements; };
struct ReviewStats     { std::uint64_t durationMs; int workingSets;
                         std::optional<double> topE1rm; };
std::vector<PriorMark> marksOf(const std::vector<Set>&);          // one session's own projection
std::optional<double> topE1rmOf(const std::vector<PriorMark>&);
std::optional<PersonalRecord> recordAgainst(const std::vector<PriorMark>& earned,
                                            const std::vector<PriorMark>& standing);
struct SessionMarks    { SessionId session; std::vector<PriorMark> marks; int workingSets;
                         bool finished; };   // an open row is judged, and folds under nothing
std::vector<SessionId> recordedIn(const std::vector<SessionMarks>& page,   // the log's gold dot
                                  const std::vector<PriorMark>& standing);
struct Review          { ReviewStats stats; bool slight; std::optional<PersonalRecord> record;
                         std::optional<Against> against; };

constexpr int kSlightWorkingSets = 4;
Review review(const Session&, const std::vector<Set>&, const SessionHistory&);

}
```

**`e1rm` is defined only for a loaded set**, and that is a product rule before it is a signature: a
chin-up at 0 kg and a band-assisted pull-up at −20 have no honest one-rep estimate, and the finish
screen's loudest pixel must never hold a number the domain made up. It returns the value **rounded
to the one decimal the screen prints**, and every comparison here uses that rounded number, so a
record the product cannot show can never be minted by float noise.

**`topE1rmOf` is the one definition of a session's e1RM**, and all three surfaces that print one
come through it: the finish screen makes the projection from the sets in hand (`marksOf`), the log's
page read and the record page are handed it by the store, and they agree because at a fixed load
Epley rises with reps. It is the best estimate over the whole session and never the estimate over
its heaviest set — 3 × 95 × 10 beats 100 × 5 — which is the bug the log row carried on 2026-08-12
and the reason the number is computed in one place rather than twice.

**`recordAgainst` is the one implementation of the three record rules**, and both the finish
screen's loud line and the log's gold dot come through it — a session's own marks against the marks
that stood before it. `recordedIn` is that walked forward over a page: the standing marks come off
the store, each session is judged against the history as it stood that day, and the session then
folds into it **if it is over**. An open workout is a row on the page like any other and is judged
like one — its own finish screen judges it mid-session — but its marks stand under nothing, because
the finish read of every session counts FINISHED ones alone and a page whose two halves were
filtered differently would take a real dot off a row (2026-08-12; a page is not sorted by
finishedness, since `started_at` is the device's and a queued offline start can flush late).
A session under `kSlightWorkingSets` earns no dot for the reason its finish screen
says nothing about it — two surfaces printing different verdicts on one workout is what one shared
rule prevents. The dot is judged against the log **as it is now** and frozen nowhere, so a set
arriving late from a flush queue, or a later correction, moves it rather than leaving it lying.

**`PriorMark` is a projection, not a history**: one row per (movement, load) carrying the *best reps*
ever done at it. At a fixed weight e1RM rises with reps, so that row is the best set at that load,
and all three record rules follow from it — which is what keeps the Epley formula out of SQL
entirely (§11.5's ladder lesson applied to the second formula in the product). A mark is dated by
the **session** it was set in wherever the store hands one over — `completed_at` is the device's
wall clock (§2.2), and dating a mark by it put the same standing best on two calendar days, one off
`GET /v1/gym/stats` and one off the record page (2026-08-12). `marksOf` is the single exception and
carries set instants, because inside one workout they are the only ordering there is and the record
ranking breaks its last tie on the earlier set. `SessionHistory` is a
**domain** type although the port returns it: the review is pure, so nothing under `domain/` may
depend on `ports/`, and the rule is what defines the shape the store fills.

The record rules, decided once so web and iOS can never disagree about which line is the loud one:
working sets only (a warmup, a drop and a failure count toward nothing); **a mark must have been
passed**, so a first session claims nothing and equalling is not beating; at most one record per
session, ranked `e1rm` ▸ `heaviest` ▸ `reps-at-weight`, and within a kind by the larger e1RM, then
the heavier load, then the earlier set. Under `kSlightWorkingSets` working sets the session says
nothing beyond its three facts — a three-set session is usually a phone left running, and duration
is deliberately *not* in the predicate, because a heavy triple day is short and real while a
forgotten phone is long and empty. The comparison exists only for a session that named a routine, is
matched on the **top working set** (heaviest, ties to more reps) and never on volume — four light
sets must not beat three heavy ones — and it names the earlier session by the routine name frozen in
*that* session's snapshot, the same rule the prefill card obeys (§5).

`RoutineEntry` carries **no id**, because the table's key is `(routine_id, position)` — an entry
with an identity would be a second thing to keep in step with the store's key, and the whole reason
position is the key is that the same movement may appear twice. `Routine::lastTrainedAtMs` is the
store's aggregate over the log (`max(started_at)` of the sessions run under it), not a column
anyone writes, so it cannot fall out of step with the sessions it describes. Both types validate in
their constructors like every other entity here: a name **trimmed** (`trimmedName`, the one rule
both display names go through) and then non-empty, at most `kMaxNameLength`
(80) **bytes** — the unit the column counts — and free of NUL bytes. Trimming is what makes
`"   "` the empty name it is rather than a movement that stores and then draws blank everywhere it
appears, and what makes `" Back Squat "` the seed's own name, so renaming back to it still clears
the override instead of pinning a copy one byte different. Then: at least one entry and at most
`kMaxRoutineEntries` (50);
positions `1..n` in order; `targetSets` 1–20 *when it names one*, `targetReps` 1–100 *when it names
one*,
`targetWeightKg` within ±500, `restSeconds` 15–900 — the column checks, refused before the column
can refuse them.

**The document's size is bounded beside every field's value.** A routine's lines are written one
INSERT each inside the single transaction a routine write is, so an unbounded entry count is an
unbounded write; and `Exercise::name` carries the same eighty a routine's name does, because the
catalog read hands back every movement an account can see on every open of the picker. A write
surface that bounds each number and not how many of them there are has one door left to reach the
store with something it cannot hold.

Real constructors, never aggregate init (the house rule): `Set`'s constructor validates reps,
weight bounds, rpe range, note length, and a non-empty id, throwing `InvalidTraining` — so an
invalid set cannot exist in memory, and the HTTP layer's 400 is the constructor's throw caught
at the boundary. Two of those rules are about what *storage* can hold, and they belong here for
exactly that reason:

```cpp
// 9999-12-31T23:59:59Z, the furthest instant a timestamptz can hold.
constexpr std::uint64_t kMaxInstantMs = 253402300799000ull;
```

**Every instant is bounded to `(0, kMaxInstantMs]`** — `startedAtMs`, `finishedAtMs`,
`completedAtMs`. A device that sends nanoseconds, or serializes an int64 `-1` as a uint64, wraps
to a negative epoch and commits a 1969 row that *every later read of that account throws on*: the
log, the detail, the next start, all dead, with no delete route to recover through. The refusal
happens at construction, before SQL sees the value. The Postgres mapper clamps on the way back
too (§3.4), so a row written before this rule existed can still be read.

**A note may not hold a NUL byte.** Postgres text stops at one and would store the head of the
note as if it were the whole note — silently shortening a lifter's words is worse than refusing
them, and the wire is the only place a NUL can come from.

**A ladder step is bounded to `[kMinStepKg, kMaxStepKg]` = `[0.01, 99.99]`** — both ends of
`step_kg numeric(4,2)`, and both of them are refusals a client is owed rather than a 500. Above the
ceiling Postgres raises a numeric overflow that leaves the repository as the house 500, which the
ladder below calls *retryable*: an offline queue would resend a permanently unstorable body forever.
Below the floor the value rounds to `0.00` in the column, and the very next read of the row this
write stored refuses it as a step that is not positive. It is the same rule as the instant band, on
the one new client-controlled numeric this product has: refuse at construction what storage cannot
keep.

Codec free functions colocate in the header: `toString(SetKind)` /
`parseSetKind(string_view)` — **strict on write** (an unknown kind in a request is a 400, never
a silent downgrade of user data) — and `setKindFromStored` clamping to `working` on read, so a
future kind added by a newer deploy can't crash an older reader. Id shape validation is one
rule: `^[A-Za-z0-9_-]{8,64}$`, recommended prefixes `ses_` / `set_` / `rt_` (client-minted,
opaque to the server; the same client-supplied-id move the tree import uses).

### 3.2 The four pure session rules — auto-close, the legal end, the legal beginning, and the late set

Lift had a three-way crash-recovery UX because its store was device-local. Server-as-truth
deletes the problem, and `session-resume` was deliberately cut as a bet and kept as a rule:

```cpp
// An open session with no activity for four hours is over, and it ended at its last set —
// not at whenever the server happened to notice. A session with no sets ended when it began.
constexpr std::uint64_t kAutoCloseMs = 4ull * 60 * 60 * 1000;
std::optional<std::uint64_t> autoCloseAt(const Session&, std::optional<std::uint64_t> lastSetAtMs,
                                         std::uint64_t nowMs);
```

Pure, clock-free, tested against every branch. `TrainingService` applies it lazily — before a new
session starts and when the log is read — via the two-phase shape: load the open session +
its last set instant → `autoCloseAt` → persist the close if the domain says so. No cron, no
sweep, no heartbeat thread: gym phase 0–2 arms **zero** tickers, which is why its `main.cpp`
block is four lines.

The explicit finish is the other end of the same story, and it gets the same treatment — a rule
beside `autoCloseAt`, not a check buried in a parser:

```cpp
// A workout cannot end before it began, at zero, or past what the store can hold.
bool canFinishAt(const Session&, std::uint64_t finishedAtMs);
```

It needs the stored session, so the wire cannot enforce it alone — only the row knows when the
session began. And it has to be right the first time: between finishes `close` is
first-writer-wins by design, so the first finish that lands is the session's end **forever** — only
a STALE close yields, to the lifter's finish, under the fourth rule below.

The third rule (2026-08-16) is about the one instant a client names for a session that does not
exist yet, and it closes a trap the first two made together:

```cpp
// A device's clock is the truth about the past, never the future: a start more than five minutes
// past the log's now is refused, naming the gap. Only a start that would CREATE is held to it.
constexpr std::uint64_t kMaxClockAheadMs = 5ull * 60 * 1000;
bool canStartAt(std::uint64_t startedAtMs, std::uint64_t nowMs);
```

Without it a session started with a clock ahead of the server — a phone set wrong, or an MCP
model that said "tomorrow" — locked the whole product: `autoCloseAt` measures four hours from the
device stamp, so the phantom was never stale; the phone's honest finish was earlier than the
start and refused; discard refuses an open session; and every later start joined it. Each refusal
was right on its own. Replays and joins are not held to the clock — they create nothing — so a
phone whose clock drifted mid-workout still lands back in its own session. The refusal is
`400 clock-ahead` on HTTP (a phone's flush queue treats every 400 as terminal, and should be able
to say which one) and a sentence naming the instant to send on MCP.

The fourth rule (2026-08-16) is what keeps the first from eating a phone's owed sets, and it
turned up when two executing hunts over the phones each found the same loss from a different
door:

```cpp
// A finished session remembers WHO finished it: `finish` is the lifter's word and final; `stale`
// is the log's own four-hour guess, closed at the last landed set. A set that lands late but
// continues a stale-closed workout — within four hours of its finished_at — is accepted, and the
// finish moves forward to it. Nothing lands after the lifter's own finish.
enum class ClosedBy { finish, stale };
bool lateSetLands(const Session& session, std::uint64_t completedAtMs);
```

The auto-close is lazy and it is a *guess*: it closes a workout at its last **landed** set because
nothing more had arrived — but a phone in a basement holds sets the log never saw, and any read
that settled staleness in the meantime (the web mirror overnight, a movement's record page, the
phone's own start on reconnect) had already closed the workout under them; refusing those sets as
"landed after the finish" was the log insisting on a guess it made without the facts, and every
client's queue treats that 409 as terminal — lost lifts. So `close()` records `closed_by`
(§2.2), and `insertSet` — under the same session lock, in the same transaction — lets a set through
the finished boundary exactly when `lateSetLands` says it continues a stale close, moving
`finished_at` forward to it. An explicit finish stays terminal — and the lifter's own finish landing
on a stale close UPGRADES it (`finishAfterStaleClose`: the word becomes finish; the instant moves to
the finish when it sits within four hours of the last activity, and stays at that activity when the
tap came later — a tap hours after the bar is not five hours under it), so their word ends what the
guess only paused; a row closed before the column existed reads as a finish. The phones still drain owed appends before any call that settles
(§11.7) — that stops the close-and-extend churn — but the loss itself is closed at the root, for
every client.
A client whose clock was unset sends `0`, the session ends in 1970, `finishedAt: 0` is falsy in
JS and the row renders "in progress" for the rest of time, unfixable until phase-2 log-editing.
That is one refusal's worth of work.

### 3.3 The write path (`application/TrainingService`)

The application layer is five services, one per aggregate port, and none of them holds another:
`TrainingService` (`LogRepository&`, plus `ProgramRepository&` for the one write that freezes a
plan, the clock and the token mint), `CatalogService` (`CatalogRepository&`), `ProgramService`
(`ProgramRepository&` + the clock), `ThreadService` (`AskThreadRepository&` + the clock),
`PreferencesService` (`PreferencesRepository&`). Each HTTP adapter and `GymTools` takes only the
service(s) it reads. The log's writes below are `TrainingService`'s, and each reads top-to-bottom
like the plain-English rule:

Each write answers with a small outcome — `StartOutcome` / `AppendOutcome` / `FinishOutcome`, a
resolved row plus a typed refusal — because every refusal here is a *fact*, not an exception:
flow control never travels as a throw, and `InvalidTraining` stays reserved for malformed input.

- **`start(user, SessionStart)`** — auto-close any stale open session (§3.2) → **resolve what the
  store already holds for this caller**: their own row under that id, else whichever session is open
  for them, decided by their stated intent → and only when it holds *nothing* they are entitled to,
  **freeze the plan** if the start named a routine (load it owner-scoped; absent, or another
  account's, → `StartError::unknownRoutine` → 404; `snapshotOf` it, so the copy is composed from the
  store's own row before anything is written, §2.5) → insert with a bare `ON CONFLICT DO NOTHING`
  (deliberately untargeted: the insert must no-op on *either* arbiter — the PK replay *and* the
  one-open partial unique index; `ON CONFLICT (id)` would raise on the double-tap instead of
  converging it) → resolve the same two reads again, because the insert may have lost a race.
  A replayed POST returns the same session — open, finished or auto-closed — and it returns it
  *whatever else is going on*; a double-tap that minted two ids returns the first tap's session (the
  partial unique index refuses the second insert, and the service reads back the truth). Idempotent
  by construction, no guard flag anywhere. When **nothing** of this caller's resolves and nothing is
  open, the insert no-oped on a row owned by someone else: `StartError::idTaken` → 409, mint a new
  id. The service never invents a session the store did not accept — a fabricated 200 leaves a
  client logging into a session that exists nowhere, and every set it posts 404s forever with no
  way to notice.

  **Reading before writing is what makes that order real.** The plan used to be frozen at the top of
  the call, ahead of everything, and the cost was exact: a routine deleted after the workout began
  made both a replay and a join answer `404 no such routine` for a session sitting in the store —
  terminal by the ladder, so a flush queue dropped a start that had in fact landed, and a phone
  pressing Start could not get back into its own live workout. Neither of those callers is planning
  anything; they are being handed a session that already exists. So the routine is loaded on the one
  path that creates a session, and nowhere else.

  **The join is a caller's intent, and it is stated on the wire** (`joinOpenSession`, default
  `true`). Reading back the open session is right for the phone and free for the handoff (§11.3),
  and it is data corruption for a caller writing a *past* session (§11.4) — two intents in one
  request shape, which the server cannot infer and must not guess at from `startedAt`. A caller
  that says it will not join and finds another session open gets `StartError::alreadyOpen` → 409
  `session-already-open`, never a live workout to file yesterday's sets into. Its own id still
  answers first, so a replay is idempotent in both modes.

  **Pressing Start cannot re-plan a workout already running**, and that falls out of the order
  rather than being a rule of its own: both branches that answer with a session the store already
  holds answer with ITS stored snapshot, whatever `routineId` this call carried. A replay keeps the
  plan its session was started under; a join returns the open session's plan and not the caller's.
  The sets already logged were logged against the plan the session began with, and a second plan
  arriving mid-workout would make the finish screen's comparison a comparison against something
  that never happened.
- **`append(user, SetWrite)`** — load the session (absent or another's → not found) → construct
  the domain `Set` (throws → 400) → **resolve the replay before any refusal**: the owner-scoped
  `setOf(user, id)`. A row already stored under that id *in this session* is the answer, whatever
  state the session is in now. A row stored under that id in a **different** session is
  `AppendError::idTaken` → 409 — the caller's own earlier session or a stranger's, told apart by
  nobody, because the reply carries the fact that the id is spent and never the row. Only a
  genuinely new id reaches the insert, and **the insert is where every remaining refusal is
  decided** — including `finished`, which the service used to answer a second time off the session
  row it loaded before any lock existed. One fact decided in two layers is one fact decided in two
  ORDERS: that loaded-row copy answered `finished` for an id the store would have answered
  `deleted` for, telling a queue that a set it had in fact logged never reached the log at all.
  So: `FOR UPDATE` on the session row, then `set_number = max+1` for that (session, exercise)
  computed in the next statement, `ON CONFLICT (id) DO NOTHING`, then a read-back scoped to
  **(id, session_id)** — which is the row returned. The device's background flush can replay the
  queue in any order, any number of times; the log converges on exactly one row per minted id — with
  one order that matters (2026-08-16): into a session the log closed as STALE, a set lands only
  within four hours of the close's last activity, and each landing moves that activity forward, so
  a queue draining oldest-first lands every owed set while newest-first can hand its newest a
  terminal 409 before the sets that would have made room for it. Both phones drain oldest-first.
  A concurrent same-exercise append no longer races the numbering (§2.3): appends to one session
  serialize behind its row, which costs one lock on a write that is already one round trip.
  The insert's own four refusals come back beside the row as `SetInsertError` (§3.4) and the
  service passes them through untouched: `unknownExercise` when the set names a movement no catalog
  **this account can see** holds → `AppendError::unknownExercise` → 400; `idTaken` when the scoped
  read-back finds nothing; `finished` when the locked row is already closed →
  `AppendError::finished` → 409; and `deleted` → 409 `set-deleted`, below. None is ever an exception
  in flight — the catalog and the close are storage's to know, and storage says so in a value.

  **A set id is spent once and for good, and the replay above is not the whole of the idempotency.**
  `setOf` reads the rows that STAND, so a set the lifter deleted (§2.7) resolves to nothing here and
  falls through to the insert — which, on the primary key alone, would find the id free and log the
  set again from a queue that never learned its POST had landed. So the insert asks
  `gym_set_revisions`, under the session's lock and scoped to its owner, whether this id names a
  deleted set: `SetInsertError::deleted` → `AppendError::deleted` → 409 `set-deleted`. It is asked
  **before** the `finished` refusal, because a deleted set in a closed workout is not a set that
  never landed, and it is answered under its own word rather than `idTaken` because the two repairs
  are opposites: a spent id is repaired by minting a fresh one, which is precisely how a deleted set
  would come back under a new number. Every surface's queue treats an unrecognised 409 as terminal,
  so the word is safe to speak at a client that predates it — the set is dropped either way.

  **Visibility is checked on the WRITE, not inferred from the FK.** The foreign key only asks
  whether the row exists, so a set could name another account's private custom movement — and the
  log, the CSV export and the coach share would then print that account's private name, and its
  owner could never fully delete their account. Every write that names an exercise id now carries
  the catalog read's own predicate — `id = $1 AND (created_by IS NULL OR created_by = $2)` — inside
  the transaction that is already open, resolved against the owner read off the locked session row
  (or off the routine, for a plan entry). The refusal is `unknownExercise`, which is the honest word:
  a movement you cannot see is a movement that is not in your catalog.

  **The finish boundary, decided.** A set that already landed lands again — idempotency outlives
  the session's close, so a queue that treats 409 as terminal can never drop a row it in fact
  delivered. A set that **never** landed may **not** land after the session is closed: it is
  refused 409 `finished`, and the client drops it. The rule that follows for the device is the
  contract of the phase-1 flush queue: **flush before you finish** — finishing is the client's
  statement that everything it holds is already delivered. The exposed case is the one the device
  cannot see coming: an auto-close (§3.2) that fires while sets sit unflushed in a queue older
  than four hours. `set-logger` owns making that visible — flush on reconnect before anything
  else, and surface the refusal rather than swallowing it.
- **`finish(user, session, finishedAtMs)`** — load the session → `canFinishAt` (§3.2) or
  `FinishError::badInstant` → 400 → set `finished_at` if null; replay returns the stored session
  unchanged. Finishing an already-auto-closed session is the same no-op. The read-back after the
  close is checked like the load before it: an empty one is `FinishError::notFound`, the same fact
  an already-absent session gets, because that is what actually happened — a discard from another
  device won the race. This was the only write in the service that could answer `error == none` with
  no session, and both wire edges dereference that optional.

- **`fixSet(user, session, id, SetFix)` and `deleteSet(user, session, id)`** — the correction, W3.
  The fix is this file's own shape narrowed to three steps: load the stored row owner-scoped
  (`setOf`), hand it to the pure rule (`corrected(stored, fix)` — `domain/Training.h`), write what
  the rule returned. The rule is where a value the store cannot hold is refused, so nothing
  unstorable is ever offered to the store; and the rule is also where *what a fix may not change* is
  stated once — the movement, the instant, the set number and the session are copied across from the
  stored row by construction, so no layer above can move them by forgetting to.

  **The session in the path has to hold the set**, and that check is in the service rather than the
  store because it is the same fact the store already answers: absent, another account's, and this
  account's set in a *different* workout are one empty reply, so a stale set id cannot be walked
  into a workout the caller is not looking at. `404 set-not-found` for all three, and it is terminal
  for the queue — nothing about those bytes will ever land.

  **Nothing is refused for a finished session.** A lifter reads the log *after* the workout, which
  is exactly when they see the 4 they meant to log as a 5, so the `finished` boundary the append has
  does not exist here. Neither write settles staleness, and neither goes anywhere near
  `gym_sessions.plan` or a routine entry — *Push A keeps its own numbers*, and `TrainingServiceTest` and
  `PgLogRepositoryTest` each assert that rather than trust it.

  **The delete answers nothing at all**, which is the contract and not an omission: a set that was
  never there does not stand either, so the client whose reply was lost sends the same request again
  and gets the same 204. The one race the fix accepts is stated rather than hidden — two devices
  correcting one set leave the second one's values standing, merged against a row it read a moment
  earlier — and every version either of them replaced is kept (§2.7).

Every write returns the resolved row (journal's `PageService::write` lesson): a client that
lost a race or replayed sees the winning truth in one round trip — and when there is no row it
is entitled to, it gets a refusal, never a row it is not. The delete is the one exception and it
proves the rule: there is no row left to hand back, and a second reply that differed from the first
is exactly what an idempotent delete must not have.

### 3.4 The ports (`ports/LogRepository.h` · `CatalogRepository.h` · `ProgramRepository.h` · `AskThreadRepository.h` · `PreferencesRepository.h`)

Sketched below as ONE listing for reading; in the code it is five structs — `LogRepository` (open …
deleteSession, movementHistory, trainingLog, exportedSets, the three share doors),
`CatalogRepository` (catalog, insertExercise, renameExercise), `ProgramRepository` (routines …
deleteRoutine plus the proposal ledger, §D), `AskThreadRepository` (§O) and `PreferencesRepository`
(§I) — each file carrying its own DTOs. The proposal, thread and preferences methods are not sketched
here; their sections state them.

```cpp
struct LogRepository / CatalogRepository / ProgramRepository {   // one listing, five structs
  virtual std::vector<Exercise> catalog(const UserId&) = 0;          // seeds + own customs
  virtual std::optional<Session> open(const UserId&) = 0;
  virtual std::optional<Session> session(const UserId&, const SessionId&) = 0;
  virtual std::optional<Set> setOf(const UserId&, const SetId&) = 0; // owner-scoped: the replay lookup
  virtual std::optional<std::uint64_t> lastActivity(const SessionId&) = 0;
  virtual void insertSession(const Session&) = 0;                    // conflict = no-op
  virtual void close(const SessionId&, std::uint64_t finishedAtMs) = 0;
  virtual SetInsertOutcome insertSet(const Set& incoming) = 0;       // assigns number; refusals as
                                                                     // values. The REPLAY is the
                                                                     // service's, through setOf
  // The two that change a stored set (§2.7). Each keeps what it replaced in gym_set_revisions in the
  // SAME statement that moves the row. The update takes the WHOLE corrected row — the domain built
  // it — and answers the stored one; absent = no such set, another's, or not this session's. The
  // delete answers nothing, because a set that was never there does not stand either.
  virtual std::optional<Set> updateSet(const UserId&, const Set& corrected) = 0;
  virtual void deleteSet(const UserId&, const SessionId&, const SetId&) = 0;
  virtual LogPage log(const UserId&, const LogCursor&) = 0;   // the rows + the marks before them
  virtual std::vector<Set> setsOf(const SessionId&) = 0;
  virtual LastTimeOutcome lastTime(const UserId&, const ExerciseId&) = 0;  // the prefill read (§5)
  virtual std::vector<LastSet> lastSets(const UserId&) = 0;   // the same rule, whole catalog (§5)
  virtual SessionHistory historyFor(const UserId&, const Session&) = 0;    // the finish read (§5)
  virtual bool deleteSession(const UserId&, const SessionId&) = 0;         // the discard; sets cascade
  virtual std::vector<Routine> routines(const UserId&) = 0;       // most recently trained first
  virtual std::optional<Routine> routine(const UserId&, const RoutineId&) = 0;
  // The day's dated ledger (§M30): its proposals newest first, its creation row last. ONE read and
  // one shape for both kinds, so no screen merges two lists by date itself.
  virtual std::vector<RoutineEvent> routineHistory(const UserId&, const RoutineId&) = 0;
  // `byAgent` is who MADE the day — absent is the lifter's own hand — and it rides beside the
  // entity because it is a fact about the write, not about the document a later replace carries.
  virtual RoutineWriteOutcome insertRoutine(const Routine&, std::optional<ProposalDoor> byAgent,
                                            std::uint64_t nowMs) = 0;   // conflict = the stored
  virtual RoutineWriteOutcome replaceRoutine(const Routine&) = 0; // whole-document replace
  virtual bool deleteRoutine(const UserId&, const RoutineId&) = 0;
  virtual ExerciseInsertOutcome insertExercise(const UserId& owner, const Exercise&) = 0;
  // The rename (§4). A movement the caller CREATED renames in place; a seed is a global row and
  // takes a per-account display name instead — and either way the name it was called a moment ago
  // joins its aliases, while the name it takes on leaves them. Absent = no such id here.
  virtual std::optional<Exercise> renameExercise(const UserId&, const ExerciseId&,
                                                 const std::string& name) = 0;
  virtual MovementHistory movementHistory(const UserId&, const ExerciseId&) = 0;  // the record (§5)
  virtual TrainingLog trainingLog(const UserId&) = 0;                     // the statistics read (§5)
  virtual std::vector<ExportedSet> exportedSets(const UserId&) = 0;       // the export (§5)
  virtual std::optional<SessionShare> insertShare(const SessionShare&, std::uint64_t nowMs) = 0;
  virtual bool revokeShare(const UserId&, const SessionId&) = 0;          // false = nothing to revoke
  // The ONE read here with no UserId, because the token is the credential (§2.6). Revoked, expired
  // and never-minted are one value, so nothing above can tell them apart and neither can a prober.
  virtual std::optional<SharedSession> sharedSession(const std::string& token,
                                                     std::uint64_t nowMs) = 0;
};

struct TopWorkingSet  { double weightKg; int reps; };   // the session's heaviest, ties to more reps
struct SessionSummary { Session session;
                        int setCount;                          // every set, every kind
                        int workingSetCount;                   // the number the log screen prints
                        double tonnageKg;                      // working load, clamped at zero
                        std::vector<std::string> exerciseNames;
                        std::optional<TopWorkingSet> topSet;   // absent = no working set in it
                        std::vector<PriorMark> workingMarks;   // per (movement, load), best reps,
                                                               //   dated by the SESSION's start
                        bool closedItself; };                  // the four-hour rule ended it

// One page, and everything the rules that read a page need in one round trip: `standing` is the
// projection over everything FINISHED before the page's oldest row, narrowed to its movements,
// because a record is judged against the history before its session and page two has history page
// two cannot see.
struct LogPage { std::vector<SessionSummary> sessions; std::vector<PriorMark> standing; };

// The application puts the two facts on the row that are RULES rather than aggregations
// (`application/TrainingService.h`); the store never sees Epley and neither does any client. Both run
// over `workingMarks` — `topE1rmOf` for the estimate, which the movement simply does not enter, and
// `recordedIn` for the gold dot, which is per movement. One projection, and the same functions the
// finish screen goes through, so one workout cannot carry two verdicts two taps apart.
struct LogRow { SessionSummary summary; std::optional<double> topE1rm; bool record; };
struct LogCursor { std::uint64_t beforeMs; std::optional<SessionId> beforeId; int limit; };

enum class SetInsertError { none, idTaken, unknownExercise, finished, deleted };
struct SetInsertOutcome { std::optional<Set> set; SetInsertError error; };

struct LastTime { Session session; std::string routineName; std::vector<Set> sets; };
enum class LastTimeError { none, unknownExercise };
struct LastTimeOutcome { std::optional<LastTime> lastTime; LastTimeError error; };
// LastTime projected to the one line a list can print, for every movement at once. Sparse: a
// movement with no row is the picker's `never logged`, and atMs is the SESSION's start (§5).
struct LastSet { ExerciseId exercise; double weightKg; int reps; std::uint64_t atMs; };

enum class RoutineWriteError { none, idTaken, notFound, unknownExercise };
struct RoutineWriteOutcome { std::optional<Routine> routine; RoutineWriteError error; };
enum class ExerciseInsertError { none, idTaken };
struct ExerciseInsertOutcome { std::optional<Exercise> exercise; ExerciseInsertError error; };

// The export's row is text end to end, because a CSV is text and every rendering in one is a
// decision Postgres already makes better than C++ would (§5).
struct ExportedSet { std::string sessionId, startedAt, finishedAt, routineName, setId, exerciseId,
                                 exerciseName, setNumber, weightKg, reps, kind, rpe, note,
                                 completedAt; };

struct SessionShare { SessionId session; UserId user; std::string token;
                      std::uint64_t expiresAtMs; };
// What a coach sees, and the whole of it: no account, and no id at any depth (§2.6).
struct SharedSet { std::string exercise; int setNumber; double weightKg; int reps; SetKind kind;
                   std::optional<double> rpe; std::string note; std::uint64_t completedAtMs; };
struct SharedSession { std::uint64_t startedAtMs; std::optional<std::uint64_t> finishedAtMs;
                       std::string routineName; std::vector<SharedSet> sets; };
```

One outcome serves both routine writes because a routine write has one shape — the whole document —
and each producer can raise only what it can see: `insertRoutine` answers `idTaken`, `replaceRoutine`
answers `notFound`, and `unknownExercise` is either one's. The service does not re-spell them into a
second enum that could only say the same words; it hands the port's outcome straight back, the same
pass-through `lastTime` is.

DTOs live with their port (the house convention). **Every method that can resolve a row carries the
credential that may see it** — a `UserId` everywhere but one, and on `sharedSession` an unguessable
token instead, which is the whole of why that one is safe to leave uncredentialed (§2.6). That
includes `setOf`, the one lookup keyed by a client-minted set id:
an id is a guess anyone can make, so the scope has to travel with it. `insertSet`'s `idTaken` is
the same rule applied to the write: its read-back is scoped to `(id, session_id)`, so an id already
spent outside this session resolves to *nothing* rather than to that row. The unscoped version of
that one read handed a stranger's weight, rpe and free-text note to whoever guessed the id, and
reported a 200 for a set it had silently dropped.

**Every refusal crosses the port as a value, and that is a structural rule, not a preference.** The
catalog and the session's close are facts only storage can know. The exercise refusal used to arrive
as a `pqxx::foreign_key_violation` caught at the *HTTP edge* — which made the wire layer include a
database header and know which store gym is kept in, and cost a divergence immediately: the fake
could only imitate the throw with `InvalidTraining`, so under test that path said "could not read
that set" while the live server said "no such exercise", and no test pinned either sentence. The
translation belongs where every other adapter puts it — inside the Pg adapter, beside the statements
that already know what Postgres is (`PgTreeRepository` catching `unique_violation`,
`PgReminderRepository` catching `sql_error`). Everything the store has no answer for rides past
untranslated to the house 500.

It is no longer a catch at all: since the visibility check above, the Pg adapter asks the question
outright in the same transaction and answers it, so the FK is a backstop rather than the mechanism
and the three `catch (pqxx::foreign_key_violation)` blocks are gone. An explicit refusal is also the
only shape that can carry "you may not see it" — an FK cannot tell an id that does not exist from an
id that belongs to somebody else, and those are the same answer to the caller and different answers
to the store.

`historyFor` returns a **domain** value rather than a port-owned one, which is the exception that
proves the DTO rule: `SessionSummary` and `LastTime` are shapes the *store* composes for a caller,
while `SessionHistory` is the shape the *rule* reads — the port fills it and nothing else consumes
it. It is also one read, in one transaction: the marks, then (only for a session that named a
routine) the session it stands against and that session's sets, because without a routine the domain
draws no comparison and those rows would be loaded to be thrown away.

`LastTimeOutcome` is that same rule reaching the *reads*: `lastTime` has two empty answers — never
trained and no such movement — and the store is the only layer that can tell them apart, so it says
which in a value rather than leaving the caller to guess from a `nullopt`. An empty `LastTime` is
never one of them: the session is chosen *by* holding a non-warmup set of the movement, so a present
block always has sets, and `routineName` is `""` for a session trained ad-hoc.

The Postgres mapper also **clamps every instant it reads** into the band §3.1 accepts. The write
path makes new poison impossible; the read path makes old poison survivable — one 1969 row must
never take down every read of that account's log.

The `Fakes.h` twin applies the **same rules as the SQL** — the PK no-op, the partial-unique
open-session refusal, max+1 numbering, the owner scope on every read, the session-scoped read-back,
and the owner-scoped catalog check reported as the same typed fact — because Lift's proposal-apply bug survived
precisely as long as its mock didn't model the persistence boundary. A fake that mirrors a leak is
worse than no fake: it makes the suite green *because* the bug is faithfully reproduced. Typing the
fact is what keeps the two honest **by construction** — they now return one enum, so they cannot
hold different opinions about what an unknown movement means.

---

## 4. Capability 2 — exercise identity

The catalog read is `catalog(user)`: all seeds plus the caller's own created movements, one
query, ordered by pattern then name. Identity rules, stated once:

- The slug id never changes and never renders; the display name is one mutable column — and since
  2026-08-12 a lifter can change it, through `PATCH /v1/gym/exercises/{id}` with `{name}` alone.
  **A movement they created renames in place. A SEED does not**, because the 64 seeds are one
  global row each and an `UPDATE gym_exercises SET name` on one renames Back Squat for every lifter
  on the server; a seed takes a per-account line in `gym_exercise_names` (§2.1) and every read of a
  movement name coalesces it over the seed's. Renaming back to the seed's own name clears the line
  rather than storing a copy of it. The id never moves either way, so every set, routine entry and
  frozen plan snapshot still points at the same movement — which is exactly the promise this
  section exists to keep, and the record page (§5) is where it becomes visible. A PATCH and not a
  PUT because one field is a lifter's to change: pattern, equipment and step of a seed are the
  catalog's, and a body naming them is a `400`.
- Custom movements are rows with `created_by`, ids minted like every other client id and obeying
  the same id-shape rule — applied at the **wire**, not in the `Exercise` constructor, because the
  64 seeded slugs (`dip`) are the schema's own and predate it. `POST /v1/gym/exercises` is
  idempotent on that id like every other write here: an id spent by a seed or another account is
  `409 exercise-id-taken`, and the caller's **own** id replays with the movement already stored
  under it. That asymmetry is the whole point — a 409 on a lost reply would be re-minted into a
  second "Zercher Squat", which is the identity fork this section exists to make impossible.
  `stepKg` may be omitted, and then `defaultStepKg(equipment)` decides it, so a created movement
  climbs like the seed row beside it and no client carries a copy of that table.
- **Merge** — folding a typo'd custom onto a catalog id — is a later bet that becomes an UPDATE of
  `gym_sets.exercise_id`, possible only because sets reference ids, not names. `lift-import` folds
  Lift's case-variant free-text names onto seeded ids at import time, outside this module.
- The dip → weighted-dip → muscle-up chain stays expressible because load is data, not
  identity.

---

## 5. Capability 3 — the reads

- **The log** (`log` + `setsOf`) — sessions newest-first, keyset-paged on the **pair**
  `(started_at, id)` (`?before=<ms>&beforeId=<id>&limit=`, default 50, cap 200), summaries
  carrying both set counts, the tonnage the working sets moved, exercise names, the session's top
  working set, the marks it made with the session's best estimate over them, whether a personal
  record happened in it, and whether it closed itself; detail is per-exercise
  grouping in first-performed order, assembled client-side from numbered sets. Read-only in phase 1
  — the fix-it path is phase 2's `log-editing`.

  **The row's derived facts ride the same statement**, because the whole point of a summary is
  that the list never loads a session's sets. `topSet` is a lateral over the session's *working*
  sets — heaviest, ties to more reps, never volume, and absent for a session holding none, because
  "0 kg × 0" is not a lighter workout.

  **Both set counts travel, and the log screen prints the second one.** `setCount` is every row a
  session holds; `workingSetCount` filters to the working sets, which are the only sets that count
  toward anything. They were one number until 2026-08-12, and that was the bug the log's own design exposed: the row
  printed `setCount` beside `topSet`, a working-sets-only pick, so a five-set session with two
  warmups read *5 sets* over a number three sets earned. `setCount` keeps its meaning and its
  consumers rather than being redefined under them.

  **`tonnageKg` is `sum(greatest(weight_kg, 0) * reps)` over the same working rows**, and the clamp
  is what makes it printable at all: band-assisted work stores a negative kg (§2.3), so an unclamped
  sum lets an assisted pull-up *subtract* from a week somebody trained. An assisted set moved no
  external load and contributes zero; a bodyweight set contributes zero for the same reason, gym
  holding no bodyweight to add. This is not the volume the statistics bullet below refuses — that
  refusal is of volume **as a metric**, a headline, a tracked series, a ranking key, and it stands. This is
  tonnage **as a caption**, the scale of a week on a divider. It carries one rule with it: **a
  session or a week whose tonnage is zero shows nothing where the tonnage would go, never `0.0 t`.**
  A chin-up-and-dips week did not move zero kilograms; we have nothing true to say about it, and an
  absence beats a false zero. Weeks are the client's own fold over the page it holds — there is no
  week endpoint — so the same rule covers the oldest loaded week, which is the one week paging can
  leave incomplete and which therefore omits its tonnage until more is loaded.

  **`topE1rm` is the domain's, and it has to come off the wire.** It is `domain/Review`'s
  `topE1rmOf` — the best Epley estimate over *every* working set the session held, which is the same
  function and the same number `ReviewStats::topE1rm` gives the finish screen. It is **not** Epley
  over `topSet`: a session of 100 × 5 and then three back-offs at 95 × 10 estimates **126.7** off the
  back-offs and **116.7** off its heaviest set, so a row that ran Epley on `topSet` made one workout
  say two different things under the word `e1RM` two taps apart. Picking a set *by* e1RM is not an
  ordering the store can make — it is the formula — so the store hands over `workingMarks`, one row
  per (movement, working load) carrying the best reps at it, and `TrainingService` runs the domain over
  that.
  At a fixed load Epley rises with reps, so that projection and the full set list answer identically.
  This is the §11.5 rule applied to the second formula in the product: one copy per language and none
  in the database. A client computing an e1RM from `topSet` would be the second copy in that
  language — and a wrong one — which is exactly what `web/src/products/gym/review.js` says the web
  does not hold. Absent where Epley is undefined: no working set, or none of them loaded.

  **The wire's doubles are doubles.** `topE1rm` is rounded to one decimal as a *value*; the JSON
  text is not, because the writer renders the double at its own precision — a value like `20.7` can
  cross as `20.699999999999999` and parse back to exactly that double. Every surface parses and
  formats; nothing prints the raw token, re-rounds, or re-derives the estimate. This is the wire's
  behaviour for every double gym sends (`weightKg`, `rpe`, the review's own estimate) and the
  precision belongs to the platform's HTTP and MCP writers, not to this product.

  `closedItself` **reads `closed_by`** since 2026-08-16 — the column the late-set rule (§3.2)
  gave sessions, so the row's subtitle and the rule that revises a stale close are one fact. It was
  inferred until then (`finished_at = coalesce(max(completed_at), started_at)` is `autoCloseAt`'s
  own signature), and a row closed before the column existed still reads that signature — the fall
  back both implementations keep for legacy rows.

  The cursor is the previous page's **last row, both halves**, because `started_at` alone is not
  unique: two sessions started in the same millisecond straddling a page edge, and an exclusive
  instant cursor puts one of them in no page, ever — silently, and differently at each page size.
  Ties are near-certain the moment phase-1 `lift-import` bulk-loads coarse timestamps. A client
  that sends only `before` gets what it asks for — strictly before that instant — which cannot
  express a tie; **both halves travel or the walk is lossy**, and `beforeId` without `before`
  names no row and is a bad cursor. The summary's movement names come back as one row per
  movement, not as one string a separator has to be picked out of: a display name is user text
  — a lifter renames one — and hand-rolled framing turns one movement holding the separator into
  two.
- **Last-time prefill** (phase 1, `last-time-prefill` bet) — `GET /v1/gym/last?exercise=`, one
  route over the two gym indexes: the most recent *finished* session containing the exercise, its
  sets in order. "Last time: 82.5 × 8, 82.5 × 8, 80 × 7", weight pre-dialled. The
  metric that judges it: accepted unchanged, **or changed by exactly one ladder step in the
  progression direction** — a healthy lifter on linear progression should be one tap up.

  Four decisions, one per thing this read could have got wrong:

  - **The locator walks SESSIONS, newest first.** `gym_sessions_log (user_id, started_at desc)`
    in order, `LIMIT 1` at the first finished session holding a non-warmup set of the movement —
    the rule as the product states it, on the same `(started_at, id)` key the log read pages on, so
    the two reads can never name a different newest session. It first walked the SETS newest first
    over `gym_sets_history`, which was one index cheaper and wrong: `completed_at` is the device's
    wall clock (§2.2) and nothing ties it to its session, so a single future-stamped set pinned
    "last time" to a week-old session while the log listed a fresher one above it — and with no
    cutoff on how far last time reaches, for as long as that stamp stayed in the future. Both
    indexes still do the work, and the planner picks by selectivity: measured on 2 000 bench sets
    across 400 sessions, a movement trained every session is a semi-join driven by
    `gym_sessions_log` that stops at **2 sessions** (9 buffers, 0.07 ms); a movement trained only
    in the oldest of the 400 flips to `gym_sets_history` and probes the session by PK (**1 set
    row**, 12 buffers, 0.09 ms). Ties on the pair are impossible — the id breaks them — so unlike
    the log cursor's tie (§6) nothing is arbitrary and nothing is lost.
  - **Finished, never open — and this read settles nothing.** Today's live session is the today
    list; a last time is a previous session, and an open session is already excluded by the
    locator. Staleness is settled by a start and by the log read (§3.2), never here: this route
    fires on **every movement change**, the only open session it could reach is the caller's own
    live workout (one open per account), and closing that mid-workout refuses every set after it
    while this reply — which carries no session state — says nothing about it. A session abandoned
    with the tab shut is still settled before the prefill can be read: the client boots on the log
    read, and both doors into a workout settle before they answer.
  - **Warmups are not history.** The block is the session's non-warmup sets. Every consumer of
    last time excludes them — the card body, the weight prefill (its last row), the reps prefill
    (its first row), e1RM — and a 40 kg ramp-up single answering "what did I do last time" would be
    a lie in the product's single highest-value pixel. The filter is not a renumbering: `set_number`
    counts every set of that movement, so a block behind a warmup starts at 2.
  - **The routine name comes out of the frozen snapshot**, never out of `gym_routines`. The
    prefill card's cross-routine suffix names the day of the program that session *was*, as it was
    called then; `routine_id` is informational and nulls on delete, and a routine renamed since must
    not rewrite what the log says about the past. The read still type-checks the stored blob —
    only `jsonb_typeof(plan->'routine') = 'string'` is a name — even though the snapshot is a typed
    value the server composes and no writer here can produce anything else: `->>` renders an object,
    an array or a number as TEXT, and `{"nested": 1}` would be printed verbatim into the product's
    highest-value pixel as the day of the program. The guard costs one CASE and defends a jsonb
    column against every writer that is not this build.

  No domain rule was added, on purpose: last time is a query, not a calculation. The prefill
  *arithmetic* — plan snapshot → last time → 20 kg, with today's sticky carry-forward on top — is
  client state the server cannot see and must not guess at. The server hands back the block.
- **The picker's meta** (W5, 2026-08-12, `lastSets`) — `GET /v1/gym/exercises/last`, and it is the
  read above run over every movement at once. §B7's row prints `last 82.5 × 5 · 3 days ago` under a
  movement's name, or `never logged`, and a picker firing sixty-four `/v1/gym/last` calls to draw one
  list is the N+1 the log read already refused. One line per movement: the **last row of that
  movement's last-time block** — the row the weight prefill dials off, not the session's heaviest —
  dated by the **session's start**, which is what every mark a store hands over is dated by and what
  makes "3 days ago" the day it was trained.

  **It is a second read and not four columns on the catalog row**, and the arithmetic is the whole
  argument. The catalog is 64 rows read on nearly every screen; most of them are movements a given
  lifter has never touched, so most of those columns would be empty; and `list_exercises` hands the
  same row to an agent whose reply a deliberate token-budget wave cut by 60–96%. So the annotation is
  asked for by the one surface that draws it, and it is **sparse** — a movement with no line is the
  `never logged` the picker prints, said by saying nothing. `custom` needs no help: the `yours` tag
  is already on the catalog row, derived from `created_by`.

  One `DISTINCT ON (exercise_id)` whose inner `ORDER BY` *is* the locator's rule — newest finished
  session on `(started_at, id)`, then the highest `set_number` in it — so the two reads cannot name a
  different set.

  **What it costs, and where it changes character** (measured twice, by two agents, on local
  Postgres 14 at the default `work_mem = 4MB`; one account training a dozen movements, `EXPLAIN
  (ANALYZE, BUFFERS)` three times per corpus). The plan hash-joins the account's sets to its sessions
  and sorts every qualifying row once: **1 600 sets → quicksort, 274 kB, ~2 ms**; **19 000 →
  quicksort, 3 258 kB, ~23 ms**; **38 000 (a decade of training) → external merge, 3 032 kB spilled
  to disk, ~53 ms**. The plan *shape* never changes, but the sort crosses `work_mem` somewhere in the
  low twenty-thousands of working sets and spills from then on — a difference in kind, so it is
  written down rather than hidden behind "it scales". 53 ms for a read that fires when a picker opens
  is cheap; the lifter who ever makes it expensive is the one to revisit this for, and the measured
  alternative is in the code comment.

  **The catalog is what it must not be driven off.** The same rule as a `LATERAL` per catalog row
  measured **0.72–1.37 s** at that decade, and the plan says exactly why: 64 outer rows, each running
  a nested loop over the account's finished sessions — 104 024 inner index scans and 2.4 M buffer
  hits to return 64 rows, because proving "never logged" for a movement nobody trains means walking
  every session they ever ran. (Driven off the movements the account has *touched*, the same
  `LATERAL` measures ~9 ms — faster than the shipped sort. It was not taken because it is one edit
  away from the form above and because its win is a function of how few movements the lifter trains
  rather than of the statement. It is the noted fallback if the spill ever starts to matter.)

  No MCP tool was added — an agent asking about one movement has `last_time`, and about the whole log
  has `get_stats`, and neither of them is drawing a list.
- **The plan** (`routines` + `routine`) — the routines screen's own order, which is *most recently
  trained first* with the never-trained after them rather than above them. The instant it sorts on
  is read off the log (`max(started_at)` over the sessions run under each routine) and not out of a
  column, so it can never disagree with the log that produced it; ties fall back to `(position, id)`
  so the walk is deterministic rather than the planner's choice. Two statements, merged by routine
  id — the log read's shape applied to the plan.
- **A movement's record** (`movementHistory` + the pure `movementRecord`) —
  `GET /v1/gym/exercises/{id}/record`, and the surface that replaced the statistics room: one
  exercise, one page, one read. Four statements in one transaction, and the first is the catalog's
  own predicate — no row means this account holds no such movement (`404 no such movement`) and the
  other three never fire. The **ladders** are `DISTINCT ON (session, load)` over the movement's
  working sets in FINISHED sessions, oldest session first, and they are the whole of what the two
  tiles, the twelve weeks of bars and the record ladder are computed from: each is a question about
  the best e1RM of a session, which is a *formula*, so the store hands over orderings and the domain
  runs `topE1rmOf` over them. Their window is a LIFETIME rather than twelve weeks — only the chart
  is windowed, by the domain, against the clock the service read once — because "your best ever"
  that quietly meant "your best this quarter" would be the loudest false number in the product. The
  **recent days** are a separate statement because the ladder collapses a session's sets and the
  page prints them (`105 × 5 · 105 × 5 · 105 × 4` is three sets and two loads); warmups are not
  among them, for the reason the prefill block excludes them. The fourth statement is the days of
  the program that NAME the movement, by name, deduplicated and in program order — `routineCount` is
  that list's own length. It is names rather than a count because the RENAME SHEET (§N32) promises
  *`routines  Push A · Legs`*, and a sheet whose whole job is to prove a rename costs nothing may
  not assemble that claim from three calls; this one read is where `34 sessions`, `3 PRs · e1RM
  122.5 kept` and the two day names all come from.

  Everything on the page is dated by the **session's own start**, never by a set's `completed_at`
  (§5's statistics rule, same reason). The record **ladder** is every session whose best estimate
  beat every session before it, newest first, and the first one is not on it: a mark has to be
  passed, which is the finish screen's own rule. Where Epley is undefined — a chin-up at 0 kg, a
  band-assisted pull-up at −20 — there is no best-e1RM tile, no chart and no ladder at all, and the
  heaviest tile and the sets carry the page; a dash inside a chart frame is worse than no chart.
  Every list is **omitted from the wire when empty**, so a movement in the catalog nobody has lifted
  answers 200 with two zero counts and nothing else, which is the picker's `never logged`.
- **The finish** (`historyFor` + the pure `review`) — `GET /v1/gym/sessions/{id}/review`, one read
  behind one rule. The read is a projection and not a history: `DISTINCT ON (exercise_id, weight_kg)`
  over the *working* sets of *finished* sessions that started earlier, ordered `reps DESC,
  started_at ASC`, restricted to the movements this session works. `DISTINCT ON` is what a bare
  `max(reps)` cannot do — it hands back the winning **row**, so the mark is dated by the earliest
  SESSION those reps were hit in, which is the day the mark was set and the date the record line
  prints.

  Both of its windows compare the **pair** `(started_at, id)` against the reviewed session's own —
  the unique key every other read here pages and locates on. That is not decoration: it excludes the
  session from its own history, and the review is always read *after* the finish, so without it
  every set would tie itself and the record would silently vanish on the very first read.

  Nothing is stored. The review is recomputed on every call, which is what keeps it right when a set
  arrives late from a flush queue, and it is why there is no `ReviewService`: one load, one pure
  rule, one answer, on `TrainingService` beside `detail`.
- **The statistics ENGINE** (`trainingLog` + the pure `statistics`) — `GET /v1/gym/stats`, the
  review's shape over a longer window: one load, one pure rule, one answer, computed on every read
  and stored nowhere. It takes no parameters at all — no window, no movement filter, no page —
  because the whole point of it is the long view.

  **It is an engine and no longer a room.** 2026-08-12 retired the statistics *surface* on all three
  clients — there is no fourth tab and no dashboard in this product — and what replaced it is a
  movement's record (below), one exercise at a time. Nothing was removed here: `GET /v1/gym/stats`
  and the `get_stats` tool both stay, because an agent asking "how has my squat moved" is the
  product's own thesis, and the long view is exactly what an agent reads. Do not "clean up" this
  read as orphaned — it has two callers, one of them a model.

  Three statements in one transaction, and not one of them is a new opinion about training. The
  **series** is `DISTINCT ON (exercise_id, started_at, id)` over the working sets of finished
  sessions, keeping the heaviest with the most reps: that is `TopSet`'s rule and the same answer the
  finish screen already gives to "what was that movement that session", so the chart and the finish
  can never print two different numbers for one workout. It is made in SQL because it is an
  **ordering**; the Epley estimate over it is made in the domain because it is a **formula** —
  §11.5's ladder lesson applied to the second formula in the product, one copy per language and
  none in the database. Every point is dated by the **session's own start**, never by a set's
  `completed_at`: that is the device's wall clock and nothing ties it to the session it landed in,
  so a single future-stamped set would otherwise walk a point across the chart. The **marks** are
  `historyFor`'s projection with both of its windows removed — every movement instead of one
  session's, the whole finished log instead of what came before one session — and the two standing
  bests (highest e1RM, heaviest load) are the *prior* halves of the finish's record rules asked with
  no session to compare against. A best is dated by the session too, so the tile and the point that
  *is* that tile carry one instant: until 2026-08-12 a best came off the set's own clock while its
  point came off the session's, and the same PR read as two calendar days across this route and the
  record page. The third record rule has no standing form on purpose: "more reps
  at a load you have used before" is a comparison, and with nothing to compare against every mark
  already *is* the best reps ever done at its load. The **weeks** are counted in Postgres because
  they are dates, truncated `AT TIME ZONE 'UTC'` rather than in the server's own zone (`date_trunc`
  on a `timestamptz` reads the session's TimeZone, so the same log would bucket differently on a
  laptop and in CI), and `generate_series` fills the run so a week nobody trained is a **zero and
  not a missing row** — the gap is the fact, and a client filling it in would be doing calendar
  arithmetic in a second place. Weeks run Monday-to-Monday in UTC because the store holds no
  timezone for the lifter; the instant crosses as epoch-ms and the client renders it locally.

  **Finished sessions only**, for the reason `lastTime` and `historyFor` exclude them too: today's
  live workout is today's screen, and a statistics read that moved under a lifter between two sets
  would be reporting on a session in flight. This is one of the doors that settle staleness
  (§3.2), and it has to be one — the answer counts finished sessions, so a workout the four-hour
  rule ended hours ago but nobody has read since would be a hole in the chart, and a hole reads as
  "I did not train that week".

  **What is not in it, and each was cut for a reason that has not changed:** muscle-group volume
  and any taxonomy for it, streaks, any cardio or duration axis, volume **as a metric** — a headline
  number, a series anyone is asked to watch, a key sessions are ranked by — because `weight × reps`
  goes *negative* on band-assisted work and lies about four light sets against three heavy ones, and
  any grade, score, percentage or green/red. The finish screen's rule holds over the longer window
  too — *a fact with a direction, never a grade*.

  That refusal is of volume as a metric and not of the log's **tonnage caption**, which is a
  different claim made under the clamp and the never-print-zero rule this section's log bullet
  states. e1RM remains the headline everywhere, here and on the row.
- **Export** (`exportedSets` + `toCsv`) — `GET /v1/gym/export`, CSV of every set this account
  holds, the open session included: an export missing today is the one row a lifter goes looking
  for. It is the trust argument for a multi-year artifact and so it is deliberately dull — one
  shape, no parameters, no pagination, nothing omitted, and a fixed filename because a re-export is
  the same file with more rows in it.

  **Every value crosses the port as text**, because a CSV is text and every rendering decision in
  one is a decision Postgres already makes better than C++ would: the instants as ISO-8601 UTC (a
  spreadsheet cannot read an epoch, and the calendar conversion belongs where gym does all of its
  date work), the numerics at their column's own scale so 72.5 kg is `72.50` forever and an absent
  rpe is an empty cell rather than a zero a reader would take for a real one. That leaves
  `adapters/csv/TrainingCsv` with exactly one thing to decide — framing — and it decides it by RFC
  4180: CRLF between records, a field quoted only where it holds a comma, a quote or a line break,
  and a quote inside a quoted field doubled. A note is the lifter's own words and travels byte for
  byte, with one exception the file states out loud: a cell that a spreadsheet would RUN rather
  than show — one opening `=`, `@`, or a sign in front of something that is not a number — carries a
  leading apostrophe, because the author of a cell is not always the reader of the file (a movement
  name and a note are both writable by any MCP client the lifter granted `gym:write`, and an Ask
  turn is composed by a model). A negative load is untouched: `-20.00` is a number, not a formula,
  and band-assisted work is logged that way. This read settles **nothing**, alone among the reads
  of the log: it hands back every set unconditionally, so no session can be missing from it whatever
  `finished_at` says, and a door whose whole promise is "here is your data, untouched" has no
  business writing to the log on the way out.
- **The coach share** (`insertShare` / `revokeShare` / `sharedSession`) — two owner-scoped doors and
  the one unauthenticated read in the product, over the separate table §2.6 explains.
  `GET /v1/gym/shared/{token}` resolves the token to one session and its sets; the token is the
  whole credential, so the handler never resolves a caller and never writes — not even the
  four-hour close every signed-in read of the log takes, because a stranger holding a link must not
  be able to end the owner's workout by reading it.

  **Revoked, expired and never-minted answer one 404, byte for byte**, which is what stops a token
  from being probed for existence, and it is the same body an absent session gives every other read.
  The second statement fires only when the first found a session — roadmap's share-page rule applied
  here: a token that resolves to nothing must not spend a query proving it.

  **The body names no account and holds no id at any depth.** Not the session's, not a set's, not
  the routine's — the only thing an id could do for a reader who is not the owner is be tried
  somewhere else. Movements travel as their display **name**, because a coach holds no catalog to
  resolve a slug against, and the routine name comes off the session's own frozen snapshot (type
  checked exactly as the prefill's is) rather than off a routine as it is called today. The frozen
  plan itself does not travel: a share is one workout the lifter *did*, and a program is a
  longer-lived thing than one session's link.

---

## 6. Wire surfaces — the HTTP routes, and the MCP tools behind the grant

The routes are served by five adapters that mirror the five ports — `TrainingApi` (everything under
`/v1/gym/sessions`, `/last`, `/exercises/last`, `/stats`, `/export`, `/shared`), `CatalogApi`
(`/exercises` and a movement's record), `ProgramApi` (`/routines`, `/proposals`), `PreferencesApi`
(`/preferences`), `ThreadsApi` (`/threads`, `/export/threads`) — plus `AskApi` for the one
conditional route; `routes.cpp` is the one place every path is named, in this order.

| Method & path | Purpose | Phase |
|---|---|---|
| `GET  /v1/gym/exercises` | the catalog (seeds + own customs), each under the name THIS account calls it | 0 |
| `GET  /v1/gym/exercises/last` | the picker's meta — one line per movement this lifter has trained (`{exerciseId, weightKg, reps, at}`), and none for the rest, which is `never logged`. Beside the catalog row rather than on it (§5); `last` can never be a movement id, which needs eight characters | 2 |
| `POST /v1/gym/exercises` | create a movement — `{id, name, pattern, equipment, stepKg?}` | 2 |
| `PATCH /v1/gym/exercises/{id}` | rename a movement — `{name}` and nothing else; a seed takes a per-account name, the caller's own row renames in place, the id never moves (§4) | 2 |
| `GET  /v1/gym/exercises/{id}/record` | a movement's record — the two tiles, twelve weeks of bars, the record ladder, the recent days, and the days of the program that name it, in ONE read (§5). It is also the RENAME SHEET's proof (§N32): every number that sheet prints is one of these | 2 |
| `POST /v1/gym/sessions` | start — `{id, startedAt, joinOpenSession?, routineId?}`, idempotent; joins an open session unless the caller says it will not (§11.4); a named routine is frozen onto the row (§2.5) | 0 |
| `POST /v1/gym/sessions/{id}/sets` | append a set — `{id, exerciseId, weightKg, reps, completedAt, kind?, rpe?, note?}`. A replay of an id this account **deleted** is `409 set-deleted`, not a re-mint (§3.3) | 0 |
| `PATCH /v1/gym/sessions/{id}/sets/{setId}` | **fix a set** — `{weightKg?, reps?, kind?, rpe?, note?}` and nothing else; answers the stored row, so a retry is a no-op. `404 set-not-found` covers absent, another account's and this account's set in another workout alike; `400 fix-unreadable` covers a field a fix may not carry (`exerciseId`, `completedAt`, `setNumber`) and a value the store cannot hold. **No MCP tool, at any level** (§6, below) | 2 |
| `DELETE /v1/gym/sessions/{id}/sets/{setId}` | **delete a set** — `204`, and `204` again on a retry: a set that was never there does not stand either. Refuses nothing. The row moves into `gym_set_revisions` marked deleted (§2.7); nothing promises it back. **No MCP tool, at any level** | 2 |
| `POST /v1/gym/sessions/{id}/finish` | close — `{finishedAt}`, idempotent | 0 |
| `GET  /v1/gym/sessions?before=&beforeId=&limit=` | the log, newest first | 0 |
| `GET  /v1/gym/sessions/{id}` | one session with its sets; 200s carry a weak `ETag`, a matching `If-None-Match` answers 304 (§11.3); settles staleness (2026-08-16), so the mirror's poll ends a forgotten workout at its last set instead of showing it live forever | 0 |
| `GET  /v1/gym/sessions/{id}/review` | the finish surface — three facts, at most one record, the comparison | 2 |
| `DELETE /v1/gym/sessions/{id}` | discard — `204`; refused `409 session-open` while it is still running | 2 |
| `GET  /v1/gym/last?exercise=` | last-time prefill | 1 |
| `GET  /v1/gym/routines` | the plan, most recently trained first — each routine carrying its `revision` and the `pendingProposal` waiting on it | 2 |
| `POST /v1/gym/routines` | create a routine — the whole document, idempotent on its id | 2 |
| `GET  /v1/gym/routines/{id}` | one routine, plus its `history` — the day's creation and every proposal ever minted against it, one list, newest first with the creation row last (§M30). The LIST read carries none of it | 2 |
| `PUT  /v1/gym/routines/{id}` | replace a routine — the whole document. Moves `revision` and supersedes every pending proposal on it **only when the document or the name actually moved** (§2.9). May name the `revision` it read; a day that moved since answers `409 routine-stale` unless the bytes already stand | 2 |
| `DELETE /v1/gym/routines/{id}` | remove a routine — `204`; entries, its proposals and their change rows cascade, sessions keep their snapshots | 2 |
| `GET  /v1/gym/proposals` | the ledger, newest first. `?routineId=` narrows to one day of the program (the routine editor's History), `?state=pending` to what is waiting (Today's card) | 6 |
| `GET  /v1/gym/proposals/{id}` | one proposal with its typed diff — the screen an agent's receipt deep-links to | 6 |
| `POST /v1/gym/proposals/{id}/apply` | **THE TAP.** All of it or none, against the frozen base revision. `{proposal, routine?}` — `routine` absent when the proposal removed it. `409 proposal-superseded` when the routine moved since; `409 proposal-settled` when the other decision was already taken; a replayed tap answers `200` with the stored proposal | 6 |
| `POST /v1/gym/proposals/{id}/dismiss` | no reason asked for, nothing changed, and it stays in the routine's history. Same two refusals, mirrored | 6 |
| `GET  /v1/gym/preferences` | **the settings section** (§I) — the one read in gym that cannot 404: no row means the DEFAULTS, because every client needs the rest target and the reading unit to draw a first frame (§2.8) | 2 |
| `PUT  /v1/gym/preferences` | replace the settings document, whole. Omitted fields take their default; every refusal carries a code (`preferences-unreadable` · `unknown-unit` · `rest-target`). **Units are a display transform and reach no write** | 2 |
| `GET  /v1/gym/stats` | the statistics ENGINE — per-movement line, standing bests, weekly counts. It has no room of its own on any client since 2026-08-12; its readers are the record page's rules and any agent asking the long question (§5) | 2 |
| `GET  /v1/gym/export` | every set, CSV — `text/csv`, a header row, `Content-Disposition: attachment` | 2 |
| `POST /v1/gym/sessions/{id}/share` | mint a coach share — `{token, expiresAt}`, idempotent on the session | 2 |
| `DELETE /v1/gym/sessions/{id}/share` | revoke it — `204`; nothing to revoke is `404 no such session` | 2 |
| `GET  /v1/gym/shared/{token}` | **the one unauthenticated route.** One session and its sets; revoked, expired and unknown are one `404` | 2 |
| `GET  /v1/gym/export/threads` | every turn of every conversation, CSV — one row per turn, the thread's title and outcome beside each. The same deliberately dull file: no parameters, nothing omitted (§12.6) | 11 |
| `GET  /v1/gym/threads` | **Ask's threads** (§12.6) — `{threads:[{id,title,createdAt,askedAt,outcome,proposals}]}`, newest asked first, bounded at `kThreadList` (200) with no total and no "there are more" flag — a count the server sends is a number to compare against, which is halfway to the badge §O forbids, so a client may print `N conversations` only while it holds fewer rows than the ceiling. No turns: a list prints titles. **Mounted unconditionally**, unlike the ask below — a conversation is the lifter's data, not a feature of the model | 11 |
| `GET  /v1/gym/threads/{id}` | one conversation whole, `turns` and all. Absent and another account's are one `404` | 11 |
| `DELETE /v1/gym/threads/{id}` | **delete deletes the conversation, not the consequence.** `204`; the turns cascade, and every proposal it minted keeps its row, its state and its place in the routine's history — losing only `source.thread` | 11 |
| `POST /v1/gym/ask` | **the one conditional route.** Ask (§12) — `{thread:"thr_…", question:"…"}` in, `{answer, steps, read:{sets,sessions,weeks}, proposals:[id], thread}` out. **Since W11 the client sends ONE question into one thread, never a history** (§12.6). It hangs off the PRODUCT and not a session, because Ask reads the log. `400` for a malformed thread id, or a question that is blank, oversized, or not text the store can hold (a NUL or non-UTF-8 — `storableText`, §3.1), `409 ask-thread-taken` for an id another account holds (including the concurrent-mint race, where the store comes back with neither a thread nor a named error), `409 ask-thread-full`, `409 ask-session-open` mid-workout, `429 ask-daily-limit` / `ask-out-of-budget`, `502` when the model does not answer. Absent entirely on a deployment with no `ANTHROPIC_API_KEY` | 3 |

### The MCP tool catalog (`adapters/mcp/GymToolCatalog`, dispatched by `adapters/mcp/GymTools`)

Sixteen tools against roadmap's twenty-seven, and the smallness is the design: `tools/list` is the
biggest fixed cost of a connection, so a tool a parameter on another tool could serve does not get a
slot — which is why the pending proposal rides on `list_routines` instead of a `list_proposals` and a
`get_proposal` of its own. The **level is declared beside the description**, in the same
`ToolDeclaration` the gate reads, so a tool cannot be described as one thing and gated as another.
Seven reads is the shape this product wants: an agent here reads one lifter's log and occasionally
writes into it, and the verbs reserved for the HAND have no tool at any level — editing a logged set,
saying what a gym owns, and **applying a proposal**.

| `gym:read` | `gym:write` | `gym:delete` |
|---|---|---|
| `list_exercises` — the catalog | `start_session` — open a workout | `discard_session` |
| `list_sessions` — the log, paged | `log_set` — one set into an open workout | `propose_routine_removal` — **deletes nothing** |
| `get_session` — one workout + its sets (`review: true` adds the finish readout) | `finish_session` | `revoke_share` |
| `last_time` — the prefill | `create_routine` — a NEW day; **lands immediately** | |
| `list_routines` — all, or one by `routineId`; carries `pendingProposal` | `propose_routine_change` — **changes nothing** | |
| `get_stats` — all movements, or one by `exerciseId` | `create_exercise` | |
| | `share_session` — `{url, token, expiresAt}` | |

**W6 broke this contract on purpose, on 2026-08-12.** `save_routine` and `delete_routine` are gone at
every level. The three names above carry §0's record/intent split so an agent author reads it off the
catalog rather than out of this document: a day of the program that does not exist yet is `fresh` and
`create_routine` writes it; a day that already stands is `existing` and the two `propose_` tools mint
a diff and write nothing. **The receipt is never shaped like a write** — it carries the proposal, its
`state`, the typed diff and a `reviewUrl`, and no routine at all, so an agent that reads it cannot
tell its human the program changed. That is the one defect this wave could not afford: a well-behaved
agent turned into a liar. **The retirement answers name their replacements** rather than reading
"this connection was not granted gym:write", which would be false — the level was granted, the tool
was retired. The sentences live in `GymTools::retiredTools()` — the `ToolHost` seam landed 2026-08-15 —
and the hosts above answer them: `CompositeToolHost` over MCP, `AskTools` in-process, each consulting
the retirements only after a name misses the live catalog. `gymInstructions()` carries the same
retirement in the handshake every client reads at connect, so an agent written against the old two
learns it before its first call.

**No apply tool at any grant level, and that is a product rule rather than an economy.** Apply is not
a capability, it is a human act: `gym:delete` proposes destructive changes and does not imply the
right to make one. The two routes that settle a proposal are HTTP and owner-scoped (`routes.cpp` says
it beside the mounts), `ProgramService::replaceRoutine` is the human's other hand and is unreachable from
`GymTools`, and `GymToolsTest` pins every one of those absences by name.

Six rules hold this together, and each is load-bearing:

- **Every tool goes through a service, never the repository** — `TrainingService` for the log,
  `CatalogService` for the movements, `ProgramService` for the plan; no tool reads a thread or the
  settings, so `GymTools` holds three of the five. The services own the two-phase
  load → rule → persist shape, the lazy auto-close and the write-then-resolve idempotency; a tool
  reaching past them would be a second copy of rules that exist once. The tools are therefore a second
  *door on the same core*, not a second client of the HTTP API.
- **Every tool acts as the caller.** The `ToolCaller`'s `UserId` is what every read and write is
  scoped by, exactly as `callerOf(req, auth)` scopes the handlers — absent, another account's and
  never-existed stay one answer, and an agent is never an admin.
- **The refusals are the HTTP ones in words a model can act on.** Each names the tool that answers
  the question it should ask next (`no workout of yours has that id. Call list_sessions…`), because a
  model cannot read a doc between two calls. The domain's own `InvalidTraining` sentence is forwarded
  **verbatim** here, where the browser edge flattens every one of them into `could not read that set`.
- **Client-minted ids, said out loud in the description.** `start_session`, `log_set`,
  `create_routine`, `propose_routine_change`, `propose_routine_removal` and `create_exercise` all
  take the id the caller mints, and each description says a replay answers with the stored row — without that sentence a model invents a fresh id per retry and
  mints duplicates, which is exactly what §2.1 exists to prevent. **A replay is the same id carrying
  the SAME document.** The two document-carrying tools refuse a spent id carrying a different one —
  `create_routine` points at the proposal door, `propose_routine_change` says nothing was minted —
  because replaying a caller's second idea with their first, under `[ok]`, is the receipt that turns
  a well-behaved agent into a liar (§2.9).
- **A read's own fields survive the write that takes them back.** Duplicating a day is reading one
  with `list_routines` and sending it back under a fresh id, so every field the read PUTS ON a
  routine — `position` on a line, `lastTrainedAt`, `revision`, `pendingProposal` — is declared on
  `create_routine` and ignored. `additionalProperties: false` is enforced by `CompositeToolHost`, and
  strictness that refuses a typo AND the document we ourselves emitted is not strictness, it is an
  outage: `lastTrainedAt` is on that list because it already caused one.
- **`delete` is never merged into `write`.** Two tools may merge where a parameter does the job
  (`list_routines`, `get_stats`) but never across levels, and no read is reachable through a
  write-classified name.

**`GET /v1/gym/export` deliberately has no tool.** A CSV is a file for a person to open, and an
agent holding `list_sessions` + `get_session` + `get_stats` already has every one of those numbers in
a shape it can read — an export tool that answered with a wall of comma-separated text would spend
a `tools/list` slot and a context window to say what three tools already say.

**`PATCH` and `DELETE` on a set have no tool either, and that one is a product rule rather than an
economy.** *No agent may edit or delete a logged set — not under `gym:write`, not under
`gym:delete`, not at any level a future grant invents.* This is §L's safeguard ladder made
structural: the tool layer is the only place gym can tell an agent from a hand, and rewriting what
somebody lifted is the one verb reserved for the hand. §L's screen 27 draws the refusal in Ask's own
words — *"That one is yours to change. I can read what you lifted; I can't edit it."* — and that
sentence is only honest while this row stays empty. The reason is written beside the two mounts in
`routes.cpp` so a later wave does not "complete the catalog", and `GymToolsTest` pins the absence by
name so it cannot be added by accident.

The grant itself is the platform's: `CompositeToolHost` filters `tools/list` by scope, refuses an
out-of-scope call naming the missing `gym:<level>`, refuses an argument no schema declares, and
refuses a duplicate tool name **at boot** — so a gym tool colliding with a roadmap one takes the
server down at start-up rather than answering at random (`GymToolsTest` pins the two catalogs
against each other).

Wire shapes live in `adapters/json/TrainingJson` (the one cross-surface codec — web, iOS, Android
and the MCP tools all speak it, which is why a tool's arguments are the REST body's field names) with
one exception: the export speaks CSV, and its framing is `adapters/csv/TrainingCsv`'s alone (§5).
Instants are epoch-ms numbers, weights are
numbers in kg, sets serialize as
`{id, exerciseId, setNumber, weightKg, reps, kind, rpe?, note, completedAt}`, sessions as
`{id, startedAt, finishedAt?, routineId?, plan?}`, routines as
`{id, name, position, revision, lastTrainedAt?, entries:[{position, exerciseId, targetSets?,
targetReps?, targetWeightKg?, restSeconds?}], pendingProposal?, history?}`; list replies wrap
(`{"exercises":[…]}`, `{"sessions":[…]}`, `{"routines":[…]}`, `{"proposals":[…]}`, detail
`{"session":…, "sets":[…]}`). A proposal's head is
`{id, routineId, intent, state, summary, changeCount, createdAt, settledAt?,
source:{door, connection?, agent?}}` and the whole thing adds
`{baseRevision, baseName, name, changes:[{position, kind, exerciseId, before?, after?,
loggedSets?}]}`, where each side is `{sets, reps?, weightKg?, restSeconds?}` — `before` absent on an
added line, `after` on a removed one, and `loggedSets` on removed lines alone. `changeCount` is what
`Apply all N` prints: the rows that move, plus one for a rename, plus one for a reordered run.
`revision` is read-only on the wire: the store is what moves it. A log row is a session plus
`{setCount, workingSetCount, tonnageKg, exercises:[…], topSet?: {weightKg, reps}, topE1rm?,
record, closedItself}` — `record` always present, never omitted. Parsing type-checks every jsoncpp
field before `.as*()` and throws
`InvalidTraining` → 400.

**An absent `targetReps` is `max`, not a missing value.** It is omitted on the way in and omitted on
the way out — on the routine entry, on the frozen plan's line, and on the review's `planned` — under
the same rule every other optional here obeys, and every surface draws it as `3 × max` (§2.4). **An
absent `targetSets` is `open`** and travels exactly the same way, on the same three shapes plus a
proposal's two sides; on a diff row, which SIDE is missing is `kind`'s to say and never a null
`sets`.

**An absent `lastTrainedAt` is `untested`** (§M30) — the routine has never been trained. There is no
field beside it saying so: the absence already does, and a stored flag would still read `untested`
the day a lifter trained the day, or still read tested the day they discarded the only session that
ever ran it.

**`history` rides on the single-routine read alone**, never on the list: it is one section of one
screen, and a routines screen prints names. Its rows are
`{kind:"created", at, by?, movements?}` and `{kind:"proposal", at, proposal}` — one list, both kinds
of thing that happen to a day of the program, newest first with the creation row last. `by` is
absent when the day was the lifter's own hand, which is what a surface draws as *created by you*;
`create_routine` over MCP is a real door onto that table, so the field exists rather than the screen
assuming. `movements` is how many lines the day was created with, absent for a day made before the
ledger recorded it.

The review is the one shape that travels **one way** and so has no parse half — every number in it
is computed from stored rows on each read, and there is nothing for a client to send back:

```json
{ "stats":  { "durationMs": 3720000, "workingSets": 16, "topE1rm": 122.5 },
  "slight": false,
  "record": { "kind": "e1rm", "exerciseId": "back-squat", "value": 122.5,
              "weightKg": 105, "reps": 5, "previous": 116.7, "previousAt": 1750723200000 },
  "against": { "sessionId": "ses_…", "routine": "Legs", "startedAt": 1750723200000,
               "movements": [ { "exerciseId": "back-squat",
                                "now":     { "weightKg": 105, "reps": 5, "sets": 5 },
                                "before":  { "weightKg": 102.5, "reps": 5, "sets": 5 },
                                "planned": { "sets": 3, "reps": 12, "weightKg": 140 } } ] } }
```

Its **absences are the shape**: `topE1rm` when nothing in the session was loaded, `record` on the
~190 sessions in 200 that earn none, `before` when that movement was not trained last time,
`planned` when the frozen plan did not name it, `against` for an ad-hoc session or one with no
earlier match, and `routine` when the session it stands against carries no name. `slight` says the
session was too short to say anything honest, and then `record` and `against` are both omitted.
`planned` carries the target only — rest is the device-local timer's business, not the finish
screen's — and its own `reps` is omitted when the plan's line named none, which is `max` there as
everywhere else.

**A routine's entry order IS the routine's order.** Entries in carry no position; the codec numbers
them `1..n` from the order they arrived in, and entries out carry the number so a client can print
it. A per-entry id would be a second identity to keep in step with the store's `(routine_id,
position)` key. On `PUT` the **path** names the routine — a read-modify-write sends back the id it
read, so the two always agree, and where they could not the URL is what the store was asked for.

The prefill reply is the one read whose *absence* is part of the shape:

```json
{ "exerciseId": "bench-press",
  "session":  { "id": "ses_…", "startedAt": …, "finishedAt": … },
  "routine":  "Bench day",
  "sets":     [ { … }, { … } ] }
```

The movement is echoed because the client re-reads this on every movement change, and a reply that
lands after the lifter has moved on has to be discardable. `routine` is omitted when that session
was ad-hoc, and `session`/`sets` are omitted together for a first-ever movement — **200 naming the
movement and nothing else**. That absence is a fact, not a fault, and it is what the card draws
"First time logging this" from; a 404 would say the movement does not exist, which is a different
and false thing. `sets` is never present and empty: the session is chosen *by* holding one.

The statistics reply travels one way too, and its absences are the shape: no `e1rm` on a point or a
best means that load has no honest one-rep estimate (a chin-up, a band-assisted pull-up), and an
absent `bestE1rm` means no set of that movement ever had one. `weeks` is contiguous, so a zero week
is a zero and never a missing row.

```json
{ "weeks": [ { "startedAt": 1699833600000, "sessions": 4, "workingSets": 61 } ],
  "movements": [ { "exerciseId": "back-squat", "lastTrainedAt": 1700000000000,
                   "points":   [ { "at": 1700000000000, "weightKg": 105, "reps": 5,
                                   "e1rm": 122.5 } ],
                   "bestE1rm": { "weightKg": 105, "reps": 5, "at": 1700000000000, "e1rm": 122.5 },
                   "heaviest": { "weightKg": 110, "reps": 2, "at": 1700000000000,
                                 "e1rm": 117.3 } } ] }
```

The share's read is the one shape in the product built to name **less** than the session it is
about — every id it could have carried is absent by construction, not by omission (§5):

```json
{ "startedAt": 1700000000000, "finishedAt": 1700003600000, "routine": "Legs",
  "sets": [ { "exercise": "Back Squat", "setNumber": 1, "weightKg": 105, "reps": 5,
              "kind": "working", "note": "", "completedAt": 1700000060000 } ] }
```

**Instants are bounded at the wire, all three the same way.** `startedAt`, `completedAt` and
`finishedAt` go through one rule in the codec: a UInt64, never `0` (an unset device clock is
not a moment), never past `kMaxInstantMs` = `253402300799000` (9999-12-31T23:59:59Z, the
furthest a `timestamptz` holds). `finishedAt` was once the one instant nothing checked, and a
single `{"finishedAt":0}` closed a 2026 workout in 1970 — permanently, because `close` is
first-writer-wins. The ceiling is what keeps a nanosecond stamp or a `UInt64.max` sentinel from
reaching `to_timestamp()` and overflowing mid-transaction. The same constant is the log
cursor's "no cursor: from now".

**The status ladder.** The status alone is not enough for the flush queue to act on: of the 409s,
three mean *mint a new id and send it again*, one means *drop this set forever*, and two mean
*a new id will not help — wait for the open workout to end*. So every refusal a client must branch
on carries a machine word under `code` beside the human sentence:

| Status | `code` | When | Sentence | What the client does |
|---|---|---|---|---|
| 401 | — | no caller | `sign in to open your training log` | sign in, then replay the write |
| 404 | — | the session is absent **or** another account's — one fact, not two | `no such session` | terminal — drop it |
| 404 | — | the routine is absent **or** another account's — read, replace, delete, or a start that is *creating* a session under it (§3.3: never a replay, never a join) | `no such routine` | terminal — re-read `GET /v1/gym/routines` |
| 400 | — | the request is unreadable or unstorable *as written*: bad json, bad field type, a malformed id, an instant outside the bounds above | `could not read that session` / `… that set` / `… that finish` / `… that routine` / `… that movement` | terminal — retrying never makes a body readable |
| 400 | `unknown-exercise` | a set, a routine entry, or the prefill read names a movement **this account's** catalog does not hold — a slug nobody has, and another lifter's private movement alike (§3.3's visibility predicate; the FK is only a backstop) | `no such exercise` | terminal — the movement has to be resolved against `GET /v1/gym/exercises` first |
| 400 | — | the prefill read names no movement at all | `bad exercise` | terminal, and a read-path fault — never the queue's |
| 400 | — | the close instant runs backwards against the stored start | `a session cannot finish before it began` | terminal — send an instant the session could have ended at |
| 400 | — | the log cursor is not a digits-only instant plus, optionally, a well-formed id beside it | `bad cursor` | terminal, and a read-path fault — never the queue's |
| 409 | `session-id-taken` | start with a session id spent by an account this caller cannot see — never the caller's own, which replays | `that session id is taken` | mint a NEW session id and start again |
| 409 | `session-already-open` | start that said `joinOpenSession: false` while another of this lifter's sessions is open | `another session is already open` | terminal until the open workout ends — a new id changes nothing; finish it (or let the four-hour auto-close fire) and send the same body again |
| 400 | `clock-ahead` | a start that would CREATE a session more than five minutes past the log's now (§3.2, `canStartAt`); replays and joins are exempt | `this device's clock is N minutes ahead of the log — a workout cannot start in the future…` | terminal for that body — the fix is the clock, not a retry; the phones compose the workout on the device and claim it once the instant is past |
| 409 | `routine-stale` | a routine PUT that NAMED the revision it read, over a day that moved since, and whose bytes would move it (a replay whose bytes already stand reads back what landed) | `that routine changed since you read it — reload it and save again` | re-read the routine and save again; a PUT naming no revision never earns this |
| 503 | `ask-not-configured` | `POST /v1/gym/ask` on a deployment with no model (the route is normally not mounted at all) | `Ask isn't available right now` | terminal — Ask is absent here; a 503 WITHOUT this code is a proxy or a restart, and asking again is the repair |
| 409 | `set-id-taken` | append a NEW set id already spent by a row outside this session | `that set id is already used` | mint a NEW set id and send the same set again |
| 409 | `set-deleted` | append an id that names a set **this account deleted** — a replay of the POST that logged it, from a queue whose 200 was lost or from a claim | `that set was deleted` | terminal — drop the set. **Never the re-mint above:** a fresh id is exactly how the deletion would undo itself |
| 409 | `session-finished` | append a NEW set to a session already finished — after the lifter's own finish, or more than four hours past a stale close's last landed set (a set continuing a stale close lands, §3.2) | `that session is finished` | terminal — this set will never land here |
| 409 | `routine-id-taken` | create a routine under an id another account holds | `that routine id is taken` | mint a NEW routine id and send the same document again |
| 409 | `exercise-id-taken` | create a movement under a seeded slug or another account's id — never the caller's **own**, which answers 200 with the movement already stored under it (§2.1: a 409 there forces a re-mint, and the re-mint is a second "Zercher Squat" every later set forks history across) | `that movement id is taken` | mint a NEW movement id and send it again |
| 409 | `session-open` | discard a session that is still running | `that session is still running` | terminal until the workout ends — no id to re-mint and no body to fix; finish it (or let the four-hour auto-close fire) and send the same delete again |
| 404 | — | the proposal is absent **or** another account's — one fact, not two | `no such proposal` | terminal — re-read `GET /v1/gym/proposals` |
| 409 | `proposal-superseded` | apply or dismiss a proposal whose routine moved after the diff was written | `that routine changed after this proposal was written…` | terminal — the card is settled; draw the routine as it now stands |
| 409 | `proposal-settled` | ask for one decision on a proposal that already took the OTHER one | `that proposal was already applied` / `…already dismissed` | terminal — the screen is stale; re-read the proposal. Asking for the decision it DID take is not a refusal: it replays 200 |
| 500 | — | a storage failure — a dropped connection, a statement timeout, a deadlock | `internal error` (the house handler) | retryable — keep the set queued |

**The code is the contract; the sentence is for a human reading a log.** The wording is copy and may
be edited any day; a client that told the 409s apart by string-comparing it degrades to
"terminal, reason unknown" the first time one is reworded — and drops a set it should have re-minted
an id for. `set-id-taken` and `set-deleted` are the sharpest case: same status, same shape, opposite
repairs, and telling them apart by prose would put a deleted set back in the log. Only those refusals
carry a code, on purpose (`platform/adapters/http/JsonReply.h`):
most refusals have exactly one cause and the sentence is the whole of it, and a key that is
sometimes an empty string would make a client test it twice.

Every `…-id-taken` names a fact about an id, never about an owner: a caller learns that an id is
spent and nothing else, so absent stays byte-identical to forbidden. They are the honest answer
where the edge used to fabricate a 200 — a start that returned a session the store never accepted
(every set into it then 404'd forever), and an append that returned the *stranger's* row sitting
under the colliding id. And none of them fires on the caller's **own** id: a replayed create of a
session, a set, a routine or a movement reads back what landed, because a 409 on a lost reply is a
duplicate document, not a repair. `session-already-open` names a different kind of fact, one about
the caller's own log: only this account's open session can produce it, so it leaks nothing either —
and it is the same family of honesty, a refusal where the edge used to answer 200 with a session the
caller never asked for.

`409 that session is finished` answers **new** ids only. A set that already landed replays 200
with its stored row even after the session closes — the flush queue's whole premise is replay,
converging on one row per minted id (oldest-first into a stale close, §3.3), and a queue told 409
for a set it had already delivered would drop it and count the loss as intended.

**The discard is the one destructive action in the product, and its one refusal is the only thing
the store cannot state for itself.** `DELETE /v1/gym/sessions/{id}` takes the session and its sets
together (`on delete cascade`) and answers `204` with no body — there is nothing left to describe —
and a second delete is `404`, the same fact as never having been there. A session that is still
running is refused `409 session-open`: only the device holding the offline queue knows every set has
landed, so deleting a workout somebody is still logging into destroys sets in flight. The product
offers the door at the finish screen, *after* the close, where the refusal is unreachable. There is
no soft delete and no recovery window — nothing in this wave writes one, so no surface may promise
one.

`unknown-exercise` is the one refusal that crosses from the writes to a read, deliberately: telling
a caller that names a movement no catalog holds "you have never trained this" is a small lie that
hides a real client fault — a stale id after a phase-2 merge, a typo in a hand-written tool call —
behind the very pixels a first-ever movement draws. The prefill read consults the catalog **only
when it has no history to return**, so the answered path costs two statements and never three.

The 400s are the client's, and terminal: retrying an unreadable body never makes it readable.
The 500 is the server's, and retryable — which is why the write handlers catch **only**
`InvalidTraining`, one catch, one meaning, and no vendor type among them. A
`catch (const std::exception&)` around the same call told a queue that a five-second lock wait was
a malformed set, and the lifter's set would have been dropped forever. There are no admin doors,
nothing sweeps and nothing mails. There is exactly **one** uncredentialed door —
`GET /v1/gym/shared/{token}`, where the token in the path is the whole credential — and it reads
one row of one table the owner minted on purpose (§2.6), writes nothing, and answers the same 404
for a token that is revoked, expired or never existed.

**The log cursor carries both halves of the sort key.** The page order is `(startedAt, id)`
descending, and only the pair is unique, so the cursor is the previous page's last row in full:
`before=<epoch-ms>` and `beforeId=<that row's id>`. `before` is digits-only and clamps at
`kMaxInstantMs`; `beforeId` obeys the one id-shape rule and is refused without a `before` beside
it — an id with no instant names no row. Anything else is `400 bad cursor`. A first page passes
neither. On a bare instant cursor, two workouts that started in the same millisecond straddling
a page edge lost one of the pair to every paged read, silently, forever; `limit` defaults to 50
and caps at 200.

Telemetry: activation (`≥2 sessions of ≥5 sets within 7 days of the first set`) is instrumented
from the first `set-logger` commit via the existing web beacon — a product event on session
finish, never retrofitted.

---

## 7. Composition & wiring

The full cost of mounting the third product, itemized against the actual seams:

- **CMake:** `add_library(windmill_gym products/gym/domain/Training.cpp
  products/gym/domain/Preferences.cpp products/gym/domain/Routine.cpp products/gym/domain/Review.cpp
  products/gym/domain/Statistics.cpp` + the five `products/gym/application/*Service.cpp`)` linking
  `windmill_platform PUBLIC` — plus `products/gym/domain/Record.cpp` — after the journal block; adapters + `routes.cpp` folded in via `target_sources` under the existing
  `Drogon_FOUND AND libpqxx_FOUND` guard; `windmill_gym` added to the four
  `target_link_libraries` lines (domain tests, server, adapters tests, and — since the tool
  catalog — the mcp tests). Tests are **appended to the existing executables** — a new test binary
  means editing the Dockerfile's `--target` list, so there isn't one.
- **Dockerfile:** untouched. `windmill_server` statically absorbs the new lib; `schema.sql`
  already rides at `/app/db/schema.sql`.
- **main.cpp:** nine lines, plus one entry in the account-footprint list. The core is built **up
  with the MCP surface** rather than beside the routes, because the composite host is constructed
  once before the server takes traffic and gym's tools have to be in it; the mount stays down with
  the other two products' —

  ```cpp
  auto gymLog = std::make_shared<gym::PgLogRepository>(pool);
  auto gymCatalog = std::make_shared<gym::PgCatalogRepository>(pool);
  auto gymProgram = std::make_shared<gym::PgProgramRepository>(pool);
  auto gymThreads = std::make_shared<gym::PgAskThreadRepository>(pool);
  auto gymPreferences = std::make_shared<gym::PgPreferencesRepository>(pool);
  auto gymTrainingService =
      std::make_shared<gym::TrainingService>(*gymLog, *gymProgram, *systemClock, *tokens);
  auto gymCatalogService = std::make_shared<gym::CatalogService>(*gymCatalog);
  auto gymProgramService = std::make_shared<gym::ProgramService>(*gymProgram, *systemClock);
  auto gymThreadService = std::make_shared<gym::ThreadService>(*gymThreads, *systemClock);
  auto gymPreferencesService = std::make_shared<gym::PreferencesService>(*gymPreferences);
  auto gymTools = std::make_shared<gym::GymTools>(*gymTrainingService, *gymCatalogService,
                                                  *gymProgramService, appBaseUrl);
  const std::vector<ToolModule> mcpModules{{*mcpTools, roadmapInstructions()},
                                           {*gymTools, gym::gymInstructions()}};
  …
  gym::GymDeps gymDeps{.trainingService = gymTrainingService, .catalogService = gymCatalogService,
                       .programService = gymProgramService,
                       .preferencesService = gymPreferencesService,
                       .threadService = gymThreadService, .authService = authService,
                       .askService = gymAsk, .appBaseUrl = appBaseUrl};
  gym::registerRoutes(app, gymDeps);
  ```

  One core, two doors: the tools and the routes hold the *same* services, so a rule can
  never be true on one surface and not the other. `appBaseUrl` is there for one thing — a minted
  coach share is a token, and only gym knows the route that turns it into a URL. Tending is
  deliberately NOT given the composite (it keeps roadmap's host directly), so a prompt-injection-
  exposed agent cannot reach a training log. Still no env vars, no arming flags, no sweeps and no
  vendor keys, and gym contributes nothing to the mail list. `*tokens` is the one
  collaborator gym did not have at phase 0 and it is here for exactly one thing — minting a coach
  share's secret, from the same mint that makes a session cookie, so the one unguessable string gym
  hands out is the platform's and not gym's own. `{"gym_session_shares", "user_id"}` joins
  `gym_sessions`/`gym_sets`/`gym_routines` in `PgAccountFootprint`'s owned list: a live coach link
  is data, and an account holding one is not empty. So do `{"gym_exercises", "created_by"}`,
  `{"gym_exercise_names", "user_id"}` and `{"gym_exercise_aliases", "user_id"}` — a movement someone
  created or renamed is their data, and what they called it before that is the same fact one step
  back; a
  lifter holding only one of those was reported empty until 2026-08-12, which is an account the
  link door had proved deletable. The column there is `created_by` and **not** `user_id` precisely
  because the 64 seeds carry it NULL: a probe that matched the seeds would report every account on
  the server non-empty and break the same door the other way round. `gym_preferences` is the one gym
  table deliberately LEFT OFF that list (§2.8): the list is about what an account holds, and settings
  are how a room is set up rather than the artifact in it.
- **Schema:** the `-- ── Gym (products/gym) ──` section + the 64-row seed, appended at EOF,
  idempotent end-to-end (`create … if not exists`, seed `ON CONFLICT (id) DO NOTHING` so a
  redeploy never clobbers a renamed display name). A column that has to *change* gets its own
  statement beside its table, phrased so re-running is a no-op — `alter … drop not null` /
  `drop default` on `gym_routine_entries.target_reps` — because the run is re-applied on every
  deploy and there is no migration ledger to carry the change instead. The bar for such a line is
  that a database created before it and one created after it end up identically shaped.
- **Tests:** `test/products/gym/{Fakes.h, domain/TrainingTest.cpp, domain/PreferencesTest.cpp,
  domain/RoutineTest.cpp,
  domain/ReviewTest.cpp, domain/StatisticsTest.cpp, domain/RecordTest.cpp,
  application/{GymServiceFixture.h, TrainingServiceTest.cpp, CatalogServiceTest.cpp,
  ProgramServiceTest.cpp, ThreadServiceTest.cpp},
  adapters/http/{GymApiFixture.h, TrainingApiTest.cpp, CatalogApiTest.cpp, ProgramApiTest.cpp,
  PreferencesApiTest.cpp, ThreadsApiTest.cpp}, adapters/mcp/GymToolsTest.cpp,
  adapters/postgres/{PgGymFixture.h, PgLogRepositoryTest.cpp, PgCatalogRepositoryTest.cpp,
  PgProgramRepositoryTest.cpp, PgAskThreadRepositoryTest.cpp, PgPreferencesRepositoryTest.cpp}}`
  mirroring the tree, full assertions —
  `GymToolsTest` rides in `windmill_mcp_tests` beside roadmap's, the other three in the domain and
  adapters binaries. Its high-value targets are the ones only this surface has: the whole
  (tool → level) table pinned in order, `tools/list` shrinking to exactly what a grant named, a
  stranger refused by the same one fact an absent row gets, a replayed client-minted id answering
  with the stored row, and every refusal sentence pinned whole (they are the product here — a
  reworded one is a model that no longer knows what to do next). The
  high-value pure targets: every `autoCloseAt` branch, `Set` construction bounds (negative
  weight legal, reps 0 illegal, unknown kind thrown), `Exercise` bounds (both ends of the step
  band, the name ceiling), `Routine` construction bounds (positions `1..n`, the same movement
  twice, the eighty-character name, the fifty-line document, the line naming no rep target),
  start-idempotency (replay, double-tap two-id join, stale auto-close on start, the join that keeps
  the open session's own plan, and the replay and join that outlive a deleted routine),
  append numbering (max+1 after a gap, replay returns the stored row byte-for-byte),
  strict-parse/clamped-read of `SetKind`, and the plan snapshot's round trip. Pg mapper
  rows are `template <typename Row>` (the pqxx `row_ref`/`row` mac-vs-CI split); a green
  local build is not green CI — watch `gh run` after the backend push, then probe prod.

**Web seam (phase 0's other half, for the record here):** `web/src/products/gym/` replaces
`ComingSoon` with the module shell — sub-route parsing off `#/gym`, `gymApi.js` owning the
whole backend conversation (`credentials: 'include'`, one typed `GymError`, 404→null on
singular reads), `gym.css` scoped under `.gym-root`, and `landingAfterSignIn` on the route
table (today a lifter signing in from gym lands on the skill tree — the `PRODUCTS[0]`
fallback). The shell `status` was `'pre-open'` through phases 0–1 and flipped to `'open'` on
2026-08-08 — `gym-landing`'s move, not the seam's. `#/gym` now upgrades in place into `/app/gym`,
with the coach's `#/gym/shared/<token>` link held outside the room chrome by the route table's
`bare` predicate. The phase-1 dogfood gate has still never run.

---

## 8. What gym does not build — and the two bets it waits on

| Absent | Why |
|---|---|
| Sweeps, heartbeats, mail | Nothing in phase 0–2 fires on a clock. `gym-nudge` (phase 3) must not be a copy of the reminder skeleton — the platform primitives exist now. `platform/application/Heartbeat.h` (since 2026-08-05) is the ticker thread with the crash guard, run from construction so an operator pass can be queued onto a heartbeat nobody armed; `platform/application/MailSweep.h` (since 2026-08-15) is the DECIDE → CLAIM → SEND mail pass with the `SweepMutex` lock, the `MailArming` gate and the per-user guard, which roadmap's `ReminderSweep` and journal's `NudgeSweep` derive from (journal's `EchoSweep` beats but does not mail, so it takes the heartbeat alone). A gym mail stream is a `MailSweep` subclass plus a `Heartbeat` member, and nothing else. |
| ~~MCP tools~~ | **Built 2026-08-07 — this row is history, kept because the bet was recorded here.** The platform scoped-composite ToolHost shipped (`McpServer` binds a `CompositeToolHost`, each product registers a `ToolModule`, and a grant of `product:read` / `:write` / `:delete` — none implying another — selects what a connection sees and may call), and gym's own `ToolHost` landed the same day: fifteen tools in `adapters/mcp/`, registered in `main.cpp` beside roadmap's. W4 added `get_preferences` and 2026-08-13 retired it with no replacement — a vague name agents reached for at the top of any turn, answering with an equipment inventory the product stopped keeping (§2.8). The surface is §6. |
| Billing, plans, gates | The log is free — that is a product decision, not a blocked one. The old blocker is gone: the brand-wide gate left roadmap's settings folder in `97e1f1b` and is now `paidPlansOpen()` in `web/src/shell/billing/checkout.js`, which gym may import like any other shell module. What a gym money surface would still have to solve is the tier *copy* (`PLAN_COPY`), which stayed behind in roadmap. |
| ~~Units preference~~ | **Built 2026-08-12 (W4) — this row is history, kept because the bet was recorded here.** What it warned against is still refused and is now structural: there is no lb ladder, no lb column and no conversion anywhere. `gym_preferences.units` records the unit a lifter READS in and reaches no write and no read that computes anything (§2.8); canonical kg (§9.4) is untouched. |
| Cardio, duration, bodyweight-only, supersets, streaks, muscle-group volume | Cut in the plan, recorded there with reasons; the schema deliberately reserves nothing for them — a duration axis is a different product, and reserving speculative columns is how schemas rot. |
| Plate math, computed here | **The cut is now total, and it went the other way round than expected.** W4 brought half of it back — the store held what a gym owned and three surfaces decomposed a load into plates, pinned by a golden (§11.5) — and on 2026-08-13 the whole feature was removed instead: no inventory, no readout, no golden, no columns (§2.8). Gyms are more or less the same, and this product guides a program rather than managing equipment. No C++ ever decomposed a load, which is the one part of the original cut that was never revisited. |

---

## 9. Open decisions — taken

1. **Exercise identity** — text slug PK, seeded 64, display name mutable, `created_by` marks a
   movement its owner created; merge is an UPDATE, import folds names onto ids. (§2.1, §4)
2. **Session snapshot** — a frozen jsonb copy on the session row, composed by the server from its
   own routine at start and typed as `PlanSnapshot` in C++; routines stay relational; `routine_id`
   informational with `on delete set null`. (§2.2, §2.4, §2.5)
3. **Set kinds** — four kinds + rpe + note stored from day one, UI phase 2; strict parse on
   write, clamp on read. The first aggregating bet has now arrived and taken the semantics with it:
   **working sets only**, and a warmup, a drop and a failure count toward nothing — not the set
   count, not the top e1RM, not any of the three records. (§2.3, §3.1)
4. **Canonical units** — kg only, `numeric` at rest, numbers on the wire, negatives legal
   from −500 to 500. (§2.3)
5. **Idempotency** — the client-minted id *is* the key, everywhere (sessions, sets, routines,
   created movements); `ON CONFLICT DO NOTHING` + an owner-scoped read-back is the whole retry
   story, so a replay reads back what landed and only another account's id is a conflict; one open
   session per user is a partial unique index, not a guard flag. (§2.2, §3.3, §4)
6. **Auto-close** — a pure domain rule (4 h, closes at last activity), applied lazily on start and
   on every read whose answer a close rewrites — the log page, one session's detail, the open-session
   read, the statistics, a movement's record; no cron. The export settles nothing (it hands back every
   set whatever `finished_at` says) and neither does the share's unauthenticated read (a stranger
   holding a link must not write to the owner's log). (§3.2, §5)
7. **Namespacing** — `wm::gym` for everything; `gym::Set` at call sites, `Set` inside. (§1)
8. **No billing code in gym, still — and `gym-mcp` is no longer what it waits on.** Both halves of
   that bet landed 2026-08-07: the platform's scoped ToolHost, then gym's own catalog on top of it.
   The log is free and the *connected* log is Windmill One, so what is left is a money surface —
   a plan gate read through `Entitlements` and the tier copy that stayed behind in roadmap — and it
   is a product decision now, blocked by nothing. Gym still holds no plan enum and gates nothing.
   (§0, §6, §8)
9. **The coach share is a table, not a column.** §0's refusal is narrowed rather than dropped: there
   is still no `visibility` on `gym_sessions` and not one of the owner-scoped routes that predate it
   changed, so *absent is byte-identical to forbidden* stays a structural property of every one of
   them. The second reader arrives through `gym_session_shares` and one unauthenticated route, and
   sharing is therefore unreachable by accident — no existing query names that table. Per session,
   never per account; expiring (30 days, `shareExpiryAt`) and revocable by deleting the row;
   server-minted token, stored in the clear because the mint must be idempotent; the reply names no
   account and holds no id. Journal's §0.1 is no longer inherited *whole* — journal still has no
   share entity, gym now has one. (§0, §2.6, §5)
10. **The statistics engine answers only over values the domain already decides — and it is an
    engine, not a room.** The 2026-08-12 wave retired the statistics *surface* on web, iOS and
    Android (there is no fourth tab and no dashboard in this product) and put a movement's record in
    its place. Nothing was removed on this side: `GET /v1/gym/stats` and `get_stats` stay, because
    the long view is exactly what an agent reads. The series is
    `TopSet`'s rule, the estimate is Epley from `domain/Review.h`, the records are the *prior*
    halves of the finish's own record rules — no new arithmetic and no second ranking vocabulary.
    All date work stays in Postgres, weeks are Monday-to-Monday in UTC, and finished sessions only.
    Volume as a headline, muscle-group taxonomy, streaks, a cardio or duration axis, and any grade
    or percentage stay cut for the reasons they were cut for. (§5, §8)
11. **The tool catalog is a second door on the same core, and its classification IS the gate.** Every
    tool goes through a service (never the repository) and acts as the caller, so an agent is an
    owner-scoped client and the ownership rules are enforced in exactly one place. The level rides on
    the declaration beside the description, so the two cannot drift. Tools merge where one argument
    does the job — `list_routines` is the list and the single read, `get_session` carries the finish
    readout, `get_stats` narrows to one movement, `list_routines` carries the proposal waiting on a
    day of the program — and **never across levels**: no read is reachable through a
    write-classified name, and `gym:delete` is its own grant. Since W6 the catalog also carries the
    record/intent split in its NAMES: `create_routine` lands, `propose_routine_change` and
    `propose_routine_removal` land nothing (§0, §2.9). What is deliberately absent: an export tool (three tools already answer it in a shape
    a model reads), any tool that would touch another account, and any prompt, model or loop of gym's
    own. (§0, §6, §8)

---

## 10. Build phasing — the bets, in order

Each wave goes through the gauntlet (adversarial review of the diff → one fix pass → e2e on
the local stack → push → watch CI → probe prod).

- **`gym-schema` + `gym-backend-seam` (phase 0).** The section above, the module skeleton,
  the five phase-0 routes, tests appended, four lines in main.cpp. Exit: a set logged with
  curl against the local stack survives a server restart.
- **`gym-web-seam` (phase 0).** The module shell at `#/gym`; `pwa-shell` lands beside it as
  the platform bet gym makes non-optional (a training log in a basement gym with no signal
  must open).
- **`set-logger` (phase 1).** The product: the ladder module (one copy), sticky carry-forward,
  tap-to-type, the local-first flush queue against §3.3's idempotent writes, workout mode.
  Then `lift-import` (the corpus), `last-time-prefill` (the number being right), `training-log`
  (the reads). The dogfood gate was planted here: 8 consecutive real sessions without falling
  back to Lift, prefill right on set one in ≥6 — its capture surface is the native rooms now,
  the web logger having been demoted away (§11.6).
- **Phase 2.** `routines` — **the backend half is shipped**: the plan's CRUD, the movement a lifter
  creates, and the server-frozen snapshot at start (§2.4, §2.5, §4). `pr-line` — **the backend half
  is shipped too**: the finish read, the three record rules, the comparison and the discard (§3.1,
  §5, §6), e1RM shown to a human for once. `gym-export` — **shipped**, and it is the CSV §5
  describes rather than the settings-section stub the table used to promise. `gym-share` — **the
  backend half is shipped**: the separate table, the two owner-scoped doors and the one
  unauthenticated read (§2.6, §5). `gym-landing` — **shipped, and flipped 2026-08-08**: the landing
  is live and `shell.status` is `'open'`. `log-editing` — **the backend half is shipped (W3,
  2026-08-12)**: the two set routes, the revisions table and the domain's correction rule (§2.7,
  §3.3, §6). It ships without the drafts and the renumber the bet once named — a draft editor was a
  shape the decided design (§G18) never drew, and a renumber rewrites rows the lifter did not ask to
  change. Still open: `set-kinds` UI · `rest-timer` (the target column routines now write).
  `gym-mcp` — **shipped**, both halves: the platform's grant gate, then
  gym's sixteen tools on it (§6). What is left of that bet is client-side — the connect surface, and
  whatever the shell puts in front of a lifter who has no agent of their own.
- **Phase 3.** `progress-charts` — **the backend half is shipped** as `GET /v1/gym/stats` (§5).
  That is a decision taken **ahead of** the measured gate rather than through it: the gate
  (8 consecutive real sessions, prefill right on set one in ≥6) has still never been *run*, so
  "behind a measured gate" meant "behind a measurement nobody took", and the owner chose to build.
  What the gate protected is preserved a different way — the surface answers only over values the
  domain already decides, so shipping it early cost no new opinion about training, and the cut list
  in §8 is unchanged. Still ahead: plan-vs-actual, the strength tree, nudges on the shared sweep
  primitive, and the native shell. The client half of the charts is no longer among them: §H of the
  design canon gave it a home on 2026-08-12 — one movement's record, bars rather than a line
  because a training log is discrete events — and all three surfaces draw it off
  `GET /v1/gym/exercises/{id}/record`.

The order is deliberate: the durable write is the product; everything else is optional on top
of that row.

**§11 reassigns the surfaces and adds four bets to phase 1–2**: `gym-live-mirror` and
`gym-backfill` on the web side, `ladder-golden` in `packages/api-contract/`, and the native
`gym-ios-logger` behind the platform `apple-identity` bet (`backend/AUTH.md`, *Identities*).

---

## 11. Two surfaces — the phone writes, the web reads

The capture device is the **phone app**; the web app is everything else. This is a decision about
where the product puts a control, not a new rule on the wire.

**The server contract does not change, deliberately.** A surface gate — the backend refusing a set
that does not carry a device claim — was considered and refused on three counts: `tools/lift-import`
writes sets over this same public API, gym's **MCP tools write through the same services behind
it** (§6) so a rule stated at the HTTP edge would not reach them at all, and making the durable write
conditional on who is asking inverts §0, where server-as-truth is the reason gym exists here. The
stance lives in the surfaces. Every route — and every tool — stays owner-scoped and surface-blind.

### 11.1 Who owns what

| | Phone (native iOS · Android) | Web |
|---|---|---|
| owns | the **open** session | everything retrospective and prospective |
| | workout mode, keypad, ladder, sticky carry-forward, rest timer, wake lock, the flush queue | the log, progression, routines editor, export, MCP connect, settings, the strength-tree publish, backfill |
| writes | `gym_sessions` · `gym_sets` | `gym_routines` · `gym_routine_entries`, and past sessions only (§11.4) |

The axis is real rather than arbitrary: everything on the left is **live-state** work needing a
device that is with you, awake and offline-capable; everything on the right is keyboard work over
a log that has stopped moving. The schema already splits this way — the plan is relational and
editable, the session's copy of it is frozen (§2.4, §2.5).

### 11.2 The web shows the mirror, never an absence

Where the logger used to be, web renders **the live session as it happens** — not a disabled Start
button, not an apology:

```
Training now · Upper A · 34:12
Bench press — set 3 · 82.5 × 8 · last set 1:47 ago
     82.5 × 8   ·   82.5 × 8   ·   60 × 10 (warmup)
```

On a laptop at a desk that is worth having on its own, and it makes the phone's ownership legible
without a word of copy. With no session open, the slot says so in words rather than in a greyed-out
control — the one shape that would make this feel like a restriction rather than a division of
labour. It carries **no install door**: neither phone room has a store listing yet (Android is a
sideloaded APK off a GitHub Release, iOS is signing-blocked, §8), and a door onto nothing is
exactly the advertising this product does not do.

**Built, 2026-08-09.** The web's own Start went the same day: Today draws the mirror
(`web/src/products/gym/Today.jsx`) off the shared read hook's poll
(`web/src/products/gym/useTrainingLog.js`), the resting slot says *"Not training now."* over
*"Workouts start on your phone."* — true now, both phone rooms exist — and the web logger, its
flush queue and its resume note are deleted, not disabled.

**The mirror never says "resting".** The rest target is device-local — one module per language,
answering `packages/api-contract/gym-ladder.json` — so the server cannot know whether 1:47 is a
rest that is running or a rest that is over. The band says the same digits under a label it can
stand behind: *last set 1:47 ago*.

### 11.3 Sync — four flows, and the new one is not a channel

1. **Phone → server (the write).** Unchanged from §3.3: client-minted `set_<hex>`, offline queue,
   replay in any order any number of times, `ON CONFLICT DO NOTHING`, flush before finish. The
   living statements of this contract are the phones' queues — `SetQueue.swift` (apps/ios) and
   `SetQueue.kt` (apps/android) — which branch the 409 codes the same way: `set-id-taken` re-mints,
   `session-id-taken` re-mints, `session-finished` drops, and every other 409 is terminal and said —
   which is what makes `set-deleted` (§3.3) land correctly on a client built before it existed (§6). The web's `flushQueue.js`
   was the reference implementation until 2026-08-09; it went with the web logger, and the web now
   holds no set queue at all.
2. **Server → web (freshness). No new endpoint — built 2026-08-09** (`useTrainingLog.js`). Web
   boots on the log read — which is also what lazily settles a stale open session (§3.2) — finds
   the open session, then polls `GET /v1/gym/sessions/{id}`, which already answers
   `{session, sets}` owner-scoped. Five seconds while the tab is visible, stopped when hidden,
   refetched on `visibilitychange`. The `ETag` over `(startedAt, finishedAt, a fold of the sets as
   the reply renders them)` is built (2026-08-11, reshaped in W3): every 200 from
   `GET /v1/gym/sessions/{id}` carries it — weak, because it certifies those facts and not byte
   equality. It counted sets and read the last `completedAt` until a set stopped being
   insert-only: a **correction** moves no count, no last instant and no `finished_at`, so the old
   tag answered 304 over a weight that had changed and the mirror would have polled a stale screen
   forever. The fold covers anything a poll could act on and nothing else, and `startedAt` still
   leads so a session discarded and
   recreated under the same id can never answer the dead workout's tag with a 304. The poll sends
   it back as `If-None-Match` — read per RFC 9110 §13.1.2: a comma-separated list, `W/` stripped
   per entry, `*` matching any current representation — and an unchanged workout answers 304 with
   no body, so the steady state costs a header exchange and no re-render. The tag lives at the
   HTTP edge (`TrainingApi.cpp`); `TrainingService` stays wire-blind and the MCP tools never see it. The 401
   and the 404 never carry the header — absent stays byte-identical to forbidden.

   **No socket, and that is a decision.** A set lands once every 60–120 seconds. Roadmap already
   runs a CRDT room cluster for a value that changes per keystroke; a second live transport for one
   that changes once a minute is unearned, and the polling version is correct as written where a
   socket only becomes correct after its reconnect-and-replay path does.
3. **Device ↔ device handoff. Already free, and this is why §2.2 was shaped that way.**
   `gym_sessions_one_open` plus `start`'s deliberately *untargeted* `ON CONFLICT DO NOTHING` means
   a second device pressing Start **joins** the open session instead of minting a phantom. A dead
   phone and a borrowed iPad continue the same workout, no code. The honest gap: carry-forward and
   the rest countdown are device-local by design, so a handoff resumes the log and not the timer —
   which the receiving device should say rather than fake.
4. **Web → server (backfill).** §11.4.

### 11.4 Backfill — the door that keeps the promise

A lifter with a dead phone must not lose a session; gym exists because a training log is a
multi-year artifact nobody can regenerate. So web keeps one write door, and it is deliberately a
different door with different vocabulary: **"Add a past workout"**, never *Start*. It mints a
session with `startedAt` in the past, finishes it in the same flow, and appends sets with past
`completedAt`. Same routes, no new contract, and no live session ever opens on a laptop.

**Backfill is refused while a session is open**, and this shipped as a data bug before it shipped as
a rule: the partial unique index means the backfill's `start` did not fail, it silently **joined**
the live workout, and the sets of a session logged last Tuesday landed in today's. `lift-import`
posts to the same route to create past sessions, so the exposure was real and not hypothetical.

The refusal is the client's *and* the server's, and the division is the interesting part. Web
refuses before the request, with the reason said plainly — *"your phone is mid-workout"*, not a 409
the user is left to interpret. But a client-side rule is not a guarantee: `lift-import` writes over
this same public API and `start_session` (§6) writes through the service behind it — an agent
composing a backfill is a caller no web screen can warn — and the one durable write gym exists for
cannot depend on every caller remembering. So the rule is stated on the wire and enforced by the
store's own truth:
**`{"joinOpenSession": false}` on the start, and 409 `session-already-open` when another session is
open.**

**The join stays, and stays the default.** It is not a legacy accident to be tidied away — flow 3
above is *built* on it, and it is why §2.2 was shaped the way it was: a dead phone and a borrowed
iPad continue one workout because the second Start no-ops on the one-open index and reads back the
open session. The bug was never the join. The bug was that two callers meaning opposite things sent
byte-identical requests, so the server had to guess — and a server that guesses is how a past
workout's sets end up in a live one.

Three things this rule is deliberately **not**:

- **Not a surface gate.** §11's refusal stands: the server never asks who is calling, and any
  surface may state either intent — the phone could backfill, an MCP tool could join. What changed
  is that the caller *says* what it means, which is the opposite of the server inferring it from the
  caller's identity.
- **Not a heuristic on `startedAt`.** A past instant looks exactly like clock skew, and a handoff ten
  minutes into a workout looks exactly like a backfill. Silent inference is what produced the bug.
- **Not "refuse when the id that comes back is not the one I sent".** That is the tempting rule and
  it is wrong: the ids differing is precisely the *handoff*, the case that must keep working. A
  caller's own id is resolved before the open session either way, so a replay stays idempotent in
  both modes (§3.3).

### 11.5 Two rules that fall out sharp

**Web does NOT Finish a live session — settled 2026-08-09, by subtraction.** This paragraph spent
two corrections getting here: the rule was written as "web offers no button", the 2026-08-07 audit
found the code shipping a Finish anyway, and the open decision it left — teach the web Finish to
refuse over another device's unflushed queue, or remove it — is now resolved the second way. The
web logger went (§11.6), so the laptop half of the hazard went with it: there is no button on a
desk that can close a session over a phone holding unflushed sets. The web's one destructive door
is the retrospective discard on the review screen, and the store refuses that while the session is
open (409 `session-open`), so it cannot strand anything in flight.

What the subtraction does NOT settle is the same hazard **between two phones**: §3.3's finish
boundary still holds — a set that never landed may not land after the close, and only the device
holding the queue knows everything landed — so a Finish pressed on the Android room over an iPhone
holding three unflushed sets refuses those sets forever. The fallback is unchanged and still truer
in that case: auto-close fires at four hours and stamps the end at the **last set** (§3.2). One
lifter running two phone rooms at once is a narrow ledge, but the claim replay (§11.7) walks near
it, which is why its order — sets strictly before finish — is stated as law there.

**The ladder must not become copy #2.** §0 cut the ladder to exactly one module because Lift pasted
it into three targets and let them drift — and a native Swift logger writes copy #2 on its first
day. The fix is not shared code across a language boundary but shared *truth*: the step table and
the down-step rule became a golden fixture in `packages/api-contract/gym-ladder.json`, which
already existed to hold exactly this (wire types plus the genesis-legend golden), and the JS,
Swift and Kotlin modules each run it as a test. Drift then fails CI instead of shipping a wrong number
into the product's single highest-value pixel.

**Shipped (`ladder-golden`), and writing the contract down caught two defects the single copy had
been hiding.** Copy #2 exists today, ahead of the logger that needs it, precisely so the logger
inherits a proven ladder instead of a fresh transcription.

- **The assisted side was not the mirror of the loaded side.** The rule was implemented as "the
  down-step is evaluated at `weight − ε`" — just below the *signed* weight, which below zero is
  just *above* the magnitude. So +20 kg stepped down to 19, and its mirror −20 kg stepped up to
  −18 instead of −19: from −19 a lifter could reach −20 and had no button back. The rule is now
  stated on magnitude — a step that **lightens the load** reads the band just below it — and the
  epsilon disappears into one comparison tightening from `<` to `<=`. The law is exact and
  testable: `bump(−w, −direction, big) == −bump(w, direction, big)`. The epsilon was what hid the
  bug, and the sign convention hid it from the module's own hand-written tests, which asserted the
  wrong answer with a comment claiming the negative side "behaves identically."
- **The two languages rounded differently, on a value a lifter can type.** JS `Math.round` is
  half-*up* and Swift's `.rounded()` is half-*away-from-zero*; they part company at exactly `.5`,
  and `parseEntry` calls `round` on typed keypad weight, where `−2.505` fits well inside the
  8-character buffer. Web would have stored −2.5 and the phone −2.51 for the same string. Half
  away from zero is now pinned, because it is the same mirror law one level down: `round(−x)`
  must equal `−round(x)`, which half-up violates. Swift was the copy that had it right.

Neither defect is reachable from the loaded side of the number line, which is why one copy and a
year of use would never have found them. A second implementation is a second opinion.

### 11.6 What this costs, honestly

The demotion §11 called for is **done, 2026-08-09**: the web logger — capture screen, flush queue,
resume note, rest timer, wake lock, prefill dial — is deleted from `web/src/products/gym`, and the
web is the mirror (§11.2) plus backfill (§11.4) plus everything retrospective. It was a
subtraction, performed as one: nothing is disabled, flagged or apologised for. `apple-identity`
(`backend/AUTH.md`) remains a hard prerequisite for the iOS phone room's store path — shipping
Sign in with Apple without `user_identities` forks accounts on the first lifter who taps
*Hide My Email*, and the fork is unrecoverable once both halves hold sets.

**The dogfood gate's capture surface is the native rooms now.** An earlier version of this
paragraph feared there was no capture surface at all; the 2026-08-07 correction answered that the
PWA web logger was one — true then, and unbuilt now. The gate still names 8 consecutive real
sessions and no device, and the surfaces that can capture them are `apps/android` (a real room,
installable today as a sideloaded APK off a GitHub Release) and `apps/ios` (a full room that
builds and tests green, runnable from Xcode). The gate has still never been run.

What *does* still block the iPhone specifically is signing, not code: `apps/ios/project.yml` sets
`CODE_SIGNING_REQUIRED: NO` with no `DEVELOPMENT_TEAM`, and the declared Associated Domains
entitlement needs a paid Apple team. That is a purchase, and it is not on the gate's path — the
gate can run on Android today.

### 11.7 The claim replay — the client convention for anonymous-first capture

The phone rooms open signed out: a lifter trains against local routines and a local log, and
sign-in **claims** what the device holds. The claim is pure client-side replay over the ordinary
routes — the server stays surface-blind (§11), gains no claim endpoint, no anonymous identity and
**no server-side surface gate anywhere**. Both phones implement the same convention, and it is a
convention exactly the way the flush queue is one: the codes are the contract, the order is the
law.

On sign-in, and on every connect while a local backlog exists:

1. **Routines first**, idempotent by their `rt_` ids; 409 `routine-id-taken` re-mints.
2. **Sessions sequentially, oldest first.** Per session, strictly: `start` with the client-minted
   id, the true `startedAt`, its `routineId` if that routine landed, and **`joinOpenSession:
   false` — never the default**. A defaulted join silently files past sets into a live phone
   workout; that exact bug shipped once (§11.4). Then ALL its sets, per-(session, exercise) lane in
   original order — `set_number` is server-assigned in arrival order — then `finish` with the true
   local `finishedAt`. No log or stats reads interleaved mid-session: `settleOpen` auto-closes a
   session whose last set is over four hours old. Since 2026-08-16 a set that continues that
   stale-closed workout still lands and moves the finish forward (§3.2, `lateSetLands`) — the
   loss is closed at the root — but a set more than four hours past the last landed one, or any
   set after the lifter's own finish (which UPGRADES a stale close to a finish), gets terminal 409
   `session-finished`, so the ordering rule stands: drain the owed appends, oldest first, before
   anything that settles.
3. **Verdicts by code only.** 409 `session-already-open` → wait until the open session closes;
   409 `session-id-taken` during claim → re-mint the session id AND remap that session's queued
   sets onto it; 401 / 404 / 5xx / offline → retry, never drop; 409 `session-finished` → dropped
   and SAID (a `RefusedSet`, never silence). Every instant must sit in
   `(0, 253402300799000]` — repair a broken local timestamp before replay, because the 400 it
   earns is terminal.
4. **Settings ride along, and they need no new verb.** A device that holds preferences the lifter
   touched while signed out replays them as one ordinary `PUT /v1/gym/preferences`. The write is
   whole-document and last-write-wins, so replaying the DEVICE's copy after sign-in is what makes
   the device's win — which is the ordering this convention wants, because those are the values the
   lifter just touched. Order does not matter against the log: nothing in gym reads this row.
5. The live local session — open at the moment of sign-in — claims the same way minus the finish;
   the existing queue then owns it as on any signed-in day.
6. After a session's finish confirms, the local copy is **claimed**: the server log is the truth,
   and local reads merge server history with unclaimed-local only.

The undo window stays 9000 ms on every surface. Copy may change; the verdict codes may not.

---

## 12. Ask — the second door, not the second system

`ports/AskAgent.h` · `application/AskService.{h,cpp}` · `adapters/llm/AnthropicAsk.{h,cpp}` ·
`adapters/http/AskApi.{h,cpp}` · `domain/ReadReceipt.{h,cpp}` · `platform/adapters/llm/AgentLoop.h`

A lifter with Claude connects it and asks. A lifter without one opens **Ask**, which asks the same
questions of the same tools. **That is one system with two doors**, and everything below exists to
keep it that way rather than letting a second, looser path grow beside the first. §0's refusal of an
in-app chat is reversed here, in writing, with the bounds it is reversed under.

**It is not a coach, and the word is gone from every surface a lifter reads** — the brief that owns
gym's vocabulary says there is no coach, there is your agent. The coach *share* (§2.6) is a different
object and keeps its name: that one really is a coach, a human being holding a link.

W7 widened the panel this replaces rather than building a second thing beside it: same loop, same
catalog, same refusal ladder — pointed at the LOG instead of at one finished workout.

### 12.1 The narrowing, and where it actually is

`GymTools` does not gate — deliberately, because over MCP the grant was settled above it by
`CompositeToolHost` — so a chat wired straight to it would be a door with no lock, and a hallucinated
`discard_session` would execute.

**`AskTools` is that lock, and it is the whole of it.** It offers every `Access::read` declaration
plus `mintsProposal(name)` — the two `propose_` tools — and refuses everything else by reading the
DECLARATIONS rather than a list of names that could drift from them. So Ask can read the log and hand
the lifter a diff, and cannot log a set, finish a workout, mint a share, create a movement or discard
anything.

The scope `AskService::ask` states at its call site —
`ToolCaller{caller, ToolScope({{"gym", read}, {"gym", write}, {"gym", del}})}` — is **not a second
layer, and this file used to claim it was.** All three levels are gym's own, gym's host does not gate,
and there is no other product on it: against `GymTools` alone that scope offers all sixteen tools and
executes `discard_session`. What it is, is honest wiring — who Ask acts as, named one level at a time
rather than taken as `everything()`, so a fourth level or a second product never rides along on a
token nobody widened. `AskTools` reads it on the way past, in `callTool` as well as in the catalog
`listTools` filters, which is what makes narrowing it later take tools away in fact: arm the One gate,
or drop `del` to take `propose_routine_removal` off Ask, and the call is refused and not merely
hidden. Until W7's fix pass that check was in the catalog only, so a narrowed scope would have shown
a shorter `tools/list` and run every call in it.

Underneath it sits the rule W6 made structural: **no tool at any level edits or deletes a logged
set**, so Ask's most important refusal is not a sentence in its prompt at all — a prompt-level refusal
is a lie waiting for the right jailbreak.

`AskTools` also keeps the schema promise the OTHER door keeps, and that is parity rather than a third
layer: every declaration publishes `additionalProperties: false`, over MCP `CompositeToolHost`
enforces it, and Ask does not pass through the composite. Until it did so itself, a misspelt argument
was named on one door and silently dropped on the other — `get_stats {"exerciseID": …}` answered with
every movement a lifter has ever trained while the model believed it had asked about one. The two
doors differ in transport, prompt and who pays; nothing else. The check is written twice today
because the composite keeps its copy private to `platform/adapters/mcp`; the standing request is to
hang it off `ToolDeclaration`, where both doors would read one copy.

### 12.2 Every bound, and why each one is there

| Bound | Value | Why |
|---|---|---|
| Grant | `gym:read` + the two proposal mints | it answers questions and proposes; it changes nothing |
| Reach | the whole log | Ask is reached from Today and from a proposal card, not from one workout |
| Never mid-session | `409 ask-session-open`, checked on the server | §L says Ask is not offered while a workout runs, and three clients each remembering that is three chances to forget |
| Iterations | 8, and hitting it is a **failure** | the log is wider than one workout; an unfinished answer is still worse than "Ask didn't answer" |
| Turns | 8 per THREAD, 1000 bytes each (`kMaxThreadTurns`, `kMaxAskTurnBytes`) | since W11 the server assembles the prompt from the thread it stored, so the cap bounds the side that pays for it. It bites on the PAIR an ask would add, so a conversation is never capped halfway through answering; the refusal is `409 ask-thread-full` and the client opens a new thread |
| Entitlement | **none — it ships open** | Windmill One cannot be bought, so a locked Ask would advertise a 503 (§0). The gate is one predicate away, on the allowance line |
| Daily limit | ~10 a day, 3 back to back, per **account** (`AskRation`) | the first Windmill feature with a marginal cost per use, so the ration is stated on screen instead of hidden as a weaker model. A bucket in memory, so a deploy refills it — soft on purpose, because the row below is what has to be hard. **Taken last and given back when the run COST NOTHING**: every refusal above it costs nothing, and neither does a fuse trip, a wedged vendor or a log we could not open, because the cap's copy is a promise and three outages must not spend a burst that answered nobody. The test is `AskAnswer::modelTurns` — metered vendor round trips — and not `ok`: hitting the 8-iteration cap costs eight billed turns and stopping at `max_tokens` costs one, and refunding those (as W7 first shipped) waived the ration on precisely the most expensive runs the product has. That return is why the bucket is gym's own and not platform's `RateLimiter`, which has no way to hand a token back |
| Dollar ceiling | the platform's own: `AiFuse` hourly + `aiAllowanceFor` over 30 days | ours, never shown as money to anybody, and the same rows the owner page reads |
| Vendor | absent when unkeyed | no `ANTHROPIC_API_KEY` ⇒ no `AskService` ⇒ `registerRoutes` never mounts the path |

### 12.3 The receipt is server-observed or it is a laundered hallucination

§L's rule is that every answer states what it read — `read 214 sets · 12 weeks · 34 sessions`. **That
count is printable only because we served those rows to that connection**, so it lives in the TOOL
RESPONSE ENVELOPE and not in Ask's chrome: every gym read that hands over log rows answers with
`"read": {sets, sessions, weeks}`, counted by `domain/ReadReceipt` as the rows go out. A lifter's own
Claude over MCP therefore reads exactly the accounting the app prints, and a number that existed only
in a UI layer — a number the model could simply have made up — has nowhere to be invented.

Four rules keep it honest: it counts by **identity**, so one workout read twice is one workout; a
read that serves a SUMMARY claims only what it NAMED (a default page of `list_sessions` adds twenty
sessions and not one set); a REFUSED read counts nothing, because a refusal hands the model one
sentence and no rows — so the run's line only ever merges a reply the model actually got, and every
read settles its arguments before it marks anything; and a reply that served no log rows says nothing
at all rather than `read 0 sets`. The
run's total is merged inside `GymTools`, where the ids are, because a layer above could only have
summed the replies — and a sum counts the same set twice.

**So the line is a FLOOR, and §L's `read 214 sets · 12 weeks · 34 sessions` is the design's
illustration rather than a typical answer.** Sets are claimed by `get_session` and `last_time` alone;
`list_sessions` names workouts and hands over no set rows; `get_stats` serves a projection — one
point per session per movement — whose points carry no session id, only the session's start instant,
which two workouts can tie on, so it claims its weeks and nothing else. A realistic run (the opening
page + `get_stats` + `last_time`) over a 34-session, 272-set log prints `read 8 sets · 34 weeks · 20
sessions`. Under-claiming keeps the promise the object exists for — it never claims a row it did not
hand over — and over-claiming would break it. Raising the floor means carrying a session id through
`MovementTop` and the store's projection, which is a **W8 request**, not a thing to describe here as
if it were done.

The proposals in the reply are observed the same way: `AskTools` takes the id off the tool's own
result, never out of the answer's prose, so the app has the diff to open whether or not the model
remembered to mention it.

### 12.4 The shapes it refused

- **No streaming.** The only SSE machinery in the repo is roadmap's hand-rolled HTTP/1.1 + chunked
  decoder, and one reply per ask does not earn a second consumer of two hundred lines of parser.
- ~~**No conversation table.**~~ **W7 shipped this and W11 reversed it** (§12.6). It was a real
  decision — the client sent the turns so far, there was no thread id and nothing to garbage-collect
  — and the reason it changed is a product reason rather than a technical one.
- **No blocking the request loop.** `AskAgent::answer` blocks for as long as the vendor takes;
  `AskService` owns a two-thread pool and the handler hands its callback over. Four handler threads
  parked on a model is a training log that stops answering everybody. The run is guarded on that
  thread, because **nothing sits above a worker loop**: an exception leaving it would be every product
  on the box, and a request nobody answers. It becomes the same 502 a dead upstream gets, and gives
  the day's question back for a different reason than a dead upstream does: the turn count died with
  the stack, so whatever it spent is unknown — and a crash of ours is not a question of theirs.
- **No second loop.** W7 lifted the tool loop into `platform/adapters/llm/AgentLoop.h`, where it sits
  beside the ToolHost it drives. What stays in gym is the prompt and what the answer is made of; no
  domain code knows an Anthropic API exists. Roadmap's tend still carries its own copy of the same
  shape — re-pointing it is mechanical and was out of W7's territory, and it needs one addition, a
  per-tool callback, because a tend stamps each step somewhere a disconnected browser cannot take it.
- **It does not speak first**, has no personality, no encouragement, no streaks, no daily check-in
  and no unread badge. The prompt bans a grade as firmly as the finish screen does.

### 12.5 What the lifter is told

Ask prints **which tools each answer came from**, in call order, and **what those tools served**,
counted by the server. That pair is the product's whole stance made visible: a model reads your log
through the same doors you do, and you can check it without trusting it. Without them this would be a
chatbot claiming to know things.

The empty state points at the free door — *if you already use Claude or ChatGPT, connect them
instead: it is free, and it is better, because it knows the rest of your life.* An in-app chat that
tells you how to stop paying us costs one paragraph and is the strongest available proof that the MCP
thesis is real.

### 12.6 Ask has a past (§O, W11) — and this reverses W7 in writing

`domain/Thread.{h,cpp}` · `gym_ask_threads` + `gym_ask_turns` · `gym_proposals.thread_id`

W7 built Ask **stateless on purpose** and said so above. The owner reversed it, for a product reason
rather than a technical one: *a conversation about your bench plateau is worth more in six weeks than
it was that evening.* So the server keeps the thread, the client sends one question, and the ask
route's body changed shape.

**The list is not a chat inbox.** Each row is the question **in the lifter's own words** plus what
came of it, because that is what somebody comes back looking for. Which fixes two things at the top:

- **The title is the first message, VERBATIM** — stored as sent, byte for byte, punctuation and emoji
  included, written once at creation and never again. Nothing in this product summarises what a
  lifter typed, anywhere, ever. No auto-title, no model-written title, no folders, no pinning.
- **No unread count, no badge, no notification, and nothing waiting.** A threads screen is the most
  natural place in this product to grow a badge, and it must not. Ask *does not speak first*, and it
  does not resurface old threads on its own either.

**The outcome is DERIVED, never stored** (`outcomeOf`, `domain/Thread.h`). The proposals a thread
minted *are* the outcome — an outcome column would be a second copy of a fact the ledger already
holds, and it would go stale the first time a lifter applied a proposal from the routine screen
instead of from the thread. The ladder: something that landed beats something waiting, waiting beats
something turned down, and a proposal the routine outran is the last thing left to say.

**EVERY ROW'S DETAIL IS SOMETHING THE SERVER OBSERVED, and this is where the board is wrong.** §O
draws a dismissed thread reading `built it myself instead`. Nothing observes *why* a lifter dismissed
a proposal and this product does not ask, so that line would be us narrating a motive onto somebody's
evening — one line under the rule that the title is your words and never a summary a model wrote. So:
**a dismissed row carries what was dismissed — the count — and nothing about why.** Filed to the
design canon's `consistency.md` as a drift item; the correction is ours to propose, not to make
silently.

The same rule adds two words the board does not draw, and for the same reason. A thread whose
proposal is still **`proposed`** has not been read only — the server watched it mint something — and
a **`superseded`** one is the routine having moved underneath it, which is a fact and is not the
lifter turning anything down. Five words on the wire; the board's three are the ones drawn loudest.

**Delete deletes the conversation, not the consequence.** `gym_proposals.thread_id` is
`on delete set null`, so an applied change stays in the routine's history — it still says it came
from Ask, it just no longer opens a conversation that exists. That is not leniency about deletion: an
applied change is a fact about somebody's program rather than a message.
`pg_gym_deleting_a_thread_leaves_the_change_it_applied_in_the_routines_history` proves it against the
real store rather than assuming it.

**A question nobody answered is not a turn.** The thread row lands *before* the model runs (a
proposal minted mid-conversation references it), the turns land only once an answer has, and a run
that never answered takes its own empty thread back with it. It is the same rule the day's ration
already keeps, and it means a retry appends the question once rather than twice.

So **a thread holding no turns is a real state**, not an impossible one: one exists for the whole of
every in-flight ask, and it survives a process that died between the insert and the answer. Every
read carries such a thread as itself, with nothing under it, and so does the export.

**The question meets `storableText` like every other free text in gym** (§3.1) — a NUL or bytes that
are not UTF-8 are a terminal `400`, at the door, before a thread is opened. This one matters more
than the others rather than less: the question becomes the TITLE we promised is the lifter's words
byte for byte, so a NUL storing the head of a question as if it were the whole of it breaks the one
rule the row exists for, and non-UTF-8 bytes are refused by Postgres mid-transaction and used to
leave as the house 500 that every client queue is told to retry.

**Threads are in the CSV export with everything else**, at `GET /v1/gym/export/threads`: one row per
turn, the outcome stamped on by the service rather than rendered in SQL, and the turn itself byte for
byte. A second file rather than more columns on the first, because a CSV row is one shape and a set
and a sentence are not one shape.

Nothing omitted is meant literally, and it cost two joins to be true. The outcomes are stamped from
`allThreads` and not from the list read, which stops at `kThreadList` — a ceiling that is honest on a
screen and a lie in an archive. And the turns join is a LEFT one, so a thread holding no turns is in
the file with its turn columns empty rather than silently missing from a file the list can be held
up against.

**The three read/delete doors are mounted unconditionally** while `POST /v1/gym/ask` is not: a
deployment with no vendor key keeps every conversation a lifter already had, readable, exportable and
deletable. A thread is somebody's own words, not a feature of the model that answered them.

What this wave did **not** build: no summarisation of any kind, no search over threads, no
notification or unread state, and no change whatsoever to what Ask can DO — the safeguard ladder is
exactly as §12.1 leaves it.
