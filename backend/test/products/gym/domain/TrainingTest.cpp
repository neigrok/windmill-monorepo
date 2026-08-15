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
  // A name of nothing but blanks is the empty one in disguise: it used to store, and then rendered
  // as a movement with no name in its own header, the picker and every log row it appeared on.
  CHECK(rejects([] {
    Exercise{ExerciseId{"ex_11111111"}, "   ", Pattern::squat, Equipment::barbell, 2.5, true};
  }));
  // And an ordinary name keeps its middle and loses its ends, so " Bench Press " and "Bench Press"
  // are one movement in the picker rather than two rows a lifter has to tell apart.
  CHECK_EQ(Exercise(ExerciseId{"ex_11111111"}, "\t Front Squat \n", Pattern::squat,
                    Equipment::barbell, 2.5, true)
               .name,
           std::string("Front Squat"));
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

// A start may sit anywhere in the past — a basement's set carries the instant it happened — and
// up to five minutes past the log's now, which is the skew an honest clock is allowed. Past that
// it is a workout in the future, and the trap the header describes.
TEST(can_start_at_the_past_now_and_an_honest_clocks_skew) {
  const std::uint64_t now = 1'700'000'000'000;
  CHECK(canStartAt(1'600'000'000'000, now));                 // long ago
  CHECK(canStartAt(now, now));
  CHECK(canStartAt(now + kMaxClockAheadMs, now));            // exactly the allowance
}

TEST(can_start_at_refuses_a_start_past_the_clocks_allowance) {
  const std::uint64_t now = 1'700'000'000'000;
  CHECK_FALSE(canStartAt(now + kMaxClockAheadMs + 1, now));  // one ms past it
  CHECK_FALSE(canStartAt(now + 24ull * 60 * 60 * 1000, now)); // "tomorrow"
}

// ---- corrected: the fix, and what a fix may not reach ---------------------------------------

TEST(a_fix_that_names_nothing_leaves_the_set_exactly_as_it_was) {
  const Set stored = set(82.5, 8, SetKind::working, 8.5, "felt heavy");

  CHECK_EQ(corrected(stored, SetFix{}), stored);
}

TEST(a_fix_replaces_only_the_fields_it_names) {
  const Set stored = set(82.5, 8, SetKind::working, 8.5, "felt heavy");

  SetFix weight;
  weight.weightKg = 80.0;
  CHECK_EQ(corrected(stored, weight), set(80.0, 8, SetKind::working, 8.5, "felt heavy"));

  SetFix reps;
  reps.reps = 4;
  CHECK_EQ(corrected(stored, reps), set(82.5, 4, SetKind::working, 8.5, "felt heavy"));

  SetFix kind;
  kind.kind = SetKind::warmup;
  CHECK_EQ(corrected(stored, kind), set(82.5, 8, SetKind::warmup, 8.5, "felt heavy"));

  SetFix note;
  note.note = "";
  CHECK_EQ(corrected(stored, note), set(82.5, 8, SetKind::working, 8.5, ""));

  SetFix everything;
  everything.weightKg = 47.5;
  everything.reps = 5;
  everything.kind = SetKind::drop;
  everything.note = "back-off";
  CHECK_EQ(corrected(stored, everything), set(47.5, 5, SetKind::drop, 8.5, "back-off"));
}

// rpe is the one value a fix can also remove, so it takes two fields: unnamed keeps what is stored,
// named-and-empty clears it, named-with-a-value replaces it.
TEST(a_fix_clears_an_rpe_only_when_it_names_it) {
  const Set stored = set(82.5, 8, SetKind::working, 8.5);

  SetFix unnamed;
  CHECK_EQ(corrected(stored, unnamed).rpe, std::optional<double>(8.5));

  SetFix cleared;
  cleared.rpeNamed = true;
  CHECK_EQ(corrected(stored, cleared).rpe, std::optional<double>());

  SetFix replaced;
  replaced.rpeNamed = true;
  replaced.rpe = 9.5;
  CHECK_EQ(corrected(stored, replaced).rpe, std::optional<double>(9.5));
}

// The caption of the whole screen, at the one layer that could break it: the movement, the instant,
// the number and the session a set was lived in are carried through, whatever a fix says.
TEST(a_fix_never_moves_the_identity_the_log_is_ordered_by) {
  const Set stored{SetId{"set_00000001"}, SessionId{"ses_00000001"}, ExerciseId{"bench-press"}, 3,
                   82.5, 8, SetKind::working, std::nullopt, "", 1'700'000'000'000};
  SetFix fix;
  fix.weightKg = 60.0;
  fix.reps = 12;
  fix.kind = SetKind::failure;

  const Set fixed = corrected(stored, fix);

  CHECK_EQ(fixed.id, stored.id);
  CHECK_EQ(fixed.session, stored.session);
  CHECK_EQ(fixed.exercise, stored.exercise);
  CHECK_EQ(fixed.setNumber, 3);
  CHECK_EQ(fixed.completedAtMs, 1'700'000'000'000ull);
  CHECK_EQ(fixed.weightKg, 60.0);
  CHECK_EQ(fixed.reps, 12);
  CHECK(fixed.kind == SetKind::failure);
}

