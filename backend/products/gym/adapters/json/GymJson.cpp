#include "platform/adapters/json/AiBudgetJson.h"
#include "products/gym/adapters/json/GymJson.h"

#include <string>
#include <cmath>
#include <utility>
#include <vector>

namespace wm::gym {

namespace {
// Zero is an unset device clock, not a moment; past the ceiling would overflow a timestamptz.
std::uint64_t instantOf(const Json::Value& body, const char* field) {
  if (!body[field].isUInt64())
    throw InvalidTraining(std::string(field) + " must be an epoch-ms number");
  const std::uint64_t instant = body[field].asUInt64();
  if (instant == 0) throw InvalidTraining(std::string(field) + " must be an instant, not zero");
  if (instant > kMaxInstantMs) throw InvalidTraining(std::string(field) + " is past the end of time");
  return instant;
}

Json::Value topSetJson(const TopSet& top) {
  Json::Value body(Json::objectValue);
  body["weightKg"] = top.weightKg;
  body["reps"] = top.reps;
  body["sets"] = top.sets;
  return body;
}

Json::Value bestJson(const Best& best) {
  Json::Value body(Json::objectValue);
  body["weightKg"] = best.weightKg;
  body["reps"] = best.reps;
  body["at"] = Json::Value::UInt64(best.atMs);
  if (best.e1rm) body["e1rm"] = Estimate::stated(*best.e1rm);
  return body;
}

// `e1rm` is never optional here: a point with no honest estimate is in neither list.
Json::Value pointJson(const RecordPoint& point) {
  Json::Value body(Json::objectValue);
  body["at"] = Json::Value::UInt64(point.atMs);
  body["weightKg"] = point.weightKg;
  body["reps"] = point.reps;
  body["e1rm"] = Estimate::stated(point.e1rm);
  return body;
}
}

SessionStart parseSessionStart(const Json::Value& body) {
  if (!body.isObject()) throw InvalidTraining("a session start must be a json object");
  if (!body["id"].isString()) throw InvalidTraining("id must be a string");
  SessionStart start{SessionId{body["id"].asString()}, instantOf(body, "startedAt")};
  // Omitted or null means join; a present value parses strictly.
  if (body.isMember("joinOpenSession") && !body["joinOpenSession"].isNull()) {
    if (!body["joinOpenSession"].isBool())
      throw InvalidTraining("joinOpenSession must be a boolean");
    start.joinOpenSession = body["joinOpenSession"].asBool();
  }
  // Omitted is the ad-hoc session; present, the server loads that routine and freezes it.
  if (body.isMember("routineId") && !body["routineId"].isNull()) {
    if (!body["routineId"].isString()) throw InvalidTraining("routineId must be a string");
    start.routine = RoutineId{body["routineId"].asString()};
  }
  return start;
}

SetWrite parseSetWrite(const Json::Value& body) {
  if (!body.isObject()) throw InvalidTraining("a set must be a json object");
  if (!body["id"].isString()) throw InvalidTraining("id must be a string");
  if (!body["exerciseId"].isString()) throw InvalidTraining("exerciseId must be a string");
  if (!body["weightKg"].isNumeric()) throw InvalidTraining("weightKg must be a number");
  if (!body["reps"].isInt()) throw InvalidTraining("reps must be a whole number");

  SetWrite write{SetId{body["id"].asString()}, ExerciseId{body["exerciseId"].asString()},
                 body["weightKg"].asDouble(), body["reps"].asInt(),
                 std::nullopt, "", instantOf(body, "completedAt")};
  if (body.isMember("rpe") && !body["rpe"].isNull()) {
    if (!body["rpe"].isNumeric()) throw InvalidTraining("rpe must be a number");
    write.rpe = body["rpe"].asDouble();
  }
  if (body.isMember("note") && !body["note"].isNull()) {
    if (!body["note"].isString()) throw InvalidTraining("note must be a string");
    write.note = body["note"].asString();
  }
  return write;
}

// Field-strict at both levels, where a start and a lone set are not: a whole workout written at once
// is the one body a misspelled field would silently empty. Each set is then read as any set is.
SessionImport parseSessionImport(const Json::Value& body) {
  if (!body.isObject()) throw InvalidTraining("an import must be a json object");
  for (const std::string& field : body.getMemberNames()) {
    if (field == "id" || field == "startedAt" || field == "finishedAt" || field == "routineId" ||
        field == "sets")
      continue;
    throw InvalidTraining("unknown import field \"" + field +
                          "\". An import takes: id, startedAt, finishedAt, routineId, sets.");
  }
  if (!body["id"].isString()) throw InvalidTraining("id must be a string");
  SessionImport incoming{SessionId{body["id"].asString()}, instantOf(body, "startedAt"),
                         instantOf(body, "finishedAt"), std::nullopt, {}};
  if (body.isMember("routineId") && !body["routineId"].isNull()) {
    if (!body["routineId"].isString()) throw InvalidTraining("routineId must be a string");
    incoming.routine = RoutineId{body["routineId"].asString()};
  }
  if (!body["sets"].isArray() || body["sets"].size() > kMaxSetBatch)
    throw InvalidTraining("sets must contain 0 to 200 rows");
  for (Json::ArrayIndex i = 0; i < body["sets"].size(); ++i) {
    const Json::Value& set = body["sets"][i];
    const std::string path = "sets[" + std::to_string(i) + "]: ";
    if (set.isObject())
      for (const std::string& field : set.getMemberNames()) {
        if (field == "id" || field == "exerciseId" || field == "weightKg" || field == "reps" ||
            field == "completedAt" || field == "rpe" || field == "note")
          continue;
        throw InvalidTraining(path + "unknown set field \"" + field +
                              "\". A set takes: id, exerciseId, weightKg, reps, completedAt, rpe, note.");
      }
    try {
      incoming.sets.push_back(parseSetWrite(set));
    } catch (const InvalidTraining& error) {
      throw InvalidTraining(path + error.what());
    }
  }
  return incoming;
}

std::uint64_t parseFinish(const Json::Value& body) {
  if (!body.isObject()) throw InvalidTraining("a finish must be a json object");
  return instantOf(body, "finishedAt");
}

namespace {
// The wire's scheme, refused strictly: an empty array is a zero target, and the entity refuses the
// per-set bounds and the length with the pinned sentences.
std::vector<SetTarget> schemeFrom(const Json::Value& sets) {
  if (!sets.isArray()) throw InvalidTraining("sets must be an array");
  if (sets.empty()) throw InvalidTraining("a zero target is no target — leave out the sets instead");
  std::vector<SetTarget> scheme;
  for (const Json::Value& set : sets) {
    if (!set.isObject()) throw InvalidTraining("a set target must be a json object");
    for (const std::string& field : set.getMemberNames()) {
      if (field == "reps" || field == "weightKg") continue;
      throw InvalidTraining("unknown set field \"" + field + "\". A set takes: reps, weightKg.");
    }
    // Both mean something by their absence: never fill one in with a zero.
    std::optional<int> reps;
    if (set.isMember("reps") && !set["reps"].isNull()) {
      if (!set["reps"].isInt()) throw InvalidTraining("reps must be a whole number");
      reps = set["reps"].asInt();
    }
    std::optional<double> weightKg;
    if (set.isMember("weightKg") && !set["weightKg"].isNull()) {
      if (!set["weightKg"].isNumeric()) throw InvalidTraining("weightKg must be a number");
      weightKg = set["weightKg"].asDouble();
    }
    scheme.push_back(SetTarget{reps, weightKg});
  }
  return scheme;
}

// Shared by the lifter's routine write and an agent's proposal.
std::vector<RoutineEntry> entriesFrom(const Json::Value& body) {
  if (!body["entries"].isArray()) throw InvalidTraining("entries must be an array");
  std::vector<RoutineEntry> entries;
  for (const Json::Value& entry : body["entries"]) {
    if (!entry.isObject()) throw InvalidTraining("a routine entry must be a json object");
    // An unknown field name is refused rather than ignored. `position` is accepted and ignored:
    // lines are renumbered 1..n in arrival order.
    for (const std::string& field : entry.getMemberNames()) {
      if (field == "exerciseId" || field == "sets" || field == "restSeconds" || field == "position")
        continue;
      throw InvalidTraining("unknown routine entry field \"" + field +
                            "\". An entry takes: exerciseId, sets, restSeconds.");
    }
    if (!entry["exerciseId"].isString()) throw InvalidTraining("exerciseId must be a string");
    // No `sets` is the open line; a present array is the scheme, refused strictly.
    std::vector<SetTarget> sets;
    if (entry.isMember("sets") && !entry["sets"].isNull()) sets = schemeFrom(entry["sets"]);
    std::optional<int> restSeconds;
    if (entry.isMember("restSeconds") && !entry["restSeconds"].isNull()) {
      if (!entry["restSeconds"].isInt()) throw InvalidTraining("restSeconds must be a whole number");
      restSeconds = entry["restSeconds"].asInt();
    }
    // The entity refuses anything but 1..n.
    entries.push_back(RoutineEntry{static_cast<int>(entries.size()) + 1,
                                   ExerciseId{entry["exerciseId"].asString()}, std::move(sets),
                                   restSeconds});
  }
  return entries;
}
}

RoutineWrite parseRoutineWrite(const Json::Value& body) {
  if (!body.isObject()) throw InvalidTraining("a routine must be a json object");
  if (!body["id"].isString()) throw InvalidTraining("id must be a string");
  if (!body["name"].isString()) throw InvalidTraining("name must be a string");
  if (!body["position"].isInt()) throw InvalidTraining("position must be a whole number");
  return RoutineWrite{RoutineId{body["id"].asString()}, body["name"].asString(),
                      body["position"].asInt(), entriesFrom(body)};
}

// An absent `name` keeps the routine's own; an absent `summary` draws the diff.
ProposalWrite parseProposalWrite(const Json::Value& body, const ProposalSource& source) {
  if (!body.isObject()) throw InvalidTraining("a proposal must be a json object");
  if (!body["id"].isString()) throw InvalidTraining("id must be a string");
  if (!body["routineId"].isString()) throw InvalidTraining("routineId must be a string");
  std::optional<std::string> name;
  if (body.isMember("name") && !body["name"].isNull()) {
    if (!body["name"].isString()) throw InvalidTraining("name must be a string");
    name = body["name"].asString();
  }
  std::string summary;
  if (body.isMember("summary") && !body["summary"].isNull()) {
    if (!body["summary"].isString()) throw InvalidTraining("summary must be a string");
    summary = body["summary"].asString();
  }
  return ProposalWrite{ProposalId{body["id"].asString()}, RoutineId{body["routineId"].asString()},
                       std::move(name), std::move(summary), entriesFrom(body), source};
}

// An absent `summary` draws the diff.
WorkoutProposalWrite parseWorkoutProposalWrite(const Json::Value& body, const ProposalSource& source) {
  if (!body.isObject()) throw InvalidTraining("a proposal must be a json object");
  if (!body["id"].isString()) throw InvalidTraining("id must be a string");
  if (!body["sessionId"].isString()) throw InvalidTraining("sessionId must be a string");
  std::string summary;
  if (body.isMember("summary") && !body["summary"].isNull()) {
    if (!body["summary"].isString()) throw InvalidTraining("summary must be a string");
    summary = body["summary"].asString();
  }
  return WorkoutProposalWrite{ProposalId{body["id"].asString()}, SessionId{body["sessionId"].asString()},
                              std::move(summary), entriesFrom(body), source};
}

ExerciseWrite parseExerciseWrite(const Json::Value& body) {
  if (!body.isObject()) throw InvalidTraining("a movement must be a json object");
  if (!body["id"].isString()) throw InvalidTraining("id must be a string");
  // A created movement's id is client-minted and obeys the id-shape rule here, not in the Exercise
  // constructor: seeded slugs ('dip') are shorter than any minted id may be.
  if (!wellFormedId(body["id"].asString())) throw InvalidTraining("bad exercise id");
  if (!body["name"].isString()) throw InvalidTraining("name must be a string");
  if (!body["pattern"].isString()) throw InvalidTraining("pattern must be a string");
  if (!body["equipment"].isString()) throw InvalidTraining("equipment must be a string");

  ExerciseWrite write{ExerciseId{body["id"].asString()}, body["name"].asString(),
                      parsePattern(body["pattern"].asString()),
                      parseEquipment(body["equipment"].asString()), std::nullopt};
  // Omitted takes the equipment's default step, which the domain owns.
  if (body.isMember("stepKg") && !body["stepKg"].isNull()) {
    if (!body["stepKg"].isNumeric()) throw InvalidTraining("stepKg must be a number");
    write.stepKg = body["stepKg"].asDouble();
  }
  return write;
}

Json::Value toJson(const GymPreferences& preferences) {
  Json::Value body(Json::objectValue);
  body["units"] = toString(preferences.units);
  if (preferences.restSeconds) body["restSeconds"] = *preferences.restSeconds;
  body["restSound"] = preferences.restSound;
  body["confirmHaptic"] = preferences.confirmHaptic;
  body["confirmSound"] = preferences.confirmSound;
  return body;
}

Json::Value toJson(const Session& session) {
  Json::Value body(Json::objectValue);
  body["id"] = session.id.str();
  body["startedAt"] = Json::Value::UInt64(session.startedAtMs);
  if (session.finishedAtMs) body["finishedAt"] = Json::Value::UInt64(*session.finishedAtMs);
  if (session.routine) body["routineId"] = session.routine->str();
  if (session.plan) body["plan"] = toJson(*session.plan);
  if (session.displayName) body["routineName"] = *session.displayName;
  return body;
}

Json::Value toJson(const Set& set) {
  Json::Value body(Json::objectValue);
  body["id"] = set.id.str();
  body["exerciseId"] = set.exercise.str();
  body["setNumber"] = set.setNumber;
  body["weightKg"] = set.weightKg;
  body["reps"] = set.reps;
  if (set.rpe) body["rpe"] = *set.rpe;
  body["note"] = set.note;
  body["completedAt"] = Json::Value::UInt64(set.completedAtMs);
  return body;
}

Json::Value toJson(const std::vector<Set>& sets) {
  Json::Value array(Json::arrayValue);
  for (const Set& set : sets) array.append(toJson(set));
  return array;
}

// tonnageKg is always present: null is unavailable and zero is a real answer. topSet is omitted for a session with no
// set; topE1rm is null when no set earned an available estimate.
Json::Value toJson(const LogRow& row) {
  Json::Value body = toJson(row.summary.session);
  body["setCount"] = row.summary.setCount;
  body["workingSetCount"] = row.summary.workingSetCount;
  body["tonnageKg"] = row.summary.tonnageKg ? Json::Value(*row.summary.tonnageKg) : Json::Value();
  Json::Value names(Json::arrayValue);
  for (const std::string& name : row.summary.exerciseNames) names.append(name);
  body["exercises"] = names;
  if (row.summary.topSet) {
    Json::Value top(Json::objectValue);
    top["weightKg"] = row.summary.topSet->weightKg;
    top["reps"] = row.summary.topSet->reps;
    body["topSet"] = top;
  }
  body["topE1rm"] = row.topE1rm ? Json::Value(Estimate::stated(*row.topE1rm)) : Json::Value();
  body["record"] = row.record;
  body["closedItself"] = row.summary.closedItself;
  return body;
}

Exercise exerciseFromJson(const Json::Value& body) {
  std::vector<std::string> aliases;
  for (const auto& alias : body["aliases"]) aliases.push_back(alias.asString());
  return Exercise{Stored{}, ExerciseId{body["id"].asString()}, body["name"].asString(),
    patternFromStored(body["pattern"].asString()), equipmentFromStored(body["equipment"].asString()),
    body["stepKg"].asDouble(), body["custom"].asBool(), std::move(aliases), body.get("loadCount", 0).asInt()};
}

Json::Value toJson(const Exercise& exercise) {
  Json::Value body(Json::objectValue);
  body["id"] = exercise.id.str();
  body["name"] = exercise.name;
  body["pattern"] = toString(exercise.pattern);
  body["equipment"] = toString(exercise.equipment);
  if (exercise.equipment == Equipment::dumbbell) body["loadCount"] = exercise.loadCount;
  body["stepKg"] = exercise.stepKg;
  body["custom"] = exercise.custom;
  if (!exercise.aliases.empty()) {
    Json::Value aliases(Json::arrayValue);
    for (const std::string& alias : exercise.aliases) aliases.append(alias);
    body["aliases"] = aliases;
  }
  return body;
}

Json::Value toJson(const std::vector<Exercise>& exercises) {
  Json::Value array(Json::arrayValue);
  for (const Exercise& exercise : exercises) array.append(toJson(exercise));
  return array;
}

// `at` is the session's start. No movement name: the caller joins on `exerciseId`.
Json::Value toJson(const std::vector<LastSet>& movements) {
  Json::Value array(Json::arrayValue);
  for (const LastSet& movement : movements) {
    Json::Value line(Json::objectValue);
    line["exerciseId"] = movement.exercise.str();
    line["weightKg"] = movement.weightKg;
    line["reps"] = movement.reps;
    line["at"] = Json::Value::UInt64(movement.atMs);
    array.append(line);
  }
  return array;
}

Json::Value toJson(const std::vector<RoutineEntry>& source) {
  Json::Value entries(Json::arrayValue);
  for (const RoutineEntry& entry : source) {
    Json::Value line(Json::objectValue);
    line["position"] = entry.position;
    line["exerciseId"] = entry.exercise.str();
    if (!entry.sets.empty()) line["sets"] = toJson(entry.sets);
    if (entry.restSeconds) line["restSeconds"] = *entry.restSeconds;
    entries.append(line);
  }
  return entries;
}

Json::Value toJson(const Routine& routine) {
  Json::Value body(Json::objectValue);
  body["id"] = routine.id.str();
  body["name"] = routine.name;
  body["position"] = routine.position;
  body["revision"] = routine.revision;
  if (routine.lastTrainedAtMs) body["lastTrainedAt"] = Json::Value::UInt64(*routine.lastTrainedAtMs);
  body["entries"] = toJson(routine.entries);
  return body;
}

Json::Value toJson(const Routine& routine, const std::optional<ProposalHead>& pending) {
  Json::Value body = toJson(routine);
  if (pending) body["pendingProposal"] = toJson(*pending);
  return body;
}

Json::Value toJson(const std::vector<Routine>& routines, const std::vector<ProposalHead>& pending) {
  Json::Value array(Json::arrayValue);
  for (const Routine& routine : routines) {
    std::optional<ProposalHead> standing;
    // The heads arrive newest first, so the first match is the newest.
    for (const ProposalHead& head : pending)
      if (!standing && head.routine == routine.id && head.state == ProposalState::pending)
        standing = head;
    array.append(toJson(routine, standing));
  }
  return array;
}

namespace {
// A proposal's provenance: the door always, the connection, agent and thread where it has one.
Json::Value sourceJson(const ProposalSource& source) {
  Json::Value body(Json::objectValue);
  body["door"] = toString(source.door);
  if (!source.connection.empty()) body["connection"] = source.connection;
  if (!source.agent.empty()) body["agent"] = source.agent;
  if (source.thread) body["thread"] = source.thread->str();
  return body;
}
}

Json::Value toJson(const ProposalHead& head) {
  Json::Value body(Json::objectValue);
  body["id"] = head.id.str();
  body["routineId"] = head.routine.str();
  body["intent"] = toString(head.intent);
  body["state"] = toString(head.state);
  body["summary"] = head.summary;
  // A `kept` row is not a change; a renamed routine is one.
  body["changeCount"] = head.changes;
  body["createdAt"] = Json::Value::UInt64(head.createdAtMs);
  if (head.settledAtMs) body["settledAt"] = Json::Value::UInt64(*head.settledAtMs);
  body["source"] = sourceJson(head.source);
  return body;
}

Json::Value toJson(const ThreadOutcome& outcome) {
  Json::Value body(Json::objectValue);
  body["kind"] = toString(outcome.kind);
  // Always present; an unknown outcome has no trustworthy count and carries zero.
  body["changes"] = outcome.changes;
  if (outcome.routine) {
    body["routineId"] = outcome.routine->str();
    body["routine"] = outcome.routineName;
  }
  return body;
}

Json::Value toJson(const CoachAttachment& attachment) {
  Json::Value body(Json::objectValue);
  body["id"] = attachment.id;
  body["mediaType"] = attachment.mediaType;
  body["width"] = attachment.width;
  body["height"] = attachment.height;
  body["bytes"] = Json::UInt64(attachment.bytes);
  return body;
}

std::vector<CoachAttachment> coachAttachmentsFrom(const Json::Value& attachments) {
  std::vector<CoachAttachment> result;
  for (const auto& item : attachments)
    result.push_back({item["id"].asString(), item["mediaType"].asString(), item["width"].asInt(),
                      item["height"].asInt(), item["bytes"].asUInt64()});
  return result;
}

Json::Value toJson(const std::vector<CoachResult>& results) {
  Json::Value body(Json::arrayValue);
  for (const auto& result : results) {
    Json::Value item(Json::objectValue);
    item["kind"] = "routine-created";
    item["operationId"] = result.operationId;
    item["routineId"] = result.routineId;
    item["routineName"] = result.routineName;
    if (result.movementCount) item["movementCount"] = *result.movementCount;
    body.append(item);
  }
  return body;
}

std::vector<CoachResult> coachResultsFrom(const Json::Value& results) {
  std::vector<CoachResult> out;
  for (const auto& result : results) {
    out.push_back({result["operationId"].asString(), result["routineId"].asString(), result["routineName"].asString()});
    if (result["movementCount"].isUInt()) out.back().movementCount = result["movementCount"].asUInt();
  }
  return out;
}

Json::Value toJson(const AiBudgetView& allowance) { return aiAllowanceJson(allowance); }

Json::Value toJson(const CoachClarification& clarification) {
  Json::Value body(Json::objectValue);
  body["id"] = clarification.id;
  body["question"] = clarification.question;
  body["groups"] = Json::Value(Json::arrayValue);
  for (const auto& group : clarification.groups) {
    Json::Value item(Json::objectValue);
    item["id"] = group.id;
    item["label"] = group.label;
    item["multiple"] = group.multiple;
    item["options"] = Json::Value(Json::arrayValue);
    for (const auto& option : group.options) {
      Json::Value choice(Json::objectValue);
      choice["id"] = option.id;
      choice["label"] = option.label;
      item["options"].append(choice);
    }
    body["groups"].append(item);
  }
  return body;
}

std::optional<CoachClarification> clarificationFrom(const Json::Value& body) {
  if (!body.isObject() || body.size() != 3 || !body["id"].isString() || !body["question"].isString() ||
      !body["groups"].isArray() || body["groups"].size() > 2) return std::nullopt;
  CoachClarification clarification{body["id"].asString(), body["question"].asString()};
  for (const auto& item : body["groups"]) {
    if (!item.isObject() || item.size() != 4 || !item["id"].isString() || !item["label"].isString() ||
        !item["multiple"].isBool() || !item["options"].isArray() || item["options"].size() > 6) return std::nullopt;
    CoachChoiceGroup group{item["id"].asString(), item["label"].asString(), item["multiple"].asBool()};
    for (const auto& option : item["options"]) {
      if (!option.isObject() || option.size() != 2 || !option["id"].isString() || !option["label"].isString()) return std::nullopt;
      group.options.push_back({option["id"].asString(), option["label"].asString()});
    }
    clarification.groups.push_back(std::move(group));
  }
  if (!validClarification(clarification)) return std::nullopt;
  return clarification;
}

Json::Value toJson(const std::vector<CoachRoutineDraft>& drafts) {
  Json::Value out(Json::arrayValue);
  for (const auto& draft : drafts) {
    Json::Value body(Json::objectValue);
    body["operationId"] = draft.operationId;
    body["routineId"] = draft.routineId;
    body["name"] = draft.name;
    body["position"] = draft.position;
    body["entries"] = toJson(draft.entries);
    body["state"] = draft.state;
    out.append(body);
  }
  return out;
}

std::vector<CoachRoutineDraft> coachRoutineDraftsFrom(const Json::Value& drafts) {
  std::vector<CoachRoutineDraft> out;
  for (const auto& draft : drafts) {
    auto body = draft;
    body["id"] = draft["routineId"];
    body.removeMember("routineId");
    body.removeMember("operationId");
    body.removeMember("state");
    const auto routine = parseRoutineWrite(body);
    out.push_back({draft["operationId"].asString(), routine.id.str(), routine.name,
                   routine.position, routine.entries, draft.get("state", "pending").asString()});
  }
  return out;
}

Json::Value toJson(const AskGeneration& generation) {
  Json::Value body(Json::objectValue);
  body["id"] = generation.id;
  body["requestId"] = generation.requestId;
  body["question"] = generation.question;
  if (generation.purpose != "conversation") body["purpose"] = generation.purpose;
  if (generation.routineReview) body["routineReview"] = true;
  if (generation.clarification) body["clarification"] = toJson(*generation.clarification);
  body["status"] = generation.status;
  body["answer"] = generation.answer;
  body["at"] = Json::UInt64(generation.atMs);
  body["steps"] = toJson(generation.steps);
  body["results"] = toJson(generation.results);
  if (!generation.routineDrafts.empty()) body["routineDrafts"] = toJson(generation.routineDrafts);
  body["revision"] = Json::UInt64(generation.revision);
  if (generation.stopRequested) body["stopRequested"] = true;
  if (!generation.attachments.empty()) {
    body["attachments"] = Json::Value(Json::arrayValue);
    for (const auto& attachment : generation.attachments) body["attachments"].append(toJson(attachment));
  }
  if (generation.receipt) body["receipt"] = toJson(*generation.receipt);
  if (generation.allowanceRefusal) body["allowanceRefusal"] = toJson(*generation.allowanceRefusal);
  return body;
}

AskGeneration generationFrom(const Json::Value& body) {
  AskGeneration generation;
  generation.id = body["id"].asString();
  generation.requestId = body["requestId"].asString();
  generation.question = body["question"].asString();
  generation.purpose = body.get("purpose", "conversation").asString();
  generation.routineReview = body.get("routineReview", false).asBool();
  generation.clarification = clarificationFrom(body["clarification"]);
  generation.status = body["status"].asString();
  generation.answer = body.get("answer", "").asString();
  generation.atMs = body.get("at", Json::UInt64(0)).asUInt64();
  generation.receipt = receiptFrom(body["receipt"]);
  for (const Json::Value& step : body["steps"])
    generation.steps.push_back({step["tool"].asString(), step["failed"].asBool()});
  generation.results = coachResultsFrom(body["results"]);
  generation.routineDrafts = coachRoutineDraftsFrom(body["routineDrafts"]);
  generation.attachments = coachAttachmentsFrom(body["attachments"]);
  generation.revision = body.get("revision", Json::UInt64(0)).asUInt64();
  generation.stopRequested = body.get("stopRequested", false).asBool();
  generation.allowanceRefusal = aiAllowanceFromJson(body["allowanceRefusal"]);
  return generation;
}

Json::Value toJson(const AskThread& thread) {
  Json::Value body(Json::objectValue);
  body["id"] = thread.id.str();
  body["title"] = thread.title;
  body["createdAt"] = Json::Value::UInt64(thread.createdAtMs);
  body["askedAt"] = Json::Value::UInt64(thread.askedAtMs);
  body["outcome"] = toJson(outcomeOf(thread));
  if (!thread.answerPreview.empty()) body["answerPreview"] = thread.answerPreview;
  if (thread.generation) body["generation"] = toJson(*thread.generation);
  if (!thread.nextCursor.empty()) body["nextCursor"] = thread.nextCursor;
  Json::Value proposals(Json::arrayValue);
  for (const ThreadProposal& minted : thread.minted) {
    Json::Value line(Json::objectValue);
    line["id"] = minted.id.str();
    line["state"] = toString(minted.state);
    line["changeCount"] = minted.changes;
    line["routineId"] = minted.routine.str();
    line["routine"] = minted.routineName;
    line["createdAt"] = Json::Value::UInt64(minted.createdAtMs);
    proposals.append(line);
  }
  body["proposals"] = proposals;
  if (!thread.turns.empty()) {
    Json::Value turns(Json::arrayValue);
    for (const ThreadTurn& said : thread.turns) {
      Json::Value turn(Json::objectValue);
      turn["from"] = said.fromLifter ? "lifter" : "ask";
      turn["text"] = said.text;
      turn["at"] = Json::Value::UInt64(said.atMs);
      if (said.position) turn["position"] = Json::UInt64(said.position);
      if (!said.generationId.empty()) {
        turn["generationId"] = said.generationId;
        turn["requestId"] = said.requestId;
        turn["status"] = said.status;
      }
      if (said.purpose != "conversation") turn["purpose"] = said.purpose;
      if (said.clarification) turn["clarification"] = toJson(*said.clarification);
      if (!said.routineDrafts.empty()) turn["routineDrafts"] = toJson(said.routineDrafts);
      if (said.allowanceRefusal) turn["allowanceRefusal"] = toJson(*said.allowanceRefusal);
      if (!said.results.empty()) turn["results"] = toJson(said.results);
      if (!said.attachments.empty()) {
        turn["attachments"] = Json::Value(Json::arrayValue);
        for (const auto& attachment : said.attachments) turn["attachments"].append(toJson(attachment));
      }
      if (!said.fromLifter && said.receipt) turn["receipt"] = toJson(*said.receipt);
      turns.append(turn);
    }
    body["turns"] = turns;
  }
  return body;
}

Json::Value toJson(const std::vector<AskThread>& threads) {
  Json::Value array(Json::arrayValue);
  for (const AskThread& thread : threads) array.append(toJson(thread));
  Json::Value body(Json::objectValue);
  body["threads"] = array;
  return body;
}

Json::Value toJson(const std::vector<ProposalHead>& heads) {
  Json::Value array(Json::arrayValue);
  for (const ProposalHead& head : heads) array.append(toJson(head));
  return array;
}

// Newest first, the creation row last. `by` is omitted where the lifter created it themselves.
Json::Value toJson(const std::vector<RoutineEvent>& history) {
  Json::Value array(Json::arrayValue);
  for (const RoutineEvent& event : history) {
    Json::Value line(Json::objectValue);
    line["kind"] = event.kind == RoutineEventKind::created ? "created" : "proposal";
    line["at"] = Json::Value::UInt64(event.atMs);
    if (event.door) line["by"] = toString(*event.door);
    // The count is the document as created, absent where the ledger did not record it.
    if (event.movements) line["movements"] = *event.movements;
    if (event.proposal) line["proposal"] = toJson(*event.proposal);
    array.append(line);
  }
  return array;
}

namespace {
Json::Value targetsJson(const EntryTargets& targets) {
  Json::Value body(Json::objectValue);
  // Absences carry through the diff: no scheme is the open line, no rest falls back to the global
  // target.
  if (!targets.sets.empty()) body["sets"] = toJson(targets.sets);
  if (targets.restSeconds) body["restSeconds"] = *targets.restSeconds;
  return body;
}

std::string changeKindText(ChangeKind kind) {
  if (kind == ChangeKind::added) return "added";
  if (kind == ChangeKind::removed) return "removed";
  if (kind == ChangeKind::retargeted) return "retargeted";
  return "kept";
}

Json::Value changeJson(const RoutineChange& change) {
  Json::Value line(Json::objectValue);
  line["position"] = change.position;
  line["kind"] = changeKindText(change.kind);
  line["exerciseId"] = change.exercise.str();
  if (change.before) line["before"] = targetsJson(*change.before);
  if (change.after) line["after"] = targetsJson(*change.after);
  return line;
}

// A stored side of a diff, clamped as planFrom clamps an entry.
std::optional<EntryTargets> targetsFrom(const Json::Value& stored) {
  if (!stored.isObject()) return std::nullopt;
  std::optional<int> restSeconds;
  if (stored["restSeconds"].isInt()) restSeconds = stored["restSeconds"].asInt();
  return EntryTargets{setTargetsFrom(stored["sets"]), restSeconds};
}
}

Json::Value toJson(const RoutineProposal& proposal) {
  Json::Value body = toJson(proposal.head);
  body["baseRevision"] = proposal.baseRevision;
  body["baseName"] = proposal.baseName;
  body["name"] = proposal.proposedName;
  Json::Value changes(Json::arrayValue);
  for (const RoutineChange& change : proposal.changes) {
    Json::Value line = changeJson(change);
    // On a removed row alone; zero means planned and never trained.
    if (change.kind == ChangeKind::removed) line["loggedSets"] = change.loggedSets;
    changes.append(line);
  }
  body["changes"] = changes;
  return body;
}

Json::Value toJson(const WorkoutProposal& proposal) {
  Json::Value body(Json::objectValue);
  body["id"] = proposal.id.str();
  body["sessionId"] = proposal.session.str();
  body["state"] = toString(proposal.state);
  body["summary"] = proposal.summary;
  body["changeCount"] = proposal.changeCount;
  if (proposal.settledAtMs) body["settledAt"] = Json::Value::UInt64(*proposal.settledAtMs);
  body["source"] = sourceJson(proposal.source);
  body["baseRevision"] = proposal.baseRevision;
  body["changes"] = Json::Value(Json::arrayValue);
  for (const RoutineChange& change : proposal.changes) body["changes"].append(changeJson(change));
  return body;
}

WorkoutProposal workoutProposalFrom(const Json::Value& record) {
  std::vector<RoutineChange> changes;
  for (const Json::Value& line : record["changes"]) {
    const std::string kind = line["kind"].asString();
    changes.push_back(RoutineChange{static_cast<int>(changes.size()) + 1,
                                    kind == "added" ? ChangeKind::added : kind == "removed" ? ChangeKind::removed
                                        : kind == "retargeted" ? ChangeKind::retargeted : ChangeKind::kept,
                                    ExerciseId{line["exerciseId"].asString()}, targetsFrom(line["before"]), targetsFrom(line["after"]), 0});
  }
  const std::optional<ThreadId> thread = record["threadId"].isString() ? std::optional(ThreadId{record["threadId"].asString()}) : std::nullopt;
  const std::optional<std::uint64_t> settled = record["settledAt"].isUInt64() ? std::optional(record["settledAt"].asUInt64()) : std::nullopt;
  return WorkoutProposal{Stored{}, ProposalId{record["id"].asString()}, SessionId{record["sessionId"].asString()},
                         proposalStateFromStored(record.get("state", "pending").asString()),
                         ProposalSource{proposalDoorFromStored(record["door"].asString()), record["connection"].asString(),
                                        record["agent"].asString(), thread},
                         record["summary"].asString(), record["baseRevision"].asInt(), record["changeCount"].asInt(),
                         std::move(changes), settled};
}

// Each set's absences stay absent: no `reps` is `max`, no `weightKg` is last time's set.
Json::Value toJson(const std::vector<SetTarget>& sets) {
  Json::Value array(Json::arrayValue);
  for (const SetTarget& set : sets) {
    Json::Value line(Json::objectValue);
    if (set.reps) line["reps"] = *set.reps;
    if (set.weightKg) line["weightKg"] = *set.weightKg;
    array.append(line);
  }
  return array;
}

Json::Value toJson(const PlanSnapshot& plan) {
  Json::Value body(Json::objectValue);
  body["routine"] = plan.routineName;
  Json::Value entries(Json::arrayValue);
  for (const PlanEntry& entry : plan.entries) {
    Json::Value line(Json::objectValue);
    line["exerciseId"] = entry.exercise.str();
    if (!entry.sets.empty()) line["sets"] = toJson(entry.sets);
    if (entry.restSeconds) line["restSeconds"] = *entry.restSeconds;
    entries.append(line);
  }
  body["entries"] = entries;
  return body;
}

// `planned` carries the scheme only — an open line is `{}`; `routine` is dropped when the session it
// stands against holds no name.
Json::Value toJson(const Review& review) {
  Json::Value stats(Json::objectValue);
  stats["durationMs"] = Json::Value::UInt64(review.stats.durationMs);
  stats["workingSets"] = review.stats.workingSets;
  stats["topE1rm"] = review.stats.topE1rm ? Json::Value(Estimate::stated(*review.stats.topE1rm)) : Json::Value();
  Json::Value body(Json::objectValue);
  body["stats"] = stats;
  body["slight"] = review.slight;
  if (review.record) {
    Json::Value record(Json::objectValue);
    record["kind"] = toString(review.record->kind);
    record["exerciseId"] = review.record->exercise.str();
    const bool estimate = review.record->kind == RecordKind::e1rm;
    record["value"] = estimate ? Estimate::stated(review.record->value) : review.record->value;
    record["weightKg"] = review.record->weightKg;
    record["reps"] = review.record->reps;
    record["previous"] = estimate ? Estimate::stated(review.record->previous) : review.record->previous;
    record["previousAt"] = Json::Value::UInt64(review.record->previousAtMs);
    body["record"] = record;
  }
  if (!review.against) return body;

  Json::Value movements(Json::arrayValue);
  for (const AgainstMovement& movement : review.against->movements) {
    Json::Value line(Json::objectValue);
    line["exerciseId"] = movement.exercise.str();
    line["now"] = topSetJson(movement.now);
    if (movement.before) line["before"] = topSetJson(*movement.before);
    if (movement.planned) {
      Json::Value planned(Json::objectValue);
      if (!movement.planned->sets.empty()) planned["sets"] = toJson(movement.planned->sets);
      line["planned"] = planned;
    }
    movements.append(line);
  }
  Json::Value against(Json::objectValue);
  against["sessionId"] = review.against->session.str();
  if (!review.against->routineName.empty()) against["routine"] = review.against->routineName;
  against["startedAt"] = Json::Value::UInt64(review.against->startedAtMs);
  against["movements"] = movements;
  body["against"] = against;
  return body;
}

// The server's tally of the rows it handed over, deduped by id.
Json::Value toJson(const ReadTally& tally) {
  Json::Value out(Json::objectValue);
  out["sets"] = tally.sets;
  out["sessions"] = tally.sessions;
  out["weeks"] = tally.weeks;
  return out;
}

Json::Value toJson(const std::vector<AskStep>& steps) {
  Json::Value out(Json::arrayValue);
  for (const AskStep& step : steps) {
    Json::Value line(Json::objectValue);
    line["tool"] = step.tool;
    line["failed"] = step.failed;
    out.append(line);
  }
  return out;
}

Json::Value toJson(const AnswerReceipt& receipt) {
  Json::Value out(Json::objectValue);
  out["version"] = receipt.version;
  out["read"] = toJson(receipt.read);
  out["steps"] = toJson(receipt.steps);
  out["proposals"] = Json::Value(Json::arrayValue);
  for (const std::string& id : receipt.proposals) out["proposals"].append(id);
  out["observations"] = Json::Value(Json::arrayValue);
  for (const SessionObservation& fact : receipt.observations) {
    Json::Value line(Json::objectValue);
    line["tool"] = fact.tool;
    line["sessionId"] = fact.sessionId.str();
    line["startedAt"] = Json::Value::UInt64(fact.startedAtMs);
    if (fact.finishedAtMs) line["finishedAt"] = Json::Value::UInt64(*fact.finishedAtMs);
    if (fact.routine) line["routine"] = *fact.routine;
    switch (fact.coverage) {
      case ReadCoverage::summary: line["coverage"] = "summary"; break;
      case ReadCoverage::session: line["coverage"] = "session"; break;
      case ReadCoverage::movement: line["coverage"] = "movement"; break;
    }
    if (fact.exerciseId) line["exerciseId"] = fact.exerciseId->str();
    line["setsRead"] = fact.setsRead;
    if (fact.workout) {
      line["workout"]["workingSetCount"] = fact.workout->workingSetCount;
      line["workout"]["tonnageKg"] = fact.workout->tonnageKg ? Json::Value(*fact.workout->tonnageKg) : Json::Value();
      if (fact.workout->durationMs)
        line["workout"]["durationMs"] = Json::Value::UInt64(*fact.workout->durationMs);
    }
    out["observations"].append(line);
  }
  return out;
}

std::optional<AnswerReceipt> receiptFrom(const Json::Value& stored) {
  if (!stored.isObject() || !stored["version"].isInt() ||
      !stored["read"].isObject() || !stored["steps"].isArray() ||
      !stored["proposals"].isArray() || !stored["observations"].isArray()) return std::nullopt;
  AnswerReceipt receipt;
  receipt.version = stored["version"].asInt();
  for (const char* key : {"sets", "sessions", "weeks"})
    if (!stored["read"][key].isInt()) return std::nullopt;
  receipt.read = ReadTally{stored["read"]["sets"].asInt(), stored["read"]["sessions"].asInt(),
                           stored["read"]["weeks"].asInt()};
  for (const Json::Value& step : stored["steps"]) {
    if (!step.isObject() || !step["tool"].isString() || !step["failed"].isBool()) return std::nullopt;
    receipt.steps.push_back(AskStep{step["tool"].asString(), step["failed"].asBool()});
  }
  for (const Json::Value& proposal : stored["proposals"]) {
    if (!proposal.isString()) return std::nullopt;
    receipt.proposals.push_back(proposal.asString());
  }
  for (const Json::Value& line : stored["observations"]) {
    if (!line.isObject() || !line["tool"].isString() || !line["sessionId"].isString() ||
        !line["startedAt"].isUInt64() || !line["coverage"].isString() ||
        !line["setsRead"].isInt()) return std::nullopt;
    SessionObservation fact;
    fact.tool = line["tool"].asString();
    fact.sessionId = SessionId{line["sessionId"].asString()};
    fact.startedAtMs = line["startedAt"].asUInt64();
    fact.setsRead = line["setsRead"].asInt();
    if (!line["finishedAt"].isNull()) {
      if (!line["finishedAt"].isUInt64()) return std::nullopt;
      fact.finishedAtMs = line["finishedAt"].asUInt64();
    }
    if (!line["routine"].isNull()) {
      if (!line["routine"].isString()) return std::nullopt;
      fact.routine = line["routine"].asString();
    }
    if (line["coverage"].asString() == "summary") fact.coverage = ReadCoverage::summary;
    else if (line["coverage"].asString() == "session") fact.coverage = ReadCoverage::session;
    else if (line["coverage"].asString() == "movement") fact.coverage = ReadCoverage::movement;
    else return std::nullopt;
    if (!line["exerciseId"].isNull()) {
      if (!line["exerciseId"].isString()) return std::nullopt;
      fact.exerciseId = ExerciseId{line["exerciseId"].asString()};
    }
    if (!line["workout"].isNull()) {
      const Json::Value& workout = line["workout"];
      if (!workout.isObject() || !workout["workingSetCount"].isInt() || !workout.isMember("tonnageKg") ||
          (!workout["tonnageKg"].isNumeric() && !workout["tonnageKg"].isNull())) return std::nullopt;
      WorkoutObservation total;
      total.workingSetCount = workout["workingSetCount"].asInt();
      total.tonnageKg = workout["tonnageKg"].isNull() ? std::nullopt : std::optional(workout["tonnageKg"].asDouble());
      if (!workout["durationMs"].isNull()) {
        if (!workout["durationMs"].isUInt64()) return std::nullopt;
        total.durationMs = workout["durationMs"].asUInt64();
      }
      fact.workout = total;
    }
    receipt.observations.push_back(std::move(fact));
  }
  if (!receipt.valid()) return std::nullopt;
  return receipt;
}

// No `e1rm` on a point or a best means that set earned no estimate; an absent `bestE1rm` means
// no set of that movement ever earned one. `weeks` is contiguous: a week with no training is zero.
Json::Value toJson(const Statistics& statistics) {
  Json::Value weeks(Json::arrayValue);
  for (const TrainingWeek& week : statistics.weeks) {
    Json::Value line(Json::objectValue);
    line["startedAt"] = Json::Value::UInt64(week.startedAtMs);
    line["sessions"] = week.sessions;
    line["workingSets"] = week.workingSets;
    weeks.append(line);
  }

  Json::Value movements(Json::arrayValue);
  for (const MovementProgress& movement : statistics.movements) {
    Json::Value points(Json::arrayValue);
    for (const MovementPoint& point : movement.points) {
      Json::Value line(Json::objectValue);
      line["at"] = Json::Value::UInt64(point.atMs);
      line["weightKg"] = point.weightKg;
      line["reps"] = point.reps;
      if (point.e1rm) line["e1rm"] = Estimate::stated(*point.e1rm);
      points.append(line);
    }
    Json::Value line(Json::objectValue);
    line["exerciseId"] = movement.exercise.str();
    line["lastTrainedAt"] = Json::Value::UInt64(movement.lastTrainedAtMs);
    line["points"] = points;
    if (movement.bestE1rm) line["bestE1rm"] = bestJson(*movement.bestE1rm);
    if (movement.heaviest) line["heaviest"] = bestJson(*movement.heaviest);
    movements.append(line);
  }

  Json::Value body(Json::objectValue);
  body["weeks"] = weeks;
  body["movements"] = movements;
  return body;
}

Json::Value toJson(const StatsProgress& progress) {
  const auto performedJson = [](const PerformedFact& fact) {
    Json::Value body(Json::objectValue);
    body["setId"] = fact.set.str();
    body["weightKg"] = fact.weightKg;
    body["reps"] = fact.reps;
    if (fact.rpe) body["rpe"] = *fact.rpe;
    return body;
  };
  Json::Value sessions(Json::arrayValue);
  for (const ProgressSession& session : progress.sessions) {
    Json::Value movements(Json::arrayValue);
    for (const MovementSessionFact& fact : session.movements) {
      Json::Value movement(Json::objectValue);
      movement["exerciseId"] = fact.exercise.str();
      movement["workingSetCount"] = fact.workingSetCount;
      movement["heaviest"] = performedJson(fact.heaviest);
      if (fact.mostReps) movement["mostReps"] = performedJson(*fact.mostReps);
      if (fact.estimate) {
        movement["estimate"] = performedJson(fact.estimate->performed);
        movement["estimate"]["e1rm"] = fact.estimate->estimate.e1rm ? Json::Value(*fact.estimate->estimate.e1rm) : Json::Value(Json::nullValue);
      }
      if (!fact.estimatesComplete) movement["estimatesComplete"] = false;
      movements.append(movement);
    }
    Json::Value row(Json::objectValue);
    row["sessionId"] = session.session.str();
    row["startedAt"] = Json::Value::UInt64(session.startedAtMs);
    row["movements"] = movements;
    sessions.append(row);
  }
  Json::Value body(Json::objectValue);
  body["asOf"] = Json::Value::UInt64(progress.asOfMs);
  body["sessions"] = sessions;
  return body;
}

// Every list is omitted when empty rather than sent as `[]`; the two counts are always present. A
// movement none of whose sets earned an estimate carries no `bestE1rm` and no series, but still carries its
// heaviest and its sets.
Json::Value toJson(const MovementRecord& record) {
  Json::Value body(Json::objectValue);
  body["exercise"] = toJson(record.exercise);
  body["routineCount"] = static_cast<int>(record.routines.size());
  if (!record.routines.empty()) {
    Json::Value routines(Json::arrayValue);
    for (const std::string& routine : record.routines) routines.append(routine);
    body["routines"] = routines;
  }
  body["sessionCount"] = record.sessions;
  if (record.bestE1rm) body["bestE1rm"] = bestJson(*record.bestE1rm);
  if (record.heaviest) body["heaviest"] = bestJson(*record.heaviest);
  if (!record.series.empty()) {
    Json::Value series(Json::arrayValue);
    for (const RecordPoint& point : record.series) series.append(pointJson(point));
    body["e1rmSeries"] = series;
  }
  if (!record.records.empty()) {
    Json::Value records(Json::arrayValue);
    for (const RecordPoint& point : record.records) records.append(pointJson(point));
    body["records"] = records;
  }
  if (record.recent.empty()) return body;
  Json::Value days(Json::arrayValue);
  for (const MovementDay& day : record.recent) {
    Json::Value line(Json::objectValue);
    line["sessionId"] = day.session.str();
    line["startedAt"] = Json::Value::UInt64(day.startedAtMs);
    line["sets"] = toJson(day.sets);
    days.append(line);
  }
  body["recentDays"] = days;
  return body;
}

// No id in this object at any depth; the movement travels as its display name.
Json::Value toJson(const SharedSession& shared) {
  Json::Value sets(Json::arrayValue);
  for (const SharedSet& set : shared.sets) {
    Json::Value line(Json::objectValue);
    line["exercise"] = set.exercise;
    line["setNumber"] = set.setNumber;
    line["weightKg"] = set.weightKg;
    line["reps"] = set.reps;
    if (set.rpe) line["rpe"] = *set.rpe;
    line["note"] = set.note;
    line["completedAt"] = Json::Value::UInt64(set.completedAtMs);
    sets.append(line);
  }
  Json::Value body(Json::objectValue);
  body["startedAt"] = Json::Value::UInt64(shared.startedAtMs);
  if (shared.finishedAtMs) body["finishedAt"] = Json::Value::UInt64(*shared.finishedAtMs);
  if (!shared.routineName.empty()) body["routine"] = shared.routineName;
  body["sets"] = sets;
  return body;
}

// Clamps instead of throwing: an unreadable stored blob must still leave the session readable. A
// non-object is no plan; a name that is not a string is no name, as the prefill's SQL decides it. A
// `sets` that is not an array is a defect in stored data and drops the line; a set inside it that
// cannot be read opens the line instead (setTargetsFrom), so the movement is never lost.
std::optional<PlanSnapshot> planFrom(const Json::Value& stored) {
  if (!stored.isObject()) return std::nullopt;
  PlanSnapshot plan;
  if (stored["routine"].isString()) plan.routineName = stored["routine"].asString();
  for (const Json::Value& entry : stored["entries"]) {
    if (!entry.isObject() || !entry["exerciseId"].isString()) continue;
    // `sets` may be absent: the open line. A `sets` that is not an array drops the line.
    if (entry.isMember("sets") && !entry["sets"].isArray()) continue;
    std::optional<int> restSeconds;
    if (entry["restSeconds"].isInt()) restSeconds = entry["restSeconds"].asInt();
    plan.entries.push_back(PlanEntry{ExerciseId{entry["exerciseId"].asString()},
                                     setTargetsFrom(entry["sets"]), restSeconds});
  }
  return plan;
}

// The whole scheme or none: one set that cannot be read — not an object, a wrong-typed value, or a
// value outside the band the entity keeps today — answers the open line rather than a ladder short
// by one, which would move every set after it up a slot.
std::vector<SetTarget> setTargetsFrom(const Json::Value& stored) {
  std::vector<SetTarget> sets;
  if (!stored.isArray()) return sets;
  for (const Json::Value& set : stored) {
    if (!set.isObject()) return {};
    std::optional<int> reps;
    if (!set["reps"].isNull()) {
      if (!set["reps"].isInt()) return {};
      reps = set["reps"].asInt();
    }
    std::optional<double> weightKg;
    if (!set["weightKg"].isNull()) {
      if (!set["weightKg"].isNumeric()) return {};
      weightKg = set["weightKg"].asDouble();
    }
    try {
      sets.push_back(SetTarget{reps, weightKg});
    } catch (const InvalidTraining&) {
      return {};
    }
  }
  return sets;
}

// The title and the body are the whole write; the id and the owner are the caller's. Anything else on
// the body is ignored, and a missing or non-string half is the one sentence every unreadable note gets.
Note parseNoteWrite(const Json::Value& body, const NoteId& id, const UserId& user) {
  if (!body.isObject() || !body["title"].isString() || !body["body"].isString())
    throw InvalidTraining("could not read that note");
  return Note{id, user, body["title"].asString(), body["body"].asString()};
}

Json::Value toJson(const Note& note) {
  Json::Value body(Json::objectValue);
  body["id"] = note.id.str();
  body["position"] = note.position;
  body["title"] = note.title;
  body["body"] = note.body;
  body["updatedAt"] = Json::Value::UInt64(note.updatedAtMs);
  return body;
}

Json::Value toJson(const std::vector<Note>& notes) {
  Json::Value out(Json::arrayValue);
  for (const Note& note : notes) out.append(toJson(note));
  return out;
}

Json::Value toJson(const Bodyweight& entry) {
  Json::Value body(Json::objectValue);
  body["dateLocal"] = entry.dateLocal;
  body["weightKg"] = entry.weightKg;
  body["recordedAt"] = Json::Value::UInt64(entry.recordedAtMs);
  return body;
}

Json::Value toJson(const std::vector<Bodyweight>& entries) {
  Json::Value out(Json::arrayValue);
  for (const Bodyweight& entry : entries) out.append(toJson(entry));
  return out;
}

std::string shareUrl(const std::string& appBaseUrl, const std::string& token) {
  return appBaseUrl + "/#/gym/shared/" + token;
}

// Takes the app's base url — where the browser app is served — not the API's.
std::string proposalUrl(const std::string& appBaseUrl, const ProposalId& id) {
  return appBaseUrl + "/#/gym/proposals/" + id.str();
}

}
