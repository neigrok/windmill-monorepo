#include "products/gym/application/LogService.h"

namespace wm::gym {

namespace {
// The lazy half of §3.2: load the user's open session and its last set instant, ask the pure rule,
// persist the close if the domain says the session is over. Called before a start and before a log
// read — the only two moments staleness could be observed — so no ticker ever runs for gym.
void settleOpen(TrainingRepository& repo, const UserId& user, std::uint64_t nowMs) {
  std::optional<Session> open = repo.open(user);
  if (!open) return;
  std::optional<std::uint64_t> closeAt = autoCloseAt(*open, repo.lastActivity(open->id), nowMs);
  if (!closeAt) return;
  repo.close(open->id, *closeAt);
}
}

LogService::LogService(TrainingRepository& repo, Clock& clock) : repo_(repo), clock_(clock) {}

// Idempotent by construction, no guard flag anywhere: a replayed POST no-ops on the PK and reads
// back its own session; a double-tap that minted two ids no-ops on the one-open index and reads
// back the first tap's; the replay of an already-finished start finds nothing open and the stored
// row answers. When NOTHING of this caller's resolves, the insert no-oped on a row owned by
// someone else — the reply is a refusal, never a session the store never accepted.
StartOutcome LogService::start(const UserId& user, const SessionStart& incoming) {
  settleOpen(repo_, user, clock_.nowMs());
  repo_.insertSession(Session{incoming.id, user, incoming.startedAtMs});
  std::optional<Session> open = repo_.open(user);
  if (open) return {*open, StartError::none};
  std::optional<Session> stored = repo_.session(user, incoming.id);
  if (stored) return {*stored, StartError::none};
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

}
