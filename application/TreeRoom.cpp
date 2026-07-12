#include "application/TreeRoom.h"

namespace wm {

TreeRoom::TreeRoom(TreeId id, std::string title, LooseGraph graph, Legend legend, Seq head, OpLog& ops, PresenceBus& bus)
    : id_(std::move(id)), title_(std::move(title)), graph_(std::move(graph)), legend_(std::move(legend)),
      head_(head), ops_(ops), bus_(bus) {}

std::optional<Applied> TreeRoom::submit(const Incoming& incoming) {
  if (!appliedOpIds_.insert(incoming.opId).second) return std::nullopt;

  std::vector<Command> inverse = invert(graph_, legend_, incoming.command);
  merge(graph_, legend_, incoming.command, incoming.hlc);
  AppliedOp op{++head_, incoming.opId, incoming.command, incoming.hlc, incoming.actor};
  ops_.append(id_, op);
  bus_.broadcastOp(id_, op);
  return Applied{std::move(op), std::move(inverse)};
}

std::optional<std::string> TreeRoom::validate(const Command& command) const {
  return wm::validate(graph_, legend_, command);
}

void TreeRoom::replay(const AppliedOp& op) {
  appliedOpIds_.insert(op.opId);
  merge(graph_, legend_, op.command, op.hlc);
  head_ = op.seq;
}

TreeDiagnostics TreeRoom::diagnose() const {
  return TreeDiagnostics::assess(graph_);
}

TreeData TreeRoom::snapshot() const {
  TreeData data = graph_.toTreeData(id_, title_);
  data.kinds = legend_.kinds();
  return data;
}

std::vector<NodeId> TreeRoom::prerequisitesOf(const NodeId& node) const {
  std::optional<NodeSpec> view = graph_.nodeView(node);
  return view ? std::move(view->prerequisites) : std::vector<NodeId>{};
}

GraphState TreeRoom::exportState() const {
  return graph_.exportState();
}

LegendState TreeRoom::exportLegend() const {
  return legend_.exportState();
}

}
