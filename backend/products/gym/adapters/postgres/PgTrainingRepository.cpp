#include "products/gym/adapters/postgres/PgTrainingRepository.h"

#include "platform/adapters/json/JsonText.h"
#include "platform/adapters/postgres/PgConnection.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <pqxx/pqxx>

#include <map>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace wm::gym {

namespace {
// Every read returns the same shape. Instants are pushed through epoch casts so no timestamptz or
// calendar parsing ever happens in C++ — the pqxx date/time readers differ between the macOS and
// CI Linux builds, and this keeps both off that path. weight/rpe/step cross as float8 so pqxx
// reads a plain double out of the numeric columns.
constexpr std::string_view kSessionColumns =
    "id, user_id, routine_id, coalesce(plan::text, '') AS plan, "
    "(extract(epoch from started_at) * 1000)::bigint AS started_ms, "
    "(extract(epoch from finished_at) * 1000)::bigint AS finished_ms";

constexpr std::string_view kSetColumns =
    "id, session_id, exercise_id, set_number, weight_kg::float8 AS weight_kg, reps, kind, "
    "rpe::float8 AS rpe, note, (extract(epoch from completed_at) * 1000)::bigint AS completed_ms";

constexpr std::string_view kExerciseColumns =
    "id, name, pattern, equipment, step_kg::float8 AS step_kg, created_by";

// lastTrainedAtMs is an aggregate over the log, not a column: the newest session started under this
// routine, correlated on the routine's OWN owner so the one read and the list read carry the same
// scope without either passing the caller twice.
constexpr std::string_view kRoutineColumns =
    "r.id, r.user_id, r.name, r.position, "
    "(extract(epoch from (SELECT max(s.started_at) FROM gym_sessions s "
    "                     WHERE s.routine_id = r.id AND s.user_id = r.user_id)) * 1000)::bigint "
    "  AS last_trained_ms";

constexpr std::string_view kEntryColumns =
    "routine_id, position, exercise_id, target_sets, target_reps, "
    "target_weight_kg::float8 AS target_weight_kg, rest_seconds";

// Read as a signed bigint and clamped into the band the domain accepts. A row written before that
// band was enforced — a unit-confused client wrapped a huge uint64 into a pre-1970 timestamp — then
// reads as a bounded instant instead of failing the conversion, so one poisoned row can never take
// down every read of that account's log.
template <typename Field>
std::uint64_t instantFrom(const Field& field) {
  const long long stored = field.template as<long long>();
  if (stored < 1) return 1;
  if (static_cast<std::uint64_t>(stored) > kMaxInstantMs) return kMaxInstantMs;
  return static_cast<std::uint64_t>(stored);
}

// Templated on the row type: pqxx names it row_ref on macOS and row on the CI's Linux build, so
// binding it concretely compiles on one and fails on the other.
template <typename Row>
Session sessionFrom(const Row& row) {
  std::optional<std::uint64_t> finished;
  if (!row["finished_ms"].is_null()) finished = instantFrom(row["finished_ms"]);
  std::optional<RoutineId> routine;
  if (!row["routine_id"].is_null()) routine = RoutineId{row["routine_id"].template as<std::string>()};
  // The snapshot comes back as the typed value it was frozen as, through the codec that wrote it —
  // one shape for the jsonb column and the wire, so the two edges cannot drift. planFrom clamps, so
  // a blob this build did not write leaves the session readable.
  return Session{SessionId{row["id"].template as<std::string>()},
                 UserId{row["user_id"].template as<std::string>()},
                 instantFrom(row["started_ms"]), finished, routine,
                 planFrom(parse(row["plan"].template as<std::string>()))};
}

template <typename Row>
Set setFrom(const Row& row) {
  std::optional<double> rpe;
  if (!row["rpe"].is_null()) rpe = row["rpe"].template as<double>();
  return Set{SetId{row["id"].template as<std::string>()},
             SessionId{row["session_id"].template as<std::string>()},
             ExerciseId{row["exercise_id"].template as<std::string>()},
             row["set_number"].template as<int>(),
             row["weight_kg"].template as<double>(),
             row["reps"].template as<int>(),
             setKindFromStored(row["kind"].template as<std::string>()),
             rpe,
             row["note"].template as<std::string>(),
             instantFrom(row["completed_ms"])};
}

template <typename Row>
PriorMark markFrom(const Row& row) {
  return PriorMark{ExerciseId{row["exercise_id"].template as<std::string>()},
                   row["weight_kg"].template as<double>(), row["reps"].template as<int>(),
                   instantFrom(row["at_ms"])};
}

// One row of the log summary's aggregate: a session, one movement it holds, and how many sets of
// it. The names are framed by the row structure — never by a separator packed into one string, so
// a display name that happens to contain the separator cannot mint a movement nobody trained.
struct Tally {
  int setCount = 0;
  std::vector<std::string> exerciseNames;
};

template <typename Row>
Exercise exerciseFrom(const Row& row) {
  return Exercise{ExerciseId{row["id"].template as<std::string>()},
                  row["name"].template as<std::string>(),
                  patternFromStored(row["pattern"].template as<std::string>()),
                  equipmentFromStored(row["equipment"].template as<std::string>()),
                  row["step_kg"].template as<double>(),
                  !row["created_by"].is_null()};
}

// The position is taken from the ORDER the rows came back in, not from the column: the stored runs
// are dense by construction (both writes lay a whole document down in one transaction) and the
// entity refuses anything else, so reading the order keeps a run that was somehow left with a gap
// legible instead of failing every read of that plan.
template <typename Row>
RoutineEntry entryFrom(const Row& row, int position) {
  // A null target_reps is the line canon draws as `3 × max`, not a zero and not a missing value to
  // fill in: the column dropped its NOT NULL for exactly this, so the read carries the absence.
  std::optional<int> targetReps;
  if (!row["target_reps"].is_null()) targetReps = row["target_reps"].template as<int>();
  std::optional<double> targetWeightKg;
  if (!row["target_weight_kg"].is_null())
    targetWeightKg = row["target_weight_kg"].template as<double>();
  std::optional<int> restSeconds;
  if (!row["rest_seconds"].is_null()) restSeconds = row["rest_seconds"].template as<int>();
  return RoutineEntry{position, ExerciseId{row["exercise_id"].template as<std::string>()},
                      row["target_sets"].template as<int>(), targetReps, targetWeightKg,
                      restSeconds};
}

template <typename Row>
Routine routineFrom(const Row& row, std::vector<RoutineEntry> entries) {
  std::optional<std::uint64_t> lastTrained;
  if (!row["last_trained_ms"].is_null()) lastTrained = instantFrom(row["last_trained_ms"]);
  return Routine{RoutineId{row["id"].template as<std::string>()},
                 UserId{row["user_id"].template as<std::string>()},
                 row["name"].template as<std::string>(),
                 row["position"].template as<int>(),
                 std::move(entries),
                 lastTrained};
}

// One routine and its lines, read INSIDE a caller's transaction — the read-back both writes finish
// with, and the single read on its own. A routine holding no lines is a document no write in this
// module can lay down, and it reads as absent rather than as a plan with nothing in it.
std::optional<Routine> loadRoutine(pqxx::work& txn, const UserId& user, const RoutineId& id) {
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kRoutineColumns) +
          " FROM gym_routines r WHERE r.user_id = $1::uuid AND r.id = $2",
      user.str(), id.str());
  if (rows.empty()) return std::nullopt;
  pqxx::result lines = txn.exec_params(
      "SELECT " + std::string(kEntryColumns) +
          " FROM gym_routine_entries WHERE routine_id = $1 ORDER BY position",
      id.str());
  std::vector<RoutineEntry> entries;
  for (const auto& line : lines)
    entries.push_back(entryFrom(line, static_cast<int>(entries.size()) + 1));
  if (entries.empty()) return std::nullopt;
  return routineFrom(rows[0], std::move(entries));
}

