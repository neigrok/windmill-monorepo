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
// routine, correlated on the routine's OWN owner so the one read and the list read carry the same
// scope without either passing the caller twice.
constexpr std::string_view kRoutineColumns =
    "r.id, r.user_id, r.name, r.position, r.revision, "
    "(extract(epoch from (SELECT max(s.started_at) FROM gym_sessions s "
    "                     WHERE s.routine_id = r.id AND s.user_id = r.user_id)) * 1000)::bigint "
    "  AS last_trained_ms";

constexpr std::string_view kEntryColumns =
    "routine_id, position, exercise_id, target_sets, target_reps, "
    "target_weight_kg::float8 AS target_weight_kg, rest_seconds";

// The proposal ledger's two reads. `changes` is the stored count of what `Apply all N` counts, not a
// count of these rows: a `kept` row is not a change and a renamed routine is one, and the domain is
// where that rule lives.
constexpr std::string_view kProposalColumns =
    "p.id, p.routine_id, p.user_id, p.intent, p.base_revision, p.base_name, p.proposed_name, "
    "p.summary, p.changes, p.state, p.door, p.connection, p.agent, p.thread_id, "
    "(extract(epoch from p.created_at) * 1000)::bigint AS created_ms, "
    "(extract(epoch from p.settled_at) * 1000)::bigint AS settled_ms";

constexpr std::string_view kProposalChangeColumns =
    "position, kind, exercise_id, before_sets, before_reps, "
    "before_weight_kg::float8 AS before_weight_kg, before_rest_seconds, "
    "after_sets, after_reps, after_weight_kg::float8 AS after_weight_kg, after_rest_seconds";


