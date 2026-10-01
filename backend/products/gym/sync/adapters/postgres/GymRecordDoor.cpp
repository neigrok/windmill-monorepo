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

void guardFields(Json::Value& intent, sync::SyncTxn& txn, const std::string& table,
                 const std::string& type, const std::string& id, const Json::Value& fields) {
  for (const auto& field : fields.getMemberNames()) {
    const auto rows = sync::sqlOf(txn).exec("select " + field + "_stamp from " + table + " where id=$1", pqxx::params{id});
    Json::Value guard(Json::objectValue);
    guard["t"] = type;
    guard["id"] = id;
    guard["field"] = field;
    guard["stamp"] = rows.empty() || rows[0][0].is_null() ? Json::Value() : Json::Value(rows[0][0].as<std::string>());
    intent["guard"].append(guard);
  }
}

ProposalSettleError settleError(const Json::Value& result) {
  const std::string code = GymDoor::refusal(result);
  if (code == "unknown-record" || code == "record-dead") return ProposalSettleError::notFound;
  if (code == "proposal-settled") return ProposalSettleError::settled;
  if (code != "proposal-superseded") return ProposalSettleError::none;
  const std::string reason = result["detail"]["reason"].asString();
  if (reason == "routine-changed") return ProposalSettleError::routineMoved;
  if (reason == "replaced") return ProposalSettleError::replaced;
  return ProposalSettleError::superseded;
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

RoutineWriteOutcome GymDoor::replaceRoutine(const Routine& incoming, std::optional<int> revision) {
  RoutineWriteError error = RoutineWriteError::none;
  std::optional<Routine> held;
  const Json::Value result = execute(incoming.user, "replace_routine", toJson(incoming), [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
    held = program_.routine(incoming.user, incoming.id);
    if (!held) { error = RoutineWriteError::notFound; return std::nullopt; }
    const bool moved = held->name != incoming.name || held->entries != incoming.entries;
    if (moved && revision && held->revision != *revision) { error = RoutineWriteError::stale; return std::nullopt; }
    Json::Value fields(Json::objectValue);
    if (held->name != incoming.name) fields["name"] = incoming.name;
    if (held->position != incoming.position) fields["position"] = incoming.position;
    if (held->entries != incoming.entries) fields["entries"] = entriesOf(incoming);
    if (fields.empty()) return std::nullopt;
    if (moved && !knownEntries(catalog_, incoming.user, incoming.entries)) { error = RoutineWriteError::unknownExercise; return std::nullopt; }
    Json::Value built = intent();
    built["d"].append(delta("routine", incoming.id.str(), fields));
    guardFields(built, txn, "gym_routines", "routine", incoming.id.str(), fields);
    return built;
  });
  if (error != RoutineWriteError::none) return {std::nullopt, error};
  if (refusal(result) == "unknown-exercise") return {std::nullopt, RoutineWriteError::unknownExercise};
  if (refusal(result) == "stale") return {std::nullopt, RoutineWriteError::stale};
  if (refusal(result) == "unknown-record" || refusal(result) == "record-dead") return {std::nullopt, RoutineWriteError::notFound};
  requireOk(result);
  return {program_.routine(incoming.user, incoming.id), RoutineWriteError::none};
}

bool GymDoor::deleteRoutine(const UserId& user, const RoutineId& id) {
  bool found = false;
  Json::Value args(Json::objectValue); args["id"] = id.str();
  const Json::Value result = execute(user, "delete_routine", args, [&](sync::SyncTxn&) -> std::optional<Json::Value> {
    found = program_.routine(user, id).has_value();
    if (!found) return std::nullopt;
    Json::Value built = intent(); built["d"].append(delta("routine", id.str(), Json::Value(Json::objectValue), false, true));
    return built;
  });
  requireOk(result);
  return found;
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

ProposalSettleOutcome GymDoor::apply(const UserId& user, const ProposalId& id) {
  std::optional<RoutineProposal> before;
  Json::Value args(Json::objectValue); args["proposalId"] = id.str();
  const Json::Value result = execute(user, "gym.applyProposal", args, [&](sync::SyncTxn&) -> std::optional<Json::Value> {
    before = program_.proposal(user, id);
    Json::Value built = intent(); built["cmd"]["name"] = "gym.applyProposal"; built["cmd"]["args"] = args; return built;
  });
  const ProposalSettleError error = settleError(result);
  if (error == ProposalSettleError::routineMoved) {
    requireOk(execute(user, "supersede_proposal", args, [&](sync::SyncTxn&) -> std::optional<Json::Value> {
      const auto current = program_.proposal(user, id);
      if (!current || current->head.state != ProposalState::pending) return std::nullopt;
      Json::Value fields(Json::objectValue); fields["state"] = "superseded"; fields["settledAt"] = Json::UInt64(clock_.nowMs());
      Json::Value built = intent(); built["d"].append(delta("proposal", id.str(), fields)); return built;
    }));
  }
  if (error != ProposalSettleError::none) return {std::nullopt, std::nullopt, error};
  requireOk(result);
  auto settled = program_.proposal(user, id);
  if (!settled && before && before->head.intent == ProposalIntent::remove) {
    settled = before; settled->head.state = ProposalState::applied; settled->head.settledAtMs = clock_.nowMs();
  }
  const auto routine = settled && settled->head.intent == ProposalIntent::revise ? program_.routine(user, settled->head.routine) : std::nullopt;
  return {settled, routine, ProposalSettleError::none};
}

ProposalSettleOutcome GymDoor::dismiss(const UserId& user, const ProposalId& id) {
  Json::Value args(Json::objectValue); args["proposalId"] = id.str();
  const Json::Value result = command(user, "gym.dismissProposal", args);
  const ProposalSettleError error = settleError(result);
  if (error != ProposalSettleError::none) return {std::nullopt, std::nullopt, error};
  requireOk(result);
  return {program_.proposal(user, id), std::nullopt, ProposalSettleError::none};
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

std::optional<Exercise> GymDoor::renameExercise(const UserId& user, const ExerciseId& id, const std::string& name) {
  std::optional<Exercise> held;
  Json::Value args(Json::objectValue); args["id"] = id.str(); args["name"] = name;
  const Json::Value result = execute(user, "rename_exercise", args, [&](sync::SyncTxn&) -> std::optional<Json::Value> {
    for (const auto& exercise : catalog_.catalog(user)) if (exercise.id == id) { held = exercise; break; }
    if (!held) return std::nullopt;
    const Exercise named{id, name, held->pattern, held->equipment, held->stepKg, held->custom};
    if (named.name == held->name) return std::nullopt;
    Json::Value fields(Json::objectValue); fields["name"] = named.name;
    Json::Value built = intent(); built["d"].append(delta(held->custom ? "exercise" : "exerciseName", id.str(), fields)); return built;
  });
  requireOk(result);
  if (!held) return std::nullopt;
  for (const auto& exercise : catalog_.catalog(user)) if (exercise.id == id) return exercise;
  return std::nullopt;
}

NoteWriteOutcome GymDoor::saveNote(const Note& incoming) {
  NoteWriteError error = NoteWriteError::none;
  std::optional<Note> held;
  const Json::Value result = execute(incoming.user, "save_note_editor", toJson(incoming), [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
    const auto ids = sync::sqlOf(txn).exec("select user_id=$2::uuid from gym_notes where id=$1", pqxx::params{incoming.id.str(), incoming.user.str()});
    if (!ids.empty() && !ids[0][0].as<bool>()) { error = NoteWriteError::idTaken; return std::nullopt; }
    const auto standing = notes_.notes(incoming.user);
    for (const auto& note : standing) if (note.id == incoming.id) { held = note; break; }
    Json::Value fields(Json::objectValue);
    if (!held || held->title != incoming.title) fields["title"] = incoming.title;
    if (!held || held->body != incoming.body) fields["body"] = incoming.body;
    if (fields.empty()) return std::nullopt;
    if (!held) {
      const auto rows = sync::sqlOf(txn).exec("select ord from gym_notes where user_id=$1::uuid order by ord collate \"C\" desc nulls last,id collate \"C\" desc limit 1", pqxx::params{incoming.user.str()});
      const std::optional<std::string> last = rows.empty() || rows[0][0].is_null() ? std::nullopt : std::optional(rows[0][0].as<std::string>());
      fields["ord"] = sync::between(last, std::nullopt);
    }
    Json::Value built = intent(); built["d"].append(delta("note", incoming.id.str(), fields, !held));
    if (held) guardFields(built, txn, "gym_notes", "note", incoming.id.str(), fields);
    return built;
  });
  if (error != NoteWriteError::none) return {std::nullopt, error};
  if (refusal(result) == "cap") return {std::nullopt, NoteWriteError::full};
  if (refusal(result) == "id-spent" || refusal(result) == "id-taken") return {std::nullopt, NoteWriteError::idTaken};
  requireOk(result);
  for (const auto& note : notes_.notes(incoming.user)) if (note.id == incoming.id) return {note, NoteWriteError::none};
  return {std::nullopt, NoteWriteError::idTaken};
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
    for (const auto& note : notes_.notes(incoming.user)) if (note.title == incoming.title && note.body == incoming.body) { saved = note; break; }
    if (saved) return std::nullopt;
    if (recordTaken(txn, incoming.user, "note", incoming.id.str())) { error = NoteWriteError::idTaken; return std::nullopt; }
    if (notes_.notes(incoming.user).size() >= kMaxNotes) { error = NoteWriteError::full; return std::nullopt; }
    const auto rows = sync::sqlOf(txn).exec("select ord from gym_notes where user_id=$1::uuid order by ord collate \"C\" desc nulls last,id collate \"C\" desc limit 1", pqxx::params{incoming.user.str()});
    const std::optional<std::string> last = rows.empty() || rows[0][0].is_null() ? std::nullopt : std::optional(rows[0][0].as<std::string>());
    Json::Value fields(Json::objectValue); fields["title"] = incoming.title; fields["body"] = incoming.body; fields["ord"] = sync::between(last, std::nullopt);
    Json::Value built = intent(); built["d"].append(delta("note", incoming.id.str(), fields, true)); return built;
  });
  if (error != NoteWriteError::none) return {std::nullopt, error};
  if (refusal(result) == "cap") return {std::nullopt, NoteWriteError::full};
  if (refusal(result) == "id-spent" || refusal(result) == "id-taken") return {std::nullopt, NoteWriteError::idTaken};
  requireOk(result);
  const Json::Value recorded = execute(incoming.user, "save_note_receipt", toJson(incoming), [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
    if (receipt(txn)) return std::nullopt;
    if (!saved) for (const auto& note : notes_.notes(incoming.user)) if (note.title == incoming.title && note.body == incoming.body) { saved = note; break; }
    if (!saved) { error = NoteWriteError::idTaken; return std::nullopt; }
    const auto inserted = sync::sqlOf(txn).exec("insert into gym_note_saves(id,user_id,note) values($1,$2::uuid,$3::jsonb) on conflict do nothing returning id", pqxx::params{incoming.id.str(), incoming.user.str(), sync::jcs(toJson(*saved))});
    if (inserted.empty() && !receipt(txn)) error = NoteWriteError::idTaken;
    return std::nullopt;
  });
  requireOk(recorded);
  if (error != NoteWriteError::none) return {std::nullopt, error};
  return {saved, NoteWriteError::none};
}

void GymDoor::deleteNote(const UserId& user, const NoteId& id) {
  Json::Value args(Json::objectValue); args["id"] = id.str();
  requireOk(execute(user, "delete_note", args, [&](sync::SyncTxn&) -> std::optional<Json::Value> {
    const auto notes = notes_.notes(user);
    if (std::none_of(notes.begin(), notes.end(), [&](const Note& note) { return note.id == id; })) return std::nullopt;
    Json::Value built = intent(); built["d"].append(delta("note", id.str(), Json::Value(Json::objectValue), false, true)); return built;
  }));
}

NotesOrderOutcome GymDoor::reorderNotes(const UserId& user, const std::vector<NoteId>& order) {
  bool mismatch = false;
  Json::Value args(Json::arrayValue); for (const auto& id : order) args.append(id.str());
  const Json::Value result = execute(user, "reorder_notes", args, [&](sync::SyncTxn&) -> std::optional<Json::Value> {
    if (!namesEveryNoteOnce(notes_.notes(user), order)) { mismatch = true; return std::nullopt; }
    if (order.empty()) return std::nullopt;
    Json::Value built = intent(); std::optional<std::string> last;
    for (const auto& id : order) {
      last = sync::between(last, std::nullopt);
      Json::Value fields(Json::objectValue); fields["ord"] = *last; built["d"].append(delta("note", id.str(), fields));
    }
    return built;
  });
  if (mismatch) return {{}, NotesOrderError::mismatch};
  requireOk(result);
  return {notes_.notes(user), NotesOrderError::none};
}

Bodyweight GymDoor::saveBodyweight(const Bodyweight& incoming) {
  std::optional<Bodyweight> held;
  const Json::Value result = execute(incoming.user, "save_bodyweight", toJson(incoming), [&](sync::SyncTxn&) -> std::optional<Json::Value> {
    const auto entries = bodyweight_.entries(incoming.user, BodyweightRange{incoming.dateLocal, incoming.dateLocal});
    if (!entries.empty() && entries[0].recordedAtMs > incoming.recordedAtMs) { held = entries[0]; return std::nullopt; }
    Json::Value fields(Json::objectValue); fields["kg"] = incoming.weightKg; fields["recordedAt"] = Json::UInt64(incoming.recordedAtMs);
    Json::Value put = delta("weighin", incoming.dateLocal, fields, true); put.removeMember("born");
    Json::Value built = intent(); built["d"].append(put); return built;
  });
  if (refusal(result) == "bad-instant") throw InvalidTraining("A weigh-in is not a forecast — today or earlier.");
  requireOk(result);
  if (held) return *held;
  const auto entries = bodyweight_.entries(incoming.user, BodyweightRange{incoming.dateLocal, incoming.dateLocal});
  if (entries.empty()) throw std::runtime_error("admitted weigh-in is missing");
  return entries[0];
}

void GymDoor::deleteBodyweight(const UserId& user, const std::string& date) {
  Json::Value args(Json::objectValue); args["date"] = date;
  requireOk(execute(user, "delete_bodyweight", args, [&](sync::SyncTxn&) -> std::optional<Json::Value> {
    if (bodyweight_.entries(user, BodyweightRange{date, date}).empty()) return std::nullopt;
    Json::Value built = intent(); built["d"].append(delta("weighin", date, Json::Value(Json::objectValue), false, true)); return built;
  }));
}

GymPreferences GymDoor::savePreferences(const GymPreferences& incoming) {
  Json::Value fields = toJson(incoming);
  fields["restSeconds"] = incoming.restSeconds ? Json::Value(*incoming.restSeconds) : Json::Value();
  const Json::Value result = execute(incoming.user, "save_preferences", fields, [&](sync::SyncTxn&) -> std::optional<Json::Value> {
    const auto held = preferences_.preferences(incoming.user);
    if (held && *held == incoming) return std::nullopt;
    Json::Value built = intent(); built["d"].append(delta("prefs", "prefs", fields)); return built;
  });
  requireOk(result);
  return preferences_.preferences(incoming.user).value_or(GymPreferences{incoming.user});
}

}
