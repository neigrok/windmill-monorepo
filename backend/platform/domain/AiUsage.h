#pragma once

#include "platform/domain/Ids.h"

#include <json/json.h>

#include <optional>
#include <string>

namespace wm {

// What one vendor call consumed, in the vendor's own four buckets. Cache reads and cache writes are
// priced differently from fresh input, so folding them into one number would make the cheapest half
// of our traffic indistinguishable from the most expensive.
struct TokenUse {
  long long input = 0;
  long long output = 0;
  long long cacheRead = 0;
  long long cacheWrite = 0;
};

// Read the `usage` object off a reply. A field that is missing, null or not a number counts as zero
// and NEVER throws: a reply we cannot count is still a reply we must return to the person waiting
// for it. Losing a row from the meter is a bad day; losing the answer is a broken product.
TokenUse tokensFrom(const Json::Value& usage);

// What that call cost, in NANO-dollars. Nanos and not micros because haiku input is one micro-dollar
// per thousand tokens, so a 300-token compose would truncate to zero — and a cache read at a tenth
// of that is ten times worse. The unit would have systematically zeroed exactly the cheap
// high-volume calls this meter exists to count. Integer arithmetic throughout; no float ever touches
// a cost. nullopt means the model is absent from the price table: unpriced must be LOUD, never
// silently free.
std::optional<long long> costNanos(const std::string& model, const TokenUse& tokens);

// The same cost, but never absent — an unpriced model is charged the dearest rate we know rather
// than nothing. Every spend CONTROL reads this; only the display reads the optional above. Charging
// an unknown model zero is the arithmetic that makes a runaway invisible: it moves no ceiling and
// trips no fuse, so the failure the dashboard shouts about is the one the ceilings would wave
// through. A guess that errs toward refusing is the right way for a fuse to be wrong.
long long floorCostNanos(const std::string& model, const TokenUse& tokens);

// One row of the ledger. `user` is nullopt for the anonymous birth canvas — never invented, because
// an invented owner is worse than an honest gap. `runId` groups one tool loop's iterations into one
// logical operation, which is the only way a twelve-iteration agent reads as one act.
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

// Why a call ended, as a closed set of words — the same discipline MessagesFailure holds, and for the
// same reason: an aggregate can branch on these, and cannot branch on an open-ended vendor string.
// Failed calls are disproportionately the expensive ones (a max_tokens truncation burned the entire
// budget), so every one of these lands in the ledger.
struct AiOutcome {
  static constexpr const char* ok = "ok";
  static constexpr const char* truncated = "truncated";
  static constexpr const char* refused = "refused";
  static constexpr const char* rateLimited = "rate_limited";
  static constexpr const char* transport = "transport";
  static constexpr const char* schemaInvalid = "schema_invalid";
};

// One account's AI budget for the window: what the plan grants, what it has spent, and so whether the
// next call may run. Deliberately TendingAllowance's twin (Tending.h) — the service loads `spent`,
// the domain answers. These are fuses, not walls: set high enough that a legitimate user never meets
// one, and no dollar figure is ever shown to anybody but us.
struct AiAllowance {
  long long limitNanos = 0;
  long long spentNanos = 0;

  long long remainingNanos() const { return limitNanos > spentNanos ? limitNanos - spentNanos : 0; }
  bool allows() const { return spentNanos < limitNanos; }
};

// Deliberately generous, because paid plans cannot currently be BOUGHT (checkout is closed and
// BillingApi 503s one anyway) — so every account is on the free tier with no upgrade path, and a
// tight ceiling would refuse real people over something they could do nothing about. A fuse, not a
// wall; tune it down when there is a door to walk through.
constexpr long long kFreeMonthlyAiNanos = 25'000'000'000;   // $25.00 over the rolling 30 days
constexpr long long kProMonthlyAiNanos = 50'000'000'000;    // $50.00

// Background work gets its OWN bucket, keyed by product. One shared per-user budget let a 6-hourly
// sweep the user never asked for eat the allowance their next question is then refused for.
constexpr long long kSweepMonthlyAiNanos = 2'000'000'000;   // $2.00

}