// The position is taken from the ORDER the rows came back in, not from the column: the stored runs
// are dense by construction (both writes lay a whole document down in one transaction) and the
// entity refuses anything else, so reading the order keeps a run that was somehow left with a gap
// legible instead of failing every read of that plan.
template <typename Row>
RoutineEntry entryFrom(const Row& row, int position) {
  // A null target_sets is the OPEN line — the movement is in the day and the rack decides — and a
  // null target_reps is the line canon draws as `3 × max`. Neither is a zero and neither is a
  // missing value to fill in: both columns dropped their NOT NULL for exactly this, so the read
  // carries the absence through to the surface that draws the word.
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
  // A null thread is the MCP door, which had no conversation, and an Ask proposal whose thread the
  // lifter deleted — one absence for both, because they mean the same thing to every reader: there
  // is nothing here to open.
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

// One row of the diff, and the two sides read by the same rule the entry read obeys: a null is an
// absence that MEANS something on the `after` side, and on the `before` side it is either that same
// absence or the whole side being missing because the line is new. `kind` is what tells them apart,
// so it is read first and the sides are built from it rather than guessed at from nullness.
template <typename Row>
RoutineChange changeFrom(const Row& row) {
  const std::string kindText = row["kind"].template as<std::string>();
  const ChangeKind kind = kindText == "added"      ? ChangeKind::added
                          : kindText == "removed"  ? ChangeKind::removed
                          : kindText == "retargeted" ? ChangeKind::retargeted
                                                     : ChangeKind::kept;
  // Which side is missing is the KIND's to say, and only the kind's: a null target_sets became a
  // meaning of its own when a line could be left OPEN (§M), so reading a side's presence off it
  // would have made `+ Deadlift · decide at the rack` an added line with nothing added.
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

// The lines of one whole document, laid down in the order the entity holds them, each naming a
// movement this account may see. `false` says one did not: the caller answers unknownExercise and
// returns at once, and because a routine write is ONE transaction the rollback takes every line
// already laid down with it.
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

// One proposal and its lines, read INSIDE a caller's transaction — the read every write here
// finishes with, and the diff screen's single read on its own. The `loggedSets` pass is a third
// statement rather than a column because it is a fact about the LOG rather than about the proposal:
// §D14's *41 logged sets kept* has to be true when a lifter reads it, and a count frozen at the mint
// would be stale by then. It is a LEFT JOIN so a movement the lifter planned and never trained
// answers zero rather than dropping off the diff.
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

// The lines of one proposal, laid down in the order the entity holds them, each naming a movement
// this account may see — the same predicate a routine's own lines are written under, and for the
// same reason: another lifter's private movement named here would print that account's movement
// name in this lifter's diff. `false` says one did not, and because a mint is ONE transaction the
// rollback takes every line already laid down with it.
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

// What every pending proposal on a routine becomes the moment that routine MOVES — by the lifter's
// own hand, or by one proposal being applied while another waits. Every door's, because the base
// they were all minted against is gone. It is not a delete: a superseded proposal drops into the
// routine's dated history, so nothing piles up and nothing disappears.
void supersedeOnRoutine(pqxx::work& txn, const UserId& user, const RoutineId& routine,
                        const std::string& except, std::uint64_t nowMs) {
  txn.exec_params("UPDATE gym_proposals "
                  "SET state = 'superseded', settled_at = to_timestamp($3::bigint / 1000.0) "
                  "WHERE routine_id = $1 AND user_id = $2::uuid AND state = 'pending' AND id <> $4",
                  routine.str(), user.str(), static_cast<long long>(nowMs), except);
}

// The other rule, and it is narrower on purpose: ONE PENDING PROPOSAL PER (routine, door,
// connection), so a mint replaces only what that same door AND connection had waiting. Another
// door's proposal stands, and so does another agent's on the same account — the lifter has two
// things to decide, from two places, and losing one because the other spoke second would be the
// ledger deciding for them. It is the partial unique index's own key, cleared before the new row
// lands.
// THE SPENT ID, ANSWERED BEFORE ANYTHING IS WRITTEN, and both halves of that sentence are
// load-bearing. It is asked GLOBALLY rather than under the caller's scope because the id is a
// primary key across every account, so an id another lifter holds must be refused rather than read
// as free — and it is asked FIRST because a refusal that had already superseded this caller's own
// waiting proposal would take a card off a lifter's Today and put nothing in its place.
//
// The caller's own id splits again, on the document: the same one is the replay a lost reply
// deserves, and a different one is refused. Answering a different document with the stored proposal
// would throw the new one away and hand back a receipt saying something is waiting for the lifter —
// true of a proposal the agent never sent.
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
  // Two statements over the same owner scope, merged by routine id — the log read's shape applied
  // to the plan: the routines, then one pass for every line they hold. The order is the routines
  // screen's own, most recently trained first, with the never-trained after them rather than at the
  // top: an absent aggregate sorts nowhere on its own, so the tiebreak is stated (position, then id)
  // instead of left to the planner.
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
    if (held == linesByRoutine.end()) continue;   // no lines: not a plan, and not writable as one
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

// The routine's own dated ledger, and it is ONE read over two tables because it is one section of
// one screen (§M30). The proposals are newest first and bounded; the creation row is the routine's
// own and is always last, so a lifter reading a day of the program reaches the sentence that says
// where it came from however long its ledger has grown.
//
// The routine is resolved FIRST, under the caller's own scope: a routine that is absent or another
// account's has no history, and answering an empty list rather than somebody else's ledger is the
// same one fact every read in this module gives.
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
  // The row and its lines are ONE transaction, so a routine with no lines is not a state this store
  // can be left in. The lines are written only by the caller that WON the row: a create replayed
  // after a lost reply finds the id already spent by itself, writes nothing, and reads the STORED
  // routine back untouched — the same rule a replayed start obeys, applied to a document. And the
  // read-back is owner-scoped, so an id spent by another account resolves to nothing rather than to
  // their plan: the caller learns the id is taken and never whose it is.
  //
  // THE CREATION ROW OF THE HISTORY IS WRITTEN HERE and nowhere else — the instant, the door, and
  // how many movements the day was built with. All three belong to the winner of the id: a replay
  // writes nothing, so the ledger keeps saying what the first write said rather than re-dating a
  // day the lifter built on Sunday to whenever a queue got its reply through.
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
  // A whole-document replace: the row owner-scoped, then the lines deleted and laid down again.
  // Churning them costs no identity — entries have none, their key IS their position — and it is
  // what makes a reorder, an insertion and a deletion one write instead of three verbs the editor
  // would have to sequence. An update that matches no row is the 404 fact: absent and another
  // account's are the same answer, so nothing here says which.
  //
  // THE HUMAN'S HAND, and the two lines that make the proposal ledger safe beside it. The revision
  // moves, and every proposal still pending on this routine is superseded in the SAME transaction —
  // so the mid-session "Save 87.5 to Push A", which is a full read-modify-write of the whole
  // document, cannot silently destroy the base a diff was computed against. The proposal does not
  // vanish: it drops into the routine's dated history, where a lifter can see what an agent had
  // suggested and what they did instead.
  //
  // BOTH OF THOSE TURN ON ONE QUESTION — did the name or the document actually move? — and it is
  // asked here rather than assumed, because this route is written to by editors that save on close
  // and by a logger that writes back the whole document to change one weight. A PUT landing the
  // bytes that already stand changes nothing a diff was computed against, so it moves no revision
  // and settles no card: killing a lifter's pending proposal for a save that did nothing is the
  // ledger deciding for them. Where the day sits in the week is not part of any proposal either —
  // an apply keeps the base's own position — so dragging a day up the routines screen leaves the
  // card waiting exactly where it was.
  //
  // The lock order is the one every write in this module keeps: the routine row first (the SELECT
  // takes it), its proposals after. An apply takes the same two in the same order, so the two can
  // race and neither can deadlock.
  std::optional<Routine> stored;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    if (txn.exec_params("SELECT 1 FROM gym_routines WHERE id = $1 AND user_id = $2::uuid FOR UPDATE",
                        incoming.id.str(), incoming.user.str())
            .empty())
      return {std::nullopt, RoutineWriteError::notFound};
    // Read under the lock, so what this compares against is the document nobody else is rewriting.
    // A row holding no lines is no plan at all (loadRoutine says so), and the safe reading of one is
    // that this write moves it.
    const std::optional<Routine> standing = loadRoutine(txn, incoming.user, incoming.id);
    const bool moved = !standing || standing->name != incoming.name ||
                       !(standing->entries == incoming.entries);
    // The editor's own read, checked under the same lock — a day that moved since (a proposal
    // applied on the phone, another tab's save) is refused rather than overwritten. Only a write that
    // would MOVE the document is refused: a replay whose bytes already stand reads back what landed,
    // whatever revision it named, because a lost reply must never turn into a refusal.
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
  // The lines cascade, and every session ever trained under this routine keeps its frozen snapshot:
  // routine_id nulls (on delete set null) and the log still says which day of the program it was.
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
  // Newest first, which is the order all three surfaces read it in: Today shows the newest pending
  // card, and the routine editor's History reads down from the most recent. Both filters are
  // written as `($n IS NULL OR …)` so one statement serves the three questions the surfaces ask —
  // every pending proposal on the account, one routine's whole run, and one routine's pending.
  // The empty string is the "every routine" sentinel rather than a null, and it is exact rather than
  // convenient: the id-shape rule refuses anything under eight characters, so no routine can ever
  // be named by it.
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
  // An ordered pipeline in one transaction, and the order is the whole safety of it. The ROUTINE row
  // is locked first — the same lock order every other write in this module keeps, so a mint racing an
  // apply or a lifter's own PUT queues behind it instead of interleaving with it and leaving a
  // proposal frozen against a revision that never stood. Then the id is resolved, before a single
  // row moves. Only then does anything get written.
  //
  // EVERY REFUSAL RETURNS BEFORE THE COMMIT, and that is not a style: the supersede below settles a
  // card the lifter can see, so a refused mint that reached it would take their pending proposal off
  // Today and put nothing in its place — a mint that says "nothing was minted" while having quietly
  // spent something of theirs. Returning early rolls the whole transaction back.
  std::optional<RoutineProposal> stored;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    if (txn.exec_params("SELECT 1 FROM gym_routines WHERE id = $1 AND user_id = $2::uuid FOR UPDATE",
                        incoming.head.routine.str(), incoming.head.user.str())
            .empty())
      return {std::nullopt, ProposalMintError::unknownRoutine};
    if (std::optional<ProposalMintOutcome> answered = spentId(txn, incoming)) return *answered;

    // One pending proposal per (routine, door, connection): the older one from THIS door and
    // connection is settled as superseded before the new row lands, which is what the partial unique
    // index would otherwise refuse. Another door's stands, and so does another connection's.
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
        // The conversation this was minted in, and NULL from the MCP door, which had none. It
        // travels as the empty string and is nulled in SQL, the same sentinel `proposalHeads` uses
        // for "every routine" and exact for the same reason: the id-shape rule refuses anything
        // under eight characters, so no thread can ever be named by it. The thread row is written
        // before the model runs (AskService), so the reference is already there to point at.
        incoming.head.source.thread ? incoming.head.source.thread->str() : std::string());
    // Nothing inserted, with the id free when this transaction looked: another connection minted
    // under it between the two statements. The id is spent by whoever won, and this transaction
    // rolls back whole.
    if (inserted.affected_rows() == 0) return {std::nullopt, ProposalMintError::idTaken};
    if (!insertProposalChanges(txn, incoming))
      return {std::nullopt, ProposalMintError::unknownExercise};
    // The row this transaction just wrote, read back through the reader the diff screen uses so the
    // caller's receipt carries the same `loggedSets` a lifter will read.
    stored = loadProposal(txn, incoming.head.user, incoming.head.id);
    txn.commit();
  }
  return {stored, ProposalMintError::none};
}

