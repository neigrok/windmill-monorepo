#include "products/gym/adapters/postgres/PgPreferencesRepository.h"

#include "test/products/gym/sync/adapters/postgres/GymDoorFixture.h"
#include "test/products/gym/adapters/postgres/PgGymFixture.h"
#include "test/testing.h"

#include "products/gym/adapters/json/TrainingJson.h"

#include <pqxx/pqxx>

#include <cstdlib>
#include <optional>
#include <string>
#include <vector>

// The settings row against the real column checks, written as a phone's whole document through /v1/sync.
using namespace wm;
using namespace wm::gym;
using namespace wm::gym::pgtest;

namespace {

Json::Value phonePreferences(doortest::Harness& h, const GymPreferences& incoming) {
  Json::Value fields = toJson(incoming);
  fields["restSeconds"] = incoming.restSeconds ? Json::Value(*incoming.restSeconds) : Json::Value();
  return h.admit(incoming.user, {GymDoor::delta("prefs", "prefs", fields)});
}

}  // namespace

// No row until the first write; each whole document replaces the one row.
TEST(pg_gym_preferences_are_absent_until_written_then_upsert_in_place) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const GymPreferences saved{h.user, Unit::lb, 90, false, false, true};
  const GymPreferences replaced{h.user, Unit::kg, std::nullopt, true, true, false};

  CHECK_EQ(h.repo.preferences.preferences(h.user), std::optional<GymPreferences>());
  CHECK_EQ(GymDoor::refusal(phonePreferences(h, saved)), "");
  CHECK_EQ(h.repo.preferences.preferences(h.user), std::optional<GymPreferences>(saved));
  CHECK_EQ(GymDoor::refusal(phonePreferences(h, replaced)), "");

  CHECK_EQ(h.repo.preferences.preferences(h.user), std::optional<GymPreferences>(replaced));
  CHECK_EQ(h.repo.preferences.preferences(h.other), std::optional<GymPreferences>());
  // One row per account and not a row per write: the second document replaced the first.
  PgLease conn{*doortest::pool()};
  pqxx::work txn{*conn};
  CHECK_EQ(txn.exec("SELECT count(*)::int FROM gym_preferences WHERE user_id = $1::uuid", pqxx::params{h.user.str()})[0][0]
               .as<int>(),
           1);
}

TEST(pg_gym_preferences_are_owner_scoped_and_cascade_with_the_account) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgPreferencesRepository repo{pgTestPool()};
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("INSERT INTO gym_preferences (user_id, units, rest_seconds, rest_sound, confirm_haptic, confirm_sound) "
             "VALUES ($1::uuid, 'lb', 90, false, false, true)",
             pqxx::params{kUser});
    txn.commit();
  }

  CHECK_EQ(repo.preferences(UserId{kOther}), std::optional<GymPreferences>());
  CHECK_EQ(repo.preferences(UserId{kUser}),
           std::optional<GymPreferences>(GymPreferences{UserId{kUser}, Unit::lb, 90, false, false, true}));

  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("DELETE FROM users WHERE id = $1::uuid", pqxx::params{kUser});
    txn.commit();
  }
  CHECK_EQ(repo.preferences(UserId{kUser}), std::optional<GymPreferences>());
  reset();
}

// The columns carry the same bounds the entity does, written against raw SQL because the entity can never send these.
TEST(pg_gym_preferences_columns_refuse_what_the_domain_refuses) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();

  const std::vector<std::string> refused{
      "INSERT INTO gym_preferences (user_id, units) VALUES ('" + kUser + "', 'st')",
      "INSERT INTO gym_preferences (user_id, rest_seconds) VALUES ('" + kUser + "', 14)",
      "INSERT INTO gym_preferences (user_id, rest_seconds) VALUES ('" + kUser + "', 901)"};

  for (const std::string& statement : refused) {
    bool stopped = false;
    try {
      PgLease conn{*pgTestPool()};
      pqxx::work txn{*conn};
      txn.exec(statement);
      txn.commit();
    } catch (const std::exception&) {
      stopped = true;
    }
    CHECK(stopped);
  }
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("INSERT INTO gym_preferences (user_id) VALUES ($1::uuid)", pqxx::params{kUser});
    txn.commit();
  }
  PgPreferencesRepository repo{pgTestPool()};
  CHECK_EQ(repo.preferences(UserId{kUser}), std::optional<GymPreferences>(GymPreferences{UserId{kUser}}));
  reset();
}
