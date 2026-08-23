#include "products/gym/application/TrainingService.h"

#include <utility>

namespace wm::gym {

namespace {
// Called before a start and before every read whose reply carries session state a close rewrites.
void settleOpen(LogRepository& log, const UserId& user, std::uint64_t nowMs) {
  std::optional<Session> open = log.open(user);
  if (!open) return;
  std::optional<std::uint64_t> closeAt = autoCloseAt(*open, log.lastActivity(open->id), nowMs);
  if (!closeAt) return;
  log.close(open->id, *closeAt, ClosedBy::stale);
}

// The caller's own row under this id resolves first, so a replay is idempotent; the open session
// only when the caller's intent allows a join. Both carry the session's OWN stored snapshot. An
// empty answer is the only path that creates a session.
std::optional<StartOutcome> heldFor(LogRepository& log, const UserId& user,
                                    const SessionStart& incoming) {
  std::optional<Session> own = log.session(user, incoming.id);
  if (own) return StartOutcome{*own, StartError::none};
  std::optional<Session> open = log.open(user);
  if (!open) return std::nullopt;
  if (incoming.joinOpenSession) return StartOutcome{*open, StartError::none};
  return StartOutcome{std::nullopt, StartError::alreadyOpen};
}
}

TrainingService::TrainingService(LogRepository& log, ProgramRepository& program, Clock& clock,
                                 TokenGenerator& tokens)
    : log_(log), program_(program), clock_(clock), tokens_(tokens) {}

// Idempotent by construction, no guard flag: the caller's OWN id resolves FIRST. Only when nothing
// landed under that id does the open session enter, and the caller's intent decides join or refusal.
// The plan is frozen from the store's own routine only on the path that CREATES a session.
// The write is resolved by a read: the insert no-ops on the PK and on the one-open index, so what the
// store holds afterwards is the answer. Nothing resolving even then means another owner's row.
StartOutcome TrainingService::start(const UserId& user, const SessionStart& incoming) {
  settleOpen(log_, user, clock_.nowMs());
  std::optional<StartOutcome> already = heldFor(log_, user, incoming);
  if (already) return *already;
  // Only a start that would CREATE is held to the clock.
  const std::uint64_t nowMs = clock_.nowMs();
  if (!canStartAt(incoming.startedAtMs, nowMs))
    return {std::nullopt, StartError::clockAhead, incoming.startedAtMs - nowMs};
  std::optional<PlanSnapshot> plan;
  if (incoming.routine) {
    std::optional<Routine> planned = program_.routine(user, *incoming.routine);
    if (!planned) return {std::nullopt, StartError::unknownRoutine};
    plan = snapshotOf(*planned);
  }
  log_.insertSession(
      Session{incoming.id, user, incoming.startedAtMs, std::nullopt, incoming.routine, plan});
  std::optional<StartOutcome> landed = heldFor(log_, user, incoming);
  if (landed) return *landed;
  return {std::nullopt, StartError::idTaken};
}

// No auto-close here: a background flush replays offline sets into whatever session they belong to,
// however stale. An absent and another's session are the same fact.
// The replay is resolved BEFORE the finished refusal, so an already-durable set answers with itself
// however the session ended. Every refusal below is the STORE's alone and passed through as it
// arrives; `setOf` reads the rows that STAND, so a deleted set resolves to nothing here.
AppendOutcome TrainingService::append(const UserId& user, const SessionId& session,
                                      const SetWrite& incoming) {
  std::optional<Session> stored = log_.session(user, session);
  if (!stored) return {std::nullopt, AppendError::notFound};
  Set set{incoming.id, session, incoming.exercise, 0, incoming.weightKg, incoming.reps,
          incoming.kind, incoming.rpe, incoming.note, incoming.completedAtMs};
  std::optional<Set> replayed = log_.setOf(user, set.id);
  if (replayed && replayed->session == session) return {*replayed, AppendError::none};
  if (replayed) return {std::nullopt, AppendError::idTaken};
  SetInsertOutcome written = log_.insertSet(set);
  if (written.error == SetInsertError::idTaken) return {std::nullopt, AppendError::idTaken};
  if (written.error == SetInsertError::unknownExercise)
    return {std::nullopt, AppendError::unknownExercise};
  if (written.error == SetInsertError::finished) return {std::nullopt, AppendError::finished};
  if (written.error == SetInsertError::deleted) return {std::nullopt, AppendError::deleted};
  return {*written.set, AppendError::none};
}

// The rule is where a value the store cannot hold is refused.
// The session in the path must hold the set: absent, another account's, and this account's set in a
// different workout are one reply. Nothing is settled and nothing is refused for a finished session.
// Two devices correcting the same set at once leave the second one's values standing.
std::optional<Set> TrainingService::fixSet(const UserId& user, const SessionId& session,
                                           const SetId& id, const SetFix& fix) {
  std::optional<Set> stored = log_.setOf(user, id);
  if (!stored || !(stored->session == session)) return std::nullopt;
  return log_.updateSet(user, corrected(*stored, fix));
}

// Says nothing back, so a client whose network dropped sends the same delete again for the same
// reply. The row moves whole into the revisions table, marked deleted; no door reads it back.
void TrainingService::deleteSet(const UserId& user, const SessionId& session, const SetId& id) {
  log_.deleteSet(user, session, id);
}

// A finish is permanent once it is the lifter's word — first-writer-wins between finishes, and only
// a stale close yields to one — so the instant is checked against the stored session before it lands.
// A session discarded between the load and the close answers with the same absence a second finish
// would get.
FinishOutcome TrainingService::finish(const UserId& user, const SessionId& session,
                                      std::uint64_t finishedAtMs) {
  std::optional<Session> stored = log_.session(user, session);
  if (!stored) return {std::nullopt, FinishError::notFound};
  if (!canFinishAt(*stored, finishedAtMs)) return {std::nullopt, FinishError::badInstant};
  // A replay of a finish hands back the row; a STALE-closed session still takes the lifter's finish
  // as an upgrade, after which no late set moves it again.
  if (stored->finishedAtMs && stored->closedBy != ClosedBy::stale) return {*stored, FinishError::none};
  log_.close(session, finishedAtMs, ClosedBy::finish);
  std::optional<Session> closed = log_.session(user, session);
  if (!closed) return {std::nullopt, FinishError::notFound};
  return {*closed, FinishError::none};
}

// A record is judged against the history BEFORE its session, so the walk runs oldest first over rows
// the store hands back newest first, reading them backwards rather than re-sorting.
// A page carries the OPEN session like any other row, but only finished ones fold into the marks.
std::vector<LogRow> TrainingService::log(const UserId& user, const LogCursor& cursor) {
  settleOpen(log_, user, clock_.nowMs());
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
  settleOpen(log_, user, clock_.nowMs());
  return log_.open(user);
}

// Settles staleness; a phone's owed sets arriving after that close still land under lateSetLands.
std::optional<SessionDetail> TrainingService::detail(const UserId& user, const SessionId& session) {
  settleOpen(log_, user, clock_.nowMs());
  std::optional<Session> stored = log_.session(user, session);
  if (!stored) return std::nullopt;
  return SessionDetail{*stored, log_.setsOf(session)};
}

// Settles nothing and writes nothing: the only session settleOpen could reach here is the caller's
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

// The one refusal the store cannot state is a session still running: deleting a workout somebody is
// still logging into destroys the sets in flight. Staleness is settled elsewhere, not here. The row
// going between the load and the delete is the same fact as never having been there.
DiscardOutcome TrainingService::discard(const UserId& user, const SessionId& session) {
  std::optional<Session> stored = log_.session(user, session);
  if (!stored) return DiscardOutcome::notFound;
  if (!stored->finishedAtMs) return DiscardOutcome::open;
  if (!log_.deleteSession(user, session)) return DiscardOutcome::notFound;
  return DiscardOutcome::done;
}

// Staleness IS settled first: the answer counts finished sessions only.
Statistics TrainingService::statistics(const UserId& user) {
  settleOpen(log_, user, clock_.nowMs());
  return wm::gym::statistics(log_.trainingLog(user));
}

// The clock is read once and passed in, so the twelve-week window and the settle cannot disagree
// about what now is.
std::optional<MovementRecord> TrainingService::movementRecord(const UserId& user,
                                                              const ExerciseId& exercise) {
  const std::uint64_t nowMs = clock_.nowMs();
  settleOpen(log_, user, nowMs);
  MovementHistory history = log_.movementHistory(user, exercise);
  if (!history.exercise) return std::nullopt;
  return wm::gym::movementRecord(*history.exercise, history, nowMs);
}

// Settles nothing: hands back every set unconditionally, whatever finished_at says.
std::vector<ExportedSet> TrainingService::exportedSets(const UserId& user) {
  return log_.exportedSets(user);
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

}
