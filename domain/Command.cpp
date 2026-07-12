#include "domain/Command.h"

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
      if (c.parent) graph.addEdge(*c.parent, c.id, at);
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
    [&](const RenameKind& c) { legend.setLabel(c.id, c.label, at); },
    [&](const DescribeKind& c) { legend.setDescription(c.id, c.description, at); },
    [&](const AddKind& c) { legend.addKind(c.id, c.hue, at); },
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

std::vector<Command> invert(const LooseGraph& graph, const Legend& legend, const Command& command) {
  return std::visit(overloaded{
    [&](const RenameNode& c) -> std::vector<Command> {
      auto node = graph.nodeView(c.id);
      if (!node) return {};
      return {RenameNode{c.id, node->label}};
    },
    [&](const SetNodeColor& c) -> std::vector<Command> {
      auto node = graph.nodeView(c.id);
      if (!node) return {};
      return {SetNodeColor{c.id, node->color}};
    },
    [&](const RepositionNode& c) -> std::vector<Command> {
      auto node = graph.nodeView(c.id);
      if (!node || !node->position) return {};
      return {RepositionNode{c.id, *node->position}};
    },
    [&](const CreateNode& c) -> std::vector<Command> {
      return {DeleteNode{c.id}};
    },
    [&](const AddEdge& c) -> std::vector<Command> {
      if (graph.edgePresent(c.from, c.to)) return {};
      return {RemoveEdge{c.from, c.to}};
    },
    [&](const RemoveEdge& c) -> std::vector<Command> {
      if (!graph.edgePresent(c.from, c.to)) return {};
      return {AddEdge{c.from, c.to}};
    },
    [&](const ReconnectEdge& c) -> std::vector<Command> {
      return {ReconnectEdge{c.newFrom, c.newTo, c.oldFrom, c.oldTo}};
    },
    [&](const DeleteNode& c) -> std::vector<Command> {
      auto node = graph.nodeView(c.id);
      if (!node) return {};
      return {CreateNode{node->id, node->label, node->icon, node->color, std::nullopt, node->position}};
    },
    [&](const TransitiveReduction&) -> std::vector<Command> {
      std::vector<Command> inverse;
      for (const auto& edge : graph.redundantEdges()) inverse.push_back(AddEdge{edge.from, edge.to});
      return inverse;
    },
    [&](const RenameKind& c) -> std::vector<Command> {
      auto kind = legend.view(c.id);
      if (!kind) return {};
      return {RenameKind{c.id, kind->label}};
    },
    [&](const DescribeKind& c) -> std::vector<Command> {
      auto kind = legend.view(c.id);
      if (!kind) return {};
      return {DescribeKind{c.id, kind->description}};
    },
    [&](const AddKind& c) -> std::vector<Command> {
      if (legend.has(c.id)) return {};
      return {RemoveKind{c.id}};
    },
    [&](const RemoveKind& c) -> std::vector<Command> {
      auto kind = legend.view(c.id);
      if (!kind) return {};
      std::vector<Command> inverse{AddKind{c.id, kind->hue}};
      if (!kind->label.empty()) inverse.push_back(RenameKind{c.id, kind->label});
      if (!kind->description.empty()) inverse.push_back(DescribeKind{c.id, kind->description});
      inverse.push_back(ReorderKinds{legend.orderedIds()});  // restore the kind to its slot
      return inverse;
    },
    [&](const ReorderKinds&) -> std::vector<Command> {
      return {ReorderKinds{legend.orderedIds()}};
    },
    [&](const RecolorKind& c) -> std::vector<Command> {
      std::optional<NodeColor> old = legend.hueOf(c.id);
      if (!old || *old == c.hue) return {};
      return {RecolorKind{c.id, *old}};
    },
  }, command);
}

std::optional<std::string> validate(const LooseGraph& graph, const Legend& legend, const Command& command) {
  return std::visit(overloaded{
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

}
