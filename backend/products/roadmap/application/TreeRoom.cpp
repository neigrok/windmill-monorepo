#include "products/roadmap/application/TreeRoom.h"

#include "platform/application/WriteObservation.h"

#include <trantor/utils/Logger.h>

#include <algorithm>
#include <stdexcept>

namespace wm {

namespace {
// The present nodes `commands` delete, a batch's among them.
std::vector<NodeId> deletedBy(const std::vector<Command>& commands, const LooseGraph& graph) {
  std::vector<NodeId> deleted;
  for (const Command& command : commands) {
    if (const DeleteNode* deletion = std::get_if<DeleteNode>(&command); deletion && graph.hasNode(deletion->id))
      deleted.push_back(deletion->id);
    if (const Batch* batch = std::get_if<Batch>(&command)) {
      const std::vector<NodeId> inner = deletedBy(batch->commands, graph);
      deleted.insert(deleted.end(), inner.begin(), inner.end());
    }
  }
  return deleted;
}
}

bool RootAccess::admits(const std::vector<OwningStep>& path) const {
  if (!stands()) return false;
  std::lock_guard<std::mutex> lock(mutex_);
  return std::none_of(path.begin(), path.end(), [this](const OwningStep& step) { return absent_.count(step) > 0; });
}

void RootAccess::record(const OwningStep& step, bool present) {
  bool moved = false;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    moved = present ? absent_.erase(step) > 0 : absent_.insert(step).second;
  }
  // Told with no lock held: whoever listens asks this access again.
  if (moved && moved_) moved_(step);
}

std::vector<OwningStep> RootAccess::settle(const std::set<OwningStep>& absent, const std::set<TreeId>& live) {
  std::vector<OwningStep> moved;
  std::lock_guard<std::mutex> lock(mutex_);
  for (auto held = absent_.begin(); held != absent_.end();) {
    if (live.count(held->tree) || absent.count(*held)) {
      ++held;
      continue;
    }
    moved.push_back(*held);
    held = absent_.erase(held);
  }
  for (const OwningStep& step : absent)
    if (!live.count(step.tree) && absent_.insert(step).second) moved.push_back(step);
  settled_.store(true);
  return moved;
}

TreeRoom::~TreeRoom() {
  if (pendingOps_.empty()) return;
  LOG_WARN << "room operation rows not committed count=" << pendingOps_.size();
}

TreeRoom::TreeRoom(TreeId id, Lww<std::string> title, Lww<std::string> guide, bool guideInherited, LooseGraph graph,
                   Legend legend, Seq head, TreeId root, std::vector<OwningStep> path,
                   std::map<NodeId, TreeId> subtrees, std::shared_ptr<RootAccess> access, std::uint64_t createdAt,
                   PresenceBus& bus)
    : id_(std::move(id)), title_(std::move(title)), guide_(std::move(guide)), guideInherited_(guideInherited),
      graph_(std::move(graph)), legend_(std::move(legend)), head_(head), root_(std::move(root)), path_(std::move(path)),
      subtrees_(std::move(subtrees)), access_(std::move(access)), createdAt_(createdAt), bus_(bus),
      clock_(std::string{kServerActor}) {
  // Fold every stamp the loaded document already carries — the graph frontier and the title and guide
  // registers — so a fresh mint after restart is always ahead of anything persisted.
  VersionVector loaded = frontier(graph_.exportState(), legend_.exportState());
  loaded.observe(title_.stamp);
  loaded.observe(guide_.stamp);
  for (const auto& [actor, mark] : loaded.marks) clock_.observe(mark);
  held_ = HeldStamps{std::move(loaded)};
  // The room opens as its stored rows stand, which no other room of the tree's can have written past: its owning steps
  // are recorded as they are, so an access that missed a write without a room learns them here.
  recordOwningSteps();
}

Hlc TreeRoom::nextStamp(std::uint64_t nowMs) {
  return clock_.tick(nowMs);
}

