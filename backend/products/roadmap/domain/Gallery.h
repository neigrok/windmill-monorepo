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

// A candidate for the public wall. The overlay is the OWNER's, not the reader's; `sourceTitle`
// arrives already resolved, because whether a source may be named at all is a privacy rule the
// repository owns.
struct WallCandidate {
  TreeData data;
  UserId owner;
  Progress ownerProgress;
  // A structural edit stamps the tree's own row; a progress mark stamps only the owner's overlay.
  // The ranking folds them (lastActiveAt).
  std::uint64_t updatedAt = 0;
  std::uint64_t lastMarkedAt = 0;
  int forks = 0;
  std::string sourceTitle;
};

// Default-constructed is the anonymous reader, which knows nobody, so every entry reads the same.
struct Viewer {
  std::optional<UserId> user;
  std::set<TreeId> forked;  // the SOURCES this reader has already forked, never the copies
};

// One row of the wall. No author: it exhibits the tree, never the person who planted it. `mine` and
// `forked` are the only caller-relative facts, and both are false for the anonymous reader.
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

// A tree earns a place only once it carries a name and at least this many steps. There is no
// progress floor — an abandoned plan loses to ranking, not to a gate.
inline constexpr int kWallMinimumSteps = 3;

// Ranked: drop the candidates that haven't earned a place, then order by forks, by last-active,
// then by id so two equal rows never wobble. Every surface reads this one function.
std::vector<GalleryEntry> publicWall(const std::vector<WallCandidate>& candidates, const Viewer& viewer);

// The `limit` entries following the one `cursor` names (an empty cursor starts at the top), plus
// the token that resumes after this page — empty when the page ends the index.
struct WallPage {
  std::vector<GalleryEntry> entries;
  std::string nextCursor;
};

// nullopt when the cursor names no entry in this index: a walk that silently restarted would
// re-serve rows the caller has already read.
std::optional<WallPage> wallPage(const std::vector<GalleryEntry>& wall, const std::string& cursor,
                                 std::size_t limit);

}
