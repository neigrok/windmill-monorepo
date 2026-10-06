#include "products/gym/application/BodyweightService.h"

#include "test/products/gym/Fakes.h"
#include "test/testing.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::gym;
using namespace wm::gym::fake;

namespace {

// Reads over weigh-ins seeded straight into the store: the writes arrive through /v1/sync.
struct Harness {
  FakeGym repo;
  BodyweightService bodyweight{repo.bodyweight};

  void weighed(const std::string& day, double weightKg, std::uint64_t recordedAtMs,
               const std::string& user = "u1") {
    repo.db.bodyweightRows.push_back(at(day, weightKg, recordedAtMs, user));
  }

  Bodyweight at(const std::string& day, double weightKg, std::uint64_t recordedAtMs,
                const std::string& user = "u1") {
    return Bodyweight{UserId{user}, day, weightKg, recordedAtMs};
  }

  std::vector<std::string> daysOf(const std::string& user = "u1", BodyweightRange range = {}) {
    std::vector<std::string> days;
    for (const Bodyweight& held : bodyweight.entries(UserId{user}, range))
      days.push_back(held.dateLocal);
    return days;
  }
};

constexpr std::uint64_t kMorning = 1'786'000'000'000ull;

}  // namespace

TEST(weigh_ins_read_day_ascending_inside_inclusive_bounds_and_owner_scoped) {
  Harness h;
  h.weighed("2026-08-25", 82.4, kMorning + 3);
  h.weighed("2026-07-04", 84.0, kMorning);
  h.weighed("2026-08-01", 83.2, kMorning + 1);
  h.weighed("2026-08-03", 83.0, kMorning + 2);
  h.weighed("2026-08-02", 70.0, kMorning, "u2");

  CHECK_EQ(h.daysOf(), (std::vector<std::string>{"2026-07-04", "2026-08-01", "2026-08-03",
                                                  "2026-08-25"}));
  CHECK_EQ(h.daysOf("u1", BodyweightRange{"2026-08-01", "2026-08-03"}),
           (std::vector<std::string>{"2026-08-01", "2026-08-03"}));
  CHECK_EQ(h.daysOf("u1", BodyweightRange{"2026-08-02", ""}),
           (std::vector<std::string>{"2026-08-03", "2026-08-25"}));
  CHECK_EQ(h.daysOf("u1", BodyweightRange{"", "2026-08-01"}),
           (std::vector<std::string>{"2026-07-04", "2026-08-01"}));
  CHECK_EQ(h.daysOf("u1", BodyweightRange{"2026-08-04", "2026-08-24"}), std::vector<std::string>{});
  CHECK_EQ(h.daysOf("u1", BodyweightRange{"2026-08-25", "2026-08-01"}), std::vector<std::string>{});
  CHECK_EQ(h.daysOf("u2"), std::vector<std::string>{"2026-08-02"});
  CHECK_EQ(h.daysOf("u3"), std::vector<std::string>{});
}

// The reading at the head of the log: the newest DAY, whatever window the chart asked for, and
// nothing at all for an account that never weighed in.
TEST(latest_is_the_newest_day_and_absent_for_an_account_that_never_weighed_in) {
  Harness h;

  CHECK_EQ(h.bodyweight.latest(uid()), std::optional<Bodyweight>());
  h.weighed("2026-08-25", 82.4, kMorning);
  h.weighed("2026-08-01", 83.2, kMorning + 60'000);   // recorded later, but an older day
  CHECK_EQ(h.bodyweight.latest(uid()), std::optional<Bodyweight>(h.at("2026-08-25", 82.4, kMorning)));
  CHECK_EQ(h.bodyweight.latest(UserId{"u2"}), std::optional<Bodyweight>());
}
