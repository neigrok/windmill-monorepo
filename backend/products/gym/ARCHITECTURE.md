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
   prefill, export. (§5)
4. **Later, the wedge** — gym's MCP tools on `windmill.works/mcp`, behind a platform scoped-
   ToolHost bet gym does not own. The coach is the user's own agent; we build no chat. (§8)

**What the backend deliberately does NOT do — it stays on the device:**

- **The weight ladder** (±1/±5 under 20 kg, ±2/±5 under 50, ±5/±10 above, down-steps evaluated
  at `weight − 0.01`) is presentation. Lift's best code — and Lift pasted it into three targets
  and let them drift. Gym's rule: the ladder lives in exactly **one** web module; the server
  only stores what was logged plus each exercise's default step. Same for comma-as-decimal
  parsing, sticky carry-forward, tap-to-type.
- **The rest timer** — a countdown against a target with a Notification-API alert is device
  behavior; the server reserves the target column (§2.5) and stores the wall-clock timestamps
  the device already writes.
- **Workout mode** — Wake Lock, no chrome, the 48-pt number. Client.
- **Sharing does not exist — structurally.** No visibility column, no share entity, no public
  route. Every read and write is `WHERE user_id = :caller`; a session is legible to exactly one
  account, and absent is byte-identical to forbidden. This is journal's stance (§0.1 there),
  inherited whole. The strength-tree brand bet stays legal because **gym publishes, gym never
  imports**: it will emit an achievement or a paste-grammar tree the user hands to roadmap —
  coupling by the account and the user's own hand, never a cross-product read.
- **In-app coach chat — retired, not parked.** Roadmap's `llm-generator` ruling applied to gym:
  the shipped MCP server is the agent path. No SSE parser, no tool loop, no token bill. What
  survives from Lift is the contract — the model proposes a typed diff, the human applies.

**No billing code in gym, phases 0–2.** The log is free; the *connected* log is Windmill One.
Until `gym-mcp`, gym asks nothing of `Entitlements`, holds no plan enum, and gates nothing.
The one predicate it will eventually read is the same `hasWindmillOne` journal's Talk reads.

---

## 1. Where it lives — and the namespacing decision

```
backend/products/gym/
  ARCHITECTURE.md            this file
  domain/Training.h/.cpp     ids · enums · Exercise · Session · Set · InvalidTraining ·
                             codecs · the auto-close rule                     (pure, no I/O)
  ports/TrainingRepository.h the one store port + its DTOs
  application/LogService.h/.cpp   start/finish/append/log — load → domain → save
  adapters/
    json/TrainingJson.h/.cpp      the cross-surface wire codec
    postgres/PgTrainingRepository.h/.cpp
    http/GymApi.h/.cpp
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

One port, one service, one Api, deliberately: phase 0–1 gym is a single bounded store (the
catalog and the log live or die together), and the repo convention says a file earns existence
by consumers, not by category. The split (CatalogRepository, RoutineRepository) happens when
custom exercises or routines give it a second reason.

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
-- edits to name survive redeploys). created_by NULL marks a seed; phase-2 custom exercises
-- land as rows with created_by = the owner, visible only to them — a column now, not a
-- migration later.
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
-- not by application memory: starting while another is open JOINS the open session.
-- plan is a FROZEN jsonb copy of the routine at start (null = ad-hoc). Lift stored templateId
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
-- domain decision, deferred to the first aggregating bet; the storage is decided here.
-- set_number is server-assigned max+1 per (session, exercise) — not count+1: after a phase-2
-- delete + renumber, count+1 would mint a duplicate (a bug Lift's own spec had backwards).
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
72.5 forever; the C++ domain carries `double` but aggregates nothing in phase 0–1. There is no
lb column and no unit-preference row — a second untested ladder doubles the surface of the one
thing that must be perfect, and the named user is not American.

### 2.4 `gym_routines` + `gym_routine_entries` — the plan, relational

```sql
-- Phase-2 UI, phase-0 schema. Entries are RELATIONAL, not a JSON blob — Lift persisted
-- per-set pyramid targets as an opaque blob ("the database can never query or aggregate it")
-- and decode failures silently returned [], losing the program. The one legitimate blob is
-- the session's frozen snapshot (§2.2), which is a copy by definition.
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
  target_reps      int  not null default 8 check (target_reps between 1 and 100),
  target_weight_kg numeric(6,2) check (target_weight_kg between -500 and 500),  -- null = last time
  rest_seconds     int check (rest_seconds between 15 and 900),                 -- null = client default
  primary key (routine_id, position)
);
```

The same movement twice in one routine — bench heavy, then bench back-off — is two rows with
two positions. Lift collapsed them into one set counter with `uniquingKeysWith`; here the
key is position, so the legitimate program is representable by construction. `rest_seconds`
is the phase-2 rest-timer's reserved column.

### 2.5 The plan snapshot shape

When a session starts from a routine (phase 2), `gym_sessions.plan` freezes:

```json
{ "routine": "Upper A",
  "entries": [ { "exerciseId": "bench-press", "sets": 3, "reps": 8,
                 "weightKg": 82.5, "restSeconds": 180 } ] }
