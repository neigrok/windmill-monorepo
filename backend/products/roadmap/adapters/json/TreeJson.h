#pragma once

#include "products/roadmap/domain/Gallery.h"
#include "products/roadmap/domain/GraphState.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/Tree.h"
#include "products/roadmap/domain/TreeDiagnostics.h"
#include "products/roadmap/domain/TreeSummary.h"

#include "platform/adapters/json/JsonText.h"

#include <json/json.h>

#include <optional>
#include <string>

namespace wm {

Json::Value nodeToJson(const NodeSpec& node);
Json::Value toJson(const TreeData& data);
Json::Value toJson(const Progress& progress);
Json::Value toJson(const TreeDiagnostics& diagnostics);
Json::Value toJson(const TreeSummary& summary);   // one registry row (GET /v1/trees)
Json::Value toJson(const GalleryEntry& entry);    // one gallery card (GET /v1/gallery)
Json::Value toJson(const GraphState& state);    // the persisted graph document
Json::Value toJson(const LegendState& legend);  // the persisted legend document

// nullopt when the root is not an object, or when a field is present but the wrong type.
std::optional<TreeData> treeFromJson(const Json::Value& root, const TreeId& id);
GraphState graphStateFromJson(const Json::Value& root);
LegendState legendStateFromJson(const Json::Value& kinds);

// A link may arrive as an object {url, label?} or as a bare url string (label defaults to empty).
Json::Value linksToJson(const std::vector<Link>& links);
std::vector<Link> linksFromJson(const Json::Value& array);

}
