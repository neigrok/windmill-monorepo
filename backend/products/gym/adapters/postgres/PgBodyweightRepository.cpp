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

Bodyweight PgBodyweightRepository::save(const Bodyweight& incoming) {
  // The UPDATE arm runs only when the incoming instant is at or after the stored one, so an older
  // write changes nothing and the read-back below answers with the row that stands either way.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "INSERT INTO gym_bodyweight (user_id, date_local, weight_kg, recorded_at) "
      "VALUES ($1::uuid, $2::date, $3, $4) "
      "ON CONFLICT (user_id, date_local) DO UPDATE "
      "  SET weight_kg = excluded.weight_kg, recorded_at = excluded.recorded_at, "
      "      updated_at = now() "
      "  WHERE gym_bodyweight.recorded_at <= excluded.recorded_at",
      incoming.user.str(), incoming.dateLocal, incoming.weightKg,
      static_cast<long long>(incoming.recordedAtMs));
  pqxx::result stored = txn.exec_params(
      "SELECT " + std::string(kBodyweightColumns) +
          " FROM gym_bodyweight WHERE user_id = $1::uuid AND date_local = $2::date",
      incoming.user.str(), incoming.dateLocal);
  const Bodyweight answer = bodyweightFrom(stored[0]);
  txn.commit();
  return answer;
}

void PgBodyweightRepository::remove(const UserId& user, const std::string& dateLocal) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params("DELETE FROM gym_bodyweight WHERE user_id = $1::uuid AND date_local = $2::date",
                  user.str(), dateLocal);
  txn.commit();
}

std::vector<ExportedBodyweight> PgBodyweightRepository::exported(const UserId& user) {
  // Every value is text rendered by Postgres: the day as stored, the weight with the column's two
  // decimals, the device instant ISO-8601 UTC like every other export's instant.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT date_local::text AS date_local, weight_kg::text AS weight_kg, "
      "       to_char(to_timestamp(recorded_at / 1000.0) AT TIME ZONE 'UTC', "
      "               'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS recorded_at "
      "FROM gym_bodyweight WHERE user_id = $1::uuid ORDER BY date_local",
      user.str());
  std::vector<ExportedBodyweight> entries;
  for (const auto& row : rows)
    entries.push_back(ExportedBodyweight{row["date_local"].as<std::string>(),
                                         row["weight_kg"].as<std::string>(),
                                         row["recorded_at"].as<std::string>()});
  return entries;
}

}
