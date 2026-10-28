#include "products/gym/domain/Progress.h"

#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Registry.h"

#include <algorithm>
#include <cmath>
#include <tuple>
#include <utility>

namespace wm::gym {

EstimateScore::EstimateScore(double weightKg, int reps) {
  if (!std::isfinite(weightKg) || weightKg < 0 || reps < 1 || reps > 10) throw InvalidTraining("invalid estimate score");
  const std::string text = sync::jcs(Json::Value(sync::Quantum{0.01}.round(weightKg)));
  const auto exponentAt = text.find('e');
  const auto point = text.find('.');
  digits = text.substr(0, exponentAt);
  exponent = (exponentAt == std::string::npos ? 0 : std::stoi(text.substr(exponentAt + 1))) + 2;
  if (point != std::string::npos) {
    exponent -= static_cast<int>(digits.size() - point - 1);
    digits.erase(point, 1);
  }
  const auto first = digits.find_first_not_of('0');
  if (first == std::string::npos) { digits = "0"; exponent = 0; return; }
  digits.erase(0, first);
  int carry = 0;
  const int factor = reps == 1 ? 30 : 30 + reps;
  for (auto digit = digits.rbegin(); digit != digits.rend(); ++digit) {
    const int product = (*digit - '0') * factor + carry;
    *digit = static_cast<char>('0' + product % 10);
    carry = product / 10;
  }
  if (carry) digits = std::to_string(carry) + digits;
  while (digits.back() == '0') { digits.pop_back(); ++exponent; }
}

std::strong_ordering EstimateScore::operator<=>(const EstimateScore& other) const {
  if (digits == "0" || other.digits == "0") return (digits != "0") <=> (other.digits != "0");
  const int length = static_cast<int>(digits.size()) + exponent;
  const int otherLength = static_cast<int>(other.digits.size()) + other.exponent;
  if (length != otherLength) return length <=> otherLength;
  for (std::size_t index = 0; index < std::max(digits.size(), other.digits.size()); ++index) {
    const char left = index < digits.size() ? digits[index] : '0';
    const char right = index < other.digits.size() ? other.digits[index] : '0';
    if (left != right) return left <=> right;
  }
  return std::strong_ordering::equal;
}

std::optional<Estimate> Estimate::of(double weightKg, int reps, std::optional<double> rpe) {
  if (!std::isfinite(weightKg) || weightKg <= 0 || reps < 1 || reps > 10) return std::nullopt;
  if (rpe && (!std::isfinite(*rpe) || *rpe < 7)) return std::nullopt;
  const EstimateScore score{weightKg, reps};
  const double value = reps == 1 ? weightKg : weightKg * (1.0 + reps / 30.0);
  return Estimate{std::isfinite(value) ? std::optional<double>{value} : std::nullopt, score};
}

double Estimate::stated(double e1rm) { return sync::Quantum{0.1}.round(e1rm); }

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
    if (estimate && !estimate->e1rm) movement->estimatesComplete = false;
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
  if (!estimatesComplete()) return std::nullopt;
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
  if (!estimatesComplete()) return {};
  std::vector<Point> records;
  for (const Point& point : points)
    if (point.fact.estimate &&
        (records.empty() || Estimate::stated(*point.fact.estimate->estimate.e1rm) >
                                Estimate::stated(*records.back().fact.estimate->estimate.e1rm)))
      records.push_back(point);
  return records;
}

bool MovementSeries::estimatesComplete() const {
  return std::ranges::all_of(points, [](const Point& point) { return point.fact.estimatesComplete; });
}

}
