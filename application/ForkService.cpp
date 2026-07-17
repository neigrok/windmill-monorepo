#include "application/ForkService.h"

#include "application/TreeRoom.h"

#include <mutex>
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
      TreeRoom& room = registry_.open(source);
      data = room.snapshot();
      state = room.exportState();
      legend = room.exportLegend();
      title = room.title().value;
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
    TreeRoom& room = registry_.open(source);
    return Description{room.title().value, room.snapshot().nodes.size()};
  } catch (const std::exception&) {
    return std::nullopt;
  }
}

}
