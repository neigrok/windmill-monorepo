#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace wm {

enum class AiBudgetTier { Anonymous, LoggedIn, WindmillOne };
enum class AiBudgetSubjectKind { Device, Account };
enum class AiBudgetState { Reserved, Dispatched, Uncertain, Settled, Released };
enum class AiBudgetWindow { Lifetime, CalendarMonth, BillingPeriod };
enum class AiBudgetFundingSource { Subscription, Owner };
enum class AiBudgetScope { FreeMonth, FreeDay, AnonymousLifetime, AccountMonth, FundedPeriod };
enum class AiBudgetCode {
  Ok, Replay, Invalid, Unconfigured, SubjectExhausted,
  DebtOutstanding, Conflict, NotFound, AlreadyDispatched, InvalidState, AccountingOverflow,
  FreeMonthExhausted, FreeDayExhausted, ConcurrencyExhausted, DeviceBound, FundingRequired
};

std::string_view aiBudgetTierName(AiBudgetTier tier);
std::string_view aiBudgetCodeName(AiBudgetCode code);
std::string_view aiBudgetWindowName(AiBudgetWindow window);
std::string_view aiBudgetScopeName(AiBudgetScope scope);
std::string_view aiBudgetFundingSourceName(AiBudgetFundingSource source);
std::optional<long long> parseAiUsd(std::string_view usd);
std::string formatAiUsd(long long nanos);

struct AiBudgetSubject {
  AiBudgetSubjectKind kind = AiBudgetSubjectKind::Account;
  std::string id;
  bool operator==(const AiBudgetSubject&) const = default;
};

struct AiBudgetPrincipal {
  AiBudgetSubject subject;
  AiBudgetTier tier = AiBudgetTier::LoggedIn;
  bool owner = false;
  bool valid() const;
};

struct AiBudgetPeriod {
  long long startMs = 0;
  long long endMs = 0;
  bool operator==(const AiBudgetPeriod&) const = default;
  bool contains(long long atMs) const;
  static std::optional<AiBudgetPeriod> at(long long nowMs);
  static std::optional<AiBudgetPeriod> dayAt(long long nowMs);
  static AiBudgetPeriod lifetime();
};

struct AiBudgetLimits {
  long long anonymousLifetimeNanos = 50'000'000;
  long long loggedInMonthlyNanos = 250'000'000;
  long long paidPeriodNanos = 7'000'000'000;
  long long freeMonthlyNanos = 100'000'000'000;
  long long freeDailyNanos = 5'000'000'000;
  int freeConcurrency = 1;
  int paidConcurrency = 2;
  bool valid() const;
};

struct AiBudgetBalance {
  long long spentNanos = 0;
  long long heldNanos = 0;  // Unresolved reservations survive their original period.
  long long debtNanos = 0;
  bool valid() const;
  long long remainingNanos(long long limitNanos) const;
};

struct AiBudgetGrant {
  std::string id;
  std::string accountId;
  AiBudgetFundingSource source = AiBudgetFundingSource::Subscription;
  AiBudgetPeriod period;
  long long amountNanos = 0;
  std::string fundingReference;
  bool valid() const;
  bool operator==(const AiBudgetGrant&) const = default;
};

struct AiBudgetSnapshot {
  AiBudgetBalance freeMonth;
  AiBudgetBalance freeDay;
  AiBudgetBalance subject;
  AiBudgetPeriod period;
  AiBudgetWindow window = AiBudgetWindow::CalendarMonth;
  std::optional<AiBudgetGrant> grant;
  int concurrentCalls = 0;
  bool deviceBound = false;
};

struct AiBudgetRequest {
  std::string id;
  AiBudgetPrincipal principal;
  long long amountNanos = 0;
  long long atMs = 0;
  bool valid() const;
};

struct AiBudgetReservation {
  std::string id;
  AiBudgetSubject subject;
  AiBudgetTier tier = AiBudgetTier::LoggedIn;
  AiBudgetPeriod period;
  long long amountNanos = 0;
  AiBudgetState state = AiBudgetState::Reserved;
  std::optional<long long> actualNanos;
  bool overrunReconciled = false;
  long long admittedAtMs = 0;
  std::optional<std::string> grantId;

  bool valid() const;
  bool sameRequest(const AiBudgetRequest& other) const;
};

struct AiBudgetResult {
  AiBudgetCode code = AiBudgetCode::Invalid;
  std::optional<AiBudgetReservation> reservation;
};

struct AiBudgetGrantResult {
  AiBudgetCode code = AiBudgetCode::Invalid;
  std::optional<AiBudgetGrant> grant;
};

struct AiBudgetView {
  AiBudgetTier tier = AiBudgetTier::LoggedIn;
  bool configured = false;
  std::optional<long long> limitNanos;
  long long usedNanos = 0;
  long long heldNanos = 0;
  long long remainingNanos = 0;
  std::optional<long long> resetsAtMs;
  AiBudgetCode code = AiBudgetCode::Unconfigured;
  AiBudgetWindow window = AiBudgetWindow::CalendarMonth;
  std::optional<long long> budgetResetsAtMs;
  bool operator==(const AiBudgetView&) const = default;
};

struct AiBudgetAlert {
  std::string id;
  AiBudgetScope scope = AiBudgetScope::FreeMonth;
  AiBudgetPeriod period;
  int thresholdPercent = 0;
  long long limitNanos = 0;
  long long spentNanos = 0;
  long long heldNanos = 0;
  std::string claimToken;
  long long leaseUntilMs = 0;
  std::optional<AiBudgetFundingSource> fundingSource;
};

bool validAiBudgetId(std::string_view id);
bool validAiBudgetSubject(const AiBudgetSubject& subject, AiBudgetTier tier);
AiBudgetCode admitAiBudget(const AiBudgetRequest& request, const AiBudgetLimits& limits,
                          const AiBudgetSnapshot& snapshot);
AiBudgetView aiBudgetView(const AiBudgetPrincipal& principal, long long atMs,
                         const AiBudgetLimits& limits, const AiBudgetSnapshot& snapshot);
std::vector<int> crossedAiBudgetThresholds(const AiBudgetBalance& before, const AiBudgetBalance& after,
                                         long long limitNanos);
AiBudgetCode transitionAiBudget(AiBudgetReservation& reservation, AiBudgetState target,
                               std::optional<long long> actualNanos = std::nullopt);
AiBudgetCode reconcileAiBudgetOverrun(AiBudgetReservation& reservation);

}
