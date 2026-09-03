#include "products/roadmap/application/TreeRoom.h"

#include "products/roadmap/domain/Subgraph.h"

namespace wm {

TreeRoom::TreeRoom(TreeId id, Lww<std::string> title, LooseGraph graph, Legend legend, Seq head,
                   std::optional<UserId> owner, Visibility visibility, std::uint64_t createdAt,
                   OpLog& ops, PresenceBus& bus)
    : id_(std::move(id)), title_(std::move(title)), graph_(std::move(graph)), legend_(std::move(legend)),
      head_(head), owner_(std::move(owner)), visibility_(visibility), createdAt_(createdAt),
      ops_(ops), bus_(bus), clock_(std::string{kServerActor}) {
  // Fold every stamp the loaded document already carries — the graph frontier and the title register
  // — so a fresh mint after restart is always ahead of anything persisted.
  for (const auto& [actor, mark] : frontier(graph_.exportState(), legend_.exportState()).marks) {
    clock_.observe(mark);
  }
  clock_.observe(title_.stamp);
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
  if (incoming.title) {
    clock_.observe(incoming.title->stamp);
    if (stamp < incoming.title->stamp) stamp = incoming.title->stamp;
    title_.merge(incoming.title->value, incoming.title->stamp);  // the title joins the lattice
  }
  graph_.join(incoming.graph);
  legend_.join(incoming.legend);
  markDirty(incoming.graph, incoming.legend);
  ++head_;
  // One op per frame at the seq the frame just took, keyed on the frameId so a re-gossip never
  // double-counts. A nudge (position only) is not feed-worthy, so nothing is logged.
  if (std::optional<Command> deed = headline(incoming.graph, incoming.legend))
    ops_.append(id_, AppliedOp{head_, incoming.frameId, *deed, stamp, actor});
  bus_.broadcastSubgraph(id_, head_, incoming);
  return head_;
}

Seq TreeRoom::rename(const std::string& title, std::uint64_t nowMs) {
  Hlc stamp = clock_.tick(nowMs);
  Subgraph frame;
  frame.treeId = id_;
  frame.frameId = "srv-rename-" + toString(stamp);
  frame.actor = stamp.actor;
  frame.intent = SubgraphIntent::live;
  frame.title = Lww<std::string>{title, stamp};
  return joinSubgraph(frame, UserId{stamp.actor}).value_or(head_);
}

Seq TreeRoom::applyCommand(const Command& command, std::uint64_t nowMs, const UserId& actor) {
  return applyCommands({command}, nowMs, actor);
}

Seq TreeRoom::applyCommands(const std::vector<Command>& commands, std::uint64_t nowMs, const UserId& actor) {
  Hlc stamp = clock_.tick(nowMs);  // one stamp for the whole frame, as a graft takes one
  std::string frameId = "srv-" + toString(stamp);  // unique: the clock mints monotone stamps
  appliedOpIds_.insert(frameId);
  VersionVector before = frontier(graph_.exportState(), legend_.exportState());
  for (const Command& command : commands) merge(graph_, legend_, command, stamp);
  ++head_;

  Subgraph produced = deltaBetween(graph_.exportState(), legend_.exportState(), before);
  produced.treeId = id_;
  produced.frameId = frameId;
  produced.actor = stamp.actor;
  produced.intent = SubgraphIntent::live;
  // The op log still powers the activity feed: a lone command is its own deed, a batch is
  // summarised by its frame's headline, exactly as a joined frame is.
  std::optional<Command> deed =
      commands.size() == 1 ? std::optional<Command>(commands.front()) : headline(produced.graph, produced.legend);
  if (deed) ops_.append(id_, AppliedOp{head_, frameId, *deed, stamp, actor});
  markDirty(produced.graph, produced.legend);  // the broadcast delta is exactly the write's footprint
  bus_.broadcastSubgraph(id_, head_, produced);
  return head_;
}

Seq TreeRoom::importTree(const Graft& incoming, std::uint64_t nowMs, const UserId& actor) {
  Hlc at = clock_.tick(nowMs);  // one dominating stamp for the whole graft: the upsert and every removal
  Subgraph frame;
  frame.treeId = id_;
  frame.frameId = "srv-import-" + toString(at);
  frame.actor = at.actor;
  frame.intent = SubgraphIntent::graft;
  frame.graph = graftState(graph_, incoming, at);
  if (!incoming.document.kinds.empty()) frame.legend = Legend(incoming.document.kinds, at).exportState();
  return joinSubgraph(frame, actor).value_or(head_);
}

std::optional<Admission> TreeRoom::admit(const Subgraph& incoming) const {
  if (std::optional<Admission> refusal = wm::admit(graph_, incoming.graph)) return refusal;
  if (std::optional<Admission> refusal = wm::admit(legend_, incoming.legend)) return refusal;
  if (!incoming.title) return std::nullopt;
  return admitTitle(incoming.title->value);
}

std::optional<std::string> TreeRoom::validate(const Command& command) const {
  return wm::validate(graph_, legend_, command);
}

void TreeRoom::replay(const AppliedOp& op) {
  appliedOpIds_.insert(op.opId);
  clock_.observe(op.hlc);  // the op-log tail advances the clock past every stamp it replays
  merge(graph_, legend_, op.command, op.hlc);
  head_ = op.seq;
  allDirty_ = true;  // the snapshot is behind the log; the next save writes the full state
}

void TreeRoom::markDirty(const GraphState& graph, const LegendState& legend) {
  for (const NodeStateEntry& node : graph.nodes) dirtyNodes_.insert(node.id);
  for (const EdgeStateEntry& edge : graph.edges) dirtyEdges_.insert(edge.edge);
  for (const KindStateEntry& kind : legend.kinds) dirtyKinds_.insert(kind.id);
}

std::pair<GraphState, LegendState> TreeRoom::dirtyState() const {
  if (allDirty_) return {graph_.exportState(), legend_.exportState()};
  GraphState graph;
  LegendState legend;
  for (const NodeId& id : dirtyNodes_)
    if (std::optional<NodeStateEntry> entry = graph_.exportNode(id)) graph.nodes.push_back(std::move(*entry));
  for (const Edge& edge : dirtyEdges_)
    if (std::optional<EdgeStateEntry> entry = graph_.exportEdge(edge)) graph.edges.push_back(std::move(*entry));
  for (const KindId& id : dirtyKinds_)
    if (std::optional<KindStateEntry> entry = legend_.exportKind(id)) legend.kinds.push_back(std::move(*entry));
  return {std::move(graph), std::move(legend)};
}

void TreeRoom::markClean() {
  dirtyNodes_.clear();
  dirtyEdges_.clear();
  dirtyKinds_.clear();
  allDirty_ = false;
}

TreeDiagnostics TreeRoom::diagnose() const {
  return TreeDiagnostics::assess(graph_);
}

TreeData TreeRoom::snapshot() const {
  TreeData data = graph_.toTreeData(id_, title_.value);
  data.kinds = legend_.kinds();
  return data;
}

std::vector<NodeId> TreeRoom::prerequisitesOf(const NodeId& node) const {
  std::optional<NodeSpec> view = graph_.nodeView(node);
  return view ? std::move(view->prerequisites) : std::vector<NodeId>{};
}

bool TreeRoom::hasNode(const NodeId& node) const {
  return graph_.hasNode(node);
}

bool TreeRoom::hasEdge(const NodeId& from, const NodeId& to) const {
  return graph_.edgePresent(from, to);
}

std::vector<Edge> TreeRoom::edgesTouching(const std::vector<NodeId>& nodes) const {
  return graph_.edgesTouching(nodes);
}

GraphState TreeRoom::exportState() const {
  return graph_.exportState();
}

LegendState TreeRoom::exportLegend() const {
  return legend_.exportState();
}

}
