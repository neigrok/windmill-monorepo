# Windmill Gym — backend architecture

The backend for gym, the training log. It mirrors journal's product shape — `domain/ · ports/ ·
application/ · adapters/{json,csv,postgres,http,mcp,llm}` — and plugs in through one seam:
`gym::registerRoutes(app, deps)`. Everything lives in `namespace wm::gym`; id tags are gym's own
(`ExerciseTag`, `SessionTag`, `SetTag` → `ExerciseId`, `SessionId`, `SetId`, via the platform
`Id<Tag>` template). `STRUCTURE.md` holds the monorepo layout and the dependency rule.

## 1. Scope

The backend owns the durable set write, exercise identity, the reads the device cannot fake (the
log, last-time prefill, the finish review, a movement's record, the statistics engine, the CSV
exports, the coach share), sixteen MCP tools behind the platform grant gate, and the proposal ledger.

Device-side and never here: the weight ladder, the rest timer, workout mode, and the prefill
arithmetic (sticky carry-forward, tap-to-type, comma-as-decimal parsing).

- **It reads, it proposes, it never writes to the program.** Every mutation an agent can make
  declares `record` or `intent` (`domain/Proposal.h`). Recording something that already happened
  executes immediately at every door — a set, a workout starting or ending, a movement, a new day of
  the program. Changing something that will happen mints a proposal that does nothing until the
  lifter taps Apply. Enforcement is the tool layer, the only place gym can tell an agent from a hand:
  `ProgramService::replaceRoutine` is `PUT /v1/gym/routines/{id}` and is unreachable from `GymTools`,
  and there is no apply tool at any grant level.
- **No visibility column.** Every owner route is `WHERE user_id = :caller`, and absent is
  byte-identical to forbidden on all of them. The one non-owner reader comes through a separate table
  (`gym_session_shares`) and one unauthenticated route that reads nothing else.
- **Gym publishes, gym never imports.** No cross-product read.
- **Billing gates nothing here.** Gym holds no plan enum; every route answers a signed-in lifter, Ask
  included. `AskService::ask` reads `Entitlements::aiAllowanceFor`; a gate would be one refusal on
  that line.

## 2. Layout

```
domain/       Training (ids · enums · Exercise · Session · Set · PlanSnapshot · InvalidTraining ·
              codecs · defaultStepKg · the four session rules) · Routine · Proposal · Review ·
              Statistics · Record · Preferences · Thread · ReadReceipt
ports/        LogRepository (sessions · sets · revisions · the share) · CatalogRepository ·
              ProgramRepository (routines + the ledger) · AskThreadRepository ·
              PreferencesRepository · AskAgent
application/  TrainingService · CatalogService · ProgramService · ThreadService ·
              PreferencesService · AskService
adapters/     json/TrainingJson · csv/TrainingCsv · postgres/PgGymRows.h + five Pg repositories ·
              http/{Training,Catalog,Program,Preferences,Threads,Ask}Api ·
              mcp/{GymToolCatalog,GymTools} · llm/AnthropicAsk
routes.h/.cpp gym::GymDeps + gym::registerRoutes(app, deps)
```

Ports are cut by **aggregate**: the log, the catalog, the program (routines and the ledger together,
because `replaceRoutine` supersedes pending proposals in the same transaction), Ask's threads, the
settings row. The split is not table ownership — the log's reads join the catalog for a movement
name, the program's mint checks a movement against the catalog's predicate. Each Pg adapter's
preamble says what it reads from another aggregate's tables; shared helpers live in `PgGymRows.h`.
The in-memory fake keeps one shared store (`FakeGymStore`) so every cross-aggregate rule is written
once. `routes.cpp` names every path in one column; `TrainingApi.h` holds the status ladder.

## 3. Schema

One idempotent `-- ── Gym (products/gym) ──` section in `backend/db/schema.sql`. The whole file
re-runs on every deploy under `ON_ERROR_STOP=1`, so every statement must be re-runnable; a column
that has to change gets its own idempotent statement beside its table, and a database created before
it must end up identically shaped to one created after.

Tables are `gym_*`, `user_id uuid references users(id) on delete cascade` everywhere — account
deletion is the cascade. **All date/time work stays in SQL** (`to_timestamp`, `extract(epoch …)`);
instants cross the wire and the domain as epoch-ms `uint64`; no C++ calendar function is consulted.

### 3.1 Catalog

```sql
create table if not exists gym_exercises (
  id          text primary key,                   -- STABLE slug; never renamed, never displayed
  name        text not null,                      -- the mutable display string
  pattern     text not null check (pattern in
                ('squat','hinge','press','pull','carry','core','isolation')),
  equipment   text not null check (equipment in
                ('barbell','dumbbell','machine','cable','bodyweight','kettlebell')),
  step_kg     numeric(4,2) not null default 2.5,  -- reserved; read by nothing today
  created_by  uuid references users(id) on delete cascade,   -- null = catalog seed
  created_at  timestamptz not null default now()
);
create table if not exists gym_exercise_names (      -- what THIS account calls a seeded movement
  user_id     uuid not null references users(id) on delete cascade,
  exercise_id text not null references gym_exercises(id) on delete cascade,
  name        text not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, exercise_id)
);
create table if not exists gym_exercise_aliases (    -- what it USED to call it
  user_id     uuid not null references users(id) on delete cascade,
  exercise_id text not null references gym_exercises(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, exercise_id, name)
);
```

- **A seed row is GLOBAL**, so never `UPDATE gym_exercises SET name` on one: a seed rename takes a
  per-account line in `gym_exercise_names`, and every read of a movement name coalesces that over the
  seed's. Renaming back to the seed's own name DELETES the line. A movement the lifter created
  renames in place. The id never moves either way.
- Aliases are what the picker searches beside the current name. The name is part of the key, so
  renaming BACK deletes one row; the rename caps the list at `kMaxAliases` (5), and the set ships on
  the catalog read.
- The seed is **64 movements** across the seven patterns, `ON CONFLICT DO NOTHING`. Steps by
  equipment: barbell 2.5, dumbbell 2.0, machine 5.0, cable 2.5, bodyweight 2.5, kettlebell 4.0.
  `dip`, `pull-up` and `muscle-up` are distinct ids; "weighted" is load, not identity.

### 3.2 Sessions and sets

```sql
create table if not exists gym_sessions (
  id          text primary key,     -- CLIENT-MINTED 'ses_<hex>'; the id IS the idempotency key
  user_id     uuid not null references users(id) on delete cascade,
  routine_id  text references gym_routines(id) on delete set null,   -- informational
  plan        jsonb,                -- FROZEN routine copy, composed by the SERVER; null = ad-hoc
  started_at  timestamptz not null,
  finished_at timestamptz,
  closed_by   text check (closed_by in ('finish', 'stale'))          -- NULL reads as finish
);
create index if not exists gym_sessions_log on gym_sessions (user_id, started_at desc);
create unique index if not exists gym_sessions_one_open on gym_sessions (user_id)
  where finished_at is null;

