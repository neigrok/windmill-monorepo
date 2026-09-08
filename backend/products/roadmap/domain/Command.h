#pragma once

#include "products/roadmap/domain/Graft.h"
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
// arrives whole, and published as `maxLength` by the surfaces that take them. Every length is
// counted in characters — Unicode code points, by codePointCount() — never bytes.
constexpr std::size_t kMaxIdLength = 128;                // node / tree id
constexpr std::size_t kMaxNodeLabelLength = 200;         // node display label
constexpr std::size_t kMaxIconLength = 64;               // node icon token
constexpr std::size_t kMaxNodeDescriptionLength = 16000; // node annotation body
constexpr std::size_t kMaxNodeLinks = 32;                // external references per node
constexpr std::size_t kMaxLinkLabelLength = 200;         // a link's display text
constexpr std::size_t kMaxLinkUrlLength = 2048;          // a link's url
constexpr std::size_t kMaxNodes = 10000;                 // present nodes admitted per tree
constexpr std::size_t kMaxEdges = 20000;                 // present edges admitted per tree
constexpr std::size_t kMaxTitleChars = 200;              // a roadmap's name (TreeRegistry truncates)
constexpr std::size_t kMaxKinds = 6;                     // legend kinds per tree (one per hue)
constexpr std::size_t kMaxKindLabelLength = 24;          // a legend kind's label
constexpr std::size_t kMaxKindDescriptionLength = 80;    // a kind's sorting brief

// The one reading of "characters" every cap is held to: UTF-8 code points, so a CJK character or
// an emoji counts once. byteOffsetOfCodePoint is where code point `index` (zero-based) starts, or
// npos when the text holds no more than `index` of them — the cut a truncation makes. Both count
// only valid text: every door that holds a cap refuses malformed UTF-8 first (isValidUtf8 — no
// overlong form, no surrogate, nothing past U+10FFFF, no lone or missing continuation byte), with
// the clause `<field> is not valid UTF-8`, so a byte sequence Postgres would reject never reaches
// a live room.
bool isValidUtf8(const std::string& bytes);
std::size_t codePointCount(const std::string& utf8);
std::size_t byteOffsetOfCodePoint(const std::string& utf8, std::size_t index);

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
// `description` replaces the body; `appendDescription` joins onto it after a blank line (or opens
// it when it is empty) — a command carries one of the two at most, and the cap is held against the
// body the node would then have. An empty `icon` clears it.
struct AnnotateNode {
  NodeId id;
  std::optional<std::string> description;
  std::optional<std::vector<Link>> links;
  std::optional<std::string> icon;
  std::optional<std::string> appendDescription;
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
// Each register DescribeKind carries is written; one it leaves unset keeps the kind's value.
struct DescribeKind { KindId id; std::optional<std::string> description; std::optional<bool> crossBranchExempt; };
// A kind's label, description and cross-branch exemption may be seeded inline at creation, so a
// legend entry lands in one op.
struct AddKind { KindId id; NodeColor hue; std::string label; std::string description; bool crossBranchExempt = false; };
struct RemoveKind { KindId id; };
struct ReorderKinds { std::vector<KindId> order; };
struct RecolorKind { KindId id; NodeColor hue; };

// Several commands that landed as ONE frame under one seq, logged whole so a replay of the op row
// reproduces the frame and not just its first deed. Every member folds at the batch's own stamp.
struct Batch;

using Command = std::variant<RenameNode, SetNodeColor, RepositionNode, CreateNode, AnnotateNode,
                             AddEdge, RemoveEdge, ReconnectEdge, DeleteNode, TransitiveReduction,
                             PruneDangling, RenameKind, DescribeKind, AddKind, RemoveKind,
                             ReorderKinds, RecolorKind, Batch>;

struct Batch { std::vector<Command> commands; };

constexpr std::size_t kMaxPatchNodes = 200;
constexpr std::size_t kMaxChangeEdges = 500;

struct NodePatch {
  NodeId nodeId;
  std::optional<std::string> label;
  std::optional<std::string> icon;
  std::optional<std::string> description;
  std::optional<NodeColor> color;
  std::optional<Vec2> position;
  std::optional<std::vector<Link>> links;
};

struct NodePatchPlan {
  Batch batch;
  std::vector<NodeId> changedNodeIds;
};

struct EdgeChanges {
  std::vector<Edge> add;
  std::vector<Edge> remove;
};

struct EdgeChangePlan {
  Batch batch;
  std::vector<Edge> added;
  std::vector<Edge> removed;
};

std::variant<NodePatchPlan, std::string> planNodePatches(
    const LooseGraph& graph, const Legend& legend, const std::vector<NodePatch>& updates);
std::variant<EdgeChangePlan, std::string> planEdgeChanges(
    const LooseGraph& graph, const EdgeChanges& changes);

void merge(LooseGraph& graph, Legend& legend, const Command& command, const Hlc& at);

// Server-authoritative validation before a command is admitted to the log. A graph command is
// refused only for a malformed or over-cap field, or — for an edit of one node's registers
// (rename, recolor, move, annotate) — an id no present node carries, with the sentence
// `no node in this tree is named "x"`; legend commands may also be refused for hue uniqueness,
// ≤6 kinds and in-use removal. The string is a human-readable reason.
std::optional<std::string> validate(const LooseGraph& graph, const Legend& legend, const Command& command);

// The same bounds for arrivals that mint no Command and so are never seen by validate(). A refusal
// names the id, the value, the limit, and its KIND: 413 for a document merely too big, 400 for a
// malformed field.
struct Admission {
  enum class Verdict { tooLarge, malformed };
  Verdict verdict;
  std::string reason;
};
std::optional<Admission> admit(const TreeData& document);
// A join: the caps are read off what the graph would HOLD once the arrival lands. The join is
// performed, never estimated from the arriving stamps alone. A graft's tombstones and replaced
// edges count against its growth.
std::optional<Admission> admit(const LooseGraph& graph, const Graft& incoming);
// A document alone is a merge graft that tombstones nothing.
std::optional<Admission> admit(const LooseGraph& graph, const TreeData& incoming);
std::optional<Admission> admit(const LooseGraph& graph, const GraphState& incoming);
std::optional<Admission> admit(const Legend& legend, const LegendState& incoming);
std::optional<Admission> admitTitle(const std::string& title);

// The single feed-worthy deed a subgraph delta represents, read off which lattice fields the frame
// sets. Salience order: a node's own life, then legend deeds, then a node's fields, then edges. A
// position-only or empty frame is nullopt.
std::optional<Command> headline(const GraphState& graph, const LegendState& legend);

}
