#pragma once

#include "products/roadmap/domain/Subgraph.h"

#include <json/json.h>

namespace wm {

// A frame as it is sent on: its `branches` are a confirmation for this server and are never written.
Json::Value toJson(const Subgraph& subgraph);
// Throws std::invalid_argument on a stamp that is not one, a register that is neither null nor {v, at}, or `branches`
// that is not a list of tree ids.
Subgraph subgraphFromJson(const Json::Value& root);

// A bare version vector (the `{actor: "ms:counter:actor"}` shape a client sends in subscribe).
VersionVector versionVectorFromJson(const Json::Value& object);

}
