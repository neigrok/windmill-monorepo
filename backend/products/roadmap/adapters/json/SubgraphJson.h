#pragma once

#include "products/roadmap/domain/Subgraph.h"

#include <json/json.h>

namespace wm {

Json::Value toJson(const Subgraph& subgraph);
Subgraph subgraphFromJson(const Json::Value& root);

// A bare version vector (the `{actor: "ms:counter:actor"}` shape a client sends in subscribe).
VersionVector versionVectorFromJson(const Json::Value& object);

}
