#include "products/gym/adapters/postgres/PgLogRepository.h"

#include "platform/adapters/json/JsonText.h"
#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/adapters/postgres/PgGymRows.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <pqxx/pqxx>

#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace wm::gym {

namespace {
constexpr std::string_view kSessionColumns =
    "id, user_id, routine_id, coalesce(plan::text, '') AS plan, "
    "(extract(epoch from started_at) * 1000)::bigint AS started_ms, "
    "(extract(epoch from finished_at) * 1000)::bigint AS finished_ms, coalesce(closed_by, '') AS closed_by";

constexpr std::string_view kSetColumns =
    "id, session_id, exercise_id, set_number, weight_kg::float8 AS weight_kg, reps, kind, "
    "rpe::float8 AS rpe, note, (extract(epoch from completed_at) * 1000)::bigint AS completed_ms";

// The two lists are the same columns under the two tables' names, matched by POSITION in the
// insert; `deleted` is the one value each writer passes itself.
constexpr std::string_view kRevisionColumns =
    "set_id, session_id, user_id, exercise_id, set_number, weight_kg, reps, kind, rpe, note, "
    "completed_at, deleted";

constexpr std::string_view kRevisionSource =
    "id, session_id, user_id, exercise_id, set_number, weight_kg, reps, kind, rpe, note, "
    "completed_at";

template <typename Row>
Session sessionFrom(const Row& row) {
  std::optional<std::uint64_t> finished;
  if (!row["finished_ms"].is_null()) finished = instantFrom(row["finished_ms"]);
  std::optional<RoutineId> routine;
  if (!row["routine_id"].is_null()) routine = RoutineId{row["routine_id"].template as<std::string>()};
  return Session{SessionId{row["id"].template as<std::string>()},
                 UserId{row["user_id"].template as<std::string>()},
                 instantFrom(row["started_ms"]), finished, routine,
                 planFrom(parse(row["plan"].template as<std::string>())),
                 closedByFromStored(row["closed_by"].template as<std::string>())};
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

struct Tally {
  int setCount = 0;
  int workingSetCount = 0;
  double tonnageKg = 0;
  std::vector<std::string> exerciseNames;
  std::vector<PriorMark> workingMarks;
};
}

PgLogRepository::PgLogRepository(std::shared_ptr<PgPool> pool)
    : pool_(std::move(pool)) {}

std::optional<Session> PgLogRepository::open(const UserId& user) {
  // Release the pqxx handles in their own scope before returning — never materialise the optional
  // in the expression the transaction is torn down in.
  std::optional<Session> found;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    pqxx::result rows = txn.exec_params(
        "SELECT " + std::string(kSessionColumns) +
            " FROM gym_sessions WHERE user_id = $1::uuid AND finished_at IS NULL",
        user.str());
    if (!rows.empty()) found = sessionFrom(rows[0]);
  }
  return found;
}

std::optional<Session> PgLogRepository::session(const UserId& user, const SessionId& id) {
  std::optional<Session> found;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    pqxx::result rows = txn.exec_params(
        "SELECT " + std::string(kSessionColumns) +
            " FROM gym_sessions WHERE user_id = $1::uuid AND id = $2",
        user.str(), id.str());
    if (!rows.empty()) found = sessionFrom(rows[0]);
  }
  return found;
}

std::optional<Set> PgLogRepository::setOf(const UserId& user, const SetId& id) {
  // Owner-scoped: a set minted by another account resolves to nothing.
  std::optional<Set> found;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    pqxx::result rows = txn.exec_params(
        "SELECT " + std::string(kSetColumns) +
            " FROM gym_sets WHERE user_id = $1::uuid AND id = $2",
        user.str(), id.str());
    if (!rows.empty()) found = setFrom(rows[0]);
  }
  return found;
}

std::optional<std::uint64_t> PgLogRepository::lastActivity(const SessionId& id) {
  std::optional<std::uint64_t> last;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    pqxx::result rows = txn.exec_params(
        "SELECT (extract(epoch from max(completed_at)) * 1000)::bigint AS last_ms "
        "FROM gym_sets WHERE session_id = $1",
        id.str());
    if (!rows.empty() && !rows[0]["last_ms"].is_null()) last = instantFrom(rows[0]["last_ms"]);
  }
  return last;
}

