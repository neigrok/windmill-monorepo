#pragma once

#include "domain/Ids.h"
#include "domain/LooseGraph.h"
#include "domain/Tree.h"

#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace wm {

struct RenameNode { NodeId id; std::string label; };
struct SetNodeColor { NodeId id; NodeColor color; };
struct RepositionNode { NodeId id; Vec2 position; };
struct CreateNode {
  NodeId id;
  std::string label;
  std::string icon;
  NodeColor color = NodeColor::terracotta;
  std::optional<NodeId> parent;
  std::optional<Vec2> position;
};
struct AddEdge { NodeId from; NodeId to; };
struct RemoveEdge { NodeId from; NodeId to; };
struct ReconnectEdge { NodeId oldFrom; NodeId oldTo; NodeId newFrom; NodeId newTo; };
struct DeleteNode { NodeId id; };
struct TransitiveReduction {};

using Command = std::variant<RenameNode, SetNodeColor, RepositionNode, CreateNode,
                             AddEdge, RemoveEdge, ReconnectEdge, DeleteNode, TransitiveReduction>;

void merge(LooseGraph& graph, const Command& command, const Hlc& at);

// The inverse of a command, evaluated against the state *before* it merged. A no-op
// command (e.g. re-adding an edge that already existed) inverts to an empty sequence.
std::vector<Command> invert(const LooseGraph& before, const Command& command);

}
