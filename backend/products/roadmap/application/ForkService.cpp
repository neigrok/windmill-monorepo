#include "products/roadmap/application/ForkService.h"

#include "products/roadmap/application/TreeRoom.h"
#include "platform/domain/Access.h"

#include <mutex>
#include <optional>
#include <utility>

namespace wm {

ForkService::ForkService(RoomRegistry& registry, TreeRepository& trees, TokenGenerator& tokens)
    : registry_(registry), trees_(trees), tokens_(tokens) {}

ForkService::Result ForkService::fork(const TreeId& source, const std::string& requestedId,
                                      const std::string& requestedTitle, const UserId& owner) {
  // Copy the source's *current* authoritative state (live edits folded in), not just its
  // last snapshot — so the fork is a faithful duplicate the instant it is taken.
  TreeData data;
  GraphState state;
  LegendState legend;
  std::string title;
  {
    std::lock_guard<std::mutex> lock(registry_.strandFor(source));
    try {
      TreeRoom* room = registry_.open(source);
      // Forking copies the whole document — a read. An absent source (null) and one the forker
      // can't read are indistinguishable: noSource → 404, no existence leak. Only an infrastructure
      // failure falls to the catch, also answered noSource — masked, never surfaced.
      if (!room || !canRead(std::optional<UserId>(owner), room->owner(), room->visibility()))
        return {Outcome::noSource, {}};
      data = room->snapshot();
      state = room->exportState();
      legend = room->exportLegend();
      title = room->title().value;
    } catch (const std::exception&) {
      return {Outcome::noSource, {}};
    }
  }

  // A fork starts unlit: authoring status seeds (the checkmarks a share visitor saw on
  // first paint) don't travel — progress is the forker's own to earn.
  for (NodeStateEntry& node : state.nodes) {
    node.status = std::nullopt;
    node.statusAt = Hlc{};
  }
  for (NodeSpec& node : data.nodes) node.status = std::nullopt;

  const TreeId newId{requestedId.empty() ? "t_" + tokens_.mint().digest.substr(0, 16) : requestedId};
  const std::string forkTitle = requestedTitle.empty() ? title : requestedTitle;

  {
    std::lock_guard<std::mutex> lock(registry_.strandFor(newId));
    if (trees_.load(newId)) return {Outcome::conflict, {}};
    try {
      trees_.fork(newId, source, state, legend, forkTitle, owner);
    } catch (const DuplicateTree&) {
      return {Outcome::conflict, {}};  // a soft-deleted row still holds the id, invisible to load
    }
  }

  data.id = newId;
  data.title = forkTitle;
  return {Outcome::forked, std::move(data)};
}

std::optional<ForkService::Description> ForkService::describe(const TreeId& source) {
  std::lock_guard<std::mutex> lock(registry_.strandFor(source));
  try {
    TreeRoom* room = registry_.open(source);
    // The one caller (the magic-link fork invite) is unauthenticated, so a source is named
    // only when it is readable by id — an unlisted or public tree. An absent (null) or private
    // tree stays undescribed, so its title and shape never ride an email addressed by a stranger.
    if (!room || !canRead(std::nullopt, room->owner(), room->visibility())) return std::nullopt;
    return Description{room->title().value, room->snapshot().nodes.size()};
  } catch (const std::exception&) {
    return std::nullopt;
  }
}

}
