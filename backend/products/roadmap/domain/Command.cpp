#include "products/roadmap/domain/Command.h"

#include <cmath>
#include <cstddef>
#include <map>
#include <set>

namespace wm {

namespace {
template <class... Ts>
struct overloaded : Ts... { using Ts::operator()...; };
template <class... Ts>
overloaded(Ts...) -> overloaded<Ts...>;

std::string quoted(const std::string& value) { return "\"" + value + "\""; }

std::optional<std::string> countedOver(const std::string& what, std::size_t size, std::size_t limit) {
  if (size <= limit) return std::nullopt;
  return what + " is " + std::to_string(size) + " characters, max " + std::to_string(limit);
}

// Every per-node bound admit() enforces, wherever the node arrived from — a document's NodeSpec
// or a frame's NodeStateEntry. The id leads, and an over-long id is never quoted back: a 20KB id
// was the thing being refused, and echoing it would make the refusal as expensive as the request.
std::optional<std::string> nodeFieldBounds(const NodeId& id, const std::string& label, const std::string& icon,
                                           const std::string& description, const std::vector<Link>& links,
                                           const std::optional<Vec2>& position) {
  if (id.empty()) return "a node has an empty id";
  if (id.str().size() > kMaxIdLength)
    return "a node id is " + std::to_string(id.str().size()) + " characters, max " +
           std::to_string(kMaxIdLength);
  const std::string named = "node " + quoted(id.str()) + ": ";
  if (std::optional<std::string> bad = countedOver("label", label.size(), kMaxNodeLabelLength))
    return named + *bad;
  if (std::optional<std::string> bad = countedOver("icon", icon.size(), kMaxIconLength)) return named + *bad;
  if (std::optional<std::string> bad = countedOver("description", description.size(), kMaxNodeDescriptionLength))
    return named + *bad;
  if (links.size() > kMaxNodeLinks)
    return named + "carries " + std::to_string(links.size()) + " links, max " + std::to_string(kMaxNodeLinks);
  for (const Link& link : links) {
    if (std::optional<std::string> bad = countedOver("a link url", link.url.size(), kMaxLinkUrlLength))
      return named + *bad;
    if (std::optional<std::string> bad = countedOver("a link label", link.label.size(), kMaxLinkLabelLength))
      return named + *bad;
  }
  if (position && !(std::isfinite(position->x) && std::isfinite(position->y)))
    return named + "position is not finite";
  return std::nullopt;
}

// Every per-kind bound admit() enforces, wherever the kind arrived from — a document's Kind or a
// frame's KindStateEntry.
std::optional<std::string> kindFieldBounds(const KindId& id, const std::string& label,
                                           const std::string& description) {
  if (id.empty()) return "a kind has an empty id";
  if (id.str().size() > kMaxIdLength)
    return "a kind id is " + std::to_string(id.str().size()) + " characters, max " +
           std::to_string(kMaxIdLength);
  const std::string named = "kind " + quoted(id.str()) + ": ";
  if (std::optional<std::string> bad = countedOver("label", label.size(), kMaxKindLabelLength))
    return named + *bad;
  if (std::optional<std::string> bad = countedOver("description", description.size(), kMaxKindDescriptionLength))
    return named + *bad;
  return std::nullopt;
}

// The two whole-tree ceilings, read off the totals the arrival would leave behind. Stated last,
// after the field bounds, so a caller learns about a bad node before it learns about the size.
// A ceiling refuses GROWTH, not size: trees already past the caps exist — this very gap built
// them — and freezing one would leave its owner unable to rename, retire or thin it back down.
std::optional<Admission> growthWithin(std::size_t nodesBefore, std::size_t nodesAfter,
                                      std::size_t edgesBefore, std::size_t edgesAfter) {
  if (nodesAfter > kMaxNodes && nodesAfter > nodesBefore)
    return Admission{Admission::Verdict::tooLarge,
                     "this tree would hold " + std::to_string(nodesAfter) + " nodes, max " +
                         std::to_string(kMaxNodes) + " — split it across roadmaps, or delete what it has outgrown"};
  if (edgesAfter > kMaxEdges && edgesAfter > edgesBefore)
    return Admission{Admission::Verdict::tooLarge,
                     "this tree would hold " + std::to_string(edgesAfter) + " edges, max " +
                         std::to_string(kMaxEdges) + " — call tidy to drop the edges a longer path already implies"};
  return std::nullopt;
}
}

void merge(LooseGraph& graph, Legend& legend, const Command& command, const Hlc& at) {
  std::visit(overloaded{
    [&](const RenameNode& c) { graph.setLabel(c.id, c.label, at); },
    [&](const SetNodeColor& c) { graph.setColor(c.id, c.color, at); },
    [&](const RepositionNode& c) { graph.setPosition(c.id, c.position, at); },
    [&](const CreateNode& c) {
      graph.createNode(c.id, c.label, c.icon, c.color, c.position, at);
      if (!c.description.empty()) graph.setDescription(c.id, c.description, at);
      if (!c.links.empty()) graph.setLinks(c.id, c.links, at);
      for (const NodeId& prereq : c.prerequisites) graph.addEdge(prereq, c.id, at);
    },
    [&](const AnnotateNode& c) {
      if (c.description) graph.setDescription(c.id, *c.description, at);
      if (c.links) graph.setLinks(c.id, *c.links, at);
    },
    [&](const AddEdge& c) { graph.addEdge(c.from, c.to, at); },
    [&](const RemoveEdge& c) { graph.removeEdge(c.from, c.to, at); },
    [&](const ReconnectEdge& c) {
      graph.removeEdge(c.oldFrom, c.oldTo, at);
      graph.addEdge(c.newFrom, c.newTo, at);
    },
    [&](const DeleteNode& c) { graph.deleteNode(c.id, at); },
    [&](const TransitiveReduction&) {
      for (const auto& edge : graph.redundantEdges()) graph.removeEdge(edge.from, edge.to, at);
    },
    [&](const PruneDangling&) {
      for (const auto& edge : graph.danglingEdges()) graph.removeEdge(edge.from, edge.to, at);
    },
    [&](const RenameKind& c) { legend.setLabel(c.id, c.label, at); },
    [&](const DescribeKind& c) { legend.setDescription(c.id, c.description, at); },
    [&](const AddKind& c) {
      legend.addKind(c.id, c.hue, at);
      if (!c.label.empty()) legend.setLabel(c.id, c.label, at);
      if (!c.description.empty()) legend.setDescription(c.id, c.description, at);
    },
    [&](const RemoveKind& c) { legend.removeKind(c.id, at); },
    [&](const ReorderKinds& c) { legend.reorder(c.order, at); },
    [&](const RecolorKind& c) {
      std::optional<NodeColor> old = legend.hueOf(c.id);
      if (!old) return;
      legend.setHue(c.id, c.hue, at);
      for (const NodeId& node : graph.nodesWithColor(*old)) graph.setColor(node, c.hue, at);
    },
  }, command);
}

// A refusal names the thing it is about — the id, the value that clashed, who holds it, the limit
// that was reached — because the caller cannot see this state and must be able to act on the
// sentence alone. Every fact these messages quote is already in hand at the point of refusal; the
// old strings simply withheld it. Same words reach an MCP agent (with its tool name stamped on by
// adapters/mcp) and an HTTP client.
std::optional<std::string> validate(const LooseGraph& graph, const Legend& legend, const Command& command) {
  auto idBounds = [](const NodeId& id) -> std::optional<std::string> {
    if (id.empty()) return "node id is empty";
    if (id.str().size() > kMaxIdLength) return "node id is too long (max 128 characters)";
    return std::nullopt;
  };
  auto annotationBounds = [](const std::string* description,
                             const std::vector<Link>* links) -> std::optional<std::string> {
    if (description && description->size() > kMaxNodeDescriptionLength)
      return "description is too long (max 4000 characters)";
    if (!links) return std::nullopt;
    if (links->size() > kMaxNodeLinks) return "too many links (max 32)";
    for (const Link& link : *links) {
      if (link.url.size() > kMaxLinkUrlLength) return "a link url is too long (max 2048 characters)";
      if (link.label.size() > kMaxLinkLabelLength) return "a link label is too long (max 200 characters)";
    }
    return std::nullopt;
  };
  return std::visit(overloaded{
    [&](const CreateNode& c) -> std::optional<std::string> {
      if (auto bad = idBounds(c.id)) return bad;
      if (c.label.size() > kMaxNodeLabelLength) return "label is too long (max 200 characters)";
      if (c.icon.size() > kMaxIconLength) return "icon is too long (max 64 characters)";
      if (auto bad = annotationBounds(&c.description, &c.links)) return bad;
      if (c.position && !(std::isfinite(c.position->x) && std::isfinite(c.position->y)))
        return "position is not finite";
      if (!graph.hasNode(c.id) && graph.presentNodeCount() >= kMaxNodes)
        return "tree is at node capacity (" + std::to_string(kMaxNodes) +
               " nodes) — delete a node before adding another";
      return std::nullopt;
    },
    [&](const AnnotateNode& c) -> std::optional<std::string> {
      if (auto bad = idBounds(c.id)) return bad;
      return annotationBounds(c.description ? &*c.description : nullptr, c.links ? &*c.links : nullptr);
    },
    [&](const RenameNode& c) -> std::optional<std::string> {
      if (auto bad = idBounds(c.id)) return bad;
      if (c.label.size() > kMaxNodeLabelLength) return "label is too long (max 200 characters)";
      return std::nullopt;
    },
    [&](const RepositionNode& c) -> std::optional<std::string> {
      if (auto bad = idBounds(c.id)) return bad;
      if (!(std::isfinite(c.position.x) && std::isfinite(c.position.y))) return "position is not finite";
      return std::nullopt;
    },
    [&](const SetNodeColor& c) -> std::optional<std::string> { return idBounds(c.id); },
    [&](const DeleteNode& c) -> std::optional<std::string> { return idBounds(c.id); },
    [&](const AddEdge& c) -> std::optional<std::string> {
      if (auto bad = idBounds(c.from)) return bad;
      if (auto bad = idBounds(c.to)) return bad;
      if (!graph.edgePresent(c.from, c.to) && graph.presentEdgeCount() >= kMaxEdges)
        return "tree is at edge capacity (" + std::to_string(kMaxEdges) +
               " edges) — call tidy to drop the edges a longer path already implies";
      return std::nullopt;
    },
    [&](const RemoveEdge& c) -> std::optional<std::string> {
      if (auto bad = idBounds(c.from)) return bad;
      return idBounds(c.to);
    },
    [&](const ReconnectEdge& c) -> std::optional<std::string> {
      if (auto bad = idBounds(c.oldFrom)) return bad;
      if (auto bad = idBounds(c.oldTo)) return bad;
      if (auto bad = idBounds(c.newFrom)) return bad;
      return idBounds(c.newTo);
    },
    [&](const RenameKind& c) -> std::optional<std::string> {
      if (!legend.has(c.id)) return "no kind " + quoted(c.id.str()) + " in this legend";
      if (c.label.size() > kMaxKindLabelLength)
        return "label is " + std::to_string(c.label.size()) + " characters, max " +
               std::to_string(kMaxKindLabelLength);
      return std::nullopt;
    },
    [&](const DescribeKind& c) -> std::optional<std::string> {
      if (!legend.has(c.id)) return "no kind " + quoted(c.id.str()) + " in this legend";
      if (c.description.size() > kMaxKindDescriptionLength)
        return "description is " + std::to_string(c.description.size()) + " characters, max " +
               std::to_string(kMaxKindDescriptionLength);
      return std::nullopt;
    },
    [&](const AddKind& c) -> std::optional<std::string> {
      if (legend.has(c.id)) return "kind " + quoted(c.id.str()) + " already exists in this legend";
      if (legend.size() >= kMaxKinds)
        return "the legend is full (" + std::to_string(legend.size()) + " of " +
               std::to_string(kMaxKinds) + " kinds) — remove a kind before adding another";
      if (std::optional<KindId> owner = legend.ownerOf(c.hue))
        return "hue " + quoted(std::string(toString(c.hue))) + " already belongs to kind " +
               quoted(owner->str()) + " — a hue names one kind, so pick a free one";
      if (c.label.size() > kMaxKindLabelLength)
        return "label is " + std::to_string(c.label.size()) + " characters, max " +
               std::to_string(kMaxKindLabelLength);
      if (c.description.size() > kMaxKindDescriptionLength)
        return "description is " + std::to_string(c.description.size()) + " characters, max " +
               std::to_string(kMaxKindDescriptionLength);
      return std::nullopt;
    },
    [&](const RemoveKind& c) -> std::optional<std::string> {
      std::optional<NodeColor> hue = legend.hueOf(c.id);
      if (!hue) return "no kind " + quoted(c.id.str()) + " in this legend";
      if (!graph.hueInUse(*hue)) return std::nullopt;
      // Only the refusal pays for the count — the caller needs to know how much repainting the
      // removal is asking of it, which "kind is in use" never said.
      return "kind " + quoted(c.id.str()) + " is in use — " +
             std::to_string(graph.nodesWithColor(*hue).size()) + " node(s) still wear hue " +
             quoted(std::string(toString(*hue))) + "; recolor them first";
    },
    [&](const RecolorKind& c) -> std::optional<std::string> {
      if (!legend.has(c.id)) return "no kind " + quoted(c.id.str()) + " in this legend";
      std::optional<KindId> owner = legend.ownerOf(c.hue);
      if (owner && *owner != c.id)
        return "hue " + quoted(std::string(toString(c.hue))) + " already belongs to kind " +
               quoted(owner->str()) + " — a hue names one kind, so pick a free one";
      return std::nullopt;
    },
    [&](const auto&) -> std::optional<std::string> { return std::nullopt; },
  }, command);
}

std::optional<Admission> admitTitle(const std::string& title) {
  // Counted as UTF-8 codepoints, because kMaxTitleChars is a count of characters and a rename
  // truncates on the same reading — a byte cap here would refuse a hundred perfectly legal CJK
  // characters that the rename path happily keeps.
  std::size_t characters = 0;
  for (char byte : title)
    if ((static_cast<unsigned char>(byte) & 0xC0) != 0x80) ++characters;
  if (std::optional<std::string> bad = countedOver("the title", characters, kMaxTitleChars))
    return Admission{Admission::Verdict::malformed, *bad};
  return std::nullopt;
}

std::optional<Admission> admit(const TreeData& document) {
  if (std::optional<Admission> refusal = admitTitle(document.title)) return refusal;
  // A document's kinds REPLACE the legend rather than joining it (the posted document is the new
  // baseline), so the count is simply the list's own length.
  if (document.kinds.size() > kMaxKinds)
    return Admission{Admission::Verdict::tooLarge,
                     "this legend would hold " + std::to_string(document.kinds.size()) +
                         " kinds, max " + std::to_string(kMaxKinds) + " — remove a kind before adding another"};
  for (const Kind& kind : document.kinds)
    if (std::optional<std::string> bad = kindFieldBounds(kind.id, kind.label, kind.description))
      return Admission{Admission::Verdict::malformed, *bad};
  // A posted document IS the whole tree it describes, so it is judged as a graft into an empty
  // one — the counting rule lives in one place and the document path gets it for free. The tree
  // it lands ON is judged separately, by the caller holding that graph: a save GROWS a lattice
  // rather than replacing it, so one request's payload is never the whole of what the tree holds.
  return admit(LooseGraph{}, document);
}

std::optional<Admission> admit(const LooseGraph& graph, const TreeData& incoming) {
  // The ids and edges the batch would ADD, as sets: a document may name the same id — or the
  // same prerequisite — many times, and counting the repetitions once each refused legal
  // documents with a sentence that stated a number the tree would never have held.
  std::set<NodeId> arrivingNodes;
  std::set<Edge> arrivingEdges;
  for (const NodeSpec& node : incoming.nodes) {
    if (std::optional<std::string> bad =
            nodeFieldBounds(node.id, node.label, node.icon, node.description, node.links, node.position))
      return Admission{Admission::Verdict::malformed, *bad};
    if (!graph.hasNode(node.id)) arrivingNodes.insert(node.id);  // a graft upserts: a present id costs nothing
    for (const NodeId& prereq : node.prerequisites)
      if (!graph.edgePresent(prereq, node.id)) arrivingEdges.insert(Edge{prereq, node.id});
  }
  const std::size_t nodesBefore = graph.presentNodeCount();
  const std::size_t edgesBefore = graph.presentEdgeCount();
  return growthWithin(nodesBefore, nodesBefore + arrivingNodes.size(),
                      edgesBefore, edgesBefore + arrivingEdges.size());
}

std::optional<Admission> admit(const LooseGraph& graph, const GraphState& incoming) {
  // Run the element-set join itself — the graph's own life for each key, merged with every entry
  // the frame carries for it — instead of reading each entry's stamps and trusting them. An
  // estimate let a losing tombstone subtract from a count it never actually lowered, and let a
  // repeated id subtract once per repetition: 10000 nodes walked to 13600 over 45 acked frames,
  // with the drift never settling because the real count was re-read each time.
  std::map<NodeId, ElementSet> nodeLives;
  for (const NodeStateEntry& node : incoming.nodes) {
    if (std::optional<std::string> bad =
            nodeFieldBounds(node.id, node.label, node.icon, node.description, node.links, node.position))
      return Admission{Admission::Verdict::malformed, *bad};
    auto [life, fresh] = nodeLives.try_emplace(node.id);
    if (fresh) life->second = graph.lifeOf(node.id).value_or(ElementSet{});
    life->second.add(node.createdAt);
    life->second.remove(node.deletedAt);
  }
  std::map<Edge, ElementSet> edgeLives;
  for (const EdgeStateEntry& edge : incoming.edges) {
    auto [life, fresh] = edgeLives.try_emplace(edge.edge);
    if (fresh) life->second = graph.lifeOf(edge.edge).value_or(ElementSet{});
    life->second.add(edge.addedAt);
    life->second.remove(edge.removedAt);
  }

  // One key moves the count by at most one, in the direction the merge decided — so the total
  // can never be walked away from the truth, however the frame is shaped.
  std::size_t nodes = graph.presentNodeCount();
  for (const auto& [id, life] : nodeLives) {
    if (life.present() && !graph.hasNode(id)) ++nodes;
    else if (!life.present() && graph.hasNode(id)) --nodes;
  }
  std::size_t edges = graph.presentEdgeCount();
  for (const auto& [edge, life] : edgeLives) {
    if (life.present() && !graph.edgePresent(edge.from, edge.to)) ++edges;
    else if (!life.present() && graph.edgePresent(edge.from, edge.to)) --edges;
  }
  return growthWithin(graph.presentNodeCount(), nodes, graph.presentEdgeCount(), edges);
}

std::optional<Admission> admit(const Legend& legend, const LegendState& incoming) {
  // The legend rides the same frame the graph does and was judged by nobody: 200 kinds landed on
  // a legend capped at six, and stayed. Same element-set join, same growth rule.
  std::map<KindId, ElementSet> lives;
  std::size_t before = 0;
  for (const KindStateEntry& kind : legend.exportState().kinds) {
    ElementSet life{kind.createdAt, kind.deletedAt};
    if (life.present()) ++before;
    lives.emplace(kind.id, life);
  }
  for (const KindStateEntry& kind : incoming.kinds) {
    if (std::optional<std::string> bad = kindFieldBounds(kind.id, kind.label, kind.description))
      return Admission{Admission::Verdict::malformed, *bad};
    ElementSet& life = lives[kind.id];  // seeded above from the legend; default for a new id
    life.add(kind.createdAt);
    life.remove(kind.deletedAt);
  }

  std::size_t after = 0;
  for (const auto& [id, life] : lives) if (life.present()) ++after;
  if (after > kMaxKinds && after > before)
    return Admission{Admission::Verdict::tooLarge,
                     "this legend would hold " + std::to_string(after) + " kinds, max " +
                         std::to_string(kMaxKinds) + " — remove a kind before adding another"};
  return std::nullopt;
}

std::optional<Command> headline(const GraphState& graph, const LegendState& legend) {
  for (const NodeStateEntry& n : graph.nodes)
    if (n.createdAt.isSet()) return CreateNode{n.id, n.label, n.icon, n.color, {}, n.position, n.description, n.links};
  for (const NodeStateEntry& n : graph.nodes)
    if (n.deletedAt.isSet()) return DeleteNode{n.id};
  for (const KindStateEntry& k : legend.kinds)
    if (k.createdAt.isSet()) return AddKind{k.id, k.hue};
  for (const KindStateEntry& k : legend.kinds)
    if (k.hueAt.isSet()) return RecolorKind{k.id, k.hue};
  for (const KindStateEntry& k : legend.kinds)
    if (k.labelAt.isSet()) return RenameKind{k.id, k.label};
  for (const KindStateEntry& k : legend.kinds)
    if (k.descriptionAt.isSet()) return DescribeKind{k.id, k.description};
  for (const KindStateEntry& k : legend.kinds)
    if (k.rankAt.isSet()) return ReorderKinds{};
  for (const NodeStateEntry& n : graph.nodes)
    if (n.labelAt.isSet()) return RenameNode{n.id, n.label};
  for (const NodeStateEntry& n : graph.nodes)
    if (n.colorAt.isSet()) return SetNodeColor{n.id, n.color};
  for (const NodeStateEntry& n : graph.nodes)
    if (n.descriptionAt.isSet() || n.linksAt.isSet())
      return AnnotateNode{n.id,
                          n.descriptionAt.isSet() ? std::optional<std::string>(n.description) : std::nullopt,
                          n.linksAt.isSet() ? std::optional<std::vector<Link>>(n.links) : std::nullopt};
  for (const EdgeStateEntry& e : graph.edges)
    if (e.addedAt.isSet()) return AddEdge{e.edge.from, e.edge.to};
  for (const EdgeStateEntry& e : graph.edges)
    if (e.removedAt.isSet()) return RemoveEdge{e.edge.from, e.edge.to};
  return std::nullopt;
}

}
