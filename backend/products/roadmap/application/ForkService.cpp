#include "products/roadmap/application/ForkService.h"

#include "products/roadmap/application/TreeRoom.h"
#include "products/roadmap/domain/Access.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"

#include <mutex>
#include <optional>
#include <utility>

namespace wm {

ForkService::ForkService(RoomRegistry& registry, TreeRepository& trees, TokenGenerator& tokens, Clock& clock)
    : registry_(registry), trees_(trees), tokens_(tokens), clock_(clock) {}

ForkService::Result ForkService::fork(const TreeId& source, const std::string& requestedId,
                                      const std::string& requestedTitle, const UserId& owner) {
  // Copy the source's *current* authoritative state (live edits folded in), not just its last snapshot.
  GraphState state;
  LegendState legend;
  std::string title;
  std::string guide;
  bool guideInherited = false;
  Hlc plantedAt;
  {
    std::lock_guard<std::mutex> lock(registry_.strandFor(source));
    // Gated on the stored access row BEFORE a room is built. An absent source and one the forker
    // can't read are indistinguishable: noSource → 404.
    const std::optional<TreeAccess> access = registry_.accessOf(source);
    if (!access || !canRead(std::optional<UserId>(owner), access->owner, access->visibility))
      return {Outcome::noSource, {}};
    TreeRoom* room = registry_.open(source);
    if (!room) return {Outcome::noSource, {}};
    // A stamp from the source's own clock dominates everything the source holds, so each step's
    // fresh addition outranks any removal its record carries. The fork's title and guide are planted
    // at it too, so a fresh subscriber's delta carries them as it carries the steps.
    plantedAt = room->nextStamp(clock_.nowMs());
    const bool ownsSource = canWrite(owner, access->owner);
    state = LooseGraph(room->exportState()).forkState(plantedAt, ownsSource ? ForkOpens::kept : ForkOpens::cleared);
    legend = room->exportLegend();
    title = room->title().value;
    guide = room->guide().value;
    // The copy is the forker's own words only when they wrote the source's: their own tree, whose
    // guide is not itself a copy. Anyone else's — an ownerless tree's included — is inherited.
    guideInherited = !guide.empty() && (!ownsSource || room->guideInherited());
  }

  const TreeId newId{requestedId.empty() ? "t_" + tokens_.mint().digest.substr(0, 16) : requestedId};
  const std::string forkTitle = requestedTitle.empty() ? title : requestedTitle;

  {
    std::lock_guard<std::mutex> lock(registry_.strandFor(newId));
    if (trees_.load(newId)) return {Outcome::conflict, {}};
    try {
      trees_.fork(newId, source, state, legend, Lww<std::string>{forkTitle, plantedAt}, Lww<std::string>{guide, plantedAt},
                  guideInherited, owner);
    } catch (const DuplicateTree&) {
      return {Outcome::conflict, {}};  // a soft-deleted row still holds the id, invisible to load
    }
  }

  TreeData data = LooseGraph(state).toTreeData(newId, forkTitle);
  data.guide = guide;
  data.kinds = Legend(legend).kinds();
  return {Outcome::forked, std::move(data)};
}

std::optional<ForkService::Description> ForkService::describe(const TreeId& source) {
  std::lock_guard<std::mutex> lock(registry_.strandFor(source));
  try {
    // The caller is unauthenticated: name a source only when it is readable by id, and take the
    // verdict off the stored row before materializing anything.
    const std::optional<TreeAccess> access = registry_.accessOf(source);
    if (!access || !canRead(std::nullopt, access->owner, access->visibility)) return std::nullopt;
    TreeRoom* room = registry_.open(source);
    if (!room) return std::nullopt;
    return Description{room->title().value, room->snapshot().nodes.size()};
  } catch (const std::exception&) {
    return std::nullopt;
  }
}

}
