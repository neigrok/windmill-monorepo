#pragma once

#include "platform/ports/Clock.h"
#include "platform/ports/TokenGenerator.h"
#include "products/gym/ports/GymWriteDoor.h"
#include "products/gym/ports/LogRepository.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

struct SessionDetail {
  Session session;
  std::vector<Set> sets;

  bool operator==(const SessionDetail&) const = default;
};

// record runs the domain's three record rules over the whole page in one walk against the marks
// standing before it, and needs to be told which rows are FINISHED. Recomputed on every read and
// stored nowhere.
// topE1rm is `topE1rmOf` over the loads the store handed back: the best estimate over every working
// set, NOT Epley over `summary.topSet`. Absent exactly where Epley is undefined.
struct LogRow {
  SessionSummary summary;
  std::optional<double> topE1rm;
  bool record = false;

  bool operator==(const LogRow&) const = default;
};

// Derived log reads and sharing. Before every read whose answer a close rewrites, the door closes
// a workout gone stale, and admits nothing when none has.
// The token generator mints share secrets.
class TrainingService {
public:
  TrainingService(LogRepository& log, Clock& clock, TokenGenerator& tokens, GymWriteDoor& door);

  std::vector<SessionRows> sessions(const UserId& user, const std::vector<SessionId>& ids);

  std::vector<LogRow> log(const UserId& user, const LogCursor& cursor);
  std::optional<SessionDetail> detail(const UserId& user, const SessionId& session);
  // Settled first, so a session walked away from yesterday answers as the closed thing it is.
  std::optional<Session> openSession(const UserId& user);
  LastTimeOutcome lastTime(const UserId& user, const ExerciseId& exercise);
  // Which set is "last" is the store's ordering, the same one lastTime states.
  std::vector<LastSet> lastSets(const UserId& user);

  // An absent review is an absent session.
  std::optional<Review> review(const UserId& user, const SessionId& session);

  HistoryPage history(const UserId& user, const HistoryQuery& query);
  std::optional<LogShare> shareLog(const UserId& user, const std::string& id, LogShareMode mode,
      bool range, std::uint64_t fromMs, std::uint64_t untilMs);
  std::vector<LogShare> logShares(const UserId& user);
  void revokeLogShare(const UserId& user, const std::string& id);
  std::optional<SharedHistory> sharedHistory(const std::string& token, const HistoryQuery& query);

  Statistics statistics(const UserId& user);
  StatsProgress progress(const UserId& user);
  // Absent means this account's catalog holds no such movement.
  std::optional<MovementRecord> movementRecord(const UserId& user, const ExerciseId& exercise);

  // A repeat answers with the live share. An absent answer covers absent and another account's alike.
  std::optional<SessionShare> share(const UserId& user, const SessionId& session);
  bool revokeShare(const UserId& user, const SessionId& session);
  // No caller, and it settles NOTHING: a stranger holding a link must never write to the owner's
  // log, not even the four-hour close. The token is the whole credential.
  std::optional<SharedSession> shared(const std::string& token);

private:
  LogRepository& log_;
  Clock& clock_;
  TokenGenerator& tokens_;
  GymWriteDoor& door_;
};

}
