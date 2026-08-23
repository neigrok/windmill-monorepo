#include "products/gym/domain/Routine.h"

#include "test/testing.h"

#include <functional>
#include <optional>
#include <string>
#include <utility>
#include <vector>

using namespace wm::gym;

namespace {
RoutineEntry bench(int position = 1, int targetSets = 5, std::optional<int> targetReps = 5,
                   std::optional<double> targetWeightKg = 82.5,
                   std::optional<int> restSeconds = 180) {
  return RoutineEntry{position, ExerciseId{"bench-press"}, targetSets, targetReps, targetWeightKg,
                      restSeconds};
}

RoutineEntry squat(int position) {
  return RoutineEntry{position, ExerciseId{"back-squat"}, 3, 8, std::nullopt, std::nullopt};
}

Routine pushA(std::vector<RoutineEntry> entries) {
  return Routine{RoutineId{"rt_00000001"}, wm::UserId{"u1"}, "Push A", 0, std::move(entries)};
}

bool rejects(const std::function<void()>& build) {
  try {
    build();
    return false;
  } catch (const InvalidTraining&) {
    return true;
  }
}
}

TEST(routine_entry_accepts_the_full_legal_range) {
  CHECK_EQ(bench().targetSets, 5);
  CHECK_EQ(bench(1, 1, 1).targetSets, 1);
  CHECK_EQ(bench(1, 20, 100).targetSets, 20);
  CHECK_EQ(bench(1, 20, 100).targetReps, std::optional<int>(100));
  // Every optional means something by its absence: open, `3 × max`, last time's weight, rest.
  CHECK_EQ(bench(1, 5, 5, std::nullopt, std::nullopt).targetWeightKg, std::optional<double>());
  CHECK_EQ(bench(1, 5, 5, std::nullopt, std::nullopt).restSeconds, std::optional<int>());
  // Band-assisted work is a negative load on the same number line the sets are logged on.
  CHECK_EQ(bench(1, 5, 5, -20.0).targetWeightKg, std::optional<double>(-20.0));
  CHECK_EQ(bench(1, 5, 5, -500.0).targetWeightKg, std::optional<double>(-500.0));
  CHECK_EQ(bench(1, 5, 5, 500.0).targetWeightKg, std::optional<double>(500.0));
  CHECK_EQ(bench(1, 5, 5, 82.5, 15).restSeconds, std::optional<int>(15));
  CHECK_EQ(bench(1, 5, 5, 82.5, 900).restSeconds, std::optional<int>(900));
}

TEST(routine_entry_rejects_out_of_range_fields) {
  CHECK(rejects([] { bench(0); }));                       // positions start at 1
  CHECK(rejects([] { bench(-1); }));
  CHECK(rejects([] { bench(1, 0, 5); }));                 // zero sets is a target of nothing
  CHECK(rejects([] { bench(1, 21, 5); }));
  CHECK(rejects([] { bench(1, 5, 0); }));
  CHECK(rejects([] { bench(1, 5, 101); }));
  CHECK(rejects([] { bench(1, 5, 5, 500.5); }));
  CHECK(rejects([] { bench(1, 5, 5, -500.5); }));
  CHECK(rejects([] { bench(1, 5, 5, 82.5, 14); }));       // a rest the timer could not count
  CHECK(rejects([] { bench(1, 5, 5, 82.5, 901); }));
  CHECK(rejects([] {
    RoutineEntry{1, ExerciseId{""}, 5, 5, std::nullopt, std::nullopt};
  }));
}

TEST(routine_entry_holds_a_line_that_names_no_rep_target) {
  RoutineEntry chinUp{1, ExerciseId{"chin-up"}, 3, std::nullopt, std::nullopt, 180};

  CHECK_EQ(chinUp.targetSets, 3);
  CHECK_EQ(chinUp.targetReps, std::optional<int>());
  CHECK_EQ(bench(1, 5, std::nullopt).targetReps, std::optional<int>());
  CHECK(rejects([] { bench(1, 5, 0); }));
  CHECK(rejects([] { bench(1, 5, 101); }));
}

