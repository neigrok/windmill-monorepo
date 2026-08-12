#include "products/gym/domain/Preferences.h"

#include <algorithm>
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
    : GymPreferences(std::move(user), Unit::kg, kDefaultBarWeightKg,
                     std::vector<double>(kFullPlateSetKg.begin(), kFullPlateSetKg.end()),
                     std::nullopt, true, true, false) {}

GymPreferences::GymPreferences(UserId user, Unit units, double barWeightKg,
                               std::vector<double> platesKg, std::optional<int> restSeconds,
                               bool restSound, bool confirmHaptic, bool confirmSound)
    : user(std::move(user)), units(units), barWeightKg(barWeightKg), platesKg(std::move(platesKg)),
      restSeconds(restSeconds), restSound(restSound), confirmHaptic(confirmHaptic),
      confirmSound(confirmSound) {
  if (this->user.empty()) throw InvalidTraining("preferences belong to an account");
  // Written as a refused NEGATION rather than two comparisons, so a NaN arriving from a wire that
  // permits one fails both bounds and is refused, instead of passing a pair of `<` tests that are
  // each false about it.
  if (!(barWeightKg >= 0 && barWeightKg <= kMaxBarWeightKg))
    throw InvalidPreference("bar-weight", "a bar weighs from 0 to 100 kg");
  for (const double plate : this->platesKg)
    if (!(plate >= kMinPlateKg && plate <= kMaxPlateKg))
      throw InvalidPreference("plate-weight", "a plate weighs from 0.01 to 100 kg");
  // Normalized before it is counted: heaviest first, each kind once. The cap is on the KINDS a gym
  // holds, so a body that names 2.5 three times spends one of the twelve and not three.
  std::sort(this->platesKg.begin(), this->platesKg.end(),
            [](double heavier, double lighter) { return heavier > lighter; });
  this->platesKg.erase(std::unique(this->platesKg.begin(), this->platesKg.end()),
                       this->platesKg.end());
  if (this->platesKg.size() > kMaxPlateKinds)
    throw InvalidPreference("too-many-plates", "a gym holds at most 12 kinds of plate");
  // The same band a routine line's rest target lives in, from the same pair of constants: a program
  // that could ask for a wait the global dial refuses would be two rules about one rest.
  if (restSeconds && (*restSeconds < kMinRestSeconds || *restSeconds > kMaxRestSeconds))
    throw InvalidPreference("rest-target",
                            "a rest target runs from 15 to 900 seconds — send none for no timer");
}

}
