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
}

LogService::LogService(TrainingRepository& repo, Clock& clock) : repo_(repo), clock_(clock) {}

// Idempotent by construction, no guard flag anywhere, and the caller's OWN id is resolved first: a
// replayed POST reads back the session it minted — open, finished or auto-closed — so a replay
// never depends on what else happens to be open, and it is idempotent whichever Start it meant.
// Only when nothing landed under that id does the open session enter the story, and there the
// caller's intent decides: a double-tap that minted a second id no-ops on the one-open index and
// joins the first tap's session (so does the borrowed iPad, §11.3), while a caller that said it
// will not join is refused rather than handed a live workout it would file a past session's sets
// into. When NOTHING resolves and nothing is open, the insert no-oped on a row owned by someone
// else — the reply is a refusal, never a session the store never accepted.
StartOutcome LogService::start(const UserId& user, const SessionStart& incoming) {
  settleOpen(repo_, user, clock_.nowMs());
  repo_.insertSession(Session{incoming.id, user, incoming.startedAtMs});
  std::optional<Session> stored = repo_.session(user, incoming.id);
  if (stored) return {*stored, StartError::none};
  std::optional<Session> open = repo_.open(user);
  if (!open) return {std::nullopt, StartError::idTaken};
  if (incoming.joinOpenSession) return {*open, StartError::none};
  return {std::nullopt, StartError::alreadyOpen};
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

}
