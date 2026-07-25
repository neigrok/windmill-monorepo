#include "domain/Gallery.h"

#include <algorithm>

namespace wm {

std::vector<GalleryEntry> publicWall(const std::vector<WallCandidate>& candidates, std::size_t limit) {
  std::vector<GalleryEntry> wall;
  wall.reserve(candidates.size());
  for (const WallCandidate& candidate : candidates) {
    // A title of nothing but whitespace is no title at all — it would hang a blank card on the
    // wall, so it fails the same test an empty one does.
    if (candidate.data.title.find_first_not_of(" \t\n\r") == std::string::npos) continue;
    const TreeStats stats = treeStats(candidate.data, candidate.ownerProgress);
    if (stats.total < kWallMinimumSteps) continue;

    GalleryEntry entry;
    entry.id = candidate.data.id;
    entry.title = candidate.data.title;
    entry.stats = stats;
    entry.forks = candidate.forks;
    entry.updatedAt = candidate.updatedAt;
    wall.push_back(std::move(entry));
  }

  std::sort(wall.begin(), wall.end(), [](const GalleryEntry& a, const GalleryEntry& b) {
    if (a.forks != b.forks) return a.forks > b.forks;
    if (a.updatedAt != b.updatedAt) return a.updatedAt > b.updatedAt;
    return a.id < b.id;
  });

  if (wall.size() > limit) wall.resize(limit);
  return wall;
}

}
