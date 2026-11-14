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
// Which allowances may fund a call: any its principal draws on, or only a funded Windmill One grant, for a call that must
// never draw on the free pools.
enum class AiBudgetFunding { AnyAllowance, GrantOnly };
enum class AiBudgetScope { FreeMonth, FreeDay, AnonymousLifetime, AccountMonth, FundedPeriod };
enum class AiBudgetCode {
  Ok, Replay, Invalid, Unconfigured, SubjectExhausted,
  DebtOutstanding, Conflict, NotFound, AlreadyDispatched, InvalidState, AccountingOverflow,
  FreeMonthExhausted, FreeDayExhausted, ConcurrencyExhausted, DeviceBound, FundingRequired
};

// How long a hold may wait for its cost. Every vendor call this server makes ends well inside it, so a hold still
// unresolved this long after admission is one whose outcome is never coming.
constexpr long long kAiBudgetHoldLifetimeMs = 10 * 60 * 1000;

std::string_view aiBudgetTierName(AiBudgetTier tier);
std::string_view aiBudgetStateName(AiBudgetState state);
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
  long long anonymousLifetimeNanos = 250'000'000;
  long long loggedInMonthlyNanos = 500'000'000;
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
  std::optional<long long> closedAtMs;  // a store's refund: the subscription grant funds nothing from then on
  bool valid() const;
  bool inForceAt(long long atMs) const;
  // Both hold an instant, each holding its period up to its close: one account and source never funds an instant twice.
  bool overlaps(const AiBudgetGrant& other) const;
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

  // The allowance `principal` draws on at `atMs`: Windmill One's while this holds its grant in force, else the free
  // allowance of its kind, the signed-in one for an account (subscriptions.md §6.3).
  AiBudgetTier tierFor(const AiBudgetPrincipal& principal, long long atMs) const;
};

struct AiOutputBudget {
  long long inputNanos = 0;
  long long outputTokenNanos = 0;
  int minTokens = 0;
  int maxTokens = 0;
  bool valid() const;
  long long costNanos(int tokens) const;
  std::optional<int> tokensFor(long long amountNanos) const;
  bool operator==(const AiOutputBudget&) const = default;
};

struct AiBudgetRequest {
  std::string id;
  AiBudgetPrincipal principal;
  long long amountNanos = 0;
  long long atMs = 0;
  std::optional<AiOutputBudget> outputBudget;
  AiBudgetFunding funding = AiBudgetFunding::AnyAllowance;
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
  std::optional<AiOutputBudget> outputBudget;
  std::optional<AiBudgetState> releasedFrom;

  bool valid() const;
  bool sameRequest(const AiBudgetRequest& other) const;
  // Its cost is not known yet, so it holds one of its principal's concurrency slots.
  bool unresolved() const;
  bool lapsedAt(long long atMs) const;
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
AiBudgetResult planAiBudget(const AiBudgetRequest& request, const AiBudgetLimits& limits,
                            const AiBudgetSnapshot& snapshot);
// The moment the budget a refusal names returns, never another budget's: a shared free pool at the
// end of its UTC day or month, and the subject's own allowance when its period ends, which a lifetime
// allowance never does. Every other code names no moment.
std::optional<long long> aiBudgetReturnsAt(std::string_view code, std::optional<long long> subjectResetsAtMs, long long atMs);
AiBudgetView aiBudgetView(const AiBudgetPrincipal& principal, long long atMs,
                         const AiBudgetLimits& limits, const AiBudgetSnapshot& snapshot);
std::vector<int> crossedAiBudgetThresholds(const AiBudgetBalance& before, const AiBudgetBalance& after,
                                         long long limitNanos);
AiBudgetCode transitionAiBudget(AiBudgetReservation& reservation, AiBudgetState target,
                               std::optional<long long> actualNanos = std::nullopt);
// Lets go of a hold that lapsed: nothing is charged, its slot frees, and the record keeps its amount and the state it
// left. Windmill absorbs whatever the vendor billed for it.
AiBudgetCode releaseLapsedAiBudget(AiBudgetReservation& reservation, long long atMs);
AiBudgetCode reconcileAiBudgetOverrun(AiBudgetReservation& reservation);
// `grant` beside `held`, the grants sharing its id, its source and reference, or its account and source: Replay with the
// stored grant when one is this funding, whatever its close; Conflict when one is another or holds an instant it would.
AiBudgetGrantResult fundAiBudgetGrant(const AiBudgetGrant& grant, const std::vector<AiBudgetGrant>& held);
// A refund closes a subscription grant at min(end, refundedAt) and its reversal, none, reopens it; spent capacity stays
// spent. A change that holds an instant more must overlap none of `held`, or answers Conflict and changes nothing.
AiBudgetCode refundAiBudgetGrant(AiBudgetGrant& grant, std::optional<long long> refundedAtMs,
                                const std::vector<AiBudgetGrant>& held);

}
