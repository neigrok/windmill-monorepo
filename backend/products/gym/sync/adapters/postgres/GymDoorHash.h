#pragma once

#include "platform/adapters/json/JsonText.h"
#include "platform/domain/sync/Digest.h"

#include <cmath>

namespace wm::gym {

inline std::string gymRequestHash(const Json::Value& request) {
  return sync::sha256(dump(request)).hex();
}

inline std::string gymSetRequestHash(Json::Value request, const std::string& session) {
  request.removeMember("setNumber");
  request["sessionId"] = session;
  request["kind"] = request.get("kind", "working");
  request["note"] = request.get("note", "");
  double weight = std::round(request["weightKg"].asDouble() * 100) / 100;
  request["weightKg"] = weight == 0 ? 0.0 : weight;
  if (request["rpe"].isNull()) request.removeMember("rpe");
  else request["rpe"] = std::round(request["rpe"].asDouble() * 10) / 10;
  return gymRequestHash(request);
}

inline std::string gymImportRequestHash(const Json::Value& args) {
  Json::Value request(Json::objectValue);
  for (const char* field : {"id", "startedAt", "finishedAt", "routineId"})
    if (args.isMember(field)) request[field] = args[field];
  request["sets"] = Json::Value(Json::arrayValue);
  for (const Json::Value& set : args["sets"])
    request["sets"].append(gymSetRequestHash(set, args["id"].asString()));
  return gymRequestHash(request);
}

inline std::string gymCorrectionRequestHash(Json::Value args) {
  args.removeMember("sessionId");
  return gymRequestHash(args);
}

}