// The lines of one whole document, laid down in the order the entity holds them. The exercise FK is
// the one refusal these can raise, and it is the same fact a set's insert names: the throw has
// ALREADY aborted the transaction, so every caller returns on it at once.
void insertEntries(pqxx::work& txn, const Routine& incoming) {
  for (const RoutineEntry& entry : incoming.entries) {
    pqxx::params params;
    params.append(incoming.id.str());
    params.append(entry.position);
    params.append(entry.exercise.str());
    params.append(entry.targetSets);
    if (entry.targetReps) params.append(*entry.targetReps);
    else params.append();
    if (entry.targetWeightKg) params.append(*entry.targetWeightKg);
    else params.append();
    if (entry.restSeconds) params.append(*entry.restSeconds);
    else params.append();
    txn.exec("INSERT INTO gym_routine_entries (routine_id, position, exercise_id, target_sets, "
             "                                 target_reps, target_weight_kg, rest_seconds) "
             "VALUES ($1, $2, $3, $4, $5, $6, $7)",
             params);
  }
}
}

PgTrainingRepository::PgTrainingRepository(std::string connString)
    : connString_(std::move(connString)) {}

std::vector<Exercise> PgTrainingRepository::catalog(const UserId& user) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kExerciseColumns) +
          " FROM gym_exercises WHERE created_by IS NULL OR created_by = $1::uuid "
          "ORDER BY pattern, name",
      user.str());

  std::vector<Exercise> out;
  for (const auto& row : rows) out.push_back(exerciseFrom(row));
  return out;
}

std::optional<Session> PgTrainingRepository::open(const UserId& user) {
  // Mapped into a named local and the pqxx handles released in their own scope BEFORE the return
  // (the PgJournalRepository::load lesson) — never an optional materialised in the same expression
  // a transaction is being torn down in. At most one row exists: the partial unique index says so.
  std::optional<Session> found;
  {
    pqxx::work txn{pgThreadConnection(connString_)};
    pqxx::result rows = txn.exec_params(
        "SELECT " + std::string(kSessionColumns) +
            " FROM gym_sessions WHERE user_id = $1::uuid AND finished_at IS NULL",
        user.str());
    if (!rows.empty()) found = sessionFrom(rows[0]);
  }
  return found;
}

std::optional<Session> PgTrainingRepository::session(const UserId& user, const SessionId& id) {
  std::optional<Session> found;
  {
    pqxx::work txn{pgThreadConnection(connString_)};
    pqxx::result rows = txn.exec_params(
        "SELECT " + std::string(kSessionColumns) +
            " FROM gym_sessions WHERE user_id = $1::uuid AND id = $2",
        user.str(), id.str());
    if (!rows.empty()) found = sessionFrom(rows[0]);
  }
  return found;
}

std::optional<Set> PgTrainingRepository::setOf(const UserId& user, const SetId& id) {
  // Owner-scoped, like every other read: a set minted by another account resolves to nothing, so
  // the service can tell a replay of the caller's own row from an id it may not look at.
  std::optional<Set> found;
  {
    pqxx::work txn{pgThreadConnection(connString_)};
    pqxx::result rows = txn.exec_params(
        "SELECT " + std::string(kSetColumns) +
            " FROM gym_sets WHERE user_id = $1::uuid AND id = $2",
        user.str(), id.str());
    if (!rows.empty()) found = setFrom(rows[0]);
  }
  return found;
}

std::optional<std::uint64_t> PgTrainingRepository::lastActivity(const SessionId& id) {
  std::optional<std::uint64_t> last;
  {
    pqxx::work txn{pgThreadConnection(connString_)};
    pqxx::result rows = txn.exec_params(
        "SELECT (extract(epoch from max(completed_at)) * 1000)::bigint AS last_ms "
        "FROM gym_sets WHERE session_id = $1",
        id.str());
    if (!rows.empty() && !rows[0]["last_ms"].is_null()) last = instantFrom(rows[0]["last_ms"]);
  }
  return last;
}

