#include "application/TreeRegistry.h"

#include "domain/GraphState.h"
#include "domain/Legend.h"

#include <map>
#include <optional>
#include <utility>

namespace wm {

TreeRegistry::TreeRegistry(TreeRepository& trees, ProgressRepository& progress, TokenGenerator& tokens,
                           Hlc genesis)
    : trees_(trees), progress_(progress), tokens_(tokens), genesis_(std::move(genesis)) {}

TreeId TreeRegistry::create(const UserId& owner, const std::string& title) {
  TreeId id{"t_" + tokens_.mint().digest.substr(0, 16)};  // server-minted, unguessable, URL-safe
  GraphState empty;
  LegendState legend = Legend::seededDefaults(genesis_).exportState();  // Build/Learn/Milestone (F6)
  trees_.create(id, empty, legend, title, owner);
  return id;
}

std::vector<TreeSummary> TreeRegistry::list(const UserId& owner) {
  std::vector<OwnedTree> owned = trees_.listOwnedBy(owner);
  std::map<TreeId, ProgressDigest> overlays = progress_.overlaysFor(owner);

  std::vector<LoadedTree> loaded;
  loaded.reserve(owned.size());
  for (OwnedTree& tree : owned) {
    LoadedTree row;
    row.updatedAt = tree.updatedAt;
    row.data = std::move(tree.data);
    auto digest = overlays.find(row.data.id);
    if (digest != overlays.end()) {
      row.progress = std::move(digest->second.overlay);
      row.lastMarkedAt = digest->second.lastMarkedAt;
    }
    loaded.push_back(std::move(row));
  }
  return registrySummaries(loaded);
}

TreeRegistry::Removal TreeRegistry::remove(const TreeId& tree, const UserId& caller) {
  std::optional<StoredTree> stored = trees_.load(tree);
  if (!stored) return Removal::notFound;
  if (!stored->owner || *stored->owner != caller) return Removal::notOwner;
  trees_.softDelete(tree);
  return Removal::deleted;
}

}
