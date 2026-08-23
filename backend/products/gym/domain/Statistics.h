#pragma once

#include "products/gym/domain/Review.h"
#include "products/gym/domain/Training.h"

#include <cstdint>
#include <optional>
#include <vector>

namespace wm::gym {

// There is no statistics SURFACE: `GET /v1/gym/stats` and the `get_stats` tool are its only readers,
// so do not clean this up as unreachable code.
// e1RM is the headline, never volume. Tonnage as a caption clamps a negative load to zero, and a
// zero tonnage shows nothing rather than `0.0 t`.

// The instant is the SESSION's own start, never a set's `completed_at`. The set is the movement's
// TOP working set there. The store makes the selection; the domain makes the estimate, and Epley
// never reaches the database.
struct MovementTop {
  ExerciseId exercise;
  std::uint64_t startedAtMs;
  double weightKg;
  int reps;

  bool operator==(const MovementTop&) const = default;
};

// Weeks run Monday to Monday in UTC; the instant crosses as epoch-ms. A week with no training is
// present and zero, never missing.
struct TrainingWeek {
  std::uint64_t startedAtMs;
  int sessions;
  int workingSets;

  bool operator==(const TrainingWeek&) const = default;
};

// `tops` arrive grouped by movement and oldest first within each; `marks` are the per-(movement,
// load) projection over this account's whole finished log. Only FINISHED sessions feed any of these.
struct TrainingLog {
  std::vector<MovementTop> tops;
  std::vector<PriorMark> marks;
  std::vector<TrainingWeek> weeks;

  bool operator==(const TrainingLog&) const = default;
};

// `e1rm` is absent exactly where Epley is undefined — at and below zero.
struct MovementPoint {
  std::uint64_t atMs;
  double weightKg;
  int reps;
  std::optional<double> e1rm;

  bool operator==(const MovementPoint&) const = default;
};

// A movement's standing best and the set that holds it, read off the marks. atMs is dated by the
// SESSION the mark was set in.
struct Best {
  double weightKg;
  int reps;
  std::uint64_t atMs;
  std::optional<double> e1rm;

  bool operator==(const Best&) const = default;
};

// `bestE1rm` is chosen BY having an estimate, so its own is always there; `heaviest` is chosen by
// load, so a bodyweight movement's carries none.
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
