#pragma once

#include "products/roadmap/domain/Graft.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/Tree.h"

#include <cstddef>
#include <map>
#include <optional>
#include <string>
#include <string_view>
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
constexpr std::size_t kMaxGuideChars = 5000;             // a roadmap's guide: what it is, how to work it
constexpr std::size_t kMaxKinds = 6;                     // legend kinds per tree (one per hue)
constexpr std::size_t kMaxKindLabelLength = 24;          // a legend kind's label
constexpr std::size_t kMaxKindDescriptionLength = 80;    // a kind's sorting brief
// The most bytes one message on the tree socket carries. packages/api-contract/roadmap-socket.json names it, the
// server sets the framework's inbound limit to it (platform/infra/main.cpp), and the web client packs its frames
// under it. A node entry always fits a message of its own: every capped text at six bytes a character, the most JSON
// spends on one, with room for its keys and stamps.
constexpr std::size_t kMaxSocketMessageBytes = 1024 * 1024;
static_assert(6 * (2 * kMaxIdLength + kMaxNodeLabelLength + kMaxIconLength + kMaxNodeDescriptionLength +
                   kMaxNodeLinks * (kMaxLinkLabelLength + kMaxLinkUrlLength)) + 4096 < kMaxSocketMessageBytes);

// The one reading of "characters" every cap is held to: UTF-8 code points, so a CJK character or
// an emoji counts once. byteOffsetOfCodePoint is where code point `index` (zero-based) starts, or
// npos when the text holds no more than `index` of them — the cut a truncation makes. Both count
// only valid text: every door that holds a cap refuses malformed UTF-8 first (isValidUtf8 — no
// overlong form, no surrogate, nothing past U+10FFFF, no lone or missing continuation byte), with
// the clause `<field> is not valid UTF-8`, so a byte sequence Postgres would reject never reaches
// a live room. It then refuses a NUL, which a Postgres text value ends at, with the clause
// `<field> contains a NUL character`, so a room never holds text its row would cut short.
bool isValidUtf8(const std::string& bytes);
std::size_t codePointCount(const std::string& utf8);
std::size_t byteOffsetOfCodePoint(const std::string& utf8, std::size_t index);

struct RenameNode { NodeId id; std::string label; };
struct SetNodeColor { NodeId id; NodeColor color; };
struct CreateNode {
  NodeId id;
  std::string label;
  std::string icon;
  NodeColor color = NodeColor::terracotta;
  std::vector<NodeId> prerequisites;
  std::string description;
  std::vector<Link> links;
  // The tree the node opens. Set, it is written, and an empty id opens none: a create on an id a
  // deleted node held then keeps nothing of that node's pointer. Unset, the register is left.
  std::optional<TreeId> opens;
};
// Set a node's free annotation. Each field is optional: a nullopt leaves that register untouched.
// `description` replaces the body; `appendDescription` joins onto it after a blank line (or opens
// it when it is empty) — a command carries one of the two at most, and the cap is held against the
// body the node would then have. An empty `icon` clears it, and an empty `opens` leaves the node
// opening no tree.
struct AnnotateNode {
  NodeId id;
  std::optional<std::string> description;
  std::optional<std::vector<Link>> links;
  std::optional<std::string> icon;
  std::optional<std::string> appendDescription;
  std::optional<TreeId> opens;
};
struct AddEdge { NodeId from; NodeId to; };
struct RemoveEdge { NodeId from; NodeId to; };
struct ReconnectEdge { NodeId oldFrom; NodeId oldTo; NodeId newFrom; NodeId newTo; };
struct DeleteNode { NodeId id; };
// Written by nothing; a stored row of any of these still decodes, for the Activity feed, and lands nothing where it
// is merged. A node holds no position, so a RepositionNode row has nothing to set.
struct RepositionNode {};
struct TransitiveReduction {};
struct PruneDangling {};

// Legend commands, on the same op log / undo / broadcast machinery as the node/edge commands.
// RecolorKind is atomic: it swaps a kind's hue *and* repaints every node wearing the old hue.
struct RenameKind { KindId id; std::string label; };
// A description it carries is written. A stored row that carried none sets nothing, and the feed skips it.
struct DescribeKind { KindId id; std::optional<std::string> description; };
// A kind's label and description may be seeded inline at creation, so a legend entry lands in one op.
struct AddKind { KindId id; NodeColor hue; std::string label; std::string description; };
struct RemoveKind { KindId id; };
struct ReorderKinds { std::vector<KindId> order; };
struct RecolorKind { KindId id; NodeColor hue; };

