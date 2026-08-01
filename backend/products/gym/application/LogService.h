#pragma once

#include "platform/ports/Clock.h"
#include "products/gym/ports/TrainingRepository.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// The write shapes the wire parses into — everything the client says, nothing the server decides
// (the set number and the owner are the store's and the session's to assign).
struct SessionStart {
  SessionId id;
  std::uint64_t startedAtMs;
};

struct SetWrite {
  SetId id;
  ExerciseId exercise;
  double weightKg;
  int reps;
  SetKind kind;
  std::optional<double> rpe;
  std::string note;
  std::uint64_t completedAtMs;
};

// How a write can refuse, as facts the HTTP edge maps to statuses (400 / 404 / 409) — flow control
// is never an exception here; InvalidTraining stays reserved for malformed input (the other 400).
// Every refusal is a fact about the caller's own log: idTaken says a client-minted id is already
// spent, never by whom, so absent stays byte-identical to forbidden. unknownExercise arrives from
// the store, which is the only layer that knows the catalog, and is passed through untouched.
enum class StartError { none, idTaken };
enum class AppendError { none, notFound, finished, idTaken, unknownExercise };
enum class FinishError { none, notFound, badInstant };

struct StartOutcome {
  std::optional<Session> session;
  StartError error;
};

struct AppendOutcome {
  std::optional<Set> set;
  AppendError error;
};

struct FinishOutcome {
  std::optional<Session> session;
  FinishError error;
};

struct SessionDetail {
  Session session;
  std::vector<Set> sets;

  bool operator==(const SessionDetail&) const = default;
};

// The application seam over the training log: the HTTP adapter talks to this, never to the
// repository. It owns the two-phase auto-close (load the open session + its last set instant →
// the pure rule → persist the close) and the write-then-resolve idempotency story — every write
// returns the resolved row, so a replayed or double-tapped client sees the winning truth in one
// round trip. No cron, no sweep: staleness is settled lazily, before a start and before a log read.
class LogService {
public:
  LogService(TrainingRepository& repo, Clock& clock);

  StartOutcome start(const UserId& user, const SessionStart& incoming);
  AppendOutcome append(const UserId& user, const SessionId& session, const SetWrite& incoming);
  FinishOutcome finish(const UserId& user, const SessionId& session, std::uint64_t finishedAtMs);
  std::vector<SessionSummary> log(const UserId& user, const LogCursor& cursor);
  std::optional<SessionDetail> detail(const UserId& user, const SessionId& session);
  std::vector<Exercise> catalog(const UserId& user);
  LastTimeOutcome lastTime(const UserId& user, const ExerciseId& exercise);

private:
  TrainingRepository& repo_;
  Clock& clock_;
};

}
