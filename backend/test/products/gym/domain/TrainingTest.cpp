#include "products/gym/domain/Training.h"

#include "test/testing.h"

#include <functional>
#include <optional>
#include <string>

using namespace wm::gym;

namespace {
// A valid working set every bounds test perturbs one field of — proving the rejection is about
// that field, not an accident of the fixture.
Set set(double weightKg, int reps, SetKind kind = SetKind::working,
        std::optional<double> rpe = std::nullopt, std::string note = "",
        std::string id = "set_00000001") {
  return Set{SetId{std::move(id)}, SessionId{"ses_00000001"}, ExerciseId{"bench-press"}, 0,
             weightKg, reps, kind, rpe, std::move(note), 1'700'000'000'000};
}

bool rejects(const std::function<void()>& build) {
  try {
    build();
    return false;
  } catch (const InvalidTraining&) {
    return true;
  }
}

Session openSession(std::uint64_t startedAtMs) {
  return Session{SessionId{"ses_00000001"}, wm::UserId{"u1"}, startedAtMs};
}
}

// ---- codecs: strict on write, clamped on read ---------------------------------------------

TEST(set_kind_round_trips_through_its_codec) {
  CHECK_EQ(toString(SetKind::warmup), std::string("warmup"));
  CHECK_EQ(toString(SetKind::working), std::string("working"));
  CHECK_EQ(toString(SetKind::drop), std::string("drop"));
  CHECK_EQ(toString(SetKind::failure), std::string("failure"));
  CHECK(parseSetKind("warmup") == SetKind::warmup);
  CHECK(parseSetKind("working") == SetKind::working);
  CHECK(parseSetKind("drop") == SetKind::drop);
  CHECK(parseSetKind("failure") == SetKind::failure);
}

TEST(parse_set_kind_is_strict_an_unknown_word_throws) {
  CHECK(rejects([] { parseSetKind("amrap"); }));
  CHECK(rejects([] { parseSetKind(""); }));
  CHECK(rejects([] { parseSetKind("Working"); }));
}

TEST(set_kind_from_stored_clamps_unknown_to_working) {
  CHECK(setKindFromStored("warmup") == SetKind::warmup);
  CHECK(setKindFromStored("drop") == SetKind::drop);
  CHECK(setKindFromStored("failure") == SetKind::failure);
  CHECK(setKindFromStored("amrap") == SetKind::working);   // a newer deploy's kind can't crash us
  CHECK(setKindFromStored("") == SetKind::working);
}

TEST(pattern_parses_strictly_and_clamps_on_read) {
  CHECK(parsePattern("squat") == Pattern::squat);
  CHECK(parsePattern("hinge") == Pattern::hinge);
  CHECK(parsePattern("press") == Pattern::press);
  CHECK(parsePattern("pull") == Pattern::pull);
  CHECK(parsePattern("carry") == Pattern::carry);
  CHECK(parsePattern("core") == Pattern::core);
  CHECK(parsePattern("isolation") == Pattern::isolation);
  CHECK(rejects([] { parsePattern("legs"); }));
  CHECK(patternFromStored("legs") == Pattern::isolation);
  CHECK(patternFromStored("hinge") == Pattern::hinge);
}

TEST(equipment_parses_strictly_and_clamps_on_read) {
  CHECK(parseEquipment("barbell") == Equipment::barbell);
  CHECK(parseEquipment("dumbbell") == Equipment::dumbbell);
  CHECK(parseEquipment("machine") == Equipment::machine);
  CHECK(parseEquipment("cable") == Equipment::cable);
  CHECK(parseEquipment("bodyweight") == Equipment::bodyweight);
  CHECK(parseEquipment("kettlebell") == Equipment::kettlebell);
  CHECK(rejects([] { parseEquipment("bands"); }));
  CHECK(equipmentFromStored("bands") == Equipment::barbell);
  CHECK(equipmentFromStored("cable") == Equipment::cable);
}

// ---- the one id-shape rule ----------------------------------------------------------------

TEST(well_formed_id_is_8_to_64_url_safe_characters) {
  CHECK(wellFormedId("ses_0001"));                        // exactly 8
  CHECK(wellFormedId("set_a1B2-c3_d4"));
  CHECK(wellFormedId(std::string(64, 'a')));              // exactly 64
  CHECK_FALSE(wellFormedId("ses_001"));                   // 7 — too short
  CHECK_FALSE(wellFormedId(std::string(65, 'a')));        // too long
  CHECK_FALSE(wellFormedId("ses 0001"));                  // space
  CHECK_FALSE(wellFormedId("ses:0001"));                  // colon
  CHECK_FALSE(wellFormedId(""));
}

