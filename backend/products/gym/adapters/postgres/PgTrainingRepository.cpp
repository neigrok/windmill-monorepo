#include "products/gym/adapters/postgres/PgTrainingRepository.h"

#include "platform/adapters/postgres/PgConnection.h"

#include <pqxx/pqxx>

#include <map>
#include <string>
#include <string_view>
#include <utility>

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
  return Session{SessionId{row["id"].template as<std::string>()},
                 UserId{row["user_id"].template as<std::string>()},
                 instantFrom(row["started_ms"]), finished, routine,
                 row["plan"].template as<std::string>()};
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
}

PgTrainingRepository::PgTrainingRepository(std::string connString)
    : connString_(std::move(connString)) {}

std::vector<Exercise> PgTrainingRepository::catalog(const UserId& user) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT id, name, pattern, equipment, step_kg::float8 AS step_kg, created_by "
      "FROM gym_exercises WHERE created_by IS NULL OR created_by = $1::uuid "
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
  if (!incoming.planJson.empty()) params.append(incoming.planJson);
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
  const std::string beforeId = cursor.beforeId ? cursor.beforeId->str() : "";
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result sessions = txn.exec_params(
      "SELECT " + std::string(kSessionColumns) +
          " FROM gym_sessions WHERE user_id = $1::uuid "
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
    const auto tally = tallyBySession.find(session.id.str());
    if (tally == tallyBySession.end()) {
      out.push_back(SessionSummary{session, 0, {}});
      continue;
    }
    out.push_back(SessionSummary{session, tally->second.setCount, tally->second.exerciseNames});
  }
  return out;
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