create table if not exists gym_sets (
  id           text primary key,    -- client-minted 'set_<hex>'
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
create index if not exists gym_sets_session on gym_sets (session_id, set_number);
create index if not exists gym_sets_history on gym_sets (user_id, exercise_id, completed_at desc);
```

- **One open session per user**, enforced by the partial unique index, never by application memory.
  Starting while another is open JOINS it, unless the caller states it will not (§11.2).
- `started_at` / `finished_at` / `completed_at` are client wall-clock instants: offline logging makes
  the device's clock the only honest one.
- **One row per set that currently stands.** A correction rewrites the row; a delete moves it to
  `gym_set_revisions`. Every read recomputes off live rows and none projects a chain.
- **`set_number` is server-assigned `max+1` per (session, exercise)**, never `count+1`: deleting set 2
  of 3 leaves 1 and 3, and `count+1` would mint a second 3. Nothing renumbers after a delete.
- **Take the session's `FOR UPDATE` lock in its own statement before the insert.** Under READ
  COMMITTED an INSERT that both locks and reads `max(set_number)` misses the row it waited for. There
  is no unique index on `(session_id, exercise_id, set_number)`: the lock makes the duplicate
  unreachable and the column legitimately holds gaps.
- **Only WORKING sets count toward anything** — volume, marks, records, the counts a screen prints.
- **Negative `weight_kg` is legal** and means band-assisted work, which is why every volume sum
  clamps at zero.
- Canonical unit is **kg, at rest and on the wire**, `numeric` and never float; there is no `lb`
  column anywhere. The domain carries `double`, and e1RM rounds to the one decimal the screen prints
  before comparing, so float noise cannot mint a record.

### 3.3 The plan

```sql
create table if not exists gym_routines (
  id          text primary key,     -- client-minted 'rt_<hex>'
  user_id     uuid not null references users(id) on delete cascade,
  name        text not null,
  position    int  not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists gym_routines_user on gym_routines (user_id, position);
alter table gym_routines add column if not exists revision int not null default 1;
alter table gym_routines add column if not exists created_entries int;   -- lines it was BUILT with
alter table gym_routines add column if not exists created_door text      -- null = the lifter's hand
  check (created_door in ('mcp','ask'));

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
alter table gym_routine_entries alter column target_reps drop not null;
alter table gym_routine_entries alter column target_reps drop default;
alter table gym_routine_entries alter column target_sets drop not null;
alter table gym_routine_entries alter column target_sets drop default;
```

- `revision` is the concurrency token: what a proposal is minted AGAINST, and what stops a
  read-modify-write PUT from destroying that base.
- Entries are relational, never a blob; the only legitimate blob is the session's frozen snapshot.
  The same movement twice in one routine is two rows with two positions.
- **Four entry columns mean something by being null**, and the absence is never a zero: no target at
  all is `open` and asks at the rack; no rep target is `max`; no target weight is "whatever you did
  last time"; no rest falls back to the lifter's global rest target. `Routine` refuses reps or a load
  beside an absent set target.
- **A routine is written as a whole document**, on create and replace alike: the row and its entries
  land in one transaction, and a replace deletes the run and lays it down again. An entry has no
  identity — its key *is* its position. Positions are dense and 1-based, checked by the `Routine`
  constructor against arrival order.

**The plan snapshot.** `gym_sessions.plan` freezes at start, every field of a line but `exerciseId`
omitted when the routine named none:

```json
{ "routine": "Upper A",
  "entries": [ { "exerciseId": "bench-press", "sets": 3, "reps": 8,
                 "weightKg": 82.5, "restSeconds": 180 } ] }
```

**The server composes it, always**, from its own routine row inside `TrainingService::start`; a start
naming a routine the caller cannot read is `404 no such routine`, never a session quietly started
ad-hoc. Mid-session changes are session-scoped; writing one back is a client issuing an ordinary
`PUT /v1/gym/routines/{id}`. In C++ it is a typed `PlanSnapshot`, and **one codec pair in
`adapters/json/TrainingJson` serves both edges** — the jsonb column and the wire — so the stored
object and the one a client reads back cannot drift. The read half clamps rather than throws:
`routine` is a name only when it is a string, and a plan that is not an object is no plan at all.

### 3.4 The coach share

```sql
create table if not exists gym_session_shares (
  session_id  text primary key references gym_sessions(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  token       text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
```

- **A table and not a `visibility` column.** A column would put a stance on every session row and turn
  every `WHERE user_id = :caller` query into a place a gate can be forgotten. No existing query names
  this table, so sharing is unreachable by accident, and the feature is three port methods.
- **`session_id` is the primary key**, which makes the mint idempotent. An expired share is replaced
  rather than returned, and the guard on that `DO UPDATE` reads the instant the caller passed, never
  the database clock.
- **The token is server-minted** (the platform `TokenGenerator`), never accepted from a client, and
  stored **in the clear rather than as a digest**, because the mint must hand back the same link on a
  repeat. Lifetime is `kShareLifetimeMs` (30 days).
- **Revocation is deleting the row.** The row rides the session's cascade and is in
  `PgAccountFootprint`'s owned list.

### 3.5 Set revisions

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

- **A correction UPDATEs the set row and appends the prior version here; a delete moves the row here
  whole, marked `deleted`.** `gym_sets` keeps its one meaning and every read stays correct by
  construction.
- **Nothing shows this table to a lifter.** There is no trash and no recovery route, and no copy may
  promise a set back.
- **One write reads it, and it reads one column**: an append asks whether the id it carries names a
  set this account DELETED, so a delete survives a replay of the POST that logged the set.
- **`set_id` carries no foreign key** because a deleted set's row is gone from `gym_sets`.
  `session_id` and `user_id` keep theirs, so closing an account takes these rows and discarding a
  workout takes its revisions.
- **No CHECKs on the copied columns**: a constraint tightened on `gym_sets` later must never make the
  history of a set unwritable.
- **Each write keeps its copy in the same statement that moves the row** (`PgLogRepository`): the
  delete's `DELETE … RETURNING` feeds the `INSERT`, and the correction's data-modifying CTE copies the
  row beside the `UPDATE` under an `IS DISTINCT FROM` guard, so a resent identical fix keeps nothing.
- **One lock order for all three writes that change what a workout holds: the session row first, its
  set rows after.** `gym_set_revisions` has a foreign key to `gym_sessions`, so every copy already
  asks that session row for a `KEY SHARE`, and a writer taking a set row first would close the cycle.

### 3.6 Preferences

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

- **Units are a display transform and nothing else.** No conversion, no `lb` column: switching to `lb`
  changes what a screen prints.
- **Defaults live on the columns AND in `domain/Preferences.h`, and must agree.** A lifter with no row
  is served the domain's copy — kg, the rest timer **off**, confirmation on wherever a platform has
  one. `PgPreferencesRepositoryTest` pins the two copies together.
- `rest_seconds` NULL means "no timer"; its band is the routine line's band, from one pair of
  constants (`kMinRestSeconds` / `kMaxRestSeconds`, `domain/Training.h`).
- **Not in `PgAccountFootprint`'s owned list.** That list decides whether the link door may delete an
  account, so a table on it must be data the account holds; settings are how a room is set up.
- **The write is a whole-document `PUT`**; omitted fields take their default, and the later of two
  writes holds the whole document — the ordering the claim replay wants (§11.4). Every refusal carries
  a `code` (`preferences-unreadable` · `unknown-unit` · `rest-target`), raised by the entity.

### 3.7 The proposal ledger

```sql
create table if not exists gym_proposals (
  id            text primary key,   -- client-minted 'prop_<hex>', the idempotency key
  routine_id    text not null references gym_routines(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  intent        text not null check (intent in ('revise','remove')),
  base_revision int  not null,
  base_name     text not null,
  proposed_name text not null,
  summary       text not null default '',
  changes       int  not null default 0,            -- `Apply all N`
  state         text not null check (state in ('pending','applied','dismissed','superseded')),
  door          text not null check (door in ('mcp','ask')),
  connection    text not null default '',
  agent         text not null default '',
  created_at    timestamptz not null,
  settled_at    timestamptz,
  thread_id     text references gym_ask_threads(id) on delete set null
);
create unique index if not exists gym_proposals_one_pending
  on gym_proposals (routine_id, door, connection) where state = 'pending';

create table if not exists gym_proposal_changes (
  proposal_id text not null references gym_proposals(id) on delete cascade,
  position    int  not null check (position >= 1),
  user_id     uuid not null references users(id) on delete cascade,
  kind        text not null check (kind in ('kept','added','removed','retargeted')),
  exercise_id text not null references gym_exercises(id),
  before_sets int, before_reps int, before_weight_kg numeric(6,2), before_rest_seconds int,
  after_sets  int, after_reps  int, after_weight_kg  numeric(6,2), after_rest_seconds  int,
  primary key (proposal_id, position)
);
```

- **The rows are the DOCUMENT as well as the DIFF.** Rows `1..k` are the run the routine takes on, in
  order — `kept`, `added`, `retargeted` alike — and rows `k+1..n` are the lines it takes away, so the
  diff a lifter reads and the document an Apply writes are the same rows read two ways.
  `domain/Proposal.h`'s constructor refuses a proposal whose removals do not come last.
- **Apply is atomic and applies against `base_revision`.** The base revision and base name are frozen
  at mint; the write lands only while `gym_routines.revision` still equals it, and a routine that
  moved is **superseded, never merged over**. That comparison is made in exactly one place: the store,
  under its own lock. `ProgramService::apply` hands `appliedTo` down and re-decides none of the
  store's facts.
- **The revision moves when the document or the name moves, and not otherwise.** A PUT that lands the
  bytes already standing moves nothing and settles nothing; neither does a drag up the routines
  screen, since `position` is not part of any proposal.
- **One pending proposal per (routine, door, connection).** A newer one from the same door and
  connection supersedes the older; another door's, or another agent's on the same account, stands.
  Applied, dismissed and superseded proposals stay as a dated record for as long as the routine
  stands — `routine_id` cascades, so an applied REMOVAL takes the whole ledger with it.
- **`door` / `connection` / `agent` are provenance columns.** The last two come from the transport:
  `ToolCaller` (`platform/domain/ToolScope.h`) carries the account, the grant and a `ToolConnection`
  — over OAuth the client id and its registered name (capped at 64 printable characters), over an MCP
  key the key's public id and its name (capped at 60) — and `GymTools` copies both onto the
  `ProposalSource`. Ask stores both empty, as does a caller with no connection; the wire omits either
  field when empty.
- **Nothing a proposal touches is a logged set or a frozen snapshot.** Applying one writes
  `gym_routines` + `gym_routine_entries` and no other table. A removed line's *N logged sets kept* is
  counted at read time against the live log, never stored.
- **A spent proposal id splits three ways**: another account's is `idTaken` (spent, never whose); the
  caller's own carrying the SAME document replays the stored proposal untouched; the caller's own
  carrying a DIFFERENT document is `idReused`, refused. `isReplayOf` compares what the CALLER sent.
- **Every mint refusal returns before the commit**, because the supersede that clears the pending slot
  runs inside the mint's own transaction. The id is resolved first.
- Two refusals decided above the store: a document identical to what the routine already says is
  `noChange`; an applied REMOVAL leaves no proposal to read back, so a second tap answers `404` and a
  client treats that as the removal having landed.
- **`Apply all N` counts** every row that moves, one for a renamed routine, and one for a run the
  proposal reorders. It is what `noChange` is decided off.
- **No CHECKs on the change rows' target columns**, so a bound tightened on `gym_routine_entries`
  later cannot make a minted proposal unreadable. The entity refuses out-of-band values at the mint.
- Both tables are in `PgAccountFootprint`'s owned list. Every proposal route is owner-scoped and 401s
  before it reads anything.

### 3.8 Ask's threads

```sql
create table if not exists gym_ask_threads (
  id         text primary key,      -- client-minted 'thr_<hex>', the idempotency key
  user_id    uuid not null references users(id) on delete cascade,
  title      text not null,         -- THE FIRST MESSAGE, VERBATIM, written once
  created_at timestamptz not null,
  asked_at   timestamptz not null   -- the newest turn: what the list sorts and dates by
);
create table if not exists gym_ask_turns (
  thread_id   text not null references gym_ask_threads(id) on delete cascade,
  position    int  not null check (position >= 1),
  user_id     uuid not null references users(id) on delete cascade,
  from_lifter boolean not null,
  text        text not null,        -- as sent, byte for byte
  said_at     timestamptz not null,
  primary key (thread_id, position)
);
```

Both are on `PgAccountFootprint`'s owned list. There is **no outcome column** — the outcome is derived
from `gym_proposals` on every read. Turns are written a **pair at a time** and only once an answer
lands, but the **thread row lands first**, because a proposal minted mid-conversation points at it. A
thread holding no turns is therefore a real state: `discardEmptyThread` takes it back when the run
dies, and it survives a process that died in between. Every read and the export carry such a thread
as itself.

## 4. Domain

Pure, no I/O. Real constructors, never aggregate init: an invalid entity cannot exist in memory, and
the HTTP 400 is the constructor's throw of `InvalidTraining` caught at the boundary.

`Exercise` (id, name, pattern, equipment, stepKg, custom) · `Session` (id, user, startedAtMs,
finishedAtMs?, routine?, plan? — plan absent = ad-hoc) · `Set` (id, session, exercise, setNumber,
weightKg, reps, kind, rpe?, note, completedAtMs) · `PlanSnapshot` of `PlanEntry` (exercise, sets?,
reps?, weightKg?, restSeconds? — an absent sets is `open`, an absent reps is `max`) · `Routine` of
`RoutineEntry`, plus `defaultStepKg(Equipment)` and `snapshotOf(const Routine&)`.

`RoutineEntry` carries **no id** — the table's key is `(routine_id, position)`.
`Routine::lastTrainedAtMs` is the store's aggregate over the log, not a column anyone writes.

### 4.1 Construction bounds

- **Every instant is bounded to `(0, kMaxInstantMs]`**, `kMaxInstantMs = 253402300799000`
  (9999-12-31T23:59:59Z, the furthest a `timestamptz` holds). A device serializing an int64 `-1` as a
  uint64 wraps to a negative epoch and commits a row every later read of that account throws on. The
  Postgres mapper also clamps every instant it reads.
- **Every free text goes through `storableText`**: no NUL (Postgres `text` stops at one) and
  well-formed UTF-8 only (Postgres refuses the rest mid-transaction, which would otherwise leave as
  the retryable house 500).
- **Display names go through `trimmedName`**, then must be non-empty and at most `kMaxNameLength`
  (240) **bytes** — the unit the column counts. Clients cap at 60 characters, and 60 UTF-8 characters
  never exceed 240 bytes, so the client's cap is the one a lifter meets in every script. Trimming
  makes `"   "` the empty name it is and `" Back Squat "` the seed's own name, so renaming back to it
  clears the override.
- **A ladder step is bounded to `[kMinStepKg, kMaxStepKg]` = `[0.01, 99.99]`**, both ends of
  `step_kg numeric(4,2)`. Above it Postgres raises a numeric overflow the ladder calls retryable;
  below it the value rounds to `0.00` and the next read refuses it.
- **A routine**: at least one entry, at most `kMaxRoutineEntries` (50), positions `1..n` in order,
  `targetSets` 1–20 when named, `targetReps` 1–100 when named, `targetWeightKg` within ±500,
  `restSeconds` 15–900. The document's size is bounded beside every field's value, because a routine's
  lines are one INSERT each inside a single transaction.
- `parseSetKind` is **strict on write** (an unknown kind is a 400); `setKindFromStored` clamps to
  `working` on read, so a kind added by a newer deploy cannot crash an older reader.
- Id shape is one rule: `^[A-Za-z0-9_-]{8,64}$`, recommended prefixes `ses_` / `set_` / `rt_`, opaque
  to the server.

### 4.2 The four session rules

All pure and clock-free, in `domain/Training.h`:

- `autoCloseAt` — an open session with no activity for `kAutoCloseMs` (4 h) is over, and it ended at
  its last set; a session with no sets ended when it began.
- `canFinishAt` — a workout cannot end before it began, at zero, or past what the store can hold.
- `canStartAt` — a device's clock is the truth about the past, never the future: a start more than
  `kMaxClockAheadMs` (5 min) past the log's now is refused, naming the gap. **Only a start that would
  CREATE is held to it**; replays and joins create nothing. Without it a session started with a clock
  ahead of the server is never stale, its honest finish is earlier than its start and refused,
  discard refuses an open session, and every later start joins it.
- `lateSetLands` — a finished session remembers WHO finished it (`ClosedBy::finish` / `stale`).
  `finish` is the lifter's word and final; `stale` is the log's four-hour guess, closed at the last
  landed set. A set that continues a stale-closed workout — within four hours of its `finished_at` —
  is accepted, and the finish moves forward to it. Nothing lands after the lifter's own finish.

`TrainingService` applies the auto-close **lazily** — before a new session starts and on every read
whose answer a close rewrites — through the two-phase shape: load the open session and its last set
instant → `autoCloseAt` → persist. **No cron, no sweep, no heartbeat**: gym arms zero tickers.

Between finishes `close` is first-writer-wins, so the first finish that lands is the session's end
forever — only a STALE close yields. The lifter's own finish landing on a stale close **upgrades** it
(`finishAfterStaleClose`): the word becomes `finish`, and the instant moves to the finish when it sits
within four hours of the last activity, staying at that activity when the tap came later. A row closed
before `closed_by` existed reads as a finish.

### 4.3 The review (`domain/Review.h`)

- **`e1rm` is defined only for a loaded set** (Epley, `weightKg > 0`). A chin-up at 0 kg and a
  band-assisted pull-up at −20 have no honest estimate. It returns the value rounded to the decimal
  the screen prints, and every comparison uses that rounded number.
- **`topE1rmOf` is the one definition of a session's e1RM**, over *every* working set the session held
  — never Epley over the top set: 3 × 95 × 10 beats 100 × 5. All three surfaces that print one come
  through it.
- **`recordAgainst` is the one implementation of the three record rules**; `recordedIn` walks it
  forward over a page, judging each session against the history as it stood that day and folding a
  session into that history **only if it is finished**.
- **The record rules:** working sets only; **a mark must have been passed**, so a first session claims
  nothing and equalling is not beating; at most one record per session, ranked `e1rm` ▸ `heaviest` ▸
  `repsAtWeight`, and within a kind by the larger e1RM, then the heavier load, then the earlier set.
  Under `kSlightWorkingSets` (4) working sets a session says nothing beyond its three facts; duration
  is deliberately not in that predicate. The comparison exists only for a session that named a
  routine, is matched on the **top working set** (heaviest, ties to more reps) and never on volume,
  and names the earlier session by the routine name frozen in *that* session's snapshot.
- **`PriorMark` is a projection, not a history**: one row per (movement, load) carrying the best reps
  ever done at it. At a fixed load Epley rises with reps, so that row is the best set at that load and
  all three record rules follow from it — which keeps Epley out of SQL entirely. **A mark is dated by
  the SESSION it was set in**, never by `completed_at`. `marksOf` is the single exception, because
  inside one workout set instants are the only ordering there is.
- `SessionHistory` is a **domain** type although the port returns it: nothing under `domain/` may
  depend on `ports/`.

## 5. Services and the write path

Five services, one per port, none holding another: `TrainingService` (`LogRepository&`, plus
`ProgramRepository&` for the one write that freezes a plan, the clock and the token mint),
`CatalogService`, `ProgramService` (+ clock), `ThreadService` (+ clock), `PreferencesService`. Each
HTTP adapter and `GymTools` takes only the services it reads.

Each write answers with a small outcome — `StartOutcome` / `AppendOutcome` / `FinishOutcome`, a
resolved row plus a typed refusal. **Flow control never travels as a throw**; `InvalidTraining` is
reserved for malformed input.

**`start`** — auto-close any stale open session → **resolve what the store already holds for this
caller**: their own row under that id, else whichever session is open for them, decided by their
stated intent → and only when it holds nothing they are entitled to, **freeze the plan** if the start
named a routine (loaded owner-scoped; absent or another account's → `unknownRoutine` → 404) → insert
with a bare `ON CONFLICT DO NOTHING` (**deliberately untargeted**: it must no-op on either arbiter —
the PK replay and the one-open partial unique index; `ON CONFLICT (id)` would raise on the double-tap)
→ resolve the same two reads again, because the insert may have lost a race.

- A replayed POST returns the same session, open or finished; a double-tap that minted two ids returns
  the first tap's session. When nothing of this caller's resolves and nothing is open, the insert
  no-oped on another account's row: `idTaken` → 409. The service never invents a session the store did
  not accept.
- **The routine is loaded only on the path that creates a session.** Freezing at the top of the call
  made a replay and a join answer `404 no such routine` for a session sitting in the store — terminal
  by the ladder, so a flush queue dropped a start that had landed.
- **The join is the caller's intent, stated on the wire** (`joinOpenSession`, default `true`). A
  caller that says it will not join and finds another session open gets `alreadyOpen` → 409. Its own
  id still answers first, so a replay is idempotent in both modes.
- **Pressing Start cannot re-plan a running workout**: both branches that answer with a session the
  store already holds answer with ITS stored snapshot, whatever `routineId` the call carried.

**`append`** — load the session (absent or another's → not found) → construct the domain `Set` (throws
→ 400) → **resolve the replay before any refusal** via owner-scoped `setOf(user, id)`. A row stored
under that id *in this session* is the answer, whatever state the session is in now; a row under it in
a **different** session is `idTaken` → 409. Only a genuinely new id reaches the insert, and **the
insert is where every remaining refusal is decided**: `FOR UPDATE` on the session row, then `max+1` in
the next statement, `ON CONFLICT (id) DO NOTHING`, then a read-back scoped to **(id, session_id)**.

- One fact must not be decided in two layers: a service-side `finished` check answered `finished` for
  an id the store would have answered `deleted` for, telling a queue that a set it had logged never
  reached the log.
- **Drain oldest-first.** Into a session closed as STALE a set lands only within four hours of the
  close's last activity, and each landing moves that activity forward, so a queue draining
  newest-first can hand its newest set a terminal 409 before the sets that would have made room.
- **A set id is spent once and for good.** `setOf` reads the rows that STAND, so a deleted set resolves
  to nothing and would fall through to the insert. The insert therefore asks `gym_set_revisions`, under
  the session's lock and scoped to its owner, whether the id names a deleted set — **before** the
  `finished` refusal, and under its own word rather than `idTaken`, because the repairs are opposite: a
  spent id is repaired by minting a fresh one, which is exactly how a deleted set would come back.
- **Visibility is checked on the WRITE, not inferred from the FK.** Every write naming an exercise id
  carries the catalog read's own predicate — `id = $1 AND (created_by IS NULL OR created_by = $2)` —
  inside the open transaction, resolved against the owner read off the locked session row (or off the
  routine, for a plan entry). Without it a set could name another account's private movement, and the
  log, the export and the coach share would print that account's private name.
- **The finish boundary.** A set that already landed lands again; a set that never landed may not land
  after the session is closed (409). The contract for the device is **flush before you finish**.

**`finish`** — load → `canFinishAt` or `badInstant` → 400 → set `finished_at` if null; a replay returns
the stored session unchanged. The read-back after the close is checked like the load before it: an
empty one is `notFound`, which is what actually happened — a discard from another device won the race.

**`fixSet` / `deleteSet`** — load the stored row owner-scoped (`setOf`) → hand it to the pure rule
(`corrected(stored, fix)`) → write what the rule returned. The rule refuses a value the store cannot
hold, and is where *what a fix may not change* is stated once: the movement, the instant, the set
number and the session are copied across by construction.

- **The session in the path has to hold the set.** Absent, another account's, and this account's set in
  a different workout are one empty reply → `404 set-not-found`, terminal for a queue.
- **Nothing is refused for a finished session** — a lifter reads the log after the workout, which is
  when they see the 4 they meant to log as a 5. Neither write settles staleness, and neither touches
  `gym_sessions.plan` or a routine entry.
- **The delete answers nothing at all**, so a client whose reply was lost resends and gets the same
  204. Two devices correcting one set leave the second one's values standing; every version either
  replaced is kept.

Every other write returns the resolved row, so a client that lost a race or replayed sees the winning
truth in one round trip — and where there is no row it is entitled to, a refusal, never a row it is not.

## 6. Ports

Five structs, each file carrying its own DTOs. `LogRepository`: `open` · `session` · `setOf` ·
`lastActivity` · `insertSession` · `close` · `insertSet` · `updateSet` · `deleteSet` · `log` ·
`setsOf` · `lastTime` · `lastSets` · `historyFor` · `movementHistory` · `trainingLog` ·
`exportedSets` · `deleteSession` · `insertShare` · `revokeShare` · `sharedSession`.
`CatalogRepository`: `catalog` · `insertExercise` · `renameExercise`. `ProgramRepository`: `routines`
· `routine` · `routineHistory` · `insertRoutine` · `replaceRoutine` · `deleteRoutine` plus the ledger.

- **Every method that can resolve a row carries the credential that may see it** — a `UserId`
  everywhere but `sharedSession`, where an unguessable token stands in its place, and where revoked,
  expired and never-minted are one value so nothing above can tell them apart and neither can a
  prober. That includes `setOf`: a client-minted id is a guess anyone can make. `insertSet`'s
  read-back is scoped to `(id, session_id)`, so an id spent outside this session resolves to nothing
  rather than to that row.
- **Every refusal crosses the port as a value** — `SetInsertOutcome` (`idTaken`, `unknownExercise`,
  `finished`, `deleted`), `LastTimeOutcome`, `RoutineWriteOutcome`, `ExerciseInsertOutcome`. The
  catalog and the session's close are facts only storage can know, so the Pg adapter asks and answers
  them in the same transaction rather than letting a `pqxx` exception reach the HTTP edge. The foreign
  key is a backstop, not the mechanism — an FK cannot tell an id that does not exist from one that
  belongs to somebody else.
- **One outcome serves both routine writes**: `insertRoutine` answers `idTaken`, `replaceRoutine`
  answers `notFound`, `unknownExercise` is either one's. The service hands it straight back.
- `LastTimeOutcome` exists because `lastTime` has two empty answers — never trained, and no such
  movement — and only the store can tell them apart.
- `SessionSummary` carries both set counts (`setCount` is every row; `workingSetCount` is what the log
  screen prints), the clamped `tonnageKg`, the movement names, the session's `topSet`, its
  `workingMarks` dated by the session's start, and `closedItself`. `LogPage` adds `standing` — the
  projection over everything FINISHED before the page's oldest row, narrowed to its movements, because
  a record is judged against the history before its session and page two has history page two cannot
  see. The application puts `topE1rm` and `record` on the row afterwards: those are RULES, not
  aggregations, and the store never sees Epley.
- `historyFor` returns a **domain** value, one read in one transaction, loading the comparison session
  only for a session that named a routine.
- The **export's row is text end to end**, because a CSV is text and every rendering in one is a
  decision Postgres already makes better than C++ would.
- The **share's DTOs name no account and hold no id at any depth**.
- **The Postgres mapper clamps every instant it reads** into the band §4.1 accepts.
- **`Fakes.h` applies the same rules as the SQL** — the PK no-op, the partial-unique open-session
  refusal, max+1 numbering, the owner scope on every read, the session-scoped read-back, and the
  owner-scoped catalog check reported as the same typed fact.

## 7. Reads

**The log** (`log` + `setsOf`) — sessions newest-first, keyset-paged on the **pair**
`(started_at, id)` (`?before=<ms>&beforeId=<id>&limit=`, default 50, cap 200). Detail is per-exercise
grouping in first-performed order, assembled client-side from numbered sets.

- The row's derived facts ride the same statement, so the list never loads a session's sets. `topSet`
  is a lateral over the session's **working** sets — heaviest, ties to more reps, never volume, absent
  for a session holding none.
- **`tonnageKg` is `sum(greatest(weight_kg, 0) * reps)` over the working rows.** The clamp is what
  makes it printable, since band-assisted work stores a negative kg; an assisted or bodyweight set
  contributes zero. **A session or week whose tonnage is zero shows nothing where the tonnage would
  go, never `0.0 t`.** Weeks are the client's own fold over the page it holds — there is no week
  endpoint — so the oldest loaded week omits its tonnage until more is loaded.
- **`topE1rm` is `topE1rmOf` over `workingMarks`**, not Epley over `topSet`; absent where Epley is
  undefined. **The wire's doubles are doubles**: it is rounded to one decimal as a *value*, the JSON
  text is not, so `20.7` can cross as `20.699999999999999`. Every surface parses and formats; nothing
  prints the raw token, re-rounds, or re-derives the estimate.
- `closedItself` reads `closed_by`, falling back to the auto-close signature
  (`finished_at = coalesce(max(completed_at), started_at)`) for rows closed before the column existed.
- **The cursor is the previous page's last row, both halves**, because `started_at` alone is not unique
  and an instant-only cursor puts one of two same-millisecond sessions in no page, ever. `beforeId`
  without `before` names no row and is a bad cursor. Movement names come back one row per movement,
  never as one separated string — a display name is user text.

**Last-time prefill** — `GET /v1/gym/last?exercise=`: the most recent **finished** session containing
the exercise, and its sets in order.

- **The locator walks SESSIONS, newest first** over `gym_sessions_log`, `LIMIT 1` at the first finished
  session holding a non-warmup set of the movement, on the same `(started_at, id)` key the log pages
  on, so the two reads cannot name a different newest session. Walking SETS by `completed_at` — the
  device's wall clock — let one future-stamped set pin "last time" to a stale session. Both indexes
  still do work; the planner picks by selectivity.
- **Finished, never open — and this read settles nothing.** It fires on every movement change, and the
  only open session it could reach is the caller's own live workout.
- **Warmups are not history.** The block is the session's non-warmup sets, and every consumer excludes
  them. The filter is not a renumbering: a block behind a warmup starts at set 2.
- **The routine name comes out of the frozen snapshot**, type-checked
  (`jsonb_typeof(plan->'routine') = 'string'`), because `->>` would render an object or a number as
  TEXT into the product's highest-value pixel.
- No domain rule: last time is a query, not a calculation. The prefill arithmetic is client state.

**The picker's meta** (`lastSets`) — `GET /v1/gym/exercises/last`, that read over every movement at
once: one line per movement, the **last row of its last-time block**, dated by the session's start.
One `DISTINCT ON (exercise_id)` whose inner `ORDER BY` *is* the locator's rule. It is a **second read
and not four columns on the catalog row**, because the catalog is 64 rows read on nearly every screen
and `list_exercises` hands the same row to an agent; it is **sparse**, and a movement with no line is
the picker's `never logged`.

Measured on local Postgres 14 at `work_mem = 4MB`: the plan hash-joins the account's sets to its
sessions and sorts every qualifying row once — 1 600 sets ~2 ms, 19 000 ~23 ms, 38 000 ~53 ms with a
3 MB spill to disk. The plan shape never changes; the sort crosses `work_mem` in the low twenty
thousands of working sets. **Do not drive it off the catalog**: the same rule as a `LATERAL` per
catalog row measured 0.72–1.37 s at that size, because proving "never logged" for an untrained
movement walks every session the account ever ran. Driven off the movements the account has *touched*
the same `LATERAL` measures ~9 ms, and is the noted fallback if the spill starts to matter.

**The plan** (`routines` + `routine`) — most recently trained first, never-trained after them. The sort
instant is read off the log (`max(started_at)` per routine), not out of a column; ties fall back to
`(position, id)`.

**A movement's record** (`movementHistory` + the pure `movementRecord`) — four statements in one
transaction. The first is the catalog's own predicate: no row means `404 no such movement` and the
other three never fire. The **ladders** are `DISTINCT ON (session, load)` over the movement's working
sets in finished sessions, oldest first; the tiles, the twelve weeks of bars and the record ladder are
computed from them by `topE1rmOf`. Their window is a **lifetime** — only the chart is windowed, by the
domain. The **recent days** are a separate statement because the ladder collapses a session's sets and
the page prints them; warmups are excluded. The fourth statement is the days of the program that name
the movement, by name, deduplicated and in program order — `routineCount` is that list's length.
Everything is dated by the session's own start. The record **ladder** is every session whose best
estimate beat every session before it, newest first, and the first is not on it. Where Epley is
undefined there is no best-e1RM tile, no chart and no ladder. Every list is **omitted from the wire
when empty**, so an untrained movement answers 200 with two zero counts and nothing else.

**The finish** (`historyFor` + the pure `review`) — one read behind one rule. The read is a projection:
`DISTINCT ON (exercise_id, weight_kg)` over the working sets of finished sessions that started earlier,
ordered `reps DESC, started_at ASC`, restricted to the movements this session works, so the mark is
dated by the earliest session those reps were hit in. **Both of its windows compare the pair
`(started_at, id)` against the reviewed session's own**, which excludes the session from its own
history — the review is always read *after* the finish, so without it every set would tie itself and
the record would vanish on the first read. Nothing is stored; the review is recomputed on every call,
which keeps it right when a set arrives late from a flush queue, and is why there is no `ReviewService`.

**The statistics engine** (`trainingLog` + the pure `statistics`) — `GET /v1/gym/stats`, no parameters.
**It is an engine and not a room**: no client draws a statistics surface, and its readers are the
record page's rules and any agent asking the long question, so do not clean this read up as orphaned.
Three statements in one transaction:

- The **series** is `DISTINCT ON (exercise_id, started_at, id)` over the working sets of finished
  sessions, keeping the heaviest with the most reps — `TopSet`'s rule, in SQL because it is an
  **ordering**; the Epley estimate over it is in the domain because it is a **formula**. Every point is
  dated by the session's own start.
- The **marks** are `historyFor`'s projection with both windows removed, and the two standing bests
  (highest e1RM, heaviest load) are the *prior* halves of the finish's record rules asked with no
  session to compare against. A best is dated by the session too. The third record rule has no standing
  form: with nothing to compare against, every mark already is the best reps at its load.
- The **weeks** are counted in Postgres, truncated `AT TIME ZONE 'UTC'` rather than in the server's
  zone (`date_trunc` on a `timestamptz` reads the session TimeZone, so the same log would bucket
  differently on a laptop and in CI). `generate_series` fills the run, so a week nobody trained is a
  **zero and not a missing row**. Weeks run Monday-to-Monday in UTC.

**Finished sessions only**, and this is one of the doors that settle staleness — or a workout the
four-hour rule ended would be a hole in the chart.

**Cut, and staying cut:** muscle-group volume and any taxonomy for it, streaks, any cardio or duration
axis, volume **as a metric** (a headline, a tracked series, a ranking key), and any grade, score,
percentage or green/red. That refusal is of volume as a metric, not of the log's tonnage caption.

**Export** (`exportedSets` + `toCsv`) — CSV of every set this account holds, the open session included.
One shape, no parameters, no pagination, nothing omitted, a fixed filename. **Every value crosses the
port as text**: instants as ISO-8601 UTC, numerics at their column's scale so 72.5 kg is `72.50`
forever, an absent rpe as an empty cell. That leaves `TrainingCsv` one thing to decide — framing — by
RFC 4180: CRLF between records, a field quoted only where it holds a comma, a quote or a line break,
and a quote inside a quoted field doubled. A note travels byte for byte, with one exception: **a cell a
spreadsheet would RUN rather than show** — one opening `=`, `@`, or a sign in front of something that
is not a number — carries a leading apostrophe, because a movement name and a note are writable by any
MCP client granted `gym:write` and an Ask turn is composed by a model. A negative load is untouched.
This read settles **nothing**, alone among the reads of the log.

**The coach share** — two owner-scoped doors and the one unauthenticated read.
`GET /v1/gym/shared/{token}` resolves the token to one session and its sets; the token is the whole
credential, so the handler never resolves a caller and **never writes**, not even the four-hour close.
**Revoked, expired and never-minted answer one 404, byte for byte**, and the second statement fires
only when the first found a session. **The body names no account and holds no id at any depth**;
movements travel as their display name, the routine name comes off the session's frozen snapshot, and
the frozen plan itself does not travel.

## 8. Wire

### 8.1 HTTP routes

Five adapters mirror the five ports, plus `AskApi`. `routes.cpp` names every path in this order.

| Method & path | Purpose |
|---|---|
| `GET  /v1/gym/exercises` | the catalog (seeds + own customs), each under the name THIS account calls it |
| `GET  /v1/gym/exercises/last` | the picker's meta — `{exerciseId, weightKg, reps, at}` per trained movement, none for the rest |
| `POST /v1/gym/exercises` | create — `{id, name, pattern, equipment, stepKg?}` |
| `PATCH /v1/gym/exercises/{id}` | rename — `{name}` and nothing else |
| `GET  /v1/gym/exercises/{id}/record` | a movement's record: two tiles, twelve weeks of bars, the record ladder, recent days, the days of the program that name it — ONE read |
| `POST /v1/gym/sessions` | start — `{id, startedAt, joinOpenSession?, routineId?}`, idempotent |
| `POST /v1/gym/sessions/{id}/sets` | append — `{id, exerciseId, weightKg, reps, completedAt, kind?, rpe?, note?}` |
| `PATCH /v1/gym/sessions/{id}/sets/{setId}` | fix — `{weightKg?, reps?, kind?, rpe?, note?}`; answers the stored row. `404 set-not-found` covers absent, another account's and this account's set in another workout; `400 fix-unreadable` covers a field a fix may not carry (`exerciseId`, `completedAt`, `setNumber`). **No MCP tool at any level** |
| `DELETE /v1/gym/sessions/{id}/sets/{setId}` | delete — `204`, and `204` on retry; refuses nothing. **No MCP tool at any level** |
| `POST /v1/gym/sessions/{id}/finish` | close — `{finishedAt}`, idempotent |
| `GET  /v1/gym/sessions?before=&beforeId=&limit=` | the log, newest first |
| `GET  /v1/gym/sessions/{id}` | one session with its sets; 200s carry a weak `ETag`, a matching `If-None-Match` answers 304; settles staleness |
| `GET  /v1/gym/sessions/{id}/review` | the finish surface — three facts, at most one record, the comparison |
| `DELETE /v1/gym/sessions/{id}` | discard — `204`; `409 session-open` while it is still running |
| `GET  /v1/gym/last?exercise=` | last-time prefill |
| `GET  /v1/gym/routines` | the plan, most recently trained first — each carrying `revision` and the `pendingProposal` waiting on it |
| `POST /v1/gym/routines` | create — the whole document, idempotent on its id |
| `GET  /v1/gym/routines/{id}` | one routine plus its `history`; the LIST read carries none of it |
| `PUT  /v1/gym/routines/{id}` | replace — the whole document. Moves `revision` and supersedes pending proposals only when the document or the name moved. May name the `revision` it read; a day that moved answers `409 routine-stale` unless the bytes already stand |
| `DELETE /v1/gym/routines/{id}` | `204`; entries, proposals and change rows cascade, sessions keep their snapshots |
| `GET  /v1/gym/proposals` | the ledger, newest first; `?routineId=`, `?state=pending` |
| `GET  /v1/gym/proposals/{id}` | one proposal with its typed diff |
| `POST /v1/gym/proposals/{id}/apply` | **the tap.** All of it or none, against the frozen base revision. `{proposal, routine?}` — `routine` absent when the proposal removed it |
| `POST /v1/gym/proposals/{id}/dismiss` | no reason asked for, nothing changed; stays in the routine's history |
| `GET  /v1/gym/preferences` | the one read in gym that cannot 404: no row means the DEFAULTS |
| `PUT  /v1/gym/preferences` | replace it whole; omitted fields take their default |
| `GET  /v1/gym/stats` | the statistics engine — per-movement line, standing bests, weekly counts |
| `GET  /v1/gym/export` | every set, CSV — `text/csv`, a header row, `Content-Disposition: attachment` |
| `POST /v1/gym/sessions/{id}/share` | mint — `{token, expiresAt}`, idempotent on the session |
| `DELETE /v1/gym/sessions/{id}/share` | revoke — `204`; nothing to revoke is `404 no such session` |
| `GET  /v1/gym/shared/{token}` | **the one unauthenticated route.** Revoked, expired and unknown are one `404` |
| `GET  /v1/gym/export/threads` | every turn of every conversation, CSV — one row per turn |
| `GET  /v1/gym/threads` | `{threads:[{id,title,createdAt,askedAt,outcome,proposals}]}`, newest asked first, bounded at `kThreadList` (200), no total and no "there are more" flag. No turns. Mounted unconditionally |
| `GET  /v1/gym/threads/{id}` | one conversation whole, `turns` and all |
| `DELETE /v1/gym/threads/{id}` | `204`; turns cascade, and every proposal it minted keeps its row, state and place in the routine's history, losing only `source.thread` |
| `POST /v1/gym/ask` | **the one conditional route.** `{thread, question}` in, `{answer, steps, read:{sets,sessions,weeks}, proposals:[id], thread}` out. Absent with no `ANTHROPIC_API_KEY` |

### 8.2 Shapes

`adapters/json/TrainingJson` is the one cross-surface codec — web, iOS, Android and the MCP tools all
speak it, which is why a tool's arguments are the REST body's field names. The exports speak CSV.

Instants are epoch-ms numbers, weights numbers in kg. Sets are
`{id, exerciseId, setNumber, weightKg, reps, kind, rpe?, note, completedAt}`; sessions
`{id, startedAt, finishedAt?, routineId?, plan?}`; routines
`{id, name, position, revision, lastTrainedAt?, entries:[{position, exerciseId, targetSets?,
targetReps?, targetWeightKg?, restSeconds?}], pendingProposal?, history?}`. List replies wrap
(`{"exercises":[…]}`, `{"sessions":[…]}`, `{"routines":[…]}`, `{"proposals":[…]}`); detail is
`{"session":…, "sets":[…]}`. A log row is a session plus `{setCount, workingSetCount, tonnageKg,
exercises:[…], topSet?: {weightKg, reps}, topE1rm?, record, closedItself}` — `record` always present.

A proposal's head is `{id, routineId, intent, state, summary, changeCount, createdAt, settledAt?,
source:{door, connection?, agent?}}`; the whole adds `{baseRevision, baseName, name,
changes:[{position, kind, exerciseId, before?, after?, loggedSets?}]}`, each side
`{sets, reps?, weightKg?, restSeconds?}` — `before` absent on an added line, `after` on a removed one,
`loggedSets` on removed lines alone. `revision` is read-only on the wire.

Parsing type-checks every jsoncpp field before `.as*()` and throws `InvalidTraining` → 400.
**Instants are bounded at the wire**: a UInt64, never `0`, never past `kMaxInstantMs`, which is also
the log cursor's "no cursor: from now".

Absences that carry meaning:

- **An absent `targetReps` is `max`** and an **absent `targetSets` is `open`** — omitted in and out, on
  the routine entry, the frozen plan's line, the review's `planned`, and a proposal's two sides. On a
  diff row, which side is missing is `kind`'s to say, never a null.
- **An absent `lastTrainedAt` is `untested`.** No field beside it says so.
- **`history` rides on the single-routine read alone.** Rows are `{kind:"created", at, by?, movements?}`
  and `{kind:"proposal", at, proposal}`, newest first with the creation row last. `by` absent means the
  lifter's own hand; `movements` is how many lines the day was created with.
- **A routine's entry order IS the routine's order.** Entries in carry no position; the codec numbers
  them `1..n` from arrival order. On `PUT` the **path** names the routine.
- The prefill reply echoes `exerciseId` (the client re-reads on every movement change, so a late reply
  must be discardable), omits `routine` for an ad-hoc session, and omits `session`/`sets` together for
  a first-ever movement — **200 naming the movement and nothing else**, which is what the card draws
  "First time logging this" from. `sets` is never present and empty.
- The review, the statistics reply and the share travel **one way** and have no parse half. The review
  omits `topE1rm` when nothing was loaded, `record` on a session that earns none, `before` when the
  movement was not trained last time, `planned` when the frozen plan did not name it, `against` for an
  ad-hoc session or one with no earlier match, and `routine` when the session it stands against carries
  no name; `slight` says the session was too short to say anything honest, and then `record` and
  `against` are both omitted. The statistics reply omits `e1rm` on a point or a best whose load has no
  honest estimate, and `weeks` is contiguous. The share's body carries no id at any depth:

```json
{ "startedAt": 1700000000000, "finishedAt": 1700003600000, "routine": "Legs",
  "sets": [ { "exercise": "Back Squat", "setNumber": 1, "weightKg": 105, "reps": 5,
              "kind": "working", "note": "", "completedAt": 1700000060000 } ] }
```

### 8.3 The status ladder

The status alone is not enough for a flush queue to act on: of the 409s, three mean *mint a new id and
send it again*, one means *drop this set forever*, and the rest mean *a new id will not help*. So every
refusal a client must branch on carries a machine word under `code`
(`platform/adapters/http/JsonReply.h`).

| Status | `code` | When | What the client does |
|---|---|---|---|
| 401 | — | no caller | sign in, then replay the write |
| 404 | — | the session, routine or proposal is absent **or** another account's — one fact | terminal; re-read the list |
| 400 | — | unreadable or unstorable *as written*: bad json, bad field type, a malformed id, an instant out of bounds, a bad cursor, a prefill read naming no movement, a close instant running backwards | terminal |
| 400 | `unknown-exercise` | a set, routine entry or prefill read names a movement **this account's** catalog does not hold | terminal — resolve against `GET /v1/gym/exercises` first |
| 400 | `clock-ahead` | a start that would CREATE a session more than five minutes past the log's now; replays and joins exempt | terminal — the fix is the clock |
| 409 | `session-id-taken` | start with a session id spent by an account this caller cannot see | mint a NEW session id and start again |
| 409 | `session-already-open` | start that said `joinOpenSession: false` while another session is open | wait for the open workout to end, then resend |
| 409 | `routine-stale` | a PUT that NAMED the revision it read, over a day that moved since, whose bytes would move it | re-read the routine and save again |
| 409 | `set-id-taken` | append a NEW set id already spent outside this session | mint a NEW set id, resend the set |
| 409 | `set-deleted` | append an id naming a set **this account deleted** | terminal — drop the set. **Never a re-mint**: a fresh id is how the deletion would undo itself |
| 409 | `session-finished` | append a NEW set after the lifter's own finish, or more than four hours past a stale close's last landed set | terminal |
| 409 | `routine-id-taken` / `exercise-id-taken` | create under an id another account holds, or a seeded slug | mint a NEW id and resend the same document |
| 409 | `session-open` | discard a session that is still running | wait for the workout to end |
| 409 | `proposal-superseded` | apply or dismiss a proposal whose routine moved after the diff was written | terminal — draw the routine as it now stands |
| 409 | `proposal-settled` | ask for one decision on a proposal that already took the OTHER one | terminal — re-read. Asking for the decision it DID take replays 200 |
| 409 | `ask-thread-taken` / `ask-thread-full` / `ask-session-open` | another account's thread id; a thread at `kMaxThreadTurns`; an ask mid-workout | open a new thread / wait |
| 429 | `ask-daily-limit` / `ask-out-of-budget` | the day's ration or the platform ceiling | wait |
| 503 | `ask-not-configured` | `POST /v1/gym/ask` where no model is configured | terminal. A 503 WITHOUT this code is a proxy or a restart, and asking again is the repair |
| 502 | — | the model did not answer | retryable |
| 500 | — | a storage failure — dropped connection, statement timeout, deadlock | retryable — keep the set queued |

- **The code is the contract; the sentence is for a human reading a log.** A client that told the 409s
  apart by string-comparing copy degrades to "terminal, reason unknown" the first time one is reworded.
  `set-id-taken` and `set-deleted` are the sharpest case: same status, same shape, opposite repairs.
- **Every `…-id-taken` names a fact about an id, never about an owner**, and none fires on the caller's
  **own** id: a replayed create of a session, set, routine or movement reads back what landed.
  `409 session-finished` answers **new** ids only.
- The 400s are the client's and terminal; the 500 is the server's and retryable, which is why the write
  handlers catch **only** `InvalidTraining` — a `catch (const std::exception&)` around the same call
  told a queue that a five-second lock wait was a malformed set.
- There are no admin doors, nothing sweeps and nothing mails.

## 9. MCP tools

`adapters/mcp/GymToolCatalog` declares, `adapters/mcp/GymTools` dispatches. Sixteen tools: `tools/list`
is the biggest fixed cost of a connection, so a tool a parameter on another tool could serve does not
get a slot. **The level is declared beside the description**, in the same `ToolDeclaration` the gate
reads, so a tool cannot be described as one thing and gated as another.

| `gym:read` | `gym:write` | `gym:delete` |
|---|---|---|
| `list_exercises` | `start_session` | `discard_session` |
| `list_sessions` — the log, paged | `log_set` — one set into an open workout | `propose_routine_removal` — **deletes nothing** |
| `get_session` — one workout + its sets (`review: true` adds the finish readout) | `finish_session` | `revoke_share` |
| `last_time` — the prefill | `create_routine` — a NEW day; **lands immediately** | |
| `list_routines` — all, or one by `routineId`; carries `pendingProposal` | `propose_routine_change` — **changes nothing** | |
| `get_stats` — all movements, or one by `exerciseId` | `create_exercise` | |
| | `share_session` — `{url, token, expiresAt}` | |

The names carry the record/intent split: a day of the program that does not exist yet is `fresh` and
`create_routine` writes it; a day that already stands is `existing` and the two `propose_` tools mint a
diff and write nothing. **The receipt is never shaped like a write** — it carries the proposal, its
`state`, the typed diff and a `reviewUrl`, and no routine at all, so an agent cannot tell its human the
program changed. **Retired names answer with their replacements** (`GymTools::retiredTools()`,
consulted only after a name misses the live catalog, by `CompositeToolHost` over MCP and `AskTools`
in-process); `gymInstructions()` carries the same retirement in the connect handshake.

- **No apply tool at any grant level.** Apply is not a capability, it is a human act: `gym:delete`
  proposes destructive changes and does not imply the right to make one. The two routes that settle a
  proposal are HTTP and owner-scoped, `ProgramService::replaceRoutine` is unreachable from `GymTools`,
  and `GymToolsTest` pins those absences by name.
- **`PATCH` and `DELETE` on a set have no tool either**: *no agent may edit or delete a logged set —
  not under `gym:write`, not under `gym:delete`, not at any level a future grant invents.* The reason
  is written beside the two mounts in `routes.cpp`, and `GymToolsTest` pins the absence by name.
  `GET /v1/gym/export` has no tool because `list_sessions` + `get_session` + `get_stats` already give
  an agent those numbers in a shape it reads.
- **Every tool goes through a service, never the repository** — `TrainingService`, `CatalogService`,
  `ProgramService`. No tool reads a thread or the settings. The tools are a second *door on the same
  core*, not a second client of the HTTP API.
- **Every tool acts as the caller.** The `ToolCaller`'s `UserId` scopes every read and write, exactly
  as `callerOf(req, auth)` scopes the handlers. An agent is never an admin.
- **The refusals are the HTTP ones in words a model can act on**, each naming the tool that answers the
  question it should ask next. The domain's `InvalidTraining` sentence is forwarded **verbatim** here,
  where the browser edge flattens every one into `could not read that set`.
- **Client-minted ids, said out loud in the description**, on all six write tools that take one, each
  saying a replay answers with the stored row. **A replay is the same id carrying the SAME document**;
  the two document-carrying tools refuse a spent id carrying a different one.
- **A read's own fields survive the write that takes them back.** Duplicating a day is reading one with
  `list_routines` and sending it back under a fresh id, so `position`, `lastTrainedAt`, `revision` and
  `pendingProposal` are declared on `create_routine` and ignored. `additionalProperties: false` is
  enforced by `CompositeToolHost`, and strictness that refuses the document we ourselves emitted is an
  outage.
- **`delete` is never merged into `write`.** Two tools may merge where a parameter does the job
  (`list_routines`, `get_stats`) but never across levels, and no read is reachable through a
  write-classified name.

The grant is the platform's: `CompositeToolHost` filters `tools/list` by scope, refuses an out-of-scope
call naming the missing `gym:<level>`, refuses an argument no schema declares, and refuses a duplicate
tool name **at boot**.

## 10. Composition

- **CMake:** `windmill_gym` = the `domain/*.cpp` plus the five `application/*Service.cpp`, linking
  `windmill_platform PUBLIC`; adapters + `routes.cpp` folded in via `target_sources` under the
  `Drogon_FOUND AND libpqxx_FOUND` guard; `windmill_gym` on the four `target_link_libraries` lines
  (domain tests, server, adapters tests, mcp tests). Tests are **appended to the existing executables**
  — a new binary means editing the Dockerfile's `--target` list.
- **Dockerfile:** untouched. `windmill_server` statically absorbs the lib; `schema.sql` rides at
  `/app/db/schema.sql`.
- **main.cpp:** the five Pg repositories, the five services, `GymTools` and `GymDeps`. The core is
  built **up with the MCP surface**, because the composite host is constructed before the server takes
  traffic and gym's tools have to be in it (`ToolModule{*gymTools, gym::gymInstructions()}`); the
  `gym::registerRoutes(app, gymDeps)` mount stays down with the other products'. One core, two doors:
  the tools and the routes hold the *same* services, so a rule cannot be true on one surface and not
  the other. `appBaseUrl` exists to turn a minted share token into a URL; `*tokens` exists to mint that
  token from the same mint that makes a session cookie. Tending is deliberately NOT given the
  composite. Gym arms no ticker, reads no env var and contributes nothing to the mail list.
- **`PgAccountFootprint`'s owned list** carries `gym_sessions`, `gym_sets`, `gym_routines`,
  `{"gym_session_shares", "user_id"}`, `{"gym_exercises", "created_by"}`,
  `{"gym_exercise_names", "user_id"}`, `{"gym_exercise_aliases", "user_id"}`, the two proposal tables
  and the two thread tables. The exercise column is `created_by` and **not** `user_id` precisely
  because the 64 seeds carry it NULL — a probe matching the seeds would report every account non-empty
  and break the delete door. `gym_preferences` is deliberately off the list.
- **Tests** live in `test/products/gym/` mirroring the tree, with full assertions. `GymToolsTest` rides
  in `windmill_mcp_tests`; the rest are in the domain and adapters binaries. Targets unique to this
  surface: the whole (tool → level) table pinned in order, `tools/list` shrinking to exactly what a
  grant named, a stranger refused by the same one fact an absent row gets, a replayed client-minted id
  answering with the stored row, and every refusal sentence pinned whole. Pure targets: every
  `autoCloseAt` branch; `Set` bounds (negative weight legal, reps 0 illegal, unknown kind thrown);
  `Exercise` bounds; `Routine` bounds; start idempotency (replay, double-tap two-id join, stale
  auto-close on start, the join that keeps the open session's own plan, the replay and join that
  outlive a deleted routine); append numbering; strict-parse/clamped-read of `SetKind`; the plan
  snapshot's round trip. Pg mapper rows are `template <typename Row>` (the pqxx `row_ref`/`row`
  mac-vs-CI split).

## 11. Two surfaces — the phone writes, the web reads

The capture device is the **phone app** (native iOS · Android); the web app is everything else. This is
a decision about where the product puts a control, **not a rule on the wire**: every route and every
tool stays owner-scoped and surface-blind, because `tools/lift-import` writes sets over the same public
API and the MCP tools write through the same services.

| | Phone | Web |
|---|---|---|
| owns | the **open** session | everything retrospective and prospective |
| | workout mode, keypad, ladder, sticky carry-forward, rest timer, wake lock, the flush queue | the log, progression, the routines editor, export, MCP connect, settings, backfill |
| writes | `gym_sessions` · `gym_sets` | `gym_routines` · `gym_routine_entries`, and past sessions only |

**The mirror.** Web renders the live session as it happens (`web/src/products/gym/Today.jsx`) off the
shared read hook's poll (`useTrainingLog.js`). With no session open the slot says so in words —
*"Not training now."* over *"Workouts start on your phone."* — never a greyed-out control. It carries no
install door: neither phone room has a store listing. **The mirror never says "resting"**: the rest
target is device-local, so the server cannot know whether 1:47 is a rest running or a rest over, and
the band says the digits under a label it can stand behind — *last set 1:47 ago*.

### 11.1 Sync

1. **Phone → server (the write).** Client-minted `set_<hex>`, offline queue, replay in any order any
   number of times, `ON CONFLICT DO NOTHING`, flush before finish. The living statements are
   `SetQueue.swift` and `SetQueue.kt`, which branch the 409 codes the same way: `set-id-taken`
   re-mints, `session-id-taken` re-mints, `session-finished` drops, every other 409 is terminal and
   said. The web holds no set queue at all.
2. **Server → web (freshness).** No new endpoint. Web boots on the log read — which also settles a
   stale open session — finds the open session, then polls `GET /v1/gym/sessions/{id}` every five
   seconds while the tab is visible, stopped when hidden, refetched on `visibilitychange`.

   The **weak `ETag`** is over `(startedAt, finishedAt, a fold of the sets as the reply renders them)`.
   The fold must cover anything a poll could act on: a **correction** moves no count, no last instant
   and no `finished_at`, so a tag built from counts would answer 304 over a weight that had changed.
   `startedAt` leads, so a session discarded and recreated under the same id cannot answer the dead
   workout's tag with a 304. `If-None-Match` is read per RFC 9110 §13.1.2. The tag lives at the HTTP
   edge (`TrainingApi.cpp`); `TrainingService` stays wire-blind and the MCP tools never see it. The 401
   and the 404 never carry it. **No socket**: a set lands once every 60–120 seconds, and polling is
   correct as written where a socket only becomes correct after its reconnect-and-replay path does.
3. **Device ↔ device handoff.** `gym_sessions_one_open` plus `start`'s untargeted
   `ON CONFLICT DO NOTHING` means a second device pressing Start **joins** the open session instead of
   minting a phantom. Carry-forward and the rest countdown are device-local, so a handoff resumes the
   log and not the timer — which the receiving device should say rather than fake.

### 11.2 Backfill

Web keeps one write door with different vocabulary: **"Add a past workout"**, never *Start*. It mints a
session with `startedAt` in the past, finishes it in the same flow, and appends sets with past
`completedAt`. Same routes, no new contract, no live session ever opened on a laptop.

**Backfill is refused while a session is open**, and the rule is on the wire rather than in a client,
because `lift-import` writes over the same public API and `start_session` writes through the service:
**`{"joinOpenSession": false}` on the start, and 409 `session-already-open` when another session is
open.** **The join stays, and stays the default**, because the handoff is built on it; what the flag
fixes is that two callers meaning opposite things used to send byte-identical requests.

Three things this rule is deliberately not: **not a surface gate** (any surface may state either
intent), **not a heuristic on `startedAt`** (a past instant looks exactly like clock skew), and **not
"refuse when the id that comes back is not the one I sent"** (ids differing is precisely the handoff).

### 11.3 Two rules that follow

**Web does not Finish a live session.** There is no web logger and no web Finish button, so no laptop
can close a session over a phone holding unflushed sets. The web's one destructive door is the
retrospective discard, which the store refuses while the session is open. Between **two phones** the
hazard remains: a Finish pressed on one over the other's unflushed sets refuses those sets forever, and
the fallback is auto-close at four hours stamped at the last set.

**The ladder is one module per language** — JS, Swift, Kotlin — and all three answer
`packages/api-contract/gym-ladder.json` as a test, so drift fails CI. Two rules that fixture pins: **the
assisted side is the exact mirror of the loaded side** — a step that lightens the load reads the band
just below its **magnitude**, `bump(−w, −direction, big) == −bump(w, direction, big)` — and **rounding
is half away from zero** in every language, because `round(−x)` must equal `−round(x)` and half-up does
not. The server stores only what was logged plus each exercise's default step.

### 11.4 The claim replay

The phone rooms open signed out: a lifter trains against local routines and a local log, and sign-in
**claims** what the device holds. The claim is pure client-side replay over the ordinary routes — no
claim endpoint, no anonymous identity, no server-side surface gate. The codes are the contract and the
order is the law. On sign-in, and on every connect while a local backlog exists:

1. **Routines first**, idempotent by their `rt_` ids; 409 `routine-id-taken` re-mints.
2. **Sessions sequentially, oldest first.** Per session, strictly: `start` with the client-minted id,
   the true `startedAt`, its `routineId` if that routine landed, and **`joinOpenSession: false` — never
   the default**. Then ALL its sets, per-(session, exercise) lane in original order — the server assigns
   `set_number` in arrival order — then `finish` with the true local `finishedAt`. **No log or stats
   reads interleaved mid-session**: those settle staleness.
3. **Verdicts by code only.** 409 `session-already-open` → wait; 409 `session-id-taken` → re-mint the
   session id AND remap that session's queued sets onto it; 401 / 404 / 5xx / offline → retry, never
   drop; 409 `session-finished` → dropped and SAID (a `RefusedSet`, never silence). Every instant must
   sit in `(0, 253402300799000]` — repair a broken local timestamp before replay, because the 400 it
   earns is terminal.
4. **Settings ride along** as one ordinary `PUT /v1/gym/preferences`; whole-document last-write-wins
   makes the device's copy win, and order does not matter against the log.
5. The live local session claims the same way minus the finish; the existing queue then owns it.
6. After a session's finish confirms, the local copy is **claimed**: the server log is the truth, and
   local reads merge server history with unclaimed-local only.

The undo window is 9000 ms on every surface. Copy may change; the verdict codes may not.

## 12. Ask

`ports/AskAgent.h` · `application/AskService` · `adapters/llm/AnthropicAsk` · `adapters/http/AskApi` ·
`domain/ReadReceipt` · `domain/Thread` · `platform/adapters/llm/AgentLoop.h`

A lifter with Claude connects it and asks. A lifter without one opens **Ask**, which asks the same
questions of the same tools. One system, two doors, differing in transport, prompt and who pays. It is
not a coach, and that word appears on no surface a lifter reads; the coach *share* is a different
object and keeps its name.

### 12.1 The narrowing

`GymTools` does not gate — over MCP the grant is settled above it by `CompositeToolHost` — so a chat
wired straight to it would be a door with no lock. **`AskTools` is that lock.** It offers every
`Access::read` declaration plus `mintsProposal(name)` — the two `propose_` tools — and refuses
everything else by reading the DECLARATIONS rather than a list of names that could drift from them. So
Ask can read the log and hand the lifter a diff, and cannot log a set, finish a workout, mint a share,
create a movement or discard anything.

The scope `AskService::ask` states — `ToolCaller{caller, ToolScope({{"gym", read}, {"gym", write},
{"gym", del}})}` — is honest wiring, not a second layer: it names who Ask acts as, one level at a time,
so a fourth level or a second product never rides along. `AskTools` reads it in `callTool` as well as
in `listTools`, which is what makes narrowing it later take tools away in fact rather than merely
hiding them. Underneath sits the structural rule: **no tool at any level edits or deletes a logged
set**, so Ask's most important refusal is not a sentence in its prompt.

`AskTools` also enforces `additionalProperties: false` itself, because Ask does not pass through the
composite; without it `get_stats {"exerciseID": …}` answered with every movement while the model
believed it had asked about one. The check is written twice today; the standing request is to hang it
off `ToolDeclaration`, where both doors would read one copy.

### 12.2 Bounds

| Bound | Value | Why |
|---|---|---|
| Grant | `gym:read` + the two proposal mints | it answers questions and proposes; it changes nothing |
| Reach | the whole log | Ask is reached from Today and from a proposal card, not from one workout |
| Never mid-session | `409 ask-session-open`, checked on the server | three clients each remembering it is three chances to forget |
| Iterations | 8, and hitting it is a **failure** | an unfinished answer is worse than "Ask didn't answer" |
| Turns | `kMaxThreadTurns` (8) per thread, `kMaxAskTurnBytes` (1000) each | the server assembles the prompt from the stored thread, so the cap bounds the side that pays. It bites on the PAIR an ask would add, so a conversation is never capped halfway through answering; the refusal is `409 ask-thread-full` |
| Entitlement | none — it ships open | Windmill One cannot be bought, so a locked Ask would advertise a 503. The gate is one predicate on the allowance line |
| Daily limit | `kAskPerDay` (10), `kAskBackToBack` (3), per **account** (`AskRation`) | stated on screen instead of hidden as a weaker model. A bucket in memory, so a deploy refills it. **Taken last and given back only when the run COST NOTHING**: the test is `AskAnswer::modelTurns` — metered vendor round trips — not `ok`, because hitting the 8-iteration cap costs eight billed turns. That return is why the bucket is gym's own and not platform's `RateLimiter`, which cannot hand a token back |
| Dollar ceiling | the platform's `AiFuse` hourly + `aiAllowanceFor` over 30 days | never shown as money to anybody |
| Vendor | absent when unkeyed | no `ANTHROPIC_API_KEY` ⇒ no `AskService` ⇒ `registerRoutes` never mounts the path |

### 12.3 The read receipt

Every answer states what it read, and **that count is printable only because the server served those
rows**, so it lives in the tool response envelope: every gym read that hands over log rows answers with
`"read": {sets, sessions, weeks}`, counted by `domain/ReadReceipt` as the rows go out. A lifter's own
Claude over MCP reads exactly the accounting the app prints.

Four rules keep it honest: it counts by **identity**, so one workout read twice is one workout; a read
that serves a SUMMARY claims only what it NAMED; a REFUSED read counts nothing; and a reply that served
no log rows says nothing at all rather than `read 0 sets`. The run's total is merged inside `GymTools`,
where the ids are — a layer above could only have summed the replies, and a sum counts the same set
twice.

**The line is a FLOOR.** Sets are claimed by `get_session` and `last_time` alone; `list_sessions` names
workouts and hands over no set rows; `get_stats` serves a projection whose points carry no session id,
so it claims its weeks and nothing else. The proposals in the reply are observed the same way:
`AskTools` takes the id off the tool's own result, never out of the answer's prose.

### 12.4 Shapes it refuses

- **No streaming.** One reply per ask does not earn a second consumer of the SSE parser.
- **No blocking the request loop.** `AskAgent::answer` blocks for as long as the vendor takes;
  `AskService` owns a two-thread pool and the handler hands its callback over, because four handler
  threads parked on a model is a training log that stops answering everybody. The run is guarded on
  that thread — nothing sits above a worker loop, and an exception leaving it would take down every
  product on the box. It becomes the same 502 a dead upstream gets, and the day's question is given
  back, because the turn count died with the stack.
- **No second loop.** The tool loop is `platform/adapters/llm/AgentLoop.h`. What stays in gym is the
  prompt and what the answer is made of; no domain code knows an Anthropic API exists.
- **It does not speak first** — no personality, no encouragement, no streaks, no daily check-in, no
  unread badge. The prompt bans a grade as firmly as the finish screen does.

Ask prints **which tools each answer came from**, in call order, and **what those tools served**.
Without that pair this would be a chatbot claiming to know things. The empty state points at the free
door — *if you already use Claude or ChatGPT, connect them instead: it is free, and it is better,
because it knows the rest of your life.*

### 12.5 Threads

- **The title is the first message, verbatim**, stored as sent, written once at creation. Nothing in
  this product summarises what a lifter typed. No auto-title, no folders, no pinning.
- **No unread count, no badge, no notification, nothing waiting.**
- **The outcome is derived, never stored** (`outcomeOf`, `domain/Thread.h`). The proposals a thread
  minted *are* the outcome; a column would go stale the first time a lifter applied a proposal from the
  routine screen. The ladder: something that landed beats something waiting, waiting beats something
  turned down, and a proposal the routine outran is the last thing left to say. A still-`proposed`
  thread minted something; a `superseded` one is the routine having moved underneath it, which is not
  the lifter turning anything down.
- **Every row's detail is something the server observed.** A dismissed row carries what was dismissed —
  the count — and nothing about why.
- **Delete deletes the conversation, not the consequence.** `gym_proposals.thread_id` is
  `on delete set null`, so an applied change stays in the routine's history and still says it came from
  Ask.
- **A question nobody answered is not a turn.** The thread row lands before the model runs, the turns
  land only once an answer has, and a run that never answered takes its own empty thread back — so a
  retry appends the question once rather than twice.
- **The question meets `storableText`** before a thread is opened, because it becomes the title we
  promised is the lifter's words byte for byte.
- **Threads are in the CSV export** at `GET /v1/gym/export/threads`: one row per turn, the outcome
  stamped on by the service rather than rendered in SQL. The outcomes are stamped from `allThreads` and
  not from the list read, which stops at `kThreadList`; the turns join is a LEFT one, so a thread
  holding no turns is in the file with empty turn columns.
- **The three read/delete doors are mounted unconditionally** while `POST /v1/gym/ask` is not: a
  deployment with no vendor key keeps every conversation readable, exportable and deletable.

## 13. Open items

- The phase-1 dogfood gate — 8 consecutive real sessions without falling back to another app, prefill
  right on set one in ≥6 — has never been run. Its capture surfaces are `apps/android` (a sideloaded
  APK off a GitHub Release) and `apps/ios` (builds and tests green, runnable from Xcode).
- iOS store distribution is blocked on signing, not code: `apps/ios/project.yml` sets
  `CODE_SIGNING_REQUIRED: NO` with no `DEVELOPMENT_TEAM`, and the declared Associated Domains
  entitlement needs a paid Apple team. `apple-identity` (`backend/AUTH.md`) is a hard prerequisite:
  Sign in with Apple without `user_identities` forks accounts on the first lifter who taps *Hide My
  Email*.
- Set-kinds UI and the rest timer are unbuilt clients over columns the backend already writes.
- Merging a typo'd custom movement onto a catalog id is an UPDATE of `gym_sets.exercise_id`, unbuilt.
- Raising the read receipt's floor needs a session id carried through `MovementTop` and the store's
  projection.
- Hanging the `additionalProperties: false` check off `ToolDeclaration`, so MCP and Ask read one copy.
- A gym mail stream, if ever wanted, is a `MailSweep` subclass plus a `Heartbeat` member and nothing
  else (`platform/application/MailSweep.h`, `platform/application/Heartbeat.h`).
- A gym money surface would need the tier copy (`PLAN_COPY`) that lives in roadmap.
