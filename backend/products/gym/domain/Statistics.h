#pragma once

#include "products/gym/domain/Review.h"
#include "products/gym/domain/Training.h"

#include <cstdint>
#include <optional>
#include <vector>

namespace wm::gym {

// The statistics engine, a read over values this product has already decided. There is no
// statistics SURFACE: `GET /v1/gym/stats` and the `get_stats` tool are its only readers, so do not
// clean this up as unreachable code.
//
// No volume as a metric — `weight × reps` does not rise with getting stronger, band-assisted work
// logging a negative load — and e1RM is the headline instead. Tonnage as a CAPTION is allowed
// (the log's week dividers and rows; the sum is the store's) with the negative case handled: an
// assisted or bodyweight set contributes zero, and a zero tonnage shows NOTHING rather than `0.0 t`.
//
// No muscle-group anything: pattern is the only classification gym has, single-valued. No streak, no
// cardio, no duration axis, and no grades.

// What one movement did in one session. The instant is the SESSION's own start and never a set's
// `completed_at`, which is the device's wall clock. The set is the movement's TOP working set there
// — TopSet's rule. The selection is an ORDERING, so the store makes it; the estimate on top is a
// FORMULA, so the domain makes it, and Epley never reaches the database.
struct MovementTop {
  ExerciseId exercise;
  std::uint64_t startedAtMs;
  double weightKg;
  int reps;

  bool operator==(const MovementTop&) const = default;
};

// One week of training, counted in Postgres. Weeks run Monday to Monday in UTC; the instant crosses
// as epoch-ms and the client renders it in the reader's own zone. A week with no training is present
// and zero, never missing.
struct TrainingWeek {
  std::uint64_t startedAtMs;
  int sessions;
  int workingSets;

  bool operator==(const TrainingWeek&) const = default;
};

// Everything the rule below needs that it cannot compute, in one value the port fills. `tops` arrive
// grouped by movement and oldest first within each, `marks` are the review's per-(movement, load)
// projection over this account's whole finished log, and `weeks` are the counts Postgres made. Only
// FINISHED sessions feed any of the three.
struct TrainingLog {
  std::vector<MovementTop> tops;
  std::vector<PriorMark> marks;
  std::vector<TrainingWeek> weeks;

  bool operator==(const TrainingLog&) const = default;
};

// One point of a movement's line. `e1rm` is absent exactly where Epley is undefined — at and below
// zero — so those movements draw a line of loads with no estimate over it.
struct MovementPoint {
  std::uint64_t atMs;
  double weightKg;
  int reps;
  std::optional<double> e1rm;

  bool operator==(const MovementPoint&) const = default;
};

// A movement's standing best and the set that holds it, read off the marks by the same two scans
// the finish's record rules make (domain/Review.cpp). The third record rule has no standing form and
// is deliberately absent. atMs is the mark's, dated by the SESSION it was set in — the same instant
// MovementTop carries.
struct Best {
  double weightKg;
  int reps;
  std::uint64_t atMs;
  std::optional<double> e1rm;

  bool operator==(const Best&) const = default;
};

// One movement's whole line. `bestE1rm` is chosen BY having an estimate, so its own is always
// there; `heaviest` is chosen by load, so a bodyweight movement's carries none.
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

// Computed on every read and stored nowhere.
Statistics statistics(const TrainingLog& log);

}
