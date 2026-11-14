#pragma once

#include "platform/ports/AiBudgetRepository.h"

#include <functional>

namespace wm {

class AiBudgetService {
public:
  AiBudgetService(AiBudgetRepository& repository, std::function<AiBudgetLimits()> limits,
                  std::function<long long()> clock);

  AiBudgetView view(const AiBudgetPrincipal& principal);
  AiBudgetResult reserve(const std::string& id, const AiBudgetPrincipal& principal, long long amountNanos,
                         std::optional<AiOutputBudget> outputBudget = std::nullopt);
  AiBudgetResult markDispatched(const std::string& id);
  AiBudgetResult markUncertain(const std::string& id);
  AiBudgetResult settle(const std::string& id, long long actualNanos);
  AiBudgetResult release(const std::string& id);
  // The sweep's pass over every principal: releases holds that lapsed by now, at most ten batches of twenty and none
  // after `stopping` answers true, and answers how many it let go.
  int releaseLapsed(const std::function<bool()>& stopping = {});
  AiBudgetResult reconcileOverrun(const std::string& id);
  AiBudgetGrantResult fund(const AiBudgetGrant& grant);
  std::optional<std::string> boundAccount(const std::string& deviceId) const;
  AiBudgetCode bindDevice(const std::string& deviceId, const std::string& accountId);
  std::vector<AiBudgetAlert> claimAlerts(int limit = 20, long long leaseMs = 60'000);
  AiBudgetCode completeAlert(const std::string& id, const std::string& claimToken);
  AiBudgetCode retryAlert(const std::string& id, const std::string& claimToken, long long nextAttemptMs);

private:
  // Batch after batch while `anotherBatch` allows and the last came back full; one tally line and one warning for all
  // it let go.
  int releaseLapsed(const std::optional<AiBudgetSubject>& subject, long long atMs, const std::string& door,
                    const std::function<bool()>& anotherBatch);

  AiBudgetRepository& repository_;
  std::function<AiBudgetLimits()> limits_;
  std::function<long long()> clock_;
};

}