void PgLogRepository::insertSession(const Session& incoming) {
  // Bare ON CONFLICT DO NOTHING swallows BOTH unique violations: the PK (a replayed start) and the
  // one-open partial index.
  pqxx::params params;
  params.append(incoming.id.str());
  params.append(incoming.user.str());
  if (incoming.routine) params.append(incoming.routine->str());
  else params.append();
  // Serialized through the wire codec: `routine` stays the plain string the prefill's jsonb type
  // check looks for.
  if (incoming.plan) params.append(dump(toJson(*incoming.plan)));
  else params.append();
  params.append(static_cast<long long>(incoming.startedAtMs));
  if (incoming.finishedAtMs) params.append(static_cast<long long>(*incoming.finishedAtMs));
  else params.append();

  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec(
      "INSERT INTO gym_sessions (id, user_id, routine_id, plan, started_at, finished_at) "
      "VALUES ($1, $2::uuid, $3, $4::jsonb, to_timestamp($5::bigint / 1000.0), "
      "        to_timestamp($6::bigint / 1000.0)) "
      "ON CONFLICT DO NOTHING",
      params);
  txn.commit();
}

void PgLogRepository::close(const SessionId& id, std::uint64_t finishedAtMs, ClosedBy closedBy) {
  // An open row takes the instant and the word, first-writer-wins. A stale-closed row upgrades to
  // 'finish', moving the end forward only within four hours of the close. Nothing lands over a
  // finish.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "UPDATE gym_sessions "
      "SET finished_at = CASE WHEN finished_at IS NULL THEN to_timestamp($2::bigint / 1000.0) "
      "                       WHEN to_timestamp($2::bigint / 1000.0) > finished_at + interval '4 hours' "
      "                            THEN finished_at "
      "                       ELSE greatest(finished_at, to_timestamp($2::bigint / 1000.0)) END, "
      "    closed_by = $3 "
      "WHERE id = $1 AND (finished_at IS NULL OR (closed_by = 'stale' AND $3 = 'finish'))",
      id.str(), static_cast<long long>(finishedAtMs), toString(closedBy));
  txn.commit();
}

SetInsertOutcome PgLogRepository::insertSet(const Set& incoming) {
  // Lock in its own statement before the insert: under READ COMMITTED an INSERT that both locks and
  // reads max(set_number) misses the row it waited for.
  // The number is max+1 per (session, exercise), not count+1 — the gap a deleted set leaves is not
  // reused. The read-back is scoped to (id, session_id).
  // The locked row decides both refusals only this statement can make: `finished_at`, and the
  // `user_id` the movement is resolved in.
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

    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    pqxx::result locked = txn.exec_params(
        "SELECT " + std::string(kSessionColumns) + " FROM gym_sessions WHERE id = $1 FOR UPDATE",
        incoming.session.str());
    if (locked.empty()) return {std::nullopt, SetInsertError::idTaken};
    // A set id is spent once and for good: asked under the session's lock, so a delete of the same
    // id is either seen or waits behind this transaction. Asked before `finished`, and scoped to
    // the session's OWNER — a deleted id is refused whichever session replays it.
    pqxx::result deleted = txn.exec_params(
        "SELECT 1 FROM gym_set_revisions WHERE set_id = $1 AND user_id = $2::uuid AND deleted "
        "LIMIT 1",
        incoming.id.str(), locked[0]["user_id"].as<std::string>());
    if (!deleted.empty()) return {std::nullopt, SetInsertError::deleted};
    // A set continuing a workout the four-hour rule closed under it lands, and the finish moves
    // forward to it below in this transaction, so a reader never sees the set standing past it.
    const Session session = sessionFrom(locked[0]);
    const bool continuesStaleClose = session.finishedAtMs && lateSetLands(session, incoming.completedAtMs);
    if (session.finishedAtMs && !continuesStaleClose) return {std::nullopt, SetInsertError::finished};
    // The catalog's visibility predicate in the owner the locked row names — the fact the foreign
    // key cannot state.
    if (!namesVisibleMovement(txn, locked[0]["user_id"].as<std::string>(), incoming.exercise))
      return {std::nullopt, SetInsertError::unknownExercise};
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
    pqxx::result rows = txn.exec_params(
        "SELECT " + std::string(kSetColumns) + " FROM gym_sets WHERE id = $1 AND session_id = $2",
        incoming.id.str(), incoming.session.str());
    if (!rows.empty()) stored = setFrom(rows[0]);
    if (stored && continuesStaleClose)
      txn.exec_params(
          "UPDATE gym_sessions SET finished_at = greatest(finished_at, to_timestamp($2::bigint / 1000.0)) "
          "WHERE id = $1",
          incoming.session.str(), static_cast<long long>(incoming.completedAtMs));
    txn.commit();
  }
  if (!stored) return {std::nullopt, SetInsertError::idTaken};
  return {stored, SetInsertError::none};
}