// ---- Set construction: an invalid set cannot exist in memory ------------------------------

TEST(set_construction_accepts_the_full_legal_range) {
  CHECK_EQ(set(82.5, 8).weightKg, 82.5);
  CHECK_EQ(set(-20.0, 8).weightKg, -20.0);                // band-assisted work is NEGATIVE and legal
  CHECK_EQ(set(-500.0, 8).weightKg, -500.0);
  CHECK_EQ(set(500.0, 8).weightKg, 500.0);
  CHECK_EQ(set(80.0, 1).reps, 1);
  CHECK_EQ(set(80.0, 500).reps, 500);
  CHECK_EQ(set(80.0, 8, SetKind::working, 8.5).rpe, std::optional<double>(8.5));
  CHECK_EQ(set(80.0, 8, SetKind::working, 1.0).rpe, std::optional<double>(1.0));
  CHECK_EQ(set(80.0, 8, SetKind::working, 10.0).rpe, std::optional<double>(10.0));
  CHECK_EQ(set(80.0, 8, SetKind::working, std::nullopt, std::string(4000, 'x')).note.size(),
           static_cast<std::size_t>(4000));
}

TEST(set_construction_rejects_out_of_range_fields) {
  CHECK(rejects([] { set(80.0, 0); }));                   // reps 0 is not a set that happened
  CHECK(rejects([] { set(80.0, 501); }));
  CHECK(rejects([] { set(500.5, 8); }));
  CHECK(rejects([] { set(-500.5, 8); }));
  CHECK(rejects([] { set(80.0, 8, SetKind::working, 0.5); }));
  CHECK(rejects([] { set(80.0, 8, SetKind::working, 10.5); }));
  CHECK(rejects([] { set(80.0, 8, SetKind::working, std::nullopt, std::string(4001, 'x')); }));
  CHECK(rejects([] { set(80.0, 8, SetKind::working, std::nullopt, "", "set_001"); }));   // 7 chars
  CHECK(rejects([] { set(80.0, 8, SetKind::working, std::nullopt, "", "bad id 00"); }));
  // Postgres text stops at a NUL, so the note would be stored truncated — refuse it instead.
  CHECK(rejects([] {
    set(80.0, 8, SetKind::working, std::nullopt, std::string("before\0after", 12));
  }));
  CHECK(rejects([] {
    Set{SetId{"set_00000001"}, SessionId{"ses_00000001"}, ExerciseId{"bench-press"}, 0, 80.0, 8,
        SetKind::working, std::nullopt, "", 0};                        // no completion instant
  }));
  CHECK(rejects([] {
    Set{SetId{"set_00000001"}, SessionId{"ses_00000001"}, ExerciseId{"bench-press"}, 0, 80.0, 8,
        SetKind::working, std::nullopt, "", kMaxInstantMs + 1};        // nanoseconds, not ms
  }));
  CHECK_EQ((Set{SetId{"set_00000001"}, SessionId{"ses_00000001"}, ExerciseId{"bench-press"}, 0,
                80.0, 8, SetKind::working, std::nullopt, "", kMaxInstantMs}).completedAtMs,
           kMaxInstantMs);
}

