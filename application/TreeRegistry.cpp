#include "application/TreeRegistry.h"

#include "domain/GraphState.h"
#include "domain/Legend.h"
#include "domain/LooseGraph.h"

#include <map>
#include <optional>
#include <utility>

namespace wm {

TreeRegistry::TreeRegistry(TreeRepository& trees, ProgressRepository& progress, TokenGenerator& tokens,
                           Hlc genesis)
    : trees_(trees), progress_(progress), tokens_(tokens), genesis_(std::move(genesis)) {}

TreeId TreeRegistry::create(const UserId& owner, const TreeData& initial) {
  TreeId id{"t_" + tokens_.mint().digest.substr(0, 16)};  // server-minted, unguessable, URL-safe
  GraphState state = LooseGraph(initial, genesis_).exportState();  // seed the starting nodes/edges
  // Honour a posted legend; otherwise a blank tree is born with the three defaults (F6).
  LegendState legend = initial.kinds.empty() ? Legend::seededDefaults(genesis_).exportState()
                                             : Legend(initial.kinds, genesis_).exportState();
  trees_.create(id, state, legend, initial.title, owner);
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
