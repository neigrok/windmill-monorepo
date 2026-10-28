#pragma once

#include "products/gym/domain/Training.h"

#include <compare>
#include <cstdint>
#include <optional>
#include <vector>

namespace wm::gym {

struct EstimateScore {
  std::string digits = "0";
  int exponent = 0;

  EstimateScore() = default;
  EstimateScore(double weightKg, int reps);
  std::strong_ordering operator<=>(const EstimateScore& other) const;
  bool operator==(const EstimateScore&) const = default;
};

// The one e1RM rule (brand foundations, Gym), the `GymEstimate` both phones and the web hold and
// packages/api-contract/gym/domain/training-reads.json pins. A set earns an estimate only at a positive load, for one
// to ten reps, unrated or at an RPE of seven or more: one rep is the load itself, more is Epley. `e1rm` keeps full
// precision, and every reply states it to a tenth with `stated` as its last step. `score` is how two estimates
// compare, exactly where their Epley values cannot: the load in whole cents times 30 for one rep, or 30 + reps.
struct Estimate {
  std::optional<double> e1rm;
  EstimateScore score;

  static std::optional<Estimate> of(double weightKg, int reps, std::optional<double> rpe);
  static double stated(double e1rm);

  bool operator==(const Estimate&) const = default;
};

// A working set as every derived read takes it: its identity, its load, its reps and the effort it was rated at.
struct PerformedFact {
  SetId set;
  double weightKg;
  int reps;
  std::optional<double> rpe;

  std::optional<Estimate> estimate() const;

  bool operator==(const PerformedFact&) const = default;
};

struct EstimatedFact {
  PerformedFact performed;
  Estimate estimate;

  bool operator==(const EstimatedFact&) const = default;
};

// The one projection of working sets in this product: a set with its session and that session's start, never the
// set's own completed_at, which is the device's wall clock. Every estimate, best and record is derived from these
// rows in the domain; the store only selects and orders them.
struct ProgressSet {
  SessionId session;
  std::uint64_t startedAtMs;
  ExerciseId exercise;
  PerformedFact performed;

  static ProgressSet of(const Session& session, const Set& set);

  bool operator==(const ProgressSet&) const = default;
};

// One movement in one session: how many working sets it took, its heaviest set (ties to more reps, then the lowest
// set id), the set earning its estimate (the highest score, ties to the lowest set id), and its most reps at zero load.
struct MovementSessionFact {
  ExerciseId exercise;
  int workingSetCount;
  PerformedFact heaviest;
  std::optional<EstimatedFact> estimate;
  std::optional<PerformedFact> mostReps;
  bool estimatesComplete = true;

  bool operator==(const MovementSessionFact&) const = default;
};

// Movements in id order.
struct ProgressSession {
  SessionId session;
  std::uint64_t startedAtMs;
  std::vector<MovementSessionFact> movements;

  bool operator==(const ProgressSession&) const = default;
};

struct StatsProgress {
  std::uint64_t asOfMs;
  std::vector<ProgressSession> sessions;

  bool operator==(const StatsProgress&) const = default;
};

// The sets grouped into sessions, in whatever order they arrive: sessions come out by (startedAtMs, session id), each
// with its movements in id order.
std::vector<ProgressSession> progressSessions(const std::vector<ProgressSet>& sets);

StatsProgress statsProgress(const std::vector<ProgressSet>& history, std::uint64_t asOfMs);

// One movement across the sessions that worked it, oldest first and ties to the session id. Every best below is
// chosen over the whole series, and on a tie keeps the earliest session.
struct MovementSeries {
  struct Point {
    SessionId session;
    std::uint64_t startedAtMs;
    MovementSessionFact fact;

    bool operator==(const Point&) const = default;
  };

  std::vector<Point> points;

  MovementSeries(const std::vector<ProgressSession>& sessions, const ExerciseId& exercise);

  bool estimatesComplete() const;

  // The highest estimate, by score.
  std::optional<Point> best() const;
  // The heaviest load, then the most reps at it.
  std::optional<Point> heaviest() const;
  // Every estimate that beat each one before it, oldest first. The first estimate is the baseline and leads the list.
  std::vector<Point> records() const;
};

}
