#pragma once

#include "products/roadmap/domain/Gallery.h"
#include "products/roadmap/domain/GraphState.h"
#include "products/roadmap/domain/Guides.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/OpenedTrees.h"
#include "products/roadmap/domain/Subtree.h"
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
// The document as a node read answers it: each step among `subtrees` carries `subtree: {id, done, total, state}`, `state`
// "complete" or "open", or `{id}` alone where the owner's trees were not followed; no other step carries one.
Json::Value toJson(const TreeData& data, const std::map<NodeId, OwnedSubtree>& subtrees);
// Where a tree sits as GET /v1/trees/{id} answers it: `root`, `parent` as {tree, step} or null, `path` as
// [{tree, step, title}], root first, and `depth`. Its name is the document's title.
Json::Value toJson(const Place& place);
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
// What became of the steps that opened a removed tree (Cascade), as DELETE /v1/trees/{id} and MCP delete_tree answer it:
// `removed`, one {treeId, nodeIds} per tree whose steps were deleted and saved, and the ids in `unsaved` and
// `incomplete`, each present only when it holds a tree.
Json::Value toJson(const Cascade& cascade);
// What a tree's removal takes (BranchSize), as `branch` of a GET /v1/trees row and of a removal's answer:
// {subtrees, steps}.
Json::Value toJson(const BranchSize& branch);
// One owning step a write would remove unconfirmed: {step, subtree, steps, subtrees}, the counts of the subtree's own
// branch, the subtree's steps among them, and left out when they could not be read.
Json::Value toJson(const UnconfirmedBranch& branch, const std::optional<BranchSize>& size);
// A root's change aimed at a subtree, beside the door's own sentence: {code: "not-a-root", parent: {tree, step}, root}.
Json::Value toJson(const NotARoot& refusal);
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
