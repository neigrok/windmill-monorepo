#include "products/gym/domain/Preferences.h"

#include <utility>

namespace wm::gym {

InvalidPreference::InvalidPreference(std::string code, const std::string& said)
    : InvalidTraining(said), code(std::move(code)) {}

std::string toString(Unit units) { return units == Unit::lb ? "lb" : "kg"; }

Unit parseUnit(std::string_view text) {
  if (text == "kg") return Unit::kg;
  if (text == "lb") return Unit::lb;
  throw InvalidPreference("unknown-unit", "units are \"kg\" or \"lb\"");
}

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
    throw InvalidPreference("rest-target",
                            "a rest target runs from 15 to 900 seconds — send none for no timer");
}

}
