#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"
#include "products/roadmap/domain/TreeSummary.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace wm {

// A candidate for the public wall: one tree its owner listed (Visibility::public_, the deliberate
// act past unlisted), whose it is, the OWNER's overlay, the two stamps that say when it last moved
// forward, how many trees were forked from it, and the title of the tree it was itself forked
// from — carried already resolved, because whether a source may be named at all is a privacy rule
// the repository owns.
struct WallCandidate {
  TreeData data;
  UserId owner;
  Progress ownerProgress;
  // A structural edit stamps the tree's own row; a progress mark stamps only the owner's overlay.
  // Kept apart until the ranking folds them (lastActiveAt).
  std::uint64_t updatedAt = 0;
  std::uint64_t lastMarkedAt = 0;
  int forks = 0;
  std::string sourceTitle;
};

// Who is reading. Default-constructed is the anonymous reader, which knows nobody, so every entry
// reads the same to it.
struct Viewer {
  std::optional<UserId> user;
  std::set<TreeId> forked;  // the SOURCES this reader has already forked, never the copies
};

// One row of the wall. No author: the wall exhibits the tree, never the person who planted it; a
// fork names the TREE it came from and nothing else. `mine` and `forked` are the only
// caller-relative facts, and both are false for the anonymous reader.
struct GalleryEntry {
  TreeId id;
  std::string title;
  TreeStats stats;
  int forks = 0;
  // The freshest of the tree's own stamp and its owner's latest mark.
  std::uint64_t updatedAt = 0;
  std::string sourceTitle;
  bool mine = false;
  bool forked = false;
};

// A tree earns a place only once it carries a name and at least this many steps. There is
// deliberately no progress floor — an abandoned plan loses to ranking, not to a gate.
inline constexpr int kWallMinimumSteps = 3;

// The index, whole and ranked: drop the candidates that haven't earned a place, order by the forks
// they inspired, then by when the tree was last active, then by id so the order never wobbles
// between two equal rows. Every surface reads this one function: two URLs, one index.
std::vector<GalleryEntry> publicWall(const std::vector<WallCandidate>& candidates, const Viewer& viewer);

// One page of that index: the `limit` entries following the one `cursor` names (an empty cursor
// starts at the top), and the token that resumes after this page — empty when the page ends the
// index.
struct WallPage {
  std::vector<GalleryEntry> entries;
  std::string nextCursor;
};

// No page at all when the cursor names no entry in this index: a walk that silently restarted
// would hand back rows the caller has already read.
std::optional<WallPage> wallPage(const std::vector<GalleryEntry>& wall, const std::string& cursor,
                                 std::size_t limit);

}
