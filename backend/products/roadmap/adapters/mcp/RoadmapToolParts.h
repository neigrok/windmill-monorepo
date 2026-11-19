#pragma once

#include "platform/ports/ToolHost.h"
#include "products/roadmap/domain/Subtree.h"
#include "products/roadmap/domain/Access.h"
#include "products/roadmap/domain/Graft.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/Tree.h"

#include <json/json.h>

#include <cstddef>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <variant>
#include <vector>

// What roadmap's two tool hosts say alike, the one over rooms (RoadmapTools) and the one through the engine's door
// (RoadmapDoorTools): the checks of a call's arguments that read no tree, the marks a call carries, and the words a
// refusal and a receipt are written in.

namespace wm {

inline constexpr char kSeedStatusMoved[] =
    ".status is your own mark on this surface, not the document's — the authored baseline every "
    "reader sees is \"seedStatus\", and your own progress goes in \"progress\": [{nodeId, status}].";

std::string writeRefusalSentence(WriteRefusal refusal);

// A refused `kind` completes under the code of its reason, so a caller naming a kind the legend lacks, or
// creating a node that names none where it must, is told apart from a malformed call; the code never carries
// the kind or the node it named.
ToolResult kindRefused(const KindRefusal& refusal);

std::optional<std::string> commandKindFor(const std::string& tool);

bool namesAnExistingKind(const std::string& tool);

// `prefix` is blank at the top level and "nodes[3]." inside a list. A node's label, icon and
// description are typed here and capped by the domain — validate() for a command, admit() for a
// graft — whose one sentence names every field over its cap and, for an append, the body the node
// would hold.
std::optional<std::string> checkAnnotation(const Json::Value& node, const std::string& prefix);

// A legend kind id a node write files the node under; which kinds exist is the room's to say.
std::optional<std::string> optionalKind(const Json::Value& value, const std::string& path);

Json::Value progressStatusArgument(const Json::Value& value);

// Each register an imported node or kind may leave out, by its name on this surface: a node's
// `seedStatus` is the document's `status`.
inline constexpr std::pair<const char*, NodeRegister> kImportedNodeRegisters[] = {
    {"label", NodeRegister::label},             {"icon", NodeRegister::icon},
    {"color", NodeRegister::color},             {"order", NodeRegister::order},
    {"seedStatus", NodeRegister::status},       {"description", NodeRegister::description},
    {"links", NodeRegister::links},             {"opens", NodeRegister::opens}};

inline constexpr std::pair<const char*, KindRegister> kImportedKindRegisters[] = {
    {"label", KindRegister::label},
    {"description", KindRegister::description}};

// `expectedSeq`, when a batch tool is sent one: a non-negative integer, the revision read from get_tree or get_nodes.
std::optional<std::string> checkExpectedSeq(const Json::Value& args);

std::optional<std::string> checkImportedNode(const Json::Value& node, const std::string& path);

// A pointer a call sends a step: the argument path that names it, the step and the tree it names, an empty id for none.
struct SentPointer {
  std::string path;
  NodeId step;
  TreeId tree;
};

// What a receipt says of the pointers its call sent steps that own a subtree: each id in `opensRefused`, the rest of the
// call applied, and what to do instead in `opensError`. Nothing for a call none of whose pointers was refused.
void answerRefusedPointers(const std::vector<NodeId>& refused, Json::Value& receipt);

// Both `nodeId` and `id` land on payload["id"]; runs before commandFromJson decodes.
std::optional<std::string> prepareEdit(const std::string& tool, Json::Value& payload);

// `"a", "b", "c"` — every offender in one sentence, so one round-trip fixes the batch.
std::string quotedList(const std::vector<std::string>& ids);

// The subtrees a call names in `branches` (SPEC.md, Model, Subtrees): a list of at most `cap` tree ids.
std::variant<std::set<TreeId>, std::string> branchesOf(const Json::Value& args, std::size_t cap);

// One mark as the caller asked for it. `outOfOrder` is their word that completing the node before
// its prerequisites is meant; it lands on the row beside the status.
struct RequestedMark {
  NodeId node;
  ProgressStatus status;
  bool outOfOrder = false;
};

// A way the marks a write carries beside its tree edit fell short, said in the receipt's `progressError` after any
// said before it, the receipt answering progressApplied: false.
void fellShort(Json::Value& receipt, const std::string& sentence);

// What a batch of marks came to, as its tool answers it.
struct MarkedBatch {
  Json::Value results{Json::arrayValue};  // a row per mark that named a node, in the batch's order
  Json::Value skipped{Json::arrayValue};  // ids naming no node in the tree
  Json::Value refused{Json::arrayValue};  // ids of nodes that follow the tree they open and took no mark
  bool cameToARefusal = false;            // no mark was recorded and at least one was refused
  bool changed = false;                   // a row recorded a mark the caller did not hold

  // The marks as a write that carries them beside its tree edit answers them — an import's `progress[]`, update_nodes'
  // marks: a row each in `progress`, and the ids skipped or refused listed, each said in `progressError`. `unchanged`
  // says the whole call changed nothing, so a receipt whose tree edit landed nothing stops saying it beside a row that
  // recorded a mark.
  void answerOnto(Json::Value& receipt) const {
    receipt["progress"] = results;
    if (changed) receipt.removeMember("unchanged");
    if (!skipped.empty()) {
      receipt["progressSkipped"] = skipped;
      fellShort(receipt, "Some requested progress names nodes absent after the graft; those ids are listed in "
                         "progressSkipped.");
    }
    if (!refused.empty()) {
      receipt["progressRefused"] = refused;
      fellShort(receipt, "Some requested progress marks nodes that open a tree, which take no mark of their own — each "
                         "is complete when the tree it opens is; those ids are listed in progressRefused.");
    }
  }
};

// One progress row as a write sends it: `nodeId` (or the legacy `id`), `status`, and `outOfOrder`, a word about a
// completion that rides only a `complete` status. An update_nodes row and an import's progress row are read by this,
// so each takes the same checks; `path` names the row in a refusal.
std::variant<RequestedMark, std::string> readMark(const Json::Value& row, const std::string& path);

// A legend's kinds as a call sends them, checked item by item before treeFromJson reads them, an id once
// per list; `limit` caps the items when the list is the whole legend, 0 when it joins one.
std::optional<std::string> checkKinds(const Json::Value& kinds, std::size_t limit);

// Checked before treeFromJson reads it: the decoder indexes each item as an object.
std::optional<std::string> checkImport(const Json::Value& args);

// One `nodeId` (or its `id` alias) or a `nodeIds` list, never both, never neither.
std::optional<std::string> deleteTargets(const Json::Value& args, std::vector<NodeId>& out);

// The words each refusal of a subtree's create is answered in, under its code; an absent tree's are every read's, so a
// tree the caller may not read is answered as one that is not there, and one they may read and not write as every write
// tool answers it.
std::string subtreeRefusalSentence(SubtreeRefusal refusal, const TreeId& tree, const NodeId& step);

}
