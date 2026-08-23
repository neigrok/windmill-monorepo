#include "products/gym/adapters/postgres/PgProgramRepository.h"

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/adapters/postgres/PgGymRows.h"

#include <pqxx/pqxx>

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

constexpr std::string_view kEntryColumns =
    "routine_id, position, exercise_id, target_sets, target_reps, "
    "target_weight_kg::float8 AS target_weight_kg, rest_seconds";

// `changes` is a stored count, not a count of these rows: a `kept` row is not a change and a renamed
// routine is one.
constexpr std::string_view kProposalColumns =
    "p.id, p.routine_id, p.user_id, p.intent, p.base_revision, p.base_name, p.proposed_name, "
    "p.summary, p.changes, p.state, p.door, p.connection, p.agent, p.thread_id, "
    "(extract(epoch from p.created_at) * 1000)::bigint AS created_ms, "
    "(extract(epoch from p.settled_at) * 1000)::bigint AS settled_ms";

constexpr std::string_view kProposalChangeColumns =
    "position, kind, exercise_id, before_sets, before_reps, "
    "before_weight_kg::float8 AS before_weight_kg, before_rest_seconds, "
    "after_sets, after_reps, after_weight_kg::float8 AS after_weight_kg, after_rest_seconds";


// The position comes from the order the rows came back in, not from the column, so a run left with a
// gap stays legible.
template <typename Row>
RoutineEntry entryFrom(const Row& row, int position) {
  // A null target_sets is the open line and a null target_reps is `max`; neither is a zero.
  std::optional<int> targetSets;
  if (!row["target_sets"].is_null()) targetSets = row["target_sets"].template as<int>();
  std::optional<int> targetReps;
  if (!row["target_reps"].is_null()) targetReps = row["target_reps"].template as<int>();
  std::optional<double> targetWeightKg;
  if (!row["target_weight_kg"].is_null())
    targetWeightKg = row["target_weight_kg"].template as<double>();
  std::optional<int> restSeconds;
  if (!row["rest_seconds"].is_null()) restSeconds = row["rest_seconds"].template as<int>();
  return RoutineEntry{position, ExerciseId{row["exercise_id"].template as<std::string>()},
                      targetSets, targetReps, targetWeightKg, restSeconds};
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
  const auto targets = [&row](bool missing, const char* sets, const char* reps, const char* weight,
                              const char* rest) -> std::optional<EntryTargets> {
    if (missing) return std::nullopt;
    std::optional<int> targetSets;
    if (!row[sets].is_null()) targetSets = row[sets].template as<int>();
    std::optional<int> targetReps;
    if (!row[reps].is_null()) targetReps = row[reps].template as<int>();
    std::optional<double> targetWeight;
    if (!row[weight].is_null()) targetWeight = row[weight].template as<double>();
    std::optional<int> restSeconds;
    if (!row[rest].is_null()) restSeconds = row[rest].template as<int>();
    return EntryTargets{targetSets, targetReps, targetWeight, restSeconds};
  };
  return RoutineChange{row["position"].template as<int>(), kind,
                       ExerciseId{row["exercise_id"].template as<std::string>()},
                       targets(kind == ChangeKind::added, "before_sets", "before_reps",
                               "before_weight_kg", "before_rest_seconds"),
                       targets(kind == ChangeKind::removed, "after_sets", "after_reps",
                               "after_weight_kg", "after_rest_seconds"),
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
  std::vector<RoutineEntry> entries;
  for (const auto& line : lines)
    entries.push_back(entryFrom(line, static_cast<int>(entries.size()) + 1));
  if (entries.empty()) return std::nullopt;
  return routineFrom(rows[0], std::move(entries));
}

// `false` means a line named a movement this account may not see; the caller must return at once so
// the transaction rolls back every line already laid down.
bool insertEntries(pqxx::work& txn, const Routine& incoming) {
  for (const RoutineEntry& entry : incoming.entries) {
    if (!namesVisibleMovement(txn, incoming.user.str(), entry.exercise)) return false;
    pqxx::params params;
    params.append(incoming.id.str());
    params.append(entry.position);
    params.append(entry.exercise.str());
    if (entry.targetSets) params.append(*entry.targetSets);
    else params.append();
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
  return true;
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

// `false` means a line named a movement this account may not see; the caller must return at once so
// the transaction rolls back every line already laid down.
bool insertProposalChanges(pqxx::work& txn, const RoutineProposal& incoming) {
  for (const RoutineChange& change : incoming.changes) {
    if (!namesVisibleMovement(txn, incoming.head.user.str(), change.exercise)) return false;
    pqxx::params params;
    params.append(incoming.head.id.str());
    params.append(change.position);
    params.append(incoming.head.user.str());
    if (change.kind == ChangeKind::added) params.append("added");
    else if (change.kind == ChangeKind::removed) params.append("removed");
    else if (change.kind == ChangeKind::retargeted) params.append("retargeted");
    else params.append("kept");
    params.append(change.exercise.str());
    for (const std::optional<EntryTargets>& side : {change.before, change.after}) {
      if (!side) {
        params.append();
        params.append();
        params.append();
        params.append();
        continue;
      }
      if (side->sets) params.append(*side->sets);
      else params.append();
      if (side->reps) params.append(*side->reps);
      else params.append();
      if (side->weightKg) params.append(*side->weightKg);
      else params.append();
      if (side->restSeconds) params.append(*side->restSeconds);
      else params.append();
    }
    txn.exec("INSERT INTO gym_proposal_changes (proposal_id, position, user_id, kind, exercise_id, "
             "  before_sets, before_reps, before_weight_kg, before_rest_seconds, "
             "  after_sets, after_reps, after_weight_kg, after_rest_seconds) "
             "VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
             params);
  }
  return true;
}

// Not a delete: a superseded proposal drops into the routine's history.
void supersedeOnRoutine(pqxx::work& txn, const UserId& user, const RoutineId& routine,
                        const std::string& except, std::uint64_t nowMs) {
  txn.exec_params("UPDATE gym_proposals "
                  "SET state = 'superseded', settled_at = to_timestamp($3::bigint / 1000.0) "
                  "WHERE routine_id = $1 AND user_id = $2::uuid AND state = 'pending' AND id <> $4",
                  routine.str(), user.str(), static_cast<long long>(nowMs), except);
}

// Answered before anything is written, and asked globally rather than under the caller's scope
// because the id is a primary key across every account. The caller's own id splits on the document:
// the same one replays, a different one is refused.
std::optional<ProposalMintOutcome> spentId(pqxx::work& txn, const RoutineProposal& incoming) {
  pqxx::result held = txn.exec_params(
      "SELECT (user_id = $2::uuid) AS mine FROM gym_proposals WHERE id = $1",
      incoming.head.id.str(), incoming.head.user.str());
  if (held.empty()) return std::nullopt;
  if (!held[0]["mine"].as<bool>())
    return ProposalMintOutcome{std::nullopt, ProposalMintError::idTaken};
  std::optional<RoutineProposal> mine = loadProposal(txn, incoming.head.user, incoming.head.id);
  if (mine && isReplayOf(*mine, incoming))
    return ProposalMintOutcome{mine, ProposalMintError::none};
  return ProposalMintOutcome{std::nullopt, ProposalMintError::idReused};
}

void supersedeFromDoor(pqxx::work& txn, const RoutineProposal& incoming) {
  txn.exec_params("UPDATE gym_proposals "
                  "SET state = 'superseded', settled_at = to_timestamp($3::bigint / 1000.0) "
                  "WHERE routine_id = $1 AND user_id = $2::uuid AND state = 'pending' "
                  "  AND door = $4 AND connection = $5 AND id <> $6",
                  incoming.head.routine.str(), incoming.head.user.str(),
                  static_cast<long long>(incoming.head.createdAtMs),
                  toString(incoming.head.source.door), incoming.head.source.connection,
                  incoming.head.id.str());
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

  std::map<std::string, std::vector<RoutineEntry>> linesByRoutine;
  for (const auto& line : lines) {
    std::vector<RoutineEntry>& entries = linesByRoutine[line["routine_id"].as<std::string>()];
    entries.push_back(entryFrom(line, static_cast<int>(entries.size()) + 1));
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

RoutineWriteOutcome PgProgramRepository::insertRoutine(const Routine& incoming,
                                                        std::optional<ProposalDoor> byAgent,
                                                        std::uint64_t nowMs) {
  // The row and its lines are one transaction, so a routine with no lines is not a reachable state.
  // Only the caller that won the row writes the lines; a replay writes nothing and reads the stored
  // routine back untouched, owner-scoped.
  std::optional<Routine> stored;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    pqxx::params params;
    params.append(incoming.id.str());
    params.append(incoming.user.str());
    params.append(incoming.name);
    params.append(incoming.position);
    params.append(static_cast<long long>(nowMs));
    params.append(static_cast<int>(incoming.entries.size()));
    if (byAgent) params.append(toString(*byAgent));
    else params.append();
    pqxx::result inserted = txn.exec(
        "INSERT INTO gym_routines (id, user_id, name, position, created_at, created_entries, "
        "                          created_door) "
        "VALUES ($1, $2::uuid, $3, $4, to_timestamp($5::bigint / 1000.0), $6, $7) "
        "ON CONFLICT DO NOTHING",
        params);
    if (inserted.affected_rows() == 1 && !insertEntries(txn, incoming))
      return {std::nullopt, RoutineWriteError::unknownExercise};
    stored = loadRoutine(txn, incoming.user, incoming.id);
    txn.commit();
  }
  if (!stored) return {std::nullopt, RoutineWriteError::idTaken};
  return {stored, RoutineWriteError::none};
}

RoutineWriteOutcome PgProgramRepository::replaceRoutine(const Routine& incoming, std::uint64_t nowMs,
                                                       std::optional<int> expectedRevision) {
  // A whole-document replace: entries have no identity, their key is their position, so they are
  // deleted and laid down again. An update matching no row means absent or another account's, one
  // answer. The revision moves and every pending proposal is superseded in the same transaction, both
  // only when the name or the document actually moved. Lock order: the routine row first (the SELECT
  // takes it), its proposals after.
  std::optional<Routine> stored;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    if (txn.exec_params("SELECT 1 FROM gym_routines WHERE id = $1 AND user_id = $2::uuid FOR UPDATE",
                        incoming.id.str(), incoming.user.str())
            .empty())
      return {std::nullopt, RoutineWriteError::notFound};
    // Read under the lock, so the comparison is against a document nobody else is rewriting. A row
    // holding no lines reads as this write moving it.
    const std::optional<Routine> standing = loadRoutine(txn, incoming.user, incoming.id);
    const bool moved = !standing || standing->name != incoming.name ||
                       !(standing->entries == incoming.entries);
    // Checked under the same lock. Only a write that would move the document is refused; a replay
    // whose bytes already stand reads back what landed, whatever revision it named.
    if (moved && expectedRevision && standing && standing->revision != *expectedRevision)
      return {std::nullopt, RoutineWriteError::stale};
    txn.exec_params(
        "UPDATE gym_routines SET name = $3, position = $4, revision = revision + $5 "
        "WHERE id = $1 AND user_id = $2::uuid",
        incoming.id.str(), incoming.user.str(), incoming.name, incoming.position, moved ? 1 : 0);
    if (moved) {
      txn.exec_params("DELETE FROM gym_routine_entries WHERE routine_id = $1", incoming.id.str());
      if (!insertEntries(txn, incoming)) return {std::nullopt, RoutineWriteError::unknownExercise};
      supersedeOnRoutine(txn, incoming.user, incoming.id, "", nowMs);
    }
    stored = loadRoutine(txn, incoming.user, incoming.id);
    txn.commit();
  }
  if (!stored) return {std::nullopt, RoutineWriteError::notFound};
  return {stored, RoutineWriteError::none};
}

bool PgProgramRepository::deleteRoutine(const UserId& user, const RoutineId& id) {
  // The lines cascade; a session trained under this routine keeps its frozen snapshot and its
  // routine_id nulls (on delete set null).
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result removed = txn.exec_params(
      "DELETE FROM gym_routines WHERE id = $1 AND user_id = $2::uuid", id.str(), user.str());
  txn.commit();
  return removed.affected_rows() > 0;
}

// ── The proposal ledger ────────────────────────────────────────────────────────────────────────

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

ProposalMintOutcome PgProgramRepository::insertProposal(const RoutineProposal& incoming) {
  // The routine row is locked first — the lock order every write here keeps — then the id is
  // resolved, and only then is anything written. Every refusal must return before the commit: the
  // supersede below settles a proposal the lifter can see.
  std::optional<RoutineProposal> stored;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    if (txn.exec_params("SELECT 1 FROM gym_routines WHERE id = $1 AND user_id = $2::uuid FOR UPDATE",
                        incoming.head.routine.str(), incoming.head.user.str())
            .empty())
      return {std::nullopt, ProposalMintError::unknownRoutine};
    if (std::optional<ProposalMintOutcome> answered = spentId(txn, incoming)) return *answered;

    // One pending proposal per (routine, door, connection): the older one from this door and
    // connection is superseded before the new row lands, which the partial unique index would
    // otherwise refuse.
    supersedeFromDoor(txn, incoming);
    pqxx::result inserted = txn.exec_params(
        "INSERT INTO gym_proposals (id, routine_id, user_id, intent, base_revision, base_name, "
        "  proposed_name, summary, changes, state, door, connection, agent, created_at, thread_id) "
        "VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $12, "
        "        to_timestamp($13::bigint / 1000.0), nullif($14, '')) ON CONFLICT DO NOTHING",
        incoming.head.id.str(), incoming.head.routine.str(), incoming.head.user.str(),
        toString(incoming.head.intent), incoming.baseRevision, incoming.baseName,
        incoming.proposedName, incoming.head.summary, incoming.head.changes,
        toString(incoming.head.source.door), incoming.head.source.connection,
        incoming.head.source.agent, static_cast<long long>(incoming.head.createdAtMs),
        // Travels as the empty string and is nulled in SQL: the id-shape rule refuses anything under
        // eight characters, so no thread can be named by it.
        incoming.head.source.thread ? incoming.head.source.thread->str() : std::string());
    // Nothing inserted though the id was free: another connection minted under it between the two
    // statements.
    if (inserted.affected_rows() == 0) return {std::nullopt, ProposalMintError::idTaken};
    if (!insertProposalChanges(txn, incoming))
      return {std::nullopt, ProposalMintError::unknownExercise};
    stored = loadProposal(txn, incoming.head.user, incoming.head.id);
    txn.commit();
  }
  return {stored, ProposalMintError::none};
}

ProposalSettleOutcome PgProgramRepository::applyRevision(const UserId& user, const ProposalId& id,
                                                          const Routine& becomes,
                                                          std::uint64_t nowMs) {
  // Three statements rather than one joined lock, for the lock order: a joined `FOR UPDATE OF r, p`
  // takes its two rows in whatever order the planner produces them, and every write here takes the
  // routine first. Everything deciding this apply is read after both locks are held.
  std::optional<RoutineProposal> settled;
  std::optional<Routine> stored;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    pqxx::result names = txn.exec_params(
        "SELECT routine_id FROM gym_proposals WHERE id = $1 AND user_id = $2::uuid", id.str(),
        user.str());
    if (names.empty()) return {std::nullopt, std::nullopt, ProposalSettleError::notFound};
    if (txn.exec_params("SELECT 1 FROM gym_routines WHERE id = $1 AND user_id = $2::uuid FOR UPDATE",
                        names[0]["routine_id"].as<std::string>(), user.str())
            .empty())
      return {std::nullopt, std::nullopt, ProposalSettleError::notFound};
    pqxx::result locked = txn.exec_params(
        "SELECT p.state, p.base_revision, r.revision "
        "FROM gym_proposals p JOIN gym_routines r ON r.id = p.routine_id "
        "WHERE p.id = $1 AND p.user_id = $2::uuid FOR UPDATE OF p",
        id.str(), user.str());
    if (locked.empty()) return {std::nullopt, std::nullopt, ProposalSettleError::notFound};
    const ProposalState state = proposalStateFromStored(locked[0]["state"].as<std::string>());
    // A replayed tap reads back what it already did; the other settled states are refused.
    if (state == ProposalState::applied) {
      settled = loadProposal(txn, user, id);
      stored = settled ? loadRoutine(txn, user, settled->head.routine) : std::nullopt;
      return {settled, stored, ProposalSettleError::none};
    }
    if (state == ProposalState::dismissed)
      return {std::nullopt, std::nullopt, ProposalSettleError::settled};
    if (state == ProposalState::superseded)
      return {std::nullopt, std::nullopt, ProposalSettleError::superseded};
    // The base moved between the mint and the tap: the diff describes a document that is gone.
    if (locked[0]["revision"].as<int>() != locked[0]["base_revision"].as<int>()) {
      txn.exec_params("UPDATE gym_proposals SET state = 'superseded', "
                      "  settled_at = to_timestamp($2::bigint / 1000.0) WHERE id = $1",
                      id.str(), static_cast<long long>(nowMs));
      txn.commit();
      return {std::nullopt, std::nullopt, ProposalSettleError::superseded};
    }

    txn.exec_params("UPDATE gym_routines SET name = $3, revision = revision + 1 "
                    "WHERE id = $1 AND user_id = $2::uuid",
                    becomes.id.str(), user.str(), becomes.name);
    txn.exec_params("DELETE FROM gym_routine_entries WHERE routine_id = $1", becomes.id.str());
    if (!insertEntries(txn, becomes))
      return {std::nullopt, std::nullopt, ProposalSettleError::notFound};
    txn.exec_params("UPDATE gym_proposals SET state = 'applied', "
                    "  settled_at = to_timestamp($2::bigint / 1000.0) WHERE id = $1",
                    id.str(), static_cast<long long>(nowMs));
    // The routine just moved, so every other proposal waiting on it is against a base that is gone.
    supersedeOnRoutine(txn, user, becomes.id, id.str(), nowMs);
    settled = loadProposal(txn, user, id);
    stored = loadRoutine(txn, user, becomes.id);
    txn.commit();
  }
  return {settled, stored, ProposalSettleError::none};
}

ProposalSettleOutcome PgProgramRepository::applyRemoval(const UserId& user, const ProposalId& id,
                                                         std::uint64_t nowMs) {
  // The answer is composed before the delete, which takes the routine and — through
  // `on delete cascade` — its entries, its proposals and this very row with it.
  std::optional<RoutineProposal> settled;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    pqxx::result names = txn.exec_params(
        "SELECT routine_id FROM gym_proposals WHERE id = $1 AND user_id = $2::uuid", id.str(),
        user.str());
    if (names.empty()) return {std::nullopt, std::nullopt, ProposalSettleError::notFound};
    // The routine first and the proposal after — the one lock order every write here keeps.
    if (txn.exec_params("SELECT 1 FROM gym_routines WHERE id = $1 AND user_id = $2::uuid FOR UPDATE",
                        names[0]["routine_id"].as<std::string>(), user.str())
            .empty())
      return {std::nullopt, std::nullopt, ProposalSettleError::notFound};
    pqxx::result locked = txn.exec_params(
        "SELECT p.state, p.base_revision, p.routine_id, r.revision "
        "FROM gym_proposals p JOIN gym_routines r ON r.id = p.routine_id "
        "WHERE p.id = $1 AND p.user_id = $2::uuid FOR UPDATE OF p",
        id.str(), user.str());
    if (locked.empty()) return {std::nullopt, std::nullopt, ProposalSettleError::notFound};
    const ProposalState state = proposalStateFromStored(locked[0]["state"].as<std::string>());
    // A removal that landed took its own row with it, so a replay answers `notFound` above.
    if (state == ProposalState::dismissed || state == ProposalState::applied)
      return {std::nullopt, std::nullopt, ProposalSettleError::settled};
    if (state == ProposalState::superseded)
      return {std::nullopt, std::nullopt, ProposalSettleError::superseded};
    if (locked[0]["revision"].as<int>() != locked[0]["base_revision"].as<int>()) {
      txn.exec_params("UPDATE gym_proposals SET state = 'superseded', "
                      "  settled_at = to_timestamp($2::bigint / 1000.0) WHERE id = $1",
                      id.str(), static_cast<long long>(nowMs));
      txn.commit();
      return {std::nullopt, std::nullopt, ProposalSettleError::superseded};
    }

    settled = loadProposal(txn, user, id);
    if (!settled) return {std::nullopt, std::nullopt, ProposalSettleError::notFound};
    settled->head.state = ProposalState::applied;
    settled->head.settledAtMs = nowMs;
    txn.exec_params("DELETE FROM gym_routines WHERE id = $1 AND user_id = $2::uuid",
                    locked[0]["routine_id"].as<std::string>(), user.str());
    txn.commit();
  }
  return {settled, std::nullopt, ProposalSettleError::none};
}

