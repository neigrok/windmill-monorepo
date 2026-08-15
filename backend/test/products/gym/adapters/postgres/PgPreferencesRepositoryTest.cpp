#include "products/gym/adapters/postgres/PgTrainingRepository.h"

#include "test/products/gym/adapters/postgres/PgGymFixture.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <cstdlib>
#include <optional>
#include <string>
#include <utility>
#include <vector>

// §I · the settings row, against the real column checks.
using namespace wm::gym;
using namespace wm::gym::pgtest;

// ---- §I · the settings row, against the real column checks ------------------------------------

// The absence is the fact this store states: a lifter who has never opened the settings screen has
// no row, and the defaults are given a layer up rather than invented here. The upsert is the whole
// write — one row per account, last write wins — and RETURNING is what makes the answer the document
// the store now holds rather than the one the caller sent.
TEST(pg_gym_preferences_are_absent_until_written_then_upsert_in_place) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};

  const std::optional<GymPreferences> before = repo.preferences(wm::UserId{kUser});
  const GymPreferences saved = repo.savePreferences(
      GymPreferences{wm::UserId{kUser}, Unit::lb, 90, false, false, true});
  const GymPreferences replaced = repo.savePreferences(
      GymPreferences{wm::UserId{kUser}, Unit::kg, std::nullopt, true, true, false});

  CHECK_EQ(before, std::optional<GymPreferences>());
  CHECK_EQ(saved, GymPreferences(wm::UserId{kUser}, Unit::lb, 90, false, false, true));
  CHECK_EQ(replaced, GymPreferences(wm::UserId{kUser}, Unit::kg, std::nullopt, true, true, false));
  CHECK_EQ(repo.preferences(wm::UserId{kUser}), std::optional<GymPreferences>(replaced));
  // One row per account and not a row per write: the second document replaced the first.
  wm::PgLease conn{*wm::pgTestPool()};
  pqxx::work txn{*conn};
  CHECK_EQ(txn.exec_params("SELECT count(*)::int FROM gym_preferences WHERE user_id = $1::uuid",
                           kUser)[0][0]
               .as<int>(),
           1);
}

// One lifter's settings and no other's, the scope every row in this store keeps — and the cascade
// that takes the row with the account.
TEST(pg_gym_preferences_are_owner_scoped_and_cascade_with_the_account) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  repo.savePreferences(GymPreferences{wm::UserId{kUser}, Unit::lb, 90, false, false, true});

  CHECK_EQ(repo.preferences(wm::UserId{kOther}), std::optional<GymPreferences>());
  CHECK_EQ(repo.preferences(wm::UserId{kUser})->units, Unit::lb);

  {
    wm::PgLease conn{*wm::pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec_params("DELETE FROM users WHERE id = $1::uuid", kUser);
    txn.commit();
  }
  CHECK_EQ(repo.preferences(wm::UserId{kUser}), std::optional<GymPreferences>());
  reset();
}

// The columns carry the same bounds the entity does, so a row the domain would refuse is a row this
// database will not hold either — which is what makes the read's construction safe. Written against
// raw SQL on purpose: the entity can never send these, and the check is the only thing standing
// between a hand-edited row and a read that throws for every later request on that account.
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
      wm::PgLease conn{*wm::pgTestPool()};
      pqxx::work txn{*conn};
      txn.exec(statement);
      txn.commit();
    } catch (const std::exception&) {
      stopped = true;
    }
    CHECK(stopped);
  }
  // And the defaults on the columns are the defaults in the domain, so a row written by hand with
  // nothing but an owner reads back as the document a fresh lifter is served.
  {
    wm::PgLease conn{*wm::pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec_params("INSERT INTO gym_preferences (user_id) VALUES ($1::uuid)", kUser);
    txn.commit();
  }
  PgTrainingRepository repo{wm::pgTestPool()};
  CHECK_EQ(repo.preferences(wm::UserId{kUser}),
           std::optional<GymPreferences>(GymPreferences{wm::UserId{kUser}}));
  reset();
}
