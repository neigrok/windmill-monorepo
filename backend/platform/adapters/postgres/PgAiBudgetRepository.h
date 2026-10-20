#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/ports/AiBudgetRepository.h"

#include <memory>

namespace wm {

class PgAiBudgetRepository final : public AiBudgetRepository {
public:
  explicit PgAiBudgetRepository(std::shared_ptr<PgPool> pool);

  AiBudgetSnapshot snapshot(const AiBudgetPrincipal& principal, long long atMs,
                            const AiBudgetLimits& limits) override;
  AiBudgetResult reserve(const AiBudgetRequest& request, const AiBudgetLimits& limits) override;
  AiBudgetResult markDispatched(const std::string& id) override;
  AiBudgetResult markUncertain(const std::string& id) override;
  AiBudgetResult settle(const std::string& id, long long actualNanos) override;
  AiBudgetResult release(const std::string& id) override;
  AiBudgetResult reconcileOverrun(const std::string& id) override;
  AiBudgetGrantResult fund(const AiBudgetGrant& grant, const AiBudgetLimits& limits) override;
  std::optional<std::string> boundAccount(const std::string& deviceId) override;
  AiBudgetCode bindDevice(const std::string& deviceId, const std::string& accountId,
                         long long atMs, const AiBudgetLimits& limits) override;
  std::vector<AiBudgetAlert> claimAlerts(long long atMs, int limit, long long leaseUntilMs) override;
  AiBudgetCode completeAlert(const std::string& id, const std::string& claimToken) override;
  AiBudgetCode retryAlert(const std::string& id, const std::string& claimToken,
                         long long nextAttemptMs) override;

private:
  AiBudgetResult transition(const std::string& id, AiBudgetState target,
                            std::optional<long long> actualNanos = std::nullopt);
  AiBudgetCode finishAlert(const std::string& id, const std::string& claimToken,
                          std::optional<long long> nextAttemptMs);

  std::shared_ptr<PgPool> pool_;
};

}
