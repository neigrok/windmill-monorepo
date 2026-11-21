#include "products/roadmap/application/OwnerProgress.h"

#include <algorithm>
#include <new>
#include <optional>
#include <set>

namespace wm {

OwnerProgress::OwnerProgress(ProgressRepository& marks, TreeRepository& trees, Clock& clock)
    : marks_(marks), trees_(trees), clock_(clock), follows_(clock) {}

Progress OwnerProgress::stored(const TreeId& tree, const UserId& owner) { return marks_.load(tree, owner); }

ShownToReaders OwnerProgress::shownToReaders(const std::vector<OwnersTrees>& owners, std::chrono::milliseconds cap,
                                             const std::string& door) {
  // The follows come first: each owner's standing trees, or nothing for an owner left unread.
  ShownToReaders shown;
  std::map<UserId, std::optional<OpenedTrees>> byOwner;
  const std::uint64_t started = clock_.nowMs();
  for (const OwnersTrees& owner : owners) {
    std::set<TreeId> opened;
    for (const auto& [tree, pointers] : owner.trees)
      for (const auto& [node, pointer] : pointers) opened.insert(pointer.tree);
    std::optional<OpenedTrees>& standing = byOwner[owner.owner];
    if (opened.empty()) {
      // No pointer among this owner's trees: nothing is followed, and every row is the stored one.
      standing.emplace(std::map<TreeId, OpenedTree>{});
      continue;
    }
    const auto spent = std::chrono::milliseconds{static_cast<std::int64_t>(clock_.nowMs() - started)};
    standing = followed(owner.owner, opened, std::max(cap - spent, std::chrono::milliseconds{0}), door, shown.tally);
  }

  for (const OwnersTrees& owner : owners)
    for (const auto& [tree, pointers] : owner.trees)
      shown.progress.emplace(tree, readerView(tree, marks_.load(tree, owner.owner), pointers, byOwner.at(owner.owner)));
  return shown;
}

std::optional<OpenedTrees> OwnerProgress::followed(const UserId& owner, const std::set<TreeId>& opened,
                                                   std::chrono::milliseconds budget, const std::string& door,
                                                   FollowTally& tally) {
  return follows_.followed(owner, budget, door, tally, [&](std::chrono::milliseconds given) {
    return OpenedTrees(trees_.openedFrom(owner, opened, given));
  });
}

}