// The present nodes wearing the hue the legend holds for `kind`: the nodes a receipt counts as repainted.
std::vector<NodeId> wearersOf(const LooseGraph& graph, const Legend& legend, const KindId& kind);

// The nodes a recolor of `kind` repaints: its wearers, and the deleted nodes that hold its hue, so a deleted node moves
// with its kind and one brought back is under it. RecolorKind and an import that re-hues a held kind repaint by this
// one rule.
std::vector<NodeId> holdersOf(const LooseGraph& graph, const Legend& legend, const KindId& kind);

// Several commands that landed as ONE frame under one seq, logged whole so the op row tells the frame
// and not just its first deed. Every member folds at the batch's own stamp.
struct Batch;

using Command = std::variant<RenameNode, SetNodeColor, RepositionNode, CreateNode, AnnotateNode,
                             AddEdge, RemoveEdge, ReconnectEdge, DeleteNode, TransitiveReduction,
                             PruneDangling, RenameKind, DescribeKind, AddKind, RemoveKind,
                             ReorderKinds, RecolorKind, Batch>;

struct Batch { std::vector<Command> commands; };

constexpr std::size_t kMaxPatchNodes = 200;
constexpr std::size_t kMaxChangeEdges = 500;

// One row of a node batch. `appendDescription` joins onto the description the node holds and `addLinks` onto its links,
// each judged against the node as the batch finds it; a row sends neither beside the field it extends.
struct NodePatch {
  NodeId nodeId;
  std::optional<std::string> label;
  std::optional<std::string> icon;
  std::optional<std::string> description;
  std::optional<std::string> appendDescription;
  HueChoice hue;
  std::optional<std::vector<Link>> links;
  std::optional<std::vector<Link>> addLinks;
  std::optional<TreeId> opens;  // an empty id clears the tree the node opens
};

// A plan lands nothing when no row changes what its node holds: the batch is empty, so it takes no seq.
struct NodePatchPlan {
  Batch batch;
  std::vector<NodeId> changedNodeIds;

  bool landsNothing() const { return batch.commands.empty(); }
};

struct EdgeChanges {
  std::vector<Edge> add;
  std::vector<Edge> remove;
};

// A plan lands nothing when every edge it adds is held and every edge it removes is absent.
struct EdgeChangePlan {
  Batch batch;
  std::vector<Edge> added;
  std::vector<Edge> removed;

  bool landsNothing() const { return batch.commands.empty(); }
};

// The part of a single-node edit that lands on the node it names: the command with only the fields that hold
// another value there, or nothing when none does. An appended description always lands, and any other command lands
// whole. A patch row and a single-node verb land by this one rule, so an annotation stamps only the registers it
// changes, as an import does.
std::optional<Command> changedPart(const NodeSpec& node, const Command& command);

// A refusal is its sentence, or the KindRefusal of the row whose `kind` refused the batch. A row's links are judged
// against the ones its node holds (shownLinks). A row's `opens` on a step of `owned`, the subtree each step owns, plans
// nothing: such a step's pointer takes no write (SPEC.md, Model, Legacy pointers).
std::variant<NodePatchPlan, std::string, KindRefusal> planNodePatches(
    const LooseGraph& graph, const Legend& legend, const std::vector<NodePatch>& updates,
    const std::map<NodeId, TreeId>& owned);
// The edges a change lands, as one command each — or, when they are one edge removed and one added that keeps its
// source or its target, as the one ReconnectEdge that moves an edge, as a lone change lands as its own command.
std::variant<EdgeChangePlan, std::string> planEdgeChanges(
    const LooseGraph& graph, const EdgeChanges& changes);

// An update of one legend kind: the fields it sends, each optional.
struct KindUpdate {
  KindId id;
  std::optional<std::string> label;
  std::optional<std::string> description;
  std::optional<NodeColor> hue;
};

