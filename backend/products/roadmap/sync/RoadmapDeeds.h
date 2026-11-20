#pragma once

#include "platform/domain/Ids.h"
#include "platform/domain/sync/Record.h"
#include "platform/ports/SyncStore.h"
#include "products/roadmap/domain/Command.h"

#include <optional>
#include <string>
#include <vector>

// A roadmap's activity as the binding keeps it (roadmap-on-the-engine.md §7): one deed for each gesture that leaves one
// in a roadmap, with who made it, told in the words the activity feed reads (application/ActivityFeed).

namespace wm::roadmap::engine {

// One record of a roadmap as an intent found it and as it leaves it; either is unset where there was no record.
struct Touched {
  std::optional<sync::Row> before;
  std::optional<sync::Row> after;
};

// What one intent did in a roadmap, as its activity tells a reader: the steps that came and went, the kinds that came,
// went or changed, the steps renamed or recoloured and the links drawn or taken away, in that order, as one command or a
// Batch of them; nothing where it left no deed. A roadmap's genesis kinds come with it, the links of a step that came
// with the step, and the steps a kind's recolour repaints with the recolour, so none is told apart; an annotation, a
// move, a title and what only the server writes leave no deed.
std::optional<Command> deedOf(const std::vector<Touched>& records);

// One deed in one roadmap: the roadmap, the account that made it, the gesture it belongs to, which the intents of one
// gesture share, and what it did.
struct Deed {
  std::string tree;
  UserId actor;
  std::optional<std::string> gesture;
  Command what;
};

// Where the binding records every deed, inside the transaction that admits its intent, so a deed stands exactly when
// its intent does.
class Deeds {
public:
  virtual ~Deeds() = default;
  virtual void record(sync::SyncTxn& txn, const Deed& deed) = 0;
};

}
