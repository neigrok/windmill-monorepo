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
  // Releases up to `limit` holds that lapsed by `atMs`, oldest first, and answers them released: every principal's,
  // or only those occupying `subject`'s slots, the devices bound to an account included.
  virtual std::vector<AiBudgetReservation> releaseLapsed(long long atMs, int limit,
                                                         const std::optional<AiBudgetSubject>& subject) = 0;
  virtual AiBudgetResult reconcileOverrun(const std::string& id) = 0;
  virtual AiBudgetGrantResult fund(const AiBudgetGrant& grant, const AiBudgetLimits& limits) = 0;
  // The store's refund time for the period the subscription grant `fundingReference` names: one closes it, none reopens
  // it. NotFound when no grant has that reference.
  virtual AiBudgetGrantResult refund(const std::string& fundingReference, std::optional<long long> refundedAtMs) = 0;
  virtual std::optional<std::string> boundAccount(const std::string& deviceId) = 0;
  virtual AiBudgetCode bindDevice(const std::string& deviceId, const std::string& accountId,
                                 long long atMs, const AiBudgetLimits& limits) = 0;
  virtual std::vector<AiBudgetAlert> claimAlerts(long long atMs, int limit, long long leaseUntilMs) = 0;
  virtual AiBudgetCode completeAlert(const std::string& id, const std::string& claimToken) = 0;
  virtual AiBudgetCode retryAlert(const std::string& id, const std::string& claimToken,
                                 long long nextAttemptMs) = 0;
};

}
