#include "products/roadmap/application/TreeRegistry.h"

#include "platform/application/StatementLimits.h"
#include "platform/application/WriteObservation.h"
#include "products/roadmap/application/TreeRoom.h"
#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/GraphState.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/Access.h"

#include <trantor/utils/Logger.h>

#include <map>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <utility>

namespace wm {

namespace {

// How many times a subtree's create looks at its parent's room for one that is settled before it is refused.
constexpr int kSettlingLooks = 3;

// Server-minted, unguessable, URL-safe.
TreeId mintedTreeId(TokenGenerator& tokens) {
  return TreeId{"t_" + tokens.mint().digest.substr(0, 16)};
}

}

TreeRegistry::TreeRegistry(TreeRepository& trees, ProgressRepository& progress, TokenGenerator& tokens,
                           Hlc genesis, RoomRegistry& rooms, NodeEdits& edits, Clock& clock)
    : trees_(trees), progress_(progress), tokens_(tokens), genesis_(std::move(genesis)),
      rooms_(rooms), edits_(edits), clock_(clock) {}

TreeId TreeRegistry::create(const UserId& owner, const TreeData& initial) {
  TreeId id = mintedTreeId(tokens_);
  if (create(owner, id, initial) != Creation::created) throw DuplicateTree{};  // a fresh mint colliding means the RNG is broken
  return id;
}

TreeRegistry::Creation TreeRegistry::create(const UserId& owner, const TreeId& id, const TreeData& initial) {
  std::lock_guard<std::mutex> strand(rooms_.strandFor(id));
  std::optional<StoredTree> stored = trees_.load(id);
  if (stored) {
    if (stored->owner && *stored->owner == owner) return Creation::existedYours;  // idempotent resume — the row stays untouched
    return Creation::taken;
  }

  // The starting steps are added to this tree now. The legend stays at genesis, byte-equal to the
  // one a device-born tree seeds, so a claim converges.
  const Hlc plantedAt{clock_.nowMs(), 0, std::string{TreeRoom::kServerActor}};
  GraphState state = LooseGraph(initial, plantedAt).exportState();
  // A posted legend, or the three defaults when none is posted.
  LegendState legend = Legend(Legend::bornWith(initial.kinds), genesis_).exportState();
  try {
    trees_.create(id, state, legend, initial.title, owner);
  } catch (const DuplicateTree&) {
    // Lost a cross-process insert race, or the id names a soft-deleted tree whose row outlives the
    // delete, invisible to load. Reload to classify: only a live row the caller owns reads as a resume,
    // and a retired row of the caller's own reads as `retired` rather than as a stranger's id.
    std::optional<StoredTree> raced = trees_.load(id);
    if (raced && raced->owner && *raced->owner == owner) return Creation::existedYours;
    if (trees_.retiredOwner(id) == std::optional<UserId>(owner)) return Creation::retired;
    return Creation::taken;
  }
  return Creation::created;
}

std::variant<SubtreeCreation, SubtreeRefusal, Admission> TreeRegistry::createSubtree(const TreeId& parent,
                                                                                    const NodeId& step,
                                                                                    const UserId& caller,
                                                                                    const SubtreeRequest& request) {
  const std::string door = currentWriteDoor();
  WriteObservation observation{"roadmap.subtree.create", "roadmap", door.empty() ? "internal" : door};
  const auto refuse = [&observation](SubtreeRefusal refusal) {
    observation.finish(codeOf(refusal));
    return refusal;
  };
  if (request.kinds)
    if (std::optional<Admission> refusal = admitBornKinds(*request.kinds)) {
      observation.finish("kinds-refused");
      return *refusal;
    }
  // The default legend is the one a new tree is born with; a client that wants its parent's sends it.
  const LegendState legend =
      Legend(Legend::bornWith(request.kinds.value_or(std::vector<Kind>{})), genesis_).exportState();

  bool committed = false;
  try {
    TreeRoom* room = nullptr;
    // Both gates read the root's access before a room is materialized; absent and private-denied answer alike.
    const auto gateRefusal = [&]() -> std::optional<SubtreeRefusal> {
      const std::optional<TreeAccess> access = rooms_.accessOf(parent);
      if (!access || !canRead(caller, access->owner, access->visibility)) return SubtreeRefusal::noSuchTree;
      if (!canWrite(caller, access->owner)) return SubtreeRefusal::notWriter;
      room = rooms_.open(parent);
      if (!room) return SubtreeRefusal::noSuchTree;
      if (!room->hasNode(step)) return SubtreeRefusal::stepGone;
      return std::nullopt;
    };
    // The create stores the parent's head at the room's next seq, in its own transaction, so it runs only over a room
    // that is settled: every write the room holds is stored and no save of it is running. Seqs the store does not
    // hold would otherwise fall behind the stored head, where a restart leaves no gap to show them lost, and a save
    // still running would write an older head over the create's. A room held unsaved refuses the create, which waits
    // for the save the registry is retrying. One whose write is being saved is waited for with the strand let go and
    // judged again from the gates, a few times at most, since each wait lets another write in.
    std::unique_lock<std::mutex> strand(rooms_.strandFor(parent));
    for (int look = 1;; ++look) {
      if (const std::optional<SubtreeRefusal> refusal = gateRefusal()) return refuse(*refusal);
      if (rooms_.settled(parent)) break;
      if (look == kSettlingLooks || rooms_.standing(parent) == Saved::held) return refuse(SubtreeRefusal::savePending);
      strand.unlock();
      if (rooms_.settle(parent) == Saved::held) return refuse(SubtreeRefusal::savePending);
      strand.lock();
    }

    const std::map<NodeId, TreeId> pointers = room->pointers();
    const auto pointer = pointers.find(step);
    const std::optional<TreeId> opened =
        pointer == pointers.end() ? std::nullopt : std::optional<TreeId>(pointer->second);
    // Another writer may fill the step, or take the id, between the site and the store: the second attempt then reads
    // the step's subtree again, or mints the id. A conflict on it too is a fault.
    std::optional<TreeId> proposed = request.proposedId;
    for (int attempt = 1; attempt <= 2; ++attempt) {
      const std::optional<SubtreeSite> site = trees_.subtreeSite(parent, step, opened, proposed);
      if (!site) {
        rooms_.retire(parent);  // the row went away under its live room, so the room goes too
        return refuse(SubtreeRefusal::noSuchTree);
      }
      // A create whose commit's answer was lost stored a head, and a subtree, this room may not hold.
      room->catchUp(site->head);
      if (site->owned) {
        room->ownSubtree(step, site->owned->id);
        observation.finish("unchanged");
        return SubtreeCreation{false, *site->owned, room->head()};
      }
      if (site->depth >= kMaxTreeDepth) return refuse(SubtreeRefusal::depthLimit);
      if (site->opensATree) return refuse(SubtreeRefusal::stepOpensATree);

      const bool keepsProposed = proposed && wellFormedTreeId(proposed->str()) && !site->proposedTaken;
      const TreeId id = keepsProposed ? *proposed : mintedTreeId(tokens_);
      const Seq seq = room->nextSeq();
      const std::variant<Subtree, SubtreeConflict> stored =
          trees_.createSubtree(id, OwningStep{parent, step}, legend, seq);
      if (const Subtree* created = std::get_if<Subtree>(&stored)) {
        committed = true;
        room->appendSubtree(step, *created);
        observation.finish();
        return SubtreeCreation{true, *created, seq};
      }
      const SubtreeConflict conflict = std::get<SubtreeConflict>(stored);
      if (conflict == SubtreeConflict::parentGone) {
        rooms_.retire(parent);
        return refuse(SubtreeRefusal::noSuchTree);
      }
      if (conflict == SubtreeConflict::idTaken) proposed.reset();
    }
    throw DuplicateTree{};
  } catch (const std::exception& error) {
    // After the commit the child and its seq are stored, and the parent's subscribers were not told.
    observation.fail(error, committed ? "unannounced" : "failed");
    throw;
  }
}

std::vector<TreeSummary> TreeRegistry::list(const UserId& owner) {
  std::vector<OwnedTree> owned = trees_.listOwnedBy(owner);
  std::map<TreeId, ProgressDigest> overlays = progress_.overlaysFor(owner);

  std::vector<LoadedTree> loaded;
  loaded.reserve(owned.size());
  for (OwnedTree& tree : owned) {
    LoadedTree row;
    row.createdAt = tree.createdAt;
    row.updatedAt = tree.updatedAt;
    row.data = std::move(tree.data);
    row.parent = std::move(tree.parent);
    auto digest = overlays.find(row.data.id);
    if (digest != overlays.end()) {
      row.progress = std::move(digest->second.overlay);
      row.lastMarkedAt = digest->second.lastMarkedAt;
    }
    loaded.push_back(std::move(row));
  }
  return registrySummaries(loaded);
}

std::map<TreeId, std::string> TreeRegistry::titlesOwnedBy(const UserId& owner, const std::set<TreeId>& trees) {
  return trees_.titlesOwnedBy(owner, trees);
}

std::map<TreeId, OpenedTree> TreeRegistry::openedFrom(const UserId& owner, const std::set<TreeId>& opened,
                                                      std::optional<std::chrono::milliseconds> budget) {
  return trees_.openedFrom(owner, opened, budget);
}

std::map<TreeId, TreeAbove> TreeRegistry::guidedTreesAbove(const UserId& owner, const TreeId& tree) {
  return trees_.guidedTreesAbove(owner, tree);
}

std::optional<Place> TreeRegistry::placeOf(const TreeId& tree) { return trees_.placeOf(tree); }

std::variant<Cascade, TreeRegistry::RemovalRefusal> TreeRegistry::remove(const TreeId& tree, const UserId& caller) {
  // The steps that open the tree are read first, with no strand held: a removal that cannot read them removes nothing,
  // so the person can try again. Its lines are written at the removal's door, and its first failure is the request's
  // one Issue.
  constexpr const char* kCascade = "roadmap.tree.remove.cascade";
  const std::string door = currentWriteDoor();
  const std::uint64_t startedMs = clock_.nowMs();
  const std::uint64_t deadlineMs = startedMs + static_cast<std::uint64_t>(kCascadeTime.count());
  std::vector<TreeId> opening;
  {
    WriteObservation reading{kCascade, "roadmap", door};
    try {
      const StatementLimits limits{kCascadeLockWait, clock_, deadlineMs};
      opening = trees_.treesOpening(caller, tree);
    } catch (const std::exception& error) {
      reading.fail(error);
      return RemovalRefusal::cascadeUnavailable;
    }
    reading.skip();
  }

  {
    // The strand serializes the retirement against the tree's socket frames, so no concurrent open()
    // can reload the tree between the delete and the drop.
    std::lock_guard<std::mutex> strand(rooms_.strandFor(tree));
    std::optional<StoredTree> stored = trees_.load(tree);
    if (!stored) return RemovalRefusal::notFound;
    // A tree the caller cannot even read is answered as absent, never as "someone else's": the
    // second sentence would tell a stranger which private ids are real.
    if (!canRead(caller, stored->owner, stored->visibility)) return RemovalRefusal::notFound;
    if (std::optional<WriteRefusal> refusal = writeRefusalFor(caller, stored->owner))
      return *refusal == WriteRefusal::nobodysTree ? RemovalRefusal::nobodysTree : RemovalRefusal::notYours;
    // The row and the live room together: the room's retirement announces the change, and whoever listens re-decides
    // the access question against the repository.
    rooms_.remove(tree);
  }
  if (opening.empty()) return Cascade{};

  // The tree is gone whatever becomes of the steps that open it.
  Cascade cascade;
  std::size_t steps = 0;
  std::size_t edges = 0;
  std::size_t marks = 0;
  {
    const StatementLimits limits{kCascadeLockWait, clock_, deadlineMs};
    for (const TreeId& parent : opening) {
      if (clock_.nowMs() >= deadlineMs) {
        cascade.incomplete.push_back(parent);
        continue;
      }
      WriteObservation editing{kCascade, "roadmap", door};
      std::vector<NodeId> nodes;
      std::optional<DeletedNodes> landed;
      {
        // Held through the catch, so the room a failure is judged by stays the one the delete was applied to.
        std::lock_guard<std::mutex> strand(rooms_.strandFor(parent));
        TreeRoom* room = nullptr;
        std::optional<Seq> headBefore;  // the room's head as the delete began
        try {
          room = rooms_.open(parent);
          if (room && canWrite(caller, room->owner()))
            for (const auto& [node, opened] : room->pointers())
              if (opened == tree) nodes.push_back(node);
          // The tree, or its steps that opened the removed one, went away since the read: nothing is left to take.
          if (nodes.empty()) {
            editing.skip();
            continue;
          }
          headBefore = room->head();
          std::variant<DeletedNodes, std::string> deleted =
              edits_.deleteNodes(*room, parent, nodes, DanglingEdges::removed, caller);
          // Nodes the room holds pass every check a deletion makes, so a refusal here is a fault.
          if (std::holds_alternative<std::string>(deleted)) throw std::logic_error("a room refused to delete nodes it holds");
          landed = std::get<DeletedNodes>(std::move(deleted));
        } catch (const std::exception& error) {
          // The room's head moves when its delete applies, so a failure after that leaves the steps gone from the
          // room, unsaved. Before it, nothing was applied and the steps stay.
          const bool applied = headBefore && room->head() != *headBefore;
          editing.fail(error, applied ? "unsaved" : "failed");
          (applied ? cascade.unsaved : cascade.incomplete).push_back(parent);
          continue;
        }
      }
      // The delete is in the room and on every open page; its save is waited for with the parent's strand let go.
      const Saved saved = landed->save.wait();
      if (saved == Saved::gone) {
        editing.fail(TreeRowGone{}, "unsaved");
        cascade.unsaved.push_back(parent);
        continue;
      }
      // The steps are gone from the room and every open page; the registry holds the delete and retries its save.
      if (saved == Saved::held) {
        editing.finish(kHeldUnsaved);
        cascade.unsaved.push_back(parent);
        continue;
      }
      steps += nodes.size();
      edges += landed->edges;
      marks += landed->marks;
      cascade.removed.emplace(parent, std::move(nodes));
      editing.finish();
    }
  }
  LOG_INFO << "roadmap_tree_remove_cascade door=" << door << " trees=" << opening.size() << " steps=" << steps
           << " edges=" << edges << " marks=" << marks << " removed=" << cascade.removed.size()
           << " unsaved=" << cascade.unsaved.size() << " incomplete=" << cascade.incomplete.size()
           << " duration_ms=" << clock_.nowMs() - startedMs << " request_id=" << currentWriteRequestId();
  return cascade;
}

const char* TreeRegistry::sentenceOf(Renaming refusal) {
  switch (refusal) {
    case Renaming::blankTitle: return "a tree always has a name";
    case Renaming::malformedTitle: return "the title is not valid UTF-8";
    case Renaming::nulInTitle: return "the title contains a NUL character";
    default: return "no such tree";
  }
}

std::variant<std::string, TreeRegistry::Renaming> TreeRegistry::titleFrom(const std::string& title) {
  const std::size_t start = title.find_first_not_of(" \t\r\n");
  if (start == std::string::npos) return Renaming::blankTitle;
  std::string trimmed = title.substr(start, title.find_last_not_of(" \t\r\n") - start + 1);
  // The two things a row cannot hold: a Postgres text value ends at a NUL.
  if (!isValidUtf8(trimmed)) return Renaming::malformedTitle;
  if (trimmed.find('\0') != std::string::npos) return Renaming::nulInTitle;

  // A name, not a payload. Truncate — never reject — to kMaxTitleChars (domain/Command.h), on the
  // code-point reading every cap shares, so the cut can never split a sequence.
  const std::size_t cut = byteOffsetOfCodePoint(trimmed, kMaxTitleChars);
  if (cut != std::string::npos) trimmed.resize(cut);
  return trimmed;
}

TreeRegistry::Renaming TreeRegistry::rename(const TreeId& tree, const UserId& caller,
                                            const std::string& title) {
  std::variant<std::string, Renaming> landed = titleFrom(title);
  if (const Renaming* refusal = std::get_if<Renaming>(&landed)) return *refusal;
  const std::string& trimmed = std::get<std::string>(landed);

  // Where a tree hangs never changes, so it is read before a strand is taken.
  if (const std::optional<TreeAccess> hanging = rooms_.accessOf(tree); hanging && hanging->parent) {
    const std::variant<Described, Renaming> relabelled = relabel(*hanging->parent, caller, trimmed);
    if (const Renaming* refusal = std::get_if<Renaming>(&relabelled)) return *refusal;
    return std::get<Described>(relabelled).saved == Saved::held ? Renaming::renamedUnsaved : Renaming::renamed;
  }

  // The strand serializes the rename against the tree's socket frames, so the gates and the title op form one
  // uninterrupted step; the save is waited for with the strand let go. A tree the caller may not read answers as an
  // absent one, never as someone else's.
  std::unique_lock<std::mutex> strand(rooms_.strandFor(tree));
  std::optional<StoredTree> stored = trees_.load(tree);
  if (!stored || !canRead(caller, stored->owner, stored->visibility)) return Renaming::notFound;
  if (std::optional<WriteRefusal> refusal = writeRefusalFor(caller, stored->owner))
    return *refusal == WriteRefusal::nobodysTree ? Renaming::nobodysTree : Renaming::notYours;
  PendingSave saving = rooms_.rename(tree, trimmed, clock_.nowMs(), stored->title.stamp);
  strand.unlock();
  const Saved saved = saving.wait();
  if (saved == Saved::gone) return Renaming::notFound;  // the row went away under its live room, which went with it
  return saved == Saved::held ? Renaming::renamedUnsaved : Renaming::renamed;
}

std::variant<TreeRegistry::Described, TreeRegistry::Renaming, Admission> TreeRegistry::describe(
    const TreeId& tree, const UserId& caller, const Description& sent) {
  // Both halves are judged whole before either lands, so a call that sets both lands both or neither.
  std::optional<std::string> title;
  if (sent.title) {
    std::variant<std::string, Renaming> landed = titleFrom(*sent.title);
    if (const Renaming* refusal = std::get_if<Renaming>(&landed)) return *refusal;
    title = std::get<std::string>(std::move(landed));
  }
  std::optional<std::string> guide;
  if (sent.guide) {
    if (std::optional<Admission> refusal = admitGuide(*sent.guide)) return *refusal;
    guide = isBlankGuide(*sent.guide) ? std::string() : *sent.guide;
  }

  // Where a tree hangs never changes, so it is read before a strand is taken: a subtree's title is its owning step's
  // label, and lands in its parent before its guide lands here. The call's save is held when either room's is.
  bool relabelled = false;
  Saved labelSaved = Saved::saved;
  if (const std::optional<TreeAccess> hanging = title ? rooms_.accessOf(tree) : std::nullopt; hanging && hanging->parent) {
    const std::variant<Described, Renaming> landed = relabel(*hanging->parent, caller, *title);
    if (const Renaming* refusal = std::get_if<Renaming>(&landed)) return *refusal;
    relabelled = !std::get<Described>(landed).unchanged;
    labelSaved = std::get<Described>(landed).saved;
    title.reset();
  }
  const auto heldWithTheLabel = [labelSaved](Saved saved) { return labelSaved == Saved::held ? Saved::held : saved; };

  // The strand serializes both against the tree's socket frames, so the gates and the one frame form one
  // uninterrupted step; the save is waited for with the strand let go. Both gates read the stored access row before
  // a room is materialized.
  std::unique_lock<std::mutex> strand(rooms_.strandFor(tree));
  const std::optional<TreeAccess> access = rooms_.accessOf(tree);
  if (!access || !canRead(caller, access->owner, access->visibility)) return Renaming::notFound;
  if (std::optional<WriteRefusal> refusal = writeRefusalFor(caller, access->owner))
    return *refusal == WriteRefusal::nobodysTree ? Renaming::nobodysTree : Renaming::notYours;
  TreeRoom* room = rooms_.open(tree);
  if (!room) return Renaming::notFound;
  if (title && *title == room->title().value) title.reset();  // the name it already has is no rename
  if (!title && !guide) return Described{room->head(), !relabelled, heldWithTheLabel(rooms_.standing(tree))};
  const Seq seq = room->describe(title, guide, clock_.nowMs());
  PendingSave saving = rooms_.persist(tree);
  strand.unlock();
  const Saved saved = saving.wait();
  // The row went away under its live room: the room went too, so no reader is served what it set.
  if (saved == Saved::gone) return Renaming::notFound;
  return Described{seq, false, heldWithTheLabel(saved)};
}

std::variant<TreeRegistry::Described, TreeRegistry::Renaming> TreeRegistry::relabel(const OwningStep& owning,
                                                                                  const UserId& caller,
                                                                                  const std::string& title) {
  // A title is held to the cap a label is, so a name that lands as a title lands as a label too.
  static_assert(kMaxTitleChars <= kMaxNodeLabelLength);
  std::unique_lock<std::mutex> strand(rooms_.strandFor(owning.tree));
  const std::optional<TreeAccess> access = rooms_.accessOf(owning.tree);
  if (!access || !canRead(caller, access->owner, access->visibility)) return Renaming::notFound;
  if (std::optional<WriteRefusal> refusal = writeRefusalFor(caller, access->owner))
    return *refusal == WriteRefusal::nobodysTree ? Renaming::nobodysTree : Renaming::notYours;
  TreeRoom* room = rooms_.open(owning.tree);
  if (!room) return Renaming::notFound;
  const std::optional<std::string> label = room->labelOf(owning.step);
  if (!label) return Renaming::notFound;
  if (*label == title) return Described{room->head(), true, rooms_.standing(owning.tree)};
  const Seq seq = room->applyCommand(RenameNode{owning.step, title}, clock_.nowMs(), caller);
  PendingSave saving = rooms_.persist(owning.tree);
  strand.unlock();
  const Saved saved = saving.wait();
  if (saved == Saved::gone) return Renaming::notFound;
  return Described{seq, false, saved};
}

std::variant<TreeRegistry::Described, TreeRegistry::GuideRefusal, Admission> TreeRegistry::setGuide(
    const TreeId& tree, const UserId& caller, const std::string& guide) {
  const auto described = describe(tree, caller, Description{std::nullopt, guide});
  if (const Described* landed = std::get_if<Described>(&described)) return *landed;
  if (const Admission* refusal = std::get_if<Admission>(&described)) return *refusal;
  const Renaming refusal = std::get<Renaming>(described);
  if (refusal == Renaming::notYours) return GuideRefusal::notYours;
  if (refusal == Renaming::nobodysTree) return GuideRefusal::nobodysTree;
  return GuideRefusal::notFound;
}

std::variant<TreeRegistry::VisibilityChange, NotARoot> TreeRegistry::setVisibility(const TreeId& tree,
                                                                                    const UserId& caller,
                                                                                    Visibility visibility) {
  // The strand serializes the reshare against the tree's socket frames. A tree the caller may not read answers as an
  // absent one, never as someone else's.
  std::lock_guard<std::mutex> strand(rooms_.strandFor(tree));
  std::optional<StoredTree> stored = trees_.load(tree);
  if (!stored || !canRead(caller, stored->owner, stored->visibility)) return VisibilityChange::notFound;
  if (std::optional<WriteRefusal> refusal = writeRefusalFor(caller, stored->owner))
    return *refusal == WriteRefusal::nobodysTree ? VisibilityChange::nobodysTree : VisibilityChange::notYours;
  if (stored->parent) return NotARoot{*stored->parent, stored->root};
  rooms_.setVisibility(tree, visibility);
  return VisibilityChange::changed;
}

}
