#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/Tree.h"

#include <cstddef>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace wm {

// Admission bounds, enforced by validate() for a single command and admit() for a graph that
// arrives whole, and published as `maxLength` by the surfaces that take them.
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
// Set a node's free annotation. Each field is optional: a nullopt leaves that register untouched.
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
// Drop every edge no valid DAG keeps — self-edges and edges to/from an absent node — in one op.
struct PruneDangling {};

// Legend commands, on the same op log / undo / broadcast machinery as the node/edge commands.
// RecolorKind is atomic: it swaps a kind's hue *and* repaints every node wearing the old hue.
struct RenameKind { KindId id; std::string label; };
struct DescribeKind { KindId id; std::string description; };
// A kind's label and description may be seeded inline at creation, so a legend entry lands in one op.
struct AddKind { KindId id; NodeColor hue; std::string label; std::string description; };
struct RemoveKind { KindId id; };
struct ReorderKinds { std::vector<KindId> order; };
struct RecolorKind { KindId id; NodeColor hue; };

using Command = std::variant<RenameNode, SetNodeColor, RepositionNode, CreateNode, AnnotateNode,
                             AddEdge, RemoveEdge, ReconnectEdge, DeleteNode, TransitiveReduction,
                             PruneDangling, RenameKind, DescribeKind, AddKind, RemoveKind,
                             ReorderKinds, RecolorKind>;

void merge(LooseGraph& graph, Legend& legend, const Command& command, const Hlc& at);

// Server-authoritative validation, at the edge before a command is admitted to the log. Graph
// commands are never rejected (nullopt); legend commands may be, because their invariants — hue
// uniqueness, ≤6 kinds, no in-use removal, length caps — are locally decidable. The string is a
// human-readable reason.
std::optional<std::string> validate(const LooseGraph& graph, const Legend& legend, const Command& command);

// The same bounds for the arrivals that mint no Command and so are never seen by validate(). A
// refusal names the id, the value and the limit, and says which KIND it is — an HTTP door owes 413
// to a document merely too big and 400 to one whose field is malformed.
struct Admission {
  enum class Verdict { tooLarge, malformed };
  Verdict verdict;
  std::string reason;
};
std::optional<Admission> admit(const TreeData& document);
// A join: the caps are read off what the graph would HOLD once the arrival lands. The join is
// performed, never estimated from the arriving stamps alone.
std::optional<Admission> admit(const LooseGraph& graph, const TreeData& incoming);
std::optional<Admission> admit(const LooseGraph& graph, const GraphState& incoming);
std::optional<Admission> admit(const Legend& legend, const LegendState& incoming);
std::optional<Admission> admitTitle(const std::string& title);

// The single feed-worthy deed a subgraph delta represents, read off which lattice fields the frame
// sets. Salience order: a node's own life, then legend deeds, then a node's fields, then edges. A
// position-only or empty frame is nullopt.
std::optional<Command> headline(const GraphState& graph, const LegendState& legend);

}
