#include "platform/domain/AiBudget.h"

#include <algorithm>
#include <chrono>
#include <limits>
#include <stdexcept>

namespace wm {

std::string_view aiBudgetTierName(AiBudgetTier tier) {
  switch (tier) {
    case AiBudgetTier::Anonymous: return "anonymous";
    case AiBudgetTier::LoggedIn: return "logged_in";
    case AiBudgetTier::WindmillOne: return "windmill_one";
  }
  return "invalid";
}

std::string_view aiBudgetCodeName(AiBudgetCode code) {
  switch (code) {
    case AiBudgetCode::Ok: return "ok";
    case AiBudgetCode::Replay: return "replay";
    case AiBudgetCode::Invalid: return "invalid";
    case AiBudgetCode::Unconfigured: return "unconfigured";
    case AiBudgetCode::SubjectExhausted: return "subject_exhausted";
    case AiBudgetCode::DebtOutstanding: return "debt_outstanding";
    case AiBudgetCode::Conflict: return "conflict";
    case AiBudgetCode::NotFound: return "not_found";
    case AiBudgetCode::AlreadyDispatched: return "already_dispatched";
    case AiBudgetCode::InvalidState: return "invalid_state";
    case AiBudgetCode::AccountingOverflow: return "accounting_overflow";
    case AiBudgetCode::FreeMonthExhausted: return "free_month_exhausted";
    case AiBudgetCode::FreeDayExhausted: return "free_day_exhausted";
    case AiBudgetCode::ConcurrencyExhausted: return "concurrency_exhausted";
    case AiBudgetCode::DeviceBound: return "device_bound";
    case AiBudgetCode::FundingRequired: return "funding_required";
  }
  return "invalid";
}

std::string_view aiBudgetWindowName(AiBudgetWindow window) {
  switch (window) {
    case AiBudgetWindow::Lifetime: return "lifetime";
    case AiBudgetWindow::CalendarMonth: return "calendar_month_utc";
    case AiBudgetWindow::BillingPeriod: return "billing_period";
  }
  return "invalid";
}

std::string_view aiBudgetScopeName(AiBudgetScope scope) {
  switch (scope) {
    case AiBudgetScope::FreeMonth: return "free_month";
    case AiBudgetScope::FreeDay: return "free_day";
    case AiBudgetScope::AnonymousLifetime: return "anonymous_lifetime";
    case AiBudgetScope::AccountMonth: return "account_month";
    case AiBudgetScope::FundedPeriod: return "funded_period";
  }
  return "invalid";
}

std::string_view aiBudgetFundingSourceName(AiBudgetFundingSource source) {
  switch (source) {
    case AiBudgetFundingSource::Subscription: return "subscription";
    case AiBudgetFundingSource::Owner: return "owner";
  }
  return "invalid";
}

std::optional<long long> parseAiUsd(std::string_view usd) {
  if (usd.empty()) return std::nullopt;
  const std::size_t dot = usd.find('.');
  const std::string_view dollars = usd.substr(0, dot);
  const std::string_view fraction = dot == std::string_view::npos ? std::string_view{} : usd.substr(dot + 1);
  if (dollars.empty() || (dollars.size() > 1 && dollars.front() == '0')) return std::nullopt;
  if (dot != std::string_view::npos && (fraction.empty() || fraction.size() > 9)) return std::nullopt;

  long long nanos = 0;
  for (const std::string_view digits : {dollars, fraction}) {
    for (const char digit : digits) {
      if (digit < '0' || digit > '9') return std::nullopt;
      if (nanos > (std::numeric_limits<long long>::max() - (digit - '0')) / 10) return std::nullopt;
      nanos = nanos * 10 + (digit - '0');
    }
  }
  for (std::size_t position = fraction.size(); position < 9; ++position) {
    if (nanos > std::numeric_limits<long long>::max() / 10) return std::nullopt;
    nanos *= 10;
  }
  return nanos;
}

std::string formatAiUsd(long long nanos) {
  if (nanos < 0) throw std::invalid_argument("negative_ai_usd");
  const long long dollars = nanos / 1'000'000'000;
  const std::string fraction = std::to_string(nanos % 1'000'000'000);
  return std::to_string(dollars) + "." + std::string(9 - fraction.size(), '0') + fraction;
}

std::optional<AiBudgetPeriod> AiBudgetPeriod::at(long long nowMs) {
  if (nowMs < 0 || nowMs > 253'402'300'799'999LL) return std::nullopt;
  using namespace std::chrono;
  const year_month_day date{floor<days>(sys_time<milliseconds>{milliseconds{nowMs}})};
  const year_month_day first{date.year(), date.month(), day{1}};
  const year_month_day next = first + months{1};
  return AiBudgetPeriod{
      duration_cast<milliseconds>(sys_days{first}.time_since_epoch()).count(),
      duration_cast<milliseconds>(sys_days{next}.time_since_epoch()).count()};
}

std::optional<AiBudgetPeriod> AiBudgetPeriod::dayAt(long long nowMs) {
  if (!at(nowMs)) return std::nullopt;
  constexpr long long dayMs = 86'400'000;
  const long long start = nowMs - nowMs % dayMs;
  return AiBudgetPeriod{start, start + dayMs};
}

AiBudgetPeriod AiBudgetPeriod::lifetime() { return {}; }

bool AiBudgetPeriod::contains(long long atMs) const {
  if (!at(atMs)) return false;
  if (*this == lifetime()) return true;
  return startMs >= 0 && endMs > startMs && atMs >= startMs && atMs < endMs && at(endMs - 1).has_value();
}

bool AiBudgetLimits::valid() const {
  return anonymousLifetimeNanos >= 0 && loggedInMonthlyNanos >= 0 && paidPeriodNanos > 0 &&
         freeMonthlyNanos >= 0 && freeDailyNanos >= 0 && freeConcurrency > 0 && paidConcurrency > 0;
}

bool AiBudgetBalance::valid() const {
  return spentNanos >= 0 && heldNanos >= 0 && debtNanos >= 0;
}

long long AiBudgetBalance::remainingNanos(long long limitNanos) const {
  if (!valid() || limitNanos <= spentNanos) return 0;
  const long long afterSpend = limitNanos - spentNanos;
  if (afterSpend <= heldNanos) return 0;
  return afterSpend - heldNanos;
}

bool validAiBudgetId(std::string_view id) {
  return !id.empty() && id.size() <= 128 && std::all_of(id.begin(), id.end(), [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
           c == '-' || c == '_' || c == ':' || c == '.';
  });
}

bool validAiBudgetSubject(const AiBudgetSubject& subject, AiBudgetTier tier) {
  if (!validAiBudgetId(subject.id)) return false;
  if (tier == AiBudgetTier::Anonymous) return subject.kind == AiBudgetSubjectKind::Device;
  if (tier == AiBudgetTier::LoggedIn || tier == AiBudgetTier::WindmillOne)
    return subject.kind == AiBudgetSubjectKind::Account;
  return false;
}

bool AiBudgetPrincipal::valid() const {
  return validAiBudgetSubject(subject, tier) && (!owner || tier == AiBudgetTier::WindmillOne);
}

bool AiBudgetGrant::valid() const {
  if (!validAiBudgetId(id) || !validAiBudgetId(accountId) || !validAiBudgetId(fundingReference) || amountNanos <= 0)
    return false;
  if (period.endMs <= period.startMs || !period.contains(period.startMs)) return false;
  if (source == AiBudgetFundingSource::Subscription) return true;
  return source == AiBudgetFundingSource::Owner && AiBudgetPeriod::at(period.startMs) == period;
}

bool AiOutputBudget::valid() const {
  return inputNanos >= 0 && outputTokenNanos > 0 && minTokens > 0 && maxTokens >= minTokens &&
      outputTokenNanos <= (std::numeric_limits<long long>::max() - inputNanos) / maxTokens;
}

long long AiOutputBudget::costNanos(int tokens) const {
  if (!valid() || tokens < minTokens || tokens > maxTokens) return 0;
  return inputNanos + tokens * outputTokenNanos;
}

std::optional<int> AiOutputBudget::tokensFor(long long amountNanos) const {
  if (!valid() || amountNanos < inputNanos) return std::nullopt;
  const auto outputNanos = amountNanos - inputNanos;
  const auto tokens = outputNanos / outputTokenNanos;
  if (outputNanos % outputTokenNanos || tokens < minTokens || tokens > maxTokens) return std::nullopt;
  return static_cast<int>(tokens);
}

bool AiBudgetRequest::valid() const {
  return validAiBudgetId(id) && principal.valid() && amountNanos > 0 && AiBudgetPeriod::at(atMs).has_value() &&
      (!outputBudget || (outputBudget->valid() && amountNanos == outputBudget->costNanos(outputBudget->maxTokens)));
}

bool AiBudgetReservation::valid() const {
  if (!validAiBudgetId(id) || !validAiBudgetSubject(subject, tier) || amountNanos <= 0) return false;
  if (outputBudget && !outputBudget->tokensFor(amountNanos)) return false;
  if (!period.contains(admittedAtMs)) return false;
  if (tier == AiBudgetTier::Anonymous && (period != AiBudgetPeriod::lifetime() || grantId)) return false;
  if (tier == AiBudgetTier::LoggedIn && (AiBudgetPeriod::at(admittedAtMs) != period || grantId)) return false;
  if (tier == AiBudgetTier::WindmillOne && (!grantId || !validAiBudgetId(*grantId) || period == AiBudgetPeriod::lifetime()))
    return false;
  switch (state) {
    case AiBudgetState::Reserved:
    case AiBudgetState::Dispatched:
    case AiBudgetState::Uncertain:
    case AiBudgetState::Released: return !actualNanos && !overrunReconciled;
    case AiBudgetState::Settled:
      return actualNanos && *actualNanos >= 0 && (!overrunReconciled || *actualNanos > amountNanos);
  }
  return false;
}

bool AiBudgetReservation::sameRequest(const AiBudgetRequest& other) const {
  return id == other.id && subject == other.principal.subject && outputBudget == other.outputBudget &&
      (outputBudget ? other.amountNanos == outputBudget->costNanos(outputBudget->maxTokens)
                    : amountNanos == other.amountNanos);
}

AiBudgetCode admitAiBudget(const AiBudgetRequest& request, const AiBudgetLimits& limits,
                          const AiBudgetSnapshot& snapshot) {
  if (!request.valid() || !limits.valid() || !snapshot.subject.valid() || snapshot.concurrentCalls < 0)
    return AiBudgetCode::Invalid;
  const auto tier = request.principal.tier;
  if (tier == AiBudgetTier::Anonymous && snapshot.deviceBound) return AiBudgetCode::DeviceBound;
  if (snapshot.subject.debtNanos) return AiBudgetCode::DebtOutstanding;

  if (tier == AiBudgetTier::WindmillOne) {
    if (!snapshot.grant || !snapshot.grant->valid() ||
        snapshot.grant->accountId != request.principal.subject.id || !snapshot.grant->period.contains(request.atMs))
      return AiBudgetCode::FundingRequired;
    const auto window = snapshot.grant->source == AiBudgetFundingSource::Owner
        ? AiBudgetWindow::CalendarMonth : AiBudgetWindow::BillingPeriod;
    if (snapshot.period != snapshot.grant->period || snapshot.window != window) return AiBudgetCode::Invalid;
    if (snapshot.concurrentCalls >= limits.paidConcurrency) return AiBudgetCode::ConcurrencyExhausted;
    if (request.amountNanos > snapshot.subject.remainingNanos(snapshot.grant->amountNanos))
      return AiBudgetCode::SubjectExhausted;
    return AiBudgetCode::Ok;
  }

  const auto period = tier == AiBudgetTier::Anonymous ? AiBudgetPeriod::lifetime() : *AiBudgetPeriod::at(request.atMs);
  const auto window = tier == AiBudgetTier::Anonymous ? AiBudgetWindow::Lifetime : AiBudgetWindow::CalendarMonth;
  if (snapshot.period != period || snapshot.window != window || snapshot.grant ||
      !snapshot.freeMonth.valid() || !snapshot.freeDay.valid()) return AiBudgetCode::Invalid;
  if (snapshot.freeMonth.debtNanos || snapshot.freeDay.debtNanos) return AiBudgetCode::DebtOutstanding;
  if (snapshot.concurrentCalls >= limits.freeConcurrency) return AiBudgetCode::ConcurrencyExhausted;
  const long long allowance = tier == AiBudgetTier::Anonymous ? limits.anonymousLifetimeNanos : limits.loggedInMonthlyNanos;
  if (request.amountNanos > snapshot.subject.remainingNanos(allowance)) return AiBudgetCode::SubjectExhausted;
  if (request.amountNanos > snapshot.freeMonth.remainingNanos(limits.freeMonthlyNanos)) return AiBudgetCode::FreeMonthExhausted;
  if (request.amountNanos > snapshot.freeDay.remainingNanos(limits.freeDailyNanos)) return AiBudgetCode::FreeDayExhausted;
  return AiBudgetCode::Ok;
}

AiBudgetResult planAiBudget(const AiBudgetRequest& request, const AiBudgetLimits& limits,
                            const AiBudgetSnapshot& snapshot) {
  if (!request.valid()) return {AiBudgetCode::Invalid};
  auto admission = request;
  admission.outputBudget.reset();
  if (request.outputBudget) admission.amountNanos = request.outputBudget->costNanos(request.outputBudget->minTokens);
  const auto code = admitAiBudget(admission, limits, snapshot);
  if (code != AiBudgetCode::Ok) return {code};
  if (request.outputBudget) {
    const auto& offer = *request.outputBudget;
    const auto tier = request.principal.tier;
    const auto allowance = tier == AiBudgetTier::WindmillOne ? snapshot.grant->amountNanos :
        tier == AiBudgetTier::Anonymous ? limits.anonymousLifetimeNanos : limits.loggedInMonthlyNanos;
    auto available = snapshot.subject.remainingNanos(allowance);
    if (tier != AiBudgetTier::WindmillOne)
      available = std::min({available, snapshot.freeMonth.remainingNanos(limits.freeMonthlyNanos),
                            snapshot.freeDay.remainingNanos(limits.freeDailyNanos)});
    const auto tokens = std::min<long long>(offer.maxTokens, (available - offer.inputNanos) / offer.outputTokenNanos);
    admission.amountNanos = offer.costNanos(static_cast<int>(tokens));
  }
  AiBudgetReservation reservation{request.id, request.principal.subject, request.principal.tier,
      snapshot.period, admission.amountNanos, AiBudgetState::Reserved, {}, false, request.atMs,
      snapshot.grant ? std::optional<std::string>{snapshot.grant->id} : std::nullopt, request.outputBudget};
  return {AiBudgetCode::Ok, std::move(reservation)};
}

AiBudgetView aiBudgetView(const AiBudgetPrincipal& principal, long long atMs,
                         const AiBudgetLimits& limits, const AiBudgetSnapshot& snapshot) {
  AiBudgetView view;
  view.tier = principal.tier;
  view.window = snapshot.window;
  const AiBudgetRequest request{"view", principal, 1, atMs};
  view.code = admitAiBudget(request, limits, snapshot);
  if (view.code == AiBudgetCode::Invalid || !request.valid() || !limits.valid()) return view;
  if (view.code == AiBudgetCode::FreeDayExhausted) view.budgetResetsAtMs = AiBudgetPeriod::dayAt(atMs)->endMs;
  if (view.code == AiBudgetCode::FreeMonthExhausted) view.budgetResetsAtMs = AiBudgetPeriod::at(atMs)->endMs;
  if (principal.tier == AiBudgetTier::WindmillOne) {
    if (view.code == AiBudgetCode::FundingRequired || !snapshot.grant) return view;
    view.limitNanos = snapshot.grant->amountNanos;
  } else {
    view.limitNanos = principal.tier == AiBudgetTier::Anonymous ? limits.anonymousLifetimeNanos : limits.loggedInMonthlyNanos;
  }
  view.configured = true;
  if (snapshot.window != AiBudgetWindow::Lifetime) view.resetsAtMs = snapshot.period.endMs;
  if (view.code == AiBudgetCode::SubjectExhausted) view.budgetResetsAtMs = view.resetsAtMs;
  view.usedNanos = snapshot.subject.spentNanos;
  view.heldNanos = snapshot.subject.heldNanos;
  view.remainingNanos = snapshot.subject.remainingNanos(*view.limitNanos);
  return view;
}

std::vector<int> crossedAiBudgetThresholds(const AiBudgetBalance& before, const AiBudgetBalance& after,
                                         long long limitNanos) {
  std::vector<int> crossed;
  if (limitNanos <= 0 || !before.valid() || !after.valid()) return crossed;
  const long long prior = limitNanos - before.remainingNanos(limitNanos);
  const long long current = limitNanos - after.remainingNanos(limitNanos);
  for (const int percent : {50, 80, 95}) {
    const long long threshold = (limitNanos / 100) * percent + ((limitNanos % 100) * percent + 99) / 100;
    if (prior < threshold && current >= threshold) crossed.push_back(percent);
  }
  return crossed;
}

AiBudgetCode transitionAiBudget(AiBudgetReservation& reservation, AiBudgetState target,
                               std::optional<long long> actualNanos) {
  if (!reservation.valid()) return AiBudgetCode::Invalid;
  if (target == AiBudgetState::Settled) {
    if (!actualNanos || *actualNanos < 0) return AiBudgetCode::Invalid;
    if (reservation.state == AiBudgetState::Settled)
      return reservation.actualNanos == actualNanos ? AiBudgetCode::Replay : AiBudgetCode::Conflict;
    if (reservation.state != AiBudgetState::Dispatched && reservation.state != AiBudgetState::Uncertain)
      return AiBudgetCode::InvalidState;
    reservation.state = target;
    reservation.actualNanos = actualNanos;
    return AiBudgetCode::Ok;
  }
  if (actualNanos) return AiBudgetCode::Invalid;
  if (target == AiBudgetState::Dispatched) {
    if (reservation.state == AiBudgetState::Dispatched || reservation.state == AiBudgetState::Uncertain ||
        reservation.state == AiBudgetState::Settled) return AiBudgetCode::AlreadyDispatched;
    if (reservation.state != AiBudgetState::Reserved) return AiBudgetCode::InvalidState;
    reservation.state = target;
    return AiBudgetCode::Ok;
  }
  if (target == AiBudgetState::Uncertain) {
    if (reservation.state == AiBudgetState::Uncertain) return AiBudgetCode::Replay;
    if (reservation.state != AiBudgetState::Dispatched) return AiBudgetCode::InvalidState;
    reservation.state = target;
    return AiBudgetCode::Ok;
  }
  if (target == AiBudgetState::Released) {
    if (reservation.state == AiBudgetState::Released) return AiBudgetCode::Replay;
    if (reservation.state != AiBudgetState::Reserved) return AiBudgetCode::InvalidState;
    reservation.state = target;
    return AiBudgetCode::Ok;
  }
  return AiBudgetCode::InvalidState;
}

AiBudgetCode reconcileAiBudgetOverrun(AiBudgetReservation& reservation) {
  if (!reservation.valid()) return AiBudgetCode::Invalid;
  if (reservation.state != AiBudgetState::Settled || *reservation.actualNanos <= reservation.amountNanos)
    return AiBudgetCode::InvalidState;
  if (reservation.overrunReconciled) return AiBudgetCode::Replay;
  reservation.overrunReconciled = true;
  return AiBudgetCode::Ok;
}

}
