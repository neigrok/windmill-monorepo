#include "application/TreeRoom.h"

namespace wm {

TreeRoom::TreeRoom(TreeId id, std::string title, LooseGraph graph, Seq head, OpLog& ops, PresenceBus& bus)
    : id_(std::move(id)), title_(std::move(title)), graph_(std::move(graph)), head_(head), ops_(ops), bus_(bus) {}

std::optional<Applied> TreeRoom::submit(const Incoming& incoming) {
  if (!appliedOpIds_.insert(incoming.opId).second) return std::nullopt;

  std::vector<Command> inverse = invert(graph_, incoming.command);
  merge(graph_, incoming.command, incoming.hlc);
  AppliedOp op{++head_, incoming.opId, incoming.command, incoming.hlc, incoming.actor};
  ops_.append(id_, op);
  bus_.broadcastOp(id_, op);
  return Applied{std::move(op), std::move(inverse)};
}

void TreeRoom::replay(const AppliedOp& op) {
  appliedOpIds_.insert(op.opId);
  merge(graph_, op.command, op.hlc);
  head_ = op.seq;
}

TreeDiagnostics TreeRoom::diagnose() const {
  return TreeDiagnostics::assess(graph_);
}

TreeData TreeRoom::snapshot() const {
  return graph_.toTreeData(id_, title_);
}

std::vector<NodeId> TreeRoom::prerequisitesOf(const NodeId& node) const {
  std::optional<NodeSpec> view = graph_.nodeView(node);
  return view ? std::move(view->prerequisites) : std::vector<NodeId>{};
}

GraphState TreeRoom::exportState() const {
  return graph_.exportState();
}

}
