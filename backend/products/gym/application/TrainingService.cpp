#include "products/gym/application/TrainingService.h"

#include <utility>

namespace wm::gym {

namespace {
// Load the user's open session and its last set instant, ask the pure rule, persist the close if the
// domain says the session is over. Called before a start and before every read whose reply carries
// session state a close rewrites, so no ticker runs and no close lands unseen.
void settleOpen(LogRepository& log, const UserId& user, std::uint64_t nowMs) {
  std::optional<Session> open = log.open(user);
  if (!open) return;
  std::optional<std::uint64_t> closeAt = autoCloseAt(*open, log.lastActivity(open->id), nowMs);
  if (!closeAt) return;
  log.close(open->id, *closeAt, ClosedBy::stale);
}

// What the store already holds for this caller: their own row under this id first, so a replay is
// idempotent whatever else is going on, then the open session if the caller's intent allows a join.
// Both answers carry the session's OWN stored snapshot, so pressing Start cannot re-plan a running
// workout. An empty answer is the only path that creates a session.
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

// Idempotent by construction, no guard flag: the caller's OWN id resolves FIRST, so a replayed POST
// reads back the session it minted — open, finished or auto-closed — whichever Start it meant. Only
// when nothing landed under that id does the open session enter the story, and the caller's intent
// decides whether to join it or be refused.
//
// The plan is frozen here from the store's own routine, and only on the path that CREATES a session:
// a replay and a join are handed a session that already exists, with ITS stored snapshot, so a
// routine deleted since cannot 404 a phone out of its own live workout.
//
// The write is resolved by a read: the insert no-ops on the PK and on the one-open index, so what the
// store holds afterwards is the answer. Nothing resolving even then means the insert no-oped on
// another owner's row, and the reply is a refusal.
StartOutcome TrainingService::start(const UserId& user, const SessionStart& incoming) {
  settleOpen(log_, user, clock_.nowMs());
  std::optional<StartOutcome> already = heldFor(log_, user, incoming);
  if (already) return *already;
  // Only a start that would CREATE is held to the clock: a replay and a join hand back a session
  // that already exists, whatever the caller's clock says.
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

// No auto-close here on purpose: a background flush replays offline sets into whatever session they
// belong to, however stale. An absent and another's session are the same fact.
//
// The replay is resolved BEFORE the finished refusal, so a set that is already durable answers with
// itself however the session ended and a queue treating 409 as terminal cannot drop a landed row.
// Every refusal below is the STORE's alone and passed through as it arrives: only it knows the
// catalog, only its read-back knows a fresh id is spent elsewhere, only its lock knows whether the
// close landed between the read above and the insert, and only it holds the revisions. `setOf` reads
// the rows that STAND, so a deleted set resolves to nothing here and only the store can refuse it.
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

// Three phases: load the stored row under the caller's own scope, hand it to the pure rule, write
// what the rule returned. The rule is where a value the store cannot hold is refused.
//
// The session in the path must hold the set: absent, another account's, and this account's set in a
// different workout are one reply. Nothing is settled and nothing is refused for a finished session.
//
// The one race it accepts: two devices correcting the same set at once leave the second one's values
// standing, merged against a row it read a moment earlier. Every version either replaced is kept.
std::optional<Set> TrainingService::fixSet(const UserId& user, const SessionId& session,
                                           const SetId& id, const SetFix& fix) {
  std::optional<Set> stored = log_.setOf(user, id);
  if (!stored || !(stored->session == session)) return std::nullopt;
  return log_.updateSet(user, corrected(*stored, fix));
}

// Says nothing back on purpose, so a client whose network dropped sends the same delete again for
// the same reply. The row moves whole into the revisions table, marked deleted
// (ports/LogRepository.h); no door reads it back, so no surface may promise it.
void TrainingService::deleteSet(const UserId& user, const SessionId& session, const SetId& id) {
  log_.deleteSet(user, session, id);
}

// A finish is permanent once it is the lifter's word — first-writer-wins between finishes, and only
// a stale close yields to one — so the instant is checked against the stored session before it lands.
//
// A session discarded between the load and the close leaves nothing to hand back, and the reply is
// the same absence a second finish would get.
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

// The page is loaded whole before a row is built: a record is judged against the history BEFORE its
// session, so the walk runs oldest first while the page is handed back newest first. The store's rows
// arrive newest first and the walk reads them backwards rather than re-sorting.
//
// A page carries the OPEN session like any other row, while the marks standing before the page count
// finished sessions alone, so each row tells the walk whether it is over and the walk folds only
// those.
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

// The mirror's read, every five seconds while a desk tab is open. It settles staleness; a phone's
// owed sets arriving after that close still land under lateSetLands.
std::optional<SessionDetail> TrainingService::detail(const UserId& user, const SessionId& session) {
  settleOpen(log_, user, clock_.nowMs());
  std::optional<Session> stored = log_.session(user, session);
  if (!stored) return std::nullopt;
  return SessionDetail{*stored, log_.setsOf(session)};
}

// Fired on every movement change, so it settles nothing and writes nothing: the only session
// settleOpen could reach here is the caller's own live one, and closing that mid-workout would refuse
// every set after it while this reply says nothing about the session. A start and the client's boot
// log read settle staleness instead. The store's two facts pass through untouched: no history at all,
// and no such movement.
LastTimeOutcome TrainingService::lastTime(const UserId& user, const ExerciseId& exercise) {
  return log_.lastTime(user, exercise);
}

// The same read for the whole catalog at once, settling nothing for the reason the one above does
// not.
std::vector<LastSet> TrainingService::lastSets(const UserId& user) {
  return log_.lastSets(user);
}

// Load the session, its sets and the history the rules need, then hand all three to the pure rule.
// Nothing is decided here and nothing is stored: the review is recomputed on every read.
std::optional<Review> TrainingService::review(const UserId& user, const SessionId& session) {
  std::optional<Session> stored = log_.session(user, session);
  if (!stored) return std::nullopt;
  return wm::gym::review(*stored, log_.setsOf(session), log_.historyFor(user, *stored));
}

// Its only refusal the store cannot state is a session still running: deleting a workout somebody is
// still logging into destroys the sets in flight. Staleness is settled by a start and a log read and
// deliberately not here. The row going between the load and the delete is the same fact as never
// having been there.
DiscardOutcome TrainingService::discard(const UserId& user, const SessionId& session) {
  std::optional<Session> stored = log_.session(user, session);
  if (!stored) return DiscardOutcome::notFound;
  if (!stored->finishedAtMs) return DiscardOutcome::open;
  if (!log_.deleteSession(user, session)) return DiscardOutcome::notFound;
  return DiscardOutcome::done;
}

// The review's shape over a longer window. Staleness IS settled first: the answer counts finished
// sessions only, so a workout the four-hour rule ended but nobody has read since would be missing
// from every chart.
Statistics TrainingService::statistics(const UserId& user) {
  settleOpen(log_, user, clock_.nowMs());
  return wm::gym::statistics(log_.trainingLog(user));
}

// The statistics read's shape narrowed to one movement: settle staleness, load, hand it to the pure
// rule. The clock is read once and passed in, so the twelve-week window and the settle cannot
// disagree about what now is.
std::optional<MovementRecord> TrainingService::movementRecord(const UserId& user,
                                                              const ExerciseId& exercise) {
  const std::uint64_t nowMs = clock_.nowMs();
  settleOpen(log_, user, nowMs);
  MovementHistory history = log_.movementHistory(user, exercise);
  if (!history.exercise) return std::nullopt;
  return wm::gym::movementRecord(*history.exercise, history, nowMs);
}

// The export settles nothing on purpose: it hands back every set unconditionally, so no session can
// be missing from it whatever finished_at says.
std::vector<ExportedSet> TrainingService::exportedSets(const UserId& user) {
  return log_.exportedSets(user);
}

// The token is minted HERE and never parsed from anywhere: the one id in this product the client does
// not choose. The store resolves the write — a live share answers with itself, an expired one is
// replaced, and a session this caller cannot read answers with nothing.
std::optional<SessionShare> TrainingService::share(const UserId& user, const SessionId& session) {
  // One clock read decides both halves — what the new share ends at, and whether the one already on
  // this session has ended — so a share cannot expire between the two questions.
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
