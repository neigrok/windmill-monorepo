#pragma once

#include "domain/Billing.h"
#include "domain/Ids.h"

#include <optional>
#include <string>

namespace wm {

// The local mirror of Paddle's billing state, so access gating reads this database instead of the
// Paddle API. Every write is an upsert keyed on the Paddle id: Paddle delivers at-least-once and
// out of order, so a redelivered or early event must converge on the latest state rather than
// duplicate or fail.
struct SubscriptionRepository {
  virtual ~SubscriptionRepository() = default;

  virtual void upsertCustomer(const PaddleCustomer& customer) = 0;
  virtual void upsertSubscription(const PaddleSubscription& subscription) = 0;

  // The subscription that decides this account's access, found by EITHER binding: the user id our
  // checkout stamped, or the email of its Paddle customer.
  //
  // It deliberately prefers ANY access-granting row over the newest one. `custom_data` rides in
  // from a checkout anyone can open, so a stranger can plant a row carrying someone else's user id
  // — cancel it and, under a newest-row-wins rule, it would shadow that person's real subscription
  // and lock a paying customer out. Asking "does this account have any live subscription" makes a
  // planted dead row inert. It also sidesteps created_at (a local insert time, which a replayed or
  // backfilled old event puts out of order). Falls back to the newest row for display when nothing
  // grants access, so the UI can still say `canceled` rather than `none`.
  virtual std::optional<PaddleSubscription> findFor(const UserId& user, const std::string& email) = 0;
};

}
