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
constexpr std::string_view kPreferenceColumns =
    "user_id, units, rest_seconds, rest_sound, confirm_haptic, confirm_sound";

// Every bound the entity refuses is also a column check, so a stored row is a legal document by the
// time it is read. The unit is the exception: `unitFromStored` clamps an unknown word to kg rather
// than failing every read of the account.
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
  // A lifter with no row gets the domain's defaults, never a document this store invents.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows =
      txn.exec_params("SELECT " + std::string(kPreferenceColumns) +
                          " FROM gym_preferences WHERE user_id = $1::uuid",
                      user.str());
  if (rows.empty()) return std::nullopt;
  return preferencesFrom(rows[0]);
}

}