// The correction is a CONSTRUCTION, so every bound a logged set is held to holds here too — and it
// is refused before the store is ever offered the row, which is the whole reason the rule is pure.
TEST(a_fix_to_a_value_the_store_cannot_hold_is_refused_by_the_construction) {
  const Set stored = set(82.5, 8);

  CHECK(rejects([&] {
    SetFix fix;
    fix.reps = 0;
    corrected(stored, fix);
  }));
  CHECK(rejects([&] {
    SetFix fix;
    fix.reps = 501;
    corrected(stored, fix);
  }));
  CHECK(rejects([&] {
    SetFix fix;
    fix.weightKg = 500.5;
    corrected(stored, fix);
  }));
  CHECK(rejects([&] {
    SetFix fix;
    fix.rpeNamed = true;
    fix.rpe = 10.5;
    corrected(stored, fix);
  }));
  CHECK(rejects([&] {
    SetFix fix;
    fix.note = std::string("x") + '\0' + "y";
    corrected(stored, fix);
  }));
  // Bytes that are not UTF-8, which the column refuses mid-transaction where the answer would be a
  // retryable 500 on a body that can never land. Refused here, terminally, as a 400.
  CHECK(rejects([&] {
    SetFix fix;
    fix.note = "ok \xED\xA0\x80 bad";
    corrected(stored, fix);
  }));
}

// WHAT A `text` COLUMN CAN ACTUALLY HOLD, and it is one rule for every piece of free text this
// product accepts — a set's note, a movement's name, a routine's name. Postgres stores UTF-8 and
// refuses anything else as it takes the parameter, so a string that fails here is a string no retry
// can ever land: the domain owes it a 400 rather than the house 500 that the wire calls retryable.
// A NUL belongs to the same rule with a quieter failure — `text` stops at one, and the head of a
// lifter's words would store as if it were the whole of them.
TEST(storable_text_is_what_a_text_column_can_take_and_nothing_else) {
  CHECK(storableText(""));
  CHECK(storableText("felt heavy"));
  // Every width the encoding has, and each is ordinary content: an accent, Cyrillic, a CJK glyph and
  // an emoji off the astral plane.
  CHECK(storableText("Bänkpress · Присед · 懸垂 · 💪"));
  CHECK_FALSE(storableText(std::string("head\0tail", 9)));
  // A continuation byte with no lead, and a lead with no continuations.
  CHECK_FALSE(storableText("\x80"));
  CHECK_FALSE(storableText("\xC3"));
  // The overlong forms — the same code points spelled in more bytes than they need, which is how a
  // NUL or a '/' sneaks past a validator that only reads the decoded text.
  CHECK_FALSE(storableText("\xC0\x80"));
  CHECK_FALSE(storableText("\xE0\x80\xAF"));
  CHECK_FALSE(storableText("\xF0\x80\x80\xAF"));
  // A surrogate half is not a character; UTF-8 has no encoding for one and Postgres takes neither.
  CHECK_FALSE(storableText("\xED\xA0\x80"));
  CHECK_FALSE(storableText("\xED\xBF\xBF"));
  // Past the last plane, U+10FFFF.
  CHECK_FALSE(storableText("\xF4\x90\x80\x80"));
  CHECK_FALSE(storableText("\xF5\x80\x80\x80"));
  // Truncated at the end of the string, which is what a byte-sliced note arrives as.
  CHECK_FALSE(storableText("ok \xF0\x9F\x92"));

  // And it is the rule the three entities that hold free text are built on, not a predicate sitting
  // beside them: each refuses the same bytes at construction.
  CHECK(rejects([] {
    Set{SetId{"set_11111111"}, SessionId{"ses_11111111"}, ExerciseId{"bench-press"}, 1, 82.5, 8,
        SetKind::working, std::nullopt, "\xED\xA0\x80", 1'700'000'000'000};
  }));
  CHECK(rejects([] {
    Exercise{ExerciseId{"ex_11111111"}, "Zercher \xED\xA0\x80 Squat", Pattern::squat,
             Equipment::barbell, 2.5, true};
  }));
}
