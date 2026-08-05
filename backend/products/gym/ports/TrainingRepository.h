#pragma once

#include "products/gym/domain/Review.h"
#include "products/gym/domain/Routine.h"
#include "products/gym/domain/Training.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// The heaviest WORKING set of a whole session, ties broken by more reps — never by volume, the same
// rule the review's per-movement top set obeys. It is two numbers where TopSet is three: "how many
// sets at that load" is a question about one movement, and this one spans every movement in the
// session. Warmups, drops and failures are not what a session was, so none of them can be its top.
struct TopWorkingSet {
  double weightKg;
  int reps;

  bool operator==(const TopWorkingSet&) const = default;
};

// One row of the training log read: the session plus what the list needs to say about it without
// loading its sets — how many sets, which movements by display name, the heaviest working set in
// it, and whether the four-hour rule ended it rather than a tap.
//
// closedItself is INFERRED and carries no column, because the rule that closes a session already
// signs its work: autoCloseAt (§3.2) stamps finished_at at the last set's instant exactly, or at
// started_at for a session holding none, while a lifter's own finish carries the instant their
// device named. So `finished_at = max(completed_at)`, or `= started_at` with no sets, IS that
// rule's signature. A manual finish landing on exactly the same millisecond as the last set reads
// as an auto-close, and the whole cost of that coincidence is one wrong subtitle on one log row —
// cheaper than a column two writers would have to keep honest forever. Both implementations of this
// port compute it the same way, and PgTrainingRepository::log is where the SQL says so.
struct SessionSummary {
  Session session;
  int setCount;
  std::vector<std::string> exerciseNames;
  std::optional<TopWorkingSet> topSet;
  bool closedItself = false;

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

// What became of a routine write, under the same rule as insertSet: every refusal the store alone
// can know crosses as a VALUE, never as a vendor exception the wire layer would have to name. One
// outcome serves both writes because a routine write has one shape — the whole document — and each
// of the two producers can raise only what it can see: insertRoutine answers idTaken (the id is
// spent on a row this account does not own, never whose) and replaceRoutine answers notFound
// (absent and another account's are the same fact). unknownExercise is either one's, and it is the
// same fact a set's foreign key states: an entry names a movement no catalog holds.
enum class RoutineWriteError { none, idTaken, notFound, unknownExercise };

struct RoutineWriteOutcome {
  std::optional<Routine> routine;
  RoutineWriteError error;
};

// The catalog write's one refusal. The read-back is scoped to the caller's own created_by rows, so
// a seed's slug and another lifter's custom id are both simply taken — the caller mints a new id
// and sends it again, and learns nothing about who holds the old one.
enum class ExerciseInsertError { none, idTaken };

struct ExerciseInsertOutcome {
  std::optional<Exercise> exercise;
  ExerciseInsertError error;
};

// The one door to gym storage — the catalog, the plan and the log live or die together, so gym
// keeps a single bounded store (the split into Catalog/Routine repositories waits for a second
// consumer). Every read and write is owner-scoped by the UserId it carries; absent is byte-
// identical to forbidden. Writes are idempotent by client-minted id: insertSession, insertSet,
// insertRoutine and insertExercise all no-op on conflict and answer with the row that is stored,
// and one open session per user is the partial unique index's rule, never a guard flag.
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

  // The finish read: everything the review rules need that this session does not already hold, in
  // one pass. It answers in a DOMAIN value (SessionHistory) rather than a shape of its own, because
  // the rule is what defines the shape and the store's job is to fill it: the marks of the movements
  // this session works, and the earlier session it stands against with that session's sets.
  virtual SessionHistory historyFor(const UserId& user, const Session& session) = 0;
  // The one destructive action in the product. The sets go with the row (`on delete cascade`), so
  // a discard leaves nothing behind pointing at a session that is gone.
  virtual bool deleteSession(const UserId& user, const SessionId& id) = 0;  // false = nothing to remove

  // The plan. Both reads carry lastTrainedAtMs, which is an aggregate over the log rather than a
  // column, so the list can sort by the thing the routines screen sorts by and one routine can say
  // the same word as its row in that list.
  virtual std::vector<Routine> routines(const UserId& user) = 0;   // most recently trained first
  virtual std::optional<Routine> routine(const UserId& user, const RoutineId& id) = 0;
  // The routine row and its entries land in ONE transaction — the two writes are one document, and
  // a routine with no entries is a plan the domain refuses to build and the editor cannot draw.
  virtual RoutineWriteOutcome insertRoutine(const Routine& incoming) = 0;   // conflict = the stored
  virtual RoutineWriteOutcome replaceRoutine(const Routine& incoming) = 0;  // whole-document replace
  virtual bool deleteRoutine(const UserId& user, const RoutineId& id) = 0;  // false = nothing to remove
  // The owner rides beside the row rather than inside it: a catalog entry has no owner when it is a
  // seed, and `custom` is what the read derives from created_by.
  virtual ExerciseInsertOutcome insertExercise(const UserId& owner, const Exercise& incoming) = 0;
};

}
