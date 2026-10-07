#include "products/gym/domain/Preferences.h"

#include <utility>

namespace wm::gym {

std::string toString(Unit units) { return units == Unit::lb ? "lb" : "kg"; }

Unit unitFromStored(std::string_view text) { return text == "lb" ? Unit::lb : Unit::kg; }

GymPreferences::GymPreferences(UserId user)
    : GymPreferences(std::move(user), Unit::kg, std::nullopt, true, true, false) {}

GymPreferences::GymPreferences(UserId user, Unit units, std::optional<int> restSeconds,
                               bool restSound, bool confirmHaptic, bool confirmSound)
    : user(std::move(user)), units(units), restSeconds(restSeconds), restSound(restSound),
      confirmHaptic(confirmHaptic), confirmSound(confirmSound) {
  if (this->user.empty()) throw InvalidTraining("preferences belong to an account");
  // The same band a routine line's rest target lives in, from the same pair of constants.
  if (restSeconds && (*restSeconds < kMinRestSeconds || *restSeconds > kMaxRestSeconds))
    throw InvalidTraining("a rest target runs from 15 to 900 seconds — send none for no timer");
}

}
