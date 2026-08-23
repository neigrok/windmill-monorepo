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

// The heaviest working set of a whole session, ties broken by more reps — never by volume. Warmups,
// drops and failures cannot be a session's top.
struct TopWorkingSet {
  double weightKg;
  int reps;

  bool operator==(const TopWorkingSet&) const = default;
};

// One row of the training log read: the session plus what the list says about it without loading
// its sets.
//
// setCount is every set of every kind; workingSetCount only the working ones.
//
// tonnageKg is `sum(greatest(weight_kg, 0) * reps)` over the working sets: band-assisted work logs a
// negative load, so the clamp keeps it from subtracting. Zero means "nothing here moved a measurable
// load", never "no work" — surfaces draw nothing rather than `0.0 t`.
//
// workingMarks is the session's working sets collapsed to one row per (movement, load) carrying the
// best reps at it, grouped by movement and heaviest first inside each, dated by the SESSION's start;
// both implementations hand back the same vector. The row's e1RM is Epley's maximum over these rows,
// not over topSet, and the gold PR dot reads them per movement. Loads at or below zero ride along
// unfiltered — which of them Epley is defined for is the domain's rule.
//
// closedItself reads `closed_by`, falling back for rows written without it to autoCloseAt's own
// signature: finished_at exactly at the last set's instant, or at started_at for a session holding
// none. Both implementations read it the same way.
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

// One page of the log plus `standing`: the marks that stood before the OLDEST row on it, which is
// what makes a record judgeable from a page alone. Bounded by the page's own movements and by
// distinct loads, ordered by movement and heaviest load first, so both implementations hand back the
// same vector. An empty page has empty `standing`.
struct LogPage {
  std::vector<SessionSummary> sessions;   // newest first
  std::vector<PriorMark> standing;

  bool operator==(const LogPage&) const = default;
};

// The most recent FINISHED session holding a non-warmup set of the movement, and its sets of that
// movement in set_number order. Most recent is the session's own (startedAt, id) — the log read's
// sort key. `sets` is never empty. routineName is the name frozen in the session's plan snapshot
// ("" when ad-hoc), never the routine's name today.
struct LastTime {
  Session session;
  std::string routineName;
  std::vector<Set> sets;

  bool operator==(const LastTime&) const = default;
};

// The picker's meta line for one movement: `LastTime`'s LAST row, the one the prefill dials off, so
// the two reads name the same set. atMs is the SESSION's start, never the set's own completed_at,
// which is the device's wall clock. The vector is SPARSE — one row per movement this account has
// worked, and absence is `never logged`.
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

// Every refusal an insertSet can make, each crossing the port as a value rather than an exception.
// idTaken: the id is spent on a row this session does not hold, never whose. unknownExercise: no
// movement this account's catalog holds. finished: the session was already closed when the write
// took its lock. deleted: the id belongs to a set the lifter deleted — kept apart from idTaken
// because minting a fresh id and resending, the repair for idTaken, would undo that deletion.
enum class SetInsertError { none, idTaken, unknownExercise, finished, deleted };

struct SetInsertOutcome {
  std::optional<Set> set;
  SetInsertError error;
};

// One line of the export: text end to end, instants ISO-8601 UTC, numerics at their column's own
// scale (72.5 kg is "72.50"), an absent rpe an empty cell rather than a zero. Flat, with the
// session and the movement's name repeated beside every set.
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

// The coach share, a row of its own table rather than a column on the session, so no owner-scoped
// read is widened by it. The token is minted server-side, never accepted from a client, and the
// session id is resolved against the caller's own log before a share is built from it.
struct SessionShare {
  SessionId session;
  UserId user;
  std::string token;
  std::uint64_t expiresAtMs;

  bool operator==(const SessionShare&) const = default;
};

// The whole of what a coach sees: no account, no ids of any kind, no frozen plan. The movement
// travels as its display name — a coach holds no catalog to resolve a slug against.
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

