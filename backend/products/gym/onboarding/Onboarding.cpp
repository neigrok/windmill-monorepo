#include "products/gym/onboarding/Onboarding.h"

#include "platform/domain/sync/TextMerge.h"

#include <algorithm>
#include <cmath>
#include <set>

namespace wm::gym {
namespace {

bool fields(const Json::Value& value, const std::set<std::string>& names) {
  if (!value.isObject() || value.size() != names.size()) return false;
  for (const auto& name : value.getMemberNames()) if (!names.contains(name)) return false;
  return true;
}

bool label(const Json::Value& value, std::size_t limit) {
  if (!value.isString() || value.asString().empty() || value.asString().size() > limit ||
      !storableText(value.asString())) return false;
  return !sync::isBlank(value.asString());
}

}

bool validOnboardingRequestId(const std::string& id) {
  if (id.size() != 36) return false;
  for (std::size_t index = 0; index < id.size(); ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (id[index] != '-') return false;
      continue;
    }
    if (!((id[index] >= '0' && id[index] <= '9') || (id[index] >= 'a' && id[index] <= 'f'))) return false;
  }
  return true;
}

std::optional<OnboardingIn> readOnboardingIn(const Json::Value& body) {
  if (!body.isObject() || !body["requestId"].isString() ||
      !validOnboardingRequestId(body["requestId"].asString()) || !body["mode"].isString()) return std::nullopt;
  OnboardingIn input;
  input.requestId = body["requestId"].asString();
  input.mode = body["mode"].asString();
  if (input.mode == "conversation") {
    if (!(fields(body, {"requestId", "mode", "text", "context"}) ||
          fields(body, {"requestId", "mode", "text", "context", "image"})) ||
        !body["text"].isString() || body["text"].asString().size() > 4000 ||
        !storableText(body["text"].asString()) || !body["context"].isArray() || body["context"].size() > 12)
      return std::nullopt;
    if (!body.isMember("image") && sync::isBlank(body["text"].asString())) return std::nullopt;
    std::size_t contextBytes = 0;
    for (const auto& turn : body["context"]) {
      if (!fields(turn, {"role", "text"}) || !turn["role"].isString() ||
          (turn["role"].asString() != "user" && turn["role"].asString() != "assistant") ||
          !label(turn["text"], 4000)) return std::nullopt;
      contextBytes += turn["text"].asString().size();
    }
    if (contextBytes > 16000) return std::nullopt;
    input.text = body["text"].asString();
    input.context = body["context"];
    if (!body.isMember("image")) return input;
    Json::Value photo(Json::objectValue);
    photo["requestId"] = input.requestId;
    photo["mode"] = "photo";
    photo["image"] = body["image"];
    const auto checked = readOnboardingIn(photo);
    if (!checked) return std::nullopt;
    input.imageMimeType = checked->imageMimeType;
    input.imageBase64 = checked->imageBase64;
    return input;
  }
  if (input.mode == "goal") {
    if (!fields(body, {"requestId", "mode", "goal", "daysPerWeek", "equipment"}) ||
        !label(body["goal"], 1000) || !body["daysPerWeek"].isInt() ||
        body["daysPerWeek"].asInt() < 1 || body["daysPerWeek"].asInt() > 6 ||
        !body["equipment"].isString()) return std::nullopt;
    input.goal = body["goal"].asString();
    input.daysPerWeek = body["daysPerWeek"].asInt();
    input.equipment = body["equipment"].asString();
    if (input.equipment != "gym" && input.equipment != "dumbbells" && input.equipment != "barbell" &&
        input.equipment != "bands" && input.equipment != "bodyweight" && input.equipment != "other") return std::nullopt;
    return input;
  }
  if (input.mode == "program") {
    if (!fields(body, {"requestId", "mode", "program"}) || !label(body["program"], 4000)) return std::nullopt;
    input.program = body["program"].asString();
    return input;
  }
  if (input.mode != "photo" || !(fields(body, {"requestId", "mode", "image"}) || fields(body, {"requestId", "mode", "image", "note"})) ||
      !fields(body["image"], {"mimeType", "data"}) || !body["image"]["mimeType"].isString() ||
      !body["image"]["data"].isString()) return std::nullopt;
  if (body.isMember("note")) {
    if (!body["note"].isString() || body["note"].asString().size() > 1000 || !storableText(body["note"].asString())) return std::nullopt;
    input.note = body["note"].asString();
  }
  input.imageMimeType = body["image"]["mimeType"].asString();
  input.imageBase64 = body["image"]["data"].asString();
  if ((input.imageMimeType != "image/jpeg" && input.imageMimeType != "image/png") ||
      input.imageBase64.empty() || input.imageBase64.size() > 4 * ((kOnboardingImageBytes + 2) / 3) ||
      input.imageBase64.size() % 4 != 0) return std::nullopt;
  const auto padding = input.imageBase64.find('=');
  const auto end = padding == std::string::npos ? input.imageBase64.size() : padding;
  if (input.imageBase64.size() - end > 2) return std::nullopt;
  for (std::size_t index = 0; index < input.imageBase64.size(); ++index) {
    const char byte = input.imageBase64[index];
    if (index >= end) { if (byte != '=') return std::nullopt; continue; }
    if (!((byte >= 'A' && byte <= 'Z') || (byte >= 'a' && byte <= 'z') ||
          (byte >= '0' && byte <= '9') || byte == '+' || byte == '/')) return std::nullopt;
  }
  return input;
}

