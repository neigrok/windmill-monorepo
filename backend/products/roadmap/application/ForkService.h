#pragma once

#include "products/roadmap/application/RoomRegistry.h"
#include "platform/ports/Clock.h"
#include "platform/ports/TokenGenerator.h"
#include "products/roadmap/domain/Subtree.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <cstddef>
#include <optional>
#include <string>

namespace wm {

// Copies a root and its standing branch — every subtree reached down present owning steps — as each tree's room holds
// it (socket edits folded in, not just the last snapshot), into fresh trees owned by the caller, stored in one
// transaction. Each copy gets a minted id, the root's may be asked for, and each subtree's copy hangs from the copy of
// its parent under the same step, so a fork never shares a child with its source. Each copy keeps its own legend and
// guide. Someone else's guide is marked inherited: its author's words until the new owner writes a guide of their
// own; the caller's own stays theirs. A fork of the caller's own tree keeps the tree each step opens; a fork of anyone
// else's opens none. The fork starts unlit, and each copy's steps, title and guide are planted at one server stamp of
// its own tree's clock, minted as it is read. A subtree is never forked alone.
class ForkService {
public:
  ForkService(RoomRegistry& registry, TreeRepository& trees, TokenGenerator& tokens, Clock& clock);

  enum class Outcome { forked, noSource, conflict, notARoot };
  struct Result {
    Outcome outcome;
    TreeData data;  // the root copy's document (copied kinds verbatim), id and title rewritten
    std::optional<NotARoot> notARoot;  // where the subtree that was asked to be forked hangs
  };
  // requestedId and requestedTitle may be empty: the id is then server-minted, the title inherited.
  // noSource is only an absent, hidden or unreadable source; an infrastructure failure throws, so the
  // door reports it. One `roadmap_tree_fork` line counts the trees a fork copied.
  Result fork(const TreeId& source, const std::string& requestedId, const std::string& requestedTitle,
              const UserId& owner);

  // The source's live face — title and step count — for mail that must name the tree it will plant.
  // Read under the room's strand; a source that can't be opened yields nullopt.
  struct Description {
    std::string title;
    std::size_t steps = 0;
  };
  std::optional<Description> describe(const TreeId& source);

private:
  RoomRegistry& registry_;
  TreeRepository& trees_;
  TokenGenerator& tokens_;
  Clock& clock_;
};

}