// The log's door to gym storage: sessions, their sets, what corrections left behind, and the coach
// share, which goes with the session when the session goes. Every read and write is owner-scoped by
// the UserId it carries; absent is byte-identical to forbidden. Writes are idempotent by
// client-minted id: insertSession and insertSet no-op on conflict and answer with the row that is
// stored, and one open session per user is a partial unique index, never a guard flag. The two
// writes that CHANGE a stored set are idempotent by shape instead — a correction assigns absolute
// values, and a delete of an already-gone set is a delete.
//
// A set id is spent once and for good: insertSet refuses an id gym_set_revisions holds as deleted,
// with `deleted` rather than `idTaken`, or a replayed append would re-create a deleted set.
struct LogRepository {
  virtual ~LogRepository() = default;

  virtual std::optional<Session> open(const UserId& user) = 0;
  virtual std::optional<Session> session(const UserId& user, const SessionId& id) = 0;
  virtual std::optional<Set> setOf(const UserId& user, const SetId& id) = 0;
  virtual std::optional<std::uint64_t> lastActivity(const SessionId& id) = 0;
  virtual void insertSession(const Session& incoming) = 0;                // conflict = no-op
  // Lands on an open session and records who closed. A lifter's finish is final — a replay or a
  // race keeps whichever landed first. A stale close is revisable: by a late set (lateSetLands), and
  // by the lifter's own finish, which upgrades closed_by to finish and moves finished_at as
  // finishAfterStaleClose says.
  virtual void close(const SessionId& id, std::uint64_t finishedAtMs, ClosedBy closedBy) = 0;
  // Assigns the set number and returns the stored row; every refusal is decided here and nowhere
  // above. A replay is resolved earlier, by `TrainingService::append` through `setOf`, so this
  // answers `finished` for every write arriving after the locked row closed — except the one
  // lateSetLands admits, a set continuing a STALE-closed workout, which lands and moves that
  // workout's finish forward to it in the same transaction. An id held as deleted is refused before
  // either.
  virtual SetInsertOutcome insertSet(const Set& incoming) = 0;

  // The two writes that change a stored set: what they replace is appended to gym_set_revisions, so
  // gym_sets keeps one row per set that currently stands and every read above recomputes off it.
  //
  // `updateSet` takes the WHOLE corrected row, never a patch to merge, and answers with the stored
  // row so a retry reads back the same values. Absent is the one answer for no such set, another
  // account's, and one this session does not hold alike.
  //
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

  // The finish read: everything the review rules need that this session does not hold, in one pass —
  // the marks of the movements it works, and the earlier session it stands against with its sets.
  virtual SessionHistory historyFor(const UserId& user, const Session& session) = 0;
  // The sets go with the row (`on delete cascade`).
  virtual bool deleteSession(const UserId& user, const SessionId& id) = 0;  // false = nothing to remove

  // One movement's whole page in one pass. Nothing here computes an e1RM, picks a record or windows
  // a chart; the store hands over orderings and the pure rule does the rest.
  virtual MovementHistory movementHistory(const UserId& user, const ExerciseId& exercise) = 0;

  // The statistics read, in one pass. `tops` come back grouped by movement, oldest first within each
  // group, so the rule assembles a line by appending; no e1RM is computed here.
  virtual TrainingLog trainingLog(const UserId& user) = 0;
  // Every set this account holds, oldest first, including the workout still open.
  virtual std::vector<ExportedSet> exportedSets(const UserId& user) = 0;

  // The mint is idempotent ON THE SESSION: a second call while a share is live hands back the same
  // token; an expired share is replaced rather than returned. Absent, another account's, and
  // already-shared-by-someone-else are one answer.
  virtual std::optional<SessionShare> insertShare(const SessionShare& incoming,
                                                  std::uint64_t nowMs) = 0;
  virtual bool revokeShare(const UserId& user, const SessionId& id) = 0;   // false = nothing to revoke
  // The one read here with no owner behind it: the token IS the credential. Expiry is decided
  // against the instant the caller passes, never the database's clock. Revoked, expired and
  // never-existed all answer the same nothing.
  virtual std::optional<SharedSession> sharedSession(const std::string& token,
                                                     std::uint64_t nowMs) = 0;
};

}