// Lock the SESSION row in its own statement first: one lock order for every write that changes what
// a workout holds, and gym_set_revisions' foreign key to gym_sessions deadlocks any other order.
// Under READ COMMITTED the second statement then reads at a fresh snapshot and keeps what a racing
// correction wrote. One statement does both halves, so the row is never rewritten with its previous
// value unkept. The revision copy is taken only where a value actually changes, so a resent
// identical fix keeps nothing. Both statements are scoped to (id, session, owner).
std::optional<Set> PgLogRepository::updateSet(const UserId& user, const Set& corrected) {
  std::optional<Set> stored;
  {
    pqxx::params params;
    params.append(corrected.id.str());
    params.append(corrected.session.str());
    params.append(user.str());
    params.append(corrected.weightKg);
    params.append(corrected.reps);
    params.append(toString(corrected.kind));
    if (corrected.rpe) params.append(*corrected.rpe);
    else params.append();
    params.append(corrected.note);

    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    pqxx::result locked = txn.exec_params(
        "SELECT id FROM gym_sessions WHERE id = $1 AND user_id = $2::uuid FOR UPDATE",
        corrected.session.str(), user.str());
    if (locked.empty()) return std::nullopt;
    pqxx::result rows = txn.exec(
        "WITH kept AS ("
        "  INSERT INTO gym_set_revisions (" + std::string(kRevisionColumns) + ") "
        "  SELECT " + std::string(kRevisionSource) + ", false FROM gym_sets "
        "  WHERE id = $1 AND session_id = $2 AND user_id = $3::uuid "
        "    AND (weight_kg, reps, kind, rpe, note) IS DISTINCT FROM "
        "        ($4::numeric, $5::int, $6::text, $7::numeric, $8::text)) "
        "UPDATE gym_sets SET weight_kg = $4, reps = $5, kind = $6, rpe = $7, note = $8 "
        "WHERE id = $1 AND session_id = $2 AND user_id = $3::uuid "
        "RETURNING " + std::string(kSetColumns),
        params);
    if (!rows.empty()) stored = setFrom(rows[0]);
    txn.commit();
  }
  return stored;
}

// The SESSION's lock first, same order as the other writes: insertSet reads gym_set_revisions under
// this same lock, so a replayed append and the delete it races cannot both find nothing.
// One statement for the move — the DELETE's RETURNING feeds the INSERT, so the row is never absent
// from both tables. `deleted` marks it as no longer standing, as against a correction's copy, and
// the append above reads exactly that flag.
// Nothing is refused: a set that was never here lets a lost reply resend the same delete. Set
// numbers are not closed up behind it.
void PgLogRepository::deleteSet(const UserId& user, const SessionId& session, const SetId& id) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result locked = txn.exec_params(
      "SELECT id FROM gym_sessions WHERE id = $1 AND user_id = $2::uuid FOR UPDATE",
      session.str(), user.str());
  if (locked.empty()) return;
  txn.exec_params(
      "WITH gone AS ("
      "  DELETE FROM gym_sets WHERE id = $1 AND session_id = $2 AND user_id = $3::uuid "
      "  RETURNING " + std::string(kRevisionSource) + ") "
      "INSERT INTO gym_set_revisions (" + std::string(kRevisionColumns) + ") "
      "SELECT " + std::string(kRevisionSource) + ", true FROM gone",
      id.str(), session.str(), user.str());
  txn.commit();
}

