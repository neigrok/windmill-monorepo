#include "products/gym/domain/Statistics.h"

#include <algorithm>
#include <utility>

namespace wm::gym {

namespace {
std::optional<double> e1rmOf(const PerformedFact& set) {
  const std::optional<Estimate> estimate = set.estimate();
  if (!estimate) return std::nullopt;
  return estimate->e1rm;
}

MovementProgress lineOf(const MovementSeries& series, const ExerciseId& exercise) {
  MovementProgress line{exercise, series.points.back().startedAtMs, {}, std::nullopt, std::nullopt};
  for (const MovementSeries::Point& point : series.points) {
    const PerformedFact& top = point.fact.heaviest;
    line.points.push_back(MovementPoint{point.startedAtMs, top.weightKg, top.reps, e1rmOf(top)});
  }
  if (const std::optional<MovementSeries::Point> best = series.best()) {
    const EstimatedFact& set = *best->fact.estimate;
    line.bestE1rm = Best{set.performed.weightKg, set.performed.reps, best->startedAtMs, set.estimate.e1rm};
  }
  if (const std::optional<MovementSeries::Point> heaviest = series.heaviest()) {
    const PerformedFact& set = heaviest->fact.heaviest;
    line.heaviest = Best{set.weightKg, set.reps, heaviest->startedAtMs, e1rmOf(set)};
  }
  return line;
}
}

Statistics statistics(const TrainingLog& log) {
  const std::vector<ProgressSession> sessions = progressSessions(log.sets);
  std::vector<ExerciseId> trained;
  for (const ProgressSession& session : sessions)
    for (const MovementSessionFact& fact : session.movements)
      if (std::ranges::find(trained, fact.exercise) == trained.end()) trained.push_back(fact.exercise);

  std::vector<MovementProgress> movements;
  for (const ExerciseId& exercise : trained) movements.push_back(lineOf(MovementSeries{sessions, exercise}, exercise));
  // Most recently trained first, ties to the id — decided here rather than left to the store.
  std::ranges::sort(movements, [](const MovementProgress& a, const MovementProgress& b) {
    if (a.lastTrainedAtMs != b.lastTrainedAtMs) return a.lastTrainedAtMs > b.lastTrainedAtMs;
    return a.exercise.str() < b.exercise.str();
  });
  return Statistics{log.weeks, std::move(movements)};
}

}
