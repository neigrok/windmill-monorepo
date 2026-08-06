# Windmill Gym — backend architecture

The third room in the superapp. Roadmap is the plan you set, journal is the day you noticed,
gym is the rep you did. This document designs the **backend** for it — written before any code,
the way `products/journal/ARCHITECTURE.md` was, because the four decisions that cost a migration
later (exercise identity, session snapshots, set kinds, canonical units) are all schema decisions
and this is where they get taken.

The product thinking lives in `docs/PRODUCT_LOG.md` ("Gym — the third product"); the evidence it
is built on is `docs/lift-dossier.md`, a code-verified inventory of Lift, a shipped SwiftUI
training log. **Lift is not a codebase we migrate. It is a spec written in Swift and a bug
ledger** — every rule below that reads like paranoia is a bug Lift actually shipped.

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
   A set bound to an account, idempotent under retry, append-only. Lift protects data with more
   code than it presents data with, and still ships a path that deletes a user's entire history
   to recover from a corrupt store. Server-as-truth is not a feature of gym; it is the reason
   gym exists here. (§3)
2. **Exercise identity** — a seeded catalog of stable ids. Every structural bug in Lift traces
   to one line: an exercise is a display string. (§4)
3. **The reads the device can't fake** — the training log (sessions + sets back), last-time
   prefill, the finish, the statistics surface, the export, and the coach share. (§5)
4. **The wedge — shipped.** Gym's fifteen MCP tools on `windmill.works/mcp`, behind the platform's
   grant gate: `gym:read` answers questions, `gym:write` logs and plans, `gym:delete` destroys, and
   **none of the three implies another**. Every tool goes through `LogService` — the same core the
   REST handlers use, never the repository — and acts **as** the caller, so an agent is one more
   owner-scoped client and never an admin. The coach is the user's own agent. (§6, §8)

**What the backend deliberately does NOT do — it stays on the device:**

- **The weight ladder** (±1/±5 under 20 kg, ±2/±5 under 50, ±5/±10 above, bands read off the
  **magnitude**, and a step that lightens the load sized by the band just below it) is
  presentation. Lift's best code — and Lift pasted it into three targets and let them drift.
  Gym's rule was "exactly **one** module," which held only while there was one language; it is
  now one module *per language*, both answering `packages/api-contract/gym-ladder.json` as a
  test (§11.5). The server only stores what was logged plus each exercise's default step. Same
  for comma-as-decimal parsing, sticky carry-forward, tap-to-type.
- **The rest timer** — a countdown against a target with a Notification-API alert is device
  behavior; the server reserves the target column (§2.5) and stores the wall-clock timestamps
  the device already writes.
- **Workout mode** — Wake Lock, no chrome, the 48-pt number. Client.
- **Sharing is one door beside the log, never a stance on it.** This bullet used to read
  "sharing does not exist — structurally", inheriting journal's §0.1 whole, and gym no longer
  inherits it whole: a lifter can hand one finished workout to a coach. What was load-bearing about
  that refusal is kept intact and is the reason the share is shaped the way it is:
  **there is still no visibility column, and not one of the fifteen routes that already existed
  changed.**
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
  log only through those tools, under a grant: the lifter's own Claude over MCP, or the coach panel
  (§12) for someone who has no agent. **Two refusals this section used to make did not survive.**
  *Lift's propose-apply contract:* a granted write lands directly, exactly as roadmap's tending writes
  (`domain/Tending.h`); what stands where the human's Apply stood is the grant — a level nobody
  approved is a tool the connection cannot even see — and the fact that each of the three destructive
  tools sits behind `gym:delete` alone. *"No prompt, no tool loop, no token bill":* the panel is all
  three. What is still true and is the point of the design is that it is not a SECOND system — same
  tools, same service, same ownership rules, and a scope narrower than any MCP connection's. Still
  cut: streaming (no SSE parser), proposal chrome, and any chat not attached to one finished workout.

**Billing in gym is one predicate, read in one place.** The log is free — every route in §6 answers a
signed-in lifter whether or not they pay. The *connected* log is Windmill One, and the only code in
this product that knows that is `CoachService`, which reads the same `hasWindmillOne` journal's Talk
reads before the question travels anywhere. No plan enum, no tier arithmetic, no second gate.

---

## 1. Where it lives — and the namespacing decision

```
backend/products/gym/
  ARCHITECTURE.md            this file
  domain/Training.h/.cpp     ids · enums · Exercise · Session · Set · PlanSnapshot ·
                             InvalidTraining · codecs · defaultStepKg ·
                             the auto-close rule · the share's lifetime       (pure, no I/O)
  domain/Routine.h/.cpp      Routine · RoutineEntry · snapshotOf              (pure, no I/O)
  domain/Review.h/.cpp       e1RM · the three record rules · the comparison   (pure, no I/O)
  domain/Statistics.h/.cpp   the per-movement line · the standing bests       (pure, no I/O)
  ports/TrainingRepository.h the one store port + its DTOs
  ports/CoachAgent.h         the panel's port: CoachTurn · CoachStep · CoachAnswer
  application/LogService.h/.cpp   start/finish/append/log/routines/stats/export/share
  application/CoachService.h/.cpp CoachTools (read-only, one workout) + the panel's refusal ladder
  adapters/
    json/TrainingJson.h/.cpp      the cross-surface wire codec
    csv/TrainingCsv.h/.cpp        the export's framing, and nothing else
    postgres/PgTrainingRepository.h/.cpp
    http/GymApi.h/.cpp            every /v1/gym/* route but one
    http/CoachApi.h/.cpp          POST /v1/gym/sessions/{id}/coach — the one conditional route
    mcp/GymToolCatalog.h/.cpp     the fifteen declarations + the handshake paragraph
    mcp/GymTools.h/.cpp           the dispatch behind them, over LogService alone
    llm/AnthropicCoach.h/.cpp     the panel's tool loop and its one vendor call
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

One port, one service, one Api, deliberately: gym is a single bounded store (the catalog, the plan
and the log live or die together — a routine entry references a movement, a session freezes a
routine, a set references both a session and a movement), and the repo convention says a file earns
existence by consumers, not by category. The split (CatalogRepository, RoutineRepository) waits for
a second consumer, which routines and custom movements did not turn out to be: every one of their
reads and writes is used by exactly the one service the log is already served by.

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
create table if not exists gym_exercises (
  id          text primary key,
  name        text not null,
  pattern     text not null check (pattern in
                ('squat','hinge','press','pull','carry','core','isolation')),
  equipment   text not null check (equipment in
                ('barbell','dumbbell','machine','cable','bodyweight','kettlebell')),
  step_kg     numeric(4,2) not null default 2.5,   -- the default ladder increment; the
                                                   -- range-adaptive ladder layers on top, client-side
  created_by  uuid references users(id) on delete cascade,   -- null = catalog seed
  created_at  timestamptz not null default now()
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
  finished_at timestamptz
);
create index if not exists gym_sessions_log on gym_sessions (user_id, started_at desc);
create unique index if not exists gym_sessions_one_open on gym_sessions (user_id)
  where finished_at is null;
```

