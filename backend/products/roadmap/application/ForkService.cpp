#include "products/roadmap/application/ForkService.h"

#include "platform/application/WriteObservation.h"
#include "products/roadmap/application/TreeRoom.h"
#include "products/roadmap/domain/Access.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"

#include <trantor/utils/Logger.h>

#include <deque>
#include <mutex>
#include <optional>
#include <utility>

namespace wm {

ForkService::ForkService(RoomRegistry& registry, TreeRepository& trees, TokenGenerator& tokens, Clock& clock)
    : registry_(registry), trees_(trees), tokens_(tokens), clock_(clock) {}

ForkService::Result ForkService::fork(const TreeId& source, const std::string& requestedId,
                                      const std::string& requestedTitle, const UserId& owner) {
  const std::uint64_t startedMs = clock_.nowMs();
  const auto mint = [this] { return TreeId{"t_" + tokens_.mint().digest.substr(0, 16)}; };
  TreeId newId{requestedId};  // minted once the source is admitted, when none is asked for

  // The root first, then each subtree its present steps own, a level at a time: every tree read as its room holds it
  // (live edits folded in), each under its own strand alone, its copy hung from the copy of the tree it hangs from.
  struct Pending {
    TreeId source;
    TreeId copy;
    std::optional<OwningStep> parent;
  };
  std::deque<Pending> pending{Pending{source, newId, std::nullopt}};
  std::vector<TreeCopy> copies;
  bool ownsSource = false;
  while (!pending.empty()) {
    Pending next = pending.front();
    pending.pop_front();
    std::lock_guard<std::mutex> lock(registry_.strandFor(next.source));
    if (!next.parent) {
      // Gated on the stored access row BEFORE a room is built. An absent source, a hidden one and one the forker
      // can't read are indistinguishable: noSource → 404. Every tree under it is read by this access.
      const std::optional<TreeAccess> access = registry_.accessOf(next.source);
      if (!access || !canRead(std::optional<UserId>(owner), access->owner, access->visibility))
        return {Outcome::noSource, {}, std::nullopt};
      // A subtree is copied with its root's branch, never alone.
      if (const std::optional<OwningStep> parent = access->parent())
        return {Outcome::notARoot, {}, NotARoot{*parent, access->root}};
      ownsSource = canWrite(owner, access->owner);
      if (newId.empty()) newId = mint();
      next.copy = newId;
    }
    TreeRoom* room = registry_.open(next.source);
    if (!room) return {Outcome::noSource, {}, std::nullopt};  // the root went away during the walk: nothing is written
    // A stamp from the tree's own clock dominates everything it holds, so each step's fresh addition outranks any
    // removal its record carries. The copy's title and guide are planted at it too, so a fresh subscriber's delta
    // carries them as it carries the steps.
    const Hlc plantedAt = room->nextStamp(clock_.nowMs());
    const std::string guide = room->guide().value;
    // The copy is the forker's own words only when they wrote the source's: their own tree, whose guide is not itself
    // a copy. Anyone else's — an ownerless tree's included — is inherited.
    const bool guideInherited = !guide.empty() && (!ownsSource || room->guideInherited());
    // A subtree's name is its copied step's label: its own title register, which nothing reads, is not copied.
    Lww<std::string> title;
    if (!next.parent) title = {requestedTitle.empty() ? room->title().value : requestedTitle, plantedAt};
    copies.push_back(TreeCopy{next.copy, next.source, next.parent,
                              LooseGraph(room->exportState())
                                  .forkState(plantedAt, ownsSource ? ForkOpens::kept : ForkOpens::cleared),
                              room->exportLegend(), title, Lww<std::string>{guide, plantedAt}, guideInherited});
    for (const auto& [step, subtree] : room->subtrees())
      pending.push_back(Pending{subtree, mint(), OwningStep{next.copy, step}});
  }

  {
    std::lock_guard<std::mutex> lock(registry_.strandFor(newId));
    if (trees_.load(newId)) return {Outcome::conflict, {}, std::nullopt};
    try {
      trees_.fork(copies, owner);
    } catch (const DuplicateTree&) {
      return {Outcome::conflict, {}, std::nullopt};  // a soft-deleted row still holds the id, invisible to load
    }
  }
  LOG_INFO << "roadmap_tree_fork trees=" << copies.size() << " duration_ms=" << clock_.nowMs() - startedMs
           << " request_id=" << currentWriteRequestId();

  const TreeCopy& root = copies.front();
  TreeData data = LooseGraph(root.state).toTreeData(newId, root.title.value);
  data.guide = root.guide.value;
  data.kinds = Legend(root.legend).kinds();
  return {Outcome::forked, std::move(data), std::nullopt};
}

std::optional<ForkService::Description> ForkService::describe(const TreeId& source) {
  std::lock_guard<std::mutex> lock(registry_.strandFor(source));
  try {
    // The caller is unauthenticated: name a source only when it is readable by id, and take the
    // verdict off the stored row before materializing anything. A subtree is never forked alone.
    const std::optional<TreeAccess> access = registry_.accessOf(source);
    if (!access || access->parent() || !canRead(std::nullopt, access->owner, access->visibility)) return std::nullopt;
    TreeRoom* room = registry_.open(source);
    if (!room) return std::nullopt;
    return Description{room->title().value, room->snapshot().nodes.size()};
  } catch (const std::exception&) {
    return std::nullopt;
  }
}

}
