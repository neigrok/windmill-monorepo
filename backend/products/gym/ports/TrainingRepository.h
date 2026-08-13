#pragma once

#include "products/gym/domain/Preferences.h"
#include "products/gym/domain/Proposal.h"
#include "products/gym/domain/Record.h"
#include "products/gym/domain/Review.h"
#include "products/gym/domain/Routine.h"
#include "products/gym/domain/Statistics.h"
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
// loading its sets — how many sets it holds and how many of those were working, the tonnage those
// working sets moved, which movements by display name, the heaviest working set in it, the loads it
// worked, and whether the four-hour rule ended it rather than a tap.
//
// BOTH counts are here because they answer different questions and the log screen asks the second
// one. Until 2026-08-12 the row printed setCount beside topSet, and topSet is a lateral over the
// working sets alone — so the count included the ramp-up while the top set beside it could not, and
// a five-set session with two warmups read "5 sets" over a number three sets earned. setCount keeps
// its meaning — every set, every kind — because it already has readers, and redefining a field
// under its readers is how a number starts lying quietly. The log screen reads workingSetCount.
//
// tonnageKg is `sum(greatest(weight_kg, 0) * reps)` over the working sets, and the clamp is the
// whole of what makes it honest: band-assisted work logs a NEGATIVE load, so a naive sum lets an
// assisted pull-up subtract from a week the lifter trained. An assisted set moved no external load,
// so it contributes nothing; a bodyweight set contributes nothing for the same reason, gym holding
// no bodyweight to add to it. Zero is therefore a real answer meaning "nothing here moved a
// measurable load", never "no work" — which is why every surface draws NOTHING where a zero tonnage
// would go rather than `0.0 t` (domain/Statistics.h states that rule and why it is not the volume
// this product refuses).
//
// workingMarks is the session's working sets collapsed to one row per (movement, load), carrying
// the best reps done at it — PriorMark's projection (domain/Review.h) narrowed to a single session,
// grouped by movement and heaviest first inside each and dated by the SESSION's own start like
// every mark a store hands over, so both implementations of this port hand back the same vector. ONE projection serves the row's two questions, because the coarser one it
// replaced was this one summed again:
//   · the row's e1RM is Epley over EVERY working set, not over topSet — the heaviest set is rarely
//     the best estimate, and a row that ran Epley on topSet alone printed 116.7 under a session
//     whose finish screen said 126.7 — so `topE1rmOf` takes the maximum over these rows and the
//     movement they name simply does not enter that maximum.
//   · the row's gold PR dot is a fact about ONE movement, so the same rows carry the movement and
//     the domain's three record rules read them per movement (§2.4).
// Picking a set by e1RM is not an ordering the store can make — it IS the formula, and the formula
// does not reach the database (§11.5) — so the store hands over the fewest rows the answer can
// honestly be computed from and the domain runs its rules over them. Loads at or below zero ride
// along unfiltered: which of them Epley is defined for is the domain's rule to state, and it states
// it in exactly one place.
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
  int workingSetCount;
  double tonnageKg;
  std::vector<std::string> exerciseNames;
  std::optional<TopWorkingSet> topSet;
  std::vector<PriorMark> workingMarks;   // by movement, heaviest first, best reps at each
  bool closedItself = false;

  bool operator==(const SessionSummary&) const = default;
};

// One page of the log, and everything the rules that read a page need in ONE round trip: the rows
// themselves and the marks that stood before the OLDEST of them. `standing` is what makes the gold
// dot answerable at all — a record is judged against the history before its session, and a page has
// history before it that is not on the page. It is bounded by the page's own movements and by
// distinct loads rather than by set count, so a lifter with ten years of squats hands over a few
// dozen rows and not a few thousand, and it reads in the order a session's own marks do — by
// movement, heaviest load first — so both implementations of this port hand back the same vector.
// An empty page has no oldest session, so nothing stands before it and `standing` is empty too.
struct LogPage {
  std::vector<SessionSummary> sessions;   // newest first
  std::vector<PriorMark> standing;

