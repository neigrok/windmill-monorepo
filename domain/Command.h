#pragma once

#include "domain/Ids.h"
#include "domain/Legend.h"
#include "domain/LooseGraph.h"
#include "domain/Tree.h"

#include <cstddef>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace wm {

// Admission bounds, enforced by validate() at the edge — and published as `maxLength` by the
// surfaces that take them (adapters/mcp), which is why they are stated once, here.
constexpr std::size_t kMaxIdLength = 128;               // node / tree id length in bytes
constexpr std::size_t kMaxNodeLabelLength = 200;        // node display-label length in bytes
constexpr std::size_t kMaxIconLength = 64;              // node icon token length in bytes
constexpr std::size_t kMaxNodeDescriptionLength = 4000; // node annotation body length in bytes
constexpr std::size_t kMaxNodeLinks = 32;               // external references per node
constexpr std::size_t kMaxLinkLabelLength = 200;        // a link's display-text length in bytes
constexpr std::size_t kMaxLinkUrlLength = 2048;         // a link's url length in bytes
constexpr std::size_t kMaxNodes = 10000;                // present nodes admitted per tree
constexpr std::size_t kMaxEdges = 20000;                // present edges admitted per tree
constexpr std::size_t kMaxTitleChars = 200;             // a roadmap's name (TreeRegistry truncates)
constexpr std::size_t kMaxKinds = 6;                    // legend kinds per tree (one per hue)
constexpr std::size_t kMaxKindLabelLength = 24;         // a legend kind's label length in bytes
constexpr std::size_t kMaxKindDescriptionLength = 80;   // a kind's sorting brief, in bytes

struct RenameNode { NodeId id; std::string label; };
struct SetNodeColor { NodeId id; NodeColor color; };
struct RepositionNode { NodeId id; Vec2 position; };
struct CreateNode {
  NodeId id;
  std::string label;
  std::string icon;
  NodeColor color = NodeColor::terracotta;
  std::vector<NodeId> prerequisites;
  std::optional<Vec2> position;
  std::string description;
  std::vector<Link> links;
};
// Set a node's free annotation. Each field is optional: a nullopt leaves that register
// untouched, so description and links can be set together or one at a time.
struct AnnotateNode {
  NodeId id;
  std::optional<std::string> description;
  std::optional<std::vector<Link>> links;
};
struct AddEdge { NodeId from; NodeId to; };
struct RemoveEdge { NodeId from; NodeId to; };
struct ReconnectEdge { NodeId oldFrom; NodeId oldTo; NodeId newFrom; NodeId newTo; };
struct DeleteNode { NodeId id; };
struct TransitiveReduction {};
// Drop every edge no valid DAG keeps — self-edges and edges to/from an absent node — in one
// op. The GC twin of TransitiveReduction: a semantics-preserving cleanup of the loose graph.
struct PruneDangling {};

// Legend (§F6) commands. They ride the same op log / undo / broadcast machinery as the
// node/edge commands. RecolorKind is atomic: it swaps a kind's hue *and* repaints every
// node wearing the old hue, in one op and one undo step.
struct RenameKind { KindId id; std::string label; };
struct DescribeKind { KindId id; std::string description; };
// A kind's label and description may be seeded inline at creation, so a legend entry lands
// in one op instead of add + rename + describe.
struct AddKind { KindId id; NodeColor hue; std::string label; std::string description; };
struct RemoveKind { KindId id; };
struct ReorderKinds { std::vector<KindId> order; };
struct RecolorKind { KindId id; NodeColor hue; };

using Command = std::variant<RenameNode, SetNodeColor, RepositionNode, CreateNode, AnnotateNode,
                             AddEdge, RemoveEdge, ReconnectEdge, DeleteNode, TransitiveReduction,
                             PruneDangling, RenameKind, DescribeKind, AddKind, RemoveKind,
                             ReorderKinds, RecolorKind>;

void merge(LooseGraph& graph, Legend& legend, const Command& command, const Hlc& at);

// Server-authoritative validation, checked at the edge before a command is admitted to
// the log. Graph commands are never rejected (nullopt); legend commands may be, because
// their invariants — hue uniqueness, ≤6 kinds, no in-use removal, length caps — are
// locally decidable on the authoritative state. The string is a human-readable reason.
std::optional<std::string> validate(const LooseGraph& graph, const Legend& legend, const Command& command);

// The single feed-worthy deed a subgraph delta represents — the coarse inverse of merge(),
// read off which lattice fields the frame sets. A client authors in subgraphs, not commands
// (§ "only lattice effects cross a replica boundary"), so the activity feed reconstructs the
// headline here from the effects, then renders it through the one command-based feed vocabulary
// the agent path already uses. Salience order: a node's own life, then legend deeds (which fan
// out to node fields), then a node's fields, then edges. A position-only or empty frame is a
// nudge, not a deed — nullopt.
std::optional<Command> headline(const GraphState& graph, const LegendState& legend);

}
