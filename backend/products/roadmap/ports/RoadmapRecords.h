#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/read/RoadmapTree.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <chrono>
#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace wm {

// One account's roadmaps as the engine holds them: every roadmap its `tree` records name, a dead one with no records,
// each other loaded with its own records and the owner's marks and pointers; and when the server last wrote a record of
// each (epoch ms), the roadmap's own edits and not its marks.
struct AccountRoadmaps {
  std::vector<roadmap::read::TreeRecords> trees;
  std::map<std::string, std::uint64_t> editedAt;
};

// A root the gallery may list: its owner and its lineage as a reader is told it.
struct ListedRoot {
  TreeId id;
  UserId owner;
  ForkLineage lineage;
};

// Roadmap's records in the engine's roadmap_* tables, read for the read models the server answers beside sync (Roadmap
// on the sync engine §7): the activity, the share page, the gallery, the owner's progress shown to readers and
// reminders' readiness. None answers admission.
struct RoadmapRecords {
  virtual ~RoadmapRecords() = default;
  // The account whose `tree` record names `tree`, alive or not; none for an id no record holds.
  virtual std::optional<UserId> ownerOf(const TreeId& tree) = 0;
  // `owner`'s roadmaps: every one, or with `only` those of `only` alone, the rest left out as an account the reader does
  // not hold. With a `budget` the read is given that long and no longer: past it the read is abandoned, holding nothing,
  // and throws FollowTimedOut.
  virtual AccountRoadmaps roadmapsOf(const UserId& owner, const std::optional<std::set<TreeId>>& only = std::nullopt,
                                     std::optional<std::chrono::milliseconds> budget = std::nullopt) = 0;
  // Every alive public root but the house account's, each with its lineage.
  virtual std::vector<ListedRoot> publicRoots() = 0;
  // Whether `tree` is a copy, the name of its source while that source is an alive public root, and how many alive roots
  // copy it.
  virtual ForkLineage lineageOf(const TreeId& tree) = 0;
  // The sources `viewer`'s alive roadmaps were copied from.
  virtual std::set<TreeId> forkedSources(const UserId& viewer) = 0;
};

}
