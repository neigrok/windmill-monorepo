#pragma once

#include "products/gym/domain/Training.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// One row of the training log read: the session plus what the list needs to say about it without
// loading its sets — how many, and which movements by display name.
struct SessionSummary {
  Session session;
  int setCount;
  std::vector<std::string> exerciseNames;

  bool operator==(const SessionSummary&) const = default;
};

// What "last time" is, once resolved: the most recent FINISHED session holding a non-warmup set of
// the movement, the name that session was trained under, and its sets of that movement in
// set_number order. Most recent is the session's own (startedAt, id) — the log read's sort key, so
// the two reads can never disagree about which session is newest, whatever instants the device
// stamped on the sets inside it. The block is never empty — the session is chosen BY holding one of
// those sets.
// routineName is the name frozen in the session's plan snapshot ("" when the session was ad-hoc),
// never the routine's name today: the prefill card says which day of the program you did it on, and
// a routine renamed since must not rewrite what the log says about the past.
struct LastTime {
  Session session;
  std::string routineName;
  std::vector<Set> sets;

  bool operator==(const LastTime&) const = default;
};

// A first-ever movement has no last time, and that is a fact, not a fault — it comes back as an
// empty outcome with no error. unknownExercise is the other thing an empty answer could mean and
// the store is the only layer that can tell them apart, so it says which in a value, exactly as
// insertSet does: "you have never trained this" and "no catalog holds this" are different sentences
// and different moves for the client.
enum class LastTimeError { none, unknownExercise };

struct LastTimeOutcome {
  std::optional<LastTime> lastTime;
  LastTimeError error;
};

// Where a page of the log resumes and how wide it is. The sort key is (startedAt, id), descending
// and UNIQUE end to end — a plain started_at cursor drops a session whose start instant ties with
// another's across a page edge, and it is then in no page, ever. beforeId is the second half of
// that cursor: absent on the first page, the previous page's last id after that.
struct LogCursor {
  std::uint64_t beforeMs;
  std::optional<SessionId> beforeId;
  int limit;
};

// What became of an insertSet: the stored row, or the one fact that stopped it. Both refusals are
// the store's to state and both cross the port as VALUES — a vendor exception escaping to the HTTP
// edge would make the wire layer know which database gym is kept in. idTaken says the id is spent
// on a row this session does not hold, never whose, so absent stays byte-identical to forbidden;
// unknownExercise says the set names a movement no catalog holds.
enum class SetInsertError { none, idTaken, unknownExercise };

struct SetInsertOutcome {
  std::optional<Set> set;
  SetInsertError error;
};

// The one door to gym storage — the catalog and the log live or die together, so phase 0–1 keeps a
// single bounded store (the split into Catalog/Routine repositories waits for a second consumer).
// Every read and write is owner-scoped by the UserId it carries; absent is byte-identical to
// forbidden. Writes are idempotent by client-minted id: insertSession and insertSet no-op on
// conflict, and one open session per user is the partial unique index's rule, never a guard flag.
struct TrainingRepository {
  virtual ~TrainingRepository() = default;

  virtual std::vector<Exercise> catalog(const UserId& user) = 0;          // seeds + own customs
  virtual std::optional<Session> open(const UserId& user) = 0;
  virtual std::optional<Session> session(const UserId& user, const SessionId& id) = 0;
  virtual std::optional<Set> setOf(const UserId& user, const SetId& id) = 0;
  virtual std::optional<std::uint64_t> lastActivity(const SessionId& id) = 0;
  virtual void insertSession(const Session& incoming) = 0;                // conflict = no-op
  virtual void close(const SessionId& id, std::uint64_t finishedAtMs) = 0;
  // Assigns the number and returns the stored row — a replay into the same session is handed the
  // original; anything that stops the write comes back as a typed fact beside it.
  virtual SetInsertOutcome insertSet(const Set& incoming) = 0;
  virtual std::vector<SessionSummary> log(const UserId& user, const LogCursor& cursor) = 0;
  virtual std::vector<Set> setsOf(const SessionId& id) = 0;
  // The prefill read: what this account did the last time it trained this movement. Fired on every
  // movement change, and the one read in this port with no write behind it anywhere.
  virtual LastTimeOutcome lastTime(const UserId& user, const ExerciseId& exercise) = 0;
};

}
