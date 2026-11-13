#pragma once

#include "products/roadmap/application/NodeEdits.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Subtree.h"
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

  // What a caller may ask of the subtree it creates: an id it minted, and the kinds of its legend. Each is optional: a
  // free, well-formed id is kept and any other replaced by a minted one, and no kinds gives the default legend.
  struct SubtreeRequest {
    std::optional<TreeId> proposedId;
    std::optional<std::vector<Kind>> kinds;
  };
  // A subtree under `step` of `parent` (SPEC.md, Model, Subtrees), keyed by the pair, so a retry or a lost race answers
  // the subtree the step already owns, `created` false, and writes nothing. The kinds are judged first, as create_tree
  // judges them (admitBornKinds). Then, under the parent's strand, so it is serialised with every other write to the
  // parent, a step's deletion among them: read gate → write gate → the step stands → the stored site → the subtree the
  // step owns → depth → the step's legacy pointer → the child stored with its legend and the parent's next seq in one
  // transaction → that seq's `subtree` event told to the parent's subscribers. A step another writer filled meanwhile
  // is answered as owned, and an id another writer took meanwhile is replaced by a minted one, once. A call that fails
  // before the commit leaves no row, no seq and no event; one that fails after it is `unannounced`. One
  // `roadmap.subtree.create` line per call, at the door the call came through (`internal` outside one). No door calls
  // it yet.
  std::variant<SubtreeCreation, SubtreeRefusal, Admission> createSubtree(const TreeId& parent, const NodeId& step,
                                                                         const UserId& caller,
                                                                         const SubtreeRequest& request = {});

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
  // `cascadeUnavailable`: the trees whose steps open the tree could not be read, so nothing was removed.
  enum class RemovalRefusal { notFound, notYours, nobodysTree, cascadeUnavailable };
  // The read of the caller's trees whose steps open the tree, with no strand held, refused whole when it fails → owner
  // check → soft-delete → retire the room, under the tree's strand. Then, with that strand released, those steps go with
  // the tree: each tree, in id order and under its own strand alone, has them deleted as delete_node with prune deletes
  // nodes (NodeEdits), the caller's marks on them cleared, and is answered removed, unsaved or incomplete (Cascade).
  // The read and every tree's statements wait for a lock at most kCascadeLockWait, and all of it ends kCascadeTime after
  // the read began: a tree not reached by then is incomplete. Each tree edited writes one `roadmap.tree.remove.cascade`
  // line, and the removal one `roadmap_tree_remove_cascade` line of counts.
  std::variant<Cascade, RemovalRefusal> remove(const TreeId& tree, const UserId& caller);
  static constexpr std::chrono::milliseconds kCascadeLockWait{1'000};
  static constexpr std::chrono::milliseconds kCascadeTime{8'000};

  // trim → refuse a blank, text that is not valid UTF-8 and a NUL → owner check → apply through
  // RoomRegistry. A tree whose row went away under its live room answers notFound. A subtree's title is its owning
  // step's label, so it lands there (relabel).
  enum class Renaming { renamed, notFound, notYours, nobodysTree, blankTitle, malformedTitle, nulInTitle };
  Renaming rename(const TreeId& tree, const UserId& caller, const std::string& title);
  // The title a rename lands: trimmed, cut to kMaxTitleChars, or the refusal of a blank, malformed or NUL-holding one.
  static std::variant<std::string, Renaming> titleFrom(const std::string& title);
  // The words a title refusal is answered in, on every door.
  static const char* sentenceOf(Renaming refusal);

  // A title, a guide, or both, each set only when sent: rename's title rule and the guide's admission judge both
  // before either lands → read gate → owner check → one frame through the tree's room, durable before it answers
  // the seq it took. A title equal to the one the tree has is left out, and a call left with nothing to set lands
  // nothing and answers the head, `unchanged`. A tree whose row went away under its live room answers notFound. A
  // subtree's title lands first, as its owning step's label in its parent (relabel), and its guide after it in its own
  // room: the seq answered is of its own stream, its head when only the title moved, and `unchanged` says neither did.
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

  // owner check → a root's alone, a subtree answering NotARoot with its owning step → set read visibility through
  // RoomRegistry: the durable column write plus the live access of every room of the root's trees, so a just-shared
  // tree stops 404-ing at once.
  enum class VisibilityChange { changed, notFound, notYours, nobodysTree };
  std::variant<VisibilityChange, NotARoot> setVisibility(const TreeId& tree, const UserId& caller,
                                                         Visibility visibility);

private:
  // A subtree's title written as its owning step's label (SPEC.md, Model, Subtrees), as an ordinary label write of that
  // step under the parent's strand: read gate → owner check, on the parent, whose access is the subtree's → the step
  // stands → one RenameNode through the parent's room, durable before it answers the seq it took in the parent's
  // stream. A label that already is the title lands nothing and answers the parent's head, `unchanged`; a step gone from
  // its parent, or a parent whose row went away under its live room, answers notFound.
  std::variant<Described, Renaming> relabel(const OwningStep& owning, const UserId& caller, const std::string& title);

  TreeRepository& trees_;
  ProgressRepository& progress_;
  TokenGenerator& tokens_;
  Hlc genesis_;
  RoomRegistry& rooms_;
  NodeEdits& edits_;
  Clock& clock_;
};

}
