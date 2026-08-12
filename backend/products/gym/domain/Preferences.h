#pragma once

#include "products/gym/domain/Training.h"

#include <array>
#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace wm::gym {

// The refusal a settings write makes, and the ONE place in gym where a malformed value carries a
// machine word out with it. Every other 400 in this product has a single cause and the sentence is
// the whole of it; a settings document is five independent values arriving at once, so a client told
// only "could not read that" has to guess which of the five it got wrong — and one of the five is a
// list, where the guess is a list too. It IS an InvalidTraining, so every `catch (const
// InvalidTraining&)` already written still catches it and no handler has to learn a second type.
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
// Strict on write, clamped on read — the rule the pattern, equipment and set-kind words already
// live under. An unknown unit in a request is a refusal and never a silent downgrade of what the
// lifter chose; an unknown STORED word (a unit a newer deploy added) reads as kg rather than taking
// down every read of that account.
Unit parseUnit(std::string_view text);        // throws InvalidPreference
Unit unitFromStored(std::string_view text);

// What the columns hold, refused here so a document that cannot be stored is never built. A bar runs
// from 0 — the lifter loading a machine or a pair of dumbbells has no bar at all — up past every
// specialty bar ever made. A plate weighs something, and less than the same ceiling. Both sit in
// numeric(5,2) at rest, so the 20.41 kg of a 45 lb bar survives the round trip.
constexpr double kDefaultBarWeightKg = 20.0;
constexpr double kMaxBarWeightKg = 100.0;
constexpr double kMinPlateKg = 0.01;
constexpr double kMaxPlateKg = 100.0;

// Seven is the full set §I draws; twelve leaves room for the micro plates a lifter owns beside them
// and bounds the one field here that is a list. The rule is Routine's: a document with no size bound
// is a write with no size bound. It counts KINDS of plate, so a body that sends 2.5 twice is one 2.5
// and not two of the twelve.
constexpr std::size_t kMaxPlateKinds = 12;

// What a gym with a barbell in it owns, one side of the bar.
constexpr std::array<double, 7> kFullPlateSetKg{25, 20, 15, 10, 5, 2.5, 1.25};

// The five settings of §I, one row per account. Four of them are about a barbell and the fifth is
// about a phone, and every one belongs to the ACCOUNT rather than the device: a lifter reads in one
// unit everywhere, the plates are their GYM's and not their handset's, and the rest target is their
// program's. The confirmation pair is the one worth stating out loud — it records the lifter's
// INTENT, and each surface honours what it can (a native haptic where there is one, a sound where
// there is not), so a surface that cannot vibrate says so where the row is drawn rather than moving
// and doing nothing.
//
// platesKg is ONE SIDE of the bar, heaviest first and each kind once. The order and the duplicates
// are normalized rather than refused, which is the rule `trimmedName` follows for the other value a
// lifter types: a chip list arriving unsorted says exactly what a sorted one says, and a gym that
// owns two 2.5s owns 2.5s. The ordering is not decoration — the readout under the numeral walks the
// set heaviest-first, and a store that handed it back shuffled would make three surfaces sort it.
//
// An absent restSeconds MEANS something, exactly as an absent target weight on a routine line does:
// the lifter runs no timer. It is not a zero, and no client draws it as one.
struct GymPreferences {
  UserId user;
  Unit units;
  double barWeightKg;
  std::vector<double> platesKg;
  std::optional<int> restSeconds;
  bool restSound;
  bool confirmHaptic;
  bool confirmSound;

  // The answer for a lifter who has never opened this screen, which is most of them: kg, a 20 kg
  // bar, the full plate set, the rest timer OFF, and confirmation on wherever a platform has one.
  // Rest is off because a timer nobody asked for that starts beeping in a gym is the kind of thing
  // this product does not do; restSound is on beneath it because it is what the timer does once the
  // lifter turns the timer on, and it is silent until they do.
  explicit GymPreferences(UserId user);

  GymPreferences(UserId user, Unit units, double barWeightKg, std::vector<double> platesKg,
                 std::optional<int> restSeconds, bool restSound, bool confirmHaptic,
                 bool confirmSound);

  bool operator==(const GymPreferences&) const = default;
};

}
