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

std::string appendedTo(const std::string& body, const std::string& tail) {
  if (body.empty()) return tail;
  return body + "\n\n" + tail;
}

// Every field a command or an arriving document overflows, named in ONE sentence — each clause
// says the size the field would have, how far over it is, and the cap — so a caller who overran
// several caps fixes them all in one round trip.
struct Overages {
  std::vector<std::string> clauses;

  void note(const std::string& field, const std::string& value, std::size_t cap) {
    const std::size_t size = codePointCount(value);
    if (size <= cap) return;
    clauses.push_back(field + " would be " + std::to_string(size) + " characters, " +
                      std::to_string(size - cap) + " over the " + std::to_string(cap) + " cap");
  }
  void noteLinks(const std::vector<Link>& links) {
    if (links.size() > kMaxNodeLinks)
      clauses.push_back("links has " + std::to_string(links.size()) + " items, max " +
                        std::to_string(kMaxNodeLinks));
    for (std::size_t i = 0; i < links.size(); ++i) {
      const std::string item = "links[" + std::to_string(i) + "]";
      note(item + ".url", links[i].url, kMaxLinkUrlLength);
      note(item + ".label", links[i].label, kMaxLinkLabelLength);
    }
  }
  std::optional<std::string> sentence() const {
    if (clauses.empty()) return std::nullopt;
    std::string out = clauses[0];
    for (std::size_t i = 1; i < clauses.size(); ++i) out += "; " + clauses[i];
    return out;
  }
};

// Every per-node bound admit() enforces, wherever the node arrived from. An over-long id is never
// quoted back: echoing it would make the refusal as expensive as the request.
std::optional<std::string> nodeFieldBounds(const NodeId& id, const std::string& label, const std::string& icon,
                                           const std::string& description, const std::vector<Link>& links,
                                           const std::optional<Vec2>& position) {
  if (id.empty()) return "a node has an empty id";
  Overages idOver;
  idOver.note("a node id", id.str(), kMaxIdLength);
  if (std::optional<std::string> bad = idOver.sentence()) return bad;
  const std::string named = "node " + quoted(id.str()) + ": ";
  Overages over;
  over.note("label", label, kMaxNodeLabelLength);
  over.note("icon", icon, kMaxIconLength);
  over.note("description", description, kMaxNodeDescriptionLength);
  over.noteLinks(links);
  if (std::optional<std::string> bad = over.sentence()) return named + *bad;
  if (position && !(std::isfinite(position->x) && std::isfinite(position->y)))
    return named + "position is not finite";
  return std::nullopt;
}

// Every per-kind bound admit() enforces, wherever the kind arrived from.
std::optional<std::string> kindFieldBounds(const KindId& id, const std::string& label,
                                           const std::string& description) {
  if (id.empty()) return "a kind has an empty id";
  Overages idOver;
  idOver.note("a kind id", id.str(), kMaxIdLength);
  if (std::optional<std::string> bad = idOver.sentence()) return bad;
  const std::string named = "kind " + quoted(id.str()) + ": ";
  Overages over;
  over.note("label", label, kMaxKindLabelLength);
  over.note("description", description, kMaxKindDescriptionLength);
  if (std::optional<std::string> bad = over.sentence()) return named + *bad;
  return std::nullopt;
}

// The two whole-tree ceilings, read off the totals the arrival would leave behind, and stated after
// the field bounds. A ceiling refuses GROWTH, not size.
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

std::size_t codePointCount(const std::string& utf8) {
  std::size_t count = 0;
  for (char byte : utf8)
    if ((static_cast<unsigned char>(byte) & 0xC0) != 0x80) ++count;
  return count;
}

