#include "products/gym/domain/Record.h"

#include <algorithm>
#include <utility>

namespace wm::gym {

namespace {
// The set that earned a session's estimate, dated by that session.
RecordPoint pointOf(const MovementSeries::Point& point) {
  const EstimatedFact& set = *point.fact.estimate;
  return RecordPoint{point.startedAtMs, set.performed.weightKg, set.performed.reps, *set.estimate.e1rm};
}
}

MovementRecord movementRecord(const Exercise& exercise, const MovementHistory& history,
                              std::uint64_t nowMs) {
  const MovementSeries series{progressSessions(history.sets), exercise.id};
  MovementRecord record{exercise, history.routines, static_cast<int>(series.points.size()), std::nullopt,
                        std::nullopt, {}, {}, history.recent};
  if (const std::optional<MovementSeries::Point> best = series.best()) {
    const RecordPoint point = pointOf(*best);
    record.bestE1rm = Best{point.weightKg, point.reps, point.atMs, point.e1rm};
  }
  if (const std::optional<MovementSeries::Point> heaviest = series.heaviest()) {
    const PerformedFact& set = heaviest->fact.heaviest;
    const std::optional<Estimate> estimate = set.estimate();
    record.heaviest = Best{set.weightKg, set.reps, heaviest->startedAtMs,
                           estimate ? estimate->e1rm : std::nullopt};
  }
  const std::uint64_t floorMs = nowMs > kRecordWindowMs ? nowMs - kRecordWindowMs : 0;
  for (const MovementSeries::Point& point : series.points)
    if (series.estimatesComplete() && point.fact.estimate && point.fact.estimate->estimate.e1rm &&
        point.startedAtMs >= floorMs) record.series.push_back(pointOf(point));
  // A record needs a mark to have been passed, so the ladder's first step, the baseline, is no record. Newest first,
  // the order the list prints in.
  const std::vector<MovementSeries::Point> ladder = series.records();
  for (std::size_t step = ladder.size(); step > 1; --step) record.records.push_back(pointOf(ladder[step - 1]));
  return record;
}

}
