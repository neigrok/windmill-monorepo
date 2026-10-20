#include "platform/adapters/postgres/PgAiBudgetRepository.h"

#include "platform/application/WriteObservation.h"

#include <algorithm>
#include <array>
#include <stdexcept>
#include <utility>

namespace wm {
namespace {

struct Budget {
  AiBudgetScope scope;
  std::string key;
  AiBudgetPeriod period;
  long long limit = 0;
};

struct AccountTotals {
  AiBudgetBalance free;
  int concurrent = 0;
};

void lockBudget(pqxx::work& txn) {
  txn.exec("SELECT pg_advisory_xact_lock(1464681031, 1)");
}

std::string subjectKind(AiBudgetSubjectKind kind) {
  if (kind == AiBudgetSubjectKind::Device) return "device";
  if (kind == AiBudgetSubjectKind::Account) return "account";
  throw std::invalid_argument("Invalid AI budget subject kind");
}

template<class Row>
AiBudgetGrant grantFrom(const Row& row) {
  AiBudgetGrant grant;
  grant.id = row[0].template as<std::string>();
  grant.accountId = row[1].template as<std::string>();
  const auto source = row[2].template as<std::string>();
  if (source != "subscription" && source != "owner") throw std::runtime_error("Invalid stored AI funding source");
  grant.source = source == "owner" ? AiBudgetFundingSource::Owner : AiBudgetFundingSource::Subscription;
  grant.period = {row[3].template as<long long>(), row[4].template as<long long>()};
  grant.amountNanos = row[5].template as<long long>();
  grant.fundingReference = row[6].template as<std::string>();
  if (!grant.valid()) throw std::runtime_error("Invalid stored AI grant");
  return grant;
}

void ensureBudget(pqxx::work& txn, const Budget& budget) {
  txn.exec("INSERT INTO ai_budget_balances (scope, subject_key, period_start_ms, period_end_ms, limit_nanos) "
           "VALUES ($1, $2, $3, $4, $5) ON CONFLICT (scope, subject_key, period_start_ms) "
           "DO UPDATE SET limit_nanos = excluded.limit_nanos",
           pqxx::params{std::string(aiBudgetScopeName(budget.scope)), budget.key, budget.period.startMs,
                        budget.period.endMs, budget.limit});
}

void insertGrant(pqxx::work& txn, const AiBudgetGrant& grant) {
  txn.exec("INSERT INTO ai_budget_grants "
           "(id, account_id, source, period_start_ms, period_end_ms, amount_nanos, funding_reference) "
           "VALUES ($1, $2, $3, $4, $5, $6, $7)",
           pqxx::params{grant.id, grant.accountId, std::string(aiBudgetFundingSourceName(grant.source)),
                        grant.period.startMs, grant.period.endMs, grant.amountNanos, grant.fundingReference});
  ensureBudget(txn, {AiBudgetScope::FundedPeriod, grant.id, grant.period, grant.amountNanos});
}

std::optional<AiBudgetReservation> readReservation(pqxx::work& txn, const std::string& id) {
  const pqxx::result rows = txn.exec(
      "SELECT subject_kind, subject_id, tier, period_start_ms, period_end_ms, amount_nanos, "
      "state, actual_nanos, overrun_reconciled, admitted_at_ms, grant_id, "
      "input_cost_nanos, output_token_cost_nanos, min_output_tokens, max_output_tokens "
      "FROM ai_budget_reservations WHERE id = $1", pqxx::params{id});
  if (rows.empty()) return std::nullopt;
  AiBudgetReservation reservation;
  reservation.id = id;
  const auto kind = rows[0][0].as<std::string>();
  if (kind != "device" && kind != "account") throw std::runtime_error("Invalid stored AI budget subject");
  reservation.subject = {kind == "device" ? AiBudgetSubjectKind::Device : AiBudgetSubjectKind::Account,
                         rows[0][1].as<std::string>()};
  const std::array<std::string, 3> tiers{"anonymous", "logged_in", "windmill_one"};
  const auto tier = std::find(tiers.begin(), tiers.end(), rows[0][2].as<std::string>());
  if (tier == tiers.end()) throw std::runtime_error("Invalid stored AI budget tier");
  reservation.tier = static_cast<AiBudgetTier>(tier - tiers.begin());
  reservation.period = {rows[0][3].as<long long>(), rows[0][4].as<long long>()};
  reservation.amountNanos = rows[0][5].as<long long>();
  const std::array<std::string, 5> states{"reserved", "dispatched", "uncertain", "settled", "released"};
  const auto state = std::find(states.begin(), states.end(), rows[0][6].as<std::string>());
  if (state == states.end()) throw std::runtime_error("Invalid stored AI budget state");
  reservation.state = static_cast<AiBudgetState>(state - states.begin());
  if (!rows[0][7].is_null()) reservation.actualNanos = rows[0][7].as<long long>();
  reservation.overrunReconciled = rows[0][8].as<bool>();
  reservation.admittedAtMs = rows[0][9].as<long long>();
  if (!rows[0][10].is_null()) reservation.grantId = rows[0][10].as<std::string>();
  if (!rows[0][11].is_null()) reservation.outputBudget = AiOutputBudget{
      rows[0][11].as<long long>(), rows[0][12].as<long long>(), rows[0][13].as<int>(), rows[0][14].as<int>()};
  if (!reservation.valid()) throw std::runtime_error("Invalid stored AI budget reservation");
  return reservation;
}

AiBudgetBalance readBalance(pqxx::work& txn, const Budget& budget) {
  const pqxx::result rows = txn.exec(
      "SELECT least(coalesce(sum(spent_nanos) FILTER (WHERE period_start_ms = $3), 0), "
      "9223372036854775807)::bigint, least(coalesce(sum(held_nanos), 0), "
      "9223372036854775807)::bigint, least(coalesce(sum(debt_nanos), 0), "
      "9223372036854775807)::bigint FROM ai_budget_balances WHERE scope = $1 AND subject_key = $2",
      pqxx::params{std::string(aiBudgetScopeName(budget.scope)), budget.key, budget.period.startMs});
  return {rows[0][0].as<long long>(), rows[0][1].as<long long>(), rows[0][2].as<long long>()};
}

AccountTotals accountTotals(pqxx::work& txn, const std::string& account, const AiBudgetPeriod& period) {
  const pqxx::result rows = txn.exec(
      "SELECT least(coalesce(sum(r.actual_nanos) FILTER (WHERE r.tier <> 'windmill_one' "
      "AND r.admitted_at_ms >= $2 AND r.admitted_at_ms < $3), 0), 9223372036854775807)::bigint, "
      "least(coalesce(sum(r.amount_nanos) FILTER (WHERE r.tier <> 'windmill_one' "
      "AND r.state IN ('reserved', 'dispatched', 'uncertain')), 0), 9223372036854775807)::bigint, "
      "least(coalesce(sum(greatest(r.actual_nanos - r.amount_nanos, 0)) "
      "FILTER (WHERE NOT r.overrun_reconciled), 0), 9223372036854775807)::bigint, "
      "least(count(*) FILTER (WHERE r.state IN ('reserved', 'dispatched', 'uncertain')), 2147483647)::int "
      "FROM ai_budget_reservations r LEFT JOIN ai_budget_device_accounts d "
      "ON r.subject_kind = 'device' AND r.subject_id = d.device_id "
      "WHERE (r.subject_kind = 'account' AND r.subject_id = $1) OR d.account_id = $1",
      pqxx::params{account, period.startMs, period.endMs});
  return {{rows[0][0].as<long long>(), rows[0][1].as<long long>(), rows[0][2].as<long long>()},
          rows[0][3].as<int>()};
}

AiBudgetSnapshot readSnapshot(pqxx::work& txn, const AiBudgetPrincipal& principal, long long atMs,
                              const AiBudgetLimits& limits, bool& wrote) {
  AiBudgetSnapshot snapshot;
  const auto month = *AiBudgetPeriod::at(atMs);
  if (principal.tier == AiBudgetTier::WindmillOne) {
    snapshot.window = AiBudgetWindow::BillingPeriod;
    snapshot.period = month;
    const pqxx::result grants = txn.exec(
        "SELECT id, account_id, source, period_start_ms, period_end_ms, amount_nanos, funding_reference "
        "FROM ai_budget_grants WHERE account_id = $1 AND period_start_ms <= $2 AND period_end_ms > $2 "
        "AND (source = 'subscription' OR $3) "
        "ORDER BY CASE source WHEN 'subscription' THEN 0 ELSE 1 END",
        pqxx::params{principal.subject.id, atMs, principal.owner});
    if (grants.size() > 2 || (grants.size() == 2 && grants[0][2].as<std::string>() == grants[1][2].as<std::string>()))
      throw std::runtime_error("Overlapping AI grants from one source");
    if (!grants.empty()) snapshot.grant = grantFrom(grants[0]);
    if (!snapshot.grant && principal.owner) {
      const pqxx::result overlap = txn.exec(
          "SELECT 1 FROM ai_budget_grants WHERE account_id = $1 AND source = 'owner' "
          "AND period_start_ms < $3 AND period_end_ms > $2",
          pqxx::params{principal.subject.id, month.startMs, month.endMs});
      if (overlap.empty()) {
        const auto id = txn.exec("SELECT gen_random_uuid()::text")[0][0].as<std::string>();
        snapshot.grant = AiBudgetGrant{id, principal.subject.id, AiBudgetFundingSource::Owner,
                                      month, limits.paidPeriodNanos, "owner:" + id};
        insertGrant(txn, *snapshot.grant);
        wrote = true;
      }
    }
    const auto totals = accountTotals(txn, principal.subject.id, month);
    snapshot.concurrentCalls = totals.concurrent;
    if (snapshot.grant) {
      snapshot.period = snapshot.grant->period;
      snapshot.window = snapshot.grant->source == AiBudgetFundingSource::Owner
                            ? AiBudgetWindow::CalendarMonth : AiBudgetWindow::BillingPeriod;
      snapshot.subject = readBalance(txn, {AiBudgetScope::FundedPeriod, snapshot.grant->id, snapshot.period});
    }
    snapshot.subject.debtNanos = totals.free.debtNanos;
    return snapshot;
  }
  snapshot.freeMonth = readBalance(txn, {AiBudgetScope::FreeMonth, "all", month});
  snapshot.freeDay = readBalance(txn, {AiBudgetScope::FreeDay, "all", *AiBudgetPeriod::dayAt(atMs)});
  if (principal.tier == AiBudgetTier::LoggedIn) {
    snapshot.period = month;
    const auto totals = accountTotals(txn, principal.subject.id, month);
    snapshot.subject = totals.free;
    snapshot.concurrentCalls = totals.concurrent;
    return snapshot;
  }
  snapshot.period = AiBudgetPeriod::lifetime();
  snapshot.window = AiBudgetWindow::Lifetime;
  snapshot.subject = readBalance(txn, {AiBudgetScope::AnonymousLifetime, principal.subject.id, snapshot.period});
  const pqxx::result rows = txn.exec(
      "SELECT EXISTS (SELECT 1 FROM ai_budget_device_accounts WHERE device_id = $1), "
      "least(count(*), 2147483647)::int FROM ai_budget_reservations WHERE subject_kind = 'device' "
      "AND subject_id = $1 AND state IN ('reserved', 'dispatched', 'uncertain')", pqxx::params{principal.subject.id});
  snapshot.deviceBound = rows[0][0].as<bool>();
  snapshot.concurrentCalls = rows[0][1].as<int>();
  return snapshot;
}

std::vector<Budget> reservationBudgets(const AiBudgetReservation& reservation) {
  if (reservation.grantId) return {{AiBudgetScope::FundedPeriod, *reservation.grantId, reservation.period}};
  std::vector<Budget> budgets{
      {AiBudgetScope::FreeMonth, "all", *AiBudgetPeriod::at(reservation.admittedAtMs)},
      {AiBudgetScope::FreeDay, "all", *AiBudgetPeriod::dayAt(reservation.admittedAtMs)}};
  if (reservation.tier == AiBudgetTier::Anonymous)
    budgets.push_back({AiBudgetScope::AnonymousLifetime, reservation.subject.id, reservation.period});
  else budgets.push_back({AiBudgetScope::AccountMonth, reservation.subject.id, reservation.period});
  return budgets;
}

void changeBudget(pqxx::work& txn, Budget& budget, long long spent, long long held, long long debt) {
  const pqxx::result rows = txn.exec(
      "UPDATE ai_budget_balances SET spent_nanos = spent_nanos + $4::numeric, "
      "held_nanos = held_nanos + $5::numeric, debt_nanos = debt_nanos + $6::numeric "
      "WHERE scope = $1 AND subject_key = $2 AND period_start_ms = $3 RETURNING limit_nanos",
      pqxx::params{std::string(aiBudgetScopeName(budget.scope)), budget.key, budget.period.startMs, spent, held, debt});
  if (rows.size() != 1) throw std::runtime_error("Missing AI budget counter");
  budget.limit = rows[0][0].as<long long>();
}

void queueAlerts(pqxx::work& txn, const Budget& budget, long long atMs) {
  const auto balance = budget.scope == AiBudgetScope::AccountMonth
      ? accountTotals(txn, budget.key, budget.period).free : readBalance(txn, budget);
  const auto thresholds = crossedAiBudgetThresholds({}, balance, budget.limit);
  for (const int threshold : thresholds) {
    txn.exec("INSERT INTO ai_budget_alerts (scope, subject_key, period_start_ms, period_end_ms, "
             "threshold_percent, limit_nanos, spent_nanos, held_nanos, next_attempt_ms, funding_source) "
             "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, "
             "(SELECT source FROM ai_budget_grants WHERE id = $2 AND $1 = 'funded_period')) "
             "ON CONFLICT (scope, subject_key, period_start_ms, threshold_percent) DO NOTHING",
             pqxx::params{std::string(aiBudgetScopeName(budget.scope)), budget.key, budget.period.startMs,
                          budget.period.endMs, threshold, budget.limit, balance.spentNanos, balance.heldNanos, atMs});
  }
}

std::optional<Budget> boundAccountBudget(pqxx::work& txn, const AiBudgetReservation& reservation) {
  if (reservation.subject.kind != AiBudgetSubjectKind::Device) return std::nullopt;
  const pqxx::result binding = txn.exec(
      "SELECT account_id, bound_at_ms FROM ai_budget_device_accounts WHERE device_id = $1",
      pqxx::params{reservation.subject.id});
  if (binding.empty()) return std::nullopt;
  const auto account = binding[0][0].as<std::string>();
  const auto period = *AiBudgetPeriod::at(reservation.admittedAtMs);
  const auto bindingPeriod = *AiBudgetPeriod::at(binding[0][1].as<long long>());
  const pqxx::result rows = txn.exec(
      "SELECT limit_nanos FROM ai_budget_balances WHERE scope = 'account_month' AND subject_key = $1 "
      "AND period_start_ms IN ($2, $3) ORDER BY (period_start_ms = $2) DESC LIMIT 1",
      pqxx::params{account, period.startMs, bindingPeriod.startMs});
  if (rows.empty()) throw std::runtime_error("Missing bound account AI budget");
  return Budget{AiBudgetScope::AccountMonth, account, period, rows[0][0].as<long long>()};
}

}

PgAiBudgetRepository::PgAiBudgetRepository(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

AiBudgetSnapshot PgAiBudgetRepository::snapshot(const AiBudgetPrincipal& principal, long long atMs,
                                                const AiBudgetLimits& limits) {
  if (!principal.valid() || !AiBudgetPeriod::at(atMs) || !limits.valid())
    throw std::invalid_argument("Invalid AI budget snapshot request");
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  lockBudget(txn);
  bool wrote = false;
  auto snapshot = readSnapshot(txn, principal, atMs, limits, wrote);
  txn.commit();
  if (wrote) markCurrentWrite();
  return snapshot;
}

AiBudgetResult PgAiBudgetRepository::reserve(const AiBudgetRequest& request, const AiBudgetLimits& limits) {
  if (!request.valid()) return {AiBudgetCode::Invalid};
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  lockBudget(txn);
  if (auto prior = readReservation(txn, request.id)) {
    if (!prior->sameRequest(request)) return {AiBudgetCode::Conflict};
    return {AiBudgetCode::Replay, std::move(prior)};
  }
  if (!limits.valid()) return {AiBudgetCode::Invalid};
  bool wrote = false;
  const auto snapshot = readSnapshot(txn, request.principal, request.atMs, limits, wrote);
  auto plan = planAiBudget(request, limits, snapshot);
  if (plan.code != AiBudgetCode::Ok) {
    txn.commit();
    if (wrote) markCurrentWrite();
    return plan;
  }
  const auto& reservation = *plan.reservation;
  pqxx::params params{reservation.id, subjectKind(reservation.subject.kind), reservation.subject.id,
                       std::string(aiBudgetTierName(reservation.tier)), reservation.period.startMs,
                       reservation.period.endMs, reservation.amountNanos, reservation.admittedAtMs};
  if (reservation.grantId) params.append(*reservation.grantId);
  else params.append();
  if (reservation.outputBudget) {
    const auto& offer = *reservation.outputBudget;
    params.append(offer.inputNanos);
    params.append(offer.outputTokenNanos);
    params.append(offer.minTokens);
    params.append(offer.maxTokens);
  } else {
    for (int field = 0; field < 4; ++field) params.append();
  }
  txn.exec("INSERT INTO ai_budget_reservations (id, subject_kind, subject_id, tier, period_start_ms, "
           "period_end_ms, amount_nanos, admitted_at_ms, grant_id, input_cost_nanos, output_token_cost_nanos, "
           "min_output_tokens, max_output_tokens, state) "
           "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'reserved')", params);
  for (auto budget : reservationBudgets(reservation)) {
    switch (budget.scope) {
      case AiBudgetScope::FreeMonth: budget.limit = limits.freeMonthlyNanos; break;
      case AiBudgetScope::FreeDay: budget.limit = limits.freeDailyNanos; break;
      case AiBudgetScope::AnonymousLifetime: budget.limit = limits.anonymousLifetimeNanos; break;
      case AiBudgetScope::AccountMonth: budget.limit = limits.loggedInMonthlyNanos; break;
      case AiBudgetScope::FundedPeriod: budget.limit = snapshot.grant->amountNanos; break;
    }
    ensureBudget(txn, budget);
    changeBudget(txn, budget, 0, reservation.amountNanos, 0);
    queueAlerts(txn, budget, request.atMs);
  }
  txn.commit();
  markCurrentWrite();
  return plan;
}

AiBudgetResult PgAiBudgetRepository::transition(const std::string& id, AiBudgetState target,
                                               std::optional<long long> actualNanos) {
  if (!validAiBudgetId(id)) return {AiBudgetCode::Invalid};
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  lockBudget(txn);
  auto reservation = readReservation(txn, id);
  if (!reservation) return {AiBudgetCode::NotFound};
  const auto code = transitionAiBudget(*reservation, target, actualNanos);
  if (code != AiBudgetCode::Ok) return {code, std::move(reservation)};
  const long long spent = actualNanos.value_or(0);
  const long long variance = spent > reservation->amountNanos ? spent - reservation->amountNanos : 0;
  auto budgets = reservationBudgets(*reservation);
  const auto boundAccount = boundAccountBudget(txn, *reservation);
  if (variance > 0) {
    auto coverageBudgets = budgets;
    for (auto& budget : coverageBudgets) {
      const pqxx::result rows = txn.exec(
          "SELECT limit_nanos FROM ai_budget_balances WHERE scope = $1 AND subject_key = $2 AND period_start_ms = $3",
          pqxx::params{std::string(aiBudgetScopeName(budget.scope)), budget.key, budget.period.startMs});
      if (rows.size() != 1) throw std::runtime_error("Missing AI budget counter");
      budget.limit = rows[0][0].as<long long>();
    }
    if (boundAccount) coverageBudgets.push_back(*boundAccount);
    const bool principalHasDebt = reservation->grantId &&
        accountTotals(txn, reservation->subject.id, reservation->period).free.debtNanos > 0;
    const bool covered = !principalHasDebt && std::all_of(coverageBudgets.begin(), coverageBudgets.end(), [&](const auto& budget) {
      const auto balance = budget.scope == AiBudgetScope::AccountMonth
          ? accountTotals(txn, budget.key, budget.period).free : readBalance(txn, budget);
      return balance.debtNanos == 0 && balance.remainingNanos(budget.limit) >= variance;
    });
    if (covered) reconcileAiBudgetOverrun(*reservation);
  }
  const long long debt = reservation->overrunReconciled ? 0 : variance;
  const auto state = [target]() -> std::string {
    switch (target) {
      case AiBudgetState::Dispatched: return "dispatched";
      case AiBudgetState::Uncertain: return "uncertain";
      case AiBudgetState::Settled: return "settled";
      case AiBudgetState::Released: return "released";
      case AiBudgetState::Reserved: break;
    }
    throw std::invalid_argument("Invalid AI budget transition");
  }();
  pqxx::params params{id, state};
  if (actualNanos) params.append(*actualNanos);
  else params.append();
  params.append(reservation->overrunReconciled);
  txn.exec("UPDATE ai_budget_reservations SET state = $2, actual_nanos = $3, overrun_reconciled = $4 WHERE id = $1", params);
  if (target == AiBudgetState::Settled || target == AiBudgetState::Released) {
    for (auto& budget : budgets) {
      changeBudget(txn, budget, spent, -reservation->amountNanos, debt);
      queueAlerts(txn, budget, reservation->admittedAtMs);
    }
    if (boundAccount) queueAlerts(txn, *boundAccount, reservation->admittedAtMs);
  }
  txn.commit();
  markCurrentWrite();
  if (debt > 0) reportCurrentWriteFailure(std::overflow_error("AI budget reservation exceeded"));
  return {AiBudgetCode::Ok, std::move(reservation)};
}

AiBudgetResult PgAiBudgetRepository::markDispatched(const std::string& id) {
  return transition(id, AiBudgetState::Dispatched);
}

AiBudgetResult PgAiBudgetRepository::markUncertain(const std::string& id) {
  return transition(id, AiBudgetState::Uncertain);
}

AiBudgetResult PgAiBudgetRepository::settle(const std::string& id, long long actualNanos) {
  return transition(id, AiBudgetState::Settled, actualNanos);
}

AiBudgetResult PgAiBudgetRepository::release(const std::string& id) {
  return transition(id, AiBudgetState::Released);
}

AiBudgetResult PgAiBudgetRepository::reconcileOverrun(const std::string& id) {
  if (!validAiBudgetId(id)) return {AiBudgetCode::Invalid};
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  lockBudget(txn);
  auto reservation = readReservation(txn, id);
  if (!reservation) return {AiBudgetCode::NotFound};
  const auto code = reconcileAiBudgetOverrun(*reservation);
  if (code != AiBudgetCode::Ok) return {code, std::move(reservation)};
  txn.exec("UPDATE ai_budget_reservations SET overrun_reconciled = true WHERE id = $1", pqxx::params{id});
  for (auto budget : reservationBudgets(*reservation))
    changeBudget(txn, budget, 0, 0, -(*reservation->actualNanos - reservation->amountNanos));
  txn.commit();
  markCurrentWrite();
  return {AiBudgetCode::Ok, std::move(reservation)};
}

AiBudgetGrantResult PgAiBudgetRepository::fund(const AiBudgetGrant& grant, const AiBudgetLimits& limits) {
  if (!grant.valid() || !limits.valid() || grant.amountNanos != limits.paidPeriodNanos)
    return {AiBudgetCode::Invalid};
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  lockBudget(txn);
  const pqxx::result prior = txn.exec(
      "SELECT id, account_id, source, period_start_ms, period_end_ms, amount_nanos, funding_reference "
      "FROM ai_budget_grants WHERE id = $1 OR (source = $2 AND funding_reference = $3)",
      pqxx::params{grant.id, std::string(aiBudgetFundingSourceName(grant.source)), grant.fundingReference});
  if (!prior.empty()) {
    if (prior.size() != 1) return {AiBudgetCode::Conflict};
    const auto stored = grantFrom(prior[0]);
    auto retry = grant;
    retry.id = stored.id;
    if (stored != retry) return {AiBudgetCode::Conflict};
    return {AiBudgetCode::Replay, stored};
  }
  const pqxx::result overlap = txn.exec(
      "SELECT 1 FROM ai_budget_grants WHERE account_id = $1 AND source = $4 "
      "AND period_start_ms < $3 AND period_end_ms > $2",
      pqxx::params{grant.accountId, grant.period.startMs, grant.period.endMs,
                   std::string(aiBudgetFundingSourceName(grant.source))});
  if (!overlap.empty()) return {AiBudgetCode::Conflict};
  insertGrant(txn, grant);
  txn.commit();
  markCurrentWrite();
  return {AiBudgetCode::Ok, grant};
}

std::optional<std::string> PgAiBudgetRepository::boundAccount(const std::string& deviceId) {
  PgLease connection{*pool_};
  pqxx::read_transaction txn{*connection};
  const auto rows = txn.exec("SELECT account_id FROM ai_budget_device_accounts WHERE device_id = $1", pqxx::params{deviceId});
  if (rows.empty()) return std::nullopt;
  return rows[0][0].as<std::string>();
}

AiBudgetCode PgAiBudgetRepository::bindDevice(const std::string& deviceId, const std::string& accountId,
                                             long long atMs, const AiBudgetLimits& limits) {
  if (!validAiBudgetId(deviceId) || !validAiBudgetId(accountId) || !AiBudgetPeriod::at(atMs) || !limits.valid())
    return AiBudgetCode::Invalid;
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  lockBudget(txn);
  const pqxx::result prior = txn.exec("SELECT account_id FROM ai_budget_device_accounts WHERE device_id = $1",
                                     pqxx::params{deviceId});
  if (!prior.empty()) return prior[0][0].as<std::string>() == accountId ? AiBudgetCode::Replay : AiBudgetCode::Conflict;
  txn.exec("INSERT INTO ai_budget_device_accounts (device_id, account_id, bound_at_ms) VALUES ($1, $2, $3)",
           pqxx::params{deviceId, accountId, atMs});
  const Budget budget{AiBudgetScope::AccountMonth, accountId, *AiBudgetPeriod::at(atMs), limits.loggedInMonthlyNanos};
  ensureBudget(txn, budget);
  queueAlerts(txn, budget, atMs);
  txn.commit();
  markCurrentWrite();
  return AiBudgetCode::Ok;
}

std::vector<AiBudgetAlert> PgAiBudgetRepository::claimAlerts(long long atMs, int limit, long long leaseUntilMs) {
  if (!AiBudgetPeriod::at(atMs) || !AiBudgetPeriod::at(leaseUntilMs) || leaseUntilMs <= atMs || limit <= 0 || limit > 100)
    throw std::invalid_argument("Invalid AI budget alert claim");
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  lockBudget(txn);
  const pqxx::result rows = txn.exec(
      "UPDATE ai_budget_alerts SET state = 'claimed', claim_token = gen_random_uuid()::text, lease_until_ms = $3 "
      "WHERE id IN (SELECT id FROM ai_budget_alerts WHERE state <> 'delivered' AND next_attempt_ms <= $1 "
      "AND lease_until_ms <= $1 ORDER BY next_attempt_ms, id LIMIT $2) "
      "RETURNING id, scope, period_start_ms, period_end_ms, threshold_percent, limit_nanos, spent_nanos, "
      "held_nanos, claim_token, lease_until_ms, funding_source", pqxx::params{atMs, limit, leaseUntilMs});
  std::vector<AiBudgetAlert> alerts;
  const std::array<std::string, 5> scopes{"free_month", "free_day", "anonymous_lifetime", "account_month", "funded_period"};
  for (std::size_t index = 0; index < rows.size(); ++index) {
    const auto scope = std::find(scopes.begin(), scopes.end(), rows[index][1].as<std::string>());
    if (scope == scopes.end()) throw std::runtime_error("Invalid AI budget alert scope");
    AiBudgetAlert alert{rows[index][0].as<std::string>(), static_cast<AiBudgetScope>(scope - scopes.begin()),
                       {rows[index][2].as<long long>(), rows[index][3].as<long long>()},
                       rows[index][4].as<int>(), rows[index][5].as<long long>(), rows[index][6].as<long long>(),
                       rows[index][7].as<long long>(), rows[index][8].as<std::string>(), rows[index][9].as<long long>()};
    if (!rows[index][10].is_null())
      alert.fundingSource = rows[index][10].as<std::string>() == "owner"
                                ? AiBudgetFundingSource::Owner : AiBudgetFundingSource::Subscription;
    alerts.push_back(std::move(alert));
  }
  txn.commit();
  if (!alerts.empty()) markCurrentWrite();
  return alerts;
}

AiBudgetCode PgAiBudgetRepository::finishAlert(const std::string& id, const std::string& claimToken,
                                              std::optional<long long> nextAttemptMs) {
  if (!validAiBudgetId(id) || !validAiBudgetId(claimToken) || (nextAttemptMs && !AiBudgetPeriod::at(*nextAttemptMs)))
    return AiBudgetCode::Invalid;
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  lockBudget(txn);
  const pqxx::result rows = txn.exec("SELECT state, claim_token, next_attempt_ms FROM ai_budget_alerts WHERE id = $1",
                                    pqxx::params{id});
  if (rows.empty()) return AiBudgetCode::NotFound;
  if (rows[0][1].is_null() || rows[0][1].as<std::string>() != claimToken) return AiBudgetCode::Conflict;
  const auto state = rows[0][0].as<std::string>();
  if (!nextAttemptMs && state == "delivered") return AiBudgetCode::Replay;
  if (nextAttemptMs && state == "pending" && rows[0][2].as<long long>() == *nextAttemptMs) return AiBudgetCode::Replay;
  if (state != "claimed") return AiBudgetCode::InvalidState;
  if (nextAttemptMs)
    txn.exec("UPDATE ai_budget_alerts SET state = 'pending', lease_until_ms = 0, next_attempt_ms = $2 WHERE id = $1",
             pqxx::params{id, *nextAttemptMs});
  else txn.exec("UPDATE ai_budget_alerts SET state = 'delivered', lease_until_ms = 0 WHERE id = $1", pqxx::params{id});
  txn.commit();
  markCurrentWrite();
  return AiBudgetCode::Ok;
}

AiBudgetCode PgAiBudgetRepository::completeAlert(const std::string& id, const std::string& claimToken) {
  return finishAlert(id, claimToken, std::nullopt);
}

AiBudgetCode PgAiBudgetRepository::retryAlert(const std::string& id, const std::string& claimToken, long long nextAttemptMs) {
  return finishAlert(id, claimToken, nextAttemptMs);
}

}
