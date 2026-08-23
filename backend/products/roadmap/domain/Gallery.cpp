#include "products/roadmap/domain/Gallery.h"

#include <algorithm>

namespace wm {

std::vector<GalleryEntry> publicWall(const std::vector<WallCandidate>& candidates, const Viewer& viewer) {
  std::vector<GalleryEntry> wall;
  wall.reserve(candidates.size());
  for (const WallCandidate& candidate : candidates) {
    // A title of nothing but whitespace is no title at all — it fails the same test an empty one does.
    if (candidate.data.title.find_first_not_of(" \t\n\r") == std::string::npos) continue;
    const TreeStats stats = treeStats(candidate.data, candidate.ownerProgress);
    if (stats.total < kWallMinimumSteps) continue;

    GalleryEntry entry;
    entry.id = candidate.data.id;
    entry.title = candidate.data.title;
    entry.stats = stats;
    entry.forks = candidate.forks;
    entry.updatedAt = lastActiveAt(candidate.updatedAt, candidate.lastMarkedAt);
    entry.sourceTitle = candidate.sourceTitle;
    // The two facts the row wears about its reader. An anonymous Viewer owns nothing and has forked
    // nothing, so both fall out false without a special case.
    entry.mine = viewer.user && *viewer.user == candidate.owner;
    entry.forked = viewer.forked.count(candidate.data.id) > 0;
    wall.push_back(std::move(entry));
  }

  std::sort(wall.begin(), wall.end(), [](const GalleryEntry& a, const GalleryEntry& b) {
    if (a.forks != b.forks) return a.forks > b.forks;
    if (a.updatedAt != b.updatedAt) return a.updatedAt > b.updatedAt;
    return a.id < b.id;
  });

  return wall;
}

std::optional<WallPage> wallPage(const std::vector<GalleryEntry>& wall, const std::string& cursor,
                                 std::size_t limit) {
  std::size_t begin = 0;
  if (!cursor.empty()) {
    const auto resume = std::find_if(wall.begin(), wall.end(),
                                     [&](const GalleryEntry& entry) { return entry.id.str() == cursor; });
    if (resume == wall.end()) return std::nullopt;
    begin = static_cast<std::size_t>(resume - wall.begin()) + 1;
  }
  const std::size_t end = std::min(begin + limit, wall.size());

  WallPage page;
  page.entries.assign(wall.begin() + begin, wall.begin() + end);
  // The token is the last row handed out, so the next call resumes strictly after it.
  if (end < wall.size()) page.nextCursor = wall[end - 1].id.str();
  return page;
}

}
