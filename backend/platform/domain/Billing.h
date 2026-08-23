#pragma once

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
  // From the checkout's custom_data; empty for a subscription created outside our checkout, which
  // falls back to matching the customer's email.
  std::string userId;
  std::string status;
  std::string priceId;
  std::string productId;
  std::string scheduledChangeAt;  // RFC 3339; empty when nothing is scheduled
  std::string occurredAt;         // the event's own time, so a stale retry can't overwrite newer state
};

// `past_due` keeps access through Paddle's dunning retries; `paused` and `canceled` do not.
inline bool grantsAccess(const std::string& status) {
  return status == "active" || status == "trialing" || status == "past_due";
}

}
