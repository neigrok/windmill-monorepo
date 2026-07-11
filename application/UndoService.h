#pragma once

#include "domain/Command.h"
#include "domain/Ids.h"

#include <map>
#include <optional>
#include <vector>

namespace wm {

// Per-user undo stacks of inverse commands. A room hands it the inverse of each op an
// actor makes; undo pops the most recent and the caller resubmits it as a fresh op —
// which the room merges like any other, so undo can never be rejected (§5).
class UndoService {
public:
  void record(const UserId& user, std::vector<Command> inverse);
  std::optional<std::vector<Command>> pop(const UserId& user);
  std::size_t depth(const UserId& user) const;

private:
  std::map<UserId, std::vector<std::vector<Command>>> stacks_;
};

}
