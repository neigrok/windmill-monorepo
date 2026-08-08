#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/ports/AiUsageRepository.h"

#include <memory>
#include <string>
#include <vector>

namespace wm {

class PgAiUsageRepository : public AiUsageRepository {
public:
  explicit PgAiUsageRepository(std::shared_ptr<PgPool> pool);

  void record(const AiSpend& spend) noexcept override;
  long long spentSinceNanos(const UserId& user, const std::string& product,
                            long long sinceMs) override;
  UsageSummary summary(long long fromMs, long long toMs) override;
  std::vector<UserSpend> topSpenders(long long fromMs, long long toMs, int limit) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