void PgTrainingRepository::insertSession(const Session& incoming) {
  // Bare ON CONFLICT DO NOTHING on purpose: it swallows BOTH unique violations — the PK (a
  // replayed start) and the one-open partial index (a double-tap that minted a second id while a
  // session is open). Either way the service reads back whichever session holds the truth.
  pqxx::params params;
  params.append(incoming.id.str());
  params.append(incoming.user.str());
  if (incoming.routine) params.append(incoming.routine->str());
  else params.append();
  // The snapshot is serialized through the same codec the wire uses, so the stored object and the
  // one the client reads back are byte-identical — and `routine` stays the plain string the
  // prefill's jsonb type check looks for.
  if (incoming.plan) params.append(dump(toJson(*incoming.plan)));
  else params.append();
  params.append(static_cast<long long>(incoming.startedAtMs));
  if (incoming.finishedAtMs) params.append(static_cast<long long>(*incoming.finishedAtMs));
  else params.append();

  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec(
      "INSERT INTO gym_sessions (id, user_id, routine_id, plan, started_at, finished_at) "
      "VALUES ($1, $2::uuid, $3, $4::jsonb, to_timestamp($5::bigint / 1000.0), "
      "        to_timestamp($6::bigint / 1000.0)) "
      "ON CONFLICT DO NOTHING",
      params);
  txn.commit();
}

void PgTrainingRepository::close(const SessionId& id, std::uint64_t finishedAtMs) {
  // The trailing IS NULL makes the close idempotent AND first-writer-wins: a finish replay, or a
  // finish racing the lazy auto-close, keeps whichever instant landed first.
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params(
      "UPDATE gym_sessions SET finished_at = to_timestamp($2::bigint / 1000.0) "
      "WHERE id = $1 AND finished_at IS NULL",
      id.str(), static_cast<long long>(finishedAtMs));
  txn.commit();
}

SetInsertOutcome PgTrainingRepository::insertSet(const Set& incoming) {
  // The lock is its OWN statement, ahead of the insert: appends to one session serialize behind
  // its session row, and the numbering has to be computed in the NEXT statement — under READ
  // COMMITTED a snapshot is taken when a statement begins, so an INSERT that both takes the lock
  // and reads max(set_number) still counts the row it waited for as absent (proved: two
  // interleaved appends both minted set 1 that way). Then the insert: the owner copied from the
  // session row, the number max+1 per (session, exercise) — not count+1, which would mint a
  // duplicate after a phase-2 delete + renumber — and a replayed id no-ops on the PK. Then the
  // read-back, scoped to (id, session_id): a replay is handed the original, and an id spent on a
  // row this session does not hold resolves to nothing, never to a stranger's set.
  std::optional<Set> stored;
  {
    pqxx::params params;
    params.append(incoming.id.str());
    params.append(incoming.session.str());
    params.append(incoming.exercise.str());
    params.append(incoming.weightKg);
    params.append(incoming.reps);
    params.append(toString(incoming.kind));
    if (incoming.rpe) params.append(*incoming.rpe);
    else params.append();
    params.append(incoming.note);
    params.append(static_cast<long long>(incoming.completedAtMs));

    pqxx::work txn{pgThreadConnection(connString_)};
    txn.exec_params("SELECT 1 FROM gym_sessions WHERE id = $1 FOR UPDATE", incoming.session.str());
    try {
      txn.exec(
          "INSERT INTO gym_sets "
          "(id, session_id, user_id, exercise_id, set_number, weight_kg, reps, kind, rpe, note, "
          " completed_at) "
          "SELECT $1, $2, s.user_id, $3, "
          "       coalesce((SELECT max(set_number) + 1 FROM gym_sets "
          "                 WHERE session_id = $2 AND exercise_id = $3), 1), "
          "       $4, $5, $6, $7, $8, to_timestamp($9::bigint / 1000.0) "
          "FROM gym_sessions s WHERE s.id = $2 "
          "ON CONFLICT (id) DO NOTHING",
          params);
    } catch (const pqxx::foreign_key_violation&) {
      // The exercise FK, and only it: the session and owner ids are read out of the session row
      // this INSERT..SELECT selects from, so they exist or nothing is inserted at all. The fact is
      // translated HERE, the way every other adapter translates its vendor errors — it leaves the
      // port as a value, and the wire layer answers it without knowing gym is kept in Postgres.
      // The throw has already aborted the transaction; the work is rolled back as it goes out of
      // scope, and the read-back below would only fail on top of it.
      return {std::nullopt, SetInsertError::unknownExercise};
    }
    pqxx::result rows = txn.exec_params(
        "SELECT " + std::string(kSetColumns) + " FROM gym_sets WHERE id = $1 AND session_id = $2",
        incoming.id.str(), incoming.session.str());
    if (!rows.empty()) stored = setFrom(rows[0]);
    txn.commit();
  }
  if (!stored) return {std::nullopt, SetInsertError::idTaken};
  return {stored, SetInsertError::none};
}

