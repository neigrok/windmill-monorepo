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

std::variant<SubtreeCreation, SubtreeRefusal> TreeRegistry::createSubtree(const TreeId& parent, const NodeId& step,
                                                                         const UserId& caller,
                                                                         const std::optional<TreeId>& proposedId) {
  const std::string door = currentWriteDoor();
  WriteObservation observation{"roadmap.subtree.create", "roadmap", door.empty() ? "internal" : door};
  const auto refuse = [&observation](SubtreeRefusal refusal) {
    observation.finish(codeOf(refusal));
    return refusal;
  };
  try {
    std::lock_guard<std::mutex> strand(rooms_.strandFor(parent));
    // Both gates read the stored access row before a room is materialized; absent and private-denied answer alike.
    const std::optional<TreeAccess> access = rooms_.accessOf(parent);
    if (!access || !canRead(caller, access->owner, access->visibility)) return refuse(SubtreeRefusal::noSuchTree);
    if (!canWrite(caller, access->owner)) return refuse(SubtreeRefusal::notWriter);
    TreeRoom* room = rooms_.open(parent);
    if (!room) return refuse(SubtreeRefusal::noSuchTree);
    if (!room->hasNode(step)) return refuse(SubtreeRefusal::stepGone);

    const std::map<NodeId, TreeId> pointers = room->pointers();
    const auto pointer = pointers.find(step);
    const std::optional<SubtreeSite> site = trees_.subtreeSite(
        parent, step, pointer == pointers.end() ? std::nullopt : std::optional<TreeId>(pointer->second), proposedId);
    if (!site) {
      rooms_.retire(parent);  // the row went away under its live room, so the room goes too
      return refuse(SubtreeRefusal::noSuchTree);
    }
    if (site->owned) {
      observation.finish("unchanged");
      return SubtreeCreation{false, *site->owned, room->head()};
    }
    if (site->depth >= kMaxTreeDepth) return refuse(SubtreeRefusal::depthLimit);
    if (site->opensATree) return refuse(SubtreeRefusal::stepOpensATree);

    const bool keepsProposed = proposedId && wellFormedTreeId(proposedId->str()) && !site->proposedTaken;
    const TreeId id = keepsProposed ? *proposedId : mintedTreeId(tokens_);
    const Seq seq = room->nextSeq();
    const std::optional<Subtree> created = trees_.createSubtree(id, OwningStep{parent, step}, seq);
    if (!created) {
      rooms_.retire(parent);
      return refuse(SubtreeRefusal::noSuchTree);
    }
    room->appendSubtree(step, *created);
    observation.finish();
    return SubtreeCreation{true, *created, seq};
  } catch (const std::exception& error) {
    observation.fail(error);
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
    // The row first, then the live room: retire announces the change and whoever listens re-decides
    // the access question against the repository.
    trees_.softDelete(tree);
    rooms_.retire(tree);
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
      // Held through the catch, so the room a failure is judged by stays the one the delete was applied to.
      std::lock_guard<std::mutex> strand(rooms_.strandFor(parent));
      TreeRoom* room = nullptr;
      std::optional<Seq> headBefore;  // the room's head as the delete began
      try {
        room = rooms_.open(parent);
        std::vector<NodeId> nodes;
        if (room && canWrite(caller, room->owner()))
          for (const auto& [node, opened] : room->pointers())
            if (opened == tree) nodes.push_back(node);
        // The tree, or its steps that opened the removed one, went away since the read: nothing is left to take.
        if (nodes.empty()) {
          editing.skip();
          continue;
        }
        headBefore = room->head();
        const std::variant<DeletedNodes, std::string> deleted =
            edits_.deleteNodes(*room, parent, nodes, DanglingEdges::removed, caller);
        // Nodes the room holds pass every check a deletion makes, so a refusal here is a fault.
        if (std::holds_alternative<std::string>(deleted)) throw std::logic_error("a room refused to delete nodes it holds");
        const DeletedNodes& landed = std::get<DeletedNodes>(deleted);
        if (!landed.saved) {
          editing.fail(TreeRowGone{}, "unsaved");
          cascade.unsaved.push_back(parent);
          continue;
        }
        steps += nodes.size();
        edges += landed.edges;
        marks += landed.marks;
        cascade.removed.emplace(parent, std::move(nodes));
        editing.finish();
      } catch (const std::exception& error) {
        // The room's head moves when its delete applies, so a failure after that is its save's: the steps are gone
        // from the room, unsaved. Before it, nothing was applied and the steps stay.
        const bool applied = headBefore && room->head() != *headBefore;
        editing.fail(error, applied ? "unsaved" : "failed");
        (applied ? cascade.unsaved : cascade.incomplete).push_back(parent);
      }
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

  // The strand serializes the rename against the tree's socket frames, so the owner check, the title
  // op and the persist form one uninterrupted step.
  std::lock_guard<std::mutex> strand(rooms_.strandFor(tree));
  std::optional<StoredTree> stored = trees_.load(tree);
  if (!stored) return Renaming::notFound;
  if (std::optional<WriteRefusal> refusal = writeRefusalFor(caller, stored->owner))
    return *refusal == WriteRefusal::nobodysTree ? Renaming::nobodysTree : Renaming::notYours;
  if (!rooms_.rename(tree, trimmed, clock_.nowMs(), stored->title.stamp)) return Renaming::notFound;
  return Renaming::renamed;
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

  // The strand serializes both against the tree's socket frames, so the gates, the one frame and the
  // persist form one uninterrupted step. Both gates read the stored access row before a room is
  // materialized.
  std::lock_guard<std::mutex> strand(rooms_.strandFor(tree));
  const std::optional<TreeAccess> access = rooms_.accessOf(tree);
  if (!access || !canRead(caller, access->owner, access->visibility)) return Renaming::notFound;
  if (std::optional<WriteRefusal> refusal = writeRefusalFor(caller, access->owner))
    return *refusal == WriteRefusal::nobodysTree ? Renaming::nobodysTree : Renaming::notYours;
  TreeRoom* room = rooms_.open(tree);
  if (!room) return Renaming::notFound;
  if (title && *title == room->title().value) title.reset();  // the name it already has is no rename
  if (!title && !guide) return Described{room->head(), true};
  const Seq seq = room->describe(title, guide, clock_.nowMs());
  if (rooms_.persist(tree)) return Described{seq, false};
  // The row went away under its live room: the room goes too, so no reader is served what it set.
  rooms_.retire(tree);
  return Renaming::notFound;
}

std::variant<Seq, TreeRegistry::GuideRefusal, Admission> TreeRegistry::setGuide(const TreeId& tree,
                                                                              const UserId& caller,
                                                                              const std::string& guide) {
  const auto described = describe(tree, caller, Description{std::nullopt, guide});
  if (const Described* landed = std::get_if<Described>(&described)) return landed->seq;
  if (const Admission* refusal = std::get_if<Admission>(&described)) return *refusal;
  const Renaming refusal = std::get<Renaming>(described);
  if (refusal == Renaming::notYours) return GuideRefusal::notYours;
  if (refusal == Renaming::nobodysTree) return GuideRefusal::nobodysTree;
  return GuideRefusal::notFound;
}

TreeRegistry::VisibilityChange TreeRegistry::setVisibility(const TreeId& tree, const UserId& caller,
                                                           Visibility visibility) {
  // The strand serializes the reshare against the tree's socket frames.
  std::lock_guard<std::mutex> strand(rooms_.strandFor(tree));
  std::optional<StoredTree> stored = trees_.load(tree);
  if (!stored) return VisibilityChange::notFound;
  if (std::optional<WriteRefusal> refusal = writeRefusalFor(caller, stored->owner))
    return *refusal == WriteRefusal::nobodysTree ? VisibilityChange::nobodysTree : VisibilityChange::notYours;
  rooms_.setVisibility(tree, visibility);
  return VisibilityChange::changed;
}

}
