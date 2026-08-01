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
};

}
