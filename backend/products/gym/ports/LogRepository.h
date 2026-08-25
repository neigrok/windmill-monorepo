#pragma once

#include "products/gym/domain/Record.h"
#include "products/gym/domain/Review.h"
#include "products/gym/domain/Statistics.h"
#include "products/gym/domain/Training.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// Heaviest working set of a session, ties broken by more reps. Warmups, drops and failures excluded.
struct TopWorkingSet {
  double weightKg;
  int reps;

  bool operator==(const TopWorkingSet&) const = default;
};

// setCount counts every kind; workingSetCount only the working ones.
// tonnageKg is `sum(greatest(weight_kg, 0) * reps)` over working sets — a negative (band-assisted)
// load must not subtract. Zero means nothing measurable moved, never "no work".
// workingMarks: working sets collapsed to one row per (movement, load) carrying the best reps at it,
// grouped by movement, heaviest first inside each, dated by the SESSION's start. Loads at or below
// zero ride along unfiltered.
// closedItself reads `closed_by`, falling back to autoCloseAt's signature: finished_at exactly at
// the last set's instant, or at started_at for a session holding none.
struct SessionSummary {
  Session session;
  int setCount;
  int workingSetCount;
  double tonnageKg;
  std::vector<std::string> exerciseNames;
  std::optional<TopWorkingSet> topSet;
  std::vector<PriorMark> workingMarks;   // by movement, heaviest first, best reps at each
  bool closedItself = false;

  bool operator==(const SessionSummary&) const = default;
};

// `standing` is the marks that stood before the OLDEST row on the page, bounded by the page's own
// movements and by distinct loads, ordered by movement then heaviest load first. An empty page has
// empty `standing`.
struct LogPage {
  std::vector<SessionSummary> sessions;   // newest first
  std::vector<PriorMark> standing;

  bool operator==(const LogPage&) const = default;
};

// The most recent FINISHED session holding a non-warmup set of the movement, and its sets of that
// movement in set_number order; most recent is (startedAt, id). `sets` is never empty. routineName
// is the name frozen in the session's plan snapshot ("" when ad-hoc), never the routine's name today.
struct LastTime {
  Session session;
  std::string routineName;
  std::vector<Set> sets;

  bool operator==(const LastTime&) const = default;
};

// `LastTime`'s LAST row, the one the prefill dials off. atMs is the SESSION's start, never the set's
// own completed_at. The vector is SPARSE — one row per movement worked; absence is `never logged`.
struct LastSet {
  ExerciseId exercise;
  double weightKg;
  int reps;
  std::uint64_t atMs;

  bool operator==(const LastSet&) const = default;
};

// A first-ever movement comes back as an empty outcome with no error; unknownExercise means no
// catalog this account can see holds the movement at all.
enum class LastTimeError { none, unknownExercise };

struct LastTimeOutcome {
  std::optional<LastTime> lastTime;
  LastTimeError error;
};

// Where a page of the log resumes. The sort key is (startedAt, id), descending and unique end to
// end; beforeId is absent on the first page, the previous page's last id after that.
struct LogCursor {
  std::uint64_t beforeMs;
  std::optional<SessionId> beforeId;
  int limit;
};

// Every insertSet refusal crosses as a value, never an exception. idTaken: the id is spent on a row
// this session does not hold, never whose. unknownExercise: no movement this account's catalog
// holds. finished: the session was already closed when the write took its lock. deleted: the id
// belongs to a set the lifter deleted — never conflate with idTaken, whose repair (mint a fresh id
// and resend) would undo the deletion.
enum class SetInsertError { none, idTaken, unknownExercise, finished, deleted };

struct SetInsertOutcome {
  std::optional<Set> set;
  SetInsertError error;
};

// Text end to end, instants ISO-8601 UTC, numerics at their column's own scale (72.5 kg is "72.50"),
// an absent rpe an empty cell rather than a zero.
struct ExportedSet {
  std::string sessionId;
  std::string startedAt;
  std::string finishedAt;    // empty while the workout is still running
  std::string routineName;   // empty for an ad-hoc session
  std::string setId;
  std::string exerciseId;
  std::string exerciseName;
  std::string setNumber;
  std::string weightKg;
  std::string reps;
  std::string kind;
  std::string rpe;           // empty where none was logged
  std::string note;
  std::string completedAt;

  bool operator==(const ExportedSet&) const = default;
};

// The token is minted server-side, never accepted from a client; the session id is resolved against
// the caller's own log before a share is built from it.
struct SessionShare {
  SessionId session;
  UserId user;
  std::string token;
  std::uint64_t expiresAtMs;

  bool operator==(const SessionShare&) const = default;
};

// What the holder of a share link sees: no account, no ids, no frozen plan; the movement travels as its display name.
struct SharedSet {
  std::string exercise;
  int setNumber;
  double weightKg;
  int reps;
  SetKind kind;
  std::optional<double> rpe;
  std::string note;
  std::uint64_t completedAtMs;