ProposalSettleOutcome PgProgramRepository::applyRevision(const UserId& user, const ProposalId& id,
                                                          const Routine& becomes,
                                                          std::uint64_t nowMs) {
  // THE TAP, and the whole of it is one transaction: all of it or none, which is the sentence §D14
  // prints under the button.
  //
  // THREE STATEMENTS RATHER THAN ONE JOINED LOCK, and the reason is the lock ORDER. A joined
  // `FOR UPDATE OF r, p` takes its two rows in whatever order the planner produces them, and the
  // lifter's own PUT takes the routine first and its proposals after — so one plan away, the two
  // deadlock. So: read which routine this is about, lock that routine, then lock the proposal and
  // re-read the state and the base revision under it. Everything that decides this apply is read
  // after both locks are held, because a read taken before a lock is a read of a document somebody
  // else may be rewriting.
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
    // A replayed tap reads back what it already did; the other two settled states are a different
    // question being asked of a decision that is already made.
    if (state == ProposalState::applied) {
      settled = loadProposal(txn, user, id);
      stored = settled ? loadRoutine(txn, user, settled->head.routine) : std::nullopt;
      return {settled, stored, ProposalSettleError::none};
    }
    if (state == ProposalState::dismissed)
      return {std::nullopt, std::nullopt, ProposalSettleError::settled};
    if (state == ProposalState::superseded)
      return {std::nullopt, std::nullopt, ProposalSettleError::superseded};
    // The base moved between the mint and the tap. The diff describes a document that is gone, and
    // merging one over the other is the one thing this ledger exists to refuse.
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
      // Unreachable through the mint, which refuses an unknown movement before a proposal is ever
      // stored — and kept because a movement can only ever leave a lifter's catalog by the account
      // being closed, and then there is nothing left to apply to either.
      return {std::nullopt, std::nullopt, ProposalSettleError::notFound};
    txn.exec_params("UPDATE gym_proposals SET state = 'applied', "
                    "  settled_at = to_timestamp($2::bigint / 1000.0) WHERE id = $1",
                    id.str(), static_cast<long long>(nowMs));
    // The routine just moved, so every OTHER proposal waiting on it is now against a base that is
    // gone. Applying one is a write like any other and settles them the same way a lifter's own PUT
    // does.
    supersedeOnRoutine(txn, user, becomes.id, id.str(), nowMs);
    settled = loadProposal(txn, user, id);
    stored = loadRoutine(txn, user, becomes.id);
    txn.commit();
  }
  return {settled, stored, ProposalSettleError::none};
}

ProposalSettleOutcome PgProgramRepository::applyRemoval(const UserId& user, const ProposalId& id,
                                                         std::uint64_t nowMs) {
  // The other intent. The answer is composed BEFORE the delete, because the delete takes the
  // routine and — through `on delete cascade` — its entries, its proposals and this very row with
  // it. That is the honest shape rather than an oversight: a day that has left the program has no
  // editor to draw a History section in, exactly as it had none before this ledger existed.
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
    // A removal that landed took its own row with it, so a replay finds nothing at all and answers
    // `notFound` above — which is the same fact as a proposal that was never there, and the only
    // honest one once the day it removed is gone.
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
  // No reason is asked for and nothing changes. It touches one table, so it takes one lock and
  // joins no order — and a dismissed proposal stays in the routine's history in case the lifter
  // wants it back.
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
