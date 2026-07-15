#include "application/TreeRoom.h"

#include "domain/Subgraph.h"

namespace wm {

// The actor that stamps every server-minted write. Authorship lives in AppliedOp.actor; the
// HLC actor only breaks ties and keys the version vector, so one stable server identity is
// exactly right. (A multi-instance deploy would qualify it per instance.)
TreeRoom::TreeRoom(TreeId id, std::string title, LooseGraph graph, Legend legend, Seq head,
                   std::optional<UserId> owner, OpLog& ops, PresenceBus& bus)
    : id_(std::move(id)), title_(std::move(title)), graph_(std::move(graph)), legend_(std::move(legend)),
      head_(head), owner_(std::move(owner)), ops_(ops), bus_(bus), clock_("srv") {
  // Fold every stamp the loaded document already carries, so a fresh mint after restart is
  // always ahead of anything persisted — the receive rule, applied at load.
  for (const auto& [actor, mark] : frontier(graph_.exportState(), legend_.exportState()).marks) {
    clock_.observe(mark);
  }
}

Hlc TreeRoom::nextStamp(std::uint64_t nowMs) {
  return clock_.tick(nowMs);
}

std::optional<Seq> TreeRoom::joinSubgraph(const Subgraph& incoming, const UserId& actor) {
  if (!appliedOpIds_.insert(incoming.frameId).second) return std::nullopt;
  VersionVector front = frontier(incoming.graph, incoming.legend);
  Hlc stamp;
  for (const auto& [_, mark] : front.marks) {
    clock_.observe(mark);
    if (stamp < mark) stamp = mark;  // the frame's causal position, for the feed op
  }
  graph_.join(incoming.graph);
  legend_.join(incoming.legend);
  ++head_;
  // Record the headline deed so a browser edit reaches the activity feed exactly as an agent's
  // does — one op per frame at the seq the frame just took, keyed on the frameId so a re-gossip
  // never double-counts. A nudge (position only) is not feed-worthy, so nothing is logged.
  if (std::optional<Command> deed = headline(incoming.graph, incoming.legend))
    ops_.append(id_, AppliedOp{head_, incoming.frameId, *deed, stamp, actor});
  bus_.broadcastSubgraph(id_, head_, incoming);
  return head_;
}

Seq TreeRoom::applyCommand(const Command& command, std::uint64_t nowMs, const UserId& actor) {
  Hlc stamp = clock_.tick(nowMs);
  std::string frameId = "srv-" + toString(stamp);  // unique: the clock mints monotone stamps
  appliedOpIds_.insert(frameId);
  VersionVector before = frontier(graph_.exportState(), legend_.exportState());
  merge(graph_, legend_, command, stamp);
  AppliedOp op{++head_, frameId, command, stamp, actor};
  ops_.append(id_, op);  // the op log still powers the activity feed

  Subgraph produced = deltaBetween(graph_.exportState(), legend_.exportState(), before);
  produced.treeId = id_;
  produced.frameId = frameId;
  produced.actor = stamp.actor;
  produced.intent = SubgraphIntent::live;
  bus_.broadcastSubgraph(id_, op.seq, produced);
  return op.seq;
}

std::optional<std::string> TreeRoom::validate(const Command& command) const {
  return wm::validate(graph_, legend_, command);
}

void TreeRoom::replay(const AppliedOp& op) {
  appliedOpIds_.insert(op.opId);
  clock_.observe(op.hlc);  // the op-log tail advances the clock past every stamp it replays
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