TEST(routine_entry_holds_an_open_line_that_names_no_target_at_all) {
  RoutineEntry open{1, ExerciseId{"barbell-row"}, std::nullopt, std::nullopt, std::nullopt,
                    std::nullopt};

  CHECK_EQ(open.targetSets, std::optional<int>());
  CHECK_EQ(open.targetReps, std::optional<int>());
  CHECK_EQ(open.targetWeightKg, std::optional<double>());
  // Rest is a wait, not a target, so it rides on an open line.
  CHECK_EQ(RoutineEntry(1, ExerciseId{"barbell-row"}, std::nullopt, std::nullopt, std::nullopt, 180)
               .restSeconds,
           std::optional<int>(180));
  CHECK(rejects([] { bench(1, 0); }));
}

TEST(routine_entry_refuses_a_half_open_line) {
  CHECK(rejects(
      [] { RoutineEntry(1, ExerciseId{"barbell-row"}, std::nullopt, 5, std::nullopt, std::nullopt); }));
  CHECK(rejects(
      [] { RoutineEntry(1, ExerciseId{"barbell-row"}, std::nullopt, std::nullopt, 60.0, std::nullopt); }));
}

TEST(routine_construction_guards_the_id_the_name_and_the_position) {
  Routine routine = pushA({bench(1), squat(2)});
  CHECK_EQ(routine.id.str(), std::string("rt_00000001"));
  CHECK_EQ(routine.name, std::string("Push A"));
  CHECK_EQ(routine.position, 0);
  CHECK_EQ(routine.entries, (std::vector<RoutineEntry>{bench(1), squat(2)}));
  CHECK_EQ(routine.lastTrainedAtMs, std::optional<std::uint64_t>());

  CHECK(rejects([] { Routine{RoutineId{"rt_001"}, wm::UserId{"u1"}, "Push A", 0, {bench(1)}}; }));
  CHECK(rejects([] { Routine{RoutineId{"rt_00000001"}, wm::UserId{""}, "Push A", 0, {bench(1)}}; }));
  CHECK(rejects([] { Routine{RoutineId{"rt_00000001"}, wm::UserId{"u1"}, "", 0, {bench(1)}}; }));
  CHECK(rejects([] { Routine{RoutineId{"rt_00000001"}, wm::UserId{"u1"}, " \t ", 0, {bench(1)}}; }));
  CHECK_EQ(Routine(RoutineId{"rt_00000001"}, wm::UserId{"u1"}, "  Push A  ", 0, {bench(1)}).name,
           std::string("Push A"));
  CHECK(rejects([] {
    Routine{RoutineId{"rt_00000001"}, wm::UserId{"u1"}, std::string(kMaxNameLength + 1, 'x'), 0,
            {bench(1)}};
  }));
  CHECK_EQ(Routine(RoutineId{"rt_00000001"}, wm::UserId{"u1"}, std::string(kMaxNameLength, 'x'), 0,
                   {bench(1)})
               .name.size(),
           kMaxNameLength);
  // A name stops at a NUL and must be UTF-8 (storableText, domain/Training.h).
  CHECK(rejects([] {
    Routine{RoutineId{"rt_00000001"}, wm::UserId{"u1"}, std::string("Push\0A", 6), 0, {bench(1)}};
  }));
  CHECK(rejects([] {
    Routine{RoutineId{"rt_00000001"}, wm::UserId{"u1"}, "Push \xED\xA0\x80 A", 0, {bench(1)}};
  }));
  CHECK(rejects([] { Routine{RoutineId{"rt_00000001"}, wm::UserId{"u1"}, "Push A", -1, {bench(1)}}; }));
  CHECK(rejects([] {
    Routine{RoutineId{"rt_00000001"}, wm::UserId{"u1"}, "Push A", 0, {bench(1)},
            std::optional<std::uint64_t>(0)};
  }));
  CHECK(rejects([] {
    Routine{RoutineId{"rt_00000001"}, wm::UserId{"u1"}, "Push A", 0, {bench(1)},
            std::optional<std::uint64_t>(kMaxInstantMs + 1)};
  }));
}

