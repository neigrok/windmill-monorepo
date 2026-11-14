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

// Who may fund a round: any allowance its caller holds, or only a Windmill One grant, for a round that must never draw
// on the free pools.
enum class AiCallFunding { anyAllowance, windmillOne };

struct AiCallAdmission {
  std::optional<AiBudgetReservation> reservation;
  std::string refusal;
};

class AiInstallationPrincipal;

class AiCallBudget {
public:
  AiCallBudget(std::shared_ptr<AiBudgetService> budgets, Entitlements& entitlements,
               AuthRepository& accounts, FailureReporter& failures);

  // A Messages round, priced from its request body.
  AiCallAdmission begin(const AiSpend& spend, const Json::Value& request, int minOutputTokens = 0);
  AiCallAdmission beginInstallation(const AiInstallationPrincipal& principal, const AiSpend& spend,
                                    const Json::Value& request, int minOutputTokens = 1024);
  // A round its own adapter priced: `ceilingNanos` is the most it can cost, held until it settles, and none is a
  // price this ledger cannot hold. A Windmill One round refuses any other principal as `funding_required`.
  AiCallAdmission begin(const AiSpend& spend, std::optional<long long> ceilingNanos, AiCallFunding funding);
  // `settled` books the vendor's reported usage; `unconsumed` books zero — the vendor consumed
  // nothing: it answered an error before any work began, or never received the request; `uncertain`
  // keeps the hold — the send is ambiguous.
  void finish(const AiBudgetReservation& reservation, const std::string& model,
              const Json::Value& usage, AiCallEnd end);
  // The same for a round its adapter priced: `actualNanos` is what the vendor billed, and none keeps a settled
  // round's hold, as missing usage does.
  void finish(const AiBudgetReservation& reservation, std::optional<long long> actualNanos, AiCallEnd end);

private:
  AiCallAdmission beginAccount(const AiSpend& spend, std::optional<long long> amountNanos,
                               std::optional<AiOutputBudget> outputBudget, AiCallFunding funding);
  AiCallAdmission admit(const AiBudgetPrincipal& principal, std::optional<long long> amountNanos,
                        std::optional<AiOutputBudget> outputBudget);
  std::shared_ptr<AiBudgetService> budgets_;
  Entitlements& entitlements_;
  AuthRepository& accounts_;
  FailureReporter& failures_;
};

}