std::optional<Seq> TreeRoom::joinSubgraph(const Subgraph& incoming, const UserId& actor) {
  insistConfirmed(graph_.removedBy(incoming.graph), incoming.branches);
  if (!appliedOpIds_.insert(incoming.frameId).second) return std::nullopt;
  Hlc stamp;
  for (const auto& [_, mark] : frontier(incoming).marks) {
    clock_.observe(mark);
    if (stamp < mark) stamp = mark;  // the frame's causal position, for the feed op
  }
  const bool titleTook = incoming.title && title_.merge(incoming.title->value, incoming.title->stamp);
  const bool guideTook = incoming.guide && incoming.guide->stamp > guide_.stamp;
  if (guideTook) {
    guide_ = *incoming.guide;
    guideInherited_ = false;  // the guide that won is a write of this tree's, not its source's
  }
  // What the room took of the frame: the frame as sent, each entry cut to the registers that landed. A register the
  // room already holds changed nothing, so it marks no row to save, names no deed and is not sent on.
  Subgraph landed = incoming;
  landed.branches.clear();  // a confirmation for this server, never sent on
  landed.graph = graph_.join(incoming.graph);
  landed.legend = legend_.join(incoming.legend);
  if (!titleTook) landed.title.reset();
  if (!guideTook) landed.guide.reset();
  if (!titleTook && !guideTook && landed.graph.empty() && landed.legend.empty()) return std::nullopt;
  markDirty(landed.graph, landed.legend);
  unsaved_ = true;
  ++writes_;
  ++head_;
  std::size_t lateRegisters = landSeqs_.landLate(landed.graph, landed.legend, held_, head_);
  if (titleTook && held_.holds(title_.stamp)) {
    landSeqs_.title = head_;
    ++lateRegisters;
  }
  if (guideTook && held_.holds(guide_.stamp)) {
    landSeqs_.guide = head_;
    ++lateRegisters;
  }
  held_.marks.join(frontier(landed));
  if (lateRegisters > 0) {
    const std::string door = currentWriteDoor();
    LOG_INFO << "roadmap_late_landing door=" << (door.empty() ? "background" : door) << " registers=" << lateRegisters;
  }
  // One op per frame at the seq the frame just took, keyed on the frameId so a re-gossip never
  // double-counts. A frame with no feed-worthy deed (headline) queues nothing.
  if (std::optional<Command> deed = headline(landed.graph, landed.legend, graph_, legend_))
    pendingOps_.push_back(AppliedOp{head_, incoming.frameId, *deed, stamp, actor});
  recordOwningSteps();
  bus_.broadcastSubgraph(id_, head_, landed);
  return head_;
}

Seq TreeRoom::describe(const std::optional<std::string>& title, const std::optional<std::string>& guide,
                       std::uint64_t nowMs) {
  Hlc stamp = clock_.tick(nowMs);
  Subgraph frame;
  frame.treeId = id_;
  frame.frameId = "srv-describe-" + toString(stamp);
  frame.actor = stamp.actor;
  frame.intent = SubgraphIntent::live;
  if (title) frame.title = Lww<std::string>{*title, stamp};
  if (guide) frame.guide = Lww<std::string>{*guide, stamp};
  return joinSubgraph(frame, UserId{stamp.actor}).value_or(head_);
}

Seq TreeRoom::applyCommand(const Command& command, std::uint64_t nowMs, const UserId& actor) {
  return applyCommands({command}, nowMs, actor);
}

Seq TreeRoom::applyCommands(const std::vector<Command>& commands, std::uint64_t nowMs, const UserId& actor,
                            const std::set<TreeId>& branches) {
  if (commands.empty()) return head_;  // nothing to apply mints no seq, logs no op, broadcasts nothing
  insistConfirmed(deletedBy(commands, graph_), branches);
  Hlc stamp = clock_.tick(nowMs);  // one stamp for the whole frame, as a graft takes one
  std::string frameId = "srv-" + toString(stamp);  // unique: the clock mints monotone stamps
  appliedOpIds_.insert(frameId);
  VersionVector before = frontier(graph_.exportState(), legend_.exportState());
  for (const Command& command : commands) merge(graph_, legend_, command, stamp);
  unsaved_ = true;
  ++writes_;
  ++head_;

  Subgraph produced = deltaBetween(graph_.exportState(), legend_.exportState(), before);
  produced.treeId = id_;
  produced.frameId = frameId;
  produced.actor = stamp.actor;
  produced.intent = SubgraphIntent::live;
  // The op row is the whole frame: a lone command as itself, a batch as one Batch, so the feed
  // tells all of what this call did.
  const Command deed = commands.size() == 1 ? commands.front() : Command{Batch{commands}};
  pendingOps_.push_back(AppliedOp{head_, frameId, deed, stamp, actor});
  markDirty(produced.graph, produced.legend);  // the broadcast delta is exactly the write's footprint
  held_.marks.join(frontier(produced));  // minted past everything held, so nothing of it is late
  recordOwningSteps();
  bus_.broadcastSubgraph(id_, head_, produced);
  return head_;
}

