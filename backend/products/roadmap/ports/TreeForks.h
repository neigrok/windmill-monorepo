#pragma once

#include "platform/domain/Ids.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Subtree.h"
#include "products/roadmap/domain/Tree.h"

#include <cstddef>
#include <optional>
#include <string>

namespace wm {

// The fork of a roadmap (Roadmap on the sync engine §7, Fork is the server's): a readable root's branch copied into a
// person's account under new ids, `POST /v1/trees/{id}/fork` and the fork a sign-up plants. ForkService copies through
// roadmap's rooms; DoorForks through the engine's door, where ROADMAP_ENGINE_ENABLED serves roadmap's scopes.
class TreeForks {
public:
  enum class Outcome { forked, noSource, conflict, notARoot };
  struct Result {
    Outcome outcome;
    TreeData data;                     // the root copy's document, its id and title the copy's
    std::optional<NotARoot> notARoot;  // where the subtree that was asked to be forked hangs
  };
  // The source's face for mail that names the roadmap it will plant: its title and present step count.
  struct Description {
    std::string title;
    std::size_t steps = 0;
  };

  virtual ~TreeForks() = default;

  // `requestedId` and `requestedTitle` may be empty: the id is then minted, the title the source's. `noSource` is an
  // absent, hidden or unreadable source alike; an infrastructure failure throws, so the door reports it.
  virtual Result fork(const TreeId& source, const std::string& requestedId, const std::string& requestedTitle,
                      const UserId& owner) = 0;
  // A source a stranger may read by its id, a root; none otherwise.
  virtual std::optional<Description> describe(const TreeId& source) = 0;
};

}
