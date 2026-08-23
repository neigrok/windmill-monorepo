#include "products/gym/domain/Statistics.h"

#include <algorithm>
#include <utility>

namespace wm::gym {

namespace {
// A load may legally be zero or negative, so "no mark yet" is an absent optional.
std::optional<Best> bestByE1rm(const std::vector<PriorMark>& marks, const ExerciseId& exercise) {
  // A defined estimate is always above zero, so zero stands in for "nothing yet".
  std::optional<Best> best;
  double top = 0;
  for (const PriorMark& mark : marks) {
    if (!(mark.exercise == exercise)) continue;
    std::optional<double> value = e1rm(mark.weightKg, mark.reps);
    if (!value || *value <= top) continue;
    top = *value;
    best = Best{mark.weightKg, mark.reps, mark.atMs, value};
  }
  return best;
}

std::optional<Best> bestByLoad(const std::vector<PriorMark>& marks, const ExerciseId& exercise) {
  std::optional<Best> best;
  for (const PriorMark& mark : marks) {
    if (!(mark.exercise == exercise)) continue;
    if (best && mark.weightKg <= best->weightKg) continue;
    best = Best{mark.weightKg, mark.reps, mark.atMs, e1rm(mark.weightKg, mark.reps)};
  }
  return best;
}
}

Statistics statistics(const TrainingLog& log) {
  // The tops arrive grouped by movement and oldest first, so a line is assembled by appending. The
  // last point of a run is the last time that movement was trained.
  std::vector<MovementProgress> movements;
  for (const MovementTop& top : log.tops) {
    if (movements.empty() || !(movements.back().exercise == top.exercise))
      movements.push_back(MovementProgress{top.exercise, 0, {}, std::nullopt, std::nullopt});
    MovementProgress& line = movements.back();
    line.points.push_back(
        MovementPoint{top.startedAtMs, top.weightKg, top.reps, e1rm(top.weightKg, top.reps)});
    line.lastTrainedAtMs = top.startedAtMs;
  }
  for (MovementProgress& line : movements) {
    line.bestE1rm = bestByE1rm(log.marks, line.exercise);
    line.heaviest = bestByLoad(log.marks, line.exercise);
  }

  // Most recently trained first, ties to the id — decided here rather than left to the store.
  std::sort(movements.begin(), movements.end(),
            [](const MovementProgress& a, const MovementProgress& b) {
              if (a.lastTrainedAtMs != b.lastTrainedAtMs)
                return a.lastTrainedAtMs > b.lastTrainedAtMs;
              return a.exercise.str() < b.exercise.str();
            });
  return Statistics{log.weeks, std::move(movements)};
}

}
