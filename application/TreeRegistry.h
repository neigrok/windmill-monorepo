#pragma once

#include "application/RoomRegistry.h"
#include "domain/Ids.h"
#include "domain/TreeSummary.h"
#include "ports/Clock.h"
#include "ports/ProgressRepository.h"
#include "ports/TokenGenerator.h"
#include "ports/TreeRepository.h"

#include <string>
#include <vector>

namespace wm {

// The per-user tree registry: create, list, rename, and delete the roadmaps a caller owns.
// A repo-direct read model — it never opens a room, so the list is save-consistent (an
// unsaved in-flight edit doesn't move a row). Rename is the one write that must stay
// coherent with a live room (its cached title rides every save), so it hands the apply to
// RoomRegistry under the tree's strand. The one Action behind both the REST and MCP
// registry surfaces.
class TreeRegistry {
public:
  TreeRegistry(TreeRepository& trees, ProgressRepository& progress, TokenGenerator& tokens,
               Hlc genesis, RoomRegistry& rooms, Clock& clock);

  // Plant a fresh roadmap owned by `owner` from `initial` — its title and any starting nodes +
  // legend kinds (all empty for a blank tree, which gets the default legend). Returns the minted id.
  TreeId create(const UserId& owner, const TreeData& initial);

  std::vector<TreeSummary> list(const UserId& owner);

  enum class Removal { deleted, notFound, notOwner };
  Removal remove(const TreeId& tree, const UserId& caller);

  // Retitle an owned tree: trim → refuse a blank (a tree always has a name) → owner check →
  // apply through RoomRegistry (live room broadcast, or a plain column write when closed).
  enum class Renaming { renamed, notFound, notOwner, blankTitle };
  Renaming rename(const TreeId& tree, const UserId& caller, const std::string& title);

private:
  TreeRepository& trees_;
  ProgressRepository& progress_;
  TokenGenerator& tokens_;
  Hlc genesis_;
  RoomRegistry& rooms_;
  Clock& clock_;
};

}
