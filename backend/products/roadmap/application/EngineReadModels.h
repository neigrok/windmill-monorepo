#pragma once

#include "platform/ports/Clock.h"
#include "products/roadmap/application/ActivityFeed.h"
#include "products/roadmap/application/OwnerFollows.h"
#include "products/roadmap/domain/Access.h"
#include "products/roadmap/domain/Gallery.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Reminders.h"
#include "products/roadmap/domain/Tree.h"
#include "products/roadmap/domain/read/RoadmapAccount.h"
#include "products/roadmap/ports/OpLog.h"
#include "products/roadmap/ports/RoadmapRecords.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace wm {

// A roadmap a caller may read, its owner's roadmaps read together: what each read model of it answers from.
struct ReadableRoadmap {
  TreeId tree;
  UserId owner;
  bool mine = false;
  roadmap::read::RoadmapAccount account;
};

// What a step's subtree has come to: its present steps complete, of all.
struct SubtreeCount {
  NodeId step;
  TreeId tree;
  std::size_t done = 0;
  std::size_t total = 0;
};

// The owner's progress on a roadmap as its caller is shown it, and what each of its standing subtrees has come to.
struct ShownProgress {
  Progress progress;
  std::vector<SubtreeCount> subtrees;
};

// The gallery's candidates, and what its follows of their owners came to.
struct EngineWall {
  std::vector<WallCandidate> candidates;
  FollowTally tally;
};

// What the share page names of a roadmap.
struct SharedRoadmap {
  std::string title;
  std::size_t steps = 0;
  Visibility visibility = Visibility::private_;
  ForkLineage lineage;
};

// Roadmap's read models over its engine records (roadmap-on-the-engine.md §7), which the routes answer while the engine
// serves roadmap: each is the read domain's answer (domain/read) over the owner's roadmaps, told in the words the routes
// answered before. A roadmap that does not stand is hidden from everyone, its owner included (§5 Hidden).
class EngineReadModels {
public:
  EngineReadModels(RoadmapRecords& records, OpLog& activity, Clock& clock);

  // The roadmap, when it stands and `caller` owns it or its reach lets anyone with its address read it.
  std::optional<ReadableRoadmap> open(const TreeId& tree, const std::optional<UserId>& caller);

  // The roadmap's access as a door that reads no more than its owner and who may read it checks it (the share card and
  // video): what open() reads, as the rooms' accessOf answers it.
  std::optional<TreeAccess> access(const TreeId& tree, const std::optional<UserId>& caller);

  // The activity feed's events after `since`, the latest `limit` of them, named by the roadmap's present steps.
  std::vector<ActivityEvent> activity(const ReadableRoadmap& roadmap, Seq since, std::size_t limit);

  // To its owner the marks as stored; to everyone else the marks a reader is shown: a step that owns a standing subtree,
  // or whose pointer opens a standing roadmap, is complete exactly when that roadmap is, dated when the server received
  // the mark that completed it (§5 Dates).
  ShownProgress progress(const ReadableRoadmap& roadmap);

  SharedRoadmap shared(const ReadableRoadmap& roadmap);

  // Every alive public root a person owns, read alone, as the rooms' gallery lists every owned public tree. Its owner's
  // other roadmaps, which its steps may open, are followed as the rooms' follows are (OwnerFollows): only for an owner
  // whose roots on the wall open one, in the order the wall shows their cards before their marks are known, within `cap`
  // in all; an owner left unread is shown with the steps that open a roadmap set aside.
  EngineWall wall(std::chrono::milliseconds cap);
  std::set<TreeId> forkedSources(const UserId& viewer);

  // One row per standing root of `owner`'s, with their own marks: the steps whose prerequisites are met and that are
  // not complete, in id order.
  std::vector<TreeReadiness> readiness(const UserId& owner);

private:
  RoadmapRecords& records_;
  OpLog& activity_;
  Clock& clock_;
  OwnerFollows follows_;
};

}
