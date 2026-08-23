#pragma once

#include "products/roadmap/domain/Subgraph.h"

#include <json/json.h>

namespace wm {

// The subgraph wire codec: the one envelope every sync scenario shares (live edit, offline
// flush, reconnect delta, graft). It reuses TreeJson's GraphState/LegendState encoders — the wire
// speaks the same stamp format the document does — and adds the envelope fields: intent,
// gestures, coverage, title.
Json::Value toJson(const Subgraph& subgraph);
Subgraph subgraphFromJson(const Json::Value& root);

// A bare version vector (the `{actor: "ms:counter:actor"}` shape a client sends in subscribe).
VersionVector versionVectorFromJson(const Json::Value& object);

}
