#pragma once

#include "platform/application/AiBudgetService.h"
#include "platform/subscriptions/EntitlementCopy.h"

#include <functional>
#include <optional>
#include <string>

namespace wm::subscriptions {

// The AI allowance the feed's paid periods fund (subscriptions.md §6.3). Each ledger call commits on its own before the
// page does, since its lock is the one every Coach admission takes, and each is idempotent: nothing funds twice.
class PeriodFunding final : public FeedEntrySideConsumer {
public:
  // `periodNanos` is what one paid period funds (AI_ONE_PERIOD_USD).
  PeriodFunding(AiBudgetService& budgets, long long periodNanos);

  void consume(const PageTxn& page, const FeedEntry& entry) override;

private:
  void fund(const FeedEntry& entry);
  AiBudgetCode refund(const FeedEntry& entry, std::optional<long long> refundedAtMs);
  // One line per call under a request of its own: `ok`, `replay`, `unchanged` for no such grant, or `conflict`, a paid
  // period left unfunded, which also files a warning. Any other answer throws, and the page rolls back.
  AiBudgetCode observe(const std::string& operation, const FeedEntry& entry,
                       const std::function<AiBudgetGrantResult()>& call);

  AiBudgetService& budgets_;
  const long long periodNanos_;
};

}
