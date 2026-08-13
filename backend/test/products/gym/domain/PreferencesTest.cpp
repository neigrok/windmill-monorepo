#include "products/gym/domain/Preferences.h"

#include "test/testing.h"

#include <functional>
#include <optional>
#include <string>

using namespace wm::gym;

namespace {
// A legal document every bounds case perturbs one field of, so a refusal is about that field and
// never about an accident of the fixture.
GymPreferences settings(std::optional<int> restSeconds = 120, Unit units = Unit::kg) {
  return GymPreferences{wm::UserId{"u1"}, units, restSeconds, true, true, false};
}

// The code is the contract here, not the sentence: a client branches on it to say which row a lifter
// has to go back and fix, so every case below asserts the word and not the prose.
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
TEST(gym_preferences_default_to_kg_no_timer_and_confirmation_on) {
  const GymPreferences fresh{wm::UserId{"u1"}};

  CHECK_EQ(fresh.user, wm::UserId{"u1"});
  CHECK(fresh.units == Unit::kg);
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

// ---- the rest target, at both ends of its band ------------------------------------------------

TEST(gym_preferences_accept_the_full_legal_range) {
  CHECK_EQ(settings(std::nullopt).restSeconds, std::optional<int>());
  CHECK_EQ(settings(15).restSeconds, std::optional<int>(15));
  CHECK_EQ(settings(900).restSeconds, std::optional<int>(900));
  CHECK(settings(120, Unit::lb).units == Unit::lb);
}

TEST(gym_preferences_refuse_every_value_a_column_could_not_hold_and_name_which) {
  CHECK_EQ(refusalCode([] { settings(14); }), std::string("rest-target"));
  CHECK_EQ(refusalCode([] { settings(901); }), std::string("rest-target"));
}

// The refusal that is not the document's: an owner is not one of the rows a lifter fills in, so it
// carries no code and is the plain domain refusal every other entity in this product makes.
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
  CHECK_EQ(settings(kMinRestSeconds).restSeconds, std::optional<int>(15));
  CHECK_EQ(settings(kMaxRestSeconds).restSeconds, std::optional<int>(900));
}
