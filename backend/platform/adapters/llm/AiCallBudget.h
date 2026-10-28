#pragma once

#include "platform/application/AiBudgetService.h"
#include "platform/application/Entitlements.h"
#include "platform/domain/AiUsage.h"
#include "platform/ports/AuthRepository.h"
#include "platform/ports/FailureReporter.h"

#include <memory>

namespace wm {

// Per-request approximate input cost plus the full dispatched output ceiling, settled against actual usage.
std::optional<long long> anthropicReservationNanos(const Json::Value& request);
std::optional<AiOutputBudget> anthropicOutputBudget(const Json::Value& request, int minOutputTokens);
std::optional<long long> anthropicActualNanos(const std::string& model, const Json::Value& usage);

enum class AiCallEnd { settled, unconsumed, uncertain };

struct AiCallAdmission {
  std::optional<AiBudgetReservation> reservation;
  std::string refusal;
};

class AiInstallationPrincipal;

class AiCallBudget {
public:
  AiCallBudget(std::shared_ptr<AiBudgetService> budgets, Entitlements& entitlements,
               AuthRepository& accounts, FailureReporter& failures);

  AiCallAdmission begin(const AiSpend& spend, const Json::Value& request, int minOutputTokens = 0);
  AiCallAdmission beginInstallation(const AiInstallationPrincipal& principal, const AiSpend& spend,
                                    const Json::Value& request, int minOutputTokens = 1024);
  // `settled` books the vendor's reported usage; `unconsumed` books zero — the vendor answered an
  // error before any message began; `uncertain` keeps the hold — the send is ambiguous.
  void finish(const AiBudgetReservation& reservation, const std::string& model,
              const Json::Value& usage, AiCallEnd end);

private:
  AiCallAdmission admit(const AiBudgetPrincipal& principal, const AiSpend& spend,
                        const Json::Value& request, int minOutputTokens);
  std::shared_ptr<AiBudgetService> budgets_;
  Entitlements& entitlements_;
  AuthRepository& accounts_;
  FailureReporter& failures_;
};

}
