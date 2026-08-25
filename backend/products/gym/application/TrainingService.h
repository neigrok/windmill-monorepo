#pragma once

#include "platform/ports/Clock.h"
#include "platform/ports/TokenGenerator.h"
#include "products/gym/ports/LogRepository.h"
#include "products/gym/ports/ProgramRepository.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// Everything the client says, nothing the server decides — the set number and the owner are the
// store's and the session's to assign.
// joinOpenSession true puts the caller into whatever session is open; false creates exactly the
// session named, which is what backfill and import need. Defaults to the join.
// routine is read only where a session is CREATED: the server loads it and freezes its name and
// entries onto the session; the client never composes the copy. Omitted is the ad-hoc session.
struct SessionStart {
  SessionId id;
  std::uint64_t startedAtMs;
  bool joinOpenSession = true;
  std::optional<RoutineId> routine;
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

// Refusals cross as values the HTTP edge maps to statuses; InvalidTraining stays reserved for
// malformed input. idTaken: a client-minted id is already spent, never by whom, so absent stays
// byte-identical to forbidden. alreadyOpen is reachable only by a caller that said it would not
// join. unknownRoutine is a CREATING start naming a plan this account cannot read, refused rather
// than started ad-hoc. `deleted` names a set this lifter TOOK OUT of the log — never answer it as
// idTaken, whose repair (mint a fresh id and resend) would bring the deleted set back.
enum class StartError { none, idTaken, alreadyOpen, unknownRoutine, clockAhead };
enum class AppendError { none, notFound, finished, idTaken, unknownExercise, deleted };
enum class FinishError { none, notFound, badInstant };

struct StartOutcome {
  std::optional<Session> session;
  StartError error;
  std::uint64_t clockAheadMs = 0;  // clockAhead only: how far the named start sits past the log's now
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

// `open` refuses to delete a workout still being logged into, whose queued sets are in flight.
enum class DiscardOutcome { done, notFound, open };

// The HTTP adapter and the MCP tools talk to this, never to the repository. Every write returns the
// resolved row, so a replayed or double-tapped client sees the winning truth in one round trip. No
// cron, no sweep: staleness is settled lazily, before a start and before every read whose answer a
// close rewrites.
// The program port serves one write: a start naming a routine freezes that day's plan onto the
// session. The token generator serves one: minting a workout share's secret.
class TrainingService {
public:
  TrainingService(LogRepository& log, ProgramRepository& program, Clock& clock,
                  TokenGenerator& tokens);

  StartOutcome start(const UserId& user, const SessionStart& incoming);
  AppendOutcome append(const UserId& user, const SessionId& session, const SetWrite& incoming);
  FinishOutcome finish(const UserId& user, const SessionId& session, std::uint64_t finishedAtMs);

  // Both name the SESSION as well as the set, so a set id resolving under this account but in
  // another workout is the same absent fact as one that never existed. `deleteSet` answers nothing,
  // which makes a lost reply safe to send again. Neither reaches `gym_sessions.plan` or a routine
  // entry.
  std::optional<Set> fixSet(const UserId& user, const SessionId& session, const SetId& id,
                            const SetFix& fix);
  void deleteSet(const UserId& user, const SessionId& session, const SetId& id);
  std::vector<LogRow> log(const UserId& user, const LogCursor& cursor);
  std::optional<SessionDetail> detail(const UserId& user, const SessionId& session);
  // Settled first, so a session walked away from yesterday answers as the closed thing it is.
  std::optional<Session> openSession(const UserId& user);
  LastTimeOutcome lastTime(const UserId& user, const ExerciseId& exercise);
  // Which set is "last" is the store's ordering, the same one lastTime states.
  std::vector<LastSet> lastSets(const UserId& user);

  // An absent review is an absent session.
  std::optional<Review> review(const UserId& user, const SessionId& session);
  DiscardOutcome discard(const UserId& user, const SessionId& session);

  Statistics statistics(const UserId& user);
  std::vector<ExportedSet> exportedSets(const UserId& user);
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
  ProgramRepository& program_;
  Clock& clock_;
  TokenGenerator& tokens_;
};

}
