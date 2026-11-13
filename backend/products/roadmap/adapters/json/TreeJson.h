#pragma once

#include "products/roadmap/domain/Gallery.h"
#include "products/roadmap/domain/GraphState.h"
#include "products/roadmap/domain/Guides.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/OpenedTrees.h"
#include "products/roadmap/domain/Tree.h"
#include "products/roadmap/domain/TreeDiagnostics.h"
#include "products/roadmap/domain/TreeSummary.h"

#include "platform/adapters/json/JsonText.h"

#include <json/json.h>

#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace wm {

Json::Value nodeToJson(const NodeSpec& node);
Json::Value toJson(const TreeData& data);
Json::Value toJson(const Progress& progress);
Json::Value toJson(const TreeDiagnostics& diagnostics);
// A tree's diagnostics as its writer is answered them: the graph's, and beside them `treeLoops` as
// [{node, path: [{treeId, title}], pathOmitted?}] and `danglingPointers` as [{node, treeId}], the pointer as it is
// stored. `treeLoopsOmitted`, `danglingPointersOmitted` and a loop's `pathOmitted` count what the domain's caps left
// off, and are absent when that is nothing.
Json::Value toJson(const TreeDiagnostics& diagnostics, const PointerDiagnostics& pointers);
Json::Value toJson(const TreeSummary& summary);   // one registry row, as GET /v1/trees and MCP list_trees answer it
// `openers` of a GET /v1/trees row, in the order given: one {treeId, steps} each.
Json::Value toJson(const std::vector<OpeningSteps>& openers);
// What went with a removed tree, as DELETE /v1/trees/{id} and MCP delete_tree answer it: `removed`, one
// {treeId, nodeIds} per tree edited, and `incomplete`, the ids of the trees left with their steps, only when there is one.
Json::Value toJson(const Cascade& cascade);
// `opens` of GET /v1/trees/{id}, by node id; `loop` marks an opening whose tree is among `leadingBack`.
Json::Value toJson(const std::map<NodeId, Opening>& openings, const std::set<TreeId>& leadingBack);
// `guides` of GET /v1/trees/{id}/guides and of MCP get_tree, in the order given: one {treeId, title, text, yours} each.
Json::Value toJson(const std::vector<Guide>& guides);
Json::Value toJson(const GalleryEntry& entry);    // one gallery card (GET /v1/gallery)
Json::Value toJson(const GraphState& state);    // the persisted graph document
Json::Value toJson(const LegendState& legend);  // the persisted legend document

// nullopt when the root is not an object, or when a field is present but the wrong type. A document
// never sets the guide: it rides out with a tree and is written only through its own doors.
std::optional<TreeData> treeFromJson(const Json::Value& root, const TreeId& id);
GraphState graphStateFromJson(const Json::Value& root);
LegendState legendStateFromJson(const Json::Value& kinds);

// A link may arrive as an object {url, label?} or as a bare url string (label defaults to empty).
Json::Value linksToJson(const std::vector<Link>& links);
std::vector<Link> linksFromJson(const Json::Value& array);

}
