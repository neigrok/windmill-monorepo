#include "products/gym/adapters/postgres/PgProgramRepository.h"

#include "platform/adapters/json/JsonText.h"
#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/adapters/json/TrainingJson.h"
#include "products/gym/adapters/postgres/PgGymRows.h"

#include <pqxx/pqxx>

#include <cstddef>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace wm::gym {

namespace {
// lastTrainedAtMs is an aggregate over the log, not a column: the newest session started under this
// routine, correlated on the routine's own owner.
constexpr std::string_view kRoutineColumns =
    "r.id, r.user_id, r.name, r.position, r.revision, "
    "(extract(epoch from (SELECT max(s.started_at) FROM gym_sessions s "
    "                     WHERE s.routine_id = r.id AND s.user_id = r.user_id)) * 1000)::bigint "
    "  AS last_trained_ms";

constexpr std::string_view kEntryColumns = "routine_id, position, exercise_id, rest_seconds";

// The scheme rows, read beside the lines and joined to them by (routine, position) in memory.
constexpr std::string_view kEntrySetColumns =
    "routine_id, position, set_index, reps, weight_kg::float8 AS weight_kg";

// `changes` is a stored count, not a count of these rows: a `kept` row is not a change and a renamed
// routine is one.
constexpr std::string_view kProposalColumns =
    "p.id, p.routine_id, p.user_id, p.intent, p.base_revision, p.base_name, p.proposed_name, "
    "p.summary, p.changes, p.state, p.door, p.connection, p.agent, p.thread_id, "
    "(extract(epoch from p.created_at) * 1000)::bigint AS created_ms, "
    "(extract(epoch from p.settled_at) * 1000)::bigint AS settled_ms";

// The two sides travel as text: jsonb the wire codec wrote and reads back, clamping.
constexpr std::string_view kProposalChangeColumns =
    "position, kind, exercise_id, "
    "coalesce(before_sets::text, '') AS before_sets, before_rest_seconds, "
    "coalesce(after_sets::text, '') AS after_sets, after_rest_seconds";

// A line's key inside its routine: the store's own (routine_id, position).
using LineKey = std::pair<std::string, int>;

// The schemes of every line the rows cover, in set_index order as the query returned them. A line
// with no rows is absent here, which reads as the open line.
std::map<LineKey, std::vector<SetTarget>> schemesFrom(const pqxx::result& rows) {
  std::map<LineKey, std::vector<SetTarget>> schemes;
  for (const auto& row : rows) {
    // A null reps is `max` and a null weight is last time's set; neither is a zero.
    std::optional<int> reps;
    if (!row["reps"].is_null()) reps = row["reps"].as<int>();
    std::optional<double> weightKg;
    if (!row["weight_kg"].is_null()) weightKg = row["weight_kg"].as<double>();
    schemes[LineKey{row["routine_id"].as<std::string>(), row["position"].as<int>()}].push_back(
        SetTarget{reps, weightKg});
  }
  return schemes;
}

// The position comes from the order the rows came back in, not from the column, so a run left with a
// gap stays legible; the scheme is looked up by the column, which is what its rows are keyed on.
template <typename Row>
RoutineEntry entryFrom(const Row& row, int position,
                       const std::map<LineKey, std::vector<SetTarget>>& schemes) {
  std::vector<SetTarget> sets;
  const auto scheme = schemes.find(
      LineKey{row["routine_id"].template as<std::string>(), row["position"].template as<int>()});
  if (scheme != schemes.end()) sets = scheme->second;
  std::optional<int> restSeconds;
  if (!row["rest_seconds"].is_null()) restSeconds = row["rest_seconds"].template as<int>();
  return RoutineEntry{position, ExerciseId{row["exercise_id"].template as<std::string>()},
                      std::move(sets), restSeconds};
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
                 lastTrained,
                 row["revision"].template as<int>()};
}

template <typename Row>
ProposalHead headFrom(const Row& row) {
  std::optional<std::uint64_t> settled;
  if (!row["settled_ms"].is_null()) settled = instantFrom(row["settled_ms"]);
  // A null thread means there is no conversation to open.
  std::optional<ThreadId> thread;
  if (!row["thread_id"].is_null()) thread = ThreadId{row["thread_id"].template as<std::string>()};
  return ProposalHead{ProposalId{row["id"].template as<std::string>()},
                      RoutineId{row["routine_id"].template as<std::string>()},
                      UserId{row["user_id"].template as<std::string>()},
                      proposalIntentFromStored(row["intent"].template as<std::string>()),
                      proposalStateFromStored(row["state"].template as<std::string>()),
                      ProposalSource{proposalDoorFromStored(row["door"].template as<std::string>()),
                                     row["connection"].template as<std::string>(),
                                     row["agent"].template as<std::string>(), thread},
                      row["summary"].template as<std::string>(),
                      row["changes"].template as<int>(),
                      instantFrom(row["created_ms"]),
                      settled};
}

