#pragma once

#include "platform/domain/AiUsage.h"
#include "platform/application/AiBudgetService.h"
#include "platform/domain/Ids.h"
#include "platform/ports/AiUsageRepository.h"
#include "platform/ports/Clock.h"
#include "platform/subscriptions/EntitlementCopy.h"
#include "platform/subscriptions/WindmillOne.h"

#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace wm {

// The legacy allowance window used when durable USD allowances are disabled.
constexpr long long kAiWindowMs = 30LL * 24 * 60 * 60 * 1000;

// Addresses a person types into a deploy variable, comma-separated: matched lowercased, with blanks ignored. No address
// contains a comma.
class EmailList {
public:
  EmailList() = default;
  explicit EmailList(std::string_view listed);

  bool contains(std::string_view email) const;

private:
  std::vector<std::string> addresses_;
};

// Who holds Windmill One without paying for it in production: owners hold it outright (WINDMILL_OWNER_EMAILS), and the
// sandbox testers' sandbox purchases count (WINDMILL_SANDBOX_EMAILS, subscriptions.md §6.2).
struct Allowlists {
  EmailList owners;
  EmailList sandboxTesters;
};

// The one seam every product asks about Windmill One and about AI budget. Windmill One is read from the backend's own
// copy of each account's entitlement (subscriptions.md §6.1), never from a store or the subscription service.
class Entitlements {
public:
  Entitlements(subscriptions::EntitlementReader& copy, Clock& clock, AiUsageRepository& usage, Allowlists lists = {},
               std::vector<std::string> passiveOperations = {}, std::shared_ptr<AiBudgetService> budgets = nullptr);

  bool aiAllowancesEnabled() const { return bool(budgets_); }
  AiBudgetPrincipal aiPrincipalFor(const UserId& user, const std::string& email) const;
  AiBudgetView aiAllowanceView(const UserId& user, const std::string& email) const;

  // The account's hold on Windmill One now: what every gate below decides on, and what GET /v1/subscription shows.
  subscriptions::Standing standingOf(const UserId& user, const std::string& email) const;
  bool hasWindmillOne(const UserId& user, const std::string& email) const;

  // Asked apart from the plan: a surface can need this without inheriting anything about payment.
  bool isOwner(const std::string& email) const;

  // Every enabled-mode call debits the principal; legacy mode uses active usage.
  AiAllowance aiAllowanceFor(const UserId& user, const std::string& email) const;

  // Passive work has a separate operational ceiling for each product.
  AiAllowance sweepAllowanceFor(const UserId& user, const std::string& product) const;

private:
  std::shared_ptr<AiBudgetService> budgets_;
  subscriptions::EntitlementReader& copy_;
  Clock& clock_;
  AiUsageRepository& usage_;
  std::vector<std::string> passiveOperations_;
  Allowlists lists_;
};

}
