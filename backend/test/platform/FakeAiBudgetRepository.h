#pragma once

#include "platform/ports/AiBudgetRepository.h"

#include <map>
#include <stdexcept>

namespace wm::fake {

struct FakeAiBudgetRepository : AiBudgetRepository {
  AiBudgetSnapshot totals;
  std::map<std::string, AiBudgetReservation> reservations;
  std::map<std::string, AiBudgetGrant> grants;
  std::vector<AiBudgetAlert> alerts;
  std::vector<std::string> completedAlerts;
  std::vector<std::string> retriedAlerts;
  int reads = 0;
  bool failRead = false;
  bool failReserve = false;
  bool failSettle = false;
  bool failFund = false;

  AiBudgetSnapshot snapshot(const AiBudgetPrincipal& principal, long long atMs,
                            const AiBudgetLimits& limits) override {
    ++reads;
    if (failRead) throw std::runtime_error("private database detail");
    auto result = totals;
    result.period = principal.tier == AiBudgetTier::Anonymous ? AiBudgetPeriod::lifetime() : *AiBudgetPeriod::at(atMs);
    result.window = principal.tier == AiBudgetTier::Anonymous ? AiBudgetWindow::Lifetime : AiBudgetWindow::CalendarMonth;
    if (principal.tier != AiBudgetTier::WindmillOne) return result;
    result.grant.reset();
    for (const auto& [id, grant] : grants) {
      if (grant.accountId != principal.subject.id || !grant.period.contains(atMs)) continue;
      if (grant.source == AiBudgetFundingSource::Owner && !principal.owner) continue;
      result.grant = grant;
      if (grant.source == AiBudgetFundingSource::Subscription) break;
    }
    if (!result.grant && principal.owner)
      result.grant = AiBudgetGrant{"owner-period", principal.subject.id, AiBudgetFundingSource::Owner,
                                  result.period, limits.paidPeriodNanos, "owner-period"};
    result.window = result.grant && result.grant->source == AiBudgetFundingSource::Owner
        ? AiBudgetWindow::CalendarMonth : AiBudgetWindow::BillingPeriod;
    if (result.grant) result.period = result.grant->period;
    return result;
  }
  AiBudgetResult reserve(const AiBudgetRequest& request, const AiBudgetLimits& limits) override {
    if (failReserve) throw std::runtime_error("private database detail");
    const auto current = snapshot(request.principal, request.atMs, limits);
    const auto code = admitAiBudget(request, limits, current);
    if (code != AiBudgetCode::Ok) return {code, {}};
    AiBudgetReservation reservation{request.id, request.principal.subject, request.principal.tier,
        current.period, request.amountNanos, AiBudgetState::Reserved, {}, false, request.atMs,
        current.grant ? std::optional<std::string>{current.grant->id} : std::nullopt};
    reservations.emplace(request.id, reservation);
    return {AiBudgetCode::Ok, reservation};
  }
  AiBudgetResult change(const std::string& id, AiBudgetState state, std::optional<long long> actual = {}) {
    auto& reservation = reservations.at(id);
    const auto code = transitionAiBudget(reservation, state, actual);
    return {code, reservation};
  }
  AiBudgetResult markDispatched(const std::string& id) override { return change(id, AiBudgetState::Dispatched); }
  AiBudgetResult markUncertain(const std::string& id) override { return change(id, AiBudgetState::Uncertain); }
  AiBudgetResult settle(const std::string& id, long long actual) override {
    if (failSettle) throw std::runtime_error("private account content");
    return change(id, AiBudgetState::Settled, actual);
  }
  AiBudgetResult release(const std::string& id) override { return change(id, AiBudgetState::Released); }
  AiBudgetResult reconcileOverrun(const std::string&) override { return {AiBudgetCode::InvalidState, {}}; }
  AiBudgetGrantResult fund(const AiBudgetGrant& grant, const AiBudgetLimits&) override {
    if (failFund) throw std::runtime_error("private billing content");
    const auto [row, inserted] = grants.emplace(grant.id, grant);
    if (inserted) return {AiBudgetCode::Ok, grant};
    return {row->second == grant ? AiBudgetCode::Replay : AiBudgetCode::Conflict, row->second};
  }
  AiBudgetCode bindDevice(const std::string&, const std::string&, long long, const AiBudgetLimits&) override {
    return AiBudgetCode::Ok;
  }
  std::vector<AiBudgetAlert> claimAlerts(long long, int, long long) override { return alerts; }
  AiBudgetCode completeAlert(const std::string& id, const std::string&) override {
    completedAlerts.push_back(id);
    return AiBudgetCode::Ok;
  }
  AiBudgetCode retryAlert(const std::string& id, const std::string&, long long) override {
    retriedAlerts.push_back(id);
    return AiBudgetCode::Ok;
  }
};

}