Json::Value onboardingInput(const OnboardingIn& input) {
  Json::Value out(Json::objectValue);
  out["requestId"] = input.requestId;
  out["mode"] = input.mode;
  if (input.mode == "conversation") {
    out["text"] = input.text;
    out["context"] = input.context;
    if (!input.imageBase64.empty()) {
      out["image"]["mimeType"] = input.imageMimeType;
      out["image"]["data"] = input.imageBase64;
    }
    return out;
  }
  if (input.mode == "goal") {
    out["goal"] = input.goal;
    out["daysPerWeek"] = input.daysPerWeek;
    out["equipment"] = input.equipment;
    return out;
  }
  if (input.mode == "program") {
    out["program"] = input.program;
    return out;
  }
  out["image"]["mimeType"] = input.imageMimeType;
  out["image"]["data"] = input.imageBase64;
  out["note"] = input.note;
  return out;
}

std::optional<std::vector<OnboardingRoutine>> readOnboardingRoutines(
    const Json::Value& output, const OnboardingIn& input, const std::vector<Exercise>& seeds) {
  const bool dialogue = input.mode == "conversation";
  if (!(dialogue ? fields(output, {"message", "routines"}) && label(output["message"], 4000) : fields(output, {"routines"})) || !output["routines"].isArray() ||
      (!dialogue && output["routines"].empty()) || output["routines"].size() > 3 ||
      (input.mode == "goal" && output["routines"].size() > static_cast<unsigned>(input.daysPerWeek))) return std::nullopt;
  if (input.mode == "goal" && (input.equipment == "bands" || input.equipment == "other")) return std::nullopt;
  std::vector<OnboardingRoutine> routines;
  std::set<std::string> names;
  for (const auto& raw : output["routines"]) {
    if (!fields(raw, {"name", "entries"}) || !label(raw["name"], 80) ||
        !raw["entries"].isArray() || raw["entries"].empty() || raw["entries"].size() > 6 ||
        !names.insert(raw["name"].asString()).second) return std::nullopt;
    OnboardingRoutine routine{raw["name"].asString(), {}};
    std::set<std::string> movements;
    for (const auto& entry : raw["entries"]) {
      if (!fields(entry, {"exerciseId", "sets", "restSeconds"}) || !entry["exerciseId"].isString() ||
          !entry["sets"].isArray() || entry["sets"].size() > 8) return std::nullopt;
      const auto id = entry["exerciseId"].asString();
      const auto exercise = std::find_if(seeds.begin(), seeds.end(), [&](const Exercise& seed) {
        return !seed.custom && seed.id.str() == id;
      });
      if (exercise == seeds.end() || !movements.insert(id).second) return std::nullopt;
      if (input.mode == "goal" && input.equipment == "bodyweight" &&
          exercise->equipment != Equipment::bodyweight) return std::nullopt;
      if (input.mode == "goal" && input.equipment == "dumbbells" && exercise->equipment != Equipment::bodyweight &&
          exercise->equipment != Equipment::dumbbell) return std::nullopt;
      if (input.mode == "goal" && input.equipment == "barbell" && exercise->equipment != Equipment::bodyweight &&
          exercise->equipment != Equipment::barbell) return std::nullopt;
      std::optional<int> rest;
      if (!entry["restSeconds"].isNull()) {
        if (!entry["restSeconds"].isInt() || entry["restSeconds"].asInt() < kMinRestSeconds || entry["restSeconds"].asInt() > 600) return std::nullopt;
        rest = entry["restSeconds"].asInt();
      }
      std::vector<SetTarget> sets;
      for (const auto& target : entry["sets"]) {
        if (!fields(target, {"reps", "weightKg"})) return std::nullopt;
        std::optional<int> reps;
        if (!target["reps"].isNull()) {
          if (!target["reps"].isInt() || target["reps"].asInt() < 1 || target["reps"].asInt() > 100) return std::nullopt;
          reps = target["reps"].asInt();
        }
        std::optional<double> weight;
        if (!target["weightKg"].isNull()) {
          if (input.mode == "goal" || !target["weightKg"].isNumeric()) return std::nullopt;
          const double value = target["weightKg"].asDouble();
          if (!std::isfinite(value) || value < -500 || value > 500 || std::abs(value * 100 - std::round(value * 100)) > 0.000001) return std::nullopt;
          weight = value;
        }
        sets.emplace_back(reps, weight);
      }
      routine.entries.emplace_back(static_cast<int>(routine.entries.size()) + 1, ExerciseId{id}, std::move(sets), rest);
    }
    routines.push_back(std::move(routine));
  }
  return routines;
}