  bool operator==(const LogPage&) const = default;
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

// The picker's meta line for ONE movement: the last set of it this lifter performed, and when. It
// is `LastTime` projected to the one line a list can print — the LAST row of that block, which is
// the row the prefill dials its weight off — so the two reads answer with the same set or the
// product says two different things about "last time" one tap apart.
//
// atMs is the SESSION's start and never the set's own instant, the rule every mark a store hands
// over already obeys: completed_at is the device's wall clock (§2.2), and dating a line by it put
// the same set on two calendar days on two different screens. "3 days ago" is the day you trained
// it.
//
// The vector is SPARSE — one row per movement this account has actually worked, nothing for the
// rest — and that absence is the whole of `never logged`. It is what makes this read proportional
// to a lifter's history instead of to a 64-row catalog, which is why the annotation is not a column
// on the catalog row (§5).
struct LastSet {
  ExerciseId exercise;
  double weightKg;
  int reps;
  std::uint64_t atMs;

  bool operator==(const LastSet&) const = default;
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

// What became of an insertSet: the stored row, or the one fact that stopped it. Every refusal here
// is the store's to state and each crosses the port as a VALUE — a vendor exception escaping to the
// HTTP edge would make the wire layer know which database gym is kept in. idTaken says the id is
// spent on a row this session does not hold, never whose, so absent stays byte-identical to
// forbidden; unknownExercise says the set names a movement this account's catalog does not hold —
// a slug nobody has, and another lifter's private movement alike; finished says the session was
// already closed when the write took its lock, which is the boundary §3.3 makes the STORE hold,
// because it is the only layer that reads that column under the lock that decides it.
//
// `deleted` is the refusal the delete route made necessary, and it is NOT idTaken however alike the
// two look. An id spent ELSEWHERE is repaired by minting a fresh one and sending the set again —
// that is precisely what every queue does with it — and a set the LIFTER deleted must never be
// repaired that way, or the deletion undoes itself under a new id the first time a POST whose reply
// was lost is replayed. Same shape, opposite move, so it crosses the port as its own fact.
enum class SetInsertError { none, idTaken, unknownExercise, finished, deleted };

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
// same fact a set's write states under the same predicate: an entry names a movement this account's
// catalog does not hold.
enum class RoutineWriteError { none, idTaken, notFound, unknownExercise };

struct RoutineWriteOutcome {
  std::optional<Routine> routine;
  RoutineWriteError error;
};

// What a surface is asking the proposal ledger for. Today's card reads the pending ones across
// every routine; the dot on the routines list reads one routine's pending, because an applied or
// dismissed proposal is part of the program's history rather than a toast that disappeared — and
// that history is now read through `routineHistory` below rather than through this query.
struct ProposalQuery {
  std::optional<RoutineId> routine;
  bool pendingOnly = false;

  bool operator==(const ProposalQuery&) const = default;
};

// One dated row of a routine's own history (§M30's `9 Aug · created by you · 4 movements`), and
// BOTH kinds of thing that happen to a day of the program ride in it: the day being created, and
// every proposal an agent has ever minted against it. One shape and one read, because a screen
// handed two lists would have to merge them by date itself — three surfaces, three merges, and
// three chances to date the same event differently.
//
// Each kind carries its own descriptor and nothing carries two meanings. `proposal` is present
// exactly when kind is `proposal`, and the actor of one is inside it (`source.door`). `door` and
// `movements` belong to the CREATED row alone: an absent door is the lifter's own hand — the case
// §M is about — and `movements` is how many lines the day was created with, which is a fact only
// the write that created it could record, so it is absent on rows written before this wave rather
// than backfilled from a document that has been edited since.
enum class RoutineEventKind { created, proposal };

struct RoutineEvent {
  RoutineEventKind kind;
  std::uint64_t atMs;
  std::optional<ProposalDoor> door;       // created only; absent = the lifter's own hand
  std::optional<int> movements;           // created only; absent = never recorded
  std::optional<ProposalHead> proposal;   // present exactly when kind == proposal

