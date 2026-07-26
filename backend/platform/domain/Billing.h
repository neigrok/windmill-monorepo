#pragma once

#include <string>

namespace wm {

// A Paddle customer mirrored locally. The email is the whole bridge to a Windmill account: a user
// has no Paddle customer until their first checkout, when customer.created arrives.
struct PaddleCustomer {
  std::string customerId;
  std::string email;
};

// A Paddle subscription mirrored locally. `status` is Paddle's own vocabulary, stored verbatim so a
// vocabulary Paddle adds later still round-trips. `scheduledChangeAt` is set while a pause or cancel
// is pending — the status stays `active` until that date lands, which is what the UI reads to say
// "cancels on the 12th" rather than "subscribe".
struct PaddleSubscription {
  std::string subscriptionId;
  std::string customerId;
  // The Windmill account this subscription belongs to, carried from the checkout's custom_data.
  // Authoritative when present — identity was bound server-side, so nothing was typed and nothing
  // can be mismatched. Empty for a subscription created outside our checkout, which falls back to
  // matching the customer's email.
  std::string userId;
  std::string status;
  std::string priceId;
  std::string productId;
  std::string scheduledChangeAt;  // RFC 3339; empty when nothing is scheduled
  std::string occurredAt;         // the event's own time, so a stale retry can't overwrite newer state
};

// Who gets the paid product. `active` and `trialing` are plainly paying. `past_due` keeps access
// through Paddle's dunning retries — taking the product away the hour a card expires punishes the
// wrong person, and the UI is free to nudge instead. `paused` and `canceled` do not: `canceled` is
// terminal, and a cancel scheduled for the period end still reads `active` until it takes effect.
inline bool grantsAccess(const std::string& status) {
  return status == "active" || status == "trialing" || status == "past_due";
}

}
