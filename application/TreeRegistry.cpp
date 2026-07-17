#include "application/TreeRegistry.h"

#include "domain/GraphState.h"
#include "domain/Legend.h"
#include "domain/LooseGraph.h"

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

  GraphState state = LooseGraph(initial, genesis_).exportState();  // seed the starting nodes/edges
  // Honour a posted legend; otherwise a blank tree is born with the three defaults (F6).
  LegendState legend = initial.kinds.empty() ? Legend::seededDefaults(genesis_).exportState()
                                             : Legend(initial.kinds, genesis_).exportState();
  try {
    trees_.create(id, state, legend, initial.title, owner);
  } catch (const DuplicateTree&) {
    // Lost a cross-process insert race (the standalone MCP binary shares this DB), or the id
    // names a soft-deleted tree — its row outlives the delete, invisible to load. Reload to
    // classify: only a live row the caller owns reads as a resume.
    std::optional<StoredTree> raced = trees_.load(id);
    if (raced && raced->owner && *raced->owner == owner) return Creation::existedYours;
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

TreeRegistry::Removal TreeRegistry::remove(const TreeId& tree, const UserId& caller) {
  std::optional<StoredTree> stored = trees_.load(tree);
  if (!stored) return Removal::notFound;
  if (!stored->owner || *stored->owner != caller) return Removal::notOwner;
  trees_.softDelete(tree);
  return Removal::deleted;
}

TreeRegistry::Renaming TreeRegistry::rename(const TreeId& tree, const UserId& caller,
                                            const std::string& title) {
  const std::size_t start = title.find_first_not_of(" \t\r\n");
  if (start == std::string::npos) return Renaming::blankTitle;
  std::string trimmed = title.substr(start, title.find_last_not_of(" \t\r\n") - start + 1);

  // A name, not a payload: an 8MB body would otherwise ride every broadcast, save, and
  // listing. Truncate — never reject — to 200 characters, counted as UTF-8 codepoints so
  // the cut can never split a sequence.
  constexpr std::size_t kMaxTitleChars = 200;
  std::size_t seen = 0;
  for (std::size_t i = 0; i < trimmed.size(); ++i) {
    if ((static_cast<unsigned char>(trimmed[i]) & 0xC0) == 0x80) continue;  // continuation byte
    if (seen == kMaxTitleChars) {
      trimmed.resize(i);
      break;
    }
    ++seen;
  }

  // The strand serializes the rename against the tree's socket frames, so the owner check,
  // the room's title op, and its persist form one uninterrupted step.
  std::lock_guard<std::mutex> strand(rooms_.strandFor(tree));
  std::optional<StoredTree> stored = trees_.load(tree);
  if (!stored) return Renaming::notFound;
  if (!stored->owner || *stored->owner != caller) return Renaming::notOwner;
  rooms_.rename(tree, trimmed, clock_.nowMs(), stored->title.stamp);
  return Renaming::renamed;
}

}
