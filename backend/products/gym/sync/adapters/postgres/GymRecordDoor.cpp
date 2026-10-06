#include "products/gym/sync/adapters/postgres/GymDoor.h"

#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/domain/sync/FractionalIndex.h"
#include "platform/domain/sync/Jcs.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <algorithm>

namespace wm::gym {
namespace {

Json::Value entriesOf(const Routine& routine) {
  Json::Value entries = toJson(routine)["entries"];
  for (auto& entry : entries) entry.removeMember("position");
  return entries;
}

bool knownEntries(CatalogRepository& catalog, const UserId& user, const std::vector<RoutineEntry>& entries) {
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

RoutineWriteOutcome GymDoor::createRoutine(const Routine& incoming, std::optional<ProposalDoor> byAgent) {
  std::optional<Routine> held;
  RoutineWriteError error = RoutineWriteError::none;
  const Json::Value result = execute(incoming.user, "create_routine", toJson(incoming), [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
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
  ProposalMintError error = ProposalMintError::none;
  std::optional<RoutineProposal> held;
  Json::Value args(Json::objectValue); args["id"] = incoming.id.str();
  const Json::Value result = execute(user, "propose_routine_change", args, [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
    const auto base = program_.routine(user, incoming.routine);
    if (!base) { error = ProposalMintError::unknownRoutine; return std::nullopt; }
    const Routine becomes{base->id, user, incoming.name.value_or(base->name), base->position, incoming.entries};
    std::vector<RoutineChange> changes = changesBetween(base->entries, becomes.entries);
    const int count = countedChanges(base->entries, changes, base->name, becomes.name);
    if (count == 0) { error = ProposalMintError::noChange; return std::nullopt; }
    const RoutineProposal proposal{ProposalHead{incoming.id, base->id, user, ProposalIntent::revise, ProposalState::pending,
        incoming.source, incoming.summary, count, clock_.nowMs(), std::nullopt}, base->revision, base->name, becomes.name, std::move(changes)};
    const auto ids = sync::sqlOf(txn).exec("select user_id=$2::uuid from gym_proposals where id=$1", pqxx::params{incoming.id.str(), user.str()});
    if (!ids.empty()) {
      if (!ids[0][0].as<bool>()) { error = ProposalMintError::idTaken; return std::nullopt; }
      held = program_.proposal(user, incoming.id);
      if (!held || !isReplayOf(*held, proposal)) error = ProposalMintError::idReused;
      return std::nullopt;
    }
    if (recordTaken(txn, user, "proposal", incoming.id.str())) { error = ProposalMintError::idTaken; return std::nullopt; }
    if (!knownEntries(catalog_, user, becomes.entries)) { error = ProposalMintError::unknownExercise; return std::nullopt; }
    Json::Value built = intent(); built["d"].append(delta("proposal", incoming.id.str(), proposalFields(proposal), true));
    return built;
  });
  if (error != ProposalMintError::none) return {std::nullopt, error};
  const std::string code = refusal(result);
  if (code == "id-taken" || code == "id-spent") return {std::nullopt, ProposalMintError::idTaken};
  if (code == "unknown-record") return {std::nullopt, ProposalMintError::unknownRoutine};
  if (code == "unknown-exercise") return {std::nullopt, ProposalMintError::unknownExercise};
  requireOk(result);
  return {held ? held : program_.proposal(user, incoming.id), ProposalMintError::none};
}

ProposalMintOutcome GymDoor::proposeRemoval(const UserId& user, const ProposalId& id, const RoutineId& routine,
                                          const std::string& summary, const ProposalSource& source) {
  ProposalMintError error = ProposalMintError::none;
  std::optional<RoutineProposal> held;
  Json::Value args(Json::objectValue); args["id"] = id.str();
  const Json::Value result = execute(user, "propose_routine_removal", args, [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
    const auto base = program_.routine(user, routine);
    if (!base) { error = ProposalMintError::unknownRoutine; return std::nullopt; }
    auto changes = changesBetween(base->entries, {});
    const int count = static_cast<int>(changes.size());
    const RoutineProposal proposal{ProposalHead{id, routine, user, ProposalIntent::remove, ProposalState::pending,
        source, summary, count, clock_.nowMs(), std::nullopt}, base->revision, base->name, base->name, std::move(changes)};
    const auto ids = sync::sqlOf(txn).exec("select user_id=$2::uuid from gym_proposals where id=$1", pqxx::params{id.str(), user.str()});
    if (!ids.empty()) {
      if (!ids[0][0].as<bool>()) { error = ProposalMintError::idTaken; return std::nullopt; }
      held = program_.proposal(user, id);
      if (!held || !isReplayOf(*held, proposal)) error = ProposalMintError::idReused;
      return std::nullopt;
    }
    if (recordTaken(txn, user, "proposal", id.str())) { error = ProposalMintError::idTaken; return std::nullopt; }
    Json::Value built = intent(); built["d"].append(delta("proposal", id.str(), proposalFields(proposal), true));
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

ExerciseInsertOutcome GymDoor::createExercise(const UserId& user, const Exercise& incoming) {
  std::optional<Exercise> held;
  const Json::Value result = execute(user, "create_exercise", toJson(incoming), [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
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

NoteWriteOutcome GymDoor::saveInsight(const Note& incoming) {
  NoteWriteError error = NoteWriteError::none;
  std::optional<Note> saved;
  auto receipt = [&](sync::SyncTxn& txn) {
    const auto rows = sync::sqlOf(txn).exec("select note::text,user_id=$2::uuid from gym_note_saves where id=$1", pqxx::params{incoming.id.str(), incoming.user.str()});
    if (rows.empty()) return false;
    if (!rows[0][1].as<bool>()) { error = NoteWriteError::idTaken; return true; }
    const Json::Value json = sync::parseJson(rows[0][0].as<std::string>());
    saved = Note{NoteId{json["id"].asString()}, incoming.user, json["title"].asString(), json["body"].asString(), json["position"].asInt(), json["updatedAt"].asUInt64()};
    if (saved->title != incoming.title || saved->body != incoming.body) error = NoteWriteError::idTaken;
    return true;
  };
  const Json::Value result = execute(incoming.user, "save_note", toJson(incoming), [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
    if (receipt(txn)) return std::nullopt;
    const auto ids = sync::sqlOf(txn).exec("select title,body,user_id=$2::uuid from gym_notes where id=$1", pqxx::params{incoming.id.str(), incoming.user.str()});
    if (!ids.empty() && (!ids[0][2].as<bool>() || ids[0][0].as<std::string>() != incoming.title || ids[0][1].as<std::string>() != incoming.body)) {
      error = NoteWriteError::idTaken; return std::nullopt;
    }
    const auto standing = sync::sqlOf(txn).exec("select id,title,body,position,(extract(epoch from updated_at)*1000)::bigint as updated_ms from gym_notes where user_id=$1::uuid order by position for update", pqxx::params{incoming.user.str()});
    for (const auto& note : standing) {
      if (note["title"].as<std::string>() != incoming.title || note["body"].as<std::string>() != incoming.body) continue;
      saved = Note{NoteId{note["id"].as<std::string>()}, incoming.user, note["title"].as<std::string>(), note["body"].as<std::string>(), note["position"].as<int>(), note["updated_ms"].as<std::uint64_t>()};
      break;
    }
    if (!saved && recordTaken(txn, incoming.user, "note", incoming.id.str())) { error = NoteWriteError::idTaken; return std::nullopt; }
    if (!saved && standing.size() >= kMaxNotes) { error = NoteWriteError::full; return std::nullopt; }
    dynamic_cast<sync::PgSyncTxn&>(txn).beforeCommit([&, txnPtr = &txn] {
      auto& sql = sync::sqlOf(*txnPtr);
      if (!saved) {
        const auto rows = sql.exec("select title,body,position,(extract(epoch from updated_at)*1000)::bigint as updated_ms from gym_notes where id=$1 and user_id=$2::uuid", pqxx::params{incoming.id.str(), incoming.user.str()});
        if (rows.empty()) throw std::logic_error("admitted insight note is missing");
        saved = Note{incoming.id, incoming.user, rows[0]["title"].as<std::string>(), rows[0]["body"].as<std::string>(), rows[0]["position"].as<int>(), rows[0]["updated_ms"].as<std::uint64_t>()};
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