  bool operator==(const RoutineEvent&) const = default;
};

// How far back a routine's history reads. The creation row is always the last one and never counts
// against this — it is the anchor of the list, and it is one row of the routine's own record — so
// this bounds the proposals above it. A ledger nobody scrolls to the end of does not need a
// lifetime of rows in it, the same bound `kRecentDays` makes on the record page.
constexpr int kRoutineHistoryProposals = 20;

// What became of a mint, under the same rule every other write in this port obeys: each refusal is
// the store's own fact and crosses as a VALUE.
//
// THE SPENT ID SPLITS THREE WAYS, and conflating any two of them is how a mint lies. `idTaken` is
// the id spent on a proposal this account cannot see. The caller's OWN id, carrying the SAME
// document, is not a refusal at all — it is the replay, and the stored proposal comes back
// untouched, so an agent that lost a reply resends the same id instead of minting a second proposal
// that would supersede its own first. The caller's own id carrying a DIFFERENT document is
// `idReused`: two ideas cannot share one id, and answering the second with the first is a receipt
// that says "your proposal is waiting" about somebody else's proposal.
//
// `unknownRoutine` is absent and another account's alike. `unknownExercise` is refused HERE rather
// than at apply, which is the whole point of refusing it at all: a proposal a lifter cannot apply
// must never reach their screen. `noChange` is the one refusal the STORE never sees, because it is
// decided before a row is built: a document identical to what the routine already says is a card
// that would read `Apply all 0`, and putting one in a lifter's product is not nothing — it is a
// notification about nothing, in an app that has no notifications on purpose.
enum class ProposalMintError { none, idTaken, idReused, unknownRoutine, unknownExercise, noChange };

struct ProposalMintOutcome {
  std::optional<RoutineProposal> proposal;
  ProposalMintError error;
};

// What became of an apply or a dismiss. `superseded` is the base having moved since the mint — the
// lifter's own hand, or a newer proposal — and it is the one refusal that is not the caller's
// fault and not repairable: the diff describes a document that is gone, so it is settled as
// superseded and the lifter reads the routine as it now stands. `settled` is a proposal already
// applied or already dismissed being asked for the OTHER one; asking for the state it already
// holds is a replay and answers with the stored row.
enum class ProposalSettleError { none, notFound, superseded, settled };

struct ProposalSettleOutcome {
  std::optional<RoutineProposal> proposal;
  std::optional<Routine> routine;   // how the routine now stands; absent on a dismiss and a removal
  ProposalSettleError error;
};

// The catalog write's one refusal. The read-back is scoped to the caller's own created_by rows, so
// a seed's slug and another lifter's custom id are both simply taken — the caller mints a new id
// and sends it again, and learns nothing about who holds the old one.
enum class ExerciseInsertError { none, idTaken };

struct ExerciseInsertOutcome {
  std::optional<Exercise> exercise;
  ExerciseInsertError error;
};

// One line of the export, and it is TEXT end to end because a CSV is text and every rendering
// decision in one is a decision Postgres already makes better than C++ would. The instants come
// back ISO-8601 UTC — a spreadsheet cannot read an epoch, and the calendar conversion belongs where
// gym does all of its date work rather than in a second place that could disagree with it. The
// numerics come back at their column's own scale, so 72.5 kg is "72.50" forever, and an absent rpe
// is an empty cell rather than a zero that would read as a real one. The row is flat because a CSV
// row is flat: the two facts a set does not carry — which session it belongs to and what its
// movement is called — ride beside it instead of being joined back by whoever opens the file.
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

// The coach share, as a row of its own table. It is NOT a column on the session, and that is the
// whole design: every one of gym's owner-scoped reads is untouched by it, so absent stays
// byte-identical to forbidden on all of them and a share can only ever be reached through the one
// door that was built for it. Both fields the server decides are decided by the server — the token
// is minted here, never accepted from a client, because a client that picks its own share token
// picks a guessable one — and the session id has already been resolved against the caller's own log
// before a share is ever built from it.
struct SessionShare {
  SessionId session;
  UserId user;
  std::string token;
  std::uint64_t expiresAtMs;

  bool operator==(const SessionShare&) const = default;
};

// What the coach sees, and the whole of it. There is no account in this value: no email, no name,
// no other session, and no id at all — not the session's, not a set's, not the routine's — because
// the only thing an id could do for a reader who is not the owner is be tried somewhere else. The
// movement travels as its display NAME for the same reason it has to: a coach holds no catalog to
// resolve a slug against. The frozen plan does not travel — a share is one workout the lifter DID,
// and a program is a longer-lived thing than one session's link.
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

// The one door to gym storage — the catalog, the plan and the log live or die together, so gym
// keeps a single bounded store (the split into Catalog/Routine repositories waits for a second
// consumer). Every read and write is owner-scoped by the UserId it carries; absent is byte-
// identical to forbidden. Writes are idempotent by client-minted id: insertSession, insertSet,
// insertRoutine and insertExercise all no-op on conflict and answer with the row that is stored,
// and one open session per user is the partial unique index's rule, never a guard flag. The two
// writes that CHANGE a stored set are idempotent by shape instead — a correction assigns absolute
// values, and a delete of a set that is already gone is a delete.
//
// A SET ID IS SPENT ONCE AND FOR GOOD, and that is what lets those two live beside the replay. The
// primary key stopped being the whole of the idempotency the moment a row could LEAVE gym_sets: a
// replayed append would find the id free and re-create the set a lifter deleted, which is the one
// thing a delete has to survive. So insertSet refuses an id gym_set_revisions holds as deleted, and
// it refuses it with `deleted` rather than `idTaken` for the reason that enum states.
struct TrainingRepository {
  virtual ~TrainingRepository() = default;