TEST(routine_construction_refuses_a_document_with_no_entries) {
  CHECK(rejects([] { pushA({}); }));
}

TEST(routine_construction_bounds_how_many_movements_one_day_may_hold) {
  const auto run = [](int lines) {
    std::vector<RoutineEntry> entries;
    for (int at = 1; at <= lines; ++at) entries.push_back(bench(at));
    return entries;
  };

  CHECK_EQ(pushA(run(kMaxRoutineEntries)).entries.size(),
           static_cast<std::size_t>(kMaxRoutineEntries));
  CHECK(rejects([&] { pushA(run(kMaxRoutineEntries + 1)); }));
  CHECK(rejects([&] { pushA(run(5'000)); }));
}

TEST(routine_positions_run_one_to_n_in_order) {
  CHECK_EQ(pushA({bench(1), squat(2), bench(3)}).entries.size(), static_cast<std::size_t>(3));
  CHECK(rejects([] { pushA({bench(2)}); }));                        // not 1-based
  CHECK(rejects([] { pushA({bench(1), squat(3)}); }));              // a gap
  CHECK(rejects([] { pushA({bench(1), squat(1)}); }));              // a duplicate
  CHECK(rejects([] { pushA({bench(2), squat(1)}); }));              // out of order
}

TEST(routine_holds_the_same_movement_twice_at_two_positions) {
  Routine routine = pushA({bench(1, 5, 5, 82.5), bench(2, 3, 12, 60.0)});

  REQUIRE_EQ(routine.entries.size(), static_cast<std::size_t>(2));
  CHECK_EQ(routine.entries[0].exercise, routine.entries[1].exercise);
  CHECK_EQ(routine.entries[0].targetWeightKg, std::optional<double>(82.5));
  CHECK_EQ(routine.entries[1].targetWeightKg, std::optional<double>(60.0));
}

TEST(snapshot_copies_the_name_and_every_line_in_order) {
  Routine routine = pushA({bench(1, 5, 5, 82.5, 180), squat(2)});

  PlanSnapshot snapshot = snapshotOf(routine);

  CHECK_EQ(snapshot,
           (PlanSnapshot{"Push A",
                         {PlanEntry{ExerciseId{"bench-press"}, 5, 5, 82.5, 180},
                          PlanEntry{ExerciseId{"back-squat"}, 3, 8, std::nullopt, std::nullopt}}}));
}

TEST(snapshot_copies_a_line_that_names_no_rep_target_as_naming_none) {
  Routine routine = pushA({RoutineEntry{1, ExerciseId{"chin-up"}, 3, std::nullopt, std::nullopt,
                                        180}});

  PlanSnapshot snapshot = snapshotOf(routine);

  CHECK_EQ(snapshot, (PlanSnapshot{"Push A", {PlanEntry{ExerciseId{"chin-up"}, 3, std::nullopt,
                                                        std::nullopt, 180}}}));
}

TEST(snapshot_copies_an_open_line_as_naming_nothing) {
  Routine routine = pushA({RoutineEntry{1, ExerciseId{"barbell-row"}, std::nullopt, std::nullopt,
                                        std::nullopt, std::nullopt}});

  PlanSnapshot snapshot = snapshotOf(routine);

  CHECK_EQ(snapshot, (PlanSnapshot{"Push A", {PlanEntry{ExerciseId{"barbell-row"}, std::nullopt,
                                                        std::nullopt, std::nullopt,
                                                        std::nullopt}}}));
}

TEST(snapshot_keeps_no_link_to_the_routine_it_was_taken_from) {
  Routine routine = pushA({bench(1)});

  PlanSnapshot snapshot = snapshotOf(routine);
  Routine renamed{routine.id, routine.user, "Push A (old)", 3, routine.entries};

  CHECK_EQ(snapshot, snapshotOf(pushA({bench(1)})));
  CHECK_EQ(snapshot.routineName, std::string("Push A"));
  CHECK_EQ(snapshotOf(renamed).routineName, std::string("Push A (old)"));
  CHECK_EQ(snapshotOf(renamed).entries, snapshot.entries);
}
