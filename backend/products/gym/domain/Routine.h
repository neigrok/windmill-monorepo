#pragma once

#include "products/gym/domain/Training.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// No id: the table's key is (routine_id, position), which makes the same movement twice in one
// routine representable. Four fields mean something by their ABSENCE and never by a zero: no
// targetSets is an OPEN line, no targetReps is `max`, no targetWeightKg is "whatever you did last
// time", and no restSeconds falls back to the lifter's global rest target, applied by the surface
// running the timer and never by this server.
// An open line carries no targetSets, targetReps or targetWeightKg. Rest stays legal on one.
struct RoutineEntry {
  int position;
  ExerciseId exercise;
  std::optional<int> targetSets;
  std::optional<int> targetReps;
  std::optional<double> targetWeightKg;
  std::optional<int> restSeconds;

  RoutineEntry(int position, ExerciseId exercise, std::optional<int> targetSets,
               std::optional<int> targetReps, std::optional<double> targetWeightKg,
               std::optional<int> restSeconds);

  bool operator==(const RoutineEntry&) const = default;
};

// Every entry is one INSERT inside the single transaction a routine write is.
constexpr int kMaxRoutineEntries = 50;

// The client-minted id ('rt_<hex>') is the idempotency key. Entry ORDER is the routine order and the
// positions are dense and 1-based, refused at construction otherwise. A routine with no entries is
// not a plan. lastTrainedAtMs is the store's derived answer — the newest session started under this
// routine — absent until it has been trained.
// `revision` is the concurrency token a proposal is minted against: an apply lands only while the
// routine still stands at the revision the diff was computed from. It starts at 1 and moves on every
// write that changes the DOCUMENT or the NAME — never on a PUT landing the bytes that already stand,
// and never on a reorder of the routines screen. It is the STORE's to move; a client reads it and
// never sends it.
struct Routine {
  RoutineId id;
  UserId user;
  std::string name;
  int position;
  std::vector<RoutineEntry> entries;
  std::optional<std::uint64_t> lastTrainedAtMs;
  int revision;

  Routine(RoutineId id, UserId user, std::string name, int position,
          std::vector<RoutineEntry> entries,
          std::optional<std::uint64_t> lastTrainedAtMs = std::nullopt, int revision = 1);

  bool operator==(const Routine&) const = default;
};

// Frozen onto the session row at start from the store's own routine, never from a client body.
PlanSnapshot snapshotOf(const Routine& routine);

}
