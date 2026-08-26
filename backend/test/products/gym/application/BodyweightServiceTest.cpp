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

// The store's rules over the fake, which applies the same ones as the SQL: one row per (account,
// day), the later `recordedAt` wins, owner scope, inclusive bounds, day ascending.
struct Harness {
  FakeGym repo;
  BodyweightService bodyweight{repo.bodyweight};

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

TEST(a_weigh_in_is_one_row_per_day_and_a_second_write_to_the_day_corrects_it) {
  Harness h;

  const Bodyweight first = h.bodyweight.save(h.at("2026-08-25", 82.4, kMorning));
  const Bodyweight corrected = h.bodyweight.save(h.at("2026-08-25", 82.9, kMorning + 60'000));

  CHECK_EQ(first, h.at("2026-08-25", 82.4, kMorning));
  CHECK_EQ(corrected, h.at("2026-08-25", 82.9, kMorning + 60'000));
  CHECK_EQ(h.repo.db.bodyweightRows.size(), std::size_t{1});
  CHECK_EQ(h.bodyweight.entries(uid(), BodyweightRange{}),
           std::vector<Bodyweight>{h.at("2026-08-25", 82.9, kMorning + 60'000)});
}

// The collision rule: the later `recordedAt` wins whichever order the writes arrive in, an equal
// instant replaces, and a stale replay reads back the correction rather than undoing it.
TEST(the_later_recorded_at_wins_and_a_stale_write_reads_back_the_row_that_stands) {
  Harness h;
  h.bodyweight.save(h.at("2026-08-25", 82.9, kMorning + 60'000));

  const Bodyweight stale = h.bodyweight.save(h.at("2026-08-25", 82.4, kMorning));
  const Bodyweight replay = h.bodyweight.save(h.at("2026-08-25", 82.9, kMorning + 60'000));
  const Bodyweight tied = h.bodyweight.save(h.at("2026-08-25", 83.1, kMorning + 60'000));
  const Bodyweight newer = h.bodyweight.save(h.at("2026-08-25", 83.3, kMorning + 120'000));

  CHECK_EQ(stale, h.at("2026-08-25", 82.9, kMorning + 60'000));   // unchanged, answered whole
  CHECK_EQ(replay, h.at("2026-08-25", 82.9, kMorning + 60'000));
  CHECK_EQ(tied, h.at("2026-08-25", 83.1, kMorning + 60'000));    // at or after replaces
  CHECK_EQ(newer, h.at("2026-08-25", 83.3, kMorning + 120'000));
  CHECK_EQ(h.repo.db.bodyweightRows.size(), std::size_t{1});
}

TEST(weigh_ins_read_day_ascending_inside_inclusive_bounds_and_owner_scoped) {
  Harness h;
  h.bodyweight.save(h.at("2026-08-25", 82.4, kMorning + 3));
  h.bodyweight.save(h.at("2026-07-04", 84.0, kMorning));
  h.bodyweight.save(h.at("2026-08-01", 83.2, kMorning + 1));
  h.bodyweight.save(h.at("2026-08-03", 83.0, kMorning + 2));
  h.bodyweight.save(h.at("2026-08-02", 70.0, kMorning, "u2"));

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
  h.bodyweight.save(h.at("2026-08-25", 82.4, kMorning));
  h.bodyweight.save(h.at("2026-08-01", 83.2, kMorning + 60'000));   // saved later, but an older day
  CHECK_EQ(h.bodyweight.latest(uid()), std::optional<Bodyweight>(h.at("2026-08-25", 82.4, kMorning)));
  CHECK_EQ(h.bodyweight.latest(UserId{"u2"}), std::optional<Bodyweight>());
}

TEST(removing_a_weigh_in_is_owner_scoped_and_a_day_that_is_not_a_day_names_nothing) {
  Harness h;
  h.bodyweight.save(h.at("2026-08-25", 82.4, kMorning));
  h.bodyweight.save(h.at("2026-08-25", 70.0, kMorning, "u2"));

  h.bodyweight.remove(UserId{"u3"}, "2026-08-25");
  CHECK_EQ(h.repo.db.bodyweightRows.size(), std::size_t{2});
  h.bodyweight.remove(uid(), "2026-02-30");
  h.bodyweight.remove(uid(), "not a day");
  CHECK_EQ(h.repo.db.bodyweightRows.size(), std::size_t{2});
  h.bodyweight.remove(uid(), "2026-08-25");
  h.bodyweight.remove(uid(), "2026-08-25");
  CHECK_EQ(h.daysOf(), std::vector<std::string>{});
  CHECK_EQ(h.daysOf("u2"), std::vector<std::string>{"2026-08-25"});
}

// Text end to end, as the SQL renders it: the day as stored, two decimals, the instant ISO UTC.
TEST(the_bodyweight_export_renders_every_value_as_the_store_does) {
  Harness h;
  h.bodyweight.save(h.at("2026-08-25", 82.4, 1'700'000'000'000ull));
  h.bodyweight.save(h.at("2026-08-01", 83.0, 1'700'000'060'000ull));
  h.bodyweight.save(h.at("2026-08-02", 70.0, kMorning, "u2"));

  CHECK_EQ(h.bodyweight.exported(uid()),
           (std::vector<ExportedBodyweight>{{"2026-08-01", "83.00", "2023-11-14T22:14:20Z"},
                                            {"2026-08-25", "82.40", "2023-11-14T22:13:20Z"}}));
  CHECK_EQ(h.bodyweight.exported(UserId{"u3"}), std::vector<ExportedBodyweight>{});
}
