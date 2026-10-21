#pragma once

#include "products/gym/onboarding/Onboarding.h"
#include "platform/adapters/postgres/PgPool.h"

#include <memory>

namespace wm::gym {

class PgOnboardingRepository : public OnboardingRepository {
public:
  explicit PgOnboardingRepository(std::shared_ptr<PgPool> pool);
  OnboardingClaim claim(const OnboardingRecord& proposed) override;
  std::optional<OnboardingRecord> get(const std::string& deviceId,
                                    const std::string& requestId, long long nowMs) override;
  bool finish(const OnboardingRecord& result, long long nowMs) override;
  void expire(long long nowMs) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