// Which side is missing is read off `kind`, never guessed from nullness.
template <typename Row>
RoutineChange changeFrom(const Row& row) {
  const std::string kindText = row["kind"].template as<std::string>();
  const ChangeKind kind = kindText == "added"      ? ChangeKind::added
                          : kindText == "removed"  ? ChangeKind::removed
                          : kindText == "retargeted" ? ChangeKind::retargeted
                                                     : ChangeKind::kept;
  // A null scheme is the open line; the codec clamps rather than throws on a stored side.
  const auto targets = [&row](bool missing, const char* sets,
                              const char* rest) -> std::optional<EntryTargets> {
    if (missing) return std::nullopt;
    std::optional<int> restSeconds;
    if (!row[rest].is_null()) restSeconds = row[rest].template as<int>();
    return EntryTargets{setTargetsFrom(parse(row[sets].template as<std::string>())), restSeconds};
  };
  return RoutineChange{row["position"].template as<int>(), kind,
                       ExerciseId{row["exercise_id"].template as<std::string>()},
                       targets(kind == ChangeKind::added, "before_sets", "before_rest_seconds"),
                       targets(kind == ChangeKind::removed, "after_sets", "after_rest_seconds"),
                       0};
}

// Read inside a caller's transaction. A routine holding no lines reads as absent.
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
  const std::map<LineKey, std::vector<SetTarget>> schemes = schemesFrom(txn.exec_params(
      "SELECT " + std::string(kEntrySetColumns) +
          " FROM gym_routine_entry_sets WHERE routine_id = $1 ORDER BY position, set_index",
      id.str()));
  std::vector<RoutineEntry> entries;
  for (const auto& line : lines)
    entries.push_back(entryFrom(line, static_cast<int>(entries.size()) + 1, schemes));
  if (entries.empty()) return std::nullopt;
  return routineFrom(rows[0], std::move(entries));
}

// Read inside a caller's transaction. `loggedSets` is counted at read time, LEFT JOIN so a movement
// planned and never trained answers zero rather than dropping off the diff.
std::optional<RoutineProposal> loadProposal(pqxx::work& txn, const UserId& user,
                                            const ProposalId& id) {
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kProposalColumns) +
          " FROM gym_proposals p WHERE p.id = $1 AND p.user_id = $2::uuid",
      id.str(), user.str());
  if (rows.empty()) return std::nullopt;
  pqxx::result lines = txn.exec_params(
      "SELECT " + std::string(kProposalChangeColumns) +
          " FROM gym_proposal_changes WHERE proposal_id = $1 ORDER BY position",
      id.str());
  pqxx::result logged = txn.exec_params(
      "SELECT c.exercise_id, count(s.id) AS logged "
      "FROM gym_proposal_changes c "
      "LEFT JOIN gym_sets s ON s.exercise_id = c.exercise_id AND s.user_id = $2::uuid "
      "WHERE c.proposal_id = $1 AND c.kind = 'removed' "
      "GROUP BY c.exercise_id",
      id.str(), user.str());

  std::vector<RoutineChange> changes;
  for (const auto& line : lines) changes.push_back(changeFrom(line));
  for (RoutineChange& change : changes)
    for (const auto& count : logged)
      if (count["exercise_id"].as<std::string>() == change.exercise.str())
        change.loggedSets = count["logged"].as<int>();

  const ProposalHead head = headFrom(rows[0]);
  return RoutineProposal{head, rows[0]["base_revision"].as<int>(),
                         rows[0]["base_name"].as<std::string>(),
                         rows[0]["proposed_name"].as<std::string>(), std::move(changes)};
}

}

PgProgramRepository::PgProgramRepository(std::shared_ptr<PgPool> pool)
    : pool_(std::move(pool)) {}