LogPage PgLogRepository::log(const UserId& user, const LogCursor& cursor) {
  // Four queries over the same keyset window, merged by session id, all inside one transaction so
  // no row of a page can lose an aggregate to a write landing between them.
  // `set_count` is every row a session holds; `working_set_count` is the working ones, which is what
  // the top set is drawn from. `tonnage_kg` sums the working rows with the load CLAMPED at zero:
  // band-assisted work stores a negative kg.
  // The window compares the PAIR (started_at, id), which is unique. An absent tiebreaker passes the
  // empty id — the floor of the text order.
  // The marks statements are one row per (movement, load) carrying the best reps at it, dated by the
  // SESSION the mark was set in, never by the set's own completed_at. Loads at or below zero are not
  // filtered out.
  // The fourth is the marks standing BEFORE the page, narrowed to the movements this page trains and
  // floored at the page's last row; an empty page skips it. Only that one counts finished sessions —
  // the third carries the open workout as a row like any other, and the domain folds only the
  // finished ones.
  // The top set is a lateral over the session's WORKING sets, heaviest first, ties to more reps.
  const std::string beforeId = cursor.beforeId ? cursor.beforeId->str() : "";
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result sessions = txn.exec_params(
      "SELECT " + std::string(kSessionColumns) +
          ", top.weight_kg::float8 AS top_weight_kg, top.reps AS top_reps, "
          "(CASE WHEN closed_by IS NOT NULL THEN closed_by = 'stale' "
          "      ELSE finished_at IS NOT NULL AND finished_at = coalesce("
          "        (SELECT max(a.completed_at) FROM gym_sets a WHERE a.session_id = gym_sessions.id), "
          "        started_at) END) AS closed_itself "
          "FROM gym_sessions "
          "LEFT JOIN LATERAL (SELECT w.weight_kg, w.reps FROM gym_sets w "
          "                   WHERE w.session_id = gym_sessions.id AND w.kind = 'working' "
          "                   ORDER BY w.weight_kg DESC, w.reps DESC LIMIT 1) top ON true "
          "WHERE user_id = $1::uuid "
          "AND (started_at, id) < (to_timestamp($2::bigint / 1000.0), $3) "
          "ORDER BY started_at DESC, id DESC LIMIT $4",
      user.str(), static_cast<long long>(cursor.beforeMs), beforeId, cursor.limit);
  pqxx::result tallies = txn.exec_params(
      "SELECT st.session_id, coalesce(n.name, e.name) AS name, count(*)::int AS set_count, "
      "  (count(*) FILTER (WHERE st.kind = 'working'))::int AS working_set_count, "
      "  coalesce(sum(greatest(st.weight_kg, 0) * st.reps) "
      "           FILTER (WHERE st.kind = 'working'), 0)::float8 AS tonnage_kg "
      "FROM gym_sets st JOIN gym_exercises e ON e.id = st.exercise_id "
      "                 LEFT JOIN gym_exercise_names n "
      "                   ON n.exercise_id = e.id AND n.user_id = $1::uuid "
      "WHERE st.session_id IN "
      "  (SELECT id FROM gym_sessions WHERE user_id = $1::uuid "
      "   AND (started_at, id) < (to_timestamp($2::bigint / 1000.0), $3) "
      "   ORDER BY started_at DESC, id DESC LIMIT $4) "
      "GROUP BY st.session_id, coalesce(n.name, e.name) "
      "ORDER BY st.session_id, coalesce(n.name, e.name)",
      user.str(), static_cast<long long>(cursor.beforeMs), beforeId, cursor.limit);
  pqxx::result ladders = txn.exec_params(
      "SELECT DISTINCT ON (st.session_id, st.exercise_id, st.weight_kg) "
      "       st.session_id, st.exercise_id, st.weight_kg::float8 AS weight_kg, st.reps, "
      "       (extract(epoch from s.started_at) * 1000)::bigint AS at_ms "
      "FROM gym_sets st JOIN gym_sessions s ON s.id = st.session_id "
      "WHERE st.kind = 'working' AND st.session_id IN "
      "  (SELECT id FROM gym_sessions WHERE user_id = $1::uuid "
      "   AND (started_at, id) < (to_timestamp($2::bigint / 1000.0), $3) "
      "   ORDER BY started_at DESC, id DESC LIMIT $4) "
      "ORDER BY st.session_id, st.exercise_id, st.weight_kg DESC, st.reps DESC, "
      "         st.completed_at ASC",
      user.str(), static_cast<long long>(cursor.beforeMs), beforeId, cursor.limit);

  std::map<std::string, Tally> tallyBySession;
  for (const auto& row : tallies) {
    Tally& tally = tallyBySession[row["session_id"].as<std::string>()];
    tally.setCount += row["set_count"].as<int>();
    tally.workingSetCount += row["working_set_count"].as<int>();
    tally.tonnageKg += row["tonnage_kg"].as<double>();
    tally.exerciseNames.push_back(row["name"].as<std::string>());
  }
  for (const auto& row : ladders)
    tallyBySession[row["session_id"].as<std::string>()].workingMarks.push_back(markFrom(row));

  LogPage page;
  for (const auto& row : sessions) {
    Session session = sessionFrom(row);
    std::optional<TopWorkingSet> top;
    if (!row["top_weight_kg"].is_null())
      top = TopWorkingSet{row["top_weight_kg"].as<double>(), row["top_reps"].as<int>()};
    const bool closedItself = row["closed_itself"].as<bool>();
    const auto tally = tallyBySession.find(session.id.str());
    if (tally == tallyBySession.end()) {
      page.sessions.push_back(SessionSummary{session, 0, 0, 0, {}, top, {}, closedItself});
      continue;
    }
    page.sessions.push_back(SessionSummary{session, tally->second.setCount,
                                           tally->second.workingSetCount, tally->second.tonnageKg,
                                           tally->second.exerciseNames, top,
                                           tally->second.workingMarks, closedItself});
  }
  if (page.sessions.empty()) return page;

  const Session& oldest = page.sessions.back().session;
  pqxx::result standing = txn.exec_params(
      "SELECT DISTINCT ON (st.exercise_id, st.weight_kg) "
      "       st.exercise_id, st.weight_kg::float8 AS weight_kg, st.reps, "
      "       (extract(epoch from s.started_at) * 1000)::bigint AS at_ms "
      "FROM gym_sets st JOIN gym_sessions s ON s.id = st.session_id "
      "WHERE st.user_id = $1::uuid AND st.kind = 'working' AND s.finished_at IS NOT NULL "
      "  AND (s.started_at, s.id) < (to_timestamp($2::bigint / 1000.0), $3) "
      "  AND st.exercise_id IN "
      "    (SELECT p.exercise_id FROM gym_sets p JOIN gym_sessions ps ON ps.id = p.session_id "
      "     WHERE ps.user_id = $1::uuid AND p.kind = 'working' "
      "       AND (ps.started_at, ps.id) >= (to_timestamp($2::bigint / 1000.0), $3) "
      "       AND (ps.started_at, ps.id) <  (to_timestamp($4::bigint / 1000.0), $5)) "
      "ORDER BY st.exercise_id, st.weight_kg DESC, st.reps DESC, s.started_at ASC, s.id ASC, "
      "         st.completed_at ASC",
      user.str(), static_cast<long long>(oldest.startedAtMs), oldest.id.str(),
      static_cast<long long>(cursor.beforeMs), beforeId);
  for (const auto& row : standing) page.standing.push_back(markFrom(row));
  return page;
}

