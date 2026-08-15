#include "products/gym/application/TrainingService.h"

#include <utility>

namespace wm::gym {

namespace {
// The lazy half of §3.2: load the user's open session and its last set instant, ask the pure rule,
// persist the close if the domain says the session is over. Called before a start and before a log
// read — the two routes whose reply carries the session state a close rewrites — so no ticker ever
// runs for gym, and no close ever lands where the client cannot see it.
void settleOpen(LogRepository& log, const UserId& user, std::uint64_t nowMs) {
  std::optional<Session> open = log.open(user);
  if (!open) return;
  std::optional<std::uint64_t> closeAt = autoCloseAt(*open, log.lastActivity(open->id), nowMs);
  if (!closeAt) return;
  log.close(open->id, *closeAt, ClosedBy::stale);
}

// What the store ALREADY holds for this caller, and nothing else: their own row under this id first
// — so a replay is idempotent whatever else is going on — then the open session, whose fate the
// caller's stated intent decides. Both answers carry the session's OWN stored snapshot, which is
// how pressing Start cannot re-plan a workout that is already running. An empty answer means the
// store holds nothing this caller is entitled to, and only then does a session get created.
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

// Idempotent by construction, no guard flag anywhere, and the caller's OWN id is resolved FIRST: a
// replayed POST reads back the session it minted — open, finished or auto-closed — so a replay
// never depends on what else happens to be open, and it is idempotent whichever Start it meant.
// Only when nothing landed under that id does the open session enter the story, and there the
// caller's intent decides: a double-tap that minted a second id joins the first tap's session (so
// does the borrowed iPad, §11.3), while a caller that said it will not join is refused rather than
// handed a live workout it would file a past session's sets into.
//
// Reading before writing is what makes that order real rather than merely intended. The plan is
// frozen HERE from the store's own routine (§2.5) — but only on the path that actually CREATES a
// session, because freezing it earlier made an absent routine refuse a replay and a join too, and
// neither of those is planning anything: they are being handed a session that already exists. A
// routine deleted after the workout began must not 404 the phone out of its own live session.
// So both branches that answer with a session the store already holds answer with ITS stored
// snapshot, whatever routineId this call carried — a replay keeps the plan it was started under,
// and pressing Start cannot re-plan a workout that is already running.
//
// The write is still resolved by a read: the insert no-ops on the PK (a replay that raced this one)
// and on the one-open index (a double-tap), so what the store holds AFTERWARDS is the answer. When
// nothing resolves even then, the insert no-oped on a row owned by someone else — the reply is a
// refusal, never a session the store never accepted.
StartOutcome TrainingService::start(const UserId& user, const SessionStart& incoming) {
  settleOpen(log_, user, clock_.nowMs());
  std::optional<StartOutcome> already = heldFor(log_, user, incoming);
  if (already) return *already;
  // Only a start that would CREATE is held to the clock: a replay hands back the row it already
  // has, and a join hands over the workout that is open, whatever the caller's clock says.
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

// No auto-close here on purpose: the background flush replays offline sets into whatever session
// they belong to, however stale — only a start or a log read settles staleness. An absent or
// another's session is the same fact (not found). The replay is resolved BEFORE the finished
// refusal: a set that is already durable answers with itself however the session ended, so a
// flush queue that treats 409 as terminal can never drop a row it in fact landed. A set that never
// landed is another matter — the session is closed and this one is refused (§3.3), by the STORE and
// only by the store: `finished` is the boundary the locked row decides, and this method used to
// answer it a second time off the row it loaded before the lock existed. Two layers deciding one
// fact is how they end up deciding it in different orders — the loaded-row copy answered `finished`
// for an id the store would have answered `deleted` for, and told a queue that a set it had in fact
// logged had never reached the log at all. Every refusal below is the store's own, passed through as
// it arrives: only it knows the catalog, only its read-back knows whether a fresh id was already
// spent somewhere this session cannot see, only its lock knows whether the close landed between the
// read above and the insert, and only it holds the revisions.
//
// THE REPLAY ABOVE IS NOT THE WHOLE OF THE IDEMPOTENCY, and that is the fourth. `setOf` reads the
// rows that STAND, so a set the lifter deleted resolves to nothing here and falls through to the
// insert — which would log it again, under a fresh number, from a queue that never learned its POST
// had landed. Only the store holds the revisions that say the id named a set taken out of the log,
// so only the store can refuse it, and it is passed through under its own word for the reason
// TrainingService.h gives: repairing it as a spent id is exactly how the deletion would undo itself.
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

// The correction — §G18's `Save the fix`, and the first write in this product that changes something
// a lifter already logged. Three phases and no fourth: load the stored row under the caller's own
// scope, hand it to the pure rule, write what the rule returned. The rule is where a value the store
// cannot hold is refused, so nothing unstorable is ever offered to the store — the same order
// renameExercise keeps.
//
// The session in the path has to hold the set, and that check is here rather than in the store
// because it is the same fact the store already answers: absent, another account's, and this
// account's set in a different workout are one reply, so nothing above this line can tell them
// apart. Nothing is settled and nothing is refused for a finished session — a lifter reads the log
// AFTER the workout, which is precisely when they notice the 4 they meant to log as a 5.
//
// The one race it accepts, stated rather than hidden: two devices correcting the same set at once
// leave the second one's values standing, merged against a row it read a moment earlier. Every
// version either of them replaced is kept, and the alternative — merging inside the store — would
// put the correction rule in SQL where the domain could not state it once.
std::optional<Set> TrainingService::fixSet(const UserId& user, const SessionId& session,
                                           const SetId& id, const SetFix& fix) {
  std::optional<Set> stored = log_.setOf(user, id);
  if (!stored || !(stored->session == session)) return std::nullopt;
  return log_.updateSet(user, corrected(*stored, fix));
}

// The delete, and it says nothing back on purpose: a set that was never there does not stand either,
// so the reply a client whose network dropped sends this again for is the reply it already had. What
// it does NOT do is destroy anything — the row moves whole into the revisions table, marked deleted
// (ports/LogRepository.h) — and nothing on any surface may promise that back, because there is
// no door that reads it.
void TrainingService::deleteSet(const UserId& user, const SessionId& session, const SetId& id) {
  log_.deleteSet(user, session, id);
}

// The first write to finished_at is permanent (close is first-writer-wins), so the instant is
// checked against the stored session before it can land — a workout that ends before it began, or
// at an instant the store cannot hold, is refused rather than frozen into the log forever.
//
// The read-back is answered like the load above it, and for the same reason every write in this file
// does: a session discarded between the load and the close leaves nothing to hand back, and `none`
// beside no session is a reply both wire edges dereference. It is the fact the session was already
// absent — the discard won the race, and the caller learns exactly what a second finish would tell it.
FinishOutcome TrainingService::finish(const UserId& user, const SessionId& session,
                                      std::uint64_t finishedAtMs) {
  std::optional<Session> stored = log_.session(user, session);
  if (!stored) return {std::nullopt, FinishError::notFound};
  if (!canFinishAt(*stored, finishedAtMs)) return {std::nullopt, FinishError::badInstant};
  if (stored->finishedAtMs) return {*stored, FinishError::none};   // replay, or already auto-closed
  log_.close(session, finishedAtMs, ClosedBy::finish);
  std::optional<Session> closed = log_.session(user, session);
  if (!closed) return {std::nullopt, FinishError::notFound};
  return {*closed, FinishError::none};
}

// Two rules over one read, and the second one is why the page is loaded whole before a row is
// built: a record is judged against the history BEFORE its session, so the walk runs oldest first
// over the whole page while the page itself is handed back newest first. The store's rows arrive
// newest first, so the walk reads them backwards and never re-sorts them.
//
// A page carries the OPEN session like any other row, and the marks standing before the page count
// finished sessions alone — the finish read's own window. So each row hands the walk whether it is
// over, and the walk folds only the ones that are; without that the two halves of one history are
// filtered differently and a row above a still-open workout is judged against a workout its own
// finish screen cannot see.
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

std::optional<SessionDetail> TrainingService::detail(const UserId& user, const SessionId& session) {
  std::optional<Session> stored = log_.session(user, session);
  if (!stored) return std::nullopt;
  return SessionDetail{*stored, log_.setsOf(session)};
}

// The number the logger puts in front of a lifter before they touch anything — and the one route
// fired on every movement change, so it settles nothing and writes nothing. The only session
// settleOpen could reach from here is the caller's OWN live one (the partial unique index allows no
// other), and closing that mid-workout refuses every set after it while this reply, which carries
// no session state, says nothing about it. Staleness is still settled before the prefill can be
// read: a start settles it, and so does the log read the client boots on — and until one of them
// stamps it the session is open, which is already not a last time. The store's own two facts come
// back untouched: no history at all, and no such movement, which look identical from here and are
// not the same thing to a client.
LastTimeOutcome TrainingService::lastTime(const UserId& user, const ExerciseId& exercise) {
  return log_.lastTime(user, exercise);
}

// The same read for the whole catalog at once, and it settles nothing for the same reason the one
// above does not: the picker opens mid-workout, and the only open session it could reach is the
// caller's own live one.
std::vector<LastSet> TrainingService::lastSets(const UserId& user) {
  return log_.lastSets(user);
}

// Two phases and no third: load the session, its sets and the history the rules need, then hand all
// three to the pure rule and answer with what it computed. Nothing here decides anything — every
// number on the finish screen is the domain's, so the web and the phone cannot print two different
// records for one workout. Nothing is stored either: the review is recomputed on every read, which
// is what keeps it right after a set arrives late from a flush queue.
std::optional<Review> TrainingService::review(const UserId& user, const SessionId& session) {
  std::optional<Session> stored = log_.session(user, session);
  if (!stored) return std::nullopt;
  return wm::gym::review(*stored, log_.setsOf(session), log_.historyFor(user, *stored));
}

// The one destructive action in the product, and its only refusal is the one the store cannot state:
// a session still running. Only the device holding the offline queue knows every set landed, so
// deleting a workout somebody is still logging into destroys sets in flight — the door is offered at
// the finish screen, after the close. Staleness is settled by a start and by a log read (§3.2) and
// deliberately not here: a write on the way to a delete would be a rule this door invented. The last
// refusal is the race — the row went between the load and the delete — and it is the same fact as
// never having been there at all.
DiscardOutcome TrainingService::discard(const UserId& user, const SessionId& session) {
  std::optional<Session> stored = log_.session(user, session);
  if (!stored) return DiscardOutcome::notFound;
  if (!stored->finishedAtMs) return DiscardOutcome::open;
  if (!log_.deleteSession(user, session)) return DiscardOutcome::notFound;
  return DiscardOutcome::done;
}

// Two phases and no third, the review's shape over a longer window: load what the rule needs, hand
// it to the pure rule, answer with what it computed. Staleness IS settled first, and this is the
// third door that settles it — the answer counts finished sessions only, so a workout the four-hour
// rule ended hours ago but nobody has read since would be missing from every chart, and a hole in a
// chart is read as "I did not train that week".
Statistics TrainingService::statistics(const UserId& user) {
  settleOpen(log_, user, clock_.nowMs());
  return wm::gym::statistics(log_.trainingLog(user));
}

// The record page, and it is the statistics read's own shape narrowed to one movement: settle
// staleness, load, hand it to the pure rule. Staleness is settled for the reason it is settled
// there — this answer counts finished sessions only, so a workout the four-hour rule ended hours
// ago but nobody has read since would be missing from the chart, and a hole in a chart is read as
// "I did not train that week". The clock is read once and passed in, so the twelve-week window and
// the settle cannot disagree about what now is.
std::optional<MovementRecord> TrainingService::movementRecord(const UserId& user,
                                                              const ExerciseId& exercise) {
  const std::uint64_t nowMs = clock_.nowMs();
  settleOpen(log_, user, nowMs);
  MovementHistory history = log_.movementHistory(user, exercise);
  if (!history.exercise) return std::nullopt;
  return wm::gym::movementRecord(*history.exercise, history, nowMs);
}

// The export settles nothing on purpose, and it is the only read of the log that could and does
// not: it hands back every set unconditionally, so no session can be missing from it whatever
// finished_at says, and a door whose whole promise is "here is your data, untouched" has no
// business writing to the log on the way out.
std::vector<ExportedSet> TrainingService::exportedSets(const UserId& user) {
  return log_.exportedSets(user);
}

// The token is minted HERE and never parsed from anywhere: the one id in this product the client
// does not choose, because a client that chose it would choose a guessable one. The store resolves
// the write like every other — a live share answers with itself, an expired one is replaced, and a
// session this caller cannot read answers with nothing.
std::optional<SessionShare> TrainingService::share(const UserId& user, const SessionId& session) {
  // One clock reads once and decides both halves — what the new share would end at, and whether the
  // one already on this session has ended. Asking the clock twice, or letting the database answer
  // one of them, is how a share that expired between the two questions comes back as live.
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
