#pragma once

#include "platform/domain/AiUsage.h"
#include "platform/domain/Ids.h"

#include <string>
#include <vector>

namespace wm {

// The write half, and the only half an LLM adapter holds. `noexcept` is the contract: a failed
// ledger write must never break the product it was watching. A null shared_ptr is the no-op.
// Counts and costs only, never content.
struct UsageSink {
  virtual ~UsageSink() = default;
  virtual void record(const AiSpend& spend) noexcept = 0;
};

// `unpricedCalls` non-zero means costNanos is a floor, not a total.
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

// `anonymousCostNanos` is inside costNanos but belongs to no person, so it is never ranked.
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

// Windows arrive as epoch-ms; an empty `product` means every product.
struct AiUsageRepository : UsageSink {
  virtual long long spentSinceNanos(const UserId& user, const std::string& product,
                                    long long sinceMs) = 0;
  virtual UsageSummary summary(long long fromMs, long long toMs) = 0;
  virtual std::vector<UserSpend> topSpenders(long long fromMs, long long toMs, int limit) = 0;
};

}