std::vector<Set> PgLogRepository::setsOf(const SessionId& id) {
  // Chronological: the client assembles per-exercise groups in first-performed order from this
  // stream.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kSetColumns) +
          " FROM gym_sets WHERE session_id = $1 ORDER BY completed_at ASC, set_number ASC",
      id.str());

  std::vector<Set> out;
  for (const auto& row : rows) out.push_back(setFrom(row));
  return out;
}

LastTimeOutcome PgLogRepository::lastTime(const UserId& user, const ExerciseId& exercise) {
  // Walks SESSIONS newest first on (started_at, id) — the key the log read pages on — and stops at
  // the first finished one holding a working set: completed_at is the device's wall clock and cannot
  // order sessions. The EXISTS probe carries the block read's predicates, so a located session
  // always has a non-empty block.
  // Owner-scoped on both halves, never through the invariant that a set row inherits its session's
  // owner.
  // The routine name comes from the session's own frozen snapshot and is type-checked as a string:
  // ->> renders an object, an array or a number as JSON text.
  std::optional<LastTime> found;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
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
      // The catalog is consulted only with no history to return, and scoped: another account's
      // custom movement is unknown here.
      if (txn.exec_params("SELECT 1 FROM gym_exercises "
                          "WHERE id = $1 AND (created_by IS NULL OR created_by = $2::uuid)",
                          exercise.str(), user.str())
              .empty())
        return {std::nullopt, LastTimeError::unknownExercise};
      return {std::nullopt, LastTimeError::none};
    }
    // Warmups excluded: the prefill dials the weight off the last row of this block.
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