```

Frozen at start; mid-session changes are session-scoped. Postgres can still query jsonb when
plan-vs-actual wants it — a snapshot is a copy, not a blind spot.

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
                  std::optional<RoutineId> routine; std::string planJson; };   // "" = ad-hoc

struct Set      { SetId id; SessionId session; ExerciseId exercise; int setNumber;
                  double weightKg; int reps; SetKind kind; std::optional<double> rpe;
                  std::string note; std::uint64_t completedAtMs; };

}
```

Real constructors, never aggregate init (the house rule): `Set`'s constructor validates reps,
weight bounds, rpe range, note length, and a non-empty id, throwing `InvalidTraining` — so an
invalid set cannot exist in memory, and the HTTP layer's 400 is the constructor's throw caught
at the boundary. Codec free functions colocate in the header: `toString(SetKind)` /
`parseSetKind(string_view)` — **strict on write** (an unknown kind in a request is a 400, never
a silent downgrade of user data) — and `setKindFromStored` clamping to `working` on read, so a
future kind added by a newer deploy can't crash an older reader. Id shape validation is one
rule: `^[A-Za-z0-9_-]{8,64}$`, recommended prefixes `ses_` / `set_` / `rt_` (client-minted,
opaque to the server; the same client-supplied-id move the tree import uses).

### 3.2 The one pure rule — auto-close

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

### 3.3 The write path (`application/LogService`)

`LogService` holds `TrainingRepository&` and reads top-to-bottom like the plain-English rule:

- **`start(user, SessionStart)`** — auto-close any stale open session (§3.2) → insert
  `ON CONFLICT (id) DO NOTHING` → load whichever session is now open for this user and return
  it. A replayed POST returns the same session; a double-tap that minted two ids returns the
  first tap's session (the partial unique index refuses the second insert, and the service
  reads back the truth). Idempotent by construction, no guard flag anywhere.
- **`append(user, SetWrite)`** — load the session (absent or another's → not found; finished →
  409 at the edge) → construct the domain `Set` (throws → 400) → insert with
  `set_number = max+1` for that (session, exercise) computed in the same statement →
  `ON CONFLICT (id) DO NOTHING` → re-read the stored row and return it. The device's
  background flush can replay the queue in any order, any number of times; the log converges
  on exactly one row per minted id. One device at a time is the stated model — a concurrent
  same-exercise append from a second device could race max+1, and that is accepted, recorded,
  and not defended against with a lattice.
- **`finish(user, session, finishedAtMs)`** — set `finished_at` if null; replay returns the
  stored session unchanged. Finishing an already-auto-closed session is the same no-op.