std::vector<SessionSummary> PgTrainingRepository::log(const UserId& user,
                                                      const LogCursor& cursor) {
  // Two queries over the same keyset window, merged by session id: the page of sessions, then one
  // aggregate pass for its set counts and display names (alphabetical — first-performed order is
  // the detail read's business, not the summary's).
  //
  // The window sorts on (started_at, id), which is unique, and compares the pair against the whole
  // cursor: on a plain started_at cursor two sessions sharing a start instant across a page edge
  // hide one of them from every page, forever. An absent tiebreaker passes the empty id — the floor
  // of the text order — so the first page degrades to a plain "strictly before this instant".
  //
  // The row's two other facts ride the same statement. The top set is a lateral over this session's
  // WORKING sets, heaviest first and ties to more reps — the rule TopWorkingSet states, and never
  // volume. `closed_itself` is the auto-close's own signature rather than a column: autoCloseAt
  // stamps finished_at at the last set's instant exactly (or at started_at for a session holding
  // none), so a finish equal to that instant is the four-hour rule's work. A manual finish landing
  // on precisely the same millisecond reads as an auto-close, and the whole cost of that
  // coincidence is one wrong subtitle — cheaper than a column two writers would keep honest.
  const std::string beforeId = cursor.beforeId ? cursor.beforeId->str() : "";
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result sessions = txn.exec_params(
      "SELECT " + std::string(kSessionColumns) +
          ", top.weight_kg::float8 AS top_weight_kg, top.reps AS top_reps, "
          "(finished_at IS NOT NULL AND finished_at = coalesce("
          "   (SELECT max(a.completed_at) FROM gym_sets a WHERE a.session_id = gym_sessions.id), "
          "   started_at)) AS closed_itself "
          "FROM gym_sessions "
          "LEFT JOIN LATERAL (SELECT w.weight_kg, w.reps FROM gym_sets w "
          "                   WHERE w.session_id = gym_sessions.id AND w.kind = 'working' "
          "                   ORDER BY w.weight_kg DESC, w.reps DESC LIMIT 1) top ON true "
          "WHERE user_id = $1::uuid "
          "AND (started_at, id) < (to_timestamp($2::bigint / 1000.0), $3) "
          "ORDER BY started_at DESC, id DESC LIMIT $4",
      user.str(), static_cast<long long>(cursor.beforeMs), beforeId, cursor.limit);
  pqxx::result tallies = txn.exec_params(
      "SELECT st.session_id, e.name, count(*)::int AS set_count "
      "FROM gym_sets st JOIN gym_exercises e ON e.id = st.exercise_id "
      "WHERE st.session_id IN "
      "  (SELECT id FROM gym_sessions WHERE user_id = $1::uuid "
      "   AND (started_at, id) < (to_timestamp($2::bigint / 1000.0), $3) "
      "   ORDER BY started_at DESC, id DESC LIMIT $4) "
      "GROUP BY st.session_id, e.name ORDER BY st.session_id, e.name",
      user.str(), static_cast<long long>(cursor.beforeMs), beforeId, cursor.limit);

  std::map<std::string, Tally> tallyBySession;
  for (const auto& row : tallies) {
    Tally& tally = tallyBySession[row["session_id"].as<std::string>()];
    tally.setCount += row["set_count"].as<int>();
    tally.exerciseNames.push_back(row["name"].as<std::string>());
  }

  std::vector<SessionSummary> out;
  for (const auto& row : sessions) {
    Session session = sessionFrom(row);
    std::optional<TopWorkingSet> top;
    if (!row["top_weight_kg"].is_null())
      top = TopWorkingSet{row["top_weight_kg"].as<double>(), row["top_reps"].as<int>()};
    const bool closedItself = row["closed_itself"].as<bool>();
    const auto tally = tallyBySession.find(session.id.str());
    if (tally == tallyBySession.end()) {
      out.push_back(SessionSummary{session, 0, {}, top, closedItself});
      continue;
    }
    out.push_back(SessionSummary{session, tally->second.setCount, tally->second.exerciseNames, top,
                                 closedItself});
  }
  return out;
}

LastTimeOutcome PgTrainingRepository::lastTime(const UserId& user, const ExerciseId& exercise) {
  // The locator walks SESSIONS newest first — gym_sessions_log (user_id, started_at desc) — and
  // stops at the first finished one holding a working set of the movement, which is the rule as the
  // product states it and the same (started_at, id) key the log read pages on, so the two reads can
  // never disagree about which session is the newest. Walking the SETS newest first instead was one
  // index cheaper and wrong: completed_at is the device's wall clock (§2.2) and nothing ties it to
  // its session, so a single future-stamped set pinned "last time" to a week-old session while the
  // log listed a fresher one above it. The EXISTS probe carries the same predicates as the block
  // read below, so a located session always has a block — LastTime's is never empty.
  //
  // Owner-scoped on both halves and by construction, never through the invariant that a set row
  // inherits its session's owner: this is the one read in the module where a single mis-owned set
  // row could otherwise hand back a stranger's session and its whole frozen plan.
  //
  // The name comes out of the session's own frozen snapshot, not out of gym_routines: routine_id is
  // informational and nulls on delete, while the snapshot is what the session was trained under
  // (§2.2). The type check is the same one the codec applies to every field it reads: ->> renders
  // an object, an array or a number as JSON text, and that text would be printed verbatim as the
  // card's cross-routine suffix.
  std::optional<LastTime> found;
  {
    pqxx::work txn{pgThreadConnection(connString_)};
    pqxx::result sessions = txn.exec_params(
        "SELECT " + std::string(kSessionColumns) +
            ", CASE WHEN jsonb_typeof(plan->'routine') = 'string' THEN plan->>'routine' "
            "       ELSE '' END AS routine "
            "FROM gym_sessions WHERE user_id = $1::uuid AND id = ("
            "  SELECT s.id FROM gym_sessions s "
            "  WHERE s.user_id = $1::uuid AND s.finished_at IS NOT NULL "
            "        AND EXISTS (SELECT 1 FROM gym_sets st WHERE st.session_id = s.id "
            "                    AND st.user_id = $1::uuid AND st.exercise_id = $2 "
            "                    AND st.kind <> 'warmup') "
            "  ORDER BY s.started_at DESC, s.id DESC LIMIT 1)",
        user.str(), exercise.str());
    if (sessions.empty()) {
      // Only with no history to return is the catalog consulted, so the answered path costs two
      // statements and never three. Scoped like the catalog read: another account's custom movement
      // is unknown here, which is the same absent-is-forbidden rule every other read obeys.
      if (txn.exec_params("SELECT 1 FROM gym_exercises "
                          "WHERE id = $1 AND (created_by IS NULL OR created_by = $2::uuid)",
                          exercise.str(), user.str())
              .empty())
        return {std::nullopt, LastTimeError::unknownExercise};
      return {std::nullopt, LastTimeError::none};
    }
    // Warmups are excluded for the same reason they never advance the set counter or enter an
    // e1RM: a ramp-up single is not what you did last time, and the prefill dials the weight off
    // the last row of this block.
    pqxx::result block = txn.exec_params(
        "SELECT " + std::string(kSetColumns) +
            " FROM gym_sets WHERE user_id = $1::uuid AND session_id = $2 AND exercise_id = $3 "
            "AND kind <> 'warmup' ORDER BY set_number ASC",
        user.str(), sessions[0]["id"].as<std::string>(), exercise.str());
    std::vector<Set> sets;
    for (const auto& row : block) sets.push_back(setFrom(row));
    found = LastTime{sessionFrom(sessions[0]), sessions[0]["routine"].as<std::string>(),
                     std::move(sets)};
  }
  return {found, LastTimeError::none};
}

