#pragma once

#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Registry.h"

#include <string_view>

namespace wm::gym::engine {

std::string_view registryText();

inline const sync::Registry& registry() {
  static const sync::Registry gym{sync::parseJson(registryText())};
  return gym;
}

inline const sync::Registry& baseRegistry() {
  static const sync::Registry base{[] {
    Json::Value document = sync::parseJson(registryText());
    document["version"] = 4;
    document["minVersion"] = 4;
    Json::Value types(Json::arrayValue);
    for (auto type : document["types"]) {
      if (type["type"] == "routineCreation") continue;
      for (const char* name : {"revision", "createdEntries", "baseRevision", "baseName", "changeCount", "updatedAt"})
        type["fields"].removeMember(name);
      types.append(std::move(type));
    }
    document["types"] = std::move(types);
    return document;
  }()};
  return base;
}

}
