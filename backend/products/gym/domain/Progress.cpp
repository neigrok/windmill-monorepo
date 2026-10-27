#include "products/gym/domain/Progress.h"

#include <algorithm>
#include <cmath>
#include <tuple>
#include <utility>

namespace wm::gym {

std::optional<Estimate> Estimate::of(double weightKg, int reps, std::optional<double> rpe) {
  if (!std::isfinite(weightKg) || weightKg <= 0 || reps < 1 || reps > 10) return std::nullopt;
  if (rpe && (!std::isfinite(*rpe) || *rpe < 7)) return std::nullopt;
  const std::int64_t cents = std::llround(weightKg * 100);
  if (reps == 1) return Estimate{weightKg, cents * 30};
  return Estimate{weightKg * (1.0 + reps / 30.0), cents * (30 + reps)};
}

double Estimate::stated(double e1rm) { return std::round(e1rm * 10.0) / 10.0; }

std::optional<Estimate> PerformedFact::estimate() const { return Estimate::of(weightKg, reps, rpe); }

ProgressSet ProgressSet::of(const Session& session, const Set& set) {
  return ProgressSet{session.id, session.startedAtMs, set.exercise,
                     PerformedFact{set.id, set.weightKg, set.reps, set.rpe}};
}

std::vector<ProgressSession> progressSessions(const std::vector<ProgressSet>& sets) {
  std::vector<ProgressSession> sessions;
  for (const ProgressSet& row : sets) {
    auto session = std::ranges::find(sessions, row.session, &ProgressSession::session);
    if (session == sessions.end())
      session = sessions.insert(sessions.end(), ProgressSession{row.session, row.startedAtMs, {}});
    auto movement = std::ranges::find(session->movements, row.exercise, &MovementSessionFact::exercise);
    if (movement == session->movements.end())
      movement = session->movements.insert(session->movements.end(),
                                           MovementSessionFact{row.exercise, 0, row.performed, std::nullopt, std::nullopt});
    ++movement->workingSetCount;

    const PerformedFact& set = row.performed;
    if (std::tuple(set.weightKg, set.reps, movement->heaviest.set.str()) >
        std::tuple(movement->heaviest.weightKg, movement->heaviest.reps, set.set.str()))
      movement->heaviest = set;
    if (set.weightKg == 0 && (!movement->mostReps || std::pair(set.reps, movement->mostReps->set.str()) >
                                                         std::pair(movement->mostReps->reps, set.set.str())))
      movement->mostReps = set;
    const std::optional<Estimate> estimate = set.estimate();
    if (estimate && (!movement->estimate ||
                     std::pair(estimate->score, movement->estimate->performed.set.str()) >
                         std::pair(movement->estimate->estimate.score, set.set.str())))
      movement->estimate = EstimatedFact{set, *estimate};
  }
  for (ProgressSession& session : sessions)
    std::ranges::sort(session.movements, {}, [](const MovementSessionFact& fact) { return fact.exercise.str(); });
  std::ranges::sort(sessions, {}, [](const ProgressSession& session) {
    return std::pair(session.startedAtMs, session.session.str());
  });
  return sessions;
}

StatsProgress statsProgress(const std::vector<ProgressSet>& history, std::uint64_t asOfMs) {
  return StatsProgress{asOfMs, progressSessions(history)};
}

MovementSeries::MovementSeries(const std::vector<ProgressSession>& sessions, const ExerciseId& exercise) {
  for (const ProgressSession& session : sessions)
    for (const MovementSessionFact& fact : session.movements)
      if (fact.exercise == exercise) points.push_back(Point{session.session, session.startedAtMs, fact});
  std::ranges::sort(points, {}, [](const Point& point) { return std::pair(point.startedAtMs, point.session.str()); });
}

std::optional<MovementSeries::Point> MovementSeries::best() const {
  std::optional<Point> best;
  for (const Point& point : points)
    if (point.fact.estimate && (!best || point.fact.estimate->estimate.score > best->fact.estimate->estimate.score))
      best = point;
  return best;
}

std::optional<MovementSeries::Point> MovementSeries::heaviest() const {
  std::optional<Point> heaviest;
  for (const Point& point : points)
    if (!heaviest || std::pair(point.fact.heaviest.weightKg, point.fact.heaviest.reps) >
                         std::pair(heaviest->fact.heaviest.weightKg, heaviest->fact.heaviest.reps))
      heaviest = point;
  return heaviest;
}

std::vector<MovementSeries::Point> MovementSeries::records() const {
  std::vector<Point> records;
  for (const Point& point : points)
    if (point.fact.estimate &&
        (records.empty() || point.fact.estimate->estimate.score > records.back().fact.estimate->estimate.score))
      records.push_back(point);
  return records;
}

}
