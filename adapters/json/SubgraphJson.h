#pragma once

#include "domain/Subgraph.h"

#include <json/json.h>

namespace wm {

// The subgraph wire codec: the one envelope every sync scenario shares (live edit, offline
// flush, reconnect delta, graft), as JSON. It reuses TreeJson's GraphState/LegendState
// encoders — the wire speaks the same stamp format the document does — and adds the envelope
// fields the protocol needs: intent, gestures, coverage, title. The only place the sync
// protocol meets JSON.
Json::Value toJson(const Subgraph& subgraph);
Subgraph subgraphFromJson(const Json::Value& root);

// A bare version vector (the `{actor: "ms:counter:actor"}` shape a client sends in subscribe).
VersionVector versionVectorFromJson(const Json::Value& object);

}
