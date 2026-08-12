#include "products/gym/domain/Preferences.h"

#include "test/testing.h"

#include <functional>
#include <optional>
#include <string>
#include <vector>

using namespace wm::gym;

namespace {
// A legal document every bounds case perturbs one field of, so a refusal is about that field and
// never about an accident of the fixture.
GymPreferences settings(double barWeightKg = 20.0,
                        std::vector<double> platesKg = {25, 20, 15, 10, 5, 2.5, 1.25},
                        std::optional<int> restSeconds = 120, Unit units = Unit::kg) {
  return GymPreferences{wm::UserId{"u1"}, units,     barWeightKg, std::move(platesKg),
                        restSeconds,      true,      true,        false};
}

// The code is the contract here, not the sentence: a client branches on it to say which of the five
// rows a lifter has to go back and fix, so every case below asserts the word and not the prose.
std::string refusalCode(const std::function<void()>& build) {
  try {
    build();
    return "";
  } catch (const InvalidPreference& refused) {
    return refused.code;
  }
}
}

// ---- the defaults, which are what most lifters are served forever --------------------------

// The whole of §I's "a lifter who never opens this screen is served", pinned as one value. Rest is
// absent — the timer is OFF — because a timer nobody asked for that starts beeping in a gym is the
// kind of thing this product does not do, and every surface reads that absence the same way.
TEST(gym_preferences_default_to_kg_a_20kg_bar_the_full_plate_set_and_no_timer) {
  const GymPreferences fresh{wm::UserId{"u1"}};

  CHECK_EQ(fresh.user, wm::UserId{"u1"});
  CHECK(fresh.units == Unit::kg);
  CHECK_EQ(fresh.barWeightKg, 20.0);
  CHECK_EQ(fresh.platesKg, (std::vector<double>{25, 20, 15, 10, 5, 2.5, 1.25}));
  CHECK_EQ(fresh.restSeconds, std::optional<int>());
  CHECK_EQ(fresh.restSound, true);
  CHECK_EQ(fresh.confirmHaptic, true);
  CHECK_EQ(fresh.confirmSound, false);
}

// ---- units: strict on write, clamped on read, and a display transform either way ------------

TEST(gym_units_parse_strictly_and_refuse_an_unknown_word) {
  CHECK(parseUnit("kg") == Unit::kg);
  CHECK(parseUnit("lb") == Unit::lb);
  CHECK_EQ(toString(Unit::kg), std::string("kg"));
  CHECK_EQ(toString(Unit::lb), std::string("lb"));

  // Not downgraded to kg, which is the whole point: a lifter who asked for stones and was silently
  // given kilograms was told nothing, and every number they read afterwards was wrong to them.
  CHECK_EQ(refusalCode([] { parseUnit("st"); }), std::string("unknown-unit"));
  CHECK_EQ(refusalCode([] { parseUnit("KG"); }), std::string("unknown-unit"));
  CHECK_EQ(refusalCode([] { parseUnit(""); }), std::string("unknown-unit"));
}

// A word a newer deploy adds to the column's check is a word this build has never heard of, and the
// answer is the safe default rather than an exception taking down every read of that account.
TEST(gym_units_clamp_to_kg_when_the_store_holds_a_word_this_build_does_not_know) {
  CHECK(unitFromStored("kg") == Unit::kg);
  CHECK(unitFromStored("lb") == Unit::lb);
  CHECK(unitFromStored("st") == Unit::kg);
  CHECK(unitFromStored("") == Unit::kg);
}

// ---- the bar and the plates, at both ends of every band -------------------------------------

