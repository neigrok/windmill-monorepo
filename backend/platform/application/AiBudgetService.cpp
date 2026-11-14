#include "platform/application/AiBudgetService.h"

#include "platform/application/WriteObservation.h"

#include <trantor/utils/Logger.h>

#include <limits>
#include <map>
#include <stdexcept>
#include <type_traits>
#include <utility>

namespace wm {
namespace {

constexpr int kReleaseBatch = 20;
// A sweep pass lets go of at most 200 holds, so a backlog is worked down a minute at a time and a pass never runs
// past a stopping process's deadline.
constexpr int kSweepBatches = 10;

template<class Run>
auto observeAiBudgetWrite(const std::string& operation, Run&& run, const std::string& door = "ai") {
  WriteObservation observation{operation, "platform", door};
  WriteContext context{observation};
  try {
    auto result = std::forward<Run>(run)();
    if constexpr (std::is_same_v<decltype(result), std::vector<AiBudgetReservation>>) {
      if (result.empty()) observation.skip();
      else observation.finish();
    } else {
      const AiBudgetCode code = [&] {
        if constexpr (std::is_same_v<decltype(result), AiBudgetCode>) return result;
        else if constexpr (std::is_same_v<decltype(result), std::vector<AiBudgetAlert>>) return AiBudgetCode::Ok;
        else return result.code;
      }();
      observation.finish(code == AiBudgetCode::Replay ? "ok" : std::string(aiBudgetCodeName(code)));
    }
    return result;
  } catch (const std::exception& error) {
    observation.fail(error);
    throw;
  } catch (...) {
    observation.failUnknown();
    throw;
  }
}

}

AiBudgetService::AiBudgetService(AiBudgetRepository& repository,
                                 std::function<AiBudgetLimits()> limits,
                                 std::function<long long()> clock)
    : repository_(repository), limits_(std::move(limits)), clock_(std::move(clock)) {
  if (!limits_ || !clock_) throw std::invalid_argument("missing_ai_budget_dependency");
}

AiBudgetView AiBudgetService::view(const AiBudgetPrincipal& principal) {
  WriteObservation observation{"ai.budget.view", "platform", "ai"};
  WriteContext context{observation};
  const auto before = observation.writeCount();
  try {
    const long long atMs = clock_();
    const AiBudgetLimits limits = limits_();
    if (!principal.valid() || !AiBudgetPeriod::at(atMs) || !limits.valid()) {
      AiBudgetView result;
      result.tier = principal.tier;
      result.code = AiBudgetCode::Invalid;
      observation.finish("invalid");
      return result;
    }
    releaseLapsed(principal.subject, atMs, "ai", [] { return true; });
    const auto snapshot = repository_.snapshot(principal, atMs, limits);
    const auto result = aiBudgetView(principal, atMs, limits, snapshot);
    if (observation.writeCount() == before) observation.skip();
    else observation.finish();
    return result;
  } catch (const std::exception& error) {
    observation.fail(error);
    throw;
  } catch (...) {
    observation.failUnknown();
    throw;
  }
}

AiBudgetResult AiBudgetService::reserve(const std::string& id, const AiBudgetPrincipal& principal,
                                      long long amountNanos, std::optional<AiOutputBudget> outputBudget,
                                      AiBudgetFunding funding) {
  return observeAiBudgetWrite("ai.budget.reserve", [&] {
    const AiBudgetRequest request{id, principal, amountNanos, clock_(), outputBudget, funding};
    if (!request.valid()) return AiBudgetResult{AiBudgetCode::Invalid};
    releaseLapsed(principal.subject, request.atMs, "ai", [] { return true; });
    return repository_.reserve(request, limits_());
  });
}

AiBudgetResult AiBudgetService::markDispatched(const std::string& id) {
  return observeAiBudgetWrite("ai.budget.dispatch", [&] {
    if (!validAiBudgetId(id)) return AiBudgetResult{AiBudgetCode::Invalid};
    return repository_.markDispatched(id);
  });
}

AiBudgetResult AiBudgetService::markUncertain(const std::string& id) {
  return observeAiBudgetWrite("ai.budget.uncertain", [&] {
    if (!validAiBudgetId(id)) return AiBudgetResult{AiBudgetCode::Invalid};
    return repository_.markUncertain(id);
  });
}

AiBudgetResult AiBudgetService::settle(const std::string& id, long long actualNanos) {
  return observeAiBudgetWrite("ai.budget.settle", [&] {
    if (!validAiBudgetId(id) || actualNanos < 0) return AiBudgetResult{AiBudgetCode::Invalid};
    return repository_.settle(id, actualNanos);
  });
}

AiBudgetResult AiBudgetService::release(const std::string& id) {
  return observeAiBudgetWrite("ai.budget.release", [&] {
    if (!validAiBudgetId(id)) return AiBudgetResult{AiBudgetCode::Invalid};
    return repository_.release(id);
  });
}

int AiBudgetService::releaseLapsed(const std::function<bool()>& stopping) {
  int batches = 0;
  return releaseLapsed(std::nullopt, clock_(), "background",
                       [&] { return batches++ < kSweepBatches && !(stopping && stopping()); });
}

int AiBudgetService::releaseLapsed(const std::optional<AiBudgetSubject>& subject, long long atMs,
                                   const std::string& door, const std::function<bool()>& anotherBatch) {
  struct Left {
    int holds = 0;
    long long nanos = 0;
  };
  std::map<std::string, Left> left{{"reserved", {}}, {"dispatched", {}}, {"uncertain", {}}};
  const std::string requestId = freshWriteRequestId();
  int released = 0;
  while (anotherBatch()) {
    const auto holds = observeAiBudgetWrite("ai.budget.release_lapsed", [&] {
      return repository_.releaseLapsed(atMs, kReleaseBatch, subject);
    }, door);
    for (const auto& hold : holds) {
      const std::string was(aiBudgetStateName(*hold.releasedFrom));
      ++left[was].holds;
      left[was].nanos += hold.amountNanos;
      const long long ageMs = atMs - hold.admittedAtMs;
      LOG_WARN << "ai_hold_released operation=ai.budget.release_lapsed door=" << door << " outcome=" << was
               << " age=" << (ageMs < 3'600'000 ? "under_1h" : ageMs < 86'400'000 ? "under_1d" : "over_1d")
               << " request_id=" << requestId;
    }
    released += static_cast<int>(holds.size());
    if (static_cast<int>(holds.size()) < kReleaseBatch) break;
  }
  if (released == 0) return 0;
  std::string tally = "ai_hold_lapses operation=ai.budget.release_lapsed door=" + door +
      " released=" + std::to_string(released);
  std::map<std::string, std::string> tags;
  for (const auto& [was, count] : left) {
    tally += " " + was + "=" + std::to_string(count.holds) + " " + was + "_nanos=" + std::to_string(count.nanos);
    tags[was] = std::to_string(count.holds);
  }
  LOG_WARN << tally << " request_id=" << requestId;
  reportWriteWarning("ai.budget.release_lapsed", "platform", door, "released", requestId, tags);
  return released;
}

AiBudgetResult AiBudgetService::reconcileOverrun(const std::string& id) {
  return observeAiBudgetWrite("ai.budget.reconcile_overrun", [&] {
    if (!validAiBudgetId(id)) return AiBudgetResult{AiBudgetCode::Invalid};
    return repository_.reconcileOverrun(id);
  });
}

AiBudgetGrantResult AiBudgetService::fund(const AiBudgetGrant& grant) {
  return observeAiBudgetWrite("ai.budget.fund", [&] {
    const auto limits = limits_();
    if (!grant.valid() || !limits.valid()) return AiBudgetGrantResult{AiBudgetCode::Invalid};
    return repository_.fund(grant, limits);
  });
}

AiBudgetGrantResult AiBudgetService::refund(const std::string& fundingReference, std::optional<long long> refundedAtMs) {
  return observeAiBudgetWrite("ai.budget.refund", [&] {
    if (!validAiBudgetId(fundingReference) || (refundedAtMs && !AiBudgetPeriod::at(*refundedAtMs)))
      return AiBudgetGrantResult{AiBudgetCode::Invalid};
    return repository_.refund(fundingReference, refundedAtMs);
  });
}

std::optional<std::string> AiBudgetService::boundAccount(const std::string& deviceId) const {
  return repository_.boundAccount(deviceId);
}

AiBudgetCode AiBudgetService::bindDevice(const std::string& deviceId, const std::string& accountId) {
  return observeAiBudgetWrite("ai.budget.bind_device", [&] {
    const long long atMs = clock_();
    const auto limits = limits_();
    if (!validAiBudgetId(deviceId) || !validAiBudgetId(accountId) || !AiBudgetPeriod::at(atMs) || !limits.valid())
      return AiBudgetCode::Invalid;
    return repository_.bindDevice(deviceId, accountId, atMs, limits);
  });
}

std::vector<AiBudgetAlert> AiBudgetService::claimAlerts(int limit, long long leaseMs) {
  return observeAiBudgetWrite("ai.budget.alert.claim", [&] {
    const long long atMs = clock_();
    if (!AiBudgetPeriod::at(atMs) || limit <= 0 || limit > 100 || leaseMs <= 0 || leaseMs > 3'600'000 ||
        atMs > std::numeric_limits<long long>::max() - leaseMs)
      throw std::invalid_argument("invalid_ai_alert_claim");
    return repository_.claimAlerts(atMs, limit, atMs + leaseMs);
  });
}

AiBudgetCode AiBudgetService::completeAlert(const std::string& id, const std::string& claimToken) {
  return observeAiBudgetWrite("ai.budget.alert.delivered", [&] {
    if (!validAiBudgetId(id) || !validAiBudgetId(claimToken)) return AiBudgetCode::Invalid;
    return repository_.completeAlert(id, claimToken);
  });
}

AiBudgetCode AiBudgetService::retryAlert(const std::string& id, const std::string& claimToken, long long nextAttemptMs) {
  return observeAiBudgetWrite("ai.budget.alert.retry", [&] {
    if (!validAiBudgetId(id) || !validAiBudgetId(claimToken) || !AiBudgetPeriod::at(nextAttemptMs))
      return AiBudgetCode::Invalid;
    return repository_.retryAlert(id, claimToken, nextAttemptMs);
  });
}

}
