#include "products/gym/sync/GymDoor.h"

#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/domain/sync/FractionalIndex.h"
#include "platform/domain/sync/Jcs.h"
#include "products/gym/adapters/json/GymJson.h"
#include "products/gym/adapters/postgres/PgGymRows.h"
#include "products/gym/sync/GymRules.h"

#include <algorithm>

namespace wm::gym {
namespace {

Json::Value entriesOf(const Routine& routine) {
  Json::Value entries = toJson(routine)["entries"];
  for (auto& entry : entries) entry.removeMember("position");
  return entries;
}

bool knownEntries(CatalogRepository& catalog, const UserId& user, const std::vector<RoutineEntry>& entries) {
  if (entries.empty()) return true;
  const auto visible = catalog.catalog(user);
  return std::all_of(entries.begin(), entries.end(), [&](const RoutineEntry& entry) {
    return std::any_of(visible.begin(), visible.end(), [&](const Exercise& exercise) { return exercise.id == entry.exercise; });
  });
}

Json::Value proposalFields(const RoutineProposal& proposal) {
  Json::Value fields(Json::objectValue);
  fields["routineId"] = proposal.head.routine.str();
  fields["intent"] = toString(proposal.head.intent);
  fields["proposedName"] = proposal.proposedName;
  fields["summary"] = proposal.head.summary;
  fields["door"] = toString(proposal.head.source.door);
  fields["connection"] = proposal.head.source.connection;
  fields["agent"] = proposal.head.source.agent;
  fields["threadId"] = proposal.head.source.thread ? Json::Value(proposal.head.source.thread->str()) : Json::Value();
  fields["changes"] = toJson(proposal)["changes"];
  for (auto& change : fields["changes"]) {
    change.removeMember("position");
    change.removeMember("loggedSets");
  }
  return fields;
}

}

RoutineWriteOutcome GymDoor::createRoutine(const UserId& user, const RoutineWrite& write,
                                          std::optional<ProposalDoor> byAgent) {
  const Routine incoming{write.id, user, write.name, write.position, write.entries};
  std::optional<Routine> held;
  RoutineWriteError error = RoutineWriteError::none;
  const Json::Value result = execute(incoming.user, [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
    held = program_.routine(incoming.user, incoming.id);
    if (held) return std::nullopt;
    if (recordTaken(txn, incoming.user, "routine", incoming.id.str())) { error = RoutineWriteError::idTaken; return std::nullopt; }
    if (!knownEntries(catalog_, incoming.user, incoming.entries)) { error = RoutineWriteError::unknownExercise; return std::nullopt; }
    Json::Value fields(Json::objectValue);
    fields["name"] = incoming.name;
    fields["position"] = incoming.position;
    fields["entries"] = entriesOf(incoming);
    if (byAgent) fields["createdDoor"] = toString(*byAgent);
    Json::Value built = intent();
    built["d"].append(delta("routine", incoming.id.str(), fields, true));
    return built;
  });
  if (error != RoutineWriteError::none) return {std::nullopt, error};
  const std::string code = refusal(result);
  if (code == "id-taken" || code == "id-spent") return {std::nullopt, RoutineWriteError::idTaken};
  if (code == "unknown-exercise") return {std::nullopt, RoutineWriteError::unknownExercise};
  requireOk(result);
  if (held) return {held, RoutineWriteError::none};
  return {program_.routine(incoming.user, incoming.id), RoutineWriteError::none};
}

ProposalMintOutcome GymDoor::propose(const UserId& user, const ProposalWrite& incoming) {
  return mintProposal(user, incoming.id, incoming.routine, incoming.entries,
                      [&](const Routine& base) -> std::optional<RoutineProposal> {
    const Routine becomes{base.id, user, incoming.name.value_or(base.name), base.position, incoming.entries};
    std::vector<RoutineChange> changes = changesBetween(base.entries, becomes.entries);
    const int count = countedChanges(base.entries, changes, base.name, becomes.name);
    if (count == 0) return std::nullopt;
    return RoutineProposal{ProposalHead{incoming.id, base.id, user, ProposalIntent::revise, ProposalState::pending,
        incoming.source, incoming.summary, count, clock_.nowMs(), std::nullopt}, base.revision, base.name, becomes.name, std::move(changes)};
  });
}

// No document to build: the whole plan leaves, so every line of it is a removed row, and the routine leaves with no
// name, as a phone names a removal (engine A.2 admits a blank one there). The count is the admission rule's, which
// counts that blank against the base name as it counts any rename.
ProposalMintOutcome GymDoor::proposeRemoval(const UserId& user, const ProposalId& id, const RoutineId& routine,
                                          const std::string& summary, const ProposalSource& source) {
  return mintProposal(user, id, routine, {}, [&](const Routine& base) -> std::optional<RoutineProposal> {
    std::vector<RoutineChange> changes = changesBetween(base.entries, {});
    const int count = countedChanges(base.entries, changes, base.name, "");
    return RoutineProposal{ProposalHead{id, routine, user, ProposalIntent::remove, ProposalState::pending,
        source, summary, count, clock_.nowMs(), std::nullopt}, base.revision, base.name, "", std::move(changes)};
  });
}

// A spent id splits three ways: another account's is idTaken, the caller's own with the same document
// is the replay and answers the stored proposal, and the caller's own with another document is idReused.
ProposalMintOutcome GymDoor::mintProposal(const UserId& user, const ProposalId& id, const RoutineId& routine,
                                          const std::vector<RoutineEntry>& lines, const ProposalOf& proposalOf) {
  ProposalMintError error = ProposalMintError::none;
  std::optional<RoutineProposal> held;
  const Json::Value result = execute(user, [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
    const auto base = program_.routine(user, routine);
    if (!base) { error = ProposalMintError::unknownRoutine; return std::nullopt; }
    const std::optional<RoutineProposal> proposal = proposalOf(*base);
    if (!proposal) { error = ProposalMintError::noChange; return std::nullopt; }
    const auto ids = sync::sqlOf(txn).exec("select user_id=$2::uuid from gym_proposals where id=$1", pqxx::params{id.str(), user.str()});
    if (!ids.empty()) {
      if (!ids[0][0].as<bool>()) { error = ProposalMintError::idTaken; return std::nullopt; }
      held = program_.proposal(user, id);
      if (!held || !isReplayOf(*held, *proposal)) error = ProposalMintError::idReused;
      return std::nullopt;
    }
    if (recordTaken(txn, user, "proposal", id.str())) { error = ProposalMintError::idTaken; return std::nullopt; }
    if (!knownEntries(catalog_, user, lines)) { error = ProposalMintError::unknownExercise; return std::nullopt; }
    Json::Value built = intent(); built["d"].append(delta("proposal", id.str(), proposalFields(*proposal), true));
    return built;
  });
  if (error != ProposalMintError::none) return {std::nullopt, error};
  const std::string code = refusal(result);
  if (code == "id-taken" || code == "id-spent") return {std::nullopt, ProposalMintError::idTaken};
  if (code == "unknown-record") return {std::nullopt, ProposalMintError::unknownRoutine};
  if (code == "unknown-exercise") return {std::nullopt, ProposalMintError::unknownExercise};
  requireOk(result);
  return {held ? held : program_.proposal(user, id), ProposalMintError::none};
}

// The workout's plan is read where admission reads it, from the engine row under the scope lock, so the diff and
// its base revision are the ones the rules check. A spent id splits as a routine proposal's does.
WorkoutProposalOutcome GymDoor::proposeWorkout(const UserId& user, const WorkoutProposalWrite& incoming) {
  WorkoutProposalOutcome outcome{std::nullopt, WorkoutProposalError::none, std::nullopt};
  const Json::Value result = execute(user, [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
    const std::optional<sync::Row> session = locked(txn, user, "session", incoming.session.str());
    if (!session || !session->alive()) { outcome.error = WorkoutProposalError::unknownSession; return std::nullopt; }
    const std::optional<PlanSnapshot> plan = planFrom(engine::value(&*session, "plan"));
    if (!plan) { outcome.error = WorkoutProposalError::noPlan; return std::nullopt; }
    const Json::Value revision = engine::value(&*session, "planRevision");
    WorkoutProposal proposal{incoming.id, incoming.session, incoming.source, incoming.summary, *plan,
                             revision.isNull() ? 1 : revision.asInt(), incoming.entries};
    if (const std::optional<sync::Row> stored = locked(txn, user, "workoutProposal", incoming.id.str())) {
      Json::Value record(Json::objectValue);
      for (const auto& [field, reg] : stored->lattice.f) record[field] = reg.value;
      record["id"] = incoming.id.str();
      outcome.proposal = workoutProposalFrom(record);
      if (!outcome.proposal->replays(proposal)) outcome.error = WorkoutProposalError::idReused;
      return std::nullopt;
    }
    if (proposal.changeCount == 0) { outcome.error = WorkoutProposalError::noChange; return std::nullopt; }
    if (recordTaken(txn, user, "workoutProposal", incoming.id.str())) { outcome.error = WorkoutProposalError::idTaken; return std::nullopt; }
    Json::Value fields(Json::objectValue);
    fields["sessionId"] = proposal.session.str();
    fields["summary"] = proposal.summary;
    fields["door"] = toString(proposal.source.door);
    fields["connection"] = proposal.source.connection;
    fields["agent"] = proposal.source.agent;
    fields["threadId"] = proposal.source.thread ? Json::Value(proposal.source.thread->str()) : Json::Value();
    fields["changes"] = toJson(proposal)["changes"];
    for (auto& change : fields["changes"]) change.removeMember("position");
    outcome.proposal = std::move(proposal);
    Json::Value built = intent();
    built["d"].append(delta("workoutProposal", incoming.id.str(), fields, true));
    return built;
  });
  if (outcome.error != WorkoutProposalError::none) return {std::nullopt, outcome.error, std::nullopt};
  const std::string code = refusal(result);
  const auto refused = [](WorkoutProposalError error) { return WorkoutProposalOutcome{std::nullopt, error, std::nullopt}; };
  if (code == "id-taken" || code == "id-spent") return refused(WorkoutProposalError::idTaken);
  if (code == "unknown-record") return refused(WorkoutProposalError::unknownSession);
  if (code == "session-finished") return refused(WorkoutProposalError::finished);
  if (code == "unknown-exercise") return refused(WorkoutProposalError::unknownExercise);
  if (code == "invalid") return refused(WorkoutProposalError::invalidPlan);
  if (code == "plan-logged") return {std::nullopt, WorkoutProposalError::planLogged, ExerciseId{result["detail"]["exerciseId"].asString()}};
  requireOk(result);
  return outcome;
}

ExerciseInsertOutcome GymDoor::createExercise(const UserId& user, const ExerciseWrite& write) {
  const Exercise incoming{write.id, write.name, write.pattern, write.equipment,
                          write.stepKg.value_or(defaultStepKg(write.equipment)), true};
  std::optional<Exercise> held;
  const Json::Value result = execute(user, [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
    for (const auto& exercise : catalog_.catalog(user)) if (exercise.id == incoming.id && exercise.custom) { held = exercise; return std::nullopt; }
    Json::Value fields(Json::objectValue); fields["name"] = incoming.name; fields["pattern"] = toString(incoming.pattern);
    fields["equipment"] = toString(incoming.equipment);
    fields["stepKg"] = sync::sqlOf(txn).exec("select $1::numeric(4,2)", pqxx::params{incoming.stepKg})[0][0].as<double>();
    Json::Value built = intent(); built["d"].append(delta("exercise", incoming.id.str(), fields, true)); return built;
  });
  if (refusal(result) == "id-taken" || refusal(result) == "id-spent") return {std::nullopt, ExerciseInsertError::idTaken};
  requireOk(result);
  if (held) return {held, ExerciseInsertError::none};
  for (const auto& exercise : catalog_.catalog(user)) if (exercise.id == incoming.id) return {exercise, ExerciseInsertError::none};
  return {std::nullopt, ExerciseInsertError::idTaken};
}

std::optional<Exercise> GymDoor::updateExercise(const UserId& user, const ExerciseUpdate& update) {
  const std::optional<std::string> name = update.name ? std::optional(canonicalName(*update.name)) : std::nullopt;
  if (name && (name->empty() || name->size() > kMaxNameLength || !storableText(*name)))
    throw InvalidTraining("an exercise needs a bounded, storable name");
  if (update.loadCount && *update.loadCount != 1 && *update.loadCount != 2)
    throw InvalidTraining("loadCount must be 1 or 2");
  if (update.requestId && !wellFormedId(*update.requestId)) throw InvalidTraining("requestId must be a stable, well-formed id");
  Json::Value arguments(Json::objectValue);
  arguments["exerciseId"] = update.id.str();
  if (name) arguments["name"] = *name;
  if (update.equipment) arguments["equipment"] = toString(*update.equipment);
  if (update.loadCount) arguments["loadCount"] = *update.loadCount;
  std::optional<Exercise> saved;
  bool found = false;
  const auto result = execute(user, [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
    if (update.requestId) {
      const auto rows = sync::sqlOf(txn).exec("select arguments::text,exercise::text from gym_exercise_updates where user_id=$1::uuid and request_id=$2",
                                            pqxx::params{user.str(), *update.requestId});
      if (!rows.empty()) {
        if (sync::parseJson(rows[0][0].as<std::string>()) != arguments) throw InvalidTraining("requestId already holds a different exercise edit");
        saved = exerciseFromJson(sync::parseJson(rows[0][1].as<std::string>()));
        return std::nullopt;
      }
    }
    const auto catalog = catalog_.catalog(user);
    const auto existing = std::find_if(catalog.begin(), catalog.end(), [&](const auto& item) { return item.id == update.id; });
    if (existing == catalog.end()) return std::nullopt;
    found = true;
    Json::Value fields(Json::objectValue);
    if (name && !existing->custom) fields["name"] = *name;
    if (update.equipment) fields["equipment"] = toString(*update.equipment);
    if (update.loadCount) fields["loadCount"] = *update.loadCount;
    auto built = intent();
    if (name && existing->custom) {
      Json::Value renamed(Json::objectValue);
      renamed["name"] = *name;
      built["d"].append(delta("exercise", update.id.str(), renamed));
    }
    if (!fields.empty()) built["d"].append(delta("exerciseName", update.id.str(), fields));
    if (built["d"].empty()) return std::nullopt;
    if (update.requestId) dynamic_cast<sync::PgSyncTxn&>(txn).beforeCommit([&, txnPtr = &txn] {
      auto& sql = sync::sqlOf(*txnPtr);
      const auto rows = sql.exec("select " + std::string(kExerciseColumns) + " from " + std::string(kExerciseFrom) +
        " where e.id=$2 and (e.created_by is null or e.created_by=$1::uuid)", pqxx::params{user.str(), update.id.str()});
      if (rows.empty()) throw std::logic_error("admitted exercise update is missing");
      saved = exerciseFrom(rows[0]);
      sql.exec("insert into gym_exercise_updates(user_id,request_id,arguments,exercise) values($1::uuid,$2,$3::jsonb,$4::jsonb)",
               pqxx::params{user.str(), *update.requestId, sync::jcs(arguments), sync::jcs(toJson(*saved))});
    });
    return built;
  });
  requireOk(result);
  if (saved) return saved;
  if (!found) return std::nullopt;
  for (const auto& exercise : catalog_.catalog(user)) if (exercise.id == update.id) return exercise;
  return std::nullopt;
}

NoteWriteOutcome GymDoor::saveInsight(const Note& incoming) {
  NoteWriteError error = NoteWriteError::none;
  std::optional<Note> saved;
  auto receipt = [&](sync::SyncTxn& txn) {
    const auto rows = sync::sqlOf(txn).exec("select note::text,user_id=$2::uuid from gym_note_saves where id=$1", pqxx::params{incoming.id.str(), incoming.user.str()});
    if (rows.empty()) return false;
    if (!rows[0][1].as<bool>()) { error = NoteWriteError::idTaken; return true; }
    const Json::Value json = sync::parseJson(rows[0][0].as<std::string>());
    saved = Note{Stored{}, NoteId{json["id"].asString()}, incoming.user, json["title"].asString(), json["body"].asString(), json["position"].asInt(), json["updatedAt"].asUInt64()};
    if (saved->title != incoming.title || saved->body != incoming.body) error = NoteWriteError::idTaken;
    return true;
  };
  const Json::Value result = execute(incoming.user, [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
    if (receipt(txn)) return std::nullopt;
    const auto ids = sync::sqlOf(txn).exec("select title,body,user_id=$2::uuid from gym_notes where id=$1", pqxx::params{incoming.id.str(), incoming.user.str()});
    if (!ids.empty() && (!ids[0][2].as<bool>() || ids[0][0].as<std::string>() != incoming.title || ids[0][1].as<std::string>() != incoming.body)) {
      error = NoteWriteError::idTaken; return std::nullopt;
    }
    const auto standing = sync::sqlOf(txn).exec("select id,title,body,position,(extract(epoch from updated_at)*1000)::bigint as updated_ms from gym_notes where user_id=$1::uuid order by position for update", pqxx::params{incoming.user.str()});
    for (const auto& note : standing) {
      if (note["title"].as<std::string>() != incoming.title || note["body"].as<std::string>() != incoming.body) continue;
      saved = Note{Stored{}, NoteId{note["id"].as<std::string>()}, incoming.user, note["title"].as<std::string>(), note["body"].as<std::string>(), note["position"].as<int>(), note["updated_ms"].as<std::uint64_t>()};
      break;
    }
    if (!saved && recordTaken(txn, incoming.user, "note", incoming.id.str())) { error = NoteWriteError::idTaken; return std::nullopt; }
    if (!saved && standing.size() >= kMaxNotes) { error = NoteWriteError::full; return std::nullopt; }
    dynamic_cast<sync::PgSyncTxn&>(txn).beforeCommit([&, txnPtr = &txn] {
      auto& sql = sync::sqlOf(*txnPtr);
      if (!saved) {
        const auto rows = sql.exec("select title,body,position,(extract(epoch from updated_at)*1000)::bigint as updated_ms from gym_notes where id=$1 and user_id=$2::uuid", pqxx::params{incoming.id.str(), incoming.user.str()});
        if (rows.empty()) throw std::logic_error("admitted insight note is missing");
        saved = Note{Stored{}, incoming.id, incoming.user, rows[0]["title"].as<std::string>(), rows[0]["body"].as<std::string>(), rows[0]["position"].as<int>(), rows[0]["updated_ms"].as<std::uint64_t>()};
      }
      const auto inserted = sql.exec("insert into gym_note_saves(id,user_id,note) values($1,$2::uuid,$3::jsonb) on conflict do nothing returning id", pqxx::params{incoming.id.str(), incoming.user.str(), sync::jcs(toJson(*saved))});
      if (inserted.empty() && (!receipt(*txnPtr) || error != NoteWriteError::none)) throw sync::Refusal("id-taken");
    });
    if (saved) {
      if (ids.empty() && saved->id != incoming.id) txn.reserveSpent("note", sync::RecordId{incoming.id.str()});
      return std::nullopt;
    }
    const auto rows = sync::sqlOf(txn).exec("select ord from gym_notes where user_id=$1::uuid order by ord collate \"C\" desc nulls last,id collate \"C\" desc limit 1", pqxx::params{incoming.user.str()});
    const std::optional<std::string> last = rows.empty() || rows[0][0].is_null() ? std::nullopt : std::optional(rows[0][0].as<std::string>());
    Json::Value fields(Json::objectValue); fields["title"] = incoming.title; fields["body"] = incoming.body; fields["ord"] = sync::between(last, std::nullopt);
    Json::Value built = intent(); built["d"].append(delta("note", incoming.id.str(), fields, true)); return built;
  });
  if (error != NoteWriteError::none) return {std::nullopt, error};
  if (refusal(result) == "cap") return {std::nullopt, NoteWriteError::full};
  if (refusal(result) == "id-spent" || refusal(result) == "id-taken") return {std::nullopt, NoteWriteError::idTaken};
  requireOk(result);
  return {saved, NoteWriteError::none};
}

}
