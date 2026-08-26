#include "products/gym/adapters/postgres/PgBodyweightRepository.h"

#include "test/products/gym/Fakes.h"
#include "test/products/gym/adapters/postgres/PgGymFixture.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <cstdlib>
#include <exception>
#include <latch>
#include <string>
#include <thread>
#include <vector>

// The weigh-in rows, against the real primary key, the numeric(5,2) column and its CHECK, and the
// guarded upsert. Every case drives the fake beside the store and asserts the two answer alike.
using namespace wm::gym;
using namespace wm::gym::pgtest;

namespace {

Bodyweight at(const std::string& day, double weightKg, std::uint64_t recordedAtMs = kNow,
              const std::string& owner = kUser) {
  return Bodyweight{wm::UserId{owner}, day, weightKg, recordedAtMs};
}

std::vector<std::string> daysOf(BodyweightRepository& repo, const std::string& owner = kUser,
                                BodyweightRange range = {}) {
  std::vector<std::string> days;
  for (const Bodyweight& held : repo.entries(wm::UserId{owner}, range)) days.push_back(held.dateLocal);
  return days;
}

}  // namespace

TEST(pg_gym_bodyweight_is_one_row_per_day_and_the_later_recorded_at_wins) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgBodyweightRepository repo{wm::pgTestPool()};
  fake::FakeGym twin;

  CHECK_EQ(repo.entries(wm::UserId{kUser}, {}), std::vector<Bodyweight>{});
  CHECK_EQ(repo.latest(wm::UserId{kUser}), std::optional<Bodyweight>());
  std::vector<Bodyweight> answers;
  std::vector<Bodyweight> twinAnswers;
  for (const Bodyweight& write : {at("2026-08-25", 82.4, kNow), at("2026-08-25", 82.9, kNow + 60'000),
                                  at("2026-08-25", 82.4, kNow),           // stale: loses
                                  at("2026-08-25", 82.9, kNow + 60'000),  // replay
                                  at("2026-08-25", 83.1, kNow + 60'000),  // tied: replaces
                                  at("2026-08-01", 83.0, kNow + 120'000),
                                  at("2026-08-25", 70.0, kNow + 999'000, kOther)}) {
    answers.push_back(repo.save(write));
    twinAnswers.push_back(twin.bodyweight.save(write));
  }

  CHECK_EQ(answers, twinAnswers);
  CHECK_EQ(answers[0], at("2026-08-25", 82.4, kNow));
  CHECK_EQ(answers[1], at("2026-08-25", 82.9, kNow + 60'000));
  CHECK_EQ(answers[2], at("2026-08-25", 82.9, kNow + 60'000));   // the row that stands
  CHECK_EQ(answers[3], at("2026-08-25", 82.9, kNow + 60'000));
  CHECK_EQ(answers[4], at("2026-08-25", 83.1, kNow + 60'000));
  CHECK_EQ(repo.entries(wm::UserId{kUser}, {}), twin.bodyweight.entries(wm::UserId{kUser}, {}));
  CHECK_EQ(daysOf(repo), (std::vector<std::string>{"2026-08-01", "2026-08-25"}));
  CHECK_EQ(repo.latest(wm::UserId{kUser}), std::optional<Bodyweight>(at("2026-08-25", 83.1, kNow + 60'000)));
  CHECK_EQ(repo.latest(wm::UserId{kUser}), twin.bodyweight.latest(wm::UserId{kUser}));
  CHECK_EQ(daysOf(repo, kOther), std::vector<std::string>{"2026-08-25"});
  CHECK_EQ(repo.entries(wm::UserId{kOther}, {})[0].weightKg, 70.0);
  reset();
}

TEST(pg_gym_bodyweight_reads_inside_inclusive_bounds_and_exports_as_text) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgBodyweightRepository repo{wm::pgTestPool()};
  fake::FakeGym twin;
  for (const Bodyweight& write : {at("2026-08-25", 82.4, 1'700'000'000'000ull),
                                  at("2026-07-04", 84.0, 1'700'000'060'000ull),
                                  at("2026-08-01", 83.25, 1'700'000'120'000ull),
                                  at("2026-08-03", 83.0, 1'700'000'180'000ull),
                                  at("2026-08-02", 70.0, kNow, kOther)}) {
    repo.save(write);
    twin.bodyweight.save(write);
  }

  for (const BodyweightRange& range :
       {BodyweightRange{}, BodyweightRange{"2026-08-01", "2026-08-03"},
        BodyweightRange{"2026-08-02", ""}, BodyweightRange{"", "2026-08-01"},
        BodyweightRange{"2026-08-04", "2026-08-24"}, BodyweightRange{"2026-08-25", "2026-08-01"}})
    CHECK_EQ(repo.entries(wm::UserId{kUser}, range), twin.bodyweight.entries(wm::UserId{kUser}, range));
  CHECK_EQ(daysOf(repo, kUser, BodyweightRange{"2026-08-01", "2026-08-03"}),
           (std::vector<std::string>{"2026-08-01", "2026-08-03"}));
  CHECK_EQ(daysOf(repo), (std::vector<std::string>{"2026-07-04", "2026-08-01", "2026-08-03",
                                                    "2026-08-25"}));
  CHECK_EQ(repo.exported(wm::UserId{kUser}), twin.bodyweight.exported(wm::UserId{kUser}));
  CHECK_EQ(repo.exported(wm::UserId{kUser})[1],
           (ExportedBodyweight{"2026-08-01", "83.25", "2023-11-14T22:15:20Z"}));
  CHECK_EQ(repo.exported(wm::UserId{kUser})[3],
           (ExportedBodyweight{"2026-08-25", "82.40", "2023-11-14T22:13:20Z"}));
  reset();
}

TEST(pg_gym_bodyweight_remove_is_owner_scoped_and_absent_is_a_no_op) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgBodyweightRepository repo{wm::pgTestPool()};
  fake::FakeGym twin;
  for (const Bodyweight& write : {at("2026-08-25", 82.4), at("2026-08-01", 83.0),
                                  at("2026-08-25", 70.0, kNow, kOther)}) {
    repo.save(write);
    twin.bodyweight.save(write);
  }

  for (BodyweightRepository* store : {static_cast<BodyweightRepository*>(&repo),
                                      static_cast<BodyweightRepository*>(&twin.bodyweight)}) {
    store->remove(wm::UserId{kUser}, "2026-08-25");
    store->remove(wm::UserId{kUser}, "2026-08-25");
    store->remove(wm::UserId{kUser}, "2026-08-24");
  }

  CHECK_EQ(repo.entries(wm::UserId{kUser}, {}), twin.bodyweight.entries(wm::UserId{kUser}, {}));
  CHECK_EQ(daysOf(repo), std::vector<std::string>{"2026-08-01"});
  CHECK_EQ(daysOf(repo, kOther), std::vector<std::string>{"2026-08-25"});
  reset();
}

// Two writes to one day in flight at once: the primary key's row lock serializes them and the
// later instant stands whichever lands second; every flight answers with a row, never a 500.
TEST(pg_gym_bodyweight_overlapping_writes_to_one_day_leave_the_later_instant_standing) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgBodyweightRepository repo{wm::pgTestPool()};
  constexpr int kRacers = 8;
  std::vector<std::optional<Bodyweight>> answers(kRacers);
  std::vector<std::string> thrown(kRacers);
  std::latch together{kRacers};
  std::vector<std::thread> racers;
  for (int at = 0; at < kRacers; ++at)
    racers.emplace_back([&, at] {
      const Bodyweight write{wm::UserId{kUser}, "2026-08-25", 80.0 + at,
                             kNow + static_cast<std::uint64_t>(at) * 1000};
      together.arrive_and_wait();
      try {
        answers[at] = repo.save(write);
      } catch (const std::exception& failed) {
        thrown[at] = failed.what();
      }
    });
  for (std::thread& racer : racers) racer.join();

  for (int at = 0; at < kRacers; ++at) {
    CHECK_EQ(thrown[at], std::string(""));
    REQUIRE(answers[at].has_value());
    CHECK(answers[at]->recordedAtMs >= kNow + static_cast<std::uint64_t>(at) * 1000);
  }
  const std::vector<Bodyweight> held = repo.entries(wm::UserId{kUser}, {});
  REQUIRE_EQ(held.size(), std::size_t{1});
  CHECK_EQ(held[0], (Bodyweight{wm::UserId{kUser}, "2026-08-25", 80.0 + (kRacers - 1),
                                kNow + static_cast<std::uint64_t>(kRacers - 1) * 1000}));
  reset();
}

TEST(pg_gym_bodyweight_cascades_with_the_account) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgBodyweightRepository repo{wm::pgTestPool()};
  repo.save(at("2026-08-25", 82.4));
  repo.save(at("2026-08-25", 70.0, kNow, kOther));

  {
    wm::PgLease conn{*wm::pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec_params("DELETE FROM users WHERE id = $1::uuid", kUser);
    txn.commit();
  }
  CHECK_EQ(repo.entries(wm::UserId{kUser}, {}), std::vector<Bodyweight>{});
  CHECK_EQ(daysOf(repo, kOther), std::vector<std::string>{"2026-08-25"});
  reset();
}

// The columns carry the entity's band and its two decimals, and the day column refuses a day that
// is not one — written against raw SQL because the entity can never send these.
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
      wm::PgLease conn{*wm::pgTestPool()};
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
    wm::PgLease conn{*wm::pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec(row + "('" + kUser + "', '2026-08-25', 82.456, 1), ('" + kUser + "', '2026-08-26', 20, 1), "
             "('" + kUser + "', '2026-08-27', 400, 1), ('" + kUser + "', '2024-02-29', 19.996, 1)");
    txn.commit();
  }
  PgBodyweightRepository repo{wm::pgTestPool()};
  const std::vector<Bodyweight> held = repo.entries(wm::UserId{kUser}, {});
  REQUIRE_EQ(held.size(), std::size_t{4});
  CHECK_EQ(held[0], (Bodyweight{wm::UserId{kUser}, "2024-02-29", 19.996, 1}));   // both round to 20.00
  CHECK_EQ(held[1].weightKg, 82.46);
  CHECK_EQ(held[2].weightKg, 20.0);
  CHECK_EQ(held[3].weightKg, 400.0);
  reset();
}
