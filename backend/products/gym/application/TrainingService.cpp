#include "products/gym/application/TrainingService.h"

#include <utility>

namespace wm::gym {

TrainingService::TrainingService(LogRepository& log, Clock& clock, TokenGenerator& tokens, GymWriteDoor& door)
    : log_(log), clock_(clock), tokens_(tokens), door_(door) {}

// Idempotent by the caller's own id, which resolves first; only then does the open session enter, and
// the caller's intent decides join or refusal. The plan is frozen from the engine's own routine only on
// the path that CREATES a session, and only a creating start is held to the clock.
StartOutcome TrainingService::start(const UserId& user, const SessionStart& incoming) {
  return door_.start(user, incoming);
}

// No stale close here: a background flush replays offline sets into whatever session they belong to,
// however stale. An absent and another's session are the same fact. The replay is resolved before the
// finished refusal, so an already-durable set answers with itself however the session ended.
AppendOutcome TrainingService::append(const UserId& user, const SessionId& session,
                                      const SetWrite& incoming) {
  return door_.append(user, session, incoming);
}

BatchLogOutcome TrainingService::appendSets(const UserId& user, const SessionId& session,
                                            const std::vector<SetWrite>& incoming) {
  return door_.appendSets(user, session, incoming);
}

// The span, then each set against it; staleness is settled first, so a workout walked away from counts
// as the finished thing it is.
BatchLogOutcome TrainingService::importSession(const UserId& user, const SessionImport& incoming) {
  return door_.importSession(user, incoming);
}

std::vector<SessionRows> TrainingService::sessions(const UserId& user, const std::vector<SessionId>& ids) {
  if (ids.empty() || ids.size() > 50) throw InvalidTraining("sessionIds must contain 1 to 50 ids");
  door_.closeStale(user);
  return log_.sessions(user, ids);
}

// A finish is permanent once it is the lifter's word — first-writer-wins between finishes, and only a
// stale close yields to one — so the instant is checked against the stored session before it lands.
FinishOutcome TrainingService::finish(const UserId& user, const SessionId& session,
                                      std::uint64_t finishedAtMs) {
  return door_.finish(user, session, finishedAtMs);
}

// A record is judged against the history BEFORE its session, so the walk runs oldest first over rows
// the store hands back newest first, reading them backwards rather than re-sorting.
// A page carries the OPEN session like any other row, but only finished ones fold into the marks.
std::vector<LogRow> TrainingService::log(const UserId& user, const LogCursor& cursor) {
  door_.closeStale(user);
  LogPage page = log_.log(user, cursor);

  std::vector<SessionMarks> walked;
  for (auto row = page.sessions.rbegin(); row != page.sessions.rend(); ++row)
    walked.push_back(SessionMarks{row->session.id, row->workingMarks, row->workingSetCount,
                                  row->session.finishedAtMs.has_value()});
  const std::vector<SessionId> earned = recordedIn(walked, page.standing);

  std::vector<LogRow> rows;
  for (SessionSummary& summary : page.sessions) {
    std::optional<double> estimate = topE1rmOf(summary.workingMarks);
    bool record = false;
    for (const SessionId& id : earned)
      if (id == summary.session.id) record = true;
    rows.push_back(LogRow{std::move(summary), estimate, record});
  }
  return rows;
}

std::optional<Session> TrainingService::openSession(const UserId& user) {
  door_.closeStale(user);
  return log_.open(user);
}

// Settles staleness; a phone's owed sets arriving after that close still land under lateSetLands.
std::optional<SessionDetail> TrainingService::detail(const UserId& user, const SessionId& session) {
  door_.closeStale(user);
  std::optional<Session> stored = log_.session(user, session);
  if (!stored) return std::nullopt;
  return SessionDetail{*stored, log_.setsOf(session)};
}

// Settles nothing and writes nothing: the only session a stale close could reach here is the caller's
// own live one, and closing that mid-workout would refuse every set after it. The store's two facts
// pass through untouched: no history at all, and no such movement.
LastTimeOutcome TrainingService::lastTime(const UserId& user, const ExerciseId& exercise) {
  return log_.lastTime(user, exercise);
}

// The same read for the whole catalog at once, settling nothing, as above.
std::vector<LastSet> TrainingService::lastSets(const UserId& user) {
  return log_.lastSets(user);
}

// Nothing is stored: the review is recomputed on every read.
std::optional<Review> TrainingService::review(const UserId& user, const SessionId& session) {
  std::optional<Session> stored = log_.session(user, session);
  if (!stored) return std::nullopt;
  return wm::gym::review(*stored, log_.setsOf(session), log_.historyFor(user, *stored));
}

// A session still running is refused: deleting a workout somebody is still logging into destroys the
// sets in flight. Staleness is settled elsewhere, not here.
DiscardOutcome TrainingService::discard(const UserId& user, const SessionId& session) {
  return door_.discard(user, session);
}

// Staleness IS settled first: the answer counts finished sessions only.
Statistics TrainingService::statistics(const UserId& user) {
  door_.closeStale(user);
  return wm::gym::statistics(log_.trainingLog(user));
}

StatsProgress TrainingService::progress(const UserId& user) {
  const std::uint64_t nowMs = clock_.nowMs();
  door_.closeStale(user);
  const std::vector<ProgressSet> history = log_.progressHistory(user);
  return statsProgress(history, nowMs);
}

// The clock is read once and passed in, so the twelve-week window and the settle cannot disagree
// about what now is.
std::optional<MovementRecord> TrainingService::movementRecord(const UserId& user,
                                                              const ExerciseId& exercise) {
  const std::uint64_t nowMs = clock_.nowMs();
  door_.closeStale(user);
  MovementHistory history = log_.movementHistory(user, exercise);
  if (!history.exercise) return std::nullopt;
  return wm::gym::movementRecord(*history.exercise, history, nowMs);
}

// The token is minted HERE and never parsed from anywhere. The store resolves the write: a live
// share answers with itself, an expired one is replaced, a session this caller cannot read answers
// with nothing.
std::optional<SessionShare> TrainingService::share(const UserId& user, const SessionId& session) {
  // One clock read decides both what the new share ends at and whether the existing one has ended.
  const std::uint64_t nowMs = clock_.nowMs();
  return log_.insertShare(
      SessionShare{session, user, tokens_.mint().secret, shareExpiryAt(nowMs)}, nowMs);
}

bool TrainingService::revokeShare(const UserId& user, const SessionId& session) {
  return log_.revokeShare(user, session);
}

std::optional<SharedSession> TrainingService::shared(const std::string& token) {
  return log_.sharedSession(token, clock_.nowMs());
}

HistoryPage TrainingService::history(const UserId& user, const HistoryQuery& query) {
  query.validate();
  door_.closeStale(user);
  HistoryQuery read = query;
  read.asOfMs = clock_.nowMs();
  return log_.history(user, read);
}

std::optional<LogShare> TrainingService::shareLog(const UserId& user, const std::string& id,
    LogShareMode mode, bool range, std::uint64_t fromMs, std::uint64_t untilMs) {
  const auto now = clock_.nowMs();
  LogShare share{id, user, tokens_.mint().secret, mode, range, fromMs, untilMs, now,
                 shareExpiryAt(now)};
  share.validate();
  door_.closeStale(user);
  return log_.createLogShare(share);
}

std::vector<LogShare> TrainingService::logShares(const UserId& user) {
  return log_.logShares(user, clock_.nowMs());
}

void TrainingService::revokeLogShare(const UserId& user, const std::string& id) {
  log_.revokeLogShare(user, id);
}

std::optional<SharedHistory> TrainingService::sharedHistory(const std::string& token,
    const HistoryQuery& query) {
  query.validate();
  HistoryQuery read = query;
  read.asOfMs = clock_.nowMs();
  return log_.sharedHistory(token, read, read.asOfMs);
}

}