TEST(session_construction_guards_the_id_shape_and_both_instants) {
  Session session = openSession(1'700'000'000'000);
  CHECK_EQ(session.id.str(), std::string("ses_00000001"));
  CHECK_EQ(session.startedAtMs, 1'700'000'000'000ull);
  CHECK_EQ(session.finishedAtMs, std::optional<std::uint64_t>());
  CHECK_EQ(session.plan, std::optional<PlanSnapshot>());   // ad-hoc: no routine, no frozen plan
  CHECK(rejects([] { Session{SessionId{"short"}, wm::UserId{"u1"}, 1}; }));
  CHECK(rejects([] { Session{SessionId{"ses_00000001"}, wm::UserId{""}, 1}; }));
  CHECK(rejects([] { Session{SessionId{"ses_00000001"}, wm::UserId{"u1"}, 0}; }));
  // The instant band: a nanosecond-confused client wraps past what the store can hold, and the
  // wrapped row is unreadable forever — so the refusal happens before it can become a row.
  CHECK(rejects([] { Session{SessionId{"ses_00000001"}, wm::UserId{"u1"}, kMaxInstantMs + 1}; }));
  CHECK(rejects([] {
    Session{SessionId{"ses_00000001"}, wm::UserId{"u1"}, 1'700'000'000'000, 0};
  }));
  CHECK(rejects([] {
    Session{SessionId{"ses_00000001"}, wm::UserId{"u1"}, 1'700'000'000'000, kMaxInstantMs + 1};
  }));
  CHECK_EQ(Session(SessionId{"ses_00000001"}, wm::UserId{"u1"}, kMaxInstantMs).startedAtMs,
           kMaxInstantMs);
}

// ---- the equipment's default step ----------------------------------------------------------

// The numbers the 64 seed rows were written with, in one place a created movement can read them
// from: a lifter who adds a barbell lift gets the smallest plate pair without being asked, and the
// client never carries a copy of this table to keep in step.
TEST(default_step_is_the_equipments_own) {
  CHECK_EQ(defaultStepKg(Equipment::barbell), 2.5);
  CHECK_EQ(defaultStepKg(Equipment::dumbbell), 2.0);
  CHECK_EQ(defaultStepKg(Equipment::machine), 5.0);
  CHECK_EQ(defaultStepKg(Equipment::cable), 2.5);
  CHECK_EQ(defaultStepKg(Equipment::bodyweight), 2.5);
  CHECK_EQ(defaultStepKg(Equipment::kettlebell), 4.0);
}

// ---- Exercise construction: the catalog row -----------------------------------------------

TEST(exercise_construction_guards_the_name_and_the_step) {
  Exercise created{ExerciseId{"ex_11111111"}, "Zercher Squat", Pattern::squat, Equipment::barbell,
                   defaultStepKg(Equipment::barbell), true};
  CHECK_EQ(created.stepKg, 2.5);
  CHECK(created.custom);
  CHECK(rejects([] {
    Exercise{ExerciseId{""}, "Zercher Squat", Pattern::squat, Equipment::barbell, 2.5, true};
  }));
  CHECK(rejects([] {
    Exercise{ExerciseId{"ex_11111111"}, "", Pattern::squat, Equipment::barbell, 2.5, true};
  }));
  CHECK(rejects([] {
    Exercise{ExerciseId{"ex_11111111"}, "Zercher Squat", Pattern::squat, Equipment::barbell, 0, true};
  }));
  // Postgres text stops at a NUL and would keep the head of the name as the whole of it — the rule
  // the set note has always lived under, reaching the display name now that a lifter can create one.
  CHECK(rejects([] {
    Exercise{ExerciseId{"ex_11111111"}, std::string("Zercher\0Squat", 13), Pattern::squat,
             Equipment::barbell, 2.5, true};
  }));
  // The 64 seeded slugs are the schema's own and are shorter than any minted id may be, so the
  // catalog row does NOT carry the one id-shape rule — the wire applies it to a created movement.
  CHECK_EQ(Exercise(ExerciseId{"dip"}, "Dip", Pattern::press, Equipment::bodyweight, 2.5, false).id,
           ExerciseId{"dip"});
}

// step_kg is numeric(4,2) and both of its ends are the domain's to refuse. Above the ceiling the
// column raises a numeric overflow that leaves as a 500 — the status the ladder calls retryable, so
// a flush queue would resend an unstorable body forever — and below 0.01 the value rounds to 0.00,
// which the next read of that row refuses as a step that is not positive.
TEST(exercise_step_is_bounded_by_what_its_column_can_hold) {
  const auto stepOf = [](double stepKg) {
    return Exercise{ExerciseId{"ex_11111111"}, "Zercher Squat", Pattern::squat, Equipment::barbell,
                    stepKg, true}
        .stepKg;
  };
  CHECK_EQ(stepOf(kMinStepKg), 0.01);
  CHECK_EQ(stepOf(2.5), 2.5);
  CHECK_EQ(stepOf(kMaxStepKg), 99.99);
  CHECK(rejects([] {
    Exercise{ExerciseId{"ex_11111111"}, "Zercher Squat", Pattern::squat, Equipment::barbell, 100.0,
             true};
  }));
  CHECK(rejects([] {
    Exercise{ExerciseId{"ex_11111111"}, "Zercher Squat", Pattern::squat, Equipment::barbell, 1000.0,
             true};
  }));
  CHECK(rejects([] {
    Exercise{ExerciseId{"ex_11111111"}, "Zercher Squat", Pattern::squat, Equipment::barbell, 0.004,
             true};
  }));
  CHECK(rejects([] {
    Exercise{ExerciseId{"ex_11111111"}, "Zercher Squat", Pattern::squat, Equipment::barbell, -2.5,
             true};
  }));
}