Json::Value onboardingRoutines(const std::vector<OnboardingRoutine>& routines) {
  Json::Value out(Json::objectValue);
  out["routines"] = Json::Value(Json::arrayValue);
  for (const auto& routine : routines) {
    Json::Value row(Json::objectValue);
    row["name"] = routine.name;
    row["entries"] = Json::Value(Json::arrayValue);
    for (const auto& entry : routine.entries) {
      Json::Value line(Json::objectValue);
      line["exerciseId"] = entry.exercise.str();
      line["restSeconds"] = entry.restSeconds ? Json::Value(*entry.restSeconds) : Json::Value();
      line["sets"] = Json::Value(Json::arrayValue);
      for (const auto& set : entry.sets) {
        Json::Value target(Json::objectValue);
        target["reps"] = set.reps ? Json::Value(*set.reps) : Json::Value();
        target["weightKg"] = set.weightKg ? Json::Value(*set.weightKg) : Json::Value();
        line["sets"].append(target);
      }
      row["entries"].append(line);
    }
    out["routines"].append(row);
  }
  return out;
}

OnboardingRecord expireOnboarding(OnboardingRecord record, long long nowMs) {
  if (record.expiresAtMs <= nowMs && record.state != "expired") {
    record.state = "expired";
    record.errorCode = "result_expired";
    record.payload = Json::Value();
    return record;
  }
  if (record.state == "pending" && record.leaseUntilMs <= nowMs) {
    record.state = "failed";
    record.errorCode = "interrupted";
  }
  return record;
}

}
