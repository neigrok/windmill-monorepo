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

// The write shapes the wire parses into — everything the client says, nothing the server decides
// (the set number and the owner are the store's and the session's to assign).
//
// joinOpenSession says which of two things a Start means, and startedAt cannot tell them apart:
// joining puts the caller into whatever session is open, which is what makes a device-to-device
// handoff free; declining creates exactly the session named, which is what backfill and import need
// so a past workout's sets are not filed into the live one. It defaults to the join. Any surface may
// state either; the server never asks who is asking.
//
// routine is the day of the program this workout is: the server loads it, freezes its name and its
// entries onto the session, and answers with that snapshot — the client never composes the copy.
// Omitted is the ad-hoc session. It is read only where a session is CREATED: a replay and a join are
// handed the session the store already holds, with the plan it began under, and neither is refused
// for a routine deleted since.
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

// How a write can refuse, as facts the HTTP edge maps to statuses (400 / 404 / 409); flow control is
// never an exception here, and InvalidTraining stays reserved for malformed input.
//
// idTaken: a client-minted id is already spent, never by whom, so absent stays byte-identical to
// forbidden. unknownExercise comes from the store and passes through untouched. alreadyOpen is
// reachable only by a caller that said it would not join. unknownRoutine is a CREATING start naming
// a plan this account cannot read, refused rather than started ad-hoc; a replay and a join cannot
// reach it. `deleted` names a set this lifter TOOK OUT of the log — never answered as idTaken, whose
// repair is minting a fresh id and resending, which would bring the deleted set back. Nothing
// repairs this one: the queue holding it drops it.
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

// One row of the log as a SURFACE reads it: the store's summary, plus the two facts on it that are
// rules rather than aggregations.
//
// record is the gold dot: the domain's three rules (domain/Review.h) run over the whole page in one
// walk against the marks standing before it, which takes the walk being told which rows are FINISHED
// because the finish read counts finished sessions alone. Recomputed on every read and stored
// nowhere, so a late set or a correction moves the dot.
//
// topE1rm is `topE1rmOf` over the loads the store handed back — the same function the finish
// screen's `ReviewStats::topE1rm` comes through. It is the best estimate over every working set and
// NOT Epley over `summary.topSet`, which disagree on a top-set-and-back-offs session. Epley reaches
// neither the database nor a client. Absent exactly where Epley is undefined.
struct LogRow {
  SessionSummary summary;
  std::optional<double> topE1rm;
  bool record = false;

  bool operator==(const LogRow&) const = default;
};

// A discard answers with a status and nothing else — a deleted session has no row to hand back.
// `open` refuses to delete a workout still being logged into, whose queued sets are in flight.
enum class DiscardOutcome { done, notFound, open };

// The application seam over the training log: the HTTP adapter and the MCP tools talk to this, never
// to the repository. It owns the two-phase auto-close (load the open session + its last set instant →
// the pure rule → persist the close) and the write-then-resolve idempotency story — every write
// returns the resolved row, so a replayed or double-tapped client sees the winning truth in one round
// trip. No cron, no sweep: staleness is settled lazily, before a start and before every read whose
// answer a close rewrites.
//
// The program port is here for exactly one write: a start that names a routine freezes that day's
// plan onto the session, loaded from the store's own routine. It is a port and not ProgramService
// because services depend on ports and the domain, never on each other.
//
// The token generator is here for exactly one thing — minting a coach share's secret — and it is the
// platform's own, the same mint that makes a session cookie and a magic link.
class TrainingService {
public:
  TrainingService(LogRepository& log, ProgramRepository& program, Clock& clock,
                  TokenGenerator& tokens);

  StartOutcome start(const UserId& user, const SessionStart& incoming);
  AppendOutcome append(const UserId& user, const SessionId& session, const SetWrite& incoming);
  FinishOutcome finish(const UserId& user, const SessionId& session, std::uint64_t finishedAtMs);

  // The correction and the delete beside it: the log moves, the routine does not. Both name the
  // SESSION as well as the set, so a set id resolving under this account but in another workout is
  // the same absent fact as one that never existed.
  //
  // `fixSet` is the load → pure rule → write → answer-with-the-store shape; `deleteSet` answers
  // nothing, which makes a lost reply safe to send again. Neither reaches `gym_sessions.plan` or a
  // routine entry.
  std::optional<Set> fixSet(const UserId& user, const SessionId& session, const SetId& id,
                            const SetFix& fix);
  void deleteSet(const UserId& user, const SessionId& session, const SetId& id);
  std::vector<LogRow> log(const UserId& user, const LogCursor& cursor);
  std::optional<SessionDetail> detail(const UserId& user, const SessionId& session);
  // Is a workout running? Settled first — the same lazy close a log read takes — so a session
  // walked away from yesterday answers as the closed thing it is. One row rather than a search:
  // one open session per account is the store's own index.
  std::optional<Session> openSession(const UserId& user);
  LastTimeOutcome lastTime(const UserId& user, const ExerciseId& exercise);
  // The picker's meta beside the catalog and deliberately not inside it, asked for by the one surface
  // that draws it. Which set is "last" is the store's ordering, the same one lastTime states.
  std::vector<LastSet> lastSets(const UserId& user);

  // review has no refusal of its own: an absent review is an absent session.
  std::optional<Review> review(const UserId& user, const SessionId& session);
  DiscardOutcome discard(const UserId& user, const SessionId& session);

  // `statistics` is one load and one pure rule; `exportedSets` has no rule at all and hands back what
  // is stored.
  Statistics statistics(const UserId& user);
  std::vector<ExportedSet> exportedSets(const UserId& user);
  // The same one-load-one-rule shape narrowed to one movement. A read OF THE LOG, living here though
  // CatalogApi mounts it under the movement's path. Absent means this account's catalog holds no such
  // movement.
  std::optional<MovementRecord> movementRecord(const UserId& user, const ExerciseId& exercise);

  // The mint answers with the live share on a repeat, resolved by the store. An absent answer covers
  // absent and another account's alike.
  std::optional<SessionShare> share(const UserId& user, const SessionId& session);
  bool revokeShare(const UserId& user, const SessionId& session);
  // The one read here with no caller, and it settles NOTHING: a stranger holding a link must never
  // write to the owner's log, not even the four-hour close. The token is the whole credential.
  std::optional<SharedSession> shared(const std::string& token);

private:
  LogRepository& log_;
  ProgramRepository& program_;
  Clock& clock_;
  TokenGenerator& tokens_;
};

}
