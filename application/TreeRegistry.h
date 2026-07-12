#pragma once

#include "domain/Ids.h"
#include "domain/TreeSummary.h"
#include "ports/ProgressRepository.h"
#include "ports/TreeRepository.h"

#include <vector>

namespace wm {

// The per-user tree registry: the roadmaps a caller owns. A repo-direct read model — it
// never opens a room, so the list is save-consistent (an unsaved in-flight edit doesn't move
// a row). The one Action behind both the REST and MCP registry surfaces.
class TreeRegistry {
public:
  TreeRegistry(TreeRepository& trees, ProgressRepository& progress);

  std::vector<TreeSummary> list(const UserId& owner);

  enum class Removal { deleted, notFound, notOwner };
  Removal remove(const TreeId& tree, const UserId& caller);

private:
  TreeRepository& trees_;
  ProgressRepository& progress_;
};

}