SessionHistory PgTrainingRepository::historyFor(const UserId& user, const Session& session) {
  // The finish read, in one transaction and at most three statements — the two the comparison needs
  // fire only for a session that named a routine, because without one the domain draws no
  // comparison and the rows would be loaded to be thrown away.
  //
  // The marks are the whole of what the record rules need, and they are a projection rather than a
  // history: one row per (movement, load) carrying the BEST reps ever done at it. At a fixed weight
  // e1RM rises with reps, so that row is the best set at that load, and all three rules follow from
  // it — which is what keeps the Epley formula out of SQL entirely (§11.5's ladder lesson, applied
  // to the second formula in the product). DISTINCT ON is what a bare max(reps) cannot do: it hands
  // back the winning ROW, so the mark is dated by the earliest instant those reps were hit, which is
  // the day the mark was set and the date the record line prints.
  //
  // Both windows compare the PAIR (started_at, id) against this session's own, the unique key every
  // other read here pages and locates on. It is not decoration: it excludes this session from its
  // own history, and without that a review re-read after the finish would find every set of the
  // session tying itself and would silently report no record at all.
  SessionHistory history;
  {
    pqxx::work txn{pgThreadConnection(connString_)};
    pqxx::result marks = txn.exec_params(
        "SELECT DISTINCT ON (st.exercise_id, st.weight_kg) "
        "       st.exercise_id, st.weight_kg::float8 AS weight_kg, st.reps, "
        "       (extract(epoch from st.completed_at) * 1000)::bigint AS at_ms "
        "FROM gym_sets st JOIN gym_sessions s ON s.id = st.session_id "
        "WHERE st.user_id = $1::uuid AND st.kind = 'working' AND s.finished_at IS NOT NULL "
        "  AND (s.started_at, s.id) < (to_timestamp($2::bigint / 1000.0), $3) "
        "  AND st.exercise_id IN (SELECT exercise_id FROM gym_sets "
        "                         WHERE session_id = $3 AND kind = 'working') "
        "ORDER BY st.exercise_id, st.weight_kg, st.reps DESC, st.completed_at ASC",
        user.str(), static_cast<long long>(session.startedAtMs), session.id.str());
    for (const auto& row : marks) history.marks.push_back(markFrom(row));

    if (session.routine) {
      pqxx::result rows = txn.exec_params(
          "SELECT " + std::string(kSessionColumns) +
              " FROM gym_sessions WHERE user_id = $1::uuid AND routine_id = $2 "
              "AND finished_at IS NOT NULL "
              "AND (started_at, id) < (to_timestamp($3::bigint / 1000.0), $4) "
              "ORDER BY started_at DESC, id DESC LIMIT 1",
          user.str(), session.routine->str(), static_cast<long long>(session.startedAtMs),
          session.id.str());
      if (!rows.empty()) {
        history.previous = sessionFrom(rows[0]);
        pqxx::result block = txn.exec_params(
            "SELECT " + std::string(kSetColumns) +
                " FROM gym_sets WHERE session_id = $1 ORDER BY completed_at ASC, set_number ASC",
            history.previous->id.str());
        for (const auto& row : block) history.previousSets.push_back(setFrom(row));
      }
    }
  }
  return history;
}

bool PgTrainingRepository::deleteSession(const UserId& user, const SessionId& id) {
  // The sets cascade with the row (`gym_sets.session_id ... on delete cascade`), which is what makes
  // the discard one statement and leaves nothing orphaned behind it. Owner-scoped like every write:
  // another account's session is not refused, it is simply not there to remove.
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result removed = txn.exec_params(
      "DELETE FROM gym_sessions WHERE id = $1 AND user_id = $2::uuid", id.str(), user.str());
  txn.commit();
  return removed.affected_rows() > 0;
}

std::vector<Routine> PgTrainingRepository::routines(const UserId& user) {
  // Two statements over the same owner scope, merged by routine id — the log read's shape applied
  // to the plan: the routines, then one pass for every line they hold. The order is the routines
  // screen's own, most recently trained first, with the never-trained after them rather than at the
  // top: an absent aggregate sorts nowhere on its own, so the tiebreak is stated (position, then id)
  // instead of left to the planner.
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kRoutineColumns) +
          " FROM gym_routines r WHERE r.user_id = $1::uuid "
          "ORDER BY last_trained_ms DESC NULLS LAST, r.position ASC, r.id ASC",
      user.str());
  pqxx::result lines = txn.exec_params(
      "SELECT " + std::string(kEntryColumns) +
          " FROM gym_routine_entries WHERE routine_id IN "
          "  (SELECT id FROM gym_routines WHERE user_id = $1::uuid) "
          "ORDER BY routine_id, position",
      user.str());

  std::map<std::string, std::vector<RoutineEntry>> linesByRoutine;
  for (const auto& line : lines) {
    std::vector<RoutineEntry>& entries = linesByRoutine[line["routine_id"].as<std::string>()];
    entries.push_back(entryFrom(line, static_cast<int>(entries.size()) + 1));
  }

  std::vector<Routine> out;
  for (const auto& row : rows) {
    const auto held = linesByRoutine.find(row["id"].as<std::string>());
    if (held == linesByRoutine.end()) continue;   // no lines: not a plan, and not writable as one
    out.push_back(routineFrom(row, std::move(held->second)));
  }
  return out;
}

std::optional<Routine> PgTrainingRepository::routine(const UserId& user, const RoutineId& id) {
  std::optional<Routine> found;
  {
    pqxx::work txn{pgThreadConnection(connString_)};
    found = loadRoutine(txn, user, id);
  }
  return found;
}