std::vector<Routine> PgProgramRepository::routines(const UserId& user) {
  // Most recently trained first, never-trained after; the tiebreak is stated, not left to the planner.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
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
  const std::map<LineKey, std::vector<SetTarget>> schemes = schemesFrom(txn.exec_params(
      "SELECT " + std::string(kEntrySetColumns) +
          " FROM gym_routine_entry_sets WHERE routine_id IN "
          "  (SELECT id FROM gym_routines WHERE user_id = $1::uuid) "
          "ORDER BY routine_id, position, set_index",
      user.str()));

  std::map<std::string, std::vector<RoutineEntry>> linesByRoutine;
  for (const auto& line : lines) {
    std::vector<RoutineEntry>& entries = linesByRoutine[line["routine_id"].as<std::string>()];
    entries.push_back(entryFrom(line, static_cast<int>(entries.size()) + 1, schemes));
  }

  std::vector<Routine> out;
  for (const auto& row : rows) {
    const auto held = linesByRoutine.find(row["id"].as<std::string>());
    if (held == linesByRoutine.end()) continue;   // no lines: not a plan
    out.push_back(routineFrom(row, std::move(held->second)));
  }
  return out;
}

std::optional<Routine> PgProgramRepository::routine(const UserId& user, const RoutineId& id) {
  std::optional<Routine> found;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    found = loadRoutine(txn, user, id);
  }
  return found;
}

// Proposals newest first and bounded; the creation row is always last. The routine is resolved first
// under the caller's own scope: absent and another account's both answer an empty list.
std::vector<RoutineEvent> PgProgramRepository::routineHistory(const UserId& user,
                                                               const RoutineId& id) {
  std::vector<RoutineEvent> history;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    pqxx::result rows = txn.exec_params(
        "SELECT (extract(epoch from created_at) * 1000)::bigint AS created_ms, "
        "       created_entries, created_door "
        "FROM gym_routines WHERE id = $1 AND user_id = $2::uuid",
        id.str(), user.str());
    if (rows.empty()) return history;

    pqxx::result proposals = txn.exec_params(
        "SELECT " + std::string(kProposalColumns) +
            " FROM gym_proposals p WHERE p.routine_id = $1 AND p.user_id = $2::uuid "
            "ORDER BY p.created_at DESC, p.id DESC LIMIT $3",
        id.str(), user.str(), kRoutineHistoryProposals);
    for (const auto& row : proposals)
      history.push_back(RoutineEvent{RoutineEventKind::proposal, instantFrom(row["created_ms"]),
                                     std::nullopt, std::nullopt, headFrom(row)});

    std::optional<int> movements;
    if (!rows[0]["created_entries"].is_null())
      movements = rows[0]["created_entries"].as<int>();
    std::optional<ProposalDoor> door;
    if (!rows[0]["created_door"].is_null())
      door = proposalDoorFromStored(rows[0]["created_door"].as<std::string>());
    history.push_back(RoutineEvent{RoutineEventKind::created, instantFrom(rows[0]["created_ms"]),
                                   door, movements, std::nullopt});
  }
  return history;
}

std::optional<Routine> PgProgramRepository::routineCreation(const UserId& user, const RoutineId& id) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const auto rows = txn.exec_params("SELECT routine::text FROM gym_routine_creations WHERE routine_id=$1 AND user_id=$2::uuid",
                                    id.str(), user.str());
  if (rows.empty()) return std::nullopt;
  const auto document = parseRoutineWrite(parse(rows[0][0].as<std::string>()));
  return Routine{document.id, user, document.name, document.position, document.entries};
}

std::vector<ProposalHead> PgProgramRepository::proposalHeads(const UserId& user,
                                                              const ProposalQuery& query) {
  // Newest first; both filters are optional, so one statement serves all three questions. The empty
  // string is the "every routine" sentinel — the id-shape rule refuses anything under eight
  // characters, so no routine can be named by it.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kProposalColumns) +
          " FROM gym_proposals p WHERE p.user_id = $1::uuid "
          "  AND ($2 = '' OR p.routine_id = $2) "
          "  AND (NOT $3::boolean OR p.state = 'pending') "
          "ORDER BY p.created_at DESC, p.id DESC",
      user.str(), query.routine ? query.routine->str() : std::string(), query.pendingOnly);

  std::vector<ProposalHead> out;
  for (const auto& row : rows) out.push_back(headFrom(row));
  return out;
}

std::optional<RoutineProposal> PgProgramRepository::proposal(const UserId& user,
                                                              const ProposalId& id) {
  std::optional<RoutineProposal> found;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    found = loadProposal(txn, user, id);
  }
  return found;
}

}