`started_at`/`finished_at` are client wall-clock instants — offline logging means the device's
clock is the only honest one, and this is the owner's own data.

### 2.3 `gym_sets` — the product, one row at a time

```sql
-- The unit of the whole product: an append-only event stream from one device at a time.
-- Nothing to converge, so no HLC and no lattice — the client-minted id ('set_<hex>') makes
-- the background-flush queue replayable (ON CONFLICT DO NOTHING), which is all offline needs.
-- kind / rpe / note land NOW though their UI is phase 2 — Lift's lesson is that this is a
-- schema decision, not a feature decision: a warmup must not count toward volume, and
-- band-assisted work logs NEGATIVE kg, which naive volume = weight × reps silently subtracts
-- from every total (Lift shipped exactly that). The volume contribution of a set kind is a
-- domain decision and the finish surface took it: WORKING sets only, and a warmup, a drop and a
-- failure count toward nothing (products/gym/domain/Review.h). The storage is decided here.
-- set_number is server-assigned max+1 per (session, exercise) — not count+1: after a phase-2
-- delete + renumber, count+1 would mint a duplicate (a bug Lift's own spec had backwards).
-- max+1 is only unique if two appends to one session cannot read the same max, and READ COMMITTED
-- lets them: a parallel flush of six sets minted four "set 1"s. The invariant is held by a
-- FOR UPDATE on the session row taken as its own statement before the insert (§3.3) — appends to
-- one session serialize behind it. No unique index on (session_id, exercise_id, set_number) yet:
-- it would be a second arbiter to reconcile with the phase-2 renumber, and the lock already
-- makes the duplicate unreachable.
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

create table if not exists gym_routine_entries (
  routine_id       text not null references gym_routines(id) on delete cascade,
  position         int  not null check (position >= 1),
  exercise_id      text not null references gym_exercises(id),
  target_sets      int  not null default 3 check (target_sets between 1 and 20),
  target_reps      int  check (target_reps between 1 and 100),                  -- null = max
  target_weight_kg numeric(6,2) check (target_weight_kg between -500 and 500),  -- null = last time
  rest_seconds     int check (rest_seconds between 15 and 900),                 -- null = client default
  primary key (routine_id, position)
);
-- target_reps was `not null default 8` until routines met the chin-up; the run carries no ALTER
-- machinery, so the change is its own pair of idempotent statements beside the table.
alter table gym_routine_entries alter column target_reps drop not null;
alter table gym_routine_entries alter column target_reps drop default;
```

The same movement twice in one routine — bench heavy, then bench back-off — is two rows with
two positions. Lift collapsed them into one set counter with `uniquingKeysWith`; here the
key is position, so the legitimate program is representable by construction. `rest_seconds`
is the target the device's own rest timer counts down.

**Three of the entry's columns mean something by being null**, and `target_reps` is the one that
came late: the canon draws `Chin-up 3 × max` on three screens, and a required rep target could not
express that line at all — no number stands in for "as many as you can", since 0 is out of range and
1 is a single. So the absence *is* the target, everywhere it travels: the column, the entity, the
frozen snapshot, the wire, and the `max` every surface draws. A null target weight is "whatever you
did last time" and a null rest is the client's own default, under the same rule.

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

Every field of a line but `exerciseId` and `sets` is omitted when the routine named none — `reps`
included, which is the frozen half of §2.4's `3 × max`.

**The server composes it, always** — from its own routine row, inside `LogService::start`. A
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
terms of it: fifteen `WHERE user_id = :caller` queries become fifteen places where a gate can be
forgotten, and the property §0 is built on — *absent is byte-identical to forbidden* — stops being
structural and becomes something fifteen queries have to keep agreeing about. A separate table
leaves all fifteen exactly as they were and adds **one** door beside them. Sharing is then
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

---

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

struct PlanEntry    { ExerciseId exercise; int sets; std::optional<int> reps;
                      std::optional<double> weightKg; std::optional<int> restSeconds; };
struct PlanSnapshot { std::string routineName; std::vector<PlanEntry> entries; };   // §2.5

double defaultStepKg(Equipment);   // the seed's own table: barbell 2.5 · dumbbell 2.0 · machine 5.0
                                   // · cable 2.5 · bodyweight 2.5 · kettlebell 4.0