TEST(gym_preferences_accept_the_full_legal_range) {
  CHECK_EQ(settings(0).barWeightKg, 0.0);        // a machine or a pair of dumbbells: no bar at all
  CHECK_EQ(settings(20.41).barWeightKg, 20.41);  // a 45 lb bar, and the two decimals it needs
  CHECK_EQ(settings(100).barWeightKg, 100.0);
  CHECK_EQ(settings(20, {}).platesKg, std::vector<double>{});   // a gym that owns no plates
  CHECK_EQ(settings(20, {0.01}).platesKg, std::vector<double>{0.01});
  CHECK_EQ(settings(20, {100}).platesKg, std::vector<double>{100.0});
  CHECK_EQ(settings(20, {25}, std::nullopt).restSeconds, std::optional<int>());
  CHECK_EQ(settings(20, {25}, 15).restSeconds, std::optional<int>(15));
  CHECK_EQ(settings(20, {25}, 900).restSeconds, std::optional<int>(900));
  CHECK(settings(20, {25}, 120, Unit::lb).units == Unit::lb);
}

TEST(gym_preferences_refuse_every_value_a_column_could_not_hold_and_name_which) {
  CHECK_EQ(refusalCode([] { settings(-1); }), std::string("bar-weight"));
  CHECK_EQ(refusalCode([] { settings(100.01); }), std::string("bar-weight"));
  CHECK_EQ(refusalCode([] { settings(20, {0}); }), std::string("plate-weight"));
  CHECK_EQ(refusalCode([] { settings(20, {-2.5}); }), std::string("plate-weight"));
  CHECK_EQ(refusalCode([] { settings(20, {100.01}); }), std::string("plate-weight"));
  CHECK_EQ(refusalCode([] { settings(20, {25}, 14); }), std::string("rest-target"));
  CHECK_EQ(refusalCode([] { settings(20, {25}, 901); }), std::string("rest-target"));
  CHECK_EQ(refusalCode([] {
             settings(20, {25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13});
           }),
           std::string("too-many-plates"));
  // Twelve distinct kinds is the ceiling and not the twelfth refusal.
  CHECK_EQ(settings(20, {25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14}).platesKg.size(),
           std::size_t{12});
}

// ---- the one normalization, and why it is not a refusal --------------------------------------

// The chip order a client sends carries no meaning and a gym that owns two 2.5s owns 2.5s, so both
// are normalized rather than refused — `trimmedName`'s rule for the other value a lifter states.
// Heaviest first is not decoration: the readout under the numeral walks the set in that order, and a
// store that handed it back shuffled would make three surfaces sort it.
TEST(gym_plate_set_comes_back_heaviest_first_with_each_kind_once) {
  CHECK_EQ(settings(20, {1.25, 25, 2.5, 20}).platesKg, (std::vector<double>{25, 20, 2.5, 1.25}));
  CHECK_EQ(settings(20, {2.5, 2.5, 2.5, 25}).platesKg, (std::vector<double>{25, 2.5}));
  // A duplicate spends none of the twelve, because the cap counts KINDS of plate: fifteen chips
  // naming three plates is a gym with three plates in it.
  CHECK_EQ(settings(20, {25, 25, 25, 20, 20, 20, 2.5, 2.5, 2.5, 25, 20, 2.5, 25, 20, 2.5}).platesKg,
           (std::vector<double>{25, 20, 2.5}));
}

// The refusal that is not the document's: an owner is not one of the five rows, so it carries no
// code and is the plain domain refusal every other entity in this product makes.
TEST(gym_preferences_belong_to_an_account) {
  bool refused = false;
  try {
    GymPreferences{wm::UserId{""}};
  } catch (const InvalidTraining& malformed) {
    refused = std::string(malformed.what()) == "preferences belong to an account";
  }
  CHECK(refused);
}

// ---- the rest band is ONE band ---------------------------------------------------------------

// The global dial and a routine line read the same two constants, so a program can never ask for a
// wait the dial refuses. Pinned here rather than assumed, because the two live in different files.
TEST(gym_rest_band_is_the_one_a_routine_line_already_carries) {
  CHECK_EQ(kMinRestSeconds, 15);
  CHECK_EQ(kMaxRestSeconds, 900);
  CHECK_EQ(settings(20, {25}, kMinRestSeconds).restSeconds, std::optional<int>(15));
  CHECK_EQ(settings(20, {25}, kMaxRestSeconds).restSeconds, std::optional<int>(900));
}
