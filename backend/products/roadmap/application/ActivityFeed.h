#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"
#include "products/roadmap/ports/Op.h"

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace wm {

// A human-facing feed entry, projected from one op in the log and denormalized with the
// tree's current labels and (when the graph is clean) its TrunkTree branch context — so
// the feed renders without replaying the log (§9).
struct ActivityEvent {
  Seq seq = 0;
  std::uint64_t at = 0;   // epoch ms
  std::string actor;      // display name: "You" | "Guest N" | "" (the tree / system)
  std::string verb;       // added|renamed|recolored|removed|linked|unlinked|rerouted|tidied
  NodeId node;            // primary subject (empty for whole-tree ops)
  std::string label;      // subject's current label (its id if the node is gone)
  std::string kind;       // subject's current colour
  std::string summary;    // ready-to-render sentence
};

// Projects the op-log tail into feed events, keeping the most recent `limit`. Position
// nudges are omitted — too low-signal for a feed. Pure: the Action loads the current
// document and the ops; this shapes them.
std::vector<ActivityEvent> activityFeed(const TreeData& current, const std::vector<AppliedOp>& ops, std::size_t limit);

}
