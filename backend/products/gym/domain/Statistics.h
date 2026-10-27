#pragma once

#include "products/gym/domain/Progress.h"
#include "products/gym/domain/Training.h"

#include <cstdint>
#include <optional>
#include <vector>

namespace wm::gym {

// There is no statistics SURFACE: `GET /v1/gym/stats` and the `get_stats` tool are its only readers,
// so do not clean this up as unreachable code.
// e1RM is the headline, never volume. Tonnage as a caption clamps a negative load to zero, and a
// zero tonnage shows nothing rather than `0.0 t`.

// Weeks run Monday to Monday in UTC; the instant crosses as epoch-ms. A week with no training is
// present and zero, never missing.
struct TrainingWeek {
  std::uint64_t startedAtMs;
  int sessions;
  int workingSets;

  bool operator==(const TrainingWeek&) const = default;
};

// `sets` are every working set of this account's FINISHED sessions; the store selects them and the domain makes
// every estimate. Only finished sessions feed the weeks too.
struct TrainingLog {
  std::vector<ProgressSet> sets;
  std::vector<TrainingWeek> weeks;

  bool operator==(const TrainingLog&) const = default;
};

// A movement's top working set in one session, dated by the SESSION's start; `e1rm` is that set's own estimate,
// absent where it earned none.
struct MovementPoint {
  std::uint64_t atMs;
  double weightKg;
  int reps;
  std::optional<double> e1rm;

  bool operator==(const MovementPoint&) const = default;
};

// A movement's standing best and the set that holds it, dated by the SESSION it was set in.
struct Best {
  double weightKg;
  int reps;
  std::uint64_t atMs;
  std::optional<double> e1rm;

  bool operator==(const Best&) const = default;
};

// `bestE1rm` is chosen BY having an estimate, so its own is always there; `heaviest` is chosen by
// load, so it carries an estimate only where its set earned one.
struct MovementProgress {
  ExerciseId exercise;
  std::uint64_t lastTrainedAtMs;
  std::vector<MovementPoint> points;
  std::optional<Best> bestE1rm;
  std::optional<Best> heaviest;

  bool operator==(const MovementProgress&) const = default;
};

// Movements come back most recently trained first, ties broken by id so the walk is deterministic.
struct Statistics {
  std::vector<TrainingWeek> weeks;
  std::vector<MovementProgress> movements;

  bool operator==(const Statistics&) const = default;
};

// Stored nowhere.
Statistics statistics(const TrainingLog& log);

}