std::optional<Seq> TreeRoom::importTree(const Graft& incoming, std::uint64_t nowMs, const UserId& actor) {
  Hlc at = clock_.tick(nowMs);  // one dominating stamp for the whole graft: the upsert and every removal
  GraftFrame landed = graftFrame(graph_, legend_, incoming, at);
  if (landed.landsNothing()) return std::nullopt;
  Subgraph frame;
  frame.treeId = id_;
  frame.frameId = "srv-import-" + toString(at);
  frame.actor = at.actor;
  frame.intent = SubgraphIntent::graft;
  frame.graph = std::move(landed.graph);
  frame.legend = std::move(landed.legend);
  frame.branches = incoming.branches;
  return joinSubgraph(frame, actor).value_or(head_);
}

std::optional<Admission> TreeRoom::admit(const Subgraph& incoming) const {
  if (std::optional<Admission> refusal = wm::admit(graph_, incoming.graph)) return refusal;
  if (std::optional<Admission> refusal = wm::admit(legend_, incoming.legend)) return refusal;
  if (incoming.title) {
    if (std::optional<Admission> refusal = admitTitle(incoming.title->value)) return refusal;
  }
  if (!incoming.guide) return std::nullopt;
  return admitStampedGuide(incoming.guide->value);
}

std::optional<std::string> TreeRoom::validate(const Command& command) const {
  return wm::validate(graph_, legend_, command);
}

std::vector<UnconfirmedBranch> TreeRoom::unconfirmedBranches(const Subgraph& incoming) const {
  return wm::unconfirmedBranches(graph_.removedBy(incoming.graph), subtrees_, incoming.branches);
}

std::vector<UnconfirmedBranch> TreeRoom::unconfirmedBranches(const Graft& incoming) const {
  return wm::unconfirmedBranches(footprintOf(incoming).tombstonedNodes, subtrees_, incoming.branches);
}

std::vector<UnconfirmedBranch> TreeRoom::unconfirmedBranches(const std::vector<NodeId>& deleting,
                                                             const std::set<TreeId>& branches) const {
  std::vector<NodeId> present;
  for (const NodeId& node : deleting)
    if (graph_.hasNode(node)) present.push_back(node);
  return wm::unconfirmedBranches(present, subtrees_, branches);
}

void TreeRoom::insistConfirmed(const std::vector<NodeId>& removed, const std::set<TreeId>& branches) const {
  if (!wm::unconfirmedBranches(removed, subtrees_, branches).empty())
    throw std::logic_error("a write would remove an owning step whose subtree it does not name");
}

void TreeRoom::recordOwningSteps() {
  for (const auto& [step, subtree] : subtrees_) access_->record(OwningStep{id_, step}, graph_.hasNode(step));
}

void TreeRoom::ownSubtree(const NodeId& step, const TreeId& subtree) {
  subtrees_[step] = subtree;
  access_->record(OwningStep{id_, step}, graph_.hasNode(step));
}

void TreeRoom::appendSubtree(const NodeId& step, const Subtree& subtree) {
  ++head_;
  ownSubtree(step, subtree.id);
  bus_.broadcastSubtree(id_, head_, step, subtree);
}

void TreeRoom::dropLandedOps(std::size_t landed) {
  pendingOps_.erase(pendingOps_.begin(), pendingOps_.begin() + static_cast<std::ptrdiff_t>(std::min(landed, pendingOps_.size())));
}

