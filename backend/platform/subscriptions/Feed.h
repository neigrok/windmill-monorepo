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

// What a period was bought at: a decimal amount and its ISO 4217 currency.
struct Price {
  std::string amount;
  std::string currency;
  bool operator==(const Price&) const = default;
};

// A word the contract does not name yet, in an entry that still applies: the follower reports it, and never stops on it.
struct UnknownWord {
  std::string field;  // type, store, offerKind or period.offerKind
  std::string word;
  bool operator==(const UnknownWord&) const = default;
};

// D-4: one stretch [start, end) paid for or granted, as a period event carries it; `id` is the service's own.
struct Period {
  // An offer the contract does not name reads as none, and joins `unknownWords`.
  Period(const Json::Value& period, std::vector<UnknownWord>& unknownWords);

  std::string id;
  std::int64_t start = 0;
  std::int64_t end = 0;
  std::optional<Price> price;
  std::optional<std::string> offerKind;
  std::optional<std::int64_t> refundedAt;
};

// One event of the ledger (§3.4, §5.2) and, when it names an account, that account's entitlement after the event's
// transaction. Only what decides access stops a page: `environment` and the shape. An event type, store or offer the
// contract does not name yet is carried, applied to the copy and listed in `unknownWords`.
struct FeedEntry {
  explicit FeedEntry(const Json::Value& entry);

  Seq seq = 0;
  std::string type;
  bool knownType = true;  // false for an event the contract does not name: consumers after the copy skip it
  std::int64_t occurredAt = 0;
  std::int64_t recordedAt = 0;
  std::string subscriptionId;
  std::optional<UserId> accountId;
  std::string store;  // D-1, or "unknown"
  std::string environment;
  std::optional<std::string> offerKind;
  std::optional<Period> period;  // exactly on the three period events; ignored on an event the contract does not name
  std::optional<EntitlementResponse> entitlement;  // exactly when accountId is
  std::vector<UnknownWord> unknownWords;
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
