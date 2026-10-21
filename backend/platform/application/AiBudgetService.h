#pragma once

#include "platform/ports/AiBudgetRepository.h"

#include <functional>

namespace wm {

class AiBudgetService {
public:
  AiBudgetService(AiBudgetRepository& repository, std::function<AiBudgetLimits()> limits,
                  std::function<long long()> clock);

  AiBudgetView view(const AiBudgetPrincipal& principal) const;
  AiBudgetResult reserve(const std::string& id, const AiBudgetPrincipal& principal, long long amountNanos,
                         std::optional<AiOutputBudget> outputBudget = std::nullopt);
  AiBudgetResult markDispatched(const std::string& id);
  AiBudgetResult markUncertain(const std::string& id);
  AiBudgetResult settle(const std::string& id, long long actualNanos);
  AiBudgetResult release(const std::string& id);
  AiBudgetResult reconcileOverrun(const std::string& id);
  AiBudgetGrantResult fund(const AiBudgetGrant& grant);
  std::optional<std::string> boundAccount(const std::string& deviceId) const;
  AiBudgetCode bindDevice(const std::string& deviceId, const std::string& accountId);
  std::vector<AiBudgetAlert> claimAlerts(int limit = 20, long long leaseMs = 60'000);
  AiBudgetCode completeAlert(const std::string& id, const std::string& claimToken);
  AiBudgetCode retryAlert(const std::string& id, const std::string& claimToken, long long nextAttemptMs);

private:
  AiBudgetRepository& repository_;
  std::function<AiBudgetLimits()> limits_;
  std::function<long long()> clock_;
};

}
