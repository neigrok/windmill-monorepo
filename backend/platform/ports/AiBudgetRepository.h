#pragma once

#include "platform/domain/AiBudget.h"

namespace wm {

struct AiBudgetRepository {
  virtual ~AiBudgetRepository() = default;
  // Trusted owner access ensures a calendar grant when no subscription grant is current.
  virtual AiBudgetSnapshot snapshot(const AiBudgetPrincipal& principal, long long atMs,
                                    const AiBudgetLimits& limits) = 0;
  // Admission, concurrency, budget allocations and threshold outbox writes are atomic.
  virtual AiBudgetResult reserve(const AiBudgetRequest& request, const AiBudgetLimits& limits) = 0;
  virtual AiBudgetResult markDispatched(const std::string& id) = 0;
  virtual AiBudgetResult markUncertain(const std::string& id) = 0;
  virtual AiBudgetResult settle(const std::string& id, long long actualNanos) = 0;
  virtual AiBudgetResult release(const std::string& id) = 0;
  virtual AiBudgetResult reconcileOverrun(const std::string& id) = 0;
  virtual AiBudgetGrantResult fund(const AiBudgetGrant& grant, const AiBudgetLimits& limits) = 0;
  virtual AiBudgetCode bindDevice(const std::string& deviceId, const std::string& accountId,
                                 long long atMs, const AiBudgetLimits& limits) = 0;
  virtual std::vector<AiBudgetAlert> claimAlerts(long long atMs, int limit, long long leaseUntilMs) = 0;
  virtual AiBudgetCode completeAlert(const std::string& id, const std::string& claimToken) = 0;
  virtual AiBudgetCode retryAlert(const std::string& id, const std::string& claimToken,
                                 long long nextAttemptMs) = 0;
};

}
