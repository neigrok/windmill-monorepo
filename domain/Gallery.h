#pragma once

#include "domain/Ids.h"
#include "domain/Tree.h"
#include "domain/TreeSummary.h"

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace wm {

// A candidate for the public wall: one tree its owner listed (Visibility::public_ — the
// deliberate act past unlisted, which means "reachable by link", not "listed"), the OWNER's
// overlay because a shared tree shows the owner's journey, when it last moved forward, and how
// many trees were forked from it.
struct WallCandidate {
  TreeData data;
  Progress ownerProgress;
  std::uint64_t updatedAt = 0;
  int forks = 0;
};

// One row of the wall — everything a stranger reads before deciding to click through to the
// tree itself. No author: the wall exhibits the tree, never the person who planted it.
struct GalleryEntry {
  TreeId id;
  std::string title;
  TreeStats stats;
  int forks = 0;
  std::uint64_t updatedAt = 0;
};

// A tree earns a place only once it reads as a plan rather than a stub: it carries a name, and
// at least this many steps. Listing is the owner's choice; being *worth a stranger's click* is
// the wall's, and this is the whole of that judgement.
inline constexpr int kWallMinimumSteps = 3;

// The wall: drop the candidates that haven't earned a place, order by the forks they inspired
// (the one honest popularity signal we have — a fork is someone taking the plan for themselves),
// then by freshness, then by id so the order never wobbles between two equal rows. Keep the
// first `limit`.
std::vector<GalleryEntry> publicWall(const std::vector<WallCandidate>& candidates, std::size_t limit);

}
