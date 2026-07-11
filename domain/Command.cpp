#include "domain/Command.h"

namespace wm {

namespace {
template <class... Ts>
struct overloaded : Ts... { using Ts::operator()...; };
template <class... Ts>
overloaded(Ts...) -> overloaded<Ts...>;
}

void merge(LooseGraph& graph, const Command& command, const Hlc& at) {
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
  }, command);
}

std::vector<Command> invert(const LooseGraph& before, const Command& command) {
  return std::visit(overloaded{
    [&](const RenameNode& c) -> std::vector<Command> {
      auto node = before.nodeView(c.id);
      if (!node) return {};
      return {RenameNode{c.id, node->label}};
    },
    [&](const SetNodeColor& c) -> std::vector<Command> {
      auto node = before.nodeView(c.id);
      if (!node) return {};
      return {SetNodeColor{c.id, node->color}};
    },
    [&](const RepositionNode& c) -> std::vector<Command> {
      auto node = before.nodeView(c.id);
      if (!node || !node->position) return {};
      return {RepositionNode{c.id, *node->position}};
    },
    [&](const CreateNode& c) -> std::vector<Command> {
      return {DeleteNode{c.id}};
    },
    [&](const AddEdge& c) -> std::vector<Command> {
      if (before.edgePresent(c.from, c.to)) return {};
      return {RemoveEdge{c.from, c.to}};
    },
    [&](const RemoveEdge& c) -> std::vector<Command> {
      if (!before.edgePresent(c.from, c.to)) return {};
      return {AddEdge{c.from, c.to}};
    },
    [&](const ReconnectEdge& c) -> std::vector<Command> {
      return {ReconnectEdge{c.newFrom, c.newTo, c.oldFrom, c.oldTo}};
    },
    [&](const DeleteNode& c) -> std::vector<Command> {
      auto node = before.nodeView(c.id);
      if (!node) return {};
      return {CreateNode{node->id, node->label, node->icon, node->color, std::nullopt, node->position}};
    },
    [&](const TransitiveReduction&) -> std::vector<Command> {
      std::vector<Command> inverse;
      for (const auto& edge : before.redundantEdges()) inverse.push_back(AddEdge{edge.from, edge.to});
      return inverse;
    },
  }, command);
}

}
