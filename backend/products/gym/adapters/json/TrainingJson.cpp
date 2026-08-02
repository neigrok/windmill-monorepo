#include "products/gym/adapters/json/TrainingJson.h"

#include "platform/adapters/json/JsonText.h"

#include <string>

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

std::uint64_t parseFinish(const Json::Value& body) {
  if (!body.isObject()) throw InvalidTraining("a finish must be a json object");
  return instantOf(body, "finishedAt");
}

Json::Value toJson(const Session& session) {
  Json::Value body(Json::objectValue);
  body["id"] = session.id.str();
  body["startedAt"] = Json::Value::UInt64(session.startedAtMs);
  if (session.finishedAtMs) body["finishedAt"] = Json::Value::UInt64(*session.finishedAtMs);
  if (session.routine) body["routineId"] = session.routine->str();
  if (!session.planJson.empty()) {
    // The frozen snapshot travels as the object it is, not a string of one; an unparseable stored
    // blob (which nothing can currently write) is omitted rather than corrupting the reply.
    Json::Value plan = parse(session.planJson);
    if (!plan.isNull()) body["plan"] = plan;
  }
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

Json::Value toJson(const Exercise& exercise) {
  Json::Value body(Json::objectValue);
  body["id"] = exercise.id.str();
  body["name"] = exercise.name;
  body["pattern"] = toString(exercise.pattern);
  body["equipment"] = toString(exercise.equipment);
  body["stepKg"] = exercise.stepKg;
  body["custom"] = exercise.custom;
  return body;
}

Json::Value toJson(const std::vector<Exercise>& exercises) {
  Json::Value array(Json::arrayValue);
  for (const Exercise& exercise : exercises) array.append(toJson(exercise));
  return array;
}

}
