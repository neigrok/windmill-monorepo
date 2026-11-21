#include "platform/domain/sync/RegistryComposition.h"

#include <regex>
#include <set>

namespace wm::sync {

Json::Value composeRegistry(const Json::Value& manifest, const std::map<std::string, Json::Value>& documents) {
  if (!manifest.isObject() || manifest.getMemberNames() != std::vector<std::string>{"composition", "registries"} ||
      !manifest["composition"].isString() || manifest["composition"].asString().empty() ||
      !manifest["registries"].isArray() || manifest["registries"].empty())
    throw RegistryError("composition requires a name and nonempty registry list");

  Json::Value joined(Json::objectValue);
  joined["registry"] = manifest["composition"];
  joined["products"] = Json::Value(Json::objectValue);
  joined["types"] = Json::Value(Json::arrayValue);
  joined["commands"] = Json::Value(Json::arrayValue);
  std::set<std::string> files, types, commands;
  const std::regex filename("[a-z][a-z0-9-]*\\.registry\\.json");
  for (const auto& member : manifest["registries"]) {
    if (!member.isString() || !std::regex_match(member.asString(), filename))
      throw RegistryError("composition has an invalid registry filename");
    const auto file = member.asString();
    if (!files.insert(file).second) throw RegistryError("composition repeats registry " + file);
    const auto found = documents.find(file);
    if (found == documents.end()) throw RegistryError("composition has no registered document " + file);
    const auto& document = found->second;
    const Registry part(document);
    if (joined.isMember("version") &&
        (joined["version"] != document["version"] || joined["minVersion"] != document["minVersion"]))
      throw RegistryError("composition registries disagree on version interval");
    joined["version"] = document["version"];
    joined["minVersion"] = document["minVersion"];
    for (const auto& name : document["products"].getMemberNames()) {
      if (joined["products"].isMember(name)) throw RegistryError("composition repeats product " + name);
      joined["products"][name] = document["products"][name];
    }
    for (const auto& type : document["types"]) {
      if (!types.insert(type["type"].asString()).second) throw RegistryError("composition repeats type " + type["type"].asString());
      joined["types"].append(type);
    }
    for (const auto& command : document["commands"]) {
      if (!commands.insert(command["name"].asString()).second) throw RegistryError("composition repeats command " + command["name"].asString());
      joined["commands"].append(command);
    }
  }
  const Registry validated(joined);
  return joined;
}

}