Every write returns the resolved row (journal's `PageService::write` lesson): a client that
lost a race or replayed sees the winning truth in one round trip.

### 3.4 The port (`ports/TrainingRepository.h`)

```cpp
struct TrainingRepository {
  virtual ~TrainingRepository() = default;
  virtual std::vector<Exercise> catalog(const UserId&) = 0;          // seeds + own customs
  virtual std::optional<Session> open(const UserId&) = 0;
  virtual std::optional<Session> session(const UserId&, const SessionId&) = 0;
  virtual std::optional<std::uint64_t> lastActivity(const SessionId&) = 0;
  virtual void insertSession(const Session&) = 0;                    // conflict = no-op
  virtual void close(const SessionId&, std::uint64_t finishedAtMs) = 0;
  virtual Set insertSet(const Set& incoming) = 0;                    // assigns number; replay returns stored
  virtual std::vector<SessionSummary> log(const UserId&, std::uint64_t beforeMs, int limit) = 0;
  virtual std::vector<Set> setsOf(const SessionId&) = 0;
};

struct SessionSummary { Session session; int setCount; std::vector<std::string> exerciseNames; };
```

DTOs live with the port (the house convention). The `Fakes.h` twin applies the **same rules as
the SQL** — the PK no-op, the partial-unique open-session refusal, max+1 numbering — because
Lift's proposal-apply bug survived precisely as long as its mock didn't model the persistence
boundary.

---

## 4. Capability 2 — exercise identity

The catalog read is `catalog(user)`: all seeds plus the caller's own customs (phase 2), one
query, ordered by pattern then name. Identity rules, stated once:

- The slug id never changes and never renders; the display name is one mutable column.
- Custom exercises (phase 2's search/create) are rows with `created_by`, ids minted like
  every other client id. **Merge** — folding a typo'd custom onto a catalog id — is a phase-2
  bet that becomes an UPDATE of `gym_sets.exercise_id`, possible only because sets reference
  ids, not names. `lift-import` (phase 1) folds Lift's case-variant free-text names onto
  seeded ids at import time, outside this module's phase-0 scope.
- The dip → weighted-dip → muscle-up chain stays expressible because load is data, not
  identity.

---

## 5. Capability 3 — the reads

- **The log** (`log` + `setsOf`) — sessions newest-first, keyset-paged on `started_at`
  (`?before=<ms>&limit=`, default 50, cap 200), summaries carrying set count and exercise
  names; detail is per-exercise grouping in first-performed order, assembled client-side from
  numbered sets. Read-only in phase 1 — the fix-it path is phase 2's `log-editing`.
- **Last-time prefill** (phase 1, `last-time-prefill` bet) — one route over the
  `gym_sets_history` index: the most recent *finished* session containing the exercise, its
  sets in order. "Last time: 82.5 × 8, 82.5 × 8, 80 × 7", weight pre-dialled. The metric that
  judges it: accepted unchanged, **or changed by exactly one ladder step in the progression
  direction** — a healthy lifter on linear progression should be one tap up.
- **Export** (phase 2, `gym-export` bet) — CSV of every set, served through the settings
  `data` section gym registers on its web route table. Zero platform work; the section seam
  already composes.

---

## 6. HTTP surface — small, owner-scoped, boring

| Method & path | Purpose | Phase |
|---|---|---|
| `GET  /v1/gym/exercises` | the catalog (seeds + own customs) | 0 |
| `POST /v1/gym/sessions` | start — `{id, startedAt}`, idempotent, joins an open session | 0 |
| `POST /v1/gym/sessions/{id}/sets` | append a set — `{id, exerciseId, weightKg, reps, completedAt, kind?, rpe?, note?}` | 0 |
| `POST /v1/gym/sessions/{id}/finish` | close — `{finishedAt}`, idempotent | 0 |
| `GET  /v1/gym/sessions?before=&limit=` | the log, newest first | 0 |
| `GET  /v1/gym/sessions/{id}` | one session with its sets | 0 |
| `GET  /v1/gym/last?exercise=` | last-time prefill | 1 |
| `GET  /v1/gym/export` | every set, CSV | 2 |
| *(routines CRUD)* | | 2 |

Wire shapes live in `adapters/json/TrainingJson` (the one cross-surface codec — web, iOS,
Android, and later the MCP tools all speak it): instants are epoch-ms numbers, weights are
numbers in kg, sets serialize as
`{id, exerciseId, setNumber, weightKg, reps, kind, rpe?, note, completedAt}`, sessions as
`{id, startedAt, finishedAt?, routineId?, plan?}`; list replies wrap (`{"exercises":[…]}`,
`{"sessions":[…]}`, detail `{"session":…, "sets":[…]}`). Parsing type-checks every jsoncpp
field before `.as*()` and throws `InvalidTraining` → 400; the auth ladder is the house one —
`callerOf` → 401 `"sign in to open your training log"` first, absent → 404 (a fact, not a
fault), malformed → 400, never a leaked 500. Finished-session append is the one gym-specific
edge: 409 `"that session is finished"` — the client's flush queue treats it as terminal, not
retryable. There are no admin doors and no uncredentialed doors: nothing sweeps, nothing mails.

Telemetry: activation (`≥2 sessions of ≥5 sets within 7 days of the first set`) is instrumented
from the first `set-logger` commit via the existing web beacon — a product event on session
finish, never retrofitted.

---

## 7. Composition & wiring

The full cost of mounting the third product, itemized against the actual seams:

- **CMake:** `add_library(windmill_gym products/gym/domain/Training.cpp
  products/gym/application/LogService.cpp)` linking `windmill_platform PUBLIC`, after the
  journal block; adapters + `routes.cpp` folded in via `target_sources` under the existing
  `Drogon_FOUND AND libpqxx_FOUND` guard; `windmill_gym` added to the three
  `target_link_libraries` lines (domain tests, server, adapters tests). Tests are **appended
  to the existing executables** — a new test binary means editing the Dockerfile's `--target`
  list, so there isn't one.
- **Dockerfile:** untouched. `windmill_server` statically absorbs the new lib; `schema.sql`
  already rides at `/app/db/schema.sql`.
- **main.cpp:** four lines after the journal block —

  ```cpp
  auto gymRepository = std::make_shared<gym::PgTrainingRepository>(connString);
  auto logService = std::make_shared<gym::LogService>(*gymRepository, *systemClock);
  gym::GymDeps gymDeps{.logService = logService, .authService = authService};
  gym::registerRoutes(app, gymDeps);
  ```

  No env vars, no arming flags, no sweeps, no vendor keys. The seam's whole surface area is
  the absence in this block.
- **Schema:** the `-- ── Gym (products/gym) ──` section + the 64-row seed, appended at EOF,
  idempotent end-to-end (`create … if not exists`, seed `ON CONFLICT (id) DO NOTHING` so a
  redeploy never clobbers a renamed display name).
- **Tests:** `test/products/gym/{Fakes.h, domain/TrainingTest.cpp,
  application/LogServiceTest.cpp, adapters/http/GymApiTest.cpp,
  adapters/postgres/PgTrainingRepositoryTest.cpp}` mirroring the tree, full assertions. The
  high-value pure targets: every `autoCloseAt` branch, `Set` construction bounds (negative
  weight legal, reps 0 illegal, unknown kind thrown), start-idempotency (replay, double-tap
  two-id join, stale auto-close on start), append numbering (max+1 after a gap, replay
  returns the stored row byte-for-byte), strict-parse/clamped-read of `SetKind`. Pg mapper
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
| Sweeps, heartbeats, mail | Nothing in phase 0–2 fires on a clock. `gym-nudge` (phase 3) must not be a third copy of the reminder skeleton — it waits for the platform sweep primitive (roadmap's engine + journal's `NudgeSweep` are already two implementations of one shape; the third consumer forces the promotion, with journal refactored onto it as the proving move). |
| MCP tools | `McpServer` binds exactly one `ToolHost` and `main.cpp` binds roadmap's. `gym-mcp` needs the platform **scoped-composite** ToolHost (the client's grant selects which products' tools it sees) — not a flat union that regresses roadmap's hard-won `tools/list` size. Until then gym has no MCP surface, and the thesis bet stays honest: it ships when the log is worth connecting. |
| Billing, plans, gates | The log is free. `PAID_PLANS_OPEN` moving out of roadmap's settings folder blocks any gym monetization bet — a brand gate can't live inside one product. |
| Units preference | Canonical kg is a schema decision already taken; a lb ladder is a second untested surface on the one thing that must be perfect. |
| Cardio, duration, bodyweight-only, supersets, streaks, plate calculator, muscle-group volume | Cut in the plan, recorded there with reasons; the schema deliberately reserves nothing for them — a duration axis is a different product, and reserving speculative columns is how schemas rot. |

---

## 9. Open decisions — taken

1. **Exercise identity** — text slug PK, seeded 64, display name mutable, `created_by` lands
   now for phase-2 customs; merge is an UPDATE, import folds names onto ids. (§2.1, §4)
2. **Session snapshot** — frozen jsonb copy on the session row; routines stay relational;
   `routine_id` informational with `on delete set null`. (§2.2, §2.4)
3. **Set kinds** — four kinds + rpe + note stored from day one, UI phase 2; strict parse on
   write, clamp on read; volume semantics deferred to the first aggregating bet. (§2.3)
4. **Canonical units** — kg only, `numeric` at rest, numbers on the wire, negatives legal
   from −500 to 500. (§2.3)
5. **Idempotency** — the client-minted id *is* the key, everywhere (sessions, sets, routines);
   `ON CONFLICT DO NOTHING` + read-back is the whole retry story; one open session per user is
   a partial unique index, not a guard flag. (§2.2, §3.3)
6. **Auto-close** — a pure domain rule (4 h, closes at last activity), applied lazily on
   start and on log read; no cron. (§3.2)
7. **Namespacing** — `wm::gym` for everything; `gym::Set` at call sites, `Set` inside. (§1)
8. **No billing code until `gym-mcp`**, and no MCP until the scoped ToolHost exists. (§0, §8)

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
- **Phase 2.** `set-kinds` UI before anything aggregates · `log-editing` (drafts, renumber) ·
  `rest-timer` (the reserved column) · `routines` (snapshot at start) · `pr-line` (e1RM shown
  to a human for once) · `gym-export` · `gym-landing` (the flip, only once the product behind
  it is true) · `gym-mcp` behind the platform bet.
- **Phase 3, behind the measured gate** — charts, plan-vs-actual, the strength tree, nudges on
  the shared sweep primitive, the native shell.

The order is deliberate: the durable write is the product; everything else is optional on top
of that row.
