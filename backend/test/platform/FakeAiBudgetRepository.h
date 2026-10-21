#pragma once

#include "platform/ports/AiBudgetRepository.h"

#include <map>
#include <stdexcept>

namespace wm::fake {

struct FakeAiBudgetRepository : AiBudgetRepository {
  AiBudgetSnapshot totals;
  std::map<std::string, std::string> bindings;
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
    if (principal.subject.kind == AiBudgetSubjectKind::Device && bindings.count(principal.subject.id)) result.deviceBound = true;
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
    if (!request.valid()) return {AiBudgetCode::Invalid};
    if (const auto prior = reservations.find(request.id); prior != reservations.end())
      return prior->second.sameRequest(request) ? AiBudgetResult{AiBudgetCode::Replay, prior->second}
                                               : AiBudgetResult{AiBudgetCode::Conflict};
    const auto current = snapshot(request.principal, request.atMs, limits);
    auto plan = planAiBudget(request, limits, current);
    if (plan.reservation) reservations.emplace(request.id, *plan.reservation);
    return plan;
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
  std::optional<std::string> boundAccount(const std::string& device) override {
    if (failRead) throw std::runtime_error("private database detail");
    const auto row = bindings.find(device);
    if (row == bindings.end()) return std::nullopt;
    return row->second;
  }
  AiBudgetCode bindDevice(const std::string& device, const std::string& account, long long, const AiBudgetLimits&) override {
    const auto [row, inserted] = bindings.emplace(device, account);
    if (inserted) return AiBudgetCode::Ok;
    return row->second == account ? AiBudgetCode::Replay : AiBudgetCode::Conflict;
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
