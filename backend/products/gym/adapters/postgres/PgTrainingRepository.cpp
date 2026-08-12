#include "products/gym/adapters/postgres/PgTrainingRepository.h"

#include "platform/adapters/json/JsonText.h"
#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <cstddef>
#include <map>
#include <optional>
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

// What a revision is a copy of, written once because the correction and the delete copy exactly the
// same row: a column added to gym_sets must not be kept by one of them and dropped by the other. The
// two lists are the same columns under the two tables' names, matched by POSITION in the insert, and
// `deleted` is the only value the two writers disagree on — so it is the one each passes itself.
constexpr std::string_view kRevisionColumns =
    "set_id, session_id, user_id, exercise_id, set_number, weight_kg, reps, kind, rpe, note, "
    "completed_at, deleted";

constexpr std::string_view kRevisionSource =
    "id, session_id, user_id, exercise_id, set_number, weight_kg, reps, kind, rpe, note, "
    "completed_at";

// The catalog's columns, and the display name is the CALLER'S. The 64 seeds are global rows shared
// by every account on this server, so the name a lifter gave one lives in gym_exercise_names and is
// coalesced over the seed's own — while a movement they created carries its name on its own row and
// has no line to coalesce. The join is written into the column list on purpose: `e.` and `n.` are
// both named here, so a read that selects these columns without joining the override does not
// compile a query at all, rather than quietly printing the seed name to the one account that
// renamed it. kExerciseFrom takes the caller's id at $1; insertExercise, whose $1 is the movement,
// spells the same join out with its own parameter.
constexpr std::string_view kExerciseColumns =
    "e.id, coalesce(n.name, e.name) AS name, e.pattern, e.equipment, "
    "e.step_kg::float8 AS step_kg, e.created_by";

constexpr std::string_view kExerciseFrom =
    "gym_exercises e LEFT JOIN gym_exercise_names n "
    "  ON n.exercise_id = e.id AND n.user_id = $1::uuid";

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
    "p.summary, p.changes, p.state, p.door, p.connection, p.agent, "
    "(extract(epoch from p.created_at) * 1000)::bigint AS created_ms, "
    "(extract(epoch from p.settled_at) * 1000)::bigint AS settled_ms";

constexpr std::string_view kProposalChangeColumns =
    "position, kind, exercise_id, before_sets, before_reps, "
    "before_weight_kg::float8 AS before_weight_kg, before_rest_seconds, "
    "after_sets, after_reps, after_weight_kg::float8 AS after_weight_kg, after_rest_seconds";

// The settings row. plates_kg is a numeric[] and it crosses as a JOINED STRING rather than as an
// array, for the reason kSessionColumns keeps calendar work in SQL: pqxx's array reader is one of
// the names that differ between the macOS build and the CI's Linux one, and a green local build is
// not a green CI. `array_to_string` is one function, everywhere, and the parse below is six lines.
constexpr std::string_view kPreferenceColumns =
    "user_id, units, bar_weight_kg::float8 AS bar_weight_kg, "
    "array_to_string(plates_kg, ',') AS plates_kg, rest_seconds, rest_sound, confirm_haptic, "
    "confirm_sound";

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

// One row of the log summary's aggregate: a session, one movement it holds, how many sets of it and
// how much those sets moved. The names are framed by the row structure — never by a separator packed
// into one string, so a display name that happens to contain the separator cannot mint a movement
// nobody trained. Every session-level number is a sum over these per-movement rows, which is what
// keeps the two counts consistent with each other: they come off one GROUP BY and not off two
// statements that could disagree about which sets a session held.
struct Tally {
  int setCount = 0;
  int workingSetCount = 0;
  double tonnageKg = 0;
  std::vector<std::string> exerciseNames;
  std::vector<PriorMark> workingMarks;
};

// The settings row, and the one construction here that CANNOT throw for anything the schema is able
// to hold: every bound the entity refuses is also a column check, so a stored row is a legal
// document by the time it is read. The unit is the exception and the reason `unitFromStored` clamps
// — a word a newer deploy adds to that check is a word this build has never heard of, and it reads
// as kg rather than taking down every read of the account.
template <typename Row>
GymPreferences preferencesFrom(const Row& row) {
  const std::string packed = row["plates_kg"].template as<std::string>();
  std::vector<double> platesKg;
  for (std::size_t at = 0; at < packed.size();) {
    const std::size_t comma = std::min(packed.find(',', at), packed.size());
    platesKg.push_back(std::stod(packed.substr(at, comma - at)));
    at = comma + 1;
  }
  std::optional<int> restSeconds;
  if (!row["rest_seconds"].is_null()) restSeconds = row["rest_seconds"].template as<int>();
  return GymPreferences{UserId{row["user_id"].template as<std::string>()},
                        unitFromStored(row["units"].template as<std::string>()),
                        row["bar_weight_kg"].template as<double>(),
                        std::move(platesKg),
                        restSeconds,
                        row["rest_sound"].template as<bool>(),
                        row["confirm_haptic"].template as<bool>(),
                        row["confirm_sound"].template as<bool>()};
}