// domain/Routine.h — the plan, beside the log rather than inside it
struct RoutineEntry { int position; ExerciseId exercise; int targetSets;
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

**`PriorMark` is a projection, not a history**: one row per (movement, load) carrying the *best reps*
ever done at it. At a fixed weight e1RM rises with reps, so that row is the best set at that load,
and all three record rules follow from it — which is what keeps the Epley formula out of SQL
entirely (§11.5's ladder lesson applied to the second formula in the product). `SessionHistory` is a
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
their constructors like every other entity here: a name that is non-empty, at most `kMaxNameLength`
(80) **bytes** — the unit the column counts — and free of NUL bytes; at least one entry and at most
`kMaxRoutineEntries` (50);
positions `1..n` in order; `targetSets` 1–20, `targetReps` 1–100 *when it names one*,
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

### 3.2 The two pure session rules — auto-close and the legal end

Lift had a three-way crash-recovery UX because its store was device-local. Server-as-truth
deletes the problem, and `session-resume` was deliberately cut as a bet and kept as a rule:

```cpp
// An open session with no activity for four hours is over, and it ended at its last set —
// not at whenever the server happened to notice. A session with no sets ended when it began.
constexpr std::uint64_t kAutoCloseMs = 4ull * 60 * 60 * 1000;
std::optional<std::uint64_t> autoCloseAt(const Session&, std::optional<std::uint64_t> lastSetAtMs,
                                         std::uint64_t nowMs);
```

Pure, clock-free, tested against every branch. `LogService` applies it lazily — before a new
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
session began. And it has to be right the first time: `close` is `WHERE finished_at IS NULL`,
first-writer-wins by design, so the first instant that lands is the session's end **forever**.
A client whose clock was unset sends `0`, the session ends in 1970, `finishedAt: 0` is falsy in
JS and the row renders "in progress" for the rest of time, unfixable until phase-2 log-editing.
That is one refusal's worth of work.

### 3.3 The write path (`application/LogService`)

`LogService` holds `TrainingRepository&` and reads top-to-bottom like the plain-English rule:

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
  genuinely new id reaches the finished refusal (`AppendError::finished` → 409) and then the
  insert: `FOR UPDATE` on the session row, then `set_number = max+1` for that (session, exercise)
  computed in the next statement, `ON CONFLICT (id) DO NOTHING`, then a read-back scoped to
  **(id, session_id)** — which is the row returned. The device's background flush can replay the
  queue in any order, any number of times; the log converges on exactly one row per minted id.
  A concurrent same-exercise append no longer races the numbering (§2.3): appends to one session
  serialize behind its row, which costs one lock on a write that is already one round trip.
  The insert's own two refusals come back beside the row as `SetInsertError` (§3.4) and the service
  passes them through untouched: `unknownExercise` when the set names a movement no catalog holds
  → `AppendError::unknownExercise` → 400, and `idTaken` when the scoped read-back finds nothing.
  Neither is ever an exception in flight — the catalog is storage's to know, and storage says so in
  a value.

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
  unchanged. Finishing an already-auto-closed session is the same no-op.

Every write returns the resolved row (journal's `PageService::write` lesson): a client that
lost a race or replayed sees the winning truth in one round trip — and when there is no row it
is entitled to, it gets a refusal, never a row it is not.

### 3.4 The port (`ports/TrainingRepository.h`)

```cpp
struct TrainingRepository {
  virtual ~TrainingRepository() = default;
  virtual std::vector<Exercise> catalog(const UserId&) = 0;          // seeds + own customs
  virtual std::optional<Session> open(const UserId&) = 0;
  virtual std::optional<Session> session(const UserId&, const SessionId&) = 0;
  virtual std::optional<Set> setOf(const UserId&, const SetId&) = 0; // owner-scoped: the replay lookup
  virtual std::optional<std::uint64_t> lastActivity(const SessionId&) = 0;
  virtual void insertSession(const Session&) = 0;                    // conflict = no-op
  virtual void close(const SessionId&, std::uint64_t finishedAtMs) = 0;
  virtual SetInsertOutcome insertSet(const Set& incoming) = 0;       // assigns number; replay returns
                                                                     // stored; refusals as values
  virtual std::vector<SessionSummary> log(const UserId&, const LogCursor&) = 0;
  virtual std::vector<Set> setsOf(const SessionId&) = 0;
  virtual LastTimeOutcome lastTime(const UserId&, const ExerciseId&) = 0;  // the prefill read (§5)
  virtual SessionHistory historyFor(const UserId&, const Session&) = 0;    // the finish read (§5)
  virtual bool deleteSession(const UserId&, const SessionId&) = 0;         // the discard; sets cascade
  virtual std::vector<Routine> routines(const UserId&) = 0;       // most recently trained first
  virtual std::optional<Routine> routine(const UserId&, const RoutineId&) = 0;
  virtual RoutineWriteOutcome insertRoutine(const Routine&) = 0;  // conflict = the stored routine
  virtual RoutineWriteOutcome replaceRoutine(const Routine&) = 0; // whole-document replace
  virtual bool deleteRoutine(const UserId&, const RoutineId&) = 0;
  virtual ExerciseInsertOutcome insertExercise(const UserId& owner, const Exercise&) = 0;
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
struct SessionSummary { Session session; int setCount; std::vector<std::string> exerciseNames;
                        std::optional<TopWorkingSet> topSet;   // absent = no working set in it
                        bool closedItself; };                  // the four-hour rule ended it
struct LogCursor { std::uint64_t beforeMs; std::optional<SessionId> beforeId; int limit; };

enum class SetInsertError { none, idTaken, unknownExercise };
struct SetInsertOutcome { std::optional<Set> set; SetInsertError error; };

struct LastTime { Session session; std::string routineName; std::vector<Set> sets; };
enum class LastTimeError { none, unknownExercise };
struct LastTimeOutcome { std::optional<LastTime> lastTime; LastTimeError error; };

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

DTOs live with the port (the house convention). **Every method that can resolve a row carries the
credential that may see it** — a `UserId` everywhere but one, and on `sharedSession` an unguessable
token instead, which is the whole of why that one is safe to leave uncredentialed (§2.6). That
includes `setOf`, the one lookup keyed by a client-minted set id:
an id is a guess anyone can make, so the scope has to travel with it. `insertSet`'s `idTaken` is
the same rule applied to the write: its read-back is scoped to `(id, session_id)`, so an id already
spent outside this session resolves to *nothing* rather than to that row. The unscoped version of
that one read handed a stranger's weight, rpe and free-text note to whoever guessed the id, and
reported a 200 for a set it had silently dropped.

**Both refusals cross the port as values, and that is a structural rule, not a preference.** The
exercise FK is a fact only storage can know, and it arrived as a `pqxx::foreign_key_violation`
caught at the *HTTP edge* — which made the wire layer include a database header and know which
store gym is kept in, and cost a divergence immediately: the fake could only imitate the throw with
`InvalidTraining`, so under test that path said "could not read that set" while the live server
said "no such exercise", and no test pinned either sentence. The translation belongs where every
other adapter puts it — inside the Pg adapter, beside the statements that already know what
Postgres is (`PgTreeRepository` catching `unique_violation`, `PgReminderRepository` catching
`sql_error`). Everything the store has no answer for rides past untranslated to the house 500.

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
and the exercise FK reported as the same typed fact — because Lift's proposal-apply bug survived
precisely as long as its mock didn't model the persistence boundary. A fake that mirrors a leak is
worse than no fake: it makes the suite green *because* the bug is faithfully reproduced. Typing the
fact is what keeps the two honest **by construction** — they now return one enum, so they cannot
hold different opinions about what an unknown movement means.

---

## 4. Capability 2 — exercise identity

The catalog read is `catalog(user)`: all seeds plus the caller's own created movements, one
query, ordered by pattern then name. Identity rules, stated once:

- The slug id never changes and never renders; the display name is one mutable column.
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
  carrying set count, exercise names, the session's top working set and whether it closed itself;
  detail is per-exercise grouping in first-performed order, assembled client-side from numbered
  sets. Read-only in phase 1 — the fix-it path is phase 2's `log-editing`.

  **The row's two derived facts ride the same statement**, because the whole point of a summary is
  that the list never loads a session's sets. `topSet` is a lateral over the session's *working*
  sets — heaviest, ties to more reps, never volume, and absent for a session holding none, because
  "0 kg × 0" is not a lighter workout. `closedItself` is **inferred and has no column**: `autoCloseAt`
  stamps `finished_at` at the last set's instant exactly, or at `started_at` for a session holding
  none, while a lifter's own finish carries the instant their device named — so
  `finished_at = coalesce(max(completed_at), started_at)` *is* that rule's signature. A manual finish
  landing on precisely the same millisecond reads as an auto-close, and the whole cost of that
  coincidence is one wrong subtitle on one log row; a column would be a second writer to keep honest
  forever, on both surfaces and in the import.

  The cursor is the previous page's **last row, both halves**, because `started_at` alone is not
  unique: two sessions started in the same millisecond straddling a page edge, and an exclusive
  instant cursor puts one of them in no page, ever — silently, and differently at each page size.
  Ties are near-certain the moment phase-1 `lift-import` bulk-loads coarse timestamps. A client
  that sends only `before` gets what it asks for — strictly before that instant — which cannot
  express a tie; **both halves travel or the walk is lossy**, and `beforeId` without `before`
  names no row and is a bad cursor. The summary's movement names come back as one row per
  movement, not as one string a separator has to be picked out of: a display name is user text
  (phase-2 rename), and hand-rolled framing turns one movement holding the separator into two.
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
- **The plan** (`routines` + `routine`) — the routines screen's own order, which is *most recently
  trained first* with the never-trained after them rather than above them. The instant it sorts on
  is read off the log (`max(started_at)` over the sessions run under each routine) and not out of a
  column, so it can never disagree with the log that produced it; ties fall back to `(position, id)`
  so the walk is deterministic rather than the planner's choice. Two statements, merged by routine
  id — the log read's shape applied to the plan.
- **The finish** (`historyFor` + the pure `review`) — `GET /v1/gym/sessions/{id}/review`, one read
  behind one rule. The read is a projection and not a history: `DISTINCT ON (exercise_id, weight_kg)`
  over the *working* sets of *finished* sessions that started earlier, ordered `reps DESC,
  completed_at ASC`, restricted to the movements this session works. `DISTINCT ON` is what a bare
  `max(reps)` cannot do — it hands back the winning **row**, so the mark is dated by the earliest
  instant those reps were hit, which is the day the mark was set and the date the record line prints.

  Both of its windows compare the **pair** `(started_at, id)` against the reviewed session's own —
  the unique key every other read here pages and locates on. That is not decoration: it excludes the
  session from its own history, and the review is always read *after* the finish, so without it
  every set would tie itself and the record would silently vanish on the very first read.

  Nothing is stored. The review is recomputed on every call, which is what keeps it right when a set
  arrives late from a flush queue, and it is why there is no `ReviewService`: one load, one pure
  rule, one answer, on `LogService` beside `detail`.
- **The statistics surface** (`trainingLog` + the pure `statistics`) — `GET /v1/gym/stats`, the
  review's shape over a longer window: one load, one pure rule, one answer, computed on every read
  and stored nowhere. It takes no parameters at all — no window, no movement filter, no page —
  because the whole point of it is the long view.

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
  no session to compare against. The third record rule has no standing form on purpose: "more reps
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
  would be reporting on a session in flight. This is the **third** door that settles staleness
  (§3.2), and it has to be one — the answer counts finished sessions, so a workout the four-hour
  rule ended hours ago but nobody has read since would be a hole in the chart, and a hole reads as
  "I did not train that week".

  **What is not in it, and each was cut for a reason that has not changed:** muscle-group volume
  and any taxonomy for it, streaks, any cardio or duration axis, volume as a headline number (it
  goes *negative* on band-assisted work and lies about four light sets against three heavy ones),
  and any grade, score, percentage or green/red. The finish screen's rule holds over the longer
  window too — *a fact with a direction, never a grade*.
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
  and a quote inside a quoted field doubled. Nothing is edited on the way through; a note is the
  lifter's own words and travels byte for byte. This read settles **nothing**, alone among the reads
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

| Method & path | Purpose | Phase |
|---|---|---|
| `GET  /v1/gym/exercises` | the catalog (seeds + own customs) | 0 |
| `POST /v1/gym/exercises` | create a movement — `{id, name, pattern, equipment, stepKg?}` | 2 |
| `POST /v1/gym/sessions` | start — `{id, startedAt, joinOpenSession?, routineId?}`, idempotent; joins an open session unless the caller says it will not (§11.4); a named routine is frozen onto the row (§2.5) | 0 |
| `POST /v1/gym/sessions/{id}/sets` | append a set — `{id, exerciseId, weightKg, reps, completedAt, kind?, rpe?, note?}` | 0 |
| `POST /v1/gym/sessions/{id}/finish` | close — `{finishedAt}`, idempotent | 0 |
| `GET  /v1/gym/sessions?before=&beforeId=&limit=` | the log, newest first | 0 |
| `GET  /v1/gym/sessions/{id}` | one session with its sets | 0 |
| `GET  /v1/gym/sessions/{id}/review` | the finish surface — three facts, at most one record, the comparison | 2 |
| `DELETE /v1/gym/sessions/{id}` | discard — `204`; refused `409 session-open` while it is still running | 2 |
| `GET  /v1/gym/last?exercise=` | last-time prefill | 1 |
| `GET  /v1/gym/routines` | the plan, most recently trained first | 2 |
| `POST /v1/gym/routines` | create a routine — the whole document, idempotent on its id | 2 |
| `GET  /v1/gym/routines/{id}` | one routine | 2 |
| `PUT  /v1/gym/routines/{id}` | replace a routine — the whole document | 2 |
| `DELETE /v1/gym/routines/{id}` | remove a routine — `204`; entries cascade, sessions keep their snapshots | 2 |
| `GET  /v1/gym/stats` | the statistics surface — per-movement line, standing bests, weekly counts (§5) | 2 |
| `GET  /v1/gym/export` | every set, CSV — `text/csv`, a header row, `Content-Disposition: attachment` | 2 |
| `POST /v1/gym/sessions/{id}/share` | mint a coach share — `{token, expiresAt}`, idempotent on the session | 2 |
| `DELETE /v1/gym/sessions/{id}/share` | revoke it — `204`; nothing to revoke is `404 no such session` | 2 |
| `GET  /v1/gym/shared/{token}` | **the one unauthenticated route.** One session and its sets; revoked, expired and unknown are one `404` | 2 |
| `POST /v1/gym/sessions/{id}/coach` | **the one conditional route.** The panel (§12) — `{turns:[{from,text}]}` in, `{answer, steps}` out. Absent entirely on a deployment with no `ANTHROPIC_API_KEY`, which is why its own `404` carries `coach-no-session` and the framework's does not | 3 |

### The MCP tool catalog (`adapters/mcp/GymToolCatalog`, dispatched by `adapters/mcp/GymTools`)

Fifteen tools against roadmap's twenty-seven, and the smallness is the design: `tools/list` is the
biggest fixed cost of a connection, so a tool a parameter on another tool could serve does not get a
slot. The **level is declared beside the description**, in the same `ToolDeclaration` the gate reads,
so a tool cannot be described as one thing and gated as another.

| `gym:read` | `gym:write` | `gym:delete` |
|---|---|---|
| `list_exercises` — the catalog | `start_session` — open a workout | `discard_session` |
| `list_sessions` — the log, paged | `log_set` — one set into an open workout | `delete_routine` |
| `get_session` — one workout + its sets (`review: true` adds the finish readout) | `finish_session` | `revoke_share` |
| `last_time` — the prefill | `save_routine` — the whole document, replace-or-create | |
| `list_routines` — all, or one by `routineId` | `create_exercise` | |
| `get_stats` — all movements, or one by `exerciseId` | `share_session` — `{url, token, expiresAt}` | |

Five rules hold this together, and each is load-bearing:

- **Every tool goes through `LogService`, never the repository.** The service owns the two-phase
  load → rule → persist shape, the lazy auto-close and the write-then-resolve idempotency; a tool
  reaching past it would be a second copy of rules that exist once. The tools are therefore a second
  *door on the same core*, not a second client of the HTTP API.
- **Every tool acts as the caller.** The `ToolCaller`'s `UserId` is what every read and write is
  scoped by, exactly as `callerOf(req, auth)` scopes the handlers — absent, another account's and
  never-existed stay one answer, and an agent is never an admin.
- **The refusals are the HTTP ones in words a model can act on.** Each names the tool that answers
  the question it should ask next (`no workout of yours has that id. Call list_sessions…`), because a
  model cannot read a doc between two calls. The domain's own `InvalidTraining` sentence is forwarded
  **verbatim** here, where the browser edge flattens every one of them into `could not read that set`.
- **Client-minted ids, said out loud in the description.** `start_session`, `log_set`,
  `save_routine` and `create_exercise` all take the id the caller mints, and each description says a
  replay answers with the stored row — without that sentence a model invents a fresh id per retry and
  mints duplicates, which is exactly what §2.1 exists to prevent.
- **`delete` is never merged into `write`.** Two tools may merge where a parameter does the job
  (`list_routines`, `get_stats`) but never across levels, and no read is reachable through a
  write-classified name.

**`GET /v1/gym/export` deliberately has no tool.** A CSV is a file for a person to open, and an
agent holding `list_sessions` + `get_session` + `get_stats` already has every one of those numbers in
a shape it can read — a sixteenth tool that answered with a wall of comma-separated text would spend
a `tools/list` slot and a context window to say what three tools already say.

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
`{id, name, position, lastTrainedAt?, entries:[{position, exerciseId, targetSets, targetReps?,
targetWeightKg?, restSeconds?}]}`; list replies wrap (`{"exercises":[…]}`, `{"sessions":[…]}`,
`{"routines":[…]}`, detail `{"session":…, "sets":[…]}`). A log row is a session plus
`{setCount, exercises:[…], topSet?: {weightKg, reps}, closedItself}`. Parsing type-checks every
jsoncpp field before `.as*()` and throws `InvalidTraining` → 400.

**An absent `targetReps` is `max`, not a missing value.** It is omitted on the way in and omitted on
the way out — on the routine entry, on the frozen plan's line, and on the review's `planned` — under
the same rule every other optional here obeys, and every surface draws it as `3 × max` (§2.4).

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
| 400 | `unknown-exercise` | a set, a routine entry, or the prefill read names a movement no catalog holds (the exercise FK, §3.4) | `no such exercise` | terminal — the movement has to be resolved against `GET /v1/gym/exercises` first |
| 400 | — | the prefill read names no movement at all | `bad exercise` | terminal, and a read-path fault — never the queue's |
| 400 | — | the close instant runs backwards against the stored start | `a session cannot finish before it began` | terminal — send an instant the session could have ended at |
| 400 | — | the log cursor is not a digits-only instant plus, optionally, a well-formed id beside it | `bad cursor` | terminal, and a read-path fault — never the queue's |
| 409 | `session-id-taken` | start with a session id spent by an account this caller cannot see — never the caller's own, which replays | `that session id is taken` | mint a NEW session id and start again |
| 409 | `session-already-open` | start that said `joinOpenSession: false` while another of this lifter's sessions is open | `another session is already open` | terminal until the open workout ends — a new id changes nothing; finish it (or let the four-hour auto-close fire) and send the same body again |
| 409 | `set-id-taken` | append a NEW set id already spent by a row outside this session | `that set id is already used` | mint a NEW set id and send the same set again |
| 409 | `session-finished` | append a NEW set to a session already finished | `that session is finished` | terminal — this set will never land here |
| 409 | `routine-id-taken` | create a routine under an id another account holds | `that routine id is taken` | mint a NEW routine id and send the same document again |
| 409 | `exercise-id-taken` | create a movement under a seeded slug or another account's id — never the caller's **own**, which answers 200 with the movement already stored under it (§2.1: a 409 there forces a re-mint, and the re-mint is a second "Zercher Squat" every later set forks history across) | `that movement id is taken` | mint a NEW movement id and send it again |
| 409 | `session-open` | discard a session that is still running | `that session is still running` | terminal until the workout ends — no id to re-mint and no body to fix; finish it (or let the four-hour auto-close fire) and send the same delete again |
| 500 | — | a storage failure — a dropped connection, a statement timeout, a deadlock | `internal error` (the house handler) | retryable — keep the set queued |

**The code is the contract; the sentence is for a human reading a log.** The wording is copy and may
be edited any day; a client that told the 409s apart by string-comparing it degrades to
"terminal, reason unknown" the first time one is reworded — and drops a set it should have re-minted
an id for. Only those eight refusals carry a code, on purpose (`platform/adapters/http/JsonReply.h`):
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
with its stored row even after the session closes — the flush queue's whole premise is replay in
any order, any number of times, converging on one row per minted id, and a queue told 409 for a
set it had already delivered would drop it and count the loss as intended.

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
  products/gym/domain/Routine.cpp products/gym/domain/Review.cpp
  products/gym/domain/Statistics.cpp products/gym/application/LogService.cpp)` linking
  `windmill_platform PUBLIC`, after the journal block; adapters + `routes.cpp` folded in via `target_sources` under the existing
  `Drogon_FOUND AND libpqxx_FOUND` guard; `windmill_gym` added to the four
  `target_link_libraries` lines (domain tests, server, adapters tests, and — since the tool
  catalog — the mcp tests). Tests are **appended to the existing executables** — a new test binary
  means editing the Dockerfile's `--target` list, so there isn't one.
- **Dockerfile:** untouched. `windmill_server` statically absorbs the new lib; `schema.sql`
  already rides at `/app/db/schema.sql`.
- **main.cpp:** five lines, plus one entry in the account-footprint list. The core is built **up
  with the MCP surface** rather than beside the routes, because the composite host is constructed
  once before the server takes traffic and gym's tools have to be in it; the mount stays down with
  the other two products' —

  ```cpp
  auto gymRepository = std::make_shared<gym::PgTrainingRepository>(connString);
  auto logService = std::make_shared<gym::LogService>(*gymRepository, *systemClock, *tokens);
  auto gymTools = std::make_shared<gym::GymTools>(*logService, apiBaseUrl);
  const std::vector<ToolModule> mcpModules{{*mcpTools, roadmapInstructions()},
                                           {*gymTools, gym::gymInstructions()}};
  …
  gym::GymDeps gymDeps{.logService = logService, .authService = authService};
  gym::registerRoutes(app, gymDeps);
  ```

  One service, two doors: the tools and the routes hold the *same* `LogService`, so a rule can
  never be true on one surface and not the other. `apiBaseUrl` is there for one thing — a minted
  coach share is a token, and only gym knows the route that turns it into a URL. Tending is
  deliberately NOT given the composite (it keeps roadmap's host directly), so a prompt-injection-
  exposed agent cannot reach a training log. Still no env vars, no arming flags, no sweeps and no
  vendor keys, and gym contributes nothing to the mail list. `*tokens` is the one
  collaborator gym did not have at phase 0 and it is here for exactly one thing — minting a coach
  share's secret, from the same mint that makes a session cookie, so the one unguessable string gym
  hands out is the platform's and not gym's own. `{"gym_session_shares", "user_id"}` joins
  `gym_sessions`/`gym_sets`/`gym_routines` in `PgAccountFootprint`'s owned list: a live coach link
  is data, and an account holding one is not empty.
- **Schema:** the `-- ── Gym (products/gym) ──` section + the 64-row seed, appended at EOF,
  idempotent end-to-end (`create … if not exists`, seed `ON CONFLICT (id) DO NOTHING` so a
  redeploy never clobbers a renamed display name). A column that has to *change* gets its own
  statement beside its table, phrased so re-running is a no-op — `alter … drop not null` /
  `drop default` on `gym_routine_entries.target_reps` — because the run is re-applied on every
  deploy and there is no migration ledger to carry the change instead. The bar for such a line is
  that a database created before it and one created after it end up identically shaped.
- **Tests:** `test/products/gym/{Fakes.h, domain/TrainingTest.cpp, domain/RoutineTest.cpp,
  domain/ReviewTest.cpp, domain/StatisticsTest.cpp, application/LogServiceTest.cpp,
  adapters/http/GymApiTest.cpp, adapters/mcp/GymToolsTest.cpp,
  adapters/postgres/PgTrainingRepositoryTest.cpp}` mirroring the tree, full assertions —
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
fallback). The shell `status` stays `'pre-open'` until the logger is real: the author dogfoods
at `#/gym`, `/app/gym` keeps redirecting to the landing, and the flip is `gym-landing`'s move,
not the seam's.

---

## 8. What gym does not build — and the two bets it waits on

| Absent | Why |
|---|---|
| Sweeps, heartbeats, mail | Nothing in phase 0–2 fires on a clock. `gym-nudge` (phase 3) must not be a **fourth** copy of the reminder skeleton — it waits for the platform sweep primitive. There are already three: roadmap's `ReminderSweep`, journal's `NudgeSweep` and journal's `EchoSweep` each hold their own trantor `EventLoopThread`, run it from the constructor (so an operator pass can be queued onto a heartbeat nobody armed), arm `runAfter`→`runEvery` in `start()`, and wrap `tick()` in the same two-arm crash guard. So the third consumer arrived and did **not** force the promotion — the trigger is already met and unclaimed, and gym is not what will trip it. Whoever promotes it can refactor any of the three onto the primitive as the proving move. |
| ~~MCP tools~~ | **Built 2026-08-07 — this row is history, kept because the bet was recorded here.** The platform scoped-composite ToolHost shipped (`McpServer` binds a `CompositeToolHost`, each product registers a `ToolModule`, and a grant of `product:read` / `:write` / `:delete` — none implying another — selects what a connection sees and may call), and gym's own `ToolHost` landed the same day: fifteen tools in `adapters/mcp/`, registered in `main.cpp` beside roadmap's. The surface is §6. |
| Billing, plans, gates | The log is free — that is a product decision, not a blocked one. The old blocker is gone: the brand-wide gate left roadmap's settings folder in `97e1f1b` and is now `paidPlansOpen()` in `web/src/shell/billing/checkout.js`, which gym may import like any other shell module. What a gym money surface would still have to solve is the tier *copy* (`PLAN_COPY`), which stayed behind in roadmap. |
| Units preference | Canonical kg is a schema decision already taken; a lb ladder is a second untested surface on the one thing that must be perfect. |
| Cardio, duration, bodyweight-only, supersets, streaks, plate calculator, muscle-group volume | Cut in the plan, recorded there with reasons; the schema deliberately reserves nothing for them — a duration axis is a different product, and reserving speculative columns is how schemas rot. |

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
6. **Auto-close** — a pure domain rule (4 h, closes at last activity), applied lazily on start, on
   the log read and on the statistics read; no cron. The export settles nothing (it hands back every
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
   is still no `visibility` on `gym_sessions` and not one of the fifteen routes that predate it
   changed, so *absent is byte-identical to forbidden* stays a structural property of every one of
   them. The second reader arrives through `gym_session_shares` and one unauthenticated route, and
   sharing is therefore unreachable by accident — no existing query names that table. Per session,
   never per account; expiring (30 days, `shareExpiryAt`) and revocable by deleting the row;
   server-minted token, stored in the clear because the mint must be idempotent; the reply names no
   account and holds no id. Journal's §0.1 is no longer inherited *whole* — journal still has no
   share entity, gym now has one. (§0, §2.6, §5)
10. **The statistics surface answers only over values the domain already decides.** The series is
    `TopSet`'s rule, the estimate is Epley from `domain/Review.h`, the records are the *prior*
    halves of the finish's own record rules — no new arithmetic and no second ranking vocabulary.
    All date work stays in Postgres, weeks are Monday-to-Monday in UTC, and finished sessions only.
    Volume as a headline, muscle-group taxonomy, streaks, a cardio or duration axis, and any grade
    or percentage stay cut for the reasons they were cut for. (§5, §8)
11. **The tool catalog is a second door on the same core, and its classification IS the gate.** Every
    tool goes through `LogService` (never the repository) and acts as the caller, so an agent is an
    owner-scoped client and the ownership rules are enforced in exactly one place. The level rides on
    the declaration beside the description, so the two cannot drift. Tools merge where one argument
    does the job — `list_routines` is the list and the single read, `get_session` carries the finish
    readout, `get_stats` narrows to one movement, `save_routine` replaces-or-creates — and **never
    across levels**: no read is reachable through a write-classified name, and `gym:delete` is its
    own grant. What is deliberately absent: an export tool (three tools already answer it in a shape
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
  (the reads). The dogfood gate runs here: 8 consecutive real sessions without falling back to
  Lift, prefill right on set one in ≥6.
- **Phase 2.** `routines` — **the backend half is shipped**: the plan's CRUD, the movement a lifter
  creates, and the server-frozen snapshot at start (§2.4, §2.5, §4). `pr-line` — **the backend half
  is shipped too**: the finish read, the three record rules, the comparison and the discard (§3.1,
  §5, §6), e1RM shown to a human for once. `gym-export` — **shipped**, and it is the CSV §5
  describes rather than the settings-section stub the table used to promise. `gym-share` — **the
  backend half is shipped**: the separate table, the two owner-scoped doors and the one
  unauthenticated read (§2.6, §5). `set-kinds` UI · `log-editing` (drafts, renumber) ·
  `rest-timer` (the target column routines now write) · `gym-landing` (the flip, only once the
  product behind it is true). `gym-mcp` — **shipped**, both halves: the platform's grant gate, then
  gym's fifteen tools on it (§6). What is left of that bet is client-side — the connect surface, and
  whatever the shell puts in front of a lifter who has no agent of their own.
- **Phase 3.** `progress-charts` — **the backend half is shipped** as `GET /v1/gym/stats` (§5).
  That is a decision taken **ahead of** the measured gate rather than through it: the gate
  (8 consecutive real sessions, prefill right on set one in ≥6) has still never been *run*, so
  "behind a measured gate" meant "behind a measurement nobody took", and the owner chose to build.
  What the gate protected is preserved a different way — the surface answers only over values the
  domain already decides, so shipping it early cost no new opinion about training, and the cut list
  in §8 is unchanged. Still ahead: plan-vs-actual, the strength tree, nudges on the shared sweep
  primitive, the native shell — and the client half of the charts, which has no design canon yet
  (there is no chart brief among gym's G1–G7).

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
writes sets over this same public API, gym's **MCP tools write through the same `LogService` behind
it** (§6) so a rule stated at the HTTP edge would not reach them at all, and making the durable write
conditional on who is asking inverts §0, where server-as-truth is the reason gym exists here. The
stance lives in the surfaces. Every route — and every tool — stays owner-scoped and surface-blind.

### 11.1 Who owns what

| | Phone (native iOS) | Web |
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
labour. It carries **no install door**: there is no iPhone app anybody can install yet (§8), and a
door onto nothing is exactly the advertising this product does not do. Until there is one, the web
keeps its own Start.

**The mirror never says "resting".** The rest target is device-local — one module per language,
answering `packages/api-contract/gym-ladder.json` — so the server cannot know whether 1:47 is a
rest that is running or a rest that is over. The band says the same digits under a label it can
stand behind: *last set 1:47 ago*.

### 11.3 Sync — four flows, and the new one is not a channel

1. **Phone → server (the write).** Unchanged from §3.3 and already correct in
   `web/src/products/gym/logger/flushQueue.js`: client-minted `set_<hex>`, offline queue, replay in
   any order any number of times, `ON CONFLICT DO NOTHING`, flush before finish. The Swift queue is
   a re-implementation of this contract, and it must branch the three 409 codes the same way —
   `set-id-taken` re-mints, `session-id-taken` re-mints, `session-finished` drops (§6).
2. **Server → web (freshness). No new endpoint.** Web boots on the log read — which is also what
   lazily settles a stale open session (§3.2) — finds the open session, then polls
   `GET /v1/gym/sessions/{id}`, which already answers `{session, sets}` owner-scoped. Five seconds
   while the tab is visible, stopped when hidden, refetched on `visibilitychange`. The only backend
   work is an `ETag` over `(setCount, last completedAt, finishedAt)` so the steady state is a 304.

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

**Web never Finishes a live session.** §3.3's finish boundary is that a set which never landed may
not land after the close, and only the device holding the queue knows everything landed — that is
the whole content of *flush before you finish*. A Finish pressed on a laptop over a phone holding
three unflushed sets refuses those sets forever. The fallback is better than the feature anyway:
auto-close fires at four hours and stamps the end at the **last set** (§3.2), which is truer than a
manual finish three hours late. Web offers no button and says the session closes itself.

**The ladder must not become copy #2.** §0 cut the ladder to exactly one module because Lift pasted
it into three targets and let them drift — and a native Swift logger writes copy #2 on its first
day. The fix is not shared code across a language boundary but shared *truth*: the step table and
the down-step rule became a golden fixture in `packages/api-contract/gym-ladder.json`, which
already existed to hold exactly this (wire types plus the genesis-legend golden), and both the JS
module and the Swift one run it as a test. Drift then fails CI instead of shipping a wrong number
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

The web logger is written and shipped; §11 demotes it to the mirror plus backfill, which is a
subtraction. The cost is on the other side: until `gym-ios-logger` exists there is **no capture
surface at all**, so the phase-1 dogfood gate (8 consecutive real sessions) cannot run, and
`gym-landing` stays down that much longer. `apple-identity` (`backend/AUTH.md`) is a hard
prerequisite — shipping Sign in with Apple without `user_identities` forks accounts on the first
lifter who taps *Hide My Email*, and the fork is unrecoverable once both halves hold sets.

---

## 12. The coach panel — the second door, not the second system

`ports/CoachAgent.h` · `application/CoachService.{h,cpp}` · `adapters/llm/AnthropicCoach.{h,cpp}` ·
`adapters/http/CoachApi.{h,cpp}`

A lifter with Claude connects it and asks. A lifter without one gets a panel under any finished
workout that asks the same questions of the same tools. **That is one system with two doors**, and
everything below exists to keep it that way rather than letting a second, looser path grow beside the
first. §0's refusal of an in-app chat is reversed here, in writing, with the bounds it is reversed
under.

### 12.1 The narrowing, in two independent layers

`GymTools` does not gate — deliberately, because over MCP the grant was settled above it by
`CompositeToolHost` — so a panel wired straight to it would be a door with no lock, and a
hallucinated `discard_session` would execute. Two things stand in the way, and they stack rather than
merge, exactly as `ScopedToolHost` and the composite do for a tend:

- **The scope, stated at the call site.** `CoachService::ask` constructs
  `ToolCaller{caller, ToolScope({{"gym", Access::read}})}` on the line that dispatches the run. Not a
  default, not inherited, not `everything()` — the widest thing a panel could inherit is everything
  the *account* may do, which for a question about a workout that already happened is nine tools too
  many.
- **`CoachTools`, which is gym's `ScopedToolHost`.** It drops every declaration whose access is not
  `read` (so the model is handed six tools, not fifteen), refuses a non-read name if one is called
  anyway, and **forces `sessionId`** on every tool that takes one — so a set note somebody typed at
  the rack cannot steer the panel onto another workout. It decides all of this by reading the
  declarations, never a list of names, so it cannot drift from the catalog.

Either layer alone would hold today. Both is what survives someone widening the other by accident.

### 12.2 Every bound, and why each one is there

| Bound | Value | Why |
|---|---|---|
| Grant | `gym:read` | a question about a finished workout needs no write, ever |
| Reach | one session | the panel is about the workout it was opened on; `CoachTools` pins it |
| Iterations | 6, and hitting it is a **failure** | an unfinished answer printed under somebody's log is worse than "the coach didn't answer" |
| Turns | 8, 1000 bytes each | the server is stateless, so the request body *is* the prompt somebody pays for |
| Entitlement | `hasWindmillOne`, read before the question travels | the same predicate journal's Talk reads; a non-subscriber's words never reach the vendor |
| Rate | ~6 asks / 10 min / **account** | the spend is the account's; a household behind one address should not share a budget |
| Ownership | `LogService::detail` before dispatch | absent and another account's are one fact here as everywhere |
| Vendor | absent when unkeyed | no `ANTHROPIC_API_KEY` ⇒ no `CoachService` ⇒ `registerRoutes` never mounts the path |

### 12.3 The shapes it refused

- **No streaming.** The only SSE machinery in the repo is roadmap's hand-rolled HTTP/1.1 + chunked
  decoder, and one reply per ask does not earn a second consumer of two hundred lines of parser.
- **No conversation table.** The client sends the turns so far. There is no thread id to leak, no row
  to garbage-collect, and nothing extra to name on the account-close screen.
- **No blocking the request loop.** `CoachAgent::answer` blocks for as long as the vendor takes;
  `CoachService` owns a two-thread pool and the handler hands its callback over. Four handler threads
  parked on a model is a training log that stops answering everybody.
- **Not a shared loop with roadmap's.** `AnthropicCoach` is a sibling of `AnthropicAgent`, not a lift
  of it: same shape, different port, different bootstrap, and a conversation instead of one sentence.
  A **third** consumer is what earns promoting `agentTools`/`toolResultBlock`/`markCachePoint` into
  `platform/adapters/llm/`; two is not enough evidence about what the shared shape actually is.

### 12.4 What the lifter is told

The panel draws its terms before anything is typed — what it reaches and, in the same breath, that it
only reads — and it prints **which tools each answer came from**, in call order
(`web/src/products/gym/coach/coach.js`). That line is the product's whole stance made visible: a model
reads your log through the same doors you do. Without it this would be a chatbot claiming to know
things.