std::vector<LastSet> PgLogRepository::lastSets(const UserId& user) {
  // lastTime over every movement at once, one line each. The DISTINCT ON ORDER BY is the locator's
  // rule — newest finished session on (started_at, id), then the highest set_number in it — so the
  // first row per movement is the last row of that movement's lastTime block.
  // Only the movements this account has WORKED come back; the catalog is not joined in.
  // Owner-scoped on both halves like the locator, never through the invariant that a set row
  // inherits its session's owner. Warmups are out under the same rule.
  // Must not be driven off the catalog: a LATERAL per catalog row proves "no last time" for every
  // untouched movement by walking every session the account ever ran.
  std::vector<LastSet> out;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    pqxx::result rows = txn.exec_params(
        "SELECT DISTINCT ON (st.exercise_id) st.exercise_id, st.weight_kg::float8 AS weight_kg, "
        "       st.reps, (extract(epoch from s.started_at) * 1000)::bigint AS at_ms "
        "FROM gym_sets st JOIN gym_sessions s ON s.id = st.session_id "
        "WHERE st.user_id = $1::uuid AND s.user_id = $1::uuid "
        "      AND s.finished_at IS NOT NULL AND st.kind <> 'warmup' "
        "ORDER BY st.exercise_id, s.started_at DESC, s.id DESC, st.set_number DESC",
        user.str());
    for (const auto& row : rows)
      out.push_back(LastSet{ExerciseId{row["exercise_id"].as<std::string>()},
                            row["weight_kg"].as<double>(), row["reps"].as<int>(),
                            instantFrom(row["at_ms"])});
  }
  return out;
}

SessionHistory PgLogRepository::historyFor(const UserId& user, const Session& session) {
  // At most three statements in one transaction; the comparison's two fire only for a session that
  // named a routine.
  // The marks are one row per (movement, load) carrying the BEST reps ever done at it, kept from the
  // EARLIEST session to hit them, so the mark is dated by that workout. The Epley formula stays out
  // of SQL.
  // Both windows compare the PAIR (started_at, id) against this session's own, which excludes the
  // session from its own history.
  SessionHistory history;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    pqxx::result marks = txn.exec_params(
        "SELECT DISTINCT ON (st.exercise_id, st.weight_kg) "
        "       st.exercise_id, st.weight_kg::float8 AS weight_kg, st.reps, "
        "       (extract(epoch from s.started_at) * 1000)::bigint AS at_ms "
        "FROM gym_sets st JOIN gym_sessions s ON s.id = st.session_id "
        "WHERE st.user_id = $1::uuid AND st.kind = 'working' AND s.finished_at IS NOT NULL "
        "  AND (s.started_at, s.id) < (to_timestamp($2::bigint / 1000.0), $3) "
        "  AND st.exercise_id IN (SELECT exercise_id FROM gym_sets "
        "                         WHERE session_id = $3 AND kind = 'working') "
        "ORDER BY st.exercise_id, st.weight_kg, st.reps DESC, s.started_at ASC, s.id ASC, "
        "         st.completed_at ASC",
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

bool PgLogRepository::deleteSession(const UserId& user, const SessionId& id) {
  // The sets cascade with the row. Owner-scoped: another account's session is not refused, it is
  // simply not there to remove.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result removed = txn.exec_params(
      "DELETE FROM gym_sessions WHERE id = $1 AND user_id = $2::uuid", id.str(), user.str());
  txn.commit();
  return removed.affected_rows() > 0;
}

MovementHistory PgLogRepository::movementHistory(const UserId& user,
                                                      const ExerciseId& exercise) {
  // Four statements in one transaction. The first is the catalog's own visibility predicate: no row
  // and the other three never fire.
  // The LADDERS are `DISTINCT ON (session, load)` over this movement's working sets in finished
  // sessions, oldest session first and heaviest load first inside each, over a lifetime — the chart
  // is windowed by the domain. A ladder row is dated by its session.
  // The RECENT days are the last ten training days, warmups excluded, listed set by set rather than
  // collapsed by load.
  MovementHistory history;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    pqxx::result known = txn.exec_params(
        "SELECT " + std::string(kExerciseColumns) + " FROM " + std::string(kExerciseFrom) +
            " WHERE e.id = $2 AND (e.created_by IS NULL OR e.created_by = $1::uuid)",
        user.str(), exercise.str());
    if (known.empty()) return history;
    history.exercise = exerciseFrom(known[0]);

    // DISTINCT: a routine may name one movement twice. In the lifter's own program order.
    pqxx::result held = txn.exec_params(
        "SELECT DISTINCT r.name, r.position, r.id FROM gym_routines r "
        "JOIN gym_routine_entries en ON en.routine_id = r.id "
        "WHERE r.user_id = $1::uuid AND en.exercise_id = $2 "
        "ORDER BY r.position ASC, r.id ASC",
        user.str(), exercise.str());
    for (const auto& row : held) history.routines.push_back(row["name"].as<std::string>());

    pqxx::result ladders = txn.exec_params(
        "SELECT DISTINCT ON (s.started_at, s.id, st.weight_kg) "
        "       s.id AS session_id, (extract(epoch from s.started_at) * 1000)::bigint AS started_ms, "
        "       st.exercise_id, st.weight_kg::float8 AS weight_kg, st.reps, "
        "       (extract(epoch from s.started_at) * 1000)::bigint AS at_ms "
        "FROM gym_sets st JOIN gym_sessions s ON s.id = st.session_id "
        "WHERE st.user_id = $1::uuid AND st.exercise_id = $2 AND st.kind = 'working' "
        "  AND s.finished_at IS NOT NULL "
        "ORDER BY s.started_at ASC, s.id ASC, st.weight_kg DESC, st.reps DESC, "
        "         st.completed_at ASC",
        user.str(), exercise.str());
    for (const auto& row : ladders) {
      const std::string session = row["session_id"].as<std::string>();
      if (history.sessions.empty() || history.sessions.back().session.str() != session)
        history.sessions.push_back(
            MovementSession{SessionId{session}, instantFrom(row["started_ms"]), {}});
      history.sessions.back().loads.push_back(markFrom(row));
    }

    pqxx::result recent = txn.exec_params(
        "WITH ran AS ("
        "  SELECT s.id AS ran_id, s.started_at AS ran_started FROM gym_sessions s "
        "  WHERE s.user_id = $1::uuid AND s.finished_at IS NOT NULL "
        "    AND EXISTS (SELECT 1 FROM gym_sets d WHERE d.session_id = s.id "
        "                AND d.user_id = $1::uuid AND d.exercise_id = $2 AND d.kind <> 'warmup') "
        "  ORDER BY s.started_at DESC, s.id DESC LIMIT $3) "
        "SELECT ran_id, (extract(epoch from ran_started) * 1000)::bigint AS started_ms, " +
            std::string(kSetColumns) +
            " FROM ran JOIN gym_sets st ON st.session_id = ran_id "
            "WHERE st.user_id = $1::uuid AND st.exercise_id = $2 AND st.kind <> 'warmup' "
            "ORDER BY ran_started DESC, ran_id DESC, st.set_number ASC",
        user.str(), exercise.str(), kRecentDays);
    for (const auto& row : recent) {
      const std::string session = row["ran_id"].as<std::string>();
      if (history.recent.empty() || history.recent.back().session.str() != session)
        history.recent.push_back(
            MovementDay{SessionId{session}, instantFrom(row["started_ms"]), {}});
      history.recent.back().sets.push_back(setFrom(row));
    }
  }
  return history;
}

