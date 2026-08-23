#pragma once

#include "products/roadmap/application/RoomRegistry.h"
#include "platform/ports/TokenGenerator.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <cstddef>
#include <optional>
#include <string>

namespace wm {

// Forks a roadmap: copy the source's live authoritative state (socket edits folded in, not just the
// last snapshot) into a fresh tree owned by the caller. The one Action behind the REST fork endpoint
// and the pending fork a magic-link verify executes.
class ForkService {
public:
  ForkService(RoomRegistry& registry, TreeRepository& trees, TokenGenerator& tokens);

  enum class Outcome { forked, noSource, conflict };
  struct Result {
    Outcome outcome;
    TreeData data;  // the fork's document (copied kinds verbatim), id and title rewritten
  };
  // requestedId and requestedTitle may be empty: the id is then server-minted, the title inherited.
  Result fork(const TreeId& source, const std::string& requestedId, const std::string& requestedTitle,
              const UserId& owner);

  // The source's live face — title and step count — for mail that must name the tree it will plant.
  // Reads the room's current state under its strand; a source that can't be opened yields nullopt so
  // the caller can degrade to copy that promises nothing.
  struct Description {
    std::string title;
    std::size_t steps = 0;
  };
  std::optional<Description> describe(const TreeId& source);

private:
  RoomRegistry& registry_;
  TreeRepository& trees_;
  TokenGenerator& tokens_;
};

}