// The catalog read hands back every movement this account can see on every open of the picker, so
// an unbounded display name is one that ships on the product's most-fired read forever. Eighty is
// the ceiling a routine's name already lives under, and they are the same kind of string.
TEST(exercise_name_is_capped_at_the_same_eighty_a_routine_name_is) {
  CHECK_EQ(Exercise(ExerciseId{"ex_11111111"}, std::string(kMaxNameLength, 'x'), Pattern::squat,
                    Equipment::barbell, 2.5, true)
               .name.size(),
           kMaxNameLength);
  CHECK(rejects([] {
    Exercise{ExerciseId{"ex_11111111"}, std::string(kMaxNameLength + 1, 'x'), Pattern::squat,
             Equipment::barbell, 2.5, true};
  }));
  CHECK(rejects([] {
    Exercise{ExerciseId{"ex_11111111"}, std::string(2'000'000, 'x'), Pattern::squat,
             Equipment::barbell, 2.5, true};
  }));
}

// ---- autoCloseAt: every branch ------------------------------------------------------------

TEST(auto_close_leaves_a_finished_session_alone) {
  Session session{SessionId{"ses_00000001"}, wm::UserId{"u1"}, 1'000, 2'000};
  CHECK_EQ(autoCloseAt(session, std::nullopt, 1'000 + 10 * kAutoCloseMs),
           std::optional<std::uint64_t>());
}

TEST(auto_close_leaves_a_fresh_open_session_alone) {
  Session session = openSession(1'000);
  CHECK_EQ(autoCloseAt(session, std::nullopt, 1'000), std::optional<std::uint64_t>());
  CHECK_EQ(autoCloseAt(session, std::nullopt, 1'000 + kAutoCloseMs - 1),
           std::optional<std::uint64_t>());   // one ms shy of stale
}

TEST(auto_close_of_a_setless_session_closes_at_its_start) {
  Session session = openSession(1'000);
  CHECK_EQ(autoCloseAt(session, std::nullopt, 1'000 + kAutoCloseMs),
           std::optional<std::uint64_t>(1'000));
}

TEST(auto_close_with_sets_closes_at_the_last_set_not_at_notice_time) {
  Session session = openSession(1'000);
  const std::uint64_t lastSetAt = 5'000'000;
  CHECK_EQ(autoCloseAt(session, lastSetAt, lastSetAt + kAutoCloseMs - 1),
           std::optional<std::uint64_t>());   // the last set keeps it alive
  CHECK_EQ(autoCloseAt(session, lastSetAt, lastSetAt + 10 * kAutoCloseMs),
           std::optional<std::uint64_t>(lastSetAt));   // ended at the rep, not the read
}

// ---- canFinishAt: the explicit end, clock-free -------------------------------------------

TEST(can_finish_at_any_instant_from_the_start_onward) {
  Session session = openSession(1'700'000'000'000);
  CHECK(canFinishAt(session, 1'700'000'000'000));            // a session with one rep in it
  CHECK(canFinishAt(session, 1'700'003'600'000));            // an hour under the bar
  CHECK(canFinishAt(session, kMaxInstantMs));
}

TEST(can_finish_at_refuses_zero_the_ceiling_and_ending_before_beginning) {
  Session session = openSession(1'700'000'000'000);
  CHECK_FALSE(canFinishAt(session, 0));                      // an unset clock, not an ending
  CHECK_FALSE(canFinishAt(session, 1'699'999'999'999));       // one ms before it began
  CHECK_FALSE(canFinishAt(session, 1));
  CHECK_FALSE(canFinishAt(session, kMaxInstantMs + 1));
  CHECK_FALSE(canFinishAt(session, 18'446'744'073'709'551'615ull));
}
