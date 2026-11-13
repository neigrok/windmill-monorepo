#pragma once

#include "platform/ports/Clock.h"
#include "products/roadmap/application/ProgressService.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/application/TreeRoom.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/ports/PresenceBus.h"

#include <cstddef>
#include <map>
#include <string>
#include <variant>
#include <vector>

namespace wm {

// Whether a deletion takes the edges it leaves dangling with it.
enum class DanglingEdges { kept, removed };

// What a deletion came to: the seq it took, the dangling edges that went with the nodes, the caller's marks on the nodes
// that were cleared, and whether the room's save kept it. Unsaved, the tree's row was gone when the room saved — an
// erasure or a removal racing it — so the room was retired, as every write retires a room whose row went away.
struct DeletedNodes {
  Seq seq = 0;
  std::size_t edges = 0;
  std::size_t marks = 0;
  bool saved = true;
};

// The edits a server door makes to a tree's nodes for its caller beside the commands the room joins: the marks it sets
// for them, the marks it clears on what it removes, and the nodes it deletes. MCP and the registry's removal of a tree
// both edit through it, so a node goes the same way whichever door takes it.
class NodeEdits {
public:
  NodeEdits(RoomRegistry& rooms, ProgressService& progress, PresenceBus& bus, Clock& clock);

  // The caller's marks a server write sets, landed by the one path every such write takes, the clears below among them.
  // Each write comes stamped by the room's clock and is written as a server's (StampedBy::server): where the caller's
  // mark on that node holds a later stamp — a replica stamped it ahead of the server — the write itself takes the stamp
  // just after that one, so it always lands over it, whatever another door wrote a moment before; the room's clock
  // does not learn that stamp, so it carries no other write of the tree ahead. A node named twice is stamped after its
  // own row. The marks go through ProgressService::mark with `pointers`, the nodes that open a tree as the room handed
  // them to the caller: a mark on one that follows its tree is refused. The batch is written in one go, and the marks
  // that landed go to the caller's open sessions in one progress frame, at the stamps they took.
  ProgressReceipt landMarks(const TreeId& tree, const UserId& user, const std::map<NodeId, TreeId>& pointers,
                            const std::vector<ProgressWrite>& writes);

  // The caller's own completion marks on the nodes a write removes, cleared to none through landMarks, so a revive of the
  // node brings none back; anyone else's marks stay theirs. A node that opens a tree goes with its mark as any other
  // does, so no pointer is judged. A write that removed no node has nothing to clear and reads no overlay. Called under
  // the tree's strand with its room open, as the write that removes the nodes is; answers how many clears landed.
  std::size_t clearMarksOn(TreeRoom& room, const TreeId& tree, const UserId& actor, const std::vector<NodeId>& removed);

  // `nodes` deleted from the room as ONE op under one seq, with the edges touching them when `edges` says so, so the tree
  // is never seen between them: each command checked first, a refusal answered with nothing written; then the actor's
  // marks on the nodes cleared, before the delete lands, so a progress store that fails fails the deletion with nothing
  // deleted and a retry does the whole of it; then the op applied, broadcast to the tree's open pages, and saved. Called
  // under the tree's strand with its room open. Answered unsaved, the room is retired and the caller holds none. A save
  // that throws does so after the op applied: the room's head has moved, and the room's next save lands the delete.
  std::variant<DeletedNodes, std::string> deleteNodes(TreeRoom& room, const TreeId& tree,
                                                      const std::vector<NodeId>& nodes, DanglingEdges edges,
                                                      const UserId& actor);

private:
  RoomRegistry& rooms_;
  ProgressService& progress_;
  PresenceBus& bus_;
  Clock& clock_;
};

}