// What a kind update lands: one command per field that holds another value on the kind — RenameKind, DescribeKind,
// RecolorKind, in that order — and, when the hue changes, how many present nodes it repaints (wearersOf). It lands
// nothing when every field sent is the one the kind holds.
struct KindUpdatePlan {
  std::vector<Command> commands;
  std::optional<std::size_t> repaintedNodes;

  bool landsNothing() const { return commands.empty(); }
};

// Each field sent is validated as its own command is — RenameKind, DescribeKind, RecolorKind — so an unknown kind, a
// taken hue or a field over its cap is refused in that command's words; an update that sends no field is refused naming
// all three.
std::variant<KindUpdatePlan, std::string> planKindUpdate(const LooseGraph& graph, const Legend& legend,
                                                         const KindUpdate& update);

// A link url a person can open, as a node holds it: surrounding ASCII whitespace trimmed, then starting with http:,
// https: or mailto: in any case — the schemes the web shows (packages/api-contract/roadmap-link-urls.json). Nothing
// when the url is not one.
std::optional<std::string> shownLinkUrl(std::string_view url);

// The links a write sends to a node that holds `held`, as the node would hold them. A url the node holds byte for byte
// is kept as it is, unjudged and untrimmed: what is sent as held is not the write's word. Every other is trimmed and
// must be one a person can open, or the write is refused naming it under `path` (`links`, `nodes[0].links`) by its
// index and saying which schemes are taken, never echoing the url.
std::variant<std::vector<Link>, std::string> shownLinks(const std::vector<Link>& held, std::vector<Link> sent,
                                                        const std::string& path);

// `held` with `added` joined on in the order sent, each judged as shownLinks judges it. A link's identity is its url
// trimmed, so an added url names the held link that trims to it, which keeps its place, takes a sent label and holds
// the trimmed url from then on; a held url the rule refuses is named only byte for byte.
std::variant<std::vector<Link>, std::string> withLinksAdded(const std::vector<Link>& held,
                                                            const std::vector<Link>& added, const std::string& path);

void merge(LooseGraph& graph, Legend& legend, const Command& command, const Hlc& at);

// Server-authoritative validation before a command is admitted to the log. A graph command is
// refused only for a malformed or over-cap field, for a create that would take the tree past its node
// ceiling or, by the edges its prerequisites add, its edge ceiling, or — for an edit of one node's
// registers (rename, recolor, annotate) — an id no present node carries, with the sentence
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
  bool operator==(const Admission&) const = default;
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
// The kinds a new tree is sent to be born with (Legend::bornWith), in the words create_tree answers: at least one when
// sent, at most kMaxKinds, each id non-empty and every field within its cap, an id and a hue once each.
std::optional<Admission> admitBornKinds(const std::vector<Kind>& kinds);
// `incoming` joined onto a legend holding `current`, an incoming row replacing the kind of its id: no hue is worn by two
// kinds, and the legend holds at most kMaxKinds.
std::optional<Admission> admitMergedKinds(const std::vector<Kind>& current, const std::vector<Kind>& incoming);
// A tree register's one bound: valid UTF-8 with no NUL, within its cap. Past it is malformed, never truncated.
std::optional<Admission> admitTitle(const std::string& title);
std::optional<Admission> admitGuide(const std::string& guide);
// A guide of only spaces, tabs and line breaks is no guide. A door that stamps the guide itself stores
// it as ""; a guide that arrives already stamped, in a frame, cannot be stored other than as sent, so
// admitStampedGuide refuses it beside admitGuide's bounds.
bool isBlankGuide(const std::string& guide);
std::optional<Admission> admitStampedGuide(const std::string& guide);

// The single feed-worthy deed a subgraph delta represents, read off which lattice fields it sets: a room hands it what
// landed of a frame, so an echoed register names nothing. Salience order: a node's own life, then legend deeds, then a
// node's fields, then edges. A frame that sets none of these is nullopt. A deed states the registers that landed, but
// for the one that brings a node or a kind into being — its creation stamp landed, a create or a revive: that deed
// carries the name, icon and hue `graph` and `legend`, which have joined the delta, hold for it, whatever of them the
// frame echoed, since the feed reads a node that is gone again by the name its row kept.
std::optional<Command> headline(const GraphState& landed, const LegendState& landedLegend, const LooseGraph& graph,
                                const Legend& legend);

}
