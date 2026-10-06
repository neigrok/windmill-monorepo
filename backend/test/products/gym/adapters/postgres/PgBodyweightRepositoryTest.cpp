#include "products/gym/adapters/postgres/PgBodyweightRepository.h"

#include "test/products/gym/sync/adapters/postgres/GymDoorFixture.h"
#include "test/products/gym/adapters/postgres/PgGymFixture.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <cstdlib>
#include <exception>
#include <string>
#include <vector>

// The weigh-in rows against the real key, column and CHECK, written as a phone's /v1/sync put of a day.
using namespace wm;
using namespace wm::gym;
using namespace wm::gym::pgtest;

namespace {

// The server's day: a weigh-in is a forecast past the day after it.
constexpr std::uint64_t kAugust26 = 1'787'745'600'000;

// A phone's put of one day: the whole weigh-in, admitted.
Json::Value weighIn(doortest::Harness& h, const Bodyweight& entry) {
  Json::Value fields(Json::objectValue);
  fields["kg"] = entry.weightKg;
  fields["recordedAt"] = Json::UInt64(entry.recordedAtMs);
  return h.admit(entry.user, {GymDoor::delta("weighin", entry.dateLocal, fields, true)});
}

}  // namespace

TEST(pg_gym_bodyweight_is_one_row_per_day_and_the_later_put_replaces_it_whole) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  h.clock.now = kAugust26;
  CHECK_EQ(h.repo.bodyweight.entries(h.user, {}), std::vector<Bodyweight>{});
  CHECK_EQ(h.repo.bodyweight.latest(h.user), std::optional<Bodyweight>());

  for (const Bodyweight& put : {Bodyweight{h.user, "2026-08-25", 82.4, kNow},
                                Bodyweight{h.user, "2026-08-25", 82.9, kNow + 60'000},
                                Bodyweight{h.user, "2026-08-01", 83.0, kNow + 120'000},
                                Bodyweight{h.other, "2026-08-25", 70.0, kNow + 999'000}}) {
    GymDoor::requireOk(weighIn(h, put));
    h.clock.now += 1'000;
  }

  CHECK_EQ(h.repo.bodyweight.entries(h.user, {}),
           (std::vector<Bodyweight>{Bodyweight{h.user, "2026-08-01", 83.0, kNow + 120'000},
                                    Bodyweight{h.user, "2026-08-25", 82.9, kNow + 60'000}}));
  CHECK_EQ(h.repo.bodyweight.latest(h.user), std::optional<Bodyweight>(Bodyweight{h.user, "2026-08-25", 82.9, kNow + 60'000}));
  CHECK_EQ(h.repo.bodyweight.entries(h.other, {}),
           (std::vector<Bodyweight>{Bodyweight{h.other, "2026-08-25", 70.0, kNow + 999'000}}));
  // The later put stands whole, whatever instant it carries: the order is the engine's, not recordedAt's.
  GymDoor::requireOk(weighIn(h, Bodyweight{h.user, "2026-08-25", 82.4, kNow}));
  CHECK_EQ(h.repo.bodyweight.latest(h.user), std::optional<Bodyweight>(Bodyweight{h.user, "2026-08-25", 82.4, kNow}));
}

TEST(pg_gym_bodyweight_reads_inside_inclusive_bounds) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  h.clock.now = kAugust26;
  const Bodyweight july4{h.user, "2026-07-04", 84.0, 1'700'000'060'000ull};
  const Bodyweight august1{h.user, "2026-08-01", 83.25, 1'700'000'120'000ull};
  const Bodyweight august3{h.user, "2026-08-03", 83.0, 1'700'000'180'000ull};
  const Bodyweight august25{h.user, "2026-08-25", 82.4, 1'700'000'000'000ull};
  for (const Bodyweight& put : {august25, july4, august1, august3, Bodyweight{h.other, "2026-08-02", 70.0, kNow}})
    GymDoor::requireOk(weighIn(h, put));

  CHECK_EQ(h.repo.bodyweight.entries(h.user, BodyweightRange{}),
           (std::vector<Bodyweight>{july4, august1, august3, august25}));
  CHECK_EQ(h.repo.bodyweight.entries(h.user, BodyweightRange{"2026-08-01", "2026-08-03"}),
           (std::vector<Bodyweight>{august1, august3}));
  CHECK_EQ(h.repo.bodyweight.entries(h.user, BodyweightRange{"2026-08-02", ""}),
           (std::vector<Bodyweight>{august3, august25}));
  CHECK_EQ(h.repo.bodyweight.entries(h.user, BodyweightRange{"", "2026-08-01"}),
           (std::vector<Bodyweight>{july4, august1}));
  CHECK_EQ(h.repo.bodyweight.entries(h.user, BodyweightRange{"2026-08-04", "2026-08-24"}), std::vector<Bodyweight>{});
  CHECK_EQ(h.repo.bodyweight.entries(h.user, BodyweightRange{"2026-08-25", "2026-08-01"}), std::vector<Bodyweight>{});
}

TEST(pg_gym_bodyweight_remove_is_owner_scoped_and_absent_is_a_no_op) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  h.clock.now = kAugust26;
  for (const Bodyweight& put : {Bodyweight{h.user, "2026-08-25", 82.4, kNow}, Bodyweight{h.user, "2026-08-01", 83.0, kNow},
                                Bodyweight{h.other, "2026-08-25", 70.0, kNow}})
    GymDoor::requireOk(weighIn(h, put));

  h.kill(h.user, "weighin", "2026-08-25");
  h.kill(h.user, "weighin", "2026-08-25");
  h.kill(h.user, "weighin", "2026-08-24");

  CHECK_EQ(h.repo.bodyweight.entries(h.user, {}), (std::vector<Bodyweight>{Bodyweight{h.user, "2026-08-01", 83.0, kNow}}));
  CHECK_EQ(h.repo.bodyweight.entries(h.other, {}), (std::vector<Bodyweight>{Bodyweight{h.other, "2026-08-25", 70.0, kNow}}));
}

TEST(pg_gym_bodyweight_cascades_with_the_account) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgBodyweightRepository repo{pgTestPool()};
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("INSERT INTO gym_bodyweight (user_id, date_local, weight_kg, recorded_at) VALUES "
             "($1::uuid, '2026-08-25', 82.4, $3), ($2::uuid, '2026-08-25', 70.0, $3)",
             pqxx::params{kUser, kOther, static_cast<std::int64_t>(kNow)});
    txn.exec("DELETE FROM users WHERE id = $1::uuid", pqxx::params{kUser});
    txn.commit();
  }
  CHECK_EQ(repo.entries(UserId{kUser}, {}), std::vector<Bodyweight>{});
  CHECK_EQ(repo.entries(UserId{kOther}, {}), (std::vector<Bodyweight>{Bodyweight{UserId{kOther}, "2026-08-25", 70.0, kNow}}));
  reset();
}

// The columns carry the entity's band, its two decimals and real days, as raw SQL the entity can never send.
TEST(pg_gym_bodyweight_columns_refuse_what_the_domain_refuses) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  const std::string row = "INSERT INTO gym_bodyweight (user_id, date_local, weight_kg, recorded_at) VALUES ";
  const std::vector<std::string> refused{
      row + "('" + kUser + "', '2026-08-25', 19.99, 1)",
      row + "('" + kUser + "', '2026-08-25', 400.01, 1)",
      row + "('" + kUser + "', '2026-08-25', 0, 1)",
      row + "('" + kUser + "', '2026-08-25', 1000, 1)",       // past numeric(5,2) as well
      row + "('" + kUser + "', '2026-02-30', 82.4, 1)",        // not a day
      row + "('" + kUser + "', '2026-08-25', 82.4, 1), ('" + kUser + "', '2026-08-25', 82.5, 2)",
      row + "('" + kUser + "', '2026-08-25', 82.4, NULL)"};
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
  // The column rounds a third decimal exactly as the entity does, and the band's ends are legal.
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec(row + "('" + kUser + "', '2026-08-25', 82.456, 1), ('" + kUser + "', '2026-08-26', 20, 1), "
             "('" + kUser + "', '2026-08-27', 400, 1), ('" + kUser + "', '2024-02-29', 19.996, 1)");
    txn.commit();
  }
  PgBodyweightRepository repo{pgTestPool()};
  const std::vector<Bodyweight> held = repo.entries(UserId{kUser}, {});
  REQUIRE_EQ(held.size(), std::size_t{4});
  CHECK_EQ(held[0], (Bodyweight{UserId{kUser}, "2024-02-29", 19.996, 1}));   // both round to 20.00
  CHECK_EQ(held[1].weightKg, 82.46);
  CHECK_EQ(held[2].weightKg, 20.0);
  CHECK_EQ(held[3].weightKg, 400.0);
  reset();
}
