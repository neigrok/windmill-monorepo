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
//
// joinOpenSession is the one thing about a Start that cannot be read off its other fields. The
// phone pressing Start means "get me into the open session, whatever it is" — that join is what
// makes the device-to-device handoff free (§11.3), a dead phone and a borrowed iPad continuing one
// workout. Backfill and lift-import mean the opposite thing in the same shape: "create exactly this
// session, which is not now", and for them a join files a past workout's sets into the live one.
// startedAt cannot tell the two apart — clock skew and a genuinely-ten-minutes-ago handoff read
// identically — so the caller states which it means, and a silent heuristic never guesses. The
// default is the join, because that is what every caller written before this field meant. It is not
// a surface gate (§11): any surface may state either, and the server still never asks who is asking.
struct SessionStart {
  SessionId id;
  std::uint64_t startedAtMs;
  bool joinOpenSession = true;
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
// alreadyOpen is reachable only by a caller that said it would not join: this lifter's own workout
// is in progress, so the session it asked for could not be created, and the join that would have
// created the illusion of one is exactly the data corruption it declined.
enum class StartError { none, idTaken, alreadyOpen };
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