std::size_t byteOffsetOfCodePoint(const std::string& utf8, std::size_t index) {
  std::size_t seen = 0;
  for (std::size_t i = 0; i < utf8.size(); ++i) {
    if ((static_cast<unsigned char>(utf8[i]) & 0xC0) == 0x80) continue;
    if (seen == index) return i;
    ++seen;
  }
  return std::string::npos;
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
      if (c.icon) graph.setIcon(c.id, *c.icon, at);
      if (c.description) graph.setDescription(c.id, *c.description, at);
      if (c.appendDescription)
        graph.setDescription(c.id, appendedTo(graph.descriptionOf(c.id), *c.appendDescription), at);
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
    [&](const DescribeKind& c) {
      if (c.description) legend.setDescription(c.id, *c.description, at);
      if (c.crossBranchExempt) legend.setCrossBranchExempt(c.id, *c.crossBranchExempt, at);
    },
    [&](const AddKind& c) {
      legend.addKind(c.id, c.hue, at);
      if (!c.label.empty()) legend.setLabel(c.id, c.label, at);
      if (!c.description.empty()) legend.setDescription(c.id, c.description, at);
      if (c.crossBranchExempt) legend.setCrossBranchExempt(c.id, true, at);
    },
    [&](const RemoveKind& c) { legend.removeKind(c.id, at); },
    [&](const ReorderKinds& c) { legend.reorder(c.order, at); },
    [&](const RecolorKind& c) {
      std::optional<NodeColor> old = legend.hueOf(c.id);
      if (!old) return;
      legend.setHue(c.id, c.hue, at);
      for (const NodeId& node : graph.nodesWithColor(*old)) graph.setColor(node, c.hue, at);
    },
    [&](const Batch& c) {
      for (const Command& member : c.commands) merge(graph, legend, member, at);
    },
  }, command);
}

