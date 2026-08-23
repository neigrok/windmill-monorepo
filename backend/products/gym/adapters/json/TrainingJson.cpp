#include "products/gym/adapters/json/TrainingJson.h"

#include <string>
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
  if (best.e1rm) body["e1rm"] = *best.e1rm;
  return body;
}

// `e1rm` is never optional here: a point with no honest estimate is in neither list.
Json::Value pointJson(const RecordPoint& point) {
  Json::Value body(Json::objectValue);
  body["at"] = Json::Value::UInt64(point.atMs);
  body["weightKg"] = point.weightKg;
  body["reps"] = point.reps;
  body["e1rm"] = point.e1rm;
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
                 body["weightKg"].asDouble(), body["reps"].asInt(), SetKind::working,
                 std::nullopt, "", instantOf(body, "completedAt")};
  // Omitted or null means the default; a present kind parses strictly.
  if (body.isMember("kind") && !body["kind"].isNull()) {
    if (!body["kind"].isString()) throw InvalidTraining("kind must be a string");
    write.kind = parseSetKind(body["kind"].asString());
  }
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

// Every field is optional and checked for presence alone, so a `null` weight is a type error;
// `"rpe": null` is the exception and removes one.
SetFix parseSetFix(const Json::Value& body) {
  if (!body.isObject()) throw InvalidTraining("a fix must be a json object");
  for (const std::string& field : body.getMemberNames()) {
    if (field == "weightKg" || field == "reps" || field == "kind" || field == "rpe" ||
        field == "note")
      continue;
    throw InvalidTraining("unknown fix field \"" + field +
                          "\". A fix takes: weightKg, reps, kind, rpe, note. A set's movement, its "
                          "instant and its number are not a correction.");
  }
  SetFix fix;
  if (body.isMember("weightKg")) {
    if (!body["weightKg"].isNumeric()) throw InvalidTraining("weightKg must be a number");
    fix.weightKg = body["weightKg"].asDouble();
  }
  if (body.isMember("reps")) {
    if (!body["reps"].isInt()) throw InvalidTraining("reps must be a whole number");
    fix.reps = body["reps"].asInt();
  }
  if (body.isMember("kind")) {
    if (!body["kind"].isString()) throw InvalidTraining("kind must be a string");
    fix.kind = parseSetKind(body["kind"].asString());
  }
  if (body.isMember("note")) {
    if (!body["note"].isString()) throw InvalidTraining("note must be a string");
    fix.note = body["note"].asString();
  }
  if (body.isMember("rpe")) {
    fix.rpeNamed = true;
    if (!body["rpe"].isNull()) {
      if (!body["rpe"].isNumeric()) throw InvalidTraining("rpe must be a number");
      fix.rpe = body["rpe"].asDouble();
    }
  }
  return fix;
}

std::uint64_t parseFinish(const Json::Value& body) {
  if (!body.isObject()) throw InvalidTraining("a finish must be a json object");
  return instantOf(body, "finishedAt");
}

namespace {
// Shared by the lifter's routine write and an agent's proposal.
std::vector<RoutineEntry> entriesFrom(const Json::Value& body) {
  if (!body["entries"].isArray()) throw InvalidTraining("entries must be an array");
  std::vector<RoutineEntry> entries;
  for (const Json::Value& entry : body["entries"]) {
    if (!entry.isObject()) throw InvalidTraining("a routine entry must be a json object");
    // An unknown field name is refused rather than ignored. `position` is accepted and ignored:
    // lines are renumbered 1..n in arrival order.
    for (const std::string& field : entry.getMemberNames()) {
      if (field == "exerciseId" || field == "targetSets" || field == "targetReps" ||
          field == "targetWeightKg" || field == "restSeconds" || field == "position")
        continue;
      throw InvalidTraining("unknown routine entry field \"" + field +
                            "\". An entry takes: exerciseId, targetSets, targetReps, "
                            "targetWeightKg, restSeconds.");
    }
    if (!entry["exerciseId"].isString()) throw InvalidTraining("exerciseId must be a string");
    // All four optionals mean something by their absence: never fill one in with a zero.
    std::optional<int> targetSets;
    if (entry.isMember("targetSets") && !entry["targetSets"].isNull()) {
      if (!entry["targetSets"].isInt()) throw InvalidTraining("targetSets must be a whole number");
      targetSets = entry["targetSets"].asInt();
    }
    std::optional<int> targetReps;
    if (entry.isMember("targetReps") && !entry["targetReps"].isNull()) {
      if (!entry["targetReps"].isInt()) throw InvalidTraining("targetReps must be a whole number");
      targetReps = entry["targetReps"].asInt();
    }
    std::optional<double> targetWeightKg;
    if (entry.isMember("targetWeightKg") && !entry["targetWeightKg"].isNull()) {
      if (!entry["targetWeightKg"].isNumeric())
        throw InvalidTraining("targetWeightKg must be a number");
      targetWeightKg = entry["targetWeightKg"].asDouble();
    }
    std::optional<int> restSeconds;
    if (entry.isMember("restSeconds") && !entry["restSeconds"].isNull()) {
      if (!entry["restSeconds"].isInt()) throw InvalidTraining("restSeconds must be a whole number");
      restSeconds = entry["restSeconds"].asInt();
    }
    // The entity refuses anything but 1..n.
    entries.push_back(RoutineEntry{static_cast<int>(entries.size()) + 1,
                                   ExerciseId{entry["exerciseId"].asString()}, targetSets,
                                   targetReps, targetWeightKg, restSeconds});
  }
  return entries;
}
}

