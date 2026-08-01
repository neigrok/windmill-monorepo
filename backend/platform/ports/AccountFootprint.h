#pragma once

#include "platform/domain/Ids.h"

namespace wm {

// Whether an account holds anything a merge would destroy — the one precondition on the link door
// (backend/AUTH.md, "The link door"). It exists so that folding a just-created provider account
// into the account the human already had is a delete of nothing, and so that a general account
// merger never has to be written: two accounts each carrying trees, pages, sets, a subscription
// and their own grants have no correct resolution, and the case never occurs.
//
// Products own the answer, so it arrives through a port rather than through platform learning any
// product's schema. Every product must be represented: a product missing from the probe set fails
// in the destructive direction, reporting an account empty that is not.
struct AccountFootprint {
  virtual ~AccountFootprint() = default;
  virtual bool anyData(const UserId& userId) = 0;
};

}
