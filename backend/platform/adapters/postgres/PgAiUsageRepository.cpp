#include "platform/adapters/postgres/PgAiUsageRepository.h"

#include <pqxx/pqxx>
#include <trantor/utils/Logger.h>

#include <utility>

namespace wm {
namespace {

// Every window arrives as epoch-ms and becomes an instant in SQL, so the comparison happens against
// the same clock that stamped the row and the two can never drift.
constexpr const char* kFrom = "to_timestamp($1::bigint / 1000.0)";
constexpr const char* kTo = "to_timestamp($2::bigint / 1000.0)";

// A call whose model we could not price makes every total it lands in a floor rather than a figure.
// It rides on each aggregate row and not only on the summary scalar, or the page cannot honestly
// mark which of its numbers is a "≥".
constexpr const char* kUnpriced = "count(*) filter (where cost_nanos is null)";

}

PgAiUsageRepository::PgAiUsageRepository(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

void PgAiUsageRepository::record(const AiSpend& spend) noexcept {
  // The whole body, guarded. This is the sink an LLM adapter calls after the answer is already in
  // hand: a lost ledger row costs us a line in a chart, and a thrown one would cost the user their
  // reply. The port's `noexcept` is only honest because of this catch.
  try {
    const std::optional<long long> cost = costNanos(spend.model, spend.tokens);
    // Two costs, deliberately. `cost_nanos` is what we KNOW and is null when we do not — that null
    // is what lights the unpriced badge and keeps the dashboard honest. `cost_floor_nanos` is what
    // the CEILINGS read, and is never null: an unknown model is charged the dearest rate we know,
    // because a model we forgot to price must not be a model that spends for free.
    const long long floorCost = floorCostNanos(spend.model, spend.tokens);

    pqxx::params params;
    if (spend.user) params.append(spend.user->str());
    else params.append();
    params.append(spend.product);
    params.append(spend.operation);
    params.append(spend.runId);
    params.append(spend.iteration);
    params.append(spend.model);
    params.append(spend.outcome);
    params.append(spend.tokens.input);
    params.append(spend.tokens.output);
    params.append(spend.tokens.cacheRead);
    params.append(spend.tokens.cacheWrite);
    if (cost) params.append(*cost);
    else params.append();
    params.append(floorCost);

    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    txn.exec("INSERT INTO ai_usage "
             "(user_id, product, operation, run_id, iteration, model, outcome, "
             "input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_nanos, "
             "cost_floor_nanos) "
             "VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
             params);
    txn.commit();
  } catch (const std::exception& e) {
    LOG_ERROR << "ai_usage row dropped: " << e.what();
  } catch (...) {
    LOG_ERROR << "ai_usage row dropped";
  }
}

long long PgAiUsageRepository::spentSinceNanos(const UserId& user, const std::string& product,
                                               long long sinceMs) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  // An empty product means every product — one query rather than two, because the caller's question
  // is the same question either way.
  const pqxx::result rows = txn.exec_params(
      // cost_floor_nanos, not cost_nanos: summing the nullable column let an unpriced model spend
      // against no ceiling at all — fifty such calls moved a $25 budget by nothing.
      "SELECT coalesce(sum(cost_floor_nanos), 0) FROM ai_usage "
      "WHERE user_id = $1::uuid AND ts >= to_timestamp($2::bigint / 1000.0) "
      "AND ($3 = '' OR product = $3)",
      user.str(), sinceMs, product);
  if (rows.empty()) return 0;
  return rows[0][0].as<long long>();
}

UsageSummary PgAiUsageRepository::summary(long long fromMs, long long toMs) {
  UsageSummary summary;

  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const std::string window =
      std::string(" FROM ai_usage WHERE ts >= ") + kFrom + " AND ts < " + kTo;

  const pqxx::result totals = txn.exec_params(
      "SELECT coalesce(sum(cost_nanos), 0), count(*), " + std::string(kUnpriced) +
          ", coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0)"
          ", coalesce(sum(cache_read_tokens), 0), coalesce(sum(cache_write_tokens), 0)"
          ", coalesce(sum(cost_nanos) filter (where user_id is null), 0)" +
          window,
      fromMs, toMs);
  if (!totals.empty()) {
    summary.costNanos = totals[0][0].as<long long>();
    summary.calls = totals[0][1].as<long long>();
    summary.unpricedCalls = totals[0][2].as<long long>();
    summary.inputTokens = totals[0][3].as<long long>();
    summary.outputTokens = totals[0][4].as<long long>();
    summary.cacheReadTokens = totals[0][5].as<long long>();
    summary.cacheWriteTokens = totals[0][6].as<long long>();
    summary.anonymousCostNanos = totals[0][7].as<long long>();
  }

  const pqxx::result products = txn.exec_params(
      "SELECT product, coalesce(sum(cost_nanos), 0), count(*), " + std::string(kUnpriced) + window +
          " GROUP BY product ORDER BY 2 DESC, product",
      fromMs, toMs);
  for (int i = 0; i < static_cast<int>(products.size()); ++i) {
    summary.byProduct.push_back(ProductSpend{products[i][0].as<std::string>(),
                                             products[i][1].as<long long>(),
                                             products[i][2].as<long long>(),
                                             products[i][3].as<long long>()});
  }

  const pqxx::result days = txn.exec_params(
      "SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, coalesce(sum(cost_nanos), 0), count(*), " +
          std::string(kUnpriced) + window + " GROUP BY day ORDER BY day",
      fromMs, toMs);
  for (int i = 0; i < static_cast<int>(days.size()); ++i) {
    summary.daily.push_back(DaySpend{days[i][0].as<std::string>(), days[i][1].as<long long>(),
                                     days[i][2].as<long long>(), days[i][3].as<long long>()});
  }

  const pqxx::result unpriced = txn.exec_params(
      "SELECT DISTINCT model" + window + " AND cost_nanos is null ORDER BY model", fromMs, toMs);
  for (int i = 0; i < static_cast<int>(unpriced.size()); ++i) {
    summary.unpricedModels.push_back(unpriced[i][0].as<std::string>());
  }

  return summary;
}

std::vector<UserSpend> PgAiUsageRepository::topSpenders(long long fromMs, long long toMs,
                                                        int limit) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  // `user_id is not null` is the load-bearing line: this table is a list of PEOPLE, and the
  // anonymous birth canvas is not one. Its total rides on UsageSummary.anonymousCostNanos instead,
  // where nobody can misread it as an account.
  const pqxx::result rows = txn.exec_params(
      "SELECT a.user_id::text, coalesce(u.email, ''), coalesce(sum(a.cost_nanos), 0), count(*), " +
          std::string(kUnpriced) +
          ", (SELECT p.product FROM ai_usage p WHERE p.user_id = a.user_id "
          "   AND p.ts >= " + kFrom + " AND p.ts < " + kTo +
          "   GROUP BY p.product ORDER BY coalesce(sum(p.cost_nanos), 0) DESC, p.product LIMIT 1) "
          "FROM ai_usage a LEFT JOIN users u ON u.id = a.user_id "
          "WHERE a.user_id IS NOT NULL AND a.ts >= " + kFrom + " AND a.ts < " + kTo +
          " GROUP BY a.user_id, u.email ORDER BY 3 DESC, 1 LIMIT $3",
      fromMs, toMs, limit);

  std::vector<UserSpend> spenders;
  for (int i = 0; i < static_cast<int>(rows.size()); ++i) {
    spenders.push_back(UserSpend{UserId{rows[i][0].as<std::string>()}, rows[i][1].as<std::string>(),
                                 rows[i][2].as<long long>(), rows[i][3].as<long long>(),
                                 rows[i][4].as<long long>(),
                                 rows[i][5].is_null() ? "" : rows[i][5].as<std::string>()});
  }
  return spenders;
}

}
