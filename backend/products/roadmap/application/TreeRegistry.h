#pragma once

#include "products/roadmap/application/NodeEdits.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/TreeSummary.h"
#include "platform/ports/Clock.h"
#include "products/roadmap/ports/ProgressRepository.h"
#include "platform/ports/TokenGenerator.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <map>
#include <optional>
#include <set>
#include <string>
#include <variant>
#include <vector>

namespace wm {

// The per-user tree registry. A repo-direct read model — it never opens a room, so the list is
// save-consistent. Rename must stay coherent with a live room, so it hands the apply to
// RoomRegistry under the tree's strand; a removal edits the owner's other trees through NodeEdits.
class TreeRegistry {
public:
  TreeRegistry(TreeRepository& trees, ProgressRepository& progress, TokenGenerator& tokens,
               Hlc genesis, RoomRegistry& rooms, NodeEdits& edits, Clock& clock);

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

  // What following `opened` finds among `owner`'s standing trees (TreeRepository::openedFrom), off the stored rows,
  // within `budget` when one is given.
  std::map<TreeId, OpenedTree> openedFrom(const UserId& owner, const std::set<TreeId>& opened,
                                          std::optional<std::chrono::milliseconds> budget = std::nullopt);

  // The nearest of `owner`'s standing trees above `tree` that carry a guide (TreeRepository::guidedTreesAbove), off
  // the stored rows.
  std::map<TreeId, TreeAbove> guidedTreesAbove(const UserId& owner, const TreeId& tree);

  // Each refusal names both write refusals of Access.h (an enum cannot hold another), because an
  // unowned tree is nobody's, not somebody else's.
  enum class RemovalRefusal { notFound, notYours, nobodysTree };
  // owner check → soft-delete → retire the room, under the tree's strand. Then, with that strand released, the steps
  // that open the tree go with it: the caller's standing trees that hold such steps are read once, and each, in id
  // order and under its own strand alone, has them deleted as delete_node with prune deletes nodes (NodeEdits),
  // the caller's marks on them cleared. Each such tree writes one `roadmap.tree.remove.cascade` line; one it cannot edit
  // keeps its steps and is answered in `incomplete`.
  std::variant<Cascade, RemovalRefusal> remove(const TreeId& tree, const UserId& caller);

  // trim → refuse a blank, text that is not valid UTF-8 and a NUL → owner check → apply through
  // RoomRegistry. A tree whose row went away under its live room answers notFound.
  enum class Renaming { renamed, notFound, notYours, nobodysTree, blankTitle, malformedTitle, nulInTitle };
  Renaming rename(const TreeId& tree, const UserId& caller, const std::string& title);
  // The title a rename lands: trimmed, cut to kMaxTitleChars, or the refusal of a blank, malformed or NUL-holding one.
  static std::variant<std::string, Renaming> titleFrom(const std::string& title);
  // The words a title refusal is answered in, on every door.
  static const char* sentenceOf(Renaming refusal);

  // A title, a guide, or both, each set only when sent: rename's title rule and the guide's admission judge both
  // before either lands → read gate → owner check → one frame through the tree's room, durable before it answers
  // the seq it took. A title equal to the one the tree has is left out, and a call left with nothing to set lands
  // nothing and answers the head, `unchanged`. A tree whose row went away under its live room answers notFound.
  struct Description {
    std::optional<std::string> title;
    std::optional<std::string> guide;
  };
  struct Described {
    Seq seq = 0;
    bool unchanged = false;
  };
  std::variant<Described, Renaming, Admission> describe(const TreeId& tree, const UserId& caller,
                                                        const Description& sent);

  // describe with a guide alone: the seq the guide took. An empty guide clears it, and so does one of
  // only whitespace. A tree the caller cannot read, or whose row went away under its live room,
  // answers notFound; a guide past kMaxGuideChars, not valid UTF-8 or carrying a NUL answers its
  // Admission.
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
  NodeEdits& edits_;
  Clock& clock_;
};

}
