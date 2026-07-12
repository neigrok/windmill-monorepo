#pragma once

#include "domain/Ids.h"
#include "domain/Legend.h"
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

// Legend (§F6) commands. They ride the same op log / undo / broadcast machinery as the
// node/edge commands. RecolorKind is atomic: it swaps a kind's hue *and* repaints every
// node wearing the old hue, in one op and one undo step.
struct RenameKind { KindId id; std::string label; };
struct DescribeKind { KindId id; std::string description; };
struct AddKind { KindId id; NodeColor hue; };
struct RemoveKind { KindId id; };
struct ReorderKinds { std::vector<KindId> order; };
struct RecolorKind { KindId id; NodeColor hue; };

using Command = std::variant<RenameNode, SetNodeColor, RepositionNode, CreateNode,
                             AddEdge, RemoveEdge, ReconnectEdge, DeleteNode, TransitiveReduction,
                             RenameKind, DescribeKind, AddKind, RemoveKind, ReorderKinds, RecolorKind>;

void merge(LooseGraph& graph, Legend& legend, const Command& command, const Hlc& at);

// The inverse of a command, evaluated against the state *before* it merged. A no-op
// command (e.g. re-adding an edge that already existed) inverts to an empty sequence.
std::vector<Command> invert(const LooseGraph& graph, const Legend& legend, const Command& command);

// Server-authoritative validation, checked at the edge before a command is admitted to
// the log. Graph commands are never rejected (nullopt); legend commands may be, because
// their invariants — hue uniqueness, ≤6 kinds, no in-use removal, length caps — are
// locally decidable on the authoritative state. The string is a human-readable reason.
std::optional<std::string> validate(const LooseGraph& graph, const Legend& legend, const Command& command);

}
