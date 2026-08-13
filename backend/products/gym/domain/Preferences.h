#pragma once

#include "products/gym/domain/Training.h"

#include <optional>
#include <string>
#include <string_view>

namespace wm::gym {

// The refusal a settings write makes, and the ONE place in gym where a malformed value carries a
// machine word out with it. Every other 400 in this product has a single cause and the sentence is
// the whole of it; a settings document is several independent values arriving at once, so a client
// told only "could not read that" has to guess which of them it got wrong. It IS an InvalidTraining,
// so every `catch (const InvalidTraining&)` already written still catches it and no handler has to
// learn a second type.
struct InvalidPreference : InvalidTraining {
  std::string code;

  InvalidPreference(std::string code, const std::string& said);
};

// The unit a lifter READS in, and the whole of what it is: a display transform at the very edge.
// Kilograms are the only load this product stores — every column, every wire number, every rule —
// so this value reaches no write and no read that computes anything. Switching to `lb` changes what
// a screen prints and nothing about what was lifted; history does not get rewritten (§I).
enum class Unit { kg, lb };

std::string toString(Unit units);
// Strict on write, clamped on read — the rule the pattern and set-kind words already live under. An
// unknown unit in a request is a refusal and never a silent downgrade of what the lifter chose; an
// unknown STORED word (a unit a newer deploy added) reads as kg rather than taking down every read
// of that account.
Unit parseUnit(std::string_view text);        // throws InvalidPreference
Unit unitFromStored(std::string_view text);

// The settings of §I, one row per account, and every one belongs to the ACCOUNT rather than the
// device: a lifter reads in one unit everywhere, and the rest target is their program's. The
// confirmation pair is the one worth stating out loud — it records the lifter's INTENT, and each
// surface honours what it can (a native haptic where there is one, a sound where there is not), so a
// surface that cannot vibrate says so where the row is drawn rather than moving and doing nothing.
//
// There is nothing here about equipment, and that is a product decision rather than a gap: gyms are
// more or less the same, this product guides a program and tracks what was done, and it does not
// manage a plate inventory. The bar weight and the plate set this document used to carry were
// removed on 2026-08-13 along with the loading readout they fed.
//
// An absent restSeconds MEANS something, exactly as an absent target weight on a routine line does:
// the lifter runs no timer. It is not a zero, and no client draws it as one.
struct GymPreferences {
  UserId user;
  Unit units;
  std::optional<int> restSeconds;
  bool restSound;
  bool confirmHaptic;
  bool confirmSound;

  // The answer for a lifter who has never opened this screen, which is most of them: kg, the rest
  // timer OFF, and confirmation on wherever a platform has one. Rest is off because a timer nobody
  // asked for that starts beeping in a gym is the kind of thing this product does not do; restSound
  // is on beneath it because it is what the timer does once the lifter turns the timer on, and it is
  // silent until they do.
  explicit GymPreferences(UserId user);

  GymPreferences(UserId user, Unit units, std::optional<int> restSeconds, bool restSound,
                 bool confirmHaptic, bool confirmSound);

  bool operator==(const GymPreferences&) const = default;
};

}
