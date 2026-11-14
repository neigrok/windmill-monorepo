#include "products/roadmap/application/NodeEdits.h"

#include "products/roadmap/domain/Command.h"

#include <algorithm>
#include <optional>

namespace wm {

NodeEdits::NodeEdits(RoomRegistry& rooms, ProgressService& progress, PresenceBus& bus, Clock& clock)
    : rooms_(rooms), progress_(progress), bus_(bus), clock_(clock) {}

ProgressReceipt NodeEdits::landMarks(const TreeId& tree, const UserId& user, const std::map<NodeId, TreeId>& pointers,
                                     const std::vector<ProgressWrite>& writes) {
  const ProgressReceipt receipt = progress_.mark(tree, pointers, user, writes, StampedBy::server, clock_.nowMs());
  // One echo for the whole batch, not one frame per node.
  bus_.broadcastProgress(tree, user, receipt.recorded);
  return receipt;
}

std::size_t NodeEdits::clearMarksOn(TreeRoom& room, const TreeId& tree, const UserId& actor,
                                    const std::vector<NodeId>& removed) {
  if (removed.empty()) return 0;
  const Progress overlay = progress_.progressOf(tree, actor);
  std::vector<ProgressWrite> clears;
  for (const NodeId& node : removed)
    if (overlay.completed.count(node))
      clears.push_back({node, ProgressStatus::none, room.prerequisitesOf(node), room.nextStamp(clock_.nowMs()), false});
  if (clears.empty()) return 0;
  const ProgressReceipt receipt = landMarks(tree, actor, {}, clears);
  // Counted off the writes: a completion another door cleared meanwhile was not this call's to clear.
  return static_cast<std::size_t>(
      std::count_if(receipt.outcomes.begin(), receipt.outcomes.end(),
                    [](const ProgressOutcome& outcome) { return outcome.applied && !outcome.unchanged; }));
}

std::variant<DeletedNodes, std::string> NodeEdits::deleteNodes(TreeRoom& room, const TreeId& tree,
                                                               const std::vector<NodeId>& nodes, DanglingEdges edges,
                                                               const UserId& actor) {
  std::vector<Command> commands;
  for (const NodeId& node : nodes) commands.push_back(DeleteNode{node});
  const std::vector<Edge> dangled = edges == DanglingEdges::removed ? room.edgesTouching(nodes) : std::vector<Edge>{};
  for (const Edge& edge : dangled) commands.push_back(RemoveEdge{edge.from, edge.to});
  for (const Command& command : commands)
    if (std::optional<std::string> reason = room.validate(command)) return *reason;

  const std::size_t cleared = clearMarksOn(room, tree, actor, nodes);
  const Seq seq = room.applyCommands(commands, clock_.nowMs(), actor);
  const Saved saved = rooms_.persist(tree);
  if (saved == Saved::gone) rooms_.retire(tree);
  return DeletedNodes{seq, dangled.size(), cleared, saved};
}

}
