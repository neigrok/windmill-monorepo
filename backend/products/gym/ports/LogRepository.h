#pragma once

#include "products/gym/domain/History.h"
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
// closedItself reads `closed_by`; where it is null, a session closed itself when finished_at sits
// exactly at the last set's instant, or at started_at for a session holding none.
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
// is the historical display override or frozen plan name ("" when ad-hoc), never the routine's name today.
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

struct SessionRows {
  Session session;
  std::vector<Set> sets;
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

// The log as the engine stores it, read: sessions, their sets, what corrections and deletions left
// behind, and the two shares, which are this port's only writes. Every read and write is owner-scoped
// by the UserId it carries; absent is byte-identical to forbidden.
struct LogRepository {
  virtual ~LogRepository() = default;

  virtual std::optional<Session> open(const UserId& user) = 0;
  virtual std::optional<Session> session(const UserId& user, const SessionId& id) = 0;
  virtual std::optional<Set> setOf(const UserId& user, const SetId& id) = 0;
  virtual std::vector<SessionRows> sessions(const UserId& user, const std::vector<SessionId>& ids) = 0;
  virtual HistoryPage history(const UserId& user, const HistoryQuery& query) = 0;
  virtual std::optional<LogShare> createLogShare(const LogShare& share) = 0;
  virtual std::vector<LogShare> logShares(const UserId& user, std::uint64_t nowMs) = 0;
  virtual void revokeLogShare(const UserId& user, const std::string& id) = 0;
  virtual std::optional<SharedHistory> sharedHistory(const std::string& token,
      const HistoryQuery& query, std::uint64_t nowMs) = 0;

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

  // One movement's whole page in one pass; the store hands over orderings only, no e1RM.
  virtual MovementHistory movementHistory(const UserId& user, const ExerciseId& exercise) = 0;

  // `tops` come back grouped by movement, oldest first within each group; no e1RM is computed here.
  virtual TrainingLog trainingLog(const UserId& user) = 0;

  virtual std::vector<ProgressSet> progressHistory(const UserId& user) = 0;

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
