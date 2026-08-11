#pragma once

#include "products/gym/domain/Review.h"
#include "products/gym/domain/Training.h"

#include <cstdint>
#include <optional>
#include <vector>

namespace wm::gym {

// The statistics surface is a READ over values this product has already decided, and the list of
// what it refuses is as load-bearing as the list of what it answers.
//
// No volume AS A METRIC — no headline number, no series anyone is asked to watch, nothing sessions
// are ranked by — because `weight × reps` does not rise with getting stronger: band-assisted work
// logs a negative load, so the total FALLS as the band comes off, and four light sets outrank three
// heavy ones. e1RM is the headline here and everywhere else. What that refuses is not tonnage as a
// CAPTION, which the log prints on its week dividers and its rows (the sum is the store's, in
// ports/TrainingRepository.h) — the scale of a week, sitting beside the facts a lifter scans. It is
// allowed there because it is stated with the negative case handled rather than ignored: an
// assisted set contributes ZERO, having moved no external load, and a bodyweight set contributes
// zero for the same reason, gym holding no bodyweight to add to it. That carries one rule with it,
// and the rule is what keeps the caption honest — a session or a week whose tonnage is zero shows
// NOTHING where the tonnage would go, never `0.0 t`. A chin-up-and-dips week did not move zero
// kilograms; we simply have nothing true to say about it, and an absence beats a false zero.
//
// No muscle-group anything: pattern is the only classification gym has, single-valued on purpose,
// and a taxonomy that double-counts a bench set into chest and triceps is the bug the schema was
// written against. No streak, no cardio, no duration axis, and nothing here is a grade — no score,
// no percentage, nothing green or red. Every number below is a fact with a direction, which is the
// finish screen's rule (§5) applied to a longer window.

// What one movement did in one session, as the store hands it over. The instant is the SESSION's
// own start and never a set's `completed_at`: that is the device's wall clock and nothing ties it
// to the session it landed in, so a single future-stamped set would otherwise walk a point across
// the chart. The set itself is the movement's TOP working set there — heaviest, ties to more reps,
// then the earliest — which is TopSet's rule and the same answer the finish screen already gives to
// "what was that movement that session". The selection is an ORDERING, so the store makes it; the
// estimate on top of it is a FORMULA, so the domain makes it, and Epley never reaches the database.
struct MovementTop {
  ExerciseId exercise;
  std::uint64_t startedAtMs;
  double weightKg;
  int reps;

  bool operator==(const MovementTop&) const = default;
};

// One week of training, counted where every date in this product is counted — in Postgres. Weeks
// run Monday to Monday in UTC, because the store holds no timezone for the lifter and inventing one
// would put a Sunday-night session in the wrong bar for half the planet; the instant crosses as
// epoch-ms and the client renders it in whatever zone the reader is standing in. A week with no
// training is present and zero, not missing — a gap is a fact about a program, and a client that had
// to synthesize it would be doing calendar arithmetic this product keeps in one place.
struct TrainingWeek {
  std::uint64_t startedAtMs;
  int sessions;
  int workingSets;

  bool operator==(const TrainingWeek&) const = default;
};

// Everything the rule below needs that it cannot compute, in one value the port fills — the same
// contract SessionHistory holds for the review: the rule defines the shape and the store's job is
// to fill it. `tops` arrive grouped by movement and oldest first within each, `marks` are the
// review's own per-(movement, load) projection over this account's whole finished log, and `weeks`
// are the counts Postgres already made. Only FINISHED sessions feed any of the three, for the
// reason `lastTime` excludes them too: today's live workout is today's screen, and a statistics
// read that moved under a lifter between two sets would be reporting on a session in flight.
struct TrainingLog {
  std::vector<MovementTop> tops;
  std::vector<PriorMark> marks;
  std::vector<TrainingWeek> weeks;

  bool operator==(const TrainingLog&) const = default;
};

// One point of a movement's line. `e1rm` is absent exactly where Epley is undefined — a chin-up at
// 0 kg and a band-assisted pull-up at −20 have no honest one-rep estimate — so those movements draw
// a line of loads with no estimate over it rather than a line of invented numbers.
struct MovementPoint {
  std::uint64_t atMs;
  double weightKg;
  int reps;
  std::optional<double> e1rm;

  bool operator==(const MovementPoint&) const = default;
};

// A movement's standing best and the set that holds it, read off the marks by the same two scans
// the finish's record rules make over the same rows (domain/Review.cpp) — asked with no session to
// compare against, which is the only difference. The third record rule has no standing form and is
// deliberately absent: "more reps at a load you have used before" is a comparison, and with nothing
// to compare against every mark already IS the best reps ever done at its load.
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

// Movements come back most recently trained first — the order the routines screen already sorts by,
// so the two lists read the same way — with ties broken by id so the walk is deterministic rather
// than the store's choice.
struct Statistics {
  std::vector<TrainingWeek> weeks;
  std::vector<MovementProgress> movements;

  bool operator==(const Statistics&) const = default;
};

// Pure and clock-free like every rule in this product, computed on every read and stored nowhere:
// a set that arrives late from a flush queue counts the next time the surface is asked for, and
// there is no cache to key on a collection length and get wrong.
Statistics statistics(const TrainingLog& log);

}
