#pragma once

#include "platform/domain/Billing.h"
#include "platform/domain/Ids.h"

#include <optional>
#include <string>

namespace wm {

// Local mirror of Paddle's billing state. Every write is an upsert keyed on the Paddle id: Paddle
// delivers at-least-once and out of order, so events must converge rather than duplicate or fail.
struct SubscriptionRepository {
  virtual ~SubscriptionRepository() = default;

  virtual void upsertCustomer(const PaddleCustomer& customer) = 0;
  virtual void upsertSubscription(const PaddleSubscription& subscription) = 0;

  // Found by either binding: the user id the checkout stamped, or the Paddle customer's email.
  // Prefers ANY access-granting row over the newest one, so a dead row planted through `custom_data`
  // cannot shadow a real subscription. Falls back to the newest row for display when none grants
  // access.
  virtual std::optional<PaddleSubscription> findFor(const UserId& user, const std::string& email) = 0;
};

}