TrainingLog PgLogRepository::trainingLog(const UserId& user) {
  // Three statements in one transaction.
  // The series is `DISTINCT ON (movement, session)` keeping the heaviest set with the most reps —
  // an ORDERING, not a calculation; the Epley estimate over it stays in the domain. Rows come back
  // grouped by movement, oldest first inside each group, which is the port's contract.
  // The marks are historyFor's projection with both of its windows removed.
  // Weeks are truncated `AT TIME ZONE 'UTC'`: date_trunc on a timestamptz reads the session's
  // TimeZone setting and would bucket the same log differently on a laptop and in CI.
  // generate_series fills the gaps, so an untrained week is a zero rather than a missing bar.
  TrainingLog log;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
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
        "       (extract(epoch from s.started_at) * 1000)::bigint AS at_ms "
        "FROM gym_sets st JOIN gym_sessions s ON s.id = st.session_id "
        "WHERE st.user_id = $1::uuid AND st.kind = 'working' AND s.finished_at IS NOT NULL "
        "ORDER BY st.exercise_id, st.weight_kg, st.reps DESC, s.started_at ASC, s.id ASC, "
        "         st.completed_at ASC",
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

std::vector<ExportedSet> PgLogRepository::exportedSets(const UserId& user) {
  // Every value comes back as TEXT, rendered by Postgres: instants as ISO-8601 UTC, numerics at
  // their column's own scale (72.5 kg is "72.50"), an absent rpe as an empty cell and never a zero.
  // Ordered by the session's (started_at, id) pair and then by the sets inside it. Nothing is
  // excluded — the open session is in the file too. The routine name is the frozen snapshot.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT st.session_id, "
      "       to_char(s.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') "
      "         AS started_at, "
      "       coalesce(to_char(s.finished_at AT TIME ZONE 'UTC', "
      "                        'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), '') AS finished_at, "
      "       CASE WHEN jsonb_typeof(s.plan->'routine') = 'string' THEN s.plan->>'routine' "
      "            ELSE '' END AS routine, "
      // The movement travels under the name the OWNER of this file calls it.
      "       st.id AS set_id, st.exercise_id, coalesce(n.name, e.name) AS exercise, "
      "       st.set_number::text AS set_number, st.weight_kg::text AS weight_kg, "
      "       st.reps::text AS reps, st.kind, coalesce(st.rpe::text, '') AS rpe, st.note, "
      "       to_char(st.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') "
      "         AS completed_at "
      "FROM gym_sets st JOIN gym_sessions s ON s.id = st.session_id "
      "                 JOIN gym_exercises e ON e.id = st.exercise_id "
      "                 LEFT JOIN gym_exercise_names n "
      "                   ON n.exercise_id = e.id AND n.user_id = $1::uuid "
      // Scoped on BOTH halves rather than through the invariant that a set row inherits its
      // session's owner.
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

std::optional<SessionShare> PgLogRepository::insertShare(const SessionShare& incoming,
                                                              std::uint64_t nowMs) {
  // The INSERT selects from the caller's OWN session row, so a session that is absent or another
  // account's inserts nothing — that is the whole owner check.
  // The conflict is on the session, which makes the mint idempotent. DO UPDATE fires only for a
  // share that has ALREADY ENDED, judged by the instant the caller passed rather than the database
  // clock, so one clock decides both halves of this write.
  std::optional<SessionShare> stored;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
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

bool PgLogRepository::revokeShare(const UserId& user, const SessionId& id) {
  // The row IS the capability, so deleting it is the whole revocation. Owner-scoped: another
  // account's share is not refused, it is simply not there to remove.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result removed = txn.exec_params(
      "DELETE FROM gym_session_shares WHERE session_id = $1 AND user_id = $2::uuid", id.str(),
      user.str());
  txn.commit();
  return removed.affected_rows() > 0;
}

std::optional<SharedSession> PgLogRepository::sharedSession(const std::string& token,
                                                                 std::uint64_t nowMs) {
  // No owner behind this read: the token is the whole credential. Revoked, expired and never-minted
  // all return nothing, so none can be told apart.
  // The second statement fires only when the first found a session.
  // The sets carry their movement's display NAME and no id at all. The routine name is type-checked
  // out of the session's frozen snapshot: `->>` would render an object or a number as text.
  std::optional<SharedSession> found;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    pqxx::result sessions = txn.exec_params(
        "SELECT s.id AS session_id, s.user_id AS owner, "
        "       (extract(epoch from s.started_at) * 1000)::bigint AS started_ms, "
        "       (extract(epoch from s.finished_at) * 1000)::bigint AS finished_ms, "
        "       CASE WHEN jsonb_typeof(s.plan->'routine') = 'string' THEN s.plan->>'routine' "
        "            ELSE '' END AS routine "
        "FROM gym_session_shares sh JOIN gym_sessions s ON s.id = sh.session_id "
        "WHERE sh.token = $1 AND sh.expires_at > to_timestamp($2::bigint / 1000.0)",
        token, static_cast<long long>(nowMs));
    if (sessions.empty()) return std::nullopt;

    // The names are the OWNER's, resolved through the owner the session row itself names.
    pqxx::result block = txn.exec_params(
        "SELECT coalesce(n.name, e.name) AS exercise, st.set_number, "
        "       st.weight_kg::float8 AS weight_kg, st.reps, "
        "       st.kind, st.rpe::float8 AS rpe, st.note, "
        "       (extract(epoch from st.completed_at) * 1000)::bigint AS completed_ms "
        "FROM gym_sets st JOIN gym_exercises e ON e.id = st.exercise_id "
        "                 LEFT JOIN gym_exercise_names n "
        "                   ON n.exercise_id = e.id AND n.user_id = $2::uuid "
        "WHERE st.session_id = $1 ORDER BY st.completed_at ASC, st.set_number ASC",
        sessions[0]["session_id"].as<std::string>(), sessions[0]["owner"].as<std::string>());
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

}
