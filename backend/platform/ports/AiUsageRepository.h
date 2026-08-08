#pragma once

#include "platform/domain/AiUsage.h"
#include "platform/domain/Ids.h"

#include <string>
#include <vector>

namespace wm {

// The write half, and the only half an LLM adapter ever holds. `noexcept` IS the contract: a ledger
// write that fails must never break the product it was only watching. A null shared_ptr is the
// no-op, exactly as FailureReporter is used today — there is no NullUsageSink to remember to wire.
//
// Counts and costs only, never content. The same rule VendorCall holds: what someone wrote is theirs,
// and an accounting table is not a place to keep it.
struct UsageSink {
  virtual ~UsageSink() = default;
  virtual void record(const AiSpend& spend) noexcept = 0;
};

// One person's line in the ranked table. `unpricedCalls` rides here, and on every other aggregate
// below, because a row with unpriced calls in it is a row whose total is a floor — the reader is owed
// the "≥" and cannot be shown one we did not measure.
struct UserSpend {
  UserId user;
  std::string email;
  long long costNanos = 0;
  long long calls = 0;
  long long unpricedCalls = 0;
  std::string topProduct;
};

struct ProductSpend {
  std::string product;
  long long costNanos = 0;
  long long calls = 0;
  long long unpricedCalls = 0;
};

struct DaySpend {
  std::string day;  // YYYY-MM-DD
  long long costNanos = 0;
  long long calls = 0;
  long long unpricedCalls = 0;
};

// One window, read once. `anonymousCostNanos` is carried apart from the rest because anonymous
// compose is not a person: it belongs in the total and never in a ranked list of people.
struct UsageSummary {
  long long costNanos = 0;
  long long calls = 0;
  long long unpricedCalls = 0;
  long long inputTokens = 0;
  long long outputTokens = 0;
  long long cacheReadTokens = 0;
  long long cacheWriteTokens = 0;
  long long anonymousCostNanos = 0;
  std::vector<ProductSpend> byProduct;
  std::vector<DaySpend> daily;
  std::vector<std::string> unpricedModels;
};

// The read half, held only by the two readers that are allowed one: the budget check and the owner
// page. Adapters take the UsageSink above and so structurally cannot read the ledger back.
// Windows arrive as epoch-ms; an empty `product` means every product.
struct AiUsageRepository : UsageSink {
  virtual long long spentSinceNanos(const UserId& user, const std::string& product,
                                    long long sinceMs) = 0;
  virtual UsageSummary summary(long long fromMs, long long toMs) = 0;
  virtual std::vector<UserSpend> topSpenders(long long fromMs, long long toMs, int limit) = 0;
};

}