RoutineWriteOutcome PgTrainingRepository::insertRoutine(const Routine& incoming) {
  // The row and its lines are ONE transaction, so a routine with no lines is not a state this store
  // can be left in. The lines are written only by the caller that WON the row: a create replayed
  // after a lost reply finds the id already spent by itself, writes nothing, and reads the STORED
  // routine back untouched — the same rule a replayed start obeys, applied to a document. And the
  // read-back is owner-scoped, so an id spent by another account resolves to nothing rather than to
  // their plan: the caller learns the id is taken and never whose it is.
  std::optional<Routine> stored;
  {
    pqxx::work txn{pgThreadConnection(connString_)};
    pqxx::result inserted = txn.exec_params(
        "INSERT INTO gym_routines (id, user_id, name, position) "
        "VALUES ($1, $2::uuid, $3, $4) ON CONFLICT DO NOTHING",
        incoming.id.str(), incoming.user.str(), incoming.name, incoming.position);
    if (inserted.affected_rows() == 1) {
      try {
        insertEntries(txn, incoming);
      } catch (const pqxx::foreign_key_violation&) {
        return {std::nullopt, RoutineWriteError::unknownExercise};
      }
    }
    stored = loadRoutine(txn, incoming.user, incoming.id);
    txn.commit();
  }
  if (!stored) return {std::nullopt, RoutineWriteError::idTaken};
  return {stored, RoutineWriteError::none};
}

RoutineWriteOutcome PgTrainingRepository::replaceRoutine(const Routine& incoming) {
  // A whole-document replace: the row owner-scoped, then the lines deleted and laid down again.
  // Churning them costs no identity — entries have none, their key IS their position — and it is
  // what makes a reorder, an insertion and a deletion one write instead of three verbs the editor
  // would have to sequence. An update that matches no row is the 404 fact: absent and another
  // account's are the same answer, so nothing here says which.
  std::optional<Routine> stored;
  {
    pqxx::work txn{pgThreadConnection(connString_)};
    pqxx::result updated = txn.exec_params(
        "UPDATE gym_routines SET name = $3, position = $4 WHERE id = $1 AND user_id = $2::uuid",
        incoming.id.str(), incoming.user.str(), incoming.name, incoming.position);
    if (updated.affected_rows() == 0) return {std::nullopt, RoutineWriteError::notFound};
    txn.exec_params("DELETE FROM gym_routine_entries WHERE routine_id = $1", incoming.id.str());
    try {
      insertEntries(txn, incoming);
    } catch (const pqxx::foreign_key_violation&) {
      return {std::nullopt, RoutineWriteError::unknownExercise};
    }
    stored = loadRoutine(txn, incoming.user, incoming.id);
    txn.commit();
  }
  if (!stored) return {std::nullopt, RoutineWriteError::notFound};
  return {stored, RoutineWriteError::none};
}

bool PgTrainingRepository::deleteRoutine(const UserId& user, const RoutineId& id) {
  // The lines cascade, and every session ever trained under this routine keeps its frozen snapshot:
  // routine_id nulls (on delete set null) and the log still says which day of the program it was.
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result removed = txn.exec_params(
      "DELETE FROM gym_routines WHERE id = $1 AND user_id = $2::uuid", id.str(), user.str());
  txn.commit();
  return removed.affected_rows() > 0;
}

ExerciseInsertOutcome PgTrainingRepository::insertExercise(const UserId& owner,
                                                           const Exercise& incoming) {
  // The read-back is scoped to the caller's OWN created_by rows, which is what makes the refusal
  // safe: a seed's slug and another lifter's custom id both resolve to nothing here, so the answer
  // is "that id is taken" and never a row the caller may not read.
  std::optional<Exercise> stored;
  {
    pqxx::work txn{pgThreadConnection(connString_)};
    txn.exec_params(
        "INSERT INTO gym_exercises (id, name, pattern, equipment, step_kg, created_by) "
        "VALUES ($1, $2, $3, $4, $5, $6::uuid) ON CONFLICT DO NOTHING",
        incoming.id.str(), incoming.name, toString(incoming.pattern), toString(incoming.equipment),
        incoming.stepKg, owner.str());
    pqxx::result rows = txn.exec_params(
        "SELECT " + std::string(kExerciseColumns) +
            " FROM gym_exercises WHERE id = $1 AND created_by = $2::uuid",
        incoming.id.str(), owner.str());
    if (!rows.empty()) stored = exerciseFrom(rows[0]);
    txn.commit();
  }
  if (!stored) return {std::nullopt, ExerciseInsertError::idTaken};
  return {stored, ExerciseInsertError::none};
}

