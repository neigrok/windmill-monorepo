#pragma once

#include "platform/domain/Ids.h"

#include <json/json.h>

#include <optional>
#include <string>

namespace wm {

// The vendor's four buckets; cache reads and writes are priced differently from fresh input.
struct TokenUse {
  long long input = 0;
  long long output = 0;
  long long cacheRead = 0;
  long long cacheWrite = 0;
};

// A field that is missing, null or not a number counts as zero; never throws.
TokenUse tokensFrom(const Json::Value& usage);

// Nano-dollars, integer arithmetic throughout; no float ever touches a cost. nullopt means the
// model is absent from the price table — unpriced, not free.
std::optional<long long> costNanos(const std::string& model, const TokenUse& tokens);

// The same cost, never absent: an unpriced model is charged the dearest rate known. Every spend
// control reads this; only the display reads the optional above.
long long floorCostNanos(const std::string& model, const TokenUse& tokens);

// `user` is nullopt for anonymous calls and is never invented. `runId` groups one tool loop's
// iterations into one logical operation.
struct AiSpend {
  std::optional<UserId> user;
  std::string product;
  std::string operation;
  std::string model;
  std::string runId;
  std::string outcome;
  TokenUse tokens;
  int iteration = 0;
};

// A closed set of words an aggregate can branch on. Failed calls land in the ledger too.
struct AiOutcome {
  static constexpr const char* ok = "ok";
  static constexpr const char* truncated = "truncated";
  static constexpr const char* refused = "refused";
  static constexpr const char* rateLimited = "rate_limited";
  static constexpr const char* transport = "transport";
  static constexpr const char* schemaInvalid = "schema_invalid";
};

// One account's AI budget for the window; the service loads `spent`, the domain answers.
struct AiAllowance {
  long long limitNanos = 0;
  long long spentNanos = 0;

  long long remainingNanos() const { return limitNanos > spentNanos ? limitNanos - spentNanos : 0; }
  bool allows() const { return spentNanos < limitNanos; }
};

constexpr long long kFreeMonthlyAiNanos = 25'000'000'000;   // $25.00 over the rolling 30 days
constexpr long long kProMonthlyAiNanos = 50'000'000'000;    // $50.00

// Background work gets its own bucket, keyed by product, so a sweep cannot eat a user's allowance.
constexpr long long kSweepMonthlyAiNanos = 2'000'000'000;   // $2.00

}
