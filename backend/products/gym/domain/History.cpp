#include "products/gym/domain/History.h"

#include <algorithm>

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
  for (const HistorySet& set : sets) {
    if (!set.working || (exercise && set.exerciseId != *exercise)) continue;
    ++total.sets;
    total.reps += set.reps;
    total.tonnageKg += std::max(set.weightKg, 0.0) * set.reps;
  }
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