  bool operator==(const SharedSet&) const = default;
};

struct SharedSession {
  std::uint64_t startedAtMs;
  std::optional<std::uint64_t> finishedAtMs;
  std::string routineName;   // empty when the session was ad-hoc
  std::vector<SharedSet> sets;

  bool operator==(const SharedSession&) const = default;
};

// Sessions, their sets, what corrections left behind, and the workout share, which goes with the
// session. Every read and write is owner-scoped by the UserId it carries; absent is byte-identical
// to forbidden. insertSession and insertSet are idempotent by client-minted id: they no-op on
// conflict and answer with the row that is stored, and one open session per user is a partial unique
// index, never a guard flag. The two writes that CHANGE a stored set are idempotent by shape —
// a correction assigns absolute values, and a delete of an already-gone set is a delete.
// A set id is spent once and for good: insertSet refuses an id gym_set_revisions holds as deleted,
// with `deleted` rather than `idTaken`.
struct LogRepository {
  virtual ~LogRepository() = default;

  virtual std::optional<Session> open(const UserId& user) = 0;
  virtual std::optional<Session> session(const UserId& user, const SessionId& id) = 0;
  virtual std::optional<Set> setOf(const UserId& user, const SetId& id) = 0;
  virtual std::optional<std::uint64_t> lastActivity(const SessionId& id) = 0;
  virtual void insertSession(const Session& incoming) = 0;                // conflict = no-op
  // Lands on an open session and records who closed. A lifter's finish is final: a replay or a race
  // keeps whichever landed first. A stale close is revisable — by a late set (lateSetLands), and by
  // the lifter's own finish, which upgrades closed_by to finish and moves finished_at as
  // finishAfterStaleClose says.
  virtual void close(const SessionId& id, std::uint64_t finishedAtMs, ClosedBy closedBy) = 0;
  // Assigns the set number and returns the stored row; every refusal is decided here. Answers
  // `finished` for every write arriving after the locked row closed, except the one lateSetLands
  // admits — a set continuing a STALE-closed workout lands and moves that workout's finish forward
  // to it in the same transaction. An id held as deleted is refused before either.
  virtual SetInsertOutcome insertSet(const Set& incoming) = 0;

  // What these replace is appended to gym_set_revisions; gym_sets keeps one row per set that stands.
  // `updateSet` takes the WHOLE corrected row, never a patch to merge, and answers with the stored
  // row. Absent covers no such set, another account's, and one this session does not hold alike.
  // `deleteSet` answers nothing, so a lost reply is repaired by sending the same delete again.
  // Neither write is refused for a finished session.
  virtual std::optional<Set> updateSet(const UserId& user, const Set& corrected) = 0;
  virtual void deleteSet(const UserId& user, const SessionId& session, const SetId& id) = 0;

  virtual LogPage log(const UserId& user, const LogCursor& cursor) = 0;
  virtual std::vector<Set> setsOf(const SessionId& id) = 0;
  // The prefill read: what this account did the last time it trained this movement.
  virtual LastTimeOutcome lastTime(const UserId& user, const ExerciseId& exercise) = 0;
  // The picker's read: the same rule over every movement this account has trained, in one pass.
  // Ordered by movement id, the key the caller joins it onto its catalog by.
  virtual std::vector<LastSet> lastSets(const UserId& user) = 0;

  // Everything the review rules need that the session does not hold, in one pass: the marks of the
  // movements it works, and the earlier session it stands against with its sets.
  virtual SessionHistory historyFor(const UserId& user, const Session& session) = 0;
  // The sets go with the row (`on delete cascade`).
  virtual bool deleteSession(const UserId& user, const SessionId& id) = 0;  // false = nothing to remove

  // One movement's whole page in one pass; the store hands over orderings only, no e1RM.
  virtual MovementHistory movementHistory(const UserId& user, const ExerciseId& exercise) = 0;

  // `tops` come back grouped by movement, oldest first within each group; no e1RM is computed here.
  virtual TrainingLog trainingLog(const UserId& user) = 0;
  // Every set this account holds, oldest first, including the workout still open.
  virtual std::vector<ExportedSet> exportedSets(const UserId& user) = 0;

  // Idempotent ON THE SESSION: a second call while a share is live hands back the same token; an
  // expired share is replaced rather than returned. Absent, another account's, and
  // already-shared-by-someone-else are one answer.
  virtual std::optional<SessionShare> insertShare(const SessionShare& incoming,
                                                  std::uint64_t nowMs) = 0;
  virtual bool revokeShare(const UserId& user, const SessionId& id) = 0;   // false = nothing to revoke
  // No owner behind it: the token IS the credential. Expiry is decided against the instant the
  // caller passes, never the database's clock. Revoked, expired and never-existed answer alike.
  virtual std::optional<SharedSession> sharedSession(const std::string& token,
                                                     std::uint64_t nowMs) = 0;
};

}