TrainingLog PgTrainingRepository::trainingLog(const UserId& user) {
  // The statistics read, three statements in one transaction, and every one of them is a query the
  // store already knows how to make — nothing here is a new opinion about training.
  //
  // The series is `DISTINCT ON (movement, session)` keeping the heaviest set with the most reps:
  // TopSet's rule, made in SQL because it is an ORDERING and not a calculation. The Epley estimate
  // over it is the domain's and is absent here on purpose — §11.5's ladder lesson applied to the
  // second formula in the product, one copy per language and none in the database. The rows come
  // back grouped by movement and oldest first inside each group, which is the port's contract and
  // what lets the pure rule assemble a line by appending.
  //
  // The marks are historyFor's projection with both of its windows removed: every movement instead
  // of one session's, and the whole finished log instead of what came before one session. Small by
  // construction — one row per (movement, load) a lifter has ever used.
  //
  // The weeks are counted here rather than in C++ because they are dates, and truncated `AT TIME
  // ZONE 'UTC'` rather than in the server's own zone: date_trunc on a timestamptz reads the
  // session's TimeZone setting, so the same log would bucket differently on a developer's laptop
  // and in CI. generate_series fills the gaps, so a week nobody trained is a zero rather than a
  // missing bar the client would have to invent a calendar to notice.
  TrainingLog log;
  {
    pqxx::work txn{pgThreadConnection(connString_)};
    pqxx::result tops = txn.exec_params(
        "SELECT DISTINCT ON (st.exercise_id, s.started_at, s.id) st.exercise_id, "
        "       (extract(epoch from s.started_at) * 1000)::bigint AS started_ms, "
        "       st.weight_kg::float8 AS weight_kg, st.reps "
        "FROM gym_sets st JOIN gym_sessions s ON s.id = st.session_id "
        "WHERE st.user_id = $1::uuid AND st.kind = 'working' AND s.finished_at IS NOT NULL "
        "ORDER BY st.exercise_id, s.started_at, s.id, st.weight_kg DESC, st.reps DESC, "
        "         st.completed_at ASC",
        user.str());
    for (const auto& row : tops)
      log.tops.push_back(MovementTop{ExerciseId{row["exercise_id"].as<std::string>()},
                                     instantFrom(row["started_ms"]),
                                     row["weight_kg"].as<double>(), row["reps"].as<int>()});

    pqxx::result marks = txn.exec_params(
        "SELECT DISTINCT ON (st.exercise_id, st.weight_kg) "
        "       st.exercise_id, st.weight_kg::float8 AS weight_kg, st.reps, "
        "       (extract(epoch from st.completed_at) * 1000)::bigint AS at_ms "
        "FROM gym_sets st JOIN gym_sessions s ON s.id = st.session_id "
        "WHERE st.user_id = $1::uuid AND st.kind = 'working' AND s.finished_at IS NOT NULL "
        "ORDER BY st.exercise_id, st.weight_kg, st.reps DESC, st.completed_at ASC",
        user.str());
    for (const auto& row : marks) log.marks.push_back(markFrom(row));

    pqxx::result weeks = txn.exec_params(
        "WITH trained AS ("
        "  SELECT id, date_trunc('week', started_at AT TIME ZONE 'UTC') AS week "
        "  FROM gym_sessions WHERE user_id = $1::uuid AND finished_at IS NOT NULL), "
        "counted AS (SELECT week, count(*)::int AS n FROM trained GROUP BY week), "
        "worked AS (SELECT t.week, count(*)::int AS n FROM gym_sets st "
        "           JOIN trained t ON t.id = st.session_id "
        "           WHERE st.kind = 'working' GROUP BY t.week), "
        "span AS (SELECT min(week) AS first_week, max(week) AS last_week FROM trained) "
        "SELECT (extract(epoch from w) * 1000)::bigint AS week_ms, "
        "       coalesce(c.n, 0) AS sessions, coalesce(k.n, 0) AS working_sets "
        "FROM span, generate_series(span.first_week, span.last_week, interval '1 week') AS w "
        "LEFT JOIN counted c ON c.week = w "
        "LEFT JOIN worked k ON k.week = w "
        "ORDER BY w",
        user.str());
    for (const auto& row : weeks)
      log.weeks.push_back(TrainingWeek{instantFrom(row["week_ms"]), row["sessions"].as<int>(),
                                       row["working_sets"].as<int>()});
  }
  return log;
}

std::vector<ExportedSet> PgTrainingRepository::exportedSets(const UserId& user) {
  // Every value comes back as TEXT and Postgres does every rendering: the instants as ISO-8601 UTC
  // (a spreadsheet cannot read an epoch, and the calendar conversion belongs in the one place gym
  // does calendar work), the numerics at their column's own scale, so 72.5 kg is "72.50" and an
  // absent rpe is an empty cell rather than a zero a reader would take for a real one.
  //
  // Ordered by the session's own (started_at, id) pair and then by the sets inside it, which is the
  // order the workouts were lived and the same unique key every other read here pages on. Nothing
  // is excluded: the open session is in the file too, because an export missing today is the one
  // row a lifter goes looking for. The routine name is the session's own frozen snapshot, so a
  // routine renamed or deleted since cannot rewrite what the file says about the past.
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT st.session_id, "
      "       to_char(s.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') "
      "         AS started_at, "
      "       coalesce(to_char(s.finished_at AT TIME ZONE 'UTC', "
      "                        'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), '') AS finished_at, "
      "       CASE WHEN jsonb_typeof(s.plan->'routine') = 'string' THEN s.plan->>'routine' "
      "            ELSE '' END AS routine, "
      "       st.id AS set_id, st.exercise_id, e.name AS exercise, "
      "       st.set_number::text AS set_number, st.weight_kg::text AS weight_kg, "
      "       st.reps::text AS reps, st.kind, coalesce(st.rpe::text, '') AS rpe, st.note, "
      "       to_char(st.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') "
      "         AS completed_at "
      "FROM gym_sets st JOIN gym_sessions s ON s.id = st.session_id "
      "                 JOIN gym_exercises e ON e.id = st.exercise_id "
      // Scoped on BOTH halves rather than through the invariant that a set row inherits its
      // session's owner — the same guard lastTime carries, for the same reason: this row prints a
      // session's instants and the day of the program it was, so a single mis-owned set is the one
      // way a stranger's workout could reach a file with the caller's name on it.
      "WHERE st.user_id = $1::uuid AND s.user_id = $1::uuid "
      "ORDER BY s.started_at ASC, s.id ASC, st.completed_at ASC, st.set_number ASC",
      user.str());

  std::vector<ExportedSet> out;
  for (const auto& row : rows)
    out.push_back(ExportedSet{row["session_id"].as<std::string>(),
                              row["started_at"].as<std::string>(),
                              row["finished_at"].as<std::string>(),
                              row["routine"].as<std::string>(),
                              row["set_id"].as<std::string>(),
                              row["exercise_id"].as<std::string>(),
                              row["exercise"].as<std::string>(),
                              row["set_number"].as<std::string>(),
                              row["weight_kg"].as<std::string>(),
                              row["reps"].as<std::string>(),
                              row["kind"].as<std::string>(),
                              row["rpe"].as<std::string>(),
                              row["note"].as<std::string>(),
                              row["completed_at"].as<std::string>()});
  return out;
}

