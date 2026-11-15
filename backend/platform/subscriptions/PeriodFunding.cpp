#include "platform/subscriptions/PeriodFunding.h"

#include "platform/application/WriteObservation.h"

#include <algorithm>
#include <map>
#include <stdexcept>

namespace wm::subscriptions {

namespace {
// A period someone paid for and kept: a price above zero, in any currency, and no refund. A free trial is priced at
// nothing, and grace adds no period at all.
bool paidFor(const Period& period) {
  return period.price && !period.refundedAt &&
         std::any_of(period.price->amount.begin(), period.price->amount.end(), [](char c) { return c >= '1' && c <= '9'; });
}

// A production period's event, which states its refund time as it stands; a sandbox period funds no grant (§6.2).
bool statesAProductionPeriod(const FeedEntry& entry) {
  return entry.knownType && entry.period && entry.environment == "production";
}
}

PeriodFunding::PeriodFunding(AiBudgetService& budgets, long long periodNanos)
    : budgets_(budgets), periodNanos_(periodNanos) {}

// A refund closes the grant the period funds and its reversal reopens it, or funds the period as its recording would
// have when it was first heard of refunded.
void PeriodFunding::consume(const PageTxn& page, const std::vector<FeedEntry>& entries) {
  std::map<std::string, Seq> lastEvent;
  for (const FeedEntry& entry : entries)
    if (statesAProductionPeriod(entry)) lastEvent[entry.period->id] = entry.seq;
  for (const FeedEntry& entry : entries) {
    if (!statesAProductionPeriod(entry) || lastEvent.at(entry.period->id) != entry.seq) continue;
    const AiBudgetStatement statement{page.target().epoch, static_cast<long long>(entry.seq)};
    if (entry.type == "period_recorded") {
      fund(page, entry, statement);
    } else if (entry.type == "period_refunded") {
      // The event occurs at the refund time (§3.4), which its period states.
      refund(entry, entry.period->refundedAt.value_or(entry.occurredAt), statement);
    } else if (entry.type == "period_refund_reversed") {
      if (refund(entry, std::nullopt, statement) == AiBudgetCode::NotFound) fund(page, entry, statement);
    }
  }
}

// One grant over the period, its reference the period's own id, for the account the entry names, while the backend holds
// it.
void PeriodFunding::fund(const PageTxn& page, const FeedEntry& entry, const AiBudgetStatement& statement) {
  const Period& period = *entry.period;
  if (!entry.accountId || !paidFor(period)) return;
  if (!page.accountStands(*entry.accountId)) {
    WriteObservation observation{"subscription.fund", "platform", "background", freshWriteRequestId()};
    observation.finish("no_account");
    return;
  }
  observe("subscription.fund", entry, [&] {
    return budgets_.fund(AiBudgetGrant{period.id, entry.accountId->str(), AiBudgetFundingSource::Subscription,
                                       {period.start, period.end}, periodNanos_, period.id, std::nullopt, statement});
  });
}

AiBudgetCode PeriodFunding::refund(const FeedEntry& entry, std::optional<long long> refundedAtMs,
                                   const AiBudgetStatement& statement) {
  return observe("subscription.refund", entry,
                 [&] { return budgets_.refund(entry.period->id, refundedAtMs, statement); });
}

AiBudgetCode PeriodFunding::observe(const std::string& operation, const FeedEntry& entry,
                                    const std::function<AiBudgetGrantResult()>& call) {
  const std::string requestId = freshWriteRequestId();
  WriteObservation observation{operation, "platform", "background", requestId};
  WriteContext context{observation};
  AiBudgetCode code = AiBudgetCode::Invalid;
  try {
    code = call().code;
  } catch (const std::exception& error) {
    observation.fail(error);
    throw;
  } catch (...) {
    observation.failUnknown();
    throw;
  }
  switch (code) {
    case AiBudgetCode::Ok: observation.finish("ok"); return code;
    case AiBudgetCode::Replay: observation.finish("replay"); return code;
    case AiBudgetCode::NotFound: observation.finish("unchanged"); return code;
    case AiBudgetCode::Conflict:
      observation.finish("conflict");
      reportWriteWarning(operation, "platform", "background", "conflict", requestId, {{"event", entry.type}});
      return code;
    default: {
      const std::runtime_error refused{"the AI ledger refused a period of the subscription feed"};
      observation.fail(refused, std::string(aiBudgetCodeName(code)));
      throw refused;
    }
  }
}

}
