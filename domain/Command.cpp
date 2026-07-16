#include "domain/Command.h"

#include <cmath>
#include <cstddef>

namespace wm {

namespace {
template <class... Ts>
struct overloaded : Ts... { using Ts::operator()...; };
template <class... Ts>
overloaded(Ts...) -> overloaded<Ts...>;

constexpr std::size_t kMaxKinds = 6;
constexpr std::size_t kMaxLabelLength = 24;
constexpr std::size_t kMaxDescriptionLength = 80;
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
      if (!graph.hasNode(c.id) && graph.presentNodeIds().size() >= kMaxNodes)
        return "tree is at node capacity";
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
      if (!graph.edgePresent(c.from, c.to) && graph.presentEdges().size() >= kMaxEdges)
        return "tree is at edge capacity";
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
      if (!legend.has(c.id)) return "no such kind";
      if (c.label.size() > kMaxLabelLength) return "label is too long (max 24 characters)";
      return std::nullopt;
    },
    [&](const DescribeKind& c) -> std::optional<std::string> {
      if (!legend.has(c.id)) return "no such kind";
      if (c.description.size() > kMaxDescriptionLength) return "description is too long (max 80 characters)";
      return std::nullopt;
    },
    [&](const AddKind& c) -> std::optional<std::string> {
      if (legend.has(c.id)) return "kind already exists";
      if (legend.size() >= kMaxKinds) return "the legend is full (max 6 kinds)";
      if (legend.ownerOf(c.hue)) return "that hue already belongs to another kind";
      if (c.label.size() > kMaxLabelLength) return "label is too long (max 24 characters)";
      if (c.description.size() > kMaxDescriptionLength) return "description is too long (max 80 characters)";
      return std::nullopt;
    },
    [&](const RemoveKind& c) -> std::optional<std::string> {
      std::optional<NodeColor> hue = legend.hueOf(c.id);
      if (!hue) return "no such kind";
      if (graph.hueInUse(*hue)) return "kind is in use — nodes still wear its hue";
      return std::nullopt;
    },
    [&](const RecolorKind& c) -> std::optional<std::string> {
      if (!legend.has(c.id)) return "no such kind";
      std::optional<KindId> owner = legend.ownerOf(c.hue);
      if (owner && *owner != c.id) return "that hue already belongs to another kind";
      return std::nullopt;
    },
    [&](const auto&) -> std::optional<std::string> { return std::nullopt; },
  }, command);
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
