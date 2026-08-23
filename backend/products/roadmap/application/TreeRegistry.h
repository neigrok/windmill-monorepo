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

// The per-user tree registry. A repo-direct read model — it never opens a room, so the list is
// save-consistent. Rename must stay coherent with a live room, so it hands the apply to
// RoomRegistry under the tree's strand.
class TreeRegistry {
public:
  TreeRegistry(TreeRepository& trees, ProgressRepository& progress, TokenGenerator& tokens,
               Hlc genesis, RoomRegistry& rooms, Clock& clock);

  // A blank tree (all-empty `initial`) is born with the default legend. Returns the minted id.
  TreeId create(const UserId& owner, const TreeData& initial);

  // Plant under a client-minted id, create-if-absent under the tree's strand. `existedYours` is the
  // idempotent resume; `retired` is the caller's own soft-deleted id; `taken` is only ever somebody
  // else's.
  enum class Creation { created, existedYours, retired, taken };
  Creation create(const UserId& owner, const TreeId& id, const TreeData& initial);

  std::vector<TreeSummary> list(const UserId& owner);

  // Each outcome names both write refusals of Access.h (an enum cannot hold another), because an
  // unowned tree is nobody's, not somebody else's.
  enum class Removal { deleted, notFound, notYours, nobodysTree };
  Removal remove(const TreeId& tree, const UserId& caller);

  // trim → refuse a blank → owner check → apply through RoomRegistry.
  enum class Renaming { renamed, notFound, notYours, nobodysTree, blankTitle };
  Renaming rename(const TreeId& tree, const UserId& caller, const std::string& title);

  // owner check → set read visibility through RoomRegistry: the durable column write plus the live
  // room's cache, so a just-shared tree stops 404-ing at once.
  enum class VisibilityChange { changed, notFound, notYours, nobodysTree };
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
