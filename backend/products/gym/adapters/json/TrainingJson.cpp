#include "products/gym/adapters/json/TrainingJson.h"

#include <string>
#include <utility>
#include <vector>

namespace wm::gym {

namespace {
// One rule for all three instants. Zero is an unset device clock, not a moment; past the ceiling is
// a value the store cannot hold, refused here rather than left to overflow a timestamptz.
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

// `e1rm` is never optional here — a point with no honest estimate is not in either list at all.
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
  // Omitted or null means join. A PRESENT value parses strictly — a non-boolean is a 400, never a
  // guess at which of the two Starts the caller meant.
  if (body.isMember("joinOpenSession") && !body["joinOpenSession"].isNull()) {
    if (!body["joinOpenSession"].isBool())
      throw InvalidTraining("joinOpenSession must be a boolean");
    start.joinOpenSession = body["joinOpenSession"].asBool();
  }
  // Omitted is the ad-hoc session; present, the server loads that routine and freezes it — the
  // client sends the id and never the plan.
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
  // Omitted or null means the default; a PRESENT kind parses strictly, so an unknown word is a 400
  // rather than a silent downgrade.
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

// A fix names what it changes and nothing else: every field is optional and checked for PRESENCE
// alone, so a `null` weight is a type error rather than a silent no-op. `rpe` is the exception —
// the only value a set may not have at all, so `"rpe": null` removes one.
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
// The lines of a day of the program, read once for both writes that carry them: the lifter's own
// routine write and an agent's proposal.
std::vector<RoutineEntry> entriesFrom(const Json::Value& body) {
  if (!body["entries"].isArray()) throw InvalidTraining("entries must be an array");
  std::vector<RoutineEntry> entries;
  for (const Json::Value& entry : body["entries"]) {
    if (!entry.isObject()) throw InvalidTraining("a routine entry must be a json object");
    // `additionalProperties: false`, one level down into the line: an unknown name is refused
    // rather than ignored, so a misspelling cannot silently wipe the target it was aiming at.
    // `position` is ACCEPTED AND IGNORED — a routine travels as its whole document and what
    // list_routines hands back carries `position` on every line, but the run is renumbered 1..n
    // from the order these arrive in.
    for (const std::string& field : entry.getMemberNames()) {
      if (field == "exerciseId" || field == "targetSets" || field == "targetReps" ||
          field == "targetWeightKg" || field == "restSeconds" || field == "position")
        continue;
      throw InvalidTraining("unknown routine entry field \"" + field +
                            "\". An entry takes: exerciseId, targetSets, targetReps, "
                            "targetWeightKg, restSeconds.");
    }
    if (!entry["exerciseId"].isString()) throw InvalidTraining("exerciseId must be a string");
    // All FOUR optionals mean something by their absence — "you decide at the rack", "as many as
    // you can", "whatever you did last time" and "the client's own rest default" — so a present
    // value type-checks strictly and an absent one is never filled in with a zero.
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
    // The position is the order the lines arrived in; the entity refuses anything but 1..n.
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
  // Its presence is the whole meaning: a writer that names the revision it read is asking not to
  // overwrite a day that moved since; one that says nothing lands regardless.
  std::optional<int> expectedRevision;
  if (body.isMember("revision") && !body["revision"].isNull()) {
    if (!body["revision"].isInt()) throw InvalidTraining("revision must be a whole number");
    expectedRevision = body["revision"].asInt();
  }
  return RoutineWrite{RoutineId{body["id"].asString()}, body["name"].asString(),
                      body["position"].asInt(), entriesFrom(body), expectedRevision};
}

// A proposal names its own id, the routine it is about, and the document it would take on. An
// absent `name` is the routine keeping the one it has; an absent `summary` draws the diff alone.
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
  // A created movement's id is client-minted and obeys the one id-shape rule, which the Exercise
  // constructor cannot carry: the seeded slugs ('dip') are shorter than any minted id may be.
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
  // Strict about what it does NOT carry: only the name is renamable, so a body naming `pattern` or
  // `stepKg` is refused rather than answered 200 with neither changed.
  for (const std::string& field : body.getMemberNames())
    if (field != "name")
      throw InvalidTraining("unknown rename field \"" + field + "\". A rename takes: name.");
  if (!body["name"].isString()) throw InvalidTraining("name must be a string");
  return body["name"].asString();
}

GymPreferences parsePreferences(const Json::Value& body, const UserId& user) {
  if (!body.isObject())
    throw InvalidPreference("preferences-unreadable", "settings must be a json object");
  // Strict about names: an omission here is a default, so a misspelled `restSecond` read clean
  // would answer 200 having silently turned the timer off.
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
  // The one field where omitted and null say the same thing: no timer.
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
  // The frozen snapshot travels as the object it is, emitted from the typed value rather than
  // re-parsed out of storage.
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

// One row of the log: the session plus what the list says about it without loading its sets.
// setCount is every row the session holds, workingSetCount the number the screen prints.
// tonnageKg is always present and a zero is a real answer — the working sets moved no measurable
// load. Drawing that zero is a rendering rule: nothing where the tonnage would go, never `0.0 t`.
// topSet is omitted for a session holding no working set, and topE1rm with it and also where the
// heaviest working set was unloaded (Epley is undefined at and below zero). closedItself is always
// present.
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
  // Always present, like closedItself: a fact about every row rather than an optional.
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
  // What this account used to call it, newest first — OMITTED when there are none. The picker
  // matches them alongside the name.
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

// `at` is the SESSION's start, like every other instant this product hands a screen. The movement's
// NAME is not here: the caller drew this list from the catalog and joins on `exerciseId`.
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
  // The concurrency token, read-only on the wire: a client draws it and never sends it back.
  body["revision"] = routine.revision;
  // Absent until the routine has been trained once; the absence reads as "never".
  if (routine.lastTrainedAtMs) body["lastTrainedAt"] = Json::Value::UInt64(*routine.lastTrainedAtMs);
  Json::Value entries(Json::arrayValue);
  for (const RoutineEntry& entry : routine.entries) {
    Json::Value line(Json::objectValue);
    line["position"] = entry.position;
    line["exerciseId"] = entry.exercise.str();
    // Omitted on an OPEN line, which is how a client tells `3 × 5` from `you decide`; a zero here
    // would be a target of nothing.
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
  // Present only while one waits, so its ABSENCE is "this day has nothing to review".
  if (pending) body["pendingProposal"] = toJson(*pending);
  return body;
}

Json::Value toJson(const std::vector<Routine>& routines, const std::vector<ProposalHead>& pending) {
  Json::Value array(Json::arrayValue);
  for (const Routine& routine : routines) {
    std::optional<ProposalHead> standing;
    // The heads arrive newest first, so the FIRST match is the newest.
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
  // What `Apply all N` counts, and the number is the SERVER's — a `kept` row is not a change and a
  // renamed routine is one.
  body["changeCount"] = head.changes;
  body["createdAt"] = Json::Value::UInt64(head.createdAtMs);
  if (head.settledAtMs) body["settledAt"] = Json::Value::UInt64(*head.settledAtMs);
  Json::Value source(Json::objectValue);
  source["door"] = toString(head.source.door);
  // Omitted while the transport carries neither, so a card draws a truthful fallback rather than an
  // empty string.
  if (!head.source.connection.empty()) source["connection"] = head.source.connection;
  if (!head.source.agent.empty()) source["agent"] = head.source.agent;
  // The conversation this came out of: absent from every MCP proposal, and absent again once the
  // lifter has deleted the thread an Ask proposal came from. A client offers the link only where
  // this key is.
  if (head.source.thread) source["thread"] = head.source.thread->str();
  body["source"] = source;
  return body;
}

// A thread row is the question in the LIFTER'S OWN WORDS plus what came of it: `title` is the
// stored first message, and every field of `outcome` is something the server observed.
Json::Value toJson(const ThreadOutcome& outcome) {
  Json::Value body(Json::objectValue);
  body["kind"] = toString(outcome.kind);
  // Always present, and zero is a real answer: `read only` is a thread that proposed nothing.
  body["changes"] = outcome.changes;
  // Named only where ONE routine took the changes; across two the count still stands and the noun
  // does not.
  if (outcome.routine) {
    body["routineId"] = outcome.routine->str();
    body["routine"] = outcome.routineName;
  }
  return body;
}

Json::Value toJson(const AskThread& thread) {
  Json::Value body(Json::objectValue);
  body["id"] = thread.id.str();
  // THE FIRST MESSAGE, VERBATIM — never a summary a model wrote. It travels byte for byte.
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
  // The turns ride on the CONVERSATION's own read and are absent from the list, where absence means
  // "not on this read". On the conversation's own read it means nothing was said yet — a real
  // state, since the row is committed before the model runs.
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

// A routine's dated history, newest first, its creation row last. A `created` row says when, by
// whom and how many movements the day was built with; a `proposal` row hands over the head it has,
// whose actor is `proposal.source.door`.
// `by` is omitted on a created row that was the LIFTER's own hand — that absence is what a client
// draws as *created by you*.
Json::Value toJson(const std::vector<RoutineEvent>& history) {
  Json::Value array(Json::arrayValue);
  for (const RoutineEvent& event : history) {
    Json::Value line(Json::objectValue);
    line["kind"] = event.kind == RoutineEventKind::created ? "created" : "proposal";
    line["at"] = Json::Value::UInt64(event.atMs);
    if (event.door) line["by"] = toString(*event.door);
    // The count is the document AS CREATED, absent where the ledger did not record it. A client
    // draws the row without it rather than counting today's lines.
    if (event.movements) line["movements"] = *event.movements;
    if (event.proposal) line["proposal"] = toJson(*event.proposal);
    array.append(line);
  }
  return array;
}

namespace {
Json::Value targetsJson(const EntryTargets& targets) {
  Json::Value body(Json::objectValue);
  // The FOUR absences a routine line already carries, carried through the diff unchanged: no sets
  // is the open line, no reps is `max`, no weight is "whatever you did last time", no rest falls
  // back to the global target. Which SIDE of a change is missing is `kind`'s to say.
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
    // On a removed row alone. Zero is a real answer — a movement planned and never trained — so it
    // is present rather than omitted.
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
    // The open line, frozen as the absence it is rather than as "0 sets".
    if (entry.sets) line["sets"] = *entry.sets;
    if (entry.reps) line["reps"] = *entry.reps;
    if (entry.weightKg) line["weightKg"] = *entry.weightKg;
    if (entry.restSeconds) line["restSeconds"] = *entry.restSeconds;
    entries.append(line);
  }
  body["entries"] = entries;
  return body;
}

// The finish screen, one way. Every optional is OMITTED when absent and never null, and each
// omission is a sentence: no top e1RM means nothing was loaded, no record means the session earned
// none, no comparison means there was nothing to compare against. `planned` carries the target
// only; `routine` is dropped when the session it stands against holds no name.
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

// What a read served: the server's own tally of the rows it handed over, deduped by id where it
// counted them (domain/ReadReceipt.h). It rides in the read's own reply.
Json::Value toJson(const ReadTally& tally) {
  Json::Value out(Json::objectValue);
  out["sets"] = tally.sets;
  out["sessions"] = tally.sessions;
  out["weeks"] = tally.weeks;
  return out;
}

// The statistics engine, one way. No `e1rm` on a point or a best means that load has no honest
// one-rep estimate (a chin-up, a band-assisted pull-up); an absent `bestE1rm` means no set of that
// movement ever had one. `weeks` is contiguous — a week with no training is present and zero.
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

// A movement's record, one way. Every list is OMITTED when empty rather than sent as an empty
// array. A movement never lifted carries no series, no records and no days; the two counts are
// always present because zero is a real answer there. A movement whose every set was unloaded
// carries no `bestE1rm` and no series either — Epley is undefined at and below zero — while still
// carrying its heaviest and its sets.
Json::Value toJson(const MovementRecord& record) {
  Json::Value body(Json::objectValue);
  body["exercise"] = toJson(record.exercise);
  // The count is `routines.length`, emitted beside the list rather than instead of it. The list is
  // omitted when empty, like every other list on this page.
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

// What a coach reads. The absences are the session's own — a running workout has no finish, an
// ad-hoc one no routine name. There is no id in this object at any depth, and the movement travels
// as its display name.
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

// The read half of the pair, and the one function here that clamps instead of throwing: it reads
// what STORAGE holds, so an unreadable blob must still leave the session readable. A non-object is
// no plan at all; a name that is not a string is no name, exactly as the prefill's SQL decides it.
std::optional<PlanSnapshot> planFrom(const Json::Value& stored) {
  if (!stored.isObject()) return std::nullopt;
  PlanSnapshot plan;
  if (stored["routine"].isString()) plan.routineName = stored["routine"].asString();
  for (const Json::Value& entry : stored["entries"]) {
    if (!entry.isObject() || !entry["exerciseId"].isString()) continue;
    // sets and reps may both legitimately be ABSENT — the open line and `max` — so a missing one is
    // read as that absence. A value of the wrong TYPE drops the line rather than guessing at it.
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

// Takes the APP's base url — where the browser app is served — not the API's.
std::string proposalUrl(const std::string& appBaseUrl, const ProposalId& id) {
  return appBaseUrl + "/#/gym/proposals/" + id.str();
}

}
