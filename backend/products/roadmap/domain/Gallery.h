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

// A candidate for the public wall: one tree its owner listed (Visibility::public_ — the
// deliberate act past unlisted, which means "reachable by link", not "listed"), whose it is, the
// OWNER's overlay because a shared tree shows the owner's journey, the two stamps that say when
// it last moved forward, how many trees were forked from it, and the title of the tree it was
// itself forked from — carried already resolved, because whether a source may be named at all is
// a privacy rule the repository owns (a source is named only while it exists and is public).
struct WallCandidate {
  TreeData data;
  UserId owner;
  Progress ownerProgress;
  // Kept apart until the ranking folds them (lastActiveAt): a structural edit stamps the tree's
  // own row, a progress mark stamps only the owner's overlay. Reading either alone mistakes one
  // kind of activity for none at all.
  std::uint64_t updatedAt = 0;
  std::uint64_t lastMarkedAt = 0;
  int forks = 0;
  std::string sourceTitle;
};

// Who is reading. Default-constructed is the anonymous reader — the public wall's — which knows
// nobody, so every entry reads the same to it. The in-product shelf fills this in, and it is the
// whole of the difference between the two surfaces: same index, same ranking, two readers.
struct Viewer {
  std::optional<UserId> user;
  std::set<TreeId> forked;  // the SOURCES this reader has already forked, never the copies
};

// One row of the wall — everything a reader takes in before deciding to open the tree. No
// author: the wall exhibits the tree, never the person who planted it. A fork names the TREE it
// came from and nothing else, which is the one attribution that carries. `mine` and `forked` are
// the only caller-relative facts on the row, and both are false for the anonymous reader.
struct GalleryEntry {
  TreeId id;
  std::string title;
  TreeStats stats;
  int forks = 0;
  // The folded answer, spelled the way a registry row spells it (domain/TreeSummary.h): the
  // freshest of the tree's own stamp and its owner's latest mark. Canon's "New = last-active
  // desc" sort mode is this field descending — the only thing missing is the chip.
  std::uint64_t updatedAt = 0;
  std::string sourceTitle;
  bool mine = false;
  bool forked = false;
};

// A tree earns a place only once it reads as a plan rather than a stub: it carries a name, and
// at least this many steps. Listing is the owner's choice; being *worth a stranger's click* is
// the wall's, and this is the whole of that judgement. There is deliberately no progress floor —
// an unstarted plan is still a plan, and an abandoned one loses to ranking, not to a gate.
inline constexpr int kWallMinimumSteps = 3;

// The index, whole and ranked: drop the candidates that haven't earned a place, order by the
// forks they inspired (the one honest popularity signal we have — a fork is someone taking the
// plan for themselves), then by when the tree was last active, then by id so the order never
// wobbles between two equal rows. Last-active is what carries the whole weight of "no progress
// floor": a tree its owner ticks a step on every week beats one nobody has opened in a year,
// without either being gated off the wall. Every surface reads this one function: two URLs, one
// index, never two rankings.
std::vector<GalleryEntry> publicWall(const std::vector<WallCandidate>& candidates, const Viewer& viewer);

// One page of that index: the `limit` entries following the one `cursor` names (an empty cursor
// starts at the top), and the token that resumes after this page — empty when the page ends the
// index. A cap without a way past it makes the rows beyond it unreachable, so a capped answer
// always carries the token that resumes it.
struct WallPage {
  std::vector<GalleryEntry> entries;
  std::string nextCursor;
};

// No page at all when the cursor names no entry in this index: a walk that silently restarted
// would hand back rows the caller has already read.
std::optional<WallPage> wallPage(const std::vector<GalleryEntry>& wall, const std::string& cursor,
                                 std::size_t limit);

}
