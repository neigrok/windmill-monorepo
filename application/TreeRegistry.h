#pragma once

#include "domain/Ids.h"
#include "domain/TreeSummary.h"
#include "ports/ProgressRepository.h"
#include "ports/TokenGenerator.h"
#include "ports/TreeRepository.h"

#include <string>
#include <vector>

namespace wm {

// The per-user tree registry: create, list, and delete the roadmaps a caller owns. A
// repo-direct read model — it never opens a room, so the list is save-consistent (an unsaved
// in-flight edit doesn't move a row). The one Action behind both the REST and MCP registry
// surfaces.
class TreeRegistry {
public:
  TreeRegistry(TreeRepository& trees, ProgressRepository& progress, TokenGenerator& tokens, Hlc genesis);

  // Plant a fresh roadmap owned by `owner` from `initial` — its title and any starting nodes +
  // legend kinds (all empty for a blank tree, which gets the default legend). Returns the minted id.
  TreeId create(const UserId& owner, const TreeData& initial);

  std::vector<TreeSummary> list(const UserId& owner);

  enum class Removal { deleted, notFound, notOwner };
  Removal remove(const TreeId& tree, const UserId& caller);

private:
  TreeRepository& trees_;
  ProgressRepository& progress_;
  TokenGenerator& tokens_;
  Hlc genesis_;
};

}