void TreeRoom::markDirty(const GraphState& graph, const LegendState& legend) {
  for (const NodeStateEntry& node : graph.nodes) dirtyNodes_.insert(node.id);
  for (const EdgeStateEntry& edge : graph.edges) dirtyEdges_.insert(edge.edge);
  for (const KindStateEntry& kind : legend.kinds) dirtyKinds_.insert(kind.id);
}

std::pair<GraphState, LegendState> TreeRoom::dirtyState() const {
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
  unsaved_ = false;
  dirtyNodes_.clear();
  dirtyEdges_.clear();
  dirtyKinds_.clear();
}

TreeDiagnostics TreeRoom::diagnose() const {
  return TreeDiagnostics::assess(graph_, legend_);
}

std::map<NodeId, TreeId> TreeRoom::subtrees() const {
  std::map<NodeId, TreeId> owned;
  for (const auto& [step, subtree] : subtrees_)
    if (graph_.hasNode(step)) owned.emplace(step, subtree);
  return owned;
}

std::map<NodeId, TreeId> TreeRoom::pointers() const {
  std::map<NodeId, TreeId> opened = graph_.pointers();
  for (const auto& [step, subtree] : subtrees()) opened[step] = subtree;
  return opened;
}

std::map<NodeId, StampedPointer> TreeRoom::stampedPointers() const {
  std::map<NodeId, StampedPointer> opened = graph_.stampedPointers();
  for (const auto& [step, subtree] : subtrees()) opened[step] = StampedPointer{subtree, Hlc{}};
  return opened;
}

TreeData TreeRoom::snapshot() const {
  ++snapshots_;
  TreeData data = graph_.toTreeData(id_, title_.value);
  data.guide = guide_.value;
  data.kinds = legend_.kinds();
  for (NodeSpec& node : data.nodes)
    if (const auto owned = subtrees_.find(node.id); owned != subtrees_.end()) node.opens = owned->second;
  return data;
}

Subgraph TreeRoom::deltaSince(const VersionVector& since, std::optional<Seq> position) const {
  const auto landedPast = [&position](Seq landSeq) { return position && landSeq > *position; };
  Subgraph delta = deltaBetween(graph_.exportState(), legend_.exportState(), since,
                                position ? landSeqs_.past(*position) : Landed{});
  delta.treeId = id_;
  if (path_.empty()) {
    if (!since.covers(title_.stamp) || landedPast(landSeqs_.title)) delta.title = title_;
    delta.coverage->observe(title_.stamp);
  }
  if (!since.covers(guide_.stamp) || landedPast(landSeqs_.guide)) delta.guide = guide_;
  delta.coverage->observe(guide_.stamp);
  return delta;
}

std::size_t TreeRoom::lateEntriesFor(const VersionVector& since, Seq position) const {
  const Landed late = landSeqs_.past(position);
  std::size_t entries = 0;
  if (!late.nodes.empty() || !late.edges.empty() || !late.kinds.empty())
    entries = hiddenBy(since, graph_.exportState(), legend_.exportState(), late);
  // A register that holds a land seq was written, so its stamp is set.
  if (path_.empty() && landSeqs_.title > position && since.covers(title_.stamp)) ++entries;
  if (landSeqs_.guide > position && since.covers(guide_.stamp)) ++entries;
  return entries;
}

std::map<NodeId, TreeId> TreeRoom::pointersFor(const std::optional<UserId>& caller) const {
  if (!canWrite(caller, owner())) return {};
  return pointers();
}

std::vector<NodeId> TreeRoom::prerequisitesOf(const NodeId& node) const {
  std::optional<NodeSpec> view = graph_.nodeView(node);
  return view ? std::move(view->prerequisites) : std::vector<NodeId>{};
}

bool TreeRoom::hasNode(const NodeId& node) const {
  return graph_.hasNode(node);
}

std::optional<std::string> TreeRoom::labelOf(const NodeId& node) const {
  if (!graph_.hasNode(node)) return std::nullopt;
  return graph_.exportNode(node)->label;
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
