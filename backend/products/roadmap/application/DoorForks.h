#pragma once

#include "platform/ports/TokenGenerator.h"
#include "products/roadmap/application/RoadmapDoor.h"
#include "products/roadmap/ports/TreeForks.h"

namespace wm {

// The fork through the engine's door (Roadmap on the sync engine §7, Fork is the server's): a readable root's branch —
// the root and every subtree that stands under it — read in one snapshot and copied into the caller's account under new
// ids, each record a create at the copy's own server stamps, so a step's created time is when it joined the copy. A step
// deleted in the source is copied deleted, so what each step follows reads as it does in the source (D-5). `status`
// is cleared, the guide is marked inherited where it was another person's, the copies record the roadmap they were
// forked from, and pointers are copied only into the owner's own fork. A device receives the copy by sync. A fork sent
// with a request key derives its copies' ids from the caller, the key and the source, so a resend finishes what a fork
// cut short left undone and answers the same copy; until the root copy's meta lands, last, the copy stands nowhere.
class DoorForks final : public TreeForks {
public:
  DoorForks(roadmap::RoadmapDoor& door, TokenGenerator& tokens);

  Result fork(const TreeId& source, const std::string& requestedId, const std::string& requestedTitle,
              const UserId& owner, const std::optional<std::string>& requestKey) override;
  std::optional<Description> describe(const TreeId& source) override;

private:
  roadmap::RoadmapDoor& door_;
  TokenGenerator& tokens_;
};

}
