#include "products/gym/domain/History.h"

#include <algorithm>
#include <utility>

namespace wm::gym {

void HistoryQuery::validate() const {
  if (timeZone.empty() || timeZone.size() > 128 || !storableText(timeZone) || fromMs >= untilMs || untilMs > kMaxInstantMs || beforeMs > kMaxInstantMs ||
      limit < 1 || limit > 200 || (!beforeId.empty() && !wellFormedId(beforeId)) ||
      (exercise.size() > 64 || exercise.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-") != std::string::npos) ||
      (!routine.empty() && !wellFormedId(routine)))
    throw InvalidTraining{"invalid history query"};
}

HistoryTotals HistoryWorkout::totals(const std::optional<std::string>& exercise) const {
  HistoryTotals total{1, 0, 0, 0};
  std::vector<VolumePart> parts;
  for (const HistorySet& set : sets) {
    if (exercise && set.exerciseId != *exercise) continue;
    ++total.sets;
    total.reps += set.reps;
    if (set.movementAvailable) parts.emplace_back(set.id, set.weightKg, set.reps, set.equipment, set.loadCount);
    else parts.emplace_back(set.id, set.weightKg, set.reps, std::nullopt);
  }
  total.tonnageKg = totalVolume(std::move(parts));
  return total;
}

void LogShare::validate() const {
  if (!wellFormedId(id) || fromMs >= untilMs || untilMs > kMaxInstantMs ||
      (!range && (fromMs != 0 || untilMs != kMaxInstantMs)))
    throw InvalidTraining{"invalid log share"};
}

bool LogShare::sameRequest(const LogShare& other) const {
  return user == other.user && mode == other.mode && range == other.range &&
         fromMs == other.fromMs && untilMs == other.untilMs;
}

HistoryQuery LogShare::constrain(HistoryQuery query) const {
  query.fromMs = std::max(query.fromMs, fromMs);
  query.untilMs = std::min(query.untilMs, untilMs);
  return query;
}

}