ProposalSettleOutcome PgProgramRepository::dismissProposal(const UserId& user,
                                                            const ProposalId& id,
                                                            std::uint64_t nowMs) {
  // Touches one table, so it takes one lock and joins no order.
  std::optional<RoutineProposal> settled;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    pqxx::result locked = txn.exec_params(
        "SELECT state FROM gym_proposals WHERE id = $1 AND user_id = $2::uuid FOR UPDATE",
        id.str(), user.str());
    if (locked.empty()) return {std::nullopt, std::nullopt, ProposalSettleError::notFound};
    const ProposalState state = proposalStateFromStored(locked[0]["state"].as<std::string>());
    if (state == ProposalState::applied)
      return {std::nullopt, std::nullopt, ProposalSettleError::settled};
    if (state == ProposalState::superseded)
      return {std::nullopt, std::nullopt, ProposalSettleError::superseded};
    if (state == ProposalState::pending)
      txn.exec_params("UPDATE gym_proposals SET state = 'dismissed', "
                      "  settled_at = to_timestamp($2::bigint / 1000.0) WHERE id = $1",
                      id.str(), static_cast<long long>(nowMs));
    settled = loadProposal(txn, user, id);   // already dismissed: the replay reads back itself
    txn.commit();
  }
  return {settled, std::nullopt, ProposalSettleError::none};
}

}
