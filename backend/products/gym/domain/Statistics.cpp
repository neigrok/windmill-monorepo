#include "products/gym/domain/Statistics.h"

#include <algorithm>
#include <utility>

namespace wm::gym {

namespace {
// The two standing bests of one movement, and they are the prior halves of Review's record rules
// lifted out of `recordFor` unchanged: the mark with the largest Epley, and the mark with the
// heaviest load. A load may legally be zero or negative, so "no mark yet" cannot be spelled as a
// number and is spelled as an absent optional instead — the same reason the record rule keeps its
// prior top load optional.
std::optional<Best> bestByE1rm(const std::vector<PriorMark>& marks, const ExerciseId& exercise) {
  // A defined estimate is always above zero (its load is), so zero stands in for "nothing yet"
  // here exactly as it does in the record rule this is lifted from.
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
  // One walk over the tops, which arrive grouped by movement and oldest first, so a movement's line
  // is assembled by appending and never by sorting: a run of rows sharing a movement IS that
  // movement's line, in the order a chart draws it. The last point of the run is the last time the
  // movement was trained — the same fact `GET /v1/gym/routines` derives for a routine, derived here
  // from the rows already in hand rather than from a second read that could disagree with them.
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

  // Most recently trained first, ties to the id — the routines screen's order, stated here rather
  // than left to the store so the two surfaces sort by one rule.
  std::sort(movements.begin(), movements.end(),
            [](const MovementProgress& a, const MovementProgress& b) {
              if (a.lastTrainedAtMs != b.lastTrainedAtMs)
                return a.lastTrainedAtMs > b.lastTrainedAtMs;
              return a.exercise.str() < b.exercise.str();
            });
  return Statistics{log.weeks, std::move(movements)};
}

}
