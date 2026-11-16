#pragma once

#include <optional>
#include <string>

namespace wm {

// The email is the whole bridge to a Windmill account.
struct PaddleCustomer {
  std::string customerId;
  std::string email;
};

// `status` is Paddle's own vocabulary, stored verbatim. `scheduledChangeAt` is set while a pause or
// cancel is pending; the status stays `active` until that date lands.
struct PaddleSubscription {
  std::string subscriptionId;
  std::string customerId;
  // From the checkout's custom_data; empty for a subscription that carries none. Funding binds the
  // account by the customer's email and refuses a payment whose stamped account is another.
  std::string userId;
  std::string status;
  std::string priceId;
  std::string productId;
  std::string scheduledChangeAt;  // RFC 3339; empty when nothing is scheduled
  std::string occurredAt;         // the event's own time, so a stale retry can't overwrite newer state
};

// Local mirror of Paddle's billing state, which funding a Paddle payment reads by Paddle id. Every
// write is an upsert keyed on the Paddle id: Paddle delivers at-least-once and out of order, so
// events must converge rather than duplicate or fail.
struct SubscriptionRepository {
  virtual ~SubscriptionRepository() = default;

  virtual void upsertCustomer(const PaddleCustomer& customer) = 0;
  virtual void upsertSubscription(const PaddleSubscription& subscription) = 0;

  virtual std::optional<PaddleCustomer> findCustomer(const std::string& customerId) = 0;
  virtual std::optional<PaddleSubscription> findSubscription(const std::string& subscriptionId) = 0;
};

}
