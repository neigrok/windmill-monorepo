#include "products/gym/adapters/postgres/PgBodyweightRepository.h"

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/adapters/postgres/PgGymRows.h"

#include <pqxx/pqxx>

#include <string>
#include <string_view>
#include <utility>

namespace wm::gym {

namespace {
constexpr std::string_view kBodyweightColumns =
    "user_id, date_local::text AS date_local, weight_kg::float8 AS weight_kg, recorded_at";

// The column's CHECK and its two decimals are the entity's own band, so a stored row rebuilds
// without a refusal.
template <typename Row>
Bodyweight bodyweightFrom(const Row& row) {
  return Bodyweight{UserId{row["user_id"].template as<std::string>()},
                    row["date_local"].template as<std::string>(),
                    row["weight_kg"].template as<double>(), instantFrom(row["recorded_at"])};
}
}

PgBodyweightRepository::PgBodyweightRepository(std::shared_ptr<PgPool> pool)
    : pool_(std::move(pool)) {}

std::vector<Bodyweight> PgBodyweightRepository::entries(const UserId& user,
                                                        const BodyweightRange& range) {
  // An empty bound is no bound: nulled in SQL and coalesced onto the row's own day, so the
  // comparison is always true and no `''::date` is ever attempted.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kBodyweightColumns) +
          " FROM gym_bodyweight WHERE user_id = $1::uuid "
          "  AND date_local >= coalesce(nullif($2::text, '')::date, date_local) "
          "  AND date_local <= coalesce(nullif($3::text, '')::date, date_local) "
          "ORDER BY date_local",
      user.str(), range.from, range.to);
  std::vector<Bodyweight> entries;
  for (const auto& row : rows) entries.push_back(bodyweightFrom(row));
  return entries;
}

std::optional<Bodyweight> PgBodyweightRepository::latest(const UserId& user) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kBodyweightColumns) +
          " FROM gym_bodyweight WHERE user_id = $1::uuid ORDER BY date_local DESC LIMIT 1",
      user.str());
  if (rows.empty()) return std::nullopt;
  return bodyweightFrom(rows[0]);
}

}
