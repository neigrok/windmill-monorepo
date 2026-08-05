#pragma once

#include "products/gym/domain/Training.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// One line of the program: this movement, this many sets of this many reps, at this load. It
// carries NO id, because the table's key is (routine_id, position) — which is what makes the same
// movement twice in one routine (bench heavy, then bench back-off) representable at all; Lift
// collapsed the pair into one set counter. Three of its fields mean something by their ABSENCE and
// never by a zero: an absent targetReps is `3 × max` — the chin-up line, a program a required rep
// target could not express at all — an absent targetWeightKg is "whatever you did last time", and
// an absent restSeconds is the client's own default.
struct RoutineEntry {
  int position;
  ExerciseId exercise;
  int targetSets;
  std::optional<int> targetReps;
  std::optional<double> targetWeightKg;
  std::optional<int> restSeconds;

  RoutineEntry(int position, ExerciseId exercise, int targetSets, std::optional<int> targetReps,
               std::optional<double> targetWeightKg, std::optional<int> restSeconds);

  bool operator==(const RoutineEntry&) const = default;
};

// A day of the program is a page a lifter reads between sets, and this is where that stops being a
// figure of speech: every entry is one INSERT inside the one transaction a routine write is, so a
// document with no size bound is a write with no size bound. Fifty lines is already far past
// anything the editor draws.
constexpr int kMaxRoutineEntries = 50;

// A day of the program, owned by one account. The client-minted id ('rt_<hex>') is the idempotency
// key exactly as a session's is, so it obeys the one id-shape rule. Entry ORDER is the routine
// order and the positions are dense and 1-based — a gap is a line the client cannot draw and the
// store's key would still hold, so it is refused where every other malformed value is, at
// construction. A routine with no entries is not a plan, and the editor never composes one.
// lastTrainedAtMs is the store's derived answer — the newest session started under this routine —
// and it is absent until the routine has been trained once.
struct Routine {
  RoutineId id;
  UserId user;
  std::string name;
  int position;
  std::vector<RoutineEntry> entries;
  std::optional<std::uint64_t> lastTrainedAtMs;

  Routine(RoutineId id, UserId user, std::string name, int position,
          std::vector<RoutineEntry> entries,
          std::optional<std::uint64_t> lastTrainedAtMs = std::nullopt);

  bool operator==(const Routine&) const = default;
};

// The copy the server freezes onto the session row at start. It is taken here, from the store's own
// routine, and never from a client-composed body: a client's copy freezes whatever that client last
// read, which is the exact staleness the snapshot exists to prevent.
PlanSnapshot snapshotOf(const Routine& routine);

}