// A refusal names the id, the value that clashed, who holds it, and the limit that was reached: the
// caller cannot see this state and must be able to act on the sentence alone.
std::optional<std::string> validate(const LooseGraph& graph, const Legend& legend, const Command& command) {
  auto idBounds = [](const NodeId& id) -> std::optional<std::string> {
    if (id.empty()) return "node id is empty";
    Overages over;
    over.note("node id", id.str(), kMaxIdLength);
    return over.sentence();
  };
  return std::visit(overloaded{
    [&](const CreateNode& c) -> std::optional<std::string> {
      if (auto bad = idBounds(c.id)) return bad;
      Overages over;
      over.note("label", c.label, kMaxNodeLabelLength);
      over.note("icon", c.icon, kMaxIconLength);
      over.note("description", c.description, kMaxNodeDescriptionLength);
      over.noteLinks(c.links);
      if (auto bad = over.sentence()) return bad;
      if (c.position && !(std::isfinite(c.position->x) && std::isfinite(c.position->y)))
        return "position is not finite";
      if (!graph.hasNode(c.id) && graph.presentNodeCount() >= kMaxNodes)
        return "tree is at node capacity (" + std::to_string(kMaxNodes) +
               " nodes) — delete a node before adding another";
      return std::nullopt;
    },
    [&](const AnnotateNode& c) -> std::optional<std::string> {
      if (auto bad = idBounds(c.id)) return bad;
      if (c.description && c.appendDescription)
        return "description and appendDescription are both set — pass one: description replaces "
               "the body, appendDescription joins onto it";
      Overages over;
      if (c.icon) over.note("icon", *c.icon, kMaxIconLength);
      if (c.description) over.note("description", *c.description, kMaxNodeDescriptionLength);
      if (c.appendDescription)
        over.note("description", appendedTo(graph.descriptionOf(c.id), *c.appendDescription),
                  kMaxNodeDescriptionLength);
      if (c.links) over.noteLinks(*c.links);
      return over.sentence();
    },
    [&](const RenameNode& c) -> std::optional<std::string> {
      if (auto bad = idBounds(c.id)) return bad;
      Overages over;
      over.note("label", c.label, kMaxNodeLabelLength);
      return over.sentence();
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
      Overages over;
      over.note("label", c.label, kMaxKindLabelLength);
      return over.sentence();
    },
    [&](const DescribeKind& c) -> std::optional<std::string> {
      if (!legend.has(c.id)) return "no kind " + quoted(c.id.str()) + " in this legend";
      Overages over;
      if (c.description) over.note("description", *c.description, kMaxKindDescriptionLength);
      return over.sentence();
    },
    [&](const AddKind& c) -> std::optional<std::string> {
      if (legend.has(c.id)) return "kind " + quoted(c.id.str()) + " already exists in this legend";
      if (legend.size() >= kMaxKinds)
        return "the legend is full (" + std::to_string(legend.size()) + " of " +
               std::to_string(kMaxKinds) + " kinds) — remove a kind before adding another";
      if (std::optional<KindId> owner = legend.ownerOf(c.hue))
        return "hue " + quoted(std::string(toString(c.hue))) + " already belongs to kind " +
               quoted(owner->str()) + " — a hue names one kind, so pick a free one";
      Overages over;
      over.note("label", c.label, kMaxKindLabelLength);
      over.note("description", c.description, kMaxKindDescriptionLength);
      return over.sentence();
    },
    [&](const RemoveKind& c) -> std::optional<std::string> {
      std::optional<NodeColor> hue = legend.hueOf(c.id);
      if (!hue) return "no kind " + quoted(c.id.str()) + " in this legend";
      if (!graph.hueInUse(*hue)) return std::nullopt;
      // Only the refusal pays for the count — how much repainting the removal is asking of the caller.
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
    [&](const Batch& c) -> std::optional<std::string> {
      for (const Command& member : c.commands)
        if (std::optional<std::string> reason = validate(graph, legend, member)) return reason;
      return std::nullopt;
    },
    [&](const auto&) -> std::optional<std::string> { return std::nullopt; },
  }, command);
}

std::optional<Admission> admitTitle(const std::string& title) {
  Overages over;
  over.note("the title", title, kMaxTitleChars);
  if (std::optional<std::string> bad = over.sentence()) return Admission{Admission::Verdict::malformed, *bad};
  return std::nullopt;
}

std::optional<Admission> admit(const TreeData& document) {
  if (std::optional<Admission> refusal = admitTitle(document.title)) return refusal;
  // A document's kinds REPLACE the legend rather than joining it, so the count is the list's length.
  if (document.kinds.size() > kMaxKinds)
    return Admission{Admission::Verdict::tooLarge,
                     "this legend would hold " + std::to_string(document.kinds.size()) +
                         " kinds, max " + std::to_string(kMaxKinds) + " — remove a kind before adding another"};
  for (const Kind& kind : document.kinds)
    if (std::optional<std::string> bad = kindFieldBounds(kind.id, kind.label, kind.description))
      return Admission{Admission::Verdict::malformed, *bad};
  // A posted document is judged as a graft into an empty tree; the tree it lands on is judged
  // separately by the caller holding that graph. A save grows a lattice rather than replacing it.
  return admit(LooseGraph{}, document);
}

std::optional<Admission> admit(const LooseGraph& graph, const Graft& incoming) {
  // The ids and edges the batch would ADD, as sets: a document may name the same id — or the same
  // prerequisite — many times, and each must count once. What the graft removes is subtracted, so
  // a rebuild that tombstones as much as it plants is judged on what it leaves behind.
  std::set<NodeId> arrivingNodes;
  std::set<Edge> arrivingEdges;
  for (const NodeSpec& node : incoming.document.nodes) {
    if (std::optional<std::string> bad =
            nodeFieldBounds(node.id, node.label, node.icon, node.description, node.links, node.position))
      return Admission{Admission::Verdict::malformed, *bad};
    if (!graph.hasNode(node.id)) arrivingNodes.insert(node.id);  // a graft upserts: a present id costs nothing
    for (const NodeId& prereq : node.prerequisites)
      if (!graph.edgePresent(prereq, node.id)) arrivingEdges.insert(Edge{prereq, node.id});
  }
  const GraftFootprint footprint = footprintOf(graph, incoming);
  const std::size_t nodesBefore = graph.presentNodeCount();
  const std::size_t edgesBefore = graph.presentEdgeCount();
  const std::size_t leavingEdges = footprint.replacedEdges.size() + footprint.tombstonedEdges.size();
  return growthWithin(nodesBefore, nodesBefore + arrivingNodes.size() - footprint.tombstonedNodes.size(),
                      edgesBefore, edgesBefore + arrivingEdges.size() - leavingEdges);
}

std::optional<Admission> admit(const LooseGraph& graph, const TreeData& incoming) {
  return admit(graph, Graft{incoming});
}

std::optional<Admission> admit(const LooseGraph& graph, const GraphState& incoming) {
  // Run the element-set join itself rather than trusting each entry's stamps: an estimate lets a
  // losing tombstone or a repeated id subtract from a count it never lowered.
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

  // One key moves the count by at most one, in the direction the merge decided.
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
  // The legend rides the same frame the graph does: same element-set join, same growth rule.
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
    if (k.descriptionAt.isSet()) return DescribeKind{k.id, k.description, std::nullopt};
  for (const KindStateEntry& k : legend.kinds)
    if (k.crossBranchExemptAt.isSet()) return DescribeKind{k.id, std::nullopt, k.crossBranchExempt};
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
