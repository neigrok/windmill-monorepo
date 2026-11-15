#pragma once

#include "platform/application/AiBudgetService.h"
#include "platform/subscriptions/EntitlementCopy.h"

#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace wm::subscriptions {

// The AI allowance the feed's paid periods fund (subscriptions.md §6.3). Each ledger call commits on its own before the
// page does, since its lock is the one every Coach admission takes, and each is idempotent: nothing funds twice. Of a
// period's events in one page only the last acts, so a rebuild, one page holding the whole ledger, never walks a grant
// through its period's history.
class PeriodFunding final : public FeedPageSideConsumer {
public:
  // `periodNanos` is what one paid period funds (AI_ONE_PERIOD_USD).
  PeriodFunding(AiBudgetService& budgets, long long periodNanos);

  void consume(const PageTxn& page, const std::vector<FeedEntry>& entries) override;

private:
  void fund(const PageTxn& page, const FeedEntry& entry, const AiBudgetStatement& statement);
  AiBudgetCode refund(const FeedEntry& entry, std::optional<long long> refundedAtMs, const AiBudgetStatement& statement);
  // One line per call under a request of its own: `ok`, `replay`, `unchanged` for no such grant, or `conflict`, a paid
  // period left unfunded, which also files a warning. Any other answer throws, and the page rolls back. A period of an
  // account the backend no longer holds, erased before the service unbound it or read again by a rebuild, calls nothing
  // and writes `no_account`.
  AiBudgetCode observe(const std::string& operation, const FeedEntry& entry,
                       const std::function<AiBudgetGrantResult()>& call);

  AiBudgetService& budgets_;
  const long long periodNanos_;
};

}
