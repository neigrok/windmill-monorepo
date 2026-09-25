#include "products/gym/adapters/json/TrainingJson.h"

#include <set>

namespace wm::gym {

Json::Value toJson(const HistoryWorkout& workout) {
  Json::Value body(Json::objectValue);
  body["id"] = workout.id;
  body["startedAt"] = Json::UInt64(workout.startedAtMs);
  body["finishedAt"] = Json::UInt64(workout.finishedAtMs);
  if (!workout.routineId.empty()) body["routineId"] = workout.routineId;
  body["routineName"] = workout.routineName;
  const HistoryTotals totals = workout.totals();
  body["setCount"] = static_cast<int>(workout.sets.size());
  body["workingSetCount"] = totals.sets;
  body["reps"] = totals.reps;
  body["tonnageKg"] = totals.tonnageKg;
  body["sets"] = Json::Value(Json::arrayValue);
  std::set<std::string> names;
  std::set<std::string> exerciseIds;
  for (const HistorySet& set : workout.sets) {
    Json::Value line(Json::objectValue);
    line["id"] = set.id;
    line["exerciseId"] = set.exerciseId;
    line["exercise"] = set.exercise;
    line["setNumber"] = set.setNumber;
    line["weightKg"] = set.weightKg;
    line["reps"] = set.reps;
    if (set.rpe) line["rpe"] = *set.rpe;
    line["completedAt"] = Json::UInt64(set.completedAtMs);
    body["sets"].append(line);
    names.insert(set.exercise);
    exerciseIds.insert(set.exerciseId);
  }
  body["movements"] = Json::Value(Json::arrayValue);
  for (const std::string& id : exerciseIds) {
    const auto totals = workout.totals(id);
    Json::Value movement(Json::objectValue);
    movement["exerciseId"] = id;
    movement["sets"] = totals.sets;
    movement["reps"] = totals.reps;
    movement["tonnageKg"] = totals.tonnageKg;
    body["movements"].append(movement);
  }
  body["exerciseNames"] = Json::Value(Json::arrayValue);
  for (const std::string& name : names) body["exerciseNames"].append(name);
  return body;
}

HistoryWorkout historyWorkoutFrom(const Json::Value& value) {
  HistoryWorkout workout{value["id"].asString(), value["startedAt"].asUInt64(),
      value["finishedAt"].asUInt64(), value.get("routineId", "").asString(),
      value["routineName"].asString(), {}};
  for (const Json::Value& set : value["sets"]) {
    std::optional<double> rpe;
    if (set["rpe"].isNumeric()) rpe = set["rpe"].asDouble();
    workout.sets.push_back(HistorySet{set["id"].asString(), set["exerciseId"].asString(),
        set["exercise"].asString(), set["setNumber"].asInt(), set["weightKg"].asDouble(),
        set["reps"].asInt(), rpe, set["completedAt"].asUInt64(), set["working"].asBool()});
  }
  return workout;
}

Json::Value toJson(const HistoryPage& page) {
  Json::Value body(Json::objectValue);
  body["sessions"] = Json::Value(Json::arrayValue);
  for (const HistoryWorkout& workout : page.sessions) body["sessions"].append(toJson(workout));
  body["summary"]["sessions"] = page.summary.sessions;
  body["summary"]["sets"] = page.summary.sets;
  body["summary"]["reps"] = page.summary.reps;
  body["summary"]["tonnageKg"] = page.summary.tonnageKg;
  body["months"] = Json::Value(Json::arrayValue);
  for (const HistoryMonth& month : page.months) {
    Json::Value row(Json::objectValue);
    row["month"] = month.month;
    row["sessions"] = month.sessions;
    body["months"].append(row);
  }
  for (const auto& [name, facets] : {std::pair{"exercises", &page.exercises},
                                    std::pair{"routines", &page.routines}}) {
    body[name] = Json::Value(Json::arrayValue);
    for (const HistoryFacet& facet : *facets) {
      Json::Value row(Json::objectValue);
      row["id"] = facet.id;
      row["name"] = facet.name;
      row["sessions"] = facet.sessions;
      if (!facet.equipment.empty()) row["equipment"] = facet.equipment;
      body[name].append(row);
    }
  }
  if (page.progress) body["progress"] = toJson(*page.progress);
  body["next"] = Json::Value();
  if (page.hasMore && !page.sessions.empty()) {
    body["next"]["before"] = Json::UInt64(page.sessions.back().startedAtMs);
    body["next"]["beforeId"] = page.sessions.back().id;
  }
  return body;
}

Json::Value toJson(const LogShare& share) {
  Json::Value body(Json::objectValue);
  body["mode"] = share.mode == LogShareMode::snapshot ? "snapshot" : "live";
  body["scope"] = share.range ? "range" : "all";
  if (share.range) {
    body["from"] = Json::UInt64(share.fromMs);
    body["until"] = Json::UInt64(share.untilMs);
  }
  body["createdAt"] = Json::UInt64(share.createdAtMs);
  body["expiresAt"] = Json::UInt64(share.expiresAtMs);
  return body;
}

}
