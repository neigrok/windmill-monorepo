#pragma once

#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/TreeSummary.h"
#include "platform/ports/Clock.h"
#include "products/roadmap/ports/ProgressRepository.h"
#include "platform/ports/TokenGenerator.h"
#include "products/roadmap/ports/TreeRepository.h"

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

  // The claim seam: plant under a client-minted id, create-if-absent under the tree's strand.
  // `existedYours` is the idempotent resume — the caller already owns the id, the row is left
  // untouched. `taken` covers another account's tree, an unclaimed one, and a soft-deleted id.
  enum class Creation { created, existedYours, taken };
  Creation create(const UserId& owner, const TreeId& id, const TreeData& initial);

  std::vector<TreeSummary> list(const UserId& owner);

  enum class Removal { deleted, notFound, notOwner };
  Removal remove(const TreeId& tree, const UserId& caller);

  // Retitle an owned tree: trim → refuse a blank (a tree always has a name) → owner check →
  // apply through RoomRegistry (live room broadcast, or a plain column write when closed).
  enum class Renaming { renamed, notFound, notOwner, blankTitle };
  Renaming rename(const TreeId& tree, const UserId& caller, const std::string& title);

  // Reshare an owned tree: owner check → set its read visibility through RoomRegistry (durable
  // column write, plus the live room's cache so a just-shared tree stops 404-ing at once).
  enum class VisibilityChange { changed, notFound, notOwner };
  VisibilityChange setVisibility(const TreeId& tree, const UserId& caller, Visibility visibility);

private:
  TreeRepository& trees_;
  ProgressRepository& progress_;
  TokenGenerator& tokens_;
  Hlc genesis_;
  RoomRegistry& rooms_;
  Clock& clock_;
};

}
