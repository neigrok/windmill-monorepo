#pragma once

#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/TreeSummary.h"
#include "platform/ports/Clock.h"
#include "products/roadmap/ports/ProgressRepository.h"
#include "platform/ports/TokenGenerator.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <map>
#include <set>
#include <string>
#include <variant>
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

  // The title of each tree among `trees` that stands and is `owner`'s, by id — the trees a node of
  // theirs may open. Read off the stored rows, as list() is.
  std::map<TreeId, std::string> titlesOwnedBy(const UserId& owner, const std::set<TreeId>& trees);

  // What following `opened` finds among `owner`'s standing trees (TreeRepository::openedFrom), off the stored rows.
  std::map<TreeId, OpenedTree> openedFrom(const UserId& owner, const std::set<TreeId>& opened);

  // Each outcome names both write refusals of Access.h (an enum cannot hold another), because an
  // unowned tree is nobody's, not somebody else's.
  enum class Removal { deleted, notFound, notYours, nobodysTree };
  Removal remove(const TreeId& tree, const UserId& caller);

  // trim → refuse a blank, text that is not valid UTF-8 and a NUL → owner check → apply through
  // RoomRegistry. A tree whose row went away under its live room answers notFound.
  enum class Renaming { renamed, notFound, notYours, nobodysTree, blankTitle, malformedTitle, nulInTitle };
  Renaming rename(const TreeId& tree, const UserId& caller, const std::string& title);

  // admit → read gate → owner check → set the guide through the tree's room, durable before it
  // answers the seq the guide took. An empty guide clears it, and so does one of only whitespace. A
  // tree the caller cannot read, or whose row went away under its live room, answers notFound; a
  // guide past kMaxGuideChars, not valid UTF-8 or carrying a NUL answers its Admission.
  enum class GuideRefusal { notFound, notYours, nobodysTree };
  std::variant<Seq, GuideRefusal, Admission> setGuide(const TreeId& tree, const UserId& caller, const std::string& guide);

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