  virtual std::vector<Exercise> catalog(const UserId& user) = 0;          // seeds + own customs
  virtual std::optional<Session> open(const UserId& user) = 0;
  virtual std::optional<Session> session(const UserId& user, const SessionId& id) = 0;
  virtual std::optional<Set> setOf(const UserId& user, const SetId& id) = 0;
  virtual std::optional<std::uint64_t> lastActivity(const SessionId& id) = 0;
  virtual void insertSession(const Session& incoming) = 0;                // conflict = no-op
  virtual void close(const SessionId& id, std::uint64_t finishedAtMs) = 0;
  // Assigns the number and returns the stored row; anything that stops the write comes back as a
  // typed fact beside it, and EVERY refusal below this line is decided here and nowhere above it —
  // one fact decided in two layers gets decided in two orders. A REPLAY IS NOT RESOLVED HERE —
  // `LogService::append` answers it through `setOf` before this is ever reached, which is what lets
  // this method answer `finished` for every write that arrives after the locked row closed, replay
  // or not. Stating it the other way round would be a contract a second implementation could keep
  // and still lose a set. And an id this account holds as DELETED is refused before either: it is
  // the one refusal the primary key cannot make, because the row it would have collided with is
  // gone.
  virtual SetInsertOutcome insertSet(const Set& incoming) = 0;

  // The two writes that change a set already stored, and the only pair here that leaves something
  // behind: what they replace is appended to gym_set_revisions, so a correction rewrites the row the
  // log reads AND keeps what it replaced. `gym_sets` therefore keeps its meaning exactly — one row
  // per set that currently stands — and every read above it is untouched and correct by
  // construction: the tonnage, the marks, the records, the chart, the prefill and the export all
  // recompute off the live rows. The alternative, a superseding row with a tombstone, would make
  // every one of those reads project the chain forever to buy a property nothing needs, and a
  // forgotten projection shows a lifter a set twice.
  //
  // `updateSet` takes the WHOLE corrected row — the domain built it from the stored one — rather
  // than a patch the store would merge, because merging in SQL is the correction rule stated a
  // second time in a language the domain cannot read. It answers with the stored row, so a retry is
  // a no-op that reads back the same values. Absent is the one fact: no such set, another account's,
  // and one this session does not hold, told apart by nobody.
  //
  // `deleteSet` answers NOTHING, and that is the contract rather than an omission — a set that was
  // never there does not stand either, so a client whose reply was lost sends the same delete again
  // and gets the same silence. Neither write is refused for a finished session: a lifter reads the
  // log after the workout, and that is exactly when they see the 5 they meant to log as a 4.
  virtual std::optional<Set> updateSet(const UserId& user, const Set& corrected) = 0;
  virtual void deleteSet(const UserId& user, const SessionId& session, const SetId& id) = 0;

