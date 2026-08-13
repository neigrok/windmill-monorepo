#include "products/gym/domain/Record.h"

#include <algorithm>
#include <utility>

namespace wm::gym {

namespace {
// What one session was, as one point: its best estimate over every working set of the movement, and
// the load that earned it. It goes through `topE1rmOf`'s own rule rather than beside it — the best
// estimate is not the estimate of the heaviest set, and a page that ran Epley on the top set alone
// would print 116.7 under a session whose finish screen said 126.7.
std::optional<RecordPoint> pointOf(const MovementSession& session) {
  std::optional<double> top = topE1rmOf(session.loads);
  if (!top) return std::nullopt;
  for (const PriorMark& load : session.loads)
    if (e1rm(load.weightKg, load.reps) == top)
      return RecordPoint{session.startedAtMs, load.weightKg, load.reps, *top};
  return std::nullopt;
}

// The heaviest load this movement has held, ties broken by more reps and then by the earlier
// session — `Best`'s rule read off the sessions in hand. A load may legally be zero or negative, so
// "nothing yet" is an absent optional and never a number standing in for one.
std::optional<Best> heaviestOf(const std::vector<MovementSession>& sessions) {
  std::optional<Best> best;
  for (const MovementSession& session : sessions)
    for (const PriorMark& load : session.loads) {
      if (best && std::pair(load.weightKg, load.reps) <= std::pair(best->weightKg, best->reps))
        continue;
      best = Best{load.weightKg, load.reps, session.startedAtMs, e1rm(load.weightKg, load.reps)};
    }
  return best;
}
}

MovementRecord movementRecord(const Exercise& exercise, const MovementHistory& history,
                              std::uint64_t nowMs) {
  // One walk, oldest first, and it answers three of the four things on this page at once: the bar
  // for each session inside the window, the ladder of every session that beat what stood before it,
  // and the standing best that ladder ends on. A record needs a mark to have been PASSED, so the
  // first estimate a movement ever earned sets `bestE1rm` and enters no ladder.
  const std::uint64_t floorMs = nowMs > kRecordWindowMs ? nowMs - kRecordWindowMs : 0;
  MovementRecord record{exercise,
                        history.routines,
                        static_cast<int>(history.sessions.size()),
                        std::nullopt,
                        heaviestOf(history.sessions),
                        {},
                        {},
                        history.recent};
  double standing = 0;   // a defined estimate is always above zero, so zero is "nothing yet"
  for (const MovementSession& session : history.sessions) {
    std::optional<RecordPoint> point = pointOf(session);
    if (!point) continue;
    if (session.startedAtMs >= floorMs) record.series.push_back(*point);
    if (point->e1rm <= standing) continue;
    if (standing > 0) record.records.push_back(*point);
    standing = point->e1rm;
    record.bestE1rm = Best{point->weightKg, point->reps, point->atMs, point->e1rm};
  }
  // Newest first, which is the order the list prints in and the reverse of the order it was earned
  // in — the same reversal the log makes between the life of a workout and the reading of it.
  std::reverse(record.records.begin(), record.records.end());
  return record;
}

}
