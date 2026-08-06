#include "products/gym/application/LogService.h"

namespace wm::gym {

namespace {
// The lazy half of §3.2: load the user's open session and its last set instant, ask the pure rule,
// persist the close if the domain says the session is over. Called before a start and before a log
// read — the two routes whose reply carries the session state a close rewrites — so no ticker ever
// runs for gym, and no close ever lands where the client cannot see it.
void settleOpen(TrainingRepository& repo, const UserId& user, std::uint64_t nowMs) {
  std::optional<Session> open = repo.open(user);
  if (!open) return;
  std::optional<std::uint64_t> closeAt = autoCloseAt(*open, repo.lastActivity(open->id), nowMs);
  if (!closeAt) return;
  repo.close(open->id, *closeAt);
}

// What the store ALREADY holds for this caller, and nothing else: their own row under this id first
// — so a replay is idempotent whatever else is going on — then the open session, whose fate the
// caller's stated intent decides. Both answers carry the session's OWN stored snapshot, which is
// how pressing Start cannot re-plan a workout that is already running. An empty answer means the
// store holds nothing this caller is entitled to, and only then does a session get created.
std::optional<StartOutcome> heldFor(TrainingRepository& repo, const UserId& user,
                                    const SessionStart& incoming) {
  std::optional<Session> own = repo.session(user, incoming.id);
  if (own) return StartOutcome{*own, StartError::none};
  std::optional<Session> open = repo.open(user);
  if (!open) return std::nullopt;
  if (incoming.joinOpenSession) return StartOutcome{*open, StartError::none};
  return StartOutcome{std::nullopt, StartError::alreadyOpen};
}
}

LogService::LogService(TrainingRepository& repo, Clock& clock, TokenGenerator& tokens)
    : repo_(repo), clock_(clock), tokens_(tokens) {}

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
StartOutcome LogService::start(const UserId& user, const SessionStart& incoming) {
  settleOpen(repo_, user, clock_.nowMs());
  std::optional<StartOutcome> already = heldFor(repo_, user, incoming);
  if (already) return *already;
  std::optional<PlanSnapshot> plan;
  if (incoming.routine) {
    std::optional<Routine> planned = repo_.routine(user, *incoming.routine);
    if (!planned) return {std::nullopt, StartError::unknownRoutine};
    plan = snapshotOf(*planned);
  }
  repo_.insertSession(
      Session{incoming.id, user, incoming.startedAtMs, std::nullopt, incoming.routine, plan});
  std::optional<StartOutcome> landed = heldFor(repo_, user, incoming);
  if (landed) return *landed;
  return {std::nullopt, StartError::idTaken};
}

// No auto-close here on purpose: the background flush replays offline sets into whatever session
// they belong to, however stale — only a start or a log read settles staleness. An absent or
// another's session is the same fact (not found). The replay is resolved BEFORE the finished
// refusal: a set that is already durable answers with itself however the session ended, so a
// flush queue that treats 409 as terminal can never drop a row it in fact landed. A set that never
// landed is another matter — the session is closed and this one is refused (§3.3). The last two
// refusals are the store's own facts, passed through as they arrive: only it knows the catalog, and
// only its read-back knows whether a fresh id was already spent somewhere this session cannot see.
AppendOutcome LogService::append(const UserId& user, const SessionId& session,
                                 const SetWrite& incoming) {
  std::optional<Session> stored = repo_.session(user, session);
  if (!stored) return {std::nullopt, AppendError::notFound};
  Set set{incoming.id, session, incoming.exercise, 0, incoming.weightKg, incoming.reps,
          incoming.kind, incoming.rpe, incoming.note, incoming.completedAtMs};
  std::optional<Set> replayed = repo_.setOf(user, set.id);
  if (replayed && replayed->session == session) return {*replayed, AppendError::none};
  if (replayed) return {std::nullopt, AppendError::idTaken};
  if (stored->finishedAtMs) return {std::nullopt, AppendError::finished};
  SetInsertOutcome written = repo_.insertSet(set);
  if (written.error == SetInsertError::idTaken) return {std::nullopt, AppendError::idTaken};
  if (written.error == SetInsertError::unknownExercise)
    return {std::nullopt, AppendError::unknownExercise};
  return {*written.set, AppendError::none};
}

// The first write to finished_at is permanent (close is first-writer-wins), so the instant is
// checked against the stored session before it can land — a workout that ends before it began, or
// at an instant the store cannot hold, is refused rather than frozen into the log forever.
FinishOutcome LogService::finish(const UserId& user, const SessionId& session,
                                 std::uint64_t finishedAtMs) {
  std::optional<Session> stored = repo_.session(user, session);
  if (!stored) return {std::nullopt, FinishError::notFound};
  if (!canFinishAt(*stored, finishedAtMs)) return {std::nullopt, FinishError::badInstant};
  if (stored->finishedAtMs) return {*stored, FinishError::none};   // replay, or already auto-closed
  repo_.close(session, finishedAtMs);
  return {repo_.session(user, session), FinishError::none};
}

std::vector<SessionSummary> LogService::log(const UserId& user, const LogCursor& cursor) {
  settleOpen(repo_, user, clock_.nowMs());
  return repo_.log(user, cursor);
}

std::optional<SessionDetail> LogService::detail(const UserId& user, const SessionId& session) {
  std::optional<Session> stored = repo_.session(user, session);
  if (!stored) return std::nullopt;
  return SessionDetail{*stored, repo_.setsOf(session)};
}

std::vector<Exercise> LogService::catalog(const UserId& user) {
  return repo_.catalog(user);
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
LastTimeOutcome LogService::lastTime(const UserId& user, const ExerciseId& exercise) {
  return repo_.lastTime(user, exercise);
}

std::vector<Routine> LogService::routines(const UserId& user) {
  return repo_.routines(user);
}

std::optional<Routine> LogService::routine(const UserId& user, const RoutineId& id) {
  return repo_.routine(user, id);
}

// Both routine writes are one construction and one call, and that is the whole point of the shape:
// the entity's constructor is the entire validation (it throws InvalidTraining, which the wire
// turns into a 400), and the store's outcome is the entire refusal set. Neither write reads before
// it writes — a load-then-decide here would be a race the SQL already settles, and the create's
// idempotency is the id, not a lookup: a create that lost its reply and was sent again reads back
// the STORED routine untouched, exactly as a replayed start does.
RoutineWriteOutcome LogService::createRoutine(const UserId& user, const RoutineWrite& incoming) {
  return repo_.insertRoutine(
      Routine{incoming.id, user, incoming.name, incoming.position, incoming.entries});
}

RoutineWriteOutcome LogService::replaceRoutine(const UserId& user, const RoutineId& id,
                                               const RoutineWrite& incoming) {
  return repo_.replaceRoutine(Routine{id, user, incoming.name, incoming.position, incoming.entries});
}

bool LogService::deleteRoutine(const UserId& user, const RoutineId& id) {
  return repo_.deleteRoutine(user, id);
}

// The one site that applies the equipment's default step, so a movement created without one climbs
// like the seed row it sits beside and no client has to carry the table. Every created movement is
// custom by construction — the seeds are the schema's, and nothing on the wire can mint one.
ExerciseInsertOutcome LogService::createExercise(const UserId& user, const ExerciseWrite& incoming) {
  return repo_.insertExercise(
      user, Exercise{incoming.id, incoming.name, incoming.pattern, incoming.equipment,
                     incoming.stepKg.value_or(defaultStepKg(incoming.equipment)), true});
}

// Two phases and no third: load the session, its sets and the history the rules need, then hand all
// three to the pure rule and answer with what it computed. Nothing here decides anything — every
// number on the finish screen is the domain's, so the web and the phone cannot print two different
// records for one workout. Nothing is stored either: the review is recomputed on every read, which
// is what keeps it right after a set arrives late from a flush queue.
std::optional<Review> LogService::review(const UserId& user, const SessionId& session) {
  std::optional<Session> stored = repo_.session(user, session);
  if (!stored) return std::nullopt;
  return wm::gym::review(*stored, repo_.setsOf(session), repo_.historyFor(user, *stored));
}

// The one destructive action in the product, and its only refusal is the one the store cannot state:
// a session still running. Only the device holding the offline queue knows every set landed, so
// deleting a workout somebody is still logging into destroys sets in flight — the door is offered at
// the finish screen, after the close. Staleness is settled by a start and by a log read (§3.2) and
// deliberately not here: a write on the way to a delete would be a rule this door invented. The last
// refusal is the race — the row went between the load and the delete — and it is the same fact as
// never having been there at all.
DiscardOutcome LogService::discard(const UserId& user, const SessionId& session) {
  std::optional<Session> stored = repo_.session(user, session);
  if (!stored) return DiscardOutcome::notFound;
  if (!stored->finishedAtMs) return DiscardOutcome::open;
  if (!repo_.deleteSession(user, session)) return DiscardOutcome::notFound;
  return DiscardOutcome::done;
}

// Two phases and no third, the review's shape over a longer window: load what the rule needs, hand
// it to the pure rule, answer with what it computed. Staleness IS settled first, and this is the
// third door that settles it — the answer counts finished sessions only, so a workout the four-hour
// rule ended hours ago but nobody has read since would be missing from every chart, and a hole in a
// chart is read as "I did not train that week".
Statistics LogService::statistics(const UserId& user) {
  settleOpen(repo_, user, clock_.nowMs());
  return wm::gym::statistics(repo_.trainingLog(user));
}

// The export settles nothing on purpose, and it is the only read of the log that could and does
// not: it hands back every set unconditionally, so no session can be missing from it whatever
// finished_at says, and a door whose whole promise is "here is your data, untouched" has no
// business writing to the log on the way out.
std::vector<ExportedSet> LogService::exportedSets(const UserId& user) {
  return repo_.exportedSets(user);
}

// The token is minted HERE and never parsed from anywhere: the one id in this product the client
// does not choose, because a client that chose it would choose a guessable one. The store resolves
// the write like every other — a live share answers with itself, an expired one is replaced, and a
// session this caller cannot read answers with nothing.
std::optional<SessionShare> LogService::share(const UserId& user, const SessionId& session) {
  // One clock reads once and decides both halves — what the new share would end at, and whether the
  // one already on this session has ended. Asking the clock twice, or letting the database answer
  // one of them, is how a share that expired between the two questions comes back as live.
  const std::uint64_t nowMs = clock_.nowMs();
  return repo_.insertShare(
      SessionShare{session, user, tokens_.mint().secret, shareExpiryAt(nowMs)}, nowMs);
}

bool LogService::revokeShare(const UserId& user, const SessionId& session) {
  return repo_.revokeShare(user, session);
}

std::optional<SharedSession> LogService::shared(const std::string& token) {
  return repo_.sharedSession(token, clock_.nowMs());
}

}
