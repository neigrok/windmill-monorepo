#include "products/gym/adapters/json/TrainingJson.h"

#include <string>
#include <utility>
#include <vector>

namespace wm::gym {

namespace {
// One rule for all three instants, because the one instant that escaped it (finishedAt) is how a
// session came to end 56 years before it began. Zero is an unset device clock, not a moment; past
// the ceiling is a value the store cannot hold, so it is refused here rather than left to overflow
// a timestamptz mid-transaction.
std::uint64_t instantOf(const Json::Value& body, const char* field) {
  if (!body[field].isUInt64())
    throw InvalidTraining(std::string(field) + " must be an epoch-ms number");
  const std::uint64_t instant = body[field].asUInt64();
  if (instant == 0) throw InvalidTraining(std::string(field) + " must be an instant, not zero");
  if (instant > kMaxInstantMs) throw InvalidTraining(std::string(field) + " is past the end of time");
  return instant;
}

// The comparison's two sides are the same three numbers, so they are written by one hand — the line
// a client prints for "before" is the line it prints for "now", and neither can drift into a shape
// of its own.
Json::Value topSetJson(const TopSet& top) {
  Json::Value body(Json::objectValue);
  body["weightKg"] = top.weightKg;
  body["reps"] = top.reps;
  body["sets"] = top.sets;
  return body;
}

// The two standing bests are the same four numbers and are written by one hand for the same reason
// the comparison's two sides are: a client prints "best e1RM" and "heaviest" from one line of code.
Json::Value bestJson(const Best& best) {
  Json::Value body(Json::objectValue);
  body["weightKg"] = best.weightKg;
  body["reps"] = best.reps;
  body["at"] = Json::Value::UInt64(best.atMs);
  if (best.e1rm) body["e1rm"] = *best.e1rm;
  return body;
}

// A bar of the chart and a line of the record list are the same four numbers, written by one hand
// for the reason the comparison's two sides are: they are the same fact asked twice, and a client
// draws both from one line of code. `e1rm` is never optional here — a point with no honest estimate
// is not in either list at all.
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
  // Omitted (or null) means join — the phone's Start, and what every caller written before this
  // field existed meant. A PRESENT value parses strictly, exactly like a set's kind: a string where
  // a boolean belongs is a 400, never a guess at which of the two Starts the caller meant.
  if (body.isMember("joinOpenSession") && !body["joinOpenSession"].isNull()) {
    if (!body["joinOpenSession"].isBool())
      throw InvalidTraining("joinOpenSession must be a boolean");
    start.joinOpenSession = body["joinOpenSession"].asBool();
  }
  // The day of the program this workout is. Omitted is the ad-hoc session; present, the server
  // loads that routine and freezes it — the client sends the id and never the plan.
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
  // The optionals: omitted (or null) means the default — but a PRESENT kind parses strictly, so an
  // unknown word is a 400, never a silent downgrade of what the lifter said they did.
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

// A fix names what it changes and nothing else. Every field here is optional and every one of them
// is checked for PRESENCE alone — a `null` weight is a type error rather than a silent no-op —
// because the whole shape of this write is "an omission means leave it", and a client that could
// omit a field two ways would sooner or later mean different things by them. `rpe` is the exception
// and the one that earns it: it is the only value a set may not have at all, so `"rpe": null` is how
// a correction removes one, and that is why it travels as a named-plus-value pair.
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
// The lines of a day of the program, read once for the two writes that carry them: the lifter's own
// routine write and an agent's proposal. It is one function because a proposal's own description
// tells its caller to read `list_routines`, change what it means and send all of it back — two
// parsers would make that instruction a trap the day one of them grew a rule the other lacked.
std::vector<RoutineEntry> entriesFrom(const Json::Value& body) {
  if (!body["entries"].isArray()) throw InvalidTraining("entries must be an array");
  std::vector<RoutineEntry> entries;
  for (const Json::Value& entry : body["entries"]) {
    if (!entry.isObject()) throw InvalidTraining("a routine entry must be a json object");
    // The same rule the tool surface publishes as `additionalProperties: false` and the composite
    // tool host enforces on a call's arguments, reaching one level down into the line. Asking only
    // for the names it knows is not the same as refusing the rest: `targetRepsl: 5` read clean, the
    // entry stored no rep target at all, and the write answered that the routine had saved — a
    // misspelling that silently wiped the target it was aiming at.
    //
    // `position` is ACCEPTED AND IGNORED, and that is not a softening — it is the difference between
    // strictness and an outage. A routine travels as its whole document: propose_routine_change's
    // own description tells the caller to read it with list_routines, change what they mean and send
    // all of it back, and what list_routines hands them carries `position` on every line (toJson
    // below). Refusing it would make our own printed instruction a hard refusal. It is redundant
    // rather than wrong — the run is renumbered 1..n from the order these arrive in, and the entity
    // refuses any other run — so the honest answer is to take it and pay it no attention.
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
    // value type-checks strictly and an absent one is never filled in with a zero that would read
    // as a real target. targetSets joined them in W10: a routine is savable while incomplete, and
    // the line with no sets on it is the OPEN one the rack decides (§M29's `Leave it open`).
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
    // The position is the order the lines arrived in — no client numbers its own, and the entity
    // refuses anything but 1..n, so the wire order and the store's key cannot drift apart.
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
  // Optional, and its presence is the whole meaning: an editor that says which revision it read is
  // asking not to overwrite a day that moved since; a writer that says nothing lands as before.
  std::optional<int> expectedRevision;
  if (body.isMember("revision") && !body["revision"].isNull()) {
    if (!body["revision"].isInt()) throw InvalidTraining("revision must be a whole number");
    expectedRevision = body["revision"].asInt();
  }
  return RoutineWrite{RoutineId{body["id"].asString()}, body["name"].asString(),
                      body["position"].asInt(), entriesFrom(body), expectedRevision};
}

// A proposal names its own id, the routine it is about, and the document it would take on. `name`
// and `summary` are the two optionals and each means something by its absence: an absent name is
// the routine keeping the one it has, and an absent summary is an agent that said nothing about why
// — the card then draws the diff and no sentence, which is honest rather than empty.
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
  // A created movement's id is client-minted like every other, so it obeys the one id-shape rule —
  // which the Exercise constructor itself cannot carry, because the 64 seeded slugs ('dip') are the
  // schema's own and are shorter than any minted id may be.
  if (!wellFormedId(body["id"].asString())) throw InvalidTraining("bad exercise id");
  if (!body["name"].isString()) throw InvalidTraining("name must be a string");
  if (!body["pattern"].isString()) throw InvalidTraining("pattern must be a string");
  if (!body["equipment"].isString()) throw InvalidTraining("equipment must be a string");

  ExerciseWrite write{ExerciseId{body["id"].asString()}, body["name"].asString(),
                      parsePattern(body["pattern"].asString()),
                      parseEquipment(body["equipment"].asString()), std::nullopt};
  // Omitted takes the equipment's default step, which the domain owns — the client is never made to
  // carry a table it would then have to keep in step with the seed.
  if (body.isMember("stepKg") && !body["stepKg"].isNull()) {
    if (!body["stepKg"].isNumeric()) throw InvalidTraining("stepKg must be a number");
    write.stepKg = body["stepKg"].asDouble();
  }
  return write;
}

std::string parseExerciseRename(const Json::Value& body) {
  if (!body.isObject()) throw InvalidTraining("a rename must be a json object");
  // Strict about what it does NOT carry, the rule `additionalProperties: false` already publishes
  // on the tool surface: a body naming `pattern` or `stepKg` would be answered 200 with neither
  // changed, which is a write silently doing less than it said. Only the name is renamable, and a
  // seed's pattern and step are the catalog's rather than any one account's.
  for (const std::string& field : body.getMemberNames())
    if (field != "name")
      throw InvalidTraining("unknown rename field \"" + field + "\". A rename takes: name.");
  if (!body["name"].isString()) throw InvalidTraining("name must be a string");
  return body["name"].asString();
}

GymPreferences parsePreferences(const Json::Value& body, const UserId& user) {
  if (!body.isObject())
    throw InvalidPreference("preferences-unreadable", "settings must be a json object");
  // Strict about names, the rule `parseSetFix` and `parseExerciseRename` already keep: a misspelled
  // `restSecond` read clean would answer 200 with the timer unchanged, which is a write doing less
  // than it said — and here it would also silently turn the timer off, because an omission is a
  // default. The two together are how a lifter's rest quietly becomes somebody else's.
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
  // The one absence that MEANS something, so it is the one field where omitted and null say the
  // same thing on purpose: no timer. Everything else defaults; this one is the default.
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
  // The frozen snapshot travels as the object it is, not a string of one, and it is emitted from
  // the typed value rather than re-parsed out of storage — the shape is the domain's now, so the
  // wire cannot disagree with what the session actually holds.
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

// One row of the log, which is the session plus what the list says about it without loading its
// sets. Both counts travel: setCount is every row the session holds, workingSetCount is the number
// the screen prints, and they are different numbers on any session that warmed up.
//
// tonnageKg is always present and a zero is a real answer — the working sets moved no measurable
// load — so it is a NUMBER and not an omission, because a week divider sums the rows under it and
// an absence would have to be read as a zero anyway. What a zero means is a rendering rule and it
// is the same on every surface: draw nothing where the tonnage would go, never `0.0 t`.
//
// topSet is omitted for a session holding no working set — a warmup-only session, or one still
// empty — because "0 kg × 0" is not a lighter workout, it is no workout yet, and topE1rm is omitted
// with it and also where the heaviest working set was unloaded (Epley is undefined at and below
// zero). closedItself is always present: it is a fact about every row rather than an optional the
// client tests for, and the note it draws ("closed on its own — no set for four hours") is a
// sentence the row either says or does not.
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
  // Always present, like closedItself and for the same reason: the gold dot is a fact about every
  // row rather than an optional a client tests for, and `false` is the answer ~190 rows in 200 get.
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
  // What this account used to call it, newest first — OMITTED when there are none, which is nearly
  // every row of nearly every catalog, so the read that ships on every screen is byte-identical to
  // what it was before renaming grew a memory. The picker matches them alongside the name: a
  // movement renamed on Sunday is still reachable on Tuesday by the word in a lifter's hands.
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

// `at` is the SESSION's start, which is the word every other instant this product hands a screen is
// dated by, and the picker prints it as "3 days ago". The movement's NAME is not here on purpose:
// the caller drew this list from the catalog and joins on `exerciseId`, so sending the name again
// would send sixty-four strings the client already holds — and a renamed movement would then arrive
// under two spellings in one screen.
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
  // The concurrency token, read-only on the wire: a client draws it (a proposal minted against an
  // older one is stale) and never sends it back, because the store is what moves it.
  body["revision"] = routine.revision;
  // Absent until the routine has been trained once — the routines screen reads the absence as
  // "never", which is a different sentence from any instant it could otherwise be handed.
  if (routine.lastTrainedAtMs) body["lastTrainedAt"] = Json::Value::UInt64(*routine.lastTrainedAtMs);
  Json::Value entries(Json::arrayValue);
  for (const RoutineEntry& entry : routine.entries) {
    Json::Value line(Json::objectValue);
    line["position"] = entry.position;
    line["exerciseId"] = entry.exercise.str();
    // Omitted on an OPEN line, which is the whole of how a client tells `3 × 5` from `you decide`:
    // a zero here would be a target of nothing, and a client drawing one would print `0 × 5`.
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
  // Present only while one waits, so its ABSENCE is the whole of "this day has nothing to review" —
  // the rule every other optional on this wire obeys, applied to §B5's dot.
  if (pending) body["pendingProposal"] = toJson(*pending);
  return body;
}

// One pass over the heads per routine rather than a map, because a lifter holds a handful of days
// and at most one pending proposal on each: the map would be the more expensive of the two.
Json::Value toJson(const std::vector<Routine>& routines, const std::vector<ProposalHead>& pending) {
  Json::Value array(Json::arrayValue);
  for (const Routine& routine : routines) {
    std::optional<ProposalHead> standing;
    // The heads arrive newest first, so the FIRST match is the newest — which is the one a card
    // draws when two doors, or two agents on one account, each have one waiting.
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
  // What `Apply all N` counts, and the number is the SERVER's: a client that counted the diff rows
  // itself would have to know that a `kept` row is not a change and that a renamed routine is one,
  // and the three clients would then hold three copies of that rule.
  body["changeCount"] = head.changes;
  body["createdAt"] = Json::Value::UInt64(head.createdAtMs);
  if (head.settledAtMs) body["settledAt"] = Json::Value::UInt64(*head.settledAtMs);
  Json::Value source(Json::objectValue);
  source["door"] = toString(head.source.door);
  // Omitted while the transport carries neither, so a card draws a truthful fallback ("your
  // connected agent") rather than an empty string where a model's name should be.
  if (!head.source.connection.empty()) source["connection"] = head.source.connection;
  if (!head.source.agent.empty()) source["agent"] = head.source.agent;
  // THE CONVERSATION THIS CAME OUT OF, and its absence is the whole of §O's delete rule. It is
  // absent from every MCP proposal, which had no conversation, and absent again once the lifter has
  // deleted the thread an Ask proposal came from — the change stays in the routine's history and
  // still says `ask`, it just no longer opens something that exists. A client draws the row either
  // way and offers the link only where this key is.
  if (head.source.thread) source["thread"] = head.source.thread->str();
  body["source"] = source;
  return body;
}

// ── Ask's threads (§O) ─────────────────────────────────────────────────────────────────────────
//
// A row is the question in the LIFTER'S OWN WORDS plus what came of it, and both halves of that
// sentence are enforced below rather than trusted: `title` is the stored first message, and every
// field of `outcome` is something the server observed — a state the ledger holds, a count it stored,
// a routine it can name. Nothing here is a motive, because nothing observes one.
Json::Value toJson(const ThreadOutcome& outcome) {
  Json::Value body(Json::objectValue);
  body["kind"] = toString(outcome.kind);
  // Always present, and zero is a real answer: `read only` is a thread that proposed nothing.
  body["changes"] = outcome.changes;
  // Named only where ONE routine took the changes. Across two, the count still stands and the noun
  // does not, so a client draws `6 changes` and never `6 changes → Push A` about a thread that also
  // moved Legs.
  if (outcome.routine) {
    body["routineId"] = outcome.routine->str();
    body["routine"] = outcome.routineName;
  }
  return body;
}

Json::Value toJson(const AskThread& thread) {
  Json::Value body(Json::objectValue);
  body["id"] = thread.id.str();
  // THE FIRST MESSAGE, VERBATIM — never a summary a model wrote, which is the point of the whole
  // screen. It travels byte for byte, punctuation and emoji included.
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
  // The turns ride on the CONVERSATION's own read and are absent from the list, which carries titles
  // and outcomes and nothing else. On the list, absence means "not on this read". On the
  // conversation's own read it means nothing was said yet — which is a real state, not an impossible
  // one: the row is committed before the model runs, so a turn-less thread exists for the whole of
  // every in-flight ask and stays if the process died before the answer landed.
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

// A routine's dated history, newest first, its creation row last. Two kinds of row, and each
// carries only what its own kind means: a `created` row says when, by whom, and how many movements
// the day was built with, while a `proposal` row hands over the head it already has — the actor of
// one is `proposal.source.door`, so nothing here says the same thing twice under two keys.
//
// `by` is omitted on a created row that was the LIFTER's own hand, which is the ordinary case and
// the one §M is about. Its absence is what a client draws as *created by you*; a client must not
// print those words when it is present, because then it was not.
Json::Value toJson(const std::vector<RoutineEvent>& history) {
  Json::Value array(Json::arrayValue);
  for (const RoutineEvent& event : history) {
    Json::Value line(Json::objectValue);
    line["kind"] = event.kind == RoutineEventKind::created ? "created" : "proposal";
    line["at"] = Json::Value::UInt64(event.atMs);
    if (event.door) line["by"] = toString(*event.door);
    // Absent on a day created before this ledger recorded it — the count is the document AS
    // CREATED, and a routine edited since cannot prove what that was. A client draws the row
    // without it rather than counting today's lines and calling them the ones it was built with.
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
  // is the open line the rack decides, no reps is `max`, no weight is "whatever you did last
  // time", no rest falls back to the global target. Which SIDE of a change is missing is `kind`'s
  // to say and never an empty object's — an added line has no `before`, a removed one no `after`.
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
    // §D14's *41 logged sets kept*, on the one row that needs it. Zero is a real answer — a
    // movement the lifter planned and never trained — so it is present rather than omitted.
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
    // The open line, frozen as the absence it is: a session started under a half-built routine has
    // to be able to say "you decide" about this movement rather than "0 sets".
    if (entry.sets) line["sets"] = *entry.sets;
    if (entry.reps) line["reps"] = *entry.reps;
    if (entry.weightKg) line["weightKg"] = *entry.weightKg;
    if (entry.restSeconds) line["restSeconds"] = *entry.restSeconds;
    entries.append(line);
  }
  body["entries"] = entries;
  return body;
}

// The finish screen, one way. Every optional here is OMITTED when absent and never null, and each
// omission is a sentence the client draws: no top e1RM means nothing in the session was loaded, no
// record means the session earned none, no comparison means there was nothing honest to compare
// against. `planned` carries the target only — rest is the device-local timer's business, not the
// finish screen's — and `routine` is dropped when the session it stands against holds no name,
// because "Against last " is worse than the band naming no day at all.
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

// WHAT A READ SERVED, and the only number on this surface that is about the CALL rather than the
// log. Three counts and no prose: the server's own tally of the rows it handed over, deduped by id
// where it counted them (domain/ReadReceipt.h). It rides in the read's own reply, so the line a
// lifter checks an answer against is one we counted rather than one a model could invent.
Json::Value toJson(const ReadTally& tally) {
  Json::Value out(Json::objectValue);
  out["sets"] = tally.sets;
  out["sessions"] = tally.sessions;
  out["weeks"] = tally.weeks;
  return out;
}

// The statistics ENGINE, one way — there has been no statistics surface since W1c retired the room
// (domain/Statistics.h says what stayed and why). Every absence is a sentence: no `e1rm` on a point
// or a best
// means that load has no honest one-rep estimate (a chin-up, a band-assisted pull-up), and an
// absent `bestE1rm` means no set of that movement ever had one. `weeks` is contiguous — a week with
// no training is present and zero — because the gap is the fact, and a client filling it in would
// be doing calendar arithmetic in a second place. There is no total, no volume, no score and no
// percentage anywhere in it: a fact with a direction, never a grade.
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

// A movement's record, one way. Every list here is OMITTED when it is empty rather than sent as an
// empty array, and each omission is the same sentence: there is nothing true to draw. A movement
// never lifted carries no series, no records and no days — its page says `never logged` off the two
// counts, which are always present because zero is a real answer there. A movement whose every set
// was unloaded (a chin-up at 0 kg, a band-assisted pull-up at −20) carries no `bestE1rm` and no
// series either, because Epley is undefined at and below zero and a dash in a chart frame is worse
// than no chart: it still draws its heaviest tile and its sets.
Json::Value toJson(const MovementRecord& record) {
  Json::Value body(Json::objectValue);
  body["exercise"] = toJson(record.exercise);
  // The count and the NAMES are one fact served once: `routineCount` is the subhead's `in 2
  // routines` and has read that key on three surfaces since W1c, and `routines` is the same list
  // spelled out — §N32's *`routines  Push A · Legs`*, the line that makes a rename's promise
  // checkable rather than believable. The count is `routines.length` and is emitted beside it
  // rather than instead of it, because a client that lost the key would draw a page with a hole in
  // it. The list is omitted when empty, like every other list on this page.
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

// What a coach reads. The absences here are the ones the session itself has — a workout still
// running has no finish, an ad-hoc one has no routine name — and everything a session normally
// carries that names the ACCOUNT rather than the workout is not omitted but never built: there is
// no id in this object at any depth, and the movement is its display name because the reader holds
// no catalog to resolve a slug against.
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
// what STORAGE holds, not what a client sent, so a blob written by a deploy that has since been
// replaced — or by a hand at the console — must leave the session readable. A non-object is no plan
// at all; a name that is not a string is no name, exactly as the prefill's SQL decides it; an entry
// missing the three fields it is made of is skipped rather than invented.
std::optional<PlanSnapshot> planFrom(const Json::Value& stored) {
  if (!stored.isObject()) return std::nullopt;
  PlanSnapshot plan;
  if (stored["routine"].isString()) plan.routineName = stored["routine"].asString();
  for (const Json::Value& entry : stored["entries"]) {
    if (!entry.isObject() || !entry["exerciseId"].isString()) continue;
    // sets and reps may both legitimately be ABSENT — the open line and `3 × max` — so a missing
    // one is read as that absence and not as a broken entry to skip. A value of the wrong TYPE is
    // still a blob no writer of ours produced, and the line is dropped rather than guessed at.
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

// Composed here for the reason the share's link is: three surfaces composing a url is how two of
// them came to hand a coach a page of JSON. It takes the APP's base url — where the browser app is
// served — not the API's.
std::string proposalUrl(const std::string& appBaseUrl, const ProposalId& id) {
  return appBaseUrl + "/#/gym/proposals/" + id.str();
}

}