std::optional<SessionShare> PgTrainingRepository::insertShare(const SessionShare& incoming,
                                                              std::uint64_t nowMs) {
  // Write then resolve, the same story every other write in this module tells — and the INSERT is a
  // SELECT from the caller's OWN session row, so a session that is absent or another account's
  // inserts nothing, conflicts with nothing, and is answered by the read-back with nothing. That is
  // the whole owner check: there is no branch here that could be got wrong, because a row that is
  // not the caller's never reaches the statement.
  //
  // The conflict is on the session, which is what makes the mint idempotent: tapping Share twice
  // sends one link and not two capabilities to revoke separately. DO UPDATE fires only for a share
  // that has ALREADY ENDED — re-sharing a workout a month later is a new capability, not the
  // resurrection of one that expired — and its guard reads the instant the caller passed rather
  // than the database's own clock, so one clock decides both halves of this write.
  std::optional<SessionShare> stored;
  {
    pqxx::work txn{pgThreadConnection(connString_)};
    txn.exec_params(
        "INSERT INTO gym_session_shares (session_id, user_id, token, expires_at) "
        "SELECT s.id, s.user_id, $3, to_timestamp($4::bigint / 1000.0) "
        "FROM gym_sessions s WHERE s.id = $1 AND s.user_id = $2::uuid "
        "ON CONFLICT (session_id) DO UPDATE "
        "  SET token = excluded.token, expires_at = excluded.expires_at, created_at = now() "
        "  WHERE gym_session_shares.expires_at <= to_timestamp($5::bigint / 1000.0)",
        incoming.session.str(), incoming.user.str(), incoming.token,
        static_cast<long long>(incoming.expiresAtMs), static_cast<long long>(nowMs));
    pqxx::result rows = txn.exec_params(
        "SELECT session_id, user_id, token, "
        "       (extract(epoch from expires_at) * 1000)::bigint AS expires_ms "
        "FROM gym_session_shares "
        "WHERE session_id = $1 AND user_id = $2::uuid "
        "AND expires_at > to_timestamp($3::bigint / 1000.0)",
        incoming.session.str(), incoming.user.str(), static_cast<long long>(nowMs));
    if (!rows.empty())
      stored = SessionShare{SessionId{rows[0]["session_id"].as<std::string>()},
                            UserId{rows[0]["user_id"].as<std::string>()},
                            rows[0]["token"].as<std::string>(),
                            instantFrom(rows[0]["expires_ms"])};
    txn.commit();
  }
  return stored;
}

bool PgTrainingRepository::revokeShare(const UserId& user, const SessionId& id) {
  // Owner-scoped like every write here: another account's share is not refused, it is simply not
  // there to remove. The row IS the capability, so deleting it is the whole revocation — nothing is
  // marked, nothing is swept, and the token it carried resolves to the same nothing an invented one
  // does from the very next request.
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result removed = txn.exec_params(
      "DELETE FROM gym_session_shares WHERE session_id = $1 AND user_id = $2::uuid", id.str(),
      user.str());
  txn.commit();
  return removed.affected_rows() > 0;
}

std::optional<SharedSession> PgTrainingRepository::sharedSession(const std::string& token,
                                                                 std::uint64_t nowMs) {
  // The one read in this module with no owner, and the token is the whole credential. Revoked
  // (no row), expired (a row the predicate rejects) and never-minted (no row) all leave this with
  // nothing to return — one value, so nothing above can tell them apart and neither can a prober.
  //
  // The second statement fires only when the first found a session, which is roadmap's share-page
  // rule applied here: a token that resolves to nothing must not spend a query proving it.
  //
  // The sets carry their movement's display NAME and no id at all: a coach holds no catalog to
  // resolve a slug against, and an id is the one thing a reader who is not the owner could try
  // somewhere else. The routine name is type-checked out of the session's own frozen snapshot, the
  // same guard the prefill read applies — `->>` would render an object or a number as text and
  // print it verbatim as the day of the program.
  std::optional<SharedSession> found;
  {
    pqxx::work txn{pgThreadConnection(connString_)};
    pqxx::result sessions = txn.exec_params(
        "SELECT s.id AS session_id, "
        "       (extract(epoch from s.started_at) * 1000)::bigint AS started_ms, "
        "       (extract(epoch from s.finished_at) * 1000)::bigint AS finished_ms, "
        "       CASE WHEN jsonb_typeof(s.plan->'routine') = 'string' THEN s.plan->>'routine' "
        "            ELSE '' END AS routine "
        "FROM gym_session_shares sh JOIN gym_sessions s ON s.id = sh.session_id "
        "WHERE sh.token = $1 AND sh.expires_at > to_timestamp($2::bigint / 1000.0)",
        token, static_cast<long long>(nowMs));
    if (sessions.empty()) return std::nullopt;

    pqxx::result block = txn.exec_params(
        "SELECT e.name AS exercise, st.set_number, st.weight_kg::float8 AS weight_kg, st.reps, "
        "       st.kind, st.rpe::float8 AS rpe, st.note, "
        "       (extract(epoch from st.completed_at) * 1000)::bigint AS completed_ms "
        "FROM gym_sets st JOIN gym_exercises e ON e.id = st.exercise_id "
        "WHERE st.session_id = $1 ORDER BY st.completed_at ASC, st.set_number ASC",
        sessions[0]["session_id"].as<std::string>());
    std::vector<SharedSet> sets;
    for (const auto& row : block) {
      std::optional<double> rpe;
      if (!row["rpe"].is_null()) rpe = row["rpe"].as<double>();
      sets.push_back(SharedSet{row["exercise"].as<std::string>(), row["set_number"].as<int>(),
                               row["weight_kg"].as<double>(), row["reps"].as<int>(),
                               setKindFromStored(row["kind"].as<std::string>()), rpe,
                               row["note"].as<std::string>(), instantFrom(row["completed_ms"])});
    }
    std::optional<std::uint64_t> finished;
    if (!sessions[0]["finished_ms"].is_null()) finished = instantFrom(sessions[0]["finished_ms"]);
    found = SharedSession{instantFrom(sessions[0]["started_ms"]), finished,
                          sessions[0]["routine"].as<std::string>(), std::move(sets)};
  }
  return found;
}

std::vector<Set> PgTrainingRepository::setsOf(const SessionId& id) {
  // Chronological — the client assembles per-exercise groups in first-performed order from the
  // numbered sets; the server just hands the stream back in the order it was lived.
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kSetColumns) +
          " FROM gym_sets WHERE session_id = $1 ORDER BY completed_at ASC, set_number ASC",
      id.str());

  std::vector<Set> out;
  for (const auto& row : rows) out.push_back(setFrom(row));
  return out;
}

}
