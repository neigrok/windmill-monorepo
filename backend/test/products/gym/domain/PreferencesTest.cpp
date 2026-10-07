#include "products/gym/domain/Preferences.h"

#include "test/testing.h"

#include <functional>
#include <optional>
#include <string>

using namespace wm::gym;

namespace {
GymPreferences settings(std::optional<int> restSeconds = 120, Unit units = Unit::kg) {
  return GymPreferences{wm::UserId{"u1"}, units, restSeconds, true, true, false};
}

std::string refusalOf(const std::function<void()>& build) {
  try {
    build();
    return "";
  } catch (const InvalidTraining& refused) {
    return refused.what();
  }
}
}

TEST(gym_preferences_default_to_kg_no_timer_and_confirmation_on) {
  const GymPreferences fresh{wm::UserId{"u1"}};

  CHECK_EQ(fresh.user, wm::UserId{"u1"});
  CHECK(fresh.units == Unit::kg);
  CHECK_EQ(fresh.restSeconds, std::optional<int>());
  CHECK_EQ(fresh.restSound, true);
  CHECK_EQ(fresh.confirmHaptic, true);
  CHECK_EQ(fresh.confirmSound, false);
}

TEST(gym_units_name_themselves_on_the_wire) {
  CHECK_EQ(toString(Unit::kg), std::string("kg"));
  CHECK_EQ(toString(Unit::lb), std::string("lb"));
}

TEST(gym_units_clamp_to_kg_when_the_store_holds_a_word_this_build_does_not_know) {
  CHECK(unitFromStored("kg") == Unit::kg);
  CHECK(unitFromStored("lb") == Unit::lb);
  CHECK(unitFromStored("st") == Unit::kg);
  CHECK(unitFromStored("") == Unit::kg);
}

TEST(gym_preferences_accept_the_full_legal_range) {
  CHECK_EQ(settings(std::nullopt).restSeconds, std::optional<int>());
  CHECK_EQ(settings(15).restSeconds, std::optional<int>(15));
  CHECK_EQ(settings(900).restSeconds, std::optional<int>(900));
  CHECK(settings(120, Unit::lb).units == Unit::lb);
}

TEST(gym_preferences_refuse_a_rest_target_off_the_band) {
  CHECK_EQ(refusalOf([] { settings(14); }), std::string("a rest target runs from 15 to 900 seconds — send none for no timer"));
  CHECK_EQ(refusalOf([] { settings(901); }), std::string("a rest target runs from 15 to 900 seconds — send none for no timer"));
}

TEST(gym_preferences_belong_to_an_account) {
  bool refused = false;
  try {
    GymPreferences{wm::UserId{""}};
  } catch (const InvalidTraining& malformed) {
    refused = std::string(malformed.what()) == "preferences belong to an account";
  }
  CHECK(refused);
}

TEST(gym_rest_band_is_the_one_a_routine_line_already_carries) {
  CHECK_EQ(kMinRestSeconds, 15);
  CHECK_EQ(kMaxRestSeconds, 900);
  CHECK_EQ(settings(kMinRestSeconds).restSeconds, std::optional<int>(15));
  CHECK_EQ(settings(kMaxRestSeconds).restSeconds, std::optional<int>(900));
}