RoutineWrite parseRoutineWrite(const Json::Value& body) {
  if (!body.isObject()) throw InvalidTraining("a routine must be a json object");
  if (!body["id"].isString()) throw InvalidTraining("id must be a string");
  if (!body["name"].isString()) throw InvalidTraining("name must be a string");
  if (!body["position"].isInt()) throw InvalidTraining("position must be a whole number");
  // A writer that names the revision it read asks not to overwrite a routine that moved since; one
  // that says nothing lands regardless.
  std::optional<int> expectedRevision;
  if (body.isMember("revision") && !body["revision"].isNull()) {
    if (!body["revision"].isInt()) throw InvalidTraining("revision must be a whole number");
    expectedRevision = body["revision"].asInt();
  }
  return RoutineWrite{RoutineId{body["id"].asString()}, body["name"].asString(),
                      body["position"].asInt(), entriesFrom(body), expectedRevision};
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

std::string parseExerciseRename(const Json::Value& body) {
  if (!body.isObject()) throw InvalidTraining("a rename must be a json object");
  // Only the name is renamable: a body naming `pattern` or `stepKg` is refused.
  for (const std::string& field : body.getMemberNames())
    if (field != "name")
      throw InvalidTraining("unknown rename field \"" + field + "\". A rename takes: name.");
  if (!body["name"].isString()) throw InvalidTraining("name must be a string");
  return body["name"].asString();
}

GymPreferences parsePreferences(const Json::Value& body, const UserId& user) {
  if (!body.isObject())
    throw InvalidPreference("preferences-unreadable", "settings must be a json object");
  // Strict about field names: an omission is a default, so a misspelled `restSecond` would silently
  // turn the timer off.
  for (const std::string& field : body.getMemberNames()) {
    if (field == "units" || field == "restSeconds" || field == "restSound" ||
        field == "confirmHaptic" || field == "confirmSound")
      continue;
    throw InvalidPreference("preferences-unreadable",
                            "unknown settings field \"" + field +
                                "\". Settings take: units, restSeconds, restSound, confirmHaptic, "
                                "confirmSound.");
  }

  const GymPreferences fallback{user};
  Unit units = fallback.units;
  if (body.isMember("units") && !body["units"].isNull()) {
    if (!body["units"].isString())
      throw InvalidPreference("unknown-unit", "units are \"kg\" or \"lb\"");
    units = parseUnit(body["units"].asString());
  }
  // Omitted and null both mean no timer.
  std::optional<int> restSeconds;
  if (body.isMember("restSeconds") && !body["restSeconds"].isNull()) {
    if (!body["restSeconds"].isInt())
      throw InvalidPreference("rest-target", "restSeconds must be a whole number of seconds");
    restSeconds = body["restSeconds"].asInt();
  }
  bool restSound = fallback.restSound;
  if (body.isMember("restSound") && !body["restSound"].isNull()) {
    if (!body["restSound"].isBool())
      throw InvalidPreference("preferences-unreadable", "restSound must be true or false");
    restSound = body["restSound"].asBool();
  }
  bool confirmHaptic = fallback.confirmHaptic;
  if (body.isMember("confirmHaptic") && !body["confirmHaptic"].isNull()) {
    if (!body["confirmHaptic"].isBool())
      throw InvalidPreference("preferences-unreadable", "confirmHaptic must be true or false");
    confirmHaptic = body["confirmHaptic"].asBool();
  }
  bool confirmSound = fallback.confirmSound;
  if (body.isMember("confirmSound") && !body["confirmSound"].isNull()) {
    if (!body["confirmSound"].isBool())
      throw InvalidPreference("preferences-unreadable", "confirmSound must be true or false");
    confirmSound = body["confirmSound"].asBool();
  }
  return GymPreferences{user, units, restSeconds, restSound, confirmHaptic, confirmSound};
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
  return body;
}

Json::Value toJson(const Set& set) {
  Json::Value body(Json::objectValue);
  body["id"] = set.id.str();
  body["exerciseId"] = set.exercise.str();
  body["setNumber"] = set.setNumber;
  body["weightKg"] = set.weightKg;
  body["reps"] = set.reps;
  body["kind"] = toString(set.kind);
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

// tonnageKg is always present and zero is a real answer. topSet is omitted for a session with no
// working set; topE1rm with it, and also where the heaviest working set was unloaded (Epley is
// undefined at and below zero).
Json::Value toJson(const LogRow& row) {
  Json::Value body = toJson(row.summary.session);
  body["setCount"] = row.summary.setCount;
  body["workingSetCount"] = row.summary.workingSetCount;
  body["tonnageKg"] = row.summary.tonnageKg;
  Json::Value names(Json::arrayValue);
  for (const std::string& name : row.summary.exerciseNames) names.append(name);
  body["exercises"] = names;
  if (row.summary.topSet) {
    Json::Value top(Json::objectValue);
    top["weightKg"] = row.summary.topSet->weightKg;
    top["reps"] = row.summary.topSet->reps;
    body["topSet"] = top;
  }
  if (row.topE1rm) body["topE1rm"] = *row.topE1rm;
  body["record"] = row.record;
  body["closedItself"] = row.summary.closedItself;
  return body;
}

Json::Value toJson(const Exercise& exercise) {
  Json::Value body(Json::objectValue);
  body["id"] = exercise.id.str();
  body["name"] = exercise.name;
  body["pattern"] = toString(exercise.pattern);
  body["equipment"] = toString(exercise.equipment);
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

Json::Value toJson(const Routine& routine) {
  Json::Value body(Json::objectValue);
  body["id"] = routine.id.str();
  body["name"] = routine.name;
  body["position"] = routine.position;
  body["revision"] = routine.revision;
  if (routine.lastTrainedAtMs) body["lastTrainedAt"] = Json::Value::UInt64(*routine.lastTrainedAtMs);
  Json::Value entries(Json::arrayValue);
  for (const RoutineEntry& entry : routine.entries) {
    Json::Value line(Json::objectValue);
    line["position"] = entry.position;
    line["exerciseId"] = entry.exercise.str();
    if (entry.targetSets) line["targetSets"] = *entry.targetSets;
    if (entry.targetReps) line["targetReps"] = *entry.targetReps;
    if (entry.targetWeightKg) line["targetWeightKg"] = *entry.targetWeightKg;
    if (entry.restSeconds) line["restSeconds"] = *entry.restSeconds;
    entries.append(line);
  }
  body["entries"] = entries;
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
  Json::Value source(Json::objectValue);
  source["door"] = toString(head.source.door);
  if (!head.source.connection.empty()) source["connection"] = head.source.connection;
  if (!head.source.agent.empty()) source["agent"] = head.source.agent;
  if (head.source.thread) source["thread"] = head.source.thread->str();
  body["source"] = source;
  return body;
}

Json::Value toJson(const ThreadOutcome& outcome) {
  Json::Value body(Json::objectValue);
  body["kind"] = toString(outcome.kind);
  // Always present; zero means the thread proposed nothing.
  body["changes"] = outcome.changes;
  if (outcome.routine) {
    body["routineId"] = outcome.routine->str();
    body["routine"] = outcome.routineName;
  }
  return body;
}

Json::Value toJson(const AskThread& thread) {
  Json::Value body(Json::objectValue);
  body["id"] = thread.id.str();
  body["title"] = thread.title;
  body["createdAt"] = Json::Value::UInt64(thread.createdAtMs);
  body["askedAt"] = Json::Value::UInt64(thread.askedAtMs);
  body["outcome"] = toJson(outcomeOf(thread));
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
  // Absences carry through the diff: no sets is the open line, no reps is `max`, no weight is the
  // last one used, no rest falls back to the global target.
  if (targets.sets) body["sets"] = *targets.sets;
  if (targets.reps) body["reps"] = *targets.reps;
  if (targets.weightKg) body["weightKg"] = *targets.weightKg;
  if (targets.restSeconds) body["restSeconds"] = *targets.restSeconds;
  return body;
}

std::string changeKindText(ChangeKind kind) {
  if (kind == ChangeKind::added) return "added";
  if (kind == ChangeKind::removed) return "removed";
  if (kind == ChangeKind::retargeted) return "retargeted";
  return "kept";
}
}

Json::Value toJson(const RoutineProposal& proposal) {
  Json::Value body = toJson(proposal.head);
  body["baseRevision"] = proposal.baseRevision;
  body["baseName"] = proposal.baseName;
  body["name"] = proposal.proposedName;
  Json::Value changes(Json::arrayValue);
  for (const RoutineChange& change : proposal.changes) {
    Json::Value line(Json::objectValue);
    line["position"] = change.position;
    line["kind"] = changeKindText(change.kind);
    line["exerciseId"] = change.exercise.str();
    if (change.before) line["before"] = targetsJson(*change.before);
    if (change.after) line["after"] = targetsJson(*change.after);
    // On a removed row alone; zero means planned and never trained.
    if (change.kind == ChangeKind::removed) line["loggedSets"] = change.loggedSets;
    changes.append(line);
  }
  body["changes"] = changes;
  return body;
}

Json::Value toJson(const PlanSnapshot& plan) {
  Json::Value body(Json::objectValue);
  body["routine"] = plan.routineName;
  Json::Value entries(Json::arrayValue);
  for (const PlanEntry& entry : plan.entries) {
    Json::Value line(Json::objectValue);
    line["exerciseId"] = entry.exercise.str();
    if (entry.sets) line["sets"] = *entry.sets;
    if (entry.reps) line["reps"] = *entry.reps;
    if (entry.weightKg) line["weightKg"] = *entry.weightKg;
    if (entry.restSeconds) line["restSeconds"] = *entry.restSeconds;
    entries.append(line);
  }
  body["entries"] = entries;
  return body;
}

// `planned` carries the target only; `routine` is dropped when the session it stands against holds
// no name.
Json::Value toJson(const Review& review) {
  Json::Value stats(Json::objectValue);
  stats["durationMs"] = Json::Value::UInt64(review.stats.durationMs);
  stats["workingSets"] = review.stats.workingSets;
  if (review.stats.topE1rm) stats["topE1rm"] = *review.stats.topE1rm;
  Json::Value body(Json::objectValue);
  body["stats"] = stats;
  body["slight"] = review.slight;
  if (review.record) {
    Json::Value record(Json::objectValue);
    record["kind"] = toString(review.record->kind);
    record["exerciseId"] = review.record->exercise.str();
    record["value"] = review.record->value;
    record["weightKg"] = review.record->weightKg;
    record["reps"] = review.record->reps;
    record["previous"] = review.record->previous;
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
      if (movement.planned->sets) planned["sets"] = *movement.planned->sets;
      if (movement.planned->reps) planned["reps"] = *movement.planned->reps;
      if (movement.planned->weightKg) planned["weightKg"] = *movement.planned->weightKg;
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

// No `e1rm` on a point or a best means that load has no one-rep estimate; an absent `bestE1rm` means
// no set of that movement ever had one. `weeks` is contiguous: a week with no training is zero.
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
      if (point.e1rm) line["e1rm"] = *point.e1rm;
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

// Every list is omitted when empty rather than sent as `[]`; the two counts are always present. A
// movement whose every set was unloaded carries no `bestE1rm` and no series, since Epley is
// undefined at and below zero, but still carries its heaviest and its sets.
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
    line["kind"] = toString(set.kind);
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
// non-object is no plan; a name that is not a string is no name, as the prefill's SQL decides it.
std::optional<PlanSnapshot> planFrom(const Json::Value& stored) {
  if (!stored.isObject()) return std::nullopt;
  PlanSnapshot plan;
  if (stored["routine"].isString()) plan.routineName = stored["routine"].asString();
  for (const Json::Value& entry : stored["entries"]) {
    if (!entry.isObject() || !entry["exerciseId"].isString()) continue;
    // sets and reps may both be absent: the open line and `max`. A wrong-typed value drops the line.
    if (entry.isMember("sets") && !entry["sets"].isInt()) continue;
    std::optional<int> sets;
    if (entry["sets"].isInt()) sets = entry["sets"].asInt();
    std::optional<int> reps;
    if (entry["reps"].isInt()) reps = entry["reps"].asInt();
    std::optional<double> weightKg;
    if (entry["weightKg"].isNumeric()) weightKg = entry["weightKg"].asDouble();
    std::optional<int> restSeconds;
    if (entry["restSeconds"].isInt()) restSeconds = entry["restSeconds"].asInt();
    plan.entries.push_back(
        PlanEntry{ExerciseId{entry["exerciseId"].asString()}, sets, reps, weightKg, restSeconds});
  }
  return plan;
}


std::string shareUrl(const std::string& appBaseUrl, const std::string& token) {
  return appBaseUrl + "/#/gym/shared/" + token;
}

// Takes the app's base url — where the browser app is served — not the API's.
std::string proposalUrl(const std::string& appBaseUrl, const ProposalId& id) {
  return appBaseUrl + "/#/gym/proposals/" + id.str();
}

}
