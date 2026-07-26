#pragma once

#include "products/roadmap/domain/Gallery.h"
#include "products/roadmap/domain/GraphState.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/Tree.h"
#include "products/roadmap/domain/TreeDiagnostics.h"
#include "products/roadmap/domain/TreeSummary.h"

#include "platform/adapters/json/JsonText.h"  // dump / parse — the shared compact-JSON boundary

#include <json/json.h>

#include <string>

namespace wm {

// The JSON boundary: converts domain types to and from the wire/persist shape. This is
// the only place the domain meets a serialization format.
Json::Value nodeToJson(const NodeSpec& node);  // one node's wire shape, shared by get_tree and find_nodes
Json::Value toJson(const TreeData& data);
Json::Value toJson(const Progress& progress);
Json::Value toJson(const TreeDiagnostics& diagnostics);
Json::Value toJson(const TreeSummary& summary);   // one registry row (GET /v1/trees)
Json::Value toJson(const GalleryEntry& entry);    // one gallery card (GET /v1/gallery)
Json::Value toJson(const GraphState& state);    // the persisted graph document
Json::Value toJson(const LegendState& legend);  // the persisted legend document

TreeData treeFromJson(const Json::Value& root, const TreeId& id);
GraphState graphStateFromJson(const Json::Value& root);
LegendState legendStateFromJson(const Json::Value& kinds);

// A node's links, the one shape shared by the document and the command payloads. A link may
// arrive as an object {url, label?} or as a bare url string (label defaults to empty).
Json::Value linksToJson(const std::vector<Link>& links);
std::vector<Link> linksFromJson(const Json::Value& array);

}
