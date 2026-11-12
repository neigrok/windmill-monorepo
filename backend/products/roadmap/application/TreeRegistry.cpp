#include "products/roadmap/application/TreeRegistry.h"

#include "products/roadmap/application/TreeRoom.h"
#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/GraphState.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/Access.h"

#include <map>
#include <mutex>
#include <optional>
#include <utility>

namespace wm {

TreeRegistry::TreeRegistry(TreeRepository& trees, ProgressRepository& progress, TokenGenerator& tokens,
                           Hlc genesis, RoomRegistry& rooms, Clock& clock)
    : trees_(trees), progress_(progress), tokens_(tokens), genesis_(std::move(genesis)),
      rooms_(rooms), clock_(clock) {}

TreeId TreeRegistry::create(const UserId& owner, const TreeData& initial) {
  TreeId id{"t_" + tokens_.mint().digest.substr(0, 16)};  // server-minted, unguessable, URL-safe
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

TreeRegistry::Removal TreeRegistry::remove(const TreeId& tree, const UserId& caller) {
  // The strand serializes the retirement against the tree's socket frames, so no concurrent open()
  // can reload the tree between the delete and the drop.
  std::lock_guard<std::mutex> strand(rooms_.strandFor(tree));
  std::optional<StoredTree> stored = trees_.load(tree);
  if (!stored) return Removal::notFound;
  // A tree the caller cannot even read is answered as absent, never as "someone else's": the
  // second sentence would tell a stranger which private ids are real.
  if (!canRead(caller, stored->owner, stored->visibility)) return Removal::notFound;
  if (std::optional<WriteRefusal> refusal = writeRefusalFor(caller, stored->owner))
    return *refusal == WriteRefusal::nobodysTree ? Removal::nobodysTree : Removal::notYours;
  // The row first, then the live room: retire announces the change and whoever listens re-decides
  // the access question against the repository.
  trees_.softDelete(tree);
  rooms_.retire(tree);
  return Removal::deleted;
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
