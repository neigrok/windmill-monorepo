#pragma once

#include "platform/application/AiBudgetService.h"
#include "platform/application/Entitlements.h"
#include "platform/domain/AiUsage.h"
#include "platform/ports/AuthRepository.h"
#include "platform/ports/FailureReporter.h"

#include <memory>

namespace wm {

// Per-request approximate input cost plus the configured output ceiling, settled against actual usage.
std::optional<long long> anthropicReservationNanos(const Json::Value& request);
std::optional<long long> anthropicActualNanos(const std::string& model, const Json::Value& usage);

struct AiCallAdmission {
  std::optional<AiBudgetReservation> reservation;
  std::string refusal;
};

class AiCallBudget {
public:
  AiCallBudget(std::shared_ptr<AiBudgetService> budgets, Entitlements& entitlements,
               AuthRepository& accounts, FailureReporter& failures);

  AiCallAdmission begin(const AiSpend& spend, const Json::Value& request);
  void finish(const AiBudgetReservation& reservation, const std::string& model,
              const Json::Value& usage, bool complete);

private:
  std::shared_ptr<AiBudgetService> budgets_;
  Entitlements& entitlements_;
  AuthRepository& accounts_;
  FailureReporter& failures_;
};

}
