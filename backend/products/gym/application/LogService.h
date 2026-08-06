#pragma once

#include "platform/ports/Clock.h"
#include "platform/ports/TokenGenerator.h"
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
//
// routine is the day of the program this workout is: the server loads it, freezes its name and its
// entries onto the session, and answers with that snapshot. The client never composes the copy —
// a client-composed one freezes whatever that client last read, which is the staleness the
// snapshot exists to prevent. Omitted is the ad-hoc session, which is most of them. It is read only
// where a session is CREATED: a replay and a join are handed the session the store already holds,
// with the plan that session began under, and neither is refused for a routine deleted since.
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

// The plan writes. A routine travels as its WHOLE document — a create and a replace send the same
// shape, and the editor's every change is a read-modify-write of it — so there is no per-entry
// route, no reorder verb, and nothing to reconcile between them. Entry positions are the order the
// entries arrive in; the Routine constructor is what refuses anything else.
struct RoutineWrite {
  RoutineId id;
  std::string name;
  int position;
  std::vector<RoutineEntry> entries;
};

// A movement a lifter created, off the picker's "no movement by that name". stepKg is the one
// optional: omitted, the equipment decides it (defaultStepKg), which is how the 64 seeds were
// written and how a custom barbell lift comes to climb like a seeded one.
struct ExerciseWrite {
  ExerciseId id;
  std::string name;
  Pattern pattern;
  Equipment equipment;
  std::optional<double> stepKg;
};

// How a write can refuse, as facts the HTTP edge maps to statuses (400 / 404 / 409) — flow control
// is never an exception here; InvalidTraining stays reserved for malformed input (the other 400).
// Every refusal is a fact about the caller's own log: idTaken says a client-minted id is already
// spent, never by whom, so absent stays byte-identical to forbidden. unknownExercise arrives from
// the store, which is the only layer that knows the catalog, and is passed through untouched.
// alreadyOpen is reachable only by a caller that said it would not join: this lifter's own workout
// is in progress, so the session it asked for could not be created, and the join that would have
// created the illusion of one is exactly the data corruption it declined. unknownRoutine is a
// CREATING start that named a plan this account cannot read — refused rather than started ad-hoc,
// because a session that quietly loses its plan is a workout with no targets and no way to notice.
// It is unreachable from a replay or a join, which are handed a session that already exists.
enum class StartError { none, idTaken, alreadyOpen, unknownRoutine };
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

// A discard answers with a status and nothing else — a deleted session has no row to hand back —
// so this is the one operation here with no `{value, error}` pair beside it. `open` is the refusal
// the store cannot state on its own: only the device holding the offline queue knows every set has
// landed, and deleting a workout somebody is still logging into destroys the sets in flight.
enum class DiscardOutcome { done, notFound, open };

// The application seam over the training log: the HTTP adapter talks to this, never to the
// repository. It owns the two-phase auto-close (load the open session + its last set instant →
// the pure rule → persist the close) and the write-then-resolve idempotency story — every write
// returns the resolved row, so a replayed or double-tapped client sees the winning truth in one
// round trip. No cron, no sweep: staleness is settled lazily, before a start, before a log read and
// before the statistics read — the three replies a close rewrites.
//
// The token generator is here for exactly one thing — minting a coach share's secret — and it is
// the platform's own, the same mint that makes a session cookie and a magic link, so the one
// unguessable string gym hands out is not a second-best random of gym's own.
class LogService {
public:
  LogService(TrainingRepository& repo, Clock& clock, TokenGenerator& tokens);

  StartOutcome start(const UserId& user, const SessionStart& incoming);
  AppendOutcome append(const UserId& user, const SessionId& session, const SetWrite& incoming);
  FinishOutcome finish(const UserId& user, const SessionId& session, std::uint64_t finishedAtMs);
  std::vector<SessionSummary> log(const UserId& user, const LogCursor& cursor);
  std::optional<SessionDetail> detail(const UserId& user, const SessionId& session);
  std::vector<Exercise> catalog(const UserId& user);
  LastTimeOutcome lastTime(const UserId& user, const ExerciseId& exercise);

  // The plan, and the catalog's one write. Every refusal these can answer is the store's own fact,
  // so they hand the port's outcomes straight back rather than re-spelling them into a second enum
  // that could only ever say the same words — the same pass-through lastTime is.
  std::vector<Routine> routines(const UserId& user);
  std::optional<Routine> routine(const UserId& user, const RoutineId& id);
  RoutineWriteOutcome createRoutine(const UserId& user, const RoutineWrite& incoming);
  // The PATH names the routine being replaced; the body carries what it becomes.
  RoutineWriteOutcome replaceRoutine(const UserId& user, const RoutineId& id,
                                     const RoutineWrite& incoming);
  bool deleteRoutine(const UserId& user, const RoutineId& id);
  ExerciseInsertOutcome createExercise(const UserId& user, const ExerciseWrite& incoming);

  // The finish surface. review is a read with no refusal of its own — an absent review is an absent
  // session, exactly as detail's is — and discard is the one door that takes something away.
  std::optional<Review> review(const UserId& user, const SessionId& session);
  DiscardOutcome discard(const UserId& user, const SessionId& session);

  // The two long reads. `statistics` is one load and one pure rule, exactly as `review` is — the
  // shape this service uses wherever a surface is computed rather than stored. `exportedSets` has
  // no rule at all: it hands back what is stored, which is the point of an export.
  Statistics statistics(const UserId& user);
  std::vector<ExportedSet> exportedSets(const UserId& user);

  // The coach share. The mint answers with the live share on a repeat, so nothing here has to ask
  // first — the store resolves it, the same write-then-resolve every other write in this file uses.
  // An absent answer is the one fact a session read gives: absent and another account's alike.
  std::optional<SessionShare> share(const UserId& user, const SessionId& session);
  bool revokeShare(const UserId& user, const SessionId& session);
  // The one read here with no caller, and it settles NOTHING: a stranger holding a link must never
  // be able to write to the owner's log, not even the four-hour close every authenticated read
  // takes. The token is the whole credential and the clock decides whether it is still one.
  std::optional<SharedSession> shared(const std::string& token);

private:
  TrainingRepository& repo_;
  Clock& clock_;
  TokenGenerator& tokens_;
};

}