  virtual LogPage log(const UserId& user, const LogCursor& cursor) = 0;
  virtual std::vector<Set> setsOf(const SessionId& id) = 0;
  // The prefill read: what this account did the last time it trained this movement. Fired on every
  // movement change, and the one read in this port with no write behind it anywhere.
  virtual LastTimeOutcome lastTime(const UserId& user, const ExerciseId& exercise) = 0;
  // The picker's read: the same rule as above, run over every movement this account has trained,
  // in one pass. A picker asking `lastTime` per row would be sixty-four round trips to draw a list,
  // one per seeded catalog row — the N+1 the log read already refused when it made the summary carry
  // its own derived facts.
  // Ordered by movement id, because the caller joins these onto a catalog it already holds and an
  // id is the key it joins on; the ordering the LIST is drawn in is the catalog's.
  virtual std::vector<LastSet> lastSets(const UserId& user) = 0;

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
  // the same word as its row in that list — and it is also the whole of `untested` (§M30): a
  // routine that has never been trained has no newest session to name, so the absence IS the badge
  // and no flag is stored that a discarded workout could leave standing.
  virtual std::vector<Routine> routines(const UserId& user) = 0;   // most recently trained first
  virtual std::optional<Routine> routine(const UserId& user, const RoutineId& id) = 0;
  // The routine's dated history, newest first, with its creation row last. It is one read over two
  // tables rather than a list per kind, for the reason RoutineEvent gives.
  virtual std::vector<RoutineEvent> routineHistory(const UserId& user, const RoutineId& id) = 0;
  // The routine row and its entries land in ONE transaction — the two writes are one document, and
  // a routine with no entries is a plan the domain refuses to build and the editor cannot draw.
  //
  // `byAgent` is who made the day, and it is an argument rather than a field on the entity because
  // it is a fact about the WRITE and not about the document: a later replace carries the same
  // document from a different hand and must not rewrite who created it. Absent is the lifter's own
  // — the app's create, which is every create §M is about — and present is the door an agent's
  // `create_routine` came through. `nowMs` dates the creation row from the one clock the service
  // holds rather than from the database's, exactly as the proposal ledger's mint does, so a test
  // can drive it.
  virtual RoutineWriteOutcome insertRoutine(const Routine& incoming,
                                            std::optional<ProposalDoor> byAgent,
                                            std::uint64_t nowMs) = 0;   // conflict = the stored
  // The whole-document replace, and THE HUMAN'S HAND: this is what `PUT /v1/gym/routines/{id}`
  // reaches, and no MCP tool reaches it at any grant level. It moves the revision and, in the SAME
  // transaction, supersedes every proposal still pending on that routine — which is what stops the
  // mid-session "Save 87.5 to Push A" from silently destroying a proposal's base. `nowMs` is the
  // instant those supersessions are dated by, read from the one clock the service holds rather than
  // from the database's, so a test can drive it.
  virtual RoutineWriteOutcome replaceRoutine(const Routine& incoming, std::uint64_t nowMs) = 0;
  virtual bool deleteRoutine(const UserId& user, const RoutineId& id) = 0;  // false = nothing to remove
  // The owner rides beside the row rather than inside it: a catalog entry has no owner when it is a
  // seed, and `custom` is what the read derives from created_by.
  virtual ExerciseInsertOutcome insertExercise(const UserId& owner, const Exercise& incoming) = 0;
  // The one write in this port that changes something already stored, and the one that must not
  // leak across accounts: the 64 seeds are GLOBAL rows, so a movement this account created renames
  // on its own row while a seed takes a per-account display name instead — and renaming a seed back
  // to what it is called by default clears that name rather than storing a copy of it. Nothing
  // about identity moves either way: every set, routine entry and frozen plan snapshot still points
  // at the same id, which is the promise §4 exists to keep. Absent, and another account's private
  // movement, are the one answer every read here gives.
  //
  // IT ALSO KEEPS THE OLD NAME (§N32's *old name searchable as an alias*): the name this account
  // was calling the movement a moment ago joins its aliases, so the word in a lifter's muscle
  // memory still finds it in the picker. Per account like the display name itself, and it comes
  // back on `Exercise::aliases` beside that name rather than on a read of its own — an alias IS a
  // name, and a picker that had to fetch names from two places would search one of them a frame
  // late. Renaming BACK to a name this account already used takes that name off the alias list in
  // the same write, because a name cannot be both what a movement is called and what it used to be.
  virtual std::optional<Exercise> renameExercise(const UserId& user, const ExerciseId& id,
                                                 const std::string& name) = 0;

  // The record read: one movement's whole page in one pass, answered in the DOMAIN value the rule
  // defines — historyFor's contract applied to one movement instead of one session. Nothing here
  // computes an e1RM, picks a record or windows a chart; the store hands over orderings and the
  // pure rule does the rest.
  virtual MovementHistory movementHistory(const UserId& user, const ExerciseId& exercise) = 0;

  // The statistics read: everything the pure rule needs, in one pass, answered in the DOMAIN value
  // the rule defines — historyFor's contract applied to a longer window. `tops` come back grouped
  // by movement, oldest first within each group, which is what lets the rule assemble a line by
  // appending; nothing here computes an e1RM, because that formula has one copy per language and
  // none in the database.
  virtual TrainingLog trainingLog(const UserId& user) = 0;
  // Every set this account holds, oldest first, including the workout it is in the middle of — an
  // export that quietly omitted today would be the one row a lifter goes looking for.
  virtual std::vector<ExportedSet> exportedSets(const UserId& user) = 0;

