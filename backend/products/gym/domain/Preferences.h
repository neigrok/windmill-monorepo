#pragma once

#include "products/gym/domain/Training.h"

#include <optional>
#include <string>
#include <string_view>

namespace wm::gym {

// Carries a machine word beside its sentence, naming which value was wrong. An InvalidTraining, so
// existing handlers catch it unchanged.
struct InvalidPreference : InvalidTraining {
  std::string code;

  InvalidPreference(std::string code, const std::string& said);
};

// A display transform at the very edge. Kilograms are the only load this product stores, so this
// value reaches no write and no read that computes anything.
enum class Unit { kg, lb };

std::string toString(Unit units);
// Strict on write, clamped on read: an unknown unit in a request is a refusal; an unknown stored
// word reads as kg rather than failing every read of that account.
Unit parseUnit(std::string_view text);        // throws InvalidPreference
Unit unitFromStored(std::string_view text);

// One settings row per ACCOUNT, never per device. An absent restSeconds means the lifter runs no
// timer — it is not a zero and no client draws it as one.
struct GymPreferences {
  UserId user;
  Unit units;
  std::optional<int> restSeconds;
  bool restSound;
  bool confirmHaptic;
  bool confirmSound;

  // The defaults for a lifter who has never opened this screen: kg, no rest timer, confirmation on.
  explicit GymPreferences(UserId user);

  GymPreferences(UserId user, Unit units, std::optional<int> restSeconds, bool restSound,
                 bool confirmHaptic, bool confirmSound);

  bool operator==(const GymPreferences&) const = default;
};

}
