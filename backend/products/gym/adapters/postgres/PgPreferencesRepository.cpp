#include "products/gym/adapters/postgres/PgPreferencesRepository.h"

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/adapters/postgres/PgGymRows.h"

#include <pqxx/pqxx>

#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace wm::gym {

namespace {
// The settings row.
constexpr std::string_view kPreferenceColumns =
    "user_id, units, rest_seconds, rest_sound, confirm_haptic, confirm_sound";

// Every bound the entity refuses is also a column check, so a stored row is a legal document by the
// time it is read. The unit is the exception and the reason `unitFromStored` CLAMPS: a word a newer
// deploy added reads as kg rather than failing every read of the account.
template <typename Row>
GymPreferences preferencesFrom(const Row& row) {
  std::optional<int> restSeconds;
  if (!row["rest_seconds"].is_null()) restSeconds = row["rest_seconds"].template as<int>();
  return GymPreferences{UserId{row["user_id"].template as<std::string>()},
                        unitFromStored(row["units"].template as<std::string>()),
                        restSeconds,
                        row["rest_sound"].template as<bool>(),
                        row["confirm_haptic"].template as<bool>(),
                        row["confirm_sound"].template as<bool>()};
}
}

PgPreferencesRepository::PgPreferencesRepository(std::shared_ptr<PgPool> pool)
    : pool_(std::move(pool)) {}

std::optional<GymPreferences> PgPreferencesRepository::preferences(const UserId& user) {
  // Absent crosses as an absence: a lifter with no row gets the domain's DEFAULTS
  // (application/PreferencesService.cpp), never a document this store invents.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows =
      txn.exec_params("SELECT " + std::string(kPreferenceColumns) +
                          " FROM gym_preferences WHERE user_id = $1::uuid",
                      user.str());
  if (rows.empty()) return std::nullopt;
  return preferencesFrom(rows[0]);
}

GymPreferences PgPreferencesRepository::savePreferences(const GymPreferences& incoming) {
  // One row per account, so the upsert IS the whole write: no client-minted id, nothing to replay
  // against, last write wins.
  // RETURNING reads the stored row back inside the same statement, because the two differ the moment
  // a column rounds a numeric.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::params params;
  params.append(incoming.user.str());
  params.append(toString(incoming.units));
  if (incoming.restSeconds) params.append(*incoming.restSeconds);
  else params.append();
  params.append(incoming.restSound);
  params.append(incoming.confirmHaptic);
  params.append(incoming.confirmSound);
  pqxx::result rows = txn.exec(
      "INSERT INTO gym_preferences (user_id, units, rest_seconds, "
      "                             rest_sound, confirm_haptic, confirm_sound) "
      "VALUES ($1::uuid, $2, $3, $4, $5, $6) "
      "ON CONFLICT (user_id) DO UPDATE SET units = excluded.units, "
      "  rest_seconds = excluded.rest_seconds, rest_sound = excluded.rest_sound, "
      "  confirm_haptic = excluded.confirm_haptic, confirm_sound = excluded.confirm_sound, "
      "  updated_at = now() "
      "RETURNING " + std::string(kPreferenceColumns),
      params);
  GymPreferences stored = preferencesFrom(rows[0]);
  txn.commit();
  return stored;
}

}