  // The settings row (§I), and the one value in this port a lifter is allowed to have none of: a
  // lifter who has never opened that screen has no row, which is a fact rather than a fault. The
  // DEFAULTS are the domain's answer to it (domain/Preferences.h) and LogService is where they are
  // given, so the store says "nothing stored" and never invents a document nobody wrote.
  // `savePreferences` is a whole-document upsert keyed on the account — idempotent by SHAPE like the
  // two set writes rather than by a client-minted id, because there is one row per lifter and
  // nothing here for a client to name — and it answers with the row as the store now holds it.
  //
  // NOTHING ELSE IN THIS PORT READS IT, and that is §I's first row made structural: units are a
  // display transform at the very edge, so no read above is scoped by them, no write converts
  // anything, and kilograms stay the only load this store has ever held.
  virtual std::optional<GymPreferences> preferences(const UserId& user) = 0;
  virtual GymPreferences savePreferences(const GymPreferences& incoming) = 0;

  // The coach share, three doors. The mint is idempotent ON THE SESSION rather than on a
  // client-minted id, because there is no id for a client to mint here: a second call while a share
  // is live hands back the SAME token, so a lifter who taps Share twice sends one link and not two
  // capabilities they would have to revoke separately. An EXPIRED share is replaced rather than
  // returned — re-sharing a workout a month later is a new capability, not the resurrection of one
  // that ended. Absent, another account's, and already-shared-by-someone-else are one answer.
  virtual std::optional<SessionShare> insertShare(const SessionShare& incoming,
                                                  std::uint64_t nowMs) = 0;
  virtual bool revokeShare(const UserId& user, const SessionId& id) = 0;   // false = nothing to revoke
  // The one read in this port that takes no UserId, because the token IS the credential. Expiry is
  // decided against the instant the caller passes and not against the database's own clock, so one
  // clock decides and a test can drive it. Revoked, expired and never-existed all answer nothing at
  // all — the same value, so nothing above this line can tell them apart and neither can a prober.
  virtual std::optional<SharedSession> sharedSession(const std::string& token,
                                                     std::uint64_t nowMs) = 0;

  // THE PROPOSAL LEDGER. An agent reaches exactly one of these — the mint — and the other three are
  // the lifter's, because Apply is not a capability, it is a human act.
  //
  // The two reads split by what a screen needs: `proposalHeads` is what a CARD draws (Today's
  // pending card, the dot on the routines list, a row of the routine editor's History), and it
  // carries no diff rows at all, because a list that shipped every diff of every proposal would be
  // the token budget spent on a screen that prints a count. `proposal` is the diff screen's whole
  // read, and it is the one that fills `loggedSets` on a removed line — that count is what makes a
  // removal safe to read, and frozen at mint it would be wrong by the time anybody read it.
  virtual std::vector<ProposalHead> proposalHeads(const UserId& user, const ProposalQuery& query) = 0;
  virtual std::optional<RoutineProposal> proposal(const UserId& user, const ProposalId& id) = 0;
  // The mint, in ONE transaction: the proposal row, its lines, and the supersession of whatever was
  // pending from the same door. Idempotent by the client-minted id like every other write here — a
  // replay reads back the stored proposal rather than minting a second one that would supersede the
  // first. The routine is resolved under the caller's own scope inside that transaction, and its
  // revision is what the proposal is frozen against.
  virtual ProposalMintOutcome insertProposal(const RoutineProposal& incoming) = 0;
  // The apply, atomic and all-or-none, and the only place a proposal becomes a write. `becomes` is
  // what the DOMAIN computed from the base (domain/Proposal.h) — the store re-checks the revision
  // under its own lock and refuses the whole thing if the routine moved between the two, which is
  // the optimistic half of the same token the mint froze.
  virtual ProposalSettleOutcome applyRevision(const UserId& user, const ProposalId& id,
                                              const Routine& becomes, std::uint64_t nowMs) = 0;
  // The other intent, and its own verb rather than a null `becomes` on the one above: a removal
  // deletes the routine, so its entries, its sessions' pointers and this very proposal's own row go
  // with it (`on delete cascade`). The answer is composed before the delete, because after it there
  // is nothing left to read back.
  virtual ProposalSettleOutcome applyRemoval(const UserId& user, const ProposalId& id,
                                             std::uint64_t nowMs) = 0;
  // No reason is asked for and nothing changes — the proposal stays in the routine's history in
  // case the lifter wants it back.
  virtual ProposalSettleOutcome dismissProposal(const UserId& user, const ProposalId& id,
                                                std::uint64_t nowMs) = 0;
};

}