// The other half of that crossing: the set as the `numeric(5,2)[]` literal the write casts. Written
// beside the read so the two renderings cannot drift — one puts the commas in, the other takes them
// out — and the column's own check refuses anything the entity somehow let through.
std::string packedPlates(const std::vector<double>& platesKg) {
  // The separator rides on a flag rather than on "is the literal empty yet", the rule TrainingCsv
  // states for the same job: a length test is one rendering away from swallowing a comma.
  std::string literal = "{";
  bool first = true;
  for (const double plate : platesKg) {
    if (!first) literal += ",";
    first = false;
    literal += std::to_string(plate);
  }
  return literal + "}";
}

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
                 lastTrained,
                 row["revision"].template as<int>()};
}

template <typename Row>
ProposalHead headFrom(const Row& row) {
  std::optional<std::uint64_t> settled;
  if (!row["settled_ms"].is_null()) settled = instantFrom(row["settled_ms"]);
  return ProposalHead{ProposalId{row["id"].template as<std::string>()},
                      RoutineId{row["routine_id"].template as<std::string>()},
                      UserId{row["user_id"].template as<std::string>()},
                      proposalIntentFromStored(row["intent"].template as<std::string>()),
                      proposalStateFromStored(row["state"].template as<std::string>()),
                      ProposalSource{proposalDoorFromStored(row["door"].template as<std::string>()),
                                     row["connection"].template as<std::string>(),
                                     row["agent"].template as<std::string>()},
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
  const auto targets = [&row](const char* sets, const char* reps, const char* weight,
                              const char* rest) -> std::optional<EntryTargets> {
    if (row[sets].is_null()) return std::nullopt;
    std::optional<int> targetReps;
    if (!row[reps].is_null()) targetReps = row[reps].template as<int>();
    std::optional<double> targetWeight;
    if (!row[weight].is_null()) targetWeight = row[weight].template as<double>();
    std::optional<int> restSeconds;
    if (!row[rest].is_null()) restSeconds = row[rest].template as<int>();
    return EntryTargets{row[sets].template as<int>(), targetReps, targetWeight, restSeconds};
  };
  return RoutineChange{row["position"].template as<int>(), kind,
                       ExerciseId{row["exercise_id"].template as<std::string>()},
                       targets("before_sets", "before_reps", "before_weight_kg",
                               "before_rest_seconds"),
                       targets("after_sets", "after_reps", "after_weight_kg", "after_rest_seconds"),
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

// A movement this account may NAME on a write: the catalog read's own predicate — a seed, or one
// this account created — applied where a set or a routine entry points at one. The foreign key only
// asks whether the row EXISTS, and another lifter's private movement exists: named, it would print
// that account's movement name in this log, this export and this coach share, and its owner could
// never delete it away. Read inside the caller's own transaction, against the owner of the row being
// written.
bool namesVisibleMovement(pqxx::work& txn, const std::string& owner, const ExerciseId& exercise) {
  return !txn
              .exec_params("SELECT 1 FROM gym_exercises "
                           "WHERE id = $1 AND (created_by IS NULL OR created_by = $2::uuid)",
                           exercise.str(), owner)
              .empty();
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
      params.append(side->sets);
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
// connection), so a mint replaces only what that same door had waiting. Another door's proposal
// stands — the lifter has two things to decide, from two places, and losing one because the other
// spoke second would be the ledger deciding for them. It is the partial unique index's own key,
// cleared before the new row lands.
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

PgTrainingRepository::PgTrainingRepository(std::shared_ptr<PgPool> pool)
    : pool_(std::move(pool)) {}

std::vector<Exercise> PgTrainingRepository::catalog(const UserId& user) {
  // Ordered by the name the CALLER sees, not by the name the seed carries: the picker is an
  // alphabetical list, and a renamed movement that stayed sorted under its old name would be
  // findable only by someone who remembered what it used to be called.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kExerciseColumns) + " FROM " + std::string(kExerciseFrom) +
          " WHERE e.created_by IS NULL OR e.created_by = $1::uuid "
          "ORDER BY e.pattern, name",
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

std::optional<Session> PgTrainingRepository::session(const UserId& user, const SessionId& id) {
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

std::optional<Set> PgTrainingRepository::setOf(const UserId& user, const SetId& id) {
  // Owner-scoped, like every other read: a set minted by another account resolves to nothing, so
  // the service can tell a replay of the caller's own row from an id it may not look at.
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

std::optional<std::uint64_t> PgTrainingRepository::lastActivity(const SessionId& id) {
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

void PgTrainingRepository::close(const SessionId& id, std::uint64_t finishedAtMs) {
  // The trailing IS NULL makes the close idempotent AND first-writer-wins: a finish replay, or a
  // finish racing the lazy auto-close, keeps whichever instant landed first.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
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
  // duplicate over the gap a deleted set leaves — and a replayed id no-ops on the PK. Then the
  // read-back, scoped to (id, session_id): a replay is handed the original, and an id spent on a
  // row this session does not hold resolves to nothing, never to a stranger's set.
  //
  // The lock READS THE STATE IT LOCKS, and both of the facts it brings back are refusals only this
  // statement can make. `finished_at` is the boundary of §3.3 and it is decided HERE and nowhere
  // else: the service used to check it too, on a row it had loaded before this lock existed, which
  // is a fact decided in two layers and therefore in two ORDERS — that copy answered `finished` for
  // an id this statement would answer `deleted` for. And `user_id` is the scope the movement is
  // resolved in: the foreign key alone would let this set name another lifter's private movement.
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
        "SELECT user_id, finished_at IS NOT NULL AS finished FROM gym_sessions WHERE id = $1 "
        "FOR UPDATE",
        incoming.session.str());
    // No session row at all is the answer a spent id gets, and it is the same answer the shape
    // below would reach anyway: the INSERT..SELECT would select nothing, so nothing lands and the
    // read-back finds nothing. The service loads the session before it ever gets here.
    if (locked.empty()) return {std::nullopt, SetInsertError::idTaken};
    // THE ID IS SPENT ONCE AND FOR GOOD, and this read is the whole of what makes that true. The
    // primary key stopped being the whole idempotency the moment a row could leave gym_sets: a
    // delete frees the id, and the append that lost its reply — still on the device's queue, or on
    // its way through a claim — would land it again and hand the lifter back the set they deleted.
    // Asked HERE, under the session's lock, so a delete of the same id either committed before this
    // statement's snapshot (and is seen) or waits behind this transaction (and finds the row it is
    // meant to remove). It is asked before `finished` on purpose: a deleted set in a closed session
    // is not a set that never landed, and telling a queue "the session closed before this reached
    // it" would be false about a set that reached it and was taken out by hand.
    //
    // Scoped to the session's OWNER, like every other read in this store: another account's deleted
    // id is not a fact this caller may learn, and their log is not the one a replay here could put a
    // set back into. Their own deleted id is refused whichever session replays it — the id named a
    // set they removed, and a workout is not a fresh namespace for it.
    pqxx::result deleted = txn.exec_params(
        "SELECT 1 FROM gym_set_revisions WHERE set_id = $1 AND user_id = $2::uuid AND deleted "
        "LIMIT 1",
        incoming.id.str(), locked[0]["user_id"].as<std::string>());
    if (!deleted.empty()) return {std::nullopt, SetInsertError::deleted};
    if (locked[0]["finished"].as<bool>()) return {std::nullopt, SetInsertError::finished};
    // The catalog's own predicate, in the owner the locked row names — the fact the foreign key
    // cannot state, and it is translated HERE the way every other adapter translates its vendor
    // errors: it leaves the port as a value, and the wire layer answers it without knowing gym is
    // kept in Postgres.
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
    txn.commit();
  }
  if (!stored) return {std::nullopt, SetInsertError::idTaken};
  return {stored, SetInsertError::none};
}

// The correction. Two statements, and the split between them is the whole correctness argument.
//
// THE LOCK IS ITS OWN STATEMENT, AHEAD OF THE WRITE, and it is the SESSION's row — the very row
// insertSet takes and deleteSet takes. ONE LOCK ORDER FOR ALL THREE WRITES that change what a
// workout holds: the session row first, its set rows after. Two things follow, and each alone would
// buy the statement:
//
//   · The re-read. Under READ COMMITTED a statement's snapshot is taken when it begins, so a
//     correction that both copied the row and rewrote it in one statement would copy the version it
//     read BEFORE waiting on a racing correction's lock — and the value that correction wrote would
//     leave the log with nothing keeping it. Locked first, the second statement reads at a fresh
//     snapshot and keeps what actually stood.
//   · No deadlock. gym_set_revisions carries a foreign key to gym_sessions, so every copy either
//     writer takes already asks that session row for a KEY SHARE; a writer that took a SET row first
//     and the session row second would close a cycle with one that took them the other way round.
//     The order is uniform here, so there is no cycle to close.
//
// It is owner-scoped, which also settles the two questions this write would otherwise ask twice: a
// workout that is not this account's is not locked at all, and there is nothing there to correct.
//
// Then ONE statement does both halves, so there is no window in which the row has been rewritten
// and what it replaced was not kept: the data-modifying CTE copies the row as it stands into
// gym_set_revisions — such a CTE runs exactly once and to completion whether or not the main query
// reads it — and the UPDATE beside it, reading the same snapshot, writes the new values and answers
// with the stored row.
//
// The copy is taken only where the row actually MOVES. `{}` is a legal fix and an identical fix is
// the reply a client resends when the first one is lost, so an unconditional copy would grow a
// version of the row for every retry of a correction that corrected nothing — rows kept forever, in
// a table nothing reads, standing for a change nobody made. What a revision is FOR is the value some
// write replaced; a write that replaced nothing has nothing to keep.
//
// The scope is (id, session, owner) on both statements. A set id that resolves under this account
// but in another workout is not this session's to correct, and another account's is not there at
// all: one empty answer, and the caller learns nothing either way. Nothing here READS or WRITES
// gym_sessions' plan or gym_routine_entries — the lock names the session row and takes nothing off
// it — because the frozen plan is the program's word about the past.
std::optional<Set> PgTrainingRepository::updateSet(const UserId& user, const Set& corrected) {
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

// The delete, and it takes the SESSION's lock first for the reason the correction above does — one
// order for all three writes — plus the one only this write needs. A set id is spent once and for
// good (ports/TrainingRepository.h): insertSet asks gym_set_revisions whether this id names a set
// that was deleted, and it asks under this same lock, so a replayed append and the delete it races
// cannot both look and both find nothing. Locked, the two orders are the only two there are: the
// append lands and this delete removes it, or this delete commits and the append is refused.
//
// The DELETE still takes the row lock itself, and a delete that waits on a racing CORRECTION
// re-evaluates the row it waited for, so its RETURNING hands the copy the values that correction
// wrote rather than the ones it read first.
//
// One statement for the move, and that is the whole of why it is written this way: the DELETE's
// RETURNING feeds the INSERT, so there is no instant in which the row has left gym_sets and has not
// landed in gym_set_revisions. It is marked `deleted` rather than merely kept, because "this set was
// corrected to something else" and "this set does not stand any more" are different facts about a
// lifter — and because the append above reads exactly that flag.
//
// Nothing is answered and nothing is refused: a set that was never here does not stand either, which
// is what lets a client whose reply was lost send the same delete again. Numbers are NOT closed up
// behind it — deleting set 2 of 3 leaves 1 and 3, max+1 keeps minting 4, and the number a set was
// logged under is not a lifter's to rewrite.
void PgTrainingRepository::deleteSet(const UserId& user, const SessionId& session, const SetId& id) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result locked = txn.exec_params(
      "SELECT id FROM gym_sessions WHERE id = $1 AND user_id = $2::uuid FOR UPDATE",
      session.str(), user.str());
  // No workout of this account's under that id, so no set of it either — the sets cascade with the
  // session row. Nothing to remove and nothing to say, which is the same silence a set that was
  // already gone gets.
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

LogPage PgTrainingRepository::log(const UserId& user, const LogCursor& cursor) {
  // Four queries over the same keyset window, merged by session id: the page of sessions, one
  // aggregate pass for its set counts, its tonnage and its display names (alphabetical —
  // first-performed order is the detail read's business, not the summary's), one for the marks
  // each session made, and one for the marks that stood before the whole page. All four run inside
  // one transaction, so no row of a page can lose an aggregate to a write that lands between them.
  //
  // The aggregate counts twice on purpose. `set_count` is every row a session holds;
  // `working_set_count` filters to the working ones, and that is the number the log screen prints
  // beside the top set. They have to be two numbers, because the top set is a lateral over the
  // working sets alone — a row printing `set_count` there counts a ramp-up the number beside it
  // could never have come from, which is exactly what the log did until 2026-08-12.
  // `tonnage_kg` sums the same filtered rows with the load CLAMPED at zero: band-assisted work
  // stores a negative kg (§2.3), and an unclamped sum lets an assisted pull-up subtract from a week
  // somebody trained. Zero is a real answer — nothing here moved a measurable load — and never a
  // claim that nothing was done.
  //
  // The window sorts on (started_at, id), which is unique, and compares the pair against the whole
  // cursor: on a plain started_at cursor two sessions sharing a start instant across a page edge
  // hide one of them from every page, forever. An absent tiebreaker passes the empty id — the floor
  // of the text order — so the first page degrades to a plain "strictly before this instant".
  //
  // The third statement is the session's MARKS — one row per (movement, load), carrying the best
  // reps done at it. It answers both of the row's rules and is the only projection of a session's
  // working sets in this module: the e1RM is the largest Epley over these rows, which simply
  // ignores the movement, and the gold dot is the domain's three record rules read per movement.
  // Grouping is all it takes: at a fixed load Epley rises with reps, so the best-repped set at a
  // load is the best set at that load, and a handful of rows per session is the whole of it.
  // DISTINCT ON rather than a bare `max(reps)` for the reason the finish read uses it — it hands
  // back the winning ROW. Every mark this store makes is dated by the SESSION it was set in, never
  // by the set's own completed_at (domain/Review.h states the rule and what dating by a device's
  // wall clock cost), which is why the join is here at all. Loads at or below zero are NOT filtered
  // out: definedness is the domain's rule and it is stated in domain/Review.h alone.
  //
  // The fourth is the marks STANDING BEFORE the page — the same projection with the window moved to
  // "every FINISHED session older than the oldest row here", narrowed to the movements this page
  // trains. It is what makes the dot answerable at all: a record is judged against the history
  // before its session, and page 2 has ten years of history in front of it that page 2 cannot see.
  // The floor is the page's last row, taken from the rows already in hand rather than recomputed in
  // SQL, and an empty page skips the statement entirely — nothing stands before nothing.
  //
  // Only the fourth counts finished sessions, and the third deliberately does not: a page carries
  // the OPEN workout as a row like any other. The two windows are reconciled in the domain, which is
  // told which rows are over and folds only those (domain/Review.h, `SessionMarks::finished`) —
  // filtering the page here instead would drop the open row off the log entirely.
  //
  // The row's two other facts ride the sessions statement. The top set is a lateral over this
  // session's WORKING sets, heaviest first and ties to more reps — the rule TopWorkingSet states,
  // and never volume. `closed_itself` is the auto-close's own signature rather than a column: autoCloseAt
  // stamps finished_at at the last set's instant exactly (or at started_at for a session holding
  // none), so a finish equal to that instant is the four-hour rule's work. A manual finish landing
  // on precisely the same millisecond reads as an auto-close, and the whole cost of that
  // coincidence is one wrong subtitle — cheaper than a column two writers would keep honest.
  const std::string beforeId = cursor.beforeId ? cursor.beforeId->str() : "";
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
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

std::vector<LastSet> PgTrainingRepository::lastSets(const UserId& user) {
  // The read above, run over every movement at once and projected to one line each. DISTINCT ON is
  // what makes it one pass instead of a lateral per catalog row: the ORDER BY inside it IS the
  // locator's rule — newest finished session on (started_at, id), then the highest set_number in it
  // — so the first row per movement is exactly the last row of that movement's lastTime block. Say
  // the two rules differently and one screen dials a weight the other says you did not lift.
  //
  // Only the movements this account has WORKED come back. The catalog is not joined in, and that is
  // the point of the shape: a lifter's history is a dozen movements where the catalog is sixty-four,
  // and the caller already holds the catalog it joins these onto.
  //
  // Owner-scoped on both halves like the locator, never through the invariant that a set row
  // inherits its session's owner. Warmups are out under the same rule and for the same reason: a
  // ramp-up single is not what you did last time.
  //
  // WHAT IT COSTS, measured rather than asserted, so the next reader inherits numbers instead of a
  // claim. Local Postgres 14 at the default work_mem = 4MB, one account training a dozen movements,
  // EXPLAIN (ANALYZE, BUFFERS) three times per corpus. The plan hash-joins this account's sets to
  // its sessions and then sorts every qualifying row ONCE, and that sort is the whole story:
  //      1 600 working sets → quicksort, 274 kB in memory              ~2 ms
  //     19 000 working sets → quicksort, 3 258 kB in memory           ~23 ms
  //     38 000 working sets → EXTERNAL MERGE, 3 032 kB spilled to disk ~53 ms
  // The plan SHAPE holds at every size, but somewhere in the low twenty-thousands of working sets —
  // a decade of hard training — the sort crosses work_mem and spills from then on. That is a change
  // in kind, not a bigger number, so it is written down rather than left to be discovered. 53 ms is
  // cheap for a read that fires once when a picker opens; the lifter who ever makes it expensive is
  // the one to revisit this for, and the measured alternative is the next paragraph.
  //
  // WHAT IT MUST NOT BE DRIVEN OFF is the catalog. The same rule as a LATERAL per catalog row — the
  // shape a picker's mind reaches for first — measured 0.72–1.37 s on that decade, and the plan says
  // why: 64 outer rows, each running a nested loop over this account's finished sessions — 104 024
  // inner index scans and 2.4 M buffer hits to return 64 rows. For the fifty-odd movements this
  // lifter has never touched, "there is no last time" is proved only by walking every session they
  // ever ran. Driving the same LATERAL off the movements they HAVE touched measures ~9 ms and is
  // genuinely faster than the sort above; it was not taken because it is one edit away from the
  // catalog form, and because its win is a function of how few movements the lifter trains rather
  // than of the statement. It is the noted fallback, not a mystery — if the spill ever starts to
  // matter, that is the shape to measure again.
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
  // back the winning ROW, and the row it keeps is the one from the EARLIEST session to hit those
  // reps — so the mark is dated by that workout, which is the day the record line prints beside the
  // number it beat (the one dating rule, domain/Review.h).
  //
  // Both windows compare the PAIR (started_at, id) against this session's own, the unique key every
  // other read here pages and locates on. It is not decoration: it excludes this session from its
  // own history, and without that a review re-read after the finish would find every set of the
  // session tying itself and would silently report no record at all.
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

bool PgTrainingRepository::deleteSession(const UserId& user, const SessionId& id) {
  // The sets cascade with the row (`gym_sets.session_id ... on delete cascade`), which is what makes
  // the discard one statement and leaves nothing orphaned behind it. Owner-scoped like every write:
  // another account's session is not refused, it is simply not there to remove.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
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

std::optional<Routine> PgTrainingRepository::routine(const UserId& user, const RoutineId& id) {
  std::optional<Routine> found;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
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
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    pqxx::result inserted = txn.exec_params(
        "INSERT INTO gym_routines (id, user_id, name, position) "
        "VALUES ($1, $2::uuid, $3, $4) ON CONFLICT DO NOTHING",
        incoming.id.str(), incoming.user.str(), incoming.name, incoming.position);
    if (inserted.affected_rows() == 1 && !insertEntries(txn, incoming))
      return {std::nullopt, RoutineWriteError::unknownExercise};
    stored = loadRoutine(txn, incoming.user, incoming.id);
    txn.commit();
  }
  if (!stored) return {std::nullopt, RoutineWriteError::idTaken};
  return {stored, RoutineWriteError::none};
}

RoutineWriteOutcome PgTrainingRepository::replaceRoutine(const Routine& incoming,
                                                         std::uint64_t nowMs) {
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

bool PgTrainingRepository::deleteRoutine(const UserId& user, const RoutineId& id) {
  // The lines cascade, and every session ever trained under this routine keeps its frozen snapshot:
  // routine_id nulls (on delete set null) and the log still says which day of the program it was.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
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
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    txn.exec_params(
        "INSERT INTO gym_exercises (id, name, pattern, equipment, step_kg, created_by) "
        "VALUES ($1, $2, $3, $4, $5, $6::uuid) ON CONFLICT DO NOTHING",
        incoming.id.str(), incoming.name, toString(incoming.pattern), toString(incoming.equipment),
        incoming.stepKg, owner.str());
    pqxx::result rows = txn.exec_params(
        "SELECT " + std::string(kExerciseColumns) +
            " FROM gym_exercises e LEFT JOIN gym_exercise_names n "
            "  ON n.exercise_id = e.id AND n.user_id = $2::uuid "
            "WHERE e.id = $1 AND e.created_by = $2::uuid",
        incoming.id.str(), owner.str());
    if (!rows.empty()) stored = exerciseFrom(rows[0]);
    txn.commit();
  }
  if (!stored) return {std::nullopt, ExerciseInsertError::idTaken};
  return {stored, ExerciseInsertError::none};
}

std::optional<Exercise> PgTrainingRepository::renameExercise(const UserId& user,
                                                             const ExerciseId& id,
                                                             const std::string& name) {
  // Read, then decide which of two writes this is, then read back — one transaction, and the read
  // that opens it is the whole owner check: the catalog's own predicate, so a seed and this
  // account's own movement are renamable and another lifter's is simply not there.
  //
  // THE HAZARD THIS METHOD EXISTS FOR: `UPDATE gym_exercises SET name` renames a SEED for every
  // lifter on the server, because the 64 seeds are one global row each. So the statement runs only
  // where `created_by = the caller` — their own movement, their own row — and a seed takes a line
  // in gym_exercise_names instead, which every read of a movement name coalesces over the seed's.
  // Renaming a seed back to what it is called by default DELETES that line rather than storing a
  // copy of the seed's own string: an override that says nothing is not an override, and the row
  // would otherwise outlive a later change to the seed name it was pinning.
  //
  // The renamed entity is CONSTRUCTED before either write, from the row as it would be — the
  // constructor is the entire validation (§ every other write in this module), so a name too long,
  // empty, or holding the NUL that Postgres text stops at never reaches a column. Nothing else
  // about the movement moves: not its pattern, not its step, and least of all its id, which is what
  // keeps every set, routine entry and frozen plan snapshot pointing at the same movement.
  std::optional<Exercise> stored;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    pqxx::result rows = txn.exec_params(
        "SELECT " + std::string(kExerciseColumns) + ", e.name AS seed_name FROM " +
            std::string(kExerciseFrom) +
            " WHERE e.id = $2 AND (e.created_by IS NULL OR e.created_by = $1::uuid)",
        user.str(), id.str());
    if (rows.empty()) return std::nullopt;
    const Exercise current = exerciseFrom(rows[0]);
    const Exercise renamed{current.id,         name,           current.pattern,
                           current.equipment,  current.stepKg, current.custom};

    if (renamed.custom)
      txn.exec_params("UPDATE gym_exercises SET name = $3 WHERE id = $2 AND created_by = $1::uuid",
                      user.str(), id.str(), renamed.name);
    else if (renamed.name == rows[0]["seed_name"].as<std::string>())
      txn.exec_params("DELETE FROM gym_exercise_names WHERE user_id = $1::uuid AND exercise_id = $2",
                      user.str(), id.str());
    else
      txn.exec_params("INSERT INTO gym_exercise_names (user_id, exercise_id, name) "
                      "VALUES ($1::uuid, $2, $3) "
                      "ON CONFLICT (user_id, exercise_id) DO UPDATE "
                      "  SET name = excluded.name, updated_at = now()",
                      user.str(), id.str(), renamed.name);

    // The read-back carries the SAME predicate the read above did, though nothing another account
    // owns could reach it — a query in this module that is owner-scoped only by where it happens to
    // sit is one a later hand copies somewhere it is not.
    pqxx::result named = txn.exec_params(
        "SELECT " + std::string(kExerciseColumns) + " FROM " + std::string(kExerciseFrom) +
            " WHERE e.id = $2 AND (e.created_by IS NULL OR e.created_by = $1::uuid)",
        user.str(), id.str());
    if (!named.empty()) stored = exerciseFrom(named[0]);
    txn.commit();
  }
  return stored;
}

MovementHistory PgTrainingRepository::movementHistory(const UserId& user,
                                                      const ExerciseId& exercise) {
  // The record page, four statements in one transaction, and not one of them is a new opinion about
  // training. The first is the catalog's own predicate: no row means this account holds no such
  // movement, and the other three never fire — a movement nobody may see spends no query proving it.
  //
  // The LADDERS are `DISTINCT ON (session, load)` over this movement's working sets in finished
  // sessions, oldest session first and heaviest load first inside each. It is the same projection
  // the log page and the finish read make, windowed to one movement, and it is the whole of what
  // the chart, the two tiles and the record ladder are computed from — because every one of those
  // is a question about the best e1RM of a session, which is a FORMULA and does not reach the
  // database (§11.5). The window is a lifetime rather than twelve weeks: the chart is windowed by
  // the domain, and "your best ever" that quietly meant "this quarter" would be a lie in a tile.
  // A ladder row is dated by its session like every mark this store makes, which is the instant the
  // page dates its bar and its tiles by — one column read twice, so the two cannot drift apart.
  //
  // The RECENT days are the movement's last ten training days, warmups excluded for the reason the
  // prefill excludes them — a ramp-up single is not what you did. They are a separate statement
  // because the ladder collapses a session's sets and this list prints them: `105 × 5 · 105 × 5 ·
  // 105 × 4` is three sets and two loads.
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

    // DISTINCT, because a routine may name one movement twice — bench heavy, then a back-off — and
    // the subhead counts days of the program, not lines in them.
    pqxx::result held = txn.exec_params(
        "SELECT count(DISTINCT r.id)::int AS routines FROM gym_routines r "
        "JOIN gym_routine_entries en ON en.routine_id = r.id "
        "WHERE r.user_id = $1::uuid AND en.exercise_id = $2",
        user.str(), exercise.str());
    history.routines = held[0]["routines"].as<int>();

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
      // The movement travels under the name the OWNER of this file calls it, which is the same
      // coalesce every other read makes: an export whose column said "Back Squat" to the one lifter
      // who renamed it would be a file that disagreed with the app it came out of.
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

std::optional<GymPreferences> PgTrainingRepository::preferences(const UserId& user) {
  // Absent is a fact and not a fault, so it crosses as an absence: a lifter who has never opened the
  // settings screen holds no row, and the DEFAULTS are the domain's answer to that rather than a
  // document this store invents on their behalf (application/LogService.cpp).
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows =
      txn.exec_params("SELECT " + std::string(kPreferenceColumns) +
                          " FROM gym_preferences WHERE user_id = $1::uuid",
                      user.str());
  if (rows.empty()) return std::nullopt;
  return preferencesFrom(rows[0]);
}

GymPreferences PgTrainingRepository::savePreferences(const GymPreferences& incoming) {
  // One row per account, so the upsert IS the whole write: no client-minted id, nothing to replay
  // against, and last write wins — which is exactly the ordering the claim replay wants when an
  // anonymous device signs in carrying the settings the lifter just touched (§11.7).
  //
  // RETURNING reads the stored row back inside the same statement rather than in a second one,
  // because the two differ the moment a column rounds a numeric, and what the client draws has to be
  // what the store holds.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::params params;
  params.append(incoming.user.str());
  params.append(toString(incoming.units));
  params.append(incoming.barWeightKg);
  params.append(packedPlates(incoming.platesKg));
  if (incoming.restSeconds) params.append(*incoming.restSeconds);
  else params.append();
  params.append(incoming.restSound);
  params.append(incoming.confirmHaptic);
  params.append(incoming.confirmSound);
  pqxx::result rows = txn.exec(
      "INSERT INTO gym_preferences (user_id, units, bar_weight_kg, plates_kg, rest_seconds, "
      "                             rest_sound, confirm_haptic, confirm_sound) "
      "VALUES ($1::uuid, $2, $3, $4::numeric(5,2)[], $5, $6, $7, $8) "
      "ON CONFLICT (user_id) DO UPDATE SET units = excluded.units, "
      "  bar_weight_kg = excluded.bar_weight_kg, plates_kg = excluded.plates_kg, "
      "  rest_seconds = excluded.rest_seconds, rest_sound = excluded.rest_sound, "
      "  confirm_haptic = excluded.confirm_haptic, confirm_sound = excluded.confirm_sound, "
      "  updated_at = now() "
      "RETURNING " + std::string(kPreferenceColumns),
      params);
  GymPreferences stored = preferencesFrom(rows[0]);
  txn.commit();
  return stored;
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

bool PgTrainingRepository::revokeShare(const UserId& user, const SessionId& id) {
  // Owner-scoped like every write here: another account's share is not refused, it is simply not
  // there to remove. The row IS the capability, so deleting it is the whole revocation — nothing is
  // marked, nothing is swept, and the token it carried resolves to the same nothing an invented one
  // does from the very next request.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
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

    // The names are the OWNER's, resolved through the owner the session row itself names — the one
    // read here with no caller still has an account to coalesce against, and it is the account
    // whose workout this is. A coach reading the link sees the movement the lifter would name on
    // the phone, which is the whole point of sending them the link.
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

std::vector<Set> PgTrainingRepository::setsOf(const SessionId& id) {
  // Chronological — the client assembles per-exercise groups in first-performed order from the
  // numbered sets; the server just hands the stream back in the order it was lived.
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

// ── The proposal ledger ────────────────────────────────────────────────────────────────────────

std::vector<ProposalHead> PgTrainingRepository::proposalHeads(const UserId& user,
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

std::optional<RoutineProposal> PgTrainingRepository::proposal(const UserId& user,
                                                              const ProposalId& id) {
  std::optional<RoutineProposal> found;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    found = loadProposal(txn, user, id);
  }
  return found;
}

ProposalMintOutcome PgTrainingRepository::insertProposal(const RoutineProposal& incoming) {
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

    // One pending proposal per (routine, door, connection): the older one from THIS door is settled
    // as superseded before the new row lands, which is what the partial unique index would otherwise
    // refuse. Another door's stands.
    supersedeFromDoor(txn, incoming);
    pqxx::result inserted = txn.exec_params(
        "INSERT INTO gym_proposals (id, routine_id, user_id, intent, base_revision, base_name, "
        "  proposed_name, summary, changes, state, door, connection, agent, created_at) "
        "VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $12, "
        "        to_timestamp($13::bigint / 1000.0)) ON CONFLICT DO NOTHING",
        incoming.head.id.str(), incoming.head.routine.str(), incoming.head.user.str(),
        toString(incoming.head.intent), incoming.baseRevision, incoming.baseName,
        incoming.proposedName, incoming.head.summary, incoming.head.changes,
        toString(incoming.head.source.door), incoming.head.source.connection,
        incoming.head.source.agent, static_cast<long long>(incoming.head.createdAtMs));
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

ProposalSettleOutcome PgTrainingRepository::applyRevision(const UserId& user, const ProposalId& id,
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

ProposalSettleOutcome PgTrainingRepository::applyRemoval(const UserId& user, const ProposalId& id,
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

ProposalSettleOutcome PgTrainingRepository::dismissProposal(const UserId& user,
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
