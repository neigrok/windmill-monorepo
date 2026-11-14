#pragma once

#include "platform/domain/Ids.h"

#include <json/json.h>

#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace wm::subscriptions {

// The feed could not be read; `answer` is a bounded word (`timeout`, `unreachable`, `503`, `malformed`, …), never a body.
struct FeedUnavailable : std::runtime_error {
  explicit FeedUnavailable(std::string answer)
      : std::runtime_error("subscription feed unavailable: " + answer), answer(std::move(answer)) {}
  const std::string answer;
};

// §5.2 EntitlementResponse: one account's entitlement in each environment; access reads `accessUntil`, a surface `body`.
struct EntitlementResponse {
  explicit EntitlementResponse(Json::Value response);

  UserId accountId;
  std::optional<std::int64_t> productionAccessUntil;
  std::optional<std::int64_t> sandboxAccessUntil;
  Json::Value body;
};

// One event of the ledger and, when it names an account, that account's entitlement after the event's transaction.
struct FeedEntry {
  explicit FeedEntry(const Json::Value& entry);

  Seq seq = 0;
  std::string type;
  std::optional<UserId> accountId;
  std::optional<EntitlementResponse> entitlement;  // present exactly when accountId is
};

// A page of `GET /internal/v1/feed`: entries in ascending seq, the ledger's epoch and the newest seq it holds.
struct FeedPage {
  explicit FeedPage(const Json::Value& page);

  std::string epoch;
  std::vector<FeedEntry> entries;
  Seq latestSeq = 0;
};

// Where the copy stands in the ledger: the epoch it was read under, none before its first page, and the last seq applied.
struct FeedCursor {
  std::string epoch;
  Seq seq = 0;

  // §6.1: why `page` comes from a restored ledger (another epoch, or a ledger ending below this cursor), or nothing.
  std::optional<std::string> restoreIn(const FeedPage& page) const;

  // Where the copy stands once `page` applies; FeedUnavailable when it does not continue this cursor.
  FeedCursor past(const FeedPage& page) const;

  bool caughtUpWith(const FeedPage& page) const { return seq >= page.latestSeq; }
  bool operator==(const FeedCursor&) const = default;
};

// The subscription service's feed door (§5.2). Throws FeedUnavailable when the page cannot be read.
struct SubscriptionFeed {
  virtual ~SubscriptionFeed() = default;
  virtual FeedPage page(Seq after, int limit) = 0;
};

}
