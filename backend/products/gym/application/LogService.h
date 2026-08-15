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

// What an agent proposes: the routine it is about, the document it would take on, the name it would
// carry, and the one sentence a card prints before a lifter opens the diff. The proposal's own id is
// the caller's to mint, exactly as a session's and a set's are, so a lost reply is replayed rather
// than turned into a second proposal that would supersede the first.
//
// There is no `position` here, and its absence is a decision rather than an omission: where a day
// sits in a lifter's week is their ordering of their own life, not a program change an agent
// proposes, so a diff about bench press cannot quietly reshuffle the routines screen.
//
// `source` is provenance — which door, which connection, which model — carried on the write rather
// than inferred later, because W7's Ask mints through this same object and the difference between
// the two doors must be a column and never a fork.
struct ProposalWrite {
  ProposalId id;
  RoutineId routine;
  std::optional<std::string> name;   // absent = the routine keeps the name it has
  std::string summary;
  std::vector<RoutineEntry> entries;
  ProposalSource source;
};

// A movement a lifter created, off the picker's "no movement by that name". stepKg is the one
// optional: omitted, the equipment decides it (defaultStepKg), which is how the 64 seeds were
// written. It is stored and served and nothing steps a weight by it — see Training.h.
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
// `deleted` is the store's own fact and the one refusal here that exists because of the delete
// route: the id names a set this lifter TOOK OUT of the log. It is not idTaken and must never be
// answered as one — a spent id is repaired by minting a fresh one and sending the set again, which
// is exactly how a deleted set would come back under a new number the first time an append whose
// reply was lost is replayed. Nothing repairs this one: the set is not owed, and the queue holding
// it drops it.
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
// record is §G's gold dot — a personal record happened in this workout. It is the domain's three
// rules (domain/Review.h), run over the whole page in one walk against the marks standing before
// it, so the dot on a row and the loud line on that session's finish screen are the same judgement
// and cannot disagree — which takes the walk being told which rows are FINISHED, because the finish
// read counts finished sessions alone and the page carries the open workout too. It is recomputed
// on every read and stored nowhere, which is what keeps it
// honest: a record is judged against the log AS IT IS NOW, so a set arriving late from a flush
// queue — or a later correction — moves the dot instead of leaving it lying.
//
// topE1rm is `domain/Review`'s `topE1rmOf` over the loads the store handed back — the SAME function
// the finish screen's `ReviewStats::topE1rm` comes through, which is the whole point of routing it
// here. It is the best estimate over every working set and NOT Epley over `summary.topSet`: those
// two disagree on an ordinary top-set-and-back-offs session (100 × 5 then 3 × 95 × 10 estimates
// 126.7 off the back-offs and 116.7 off the top set), and a lifter who finished a workout and then
// opened The log would have read two numbers under the word `e1RM`, two taps apart.
//
// Epley reaches neither the database — picking a set BY e1RM is the formula, not an ordering, so the
// store hands over its per-load projection instead (`ports/TrainingRepository.h`) — nor a client,
// because the formula has one copy per language (§11.5) and a log row that computed its own would be
// the second copy in JavaScript. It is absent exactly where Epley is undefined: a session holding no
// working set, and one whose working sets were all chin-ups at 0 kg or band-assisted pulls at −20,
// which have no honest one-rep estimate to print.
struct LogRow {
  SessionSummary summary;
  std::optional<double> topE1rm;
  bool record = false;

  bool operator==(const LogRow&) const = default;
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

  // The correction, and the delete beside it — the log moves, the routine does not. Both name the
  // SESSION as well as the set, because a set id that resolves under this account but in another
  // workout is not this session's to change: it is the same absent fact as one that never existed,
  // and a client cannot walk a stale id into a workout it is not looking at.
  //
  // `fixSet` is the load → pure rule → write → answer-with-the-store shape every write in this file
  // has; `deleteSet` answers nothing, which is what makes a lost reply safe to send again. NOTHING
  // either of them does reaches `gym_sessions.plan` or a routine entry — the frozen snapshot is the
  // program's word about the past and a correction is the log's word about it, and §G18 puts that
  // on screen: *Push A keeps its own numbers.*
  std::optional<Set> fixSet(const UserId& user, const SessionId& session, const SetId& id,
                            const SetFix& fix);
  void deleteSet(const UserId& user, const SessionId& session, const SetId& id);
  std::vector<LogRow> log(const UserId& user, const LogCursor& cursor);
  std::optional<SessionDetail> detail(const UserId& user, const SessionId& session);
  // Is a workout running? Settled first — the same lazy close a log read takes — so a session
  // somebody walked away from yesterday answers as the closed thing it is rather than as a workout
  // in flight. Ask asks this before it will answer at all (§L: never offered mid-session), and it is
  // one row rather than a search because one open session per account is the store's own index.
  std::optional<Session> openSession(const UserId& user);
  std::vector<Exercise> catalog(const UserId& user);
  LastTimeOutcome lastTime(const UserId& user, const ExerciseId& exercise);
  // The picker's meta beside the catalog, and deliberately NOT inside it: the catalog is 64 rows
  // read on nearly every screen and most of them are movements a given lifter has never touched, so
  // the annotation is asked for by the one surface that draws it. Nothing here computes anything —
  // which set is "last" is the store's ordering, the same one lastTime states.
  std::vector<LastSet> lastSets(const UserId& user);

  // The plan, and the catalog's one write. Every refusal these can answer is the store's own fact,
  // so they hand the port's outcomes straight back rather than re-spelling them into a second enum
  // that could only ever say the same words — the same pass-through lastTime is.
  std::vector<Routine> routines(const UserId& user);
  std::optional<Routine> routine(const UserId& user, const RoutineId& id);
  // The routine's dated history — its creation and every proposal ever minted against it, in one
  // list (ports/TrainingRepository.h). It rides on the routine's own read rather than on a route of
  // its own, because it is one section of one screen (§M30) and a page that made a call per section
  // draws in stages.
  std::vector<RoutineEvent> routineHistory(const UserId& user, const RoutineId& id);
  // `byAgent` is the door a create came through, absent for the lifter's own hand. It is stated by
  // each caller rather than defaulted: the app's route and the MCP tool are the only two, and a
  // third one that appeared without saying which it was would quietly claim the lifter's.
  RoutineWriteOutcome createRoutine(const UserId& user, const RoutineWrite& incoming,
                                    std::optional<ProposalDoor> byAgent);
  // The PATH names the routine being replaced; the body carries what it becomes.
  //
  // THIS IS THE HUMAN'S HAND, and it is reachable from `PUT /v1/gym/routines/{id}` alone. No MCP
  // tool calls it at any grant level — the tool layer is the only place gym can tell an agent from
  // a hand, and an agent that wants this asks for it through the proposal ledger below. A wave that
  // "completes the catalog" here deletes the whole of §D from the product.
  RoutineWriteOutcome replaceRoutine(const UserId& user, const RoutineId& id,
                                     const RoutineWrite& incoming);
  bool deleteRoutine(const UserId& user, const RoutineId& id);

  // THE PROPOSAL LEDGER — the agent's whole reach into a day of the program that already stands.
  //
  // `propose` is the only one of the four an agent can call. It loads the routine under the
  // caller's own scope, builds the document it would become — through the Routine constructor, so a
  // proposal that could not be stored as a plan is refused at the mint rather than at the tap —
  // asks the pure rule for the typed field-level diff, and stores that against the routine's
  // current revision. Nothing is written to the program.
  //
  // `apply` and `dismiss` are the LIFTER's, reached from two owner-scoped routes and from no tool
  // at any level, because Apply is not a capability. `apply` is atomic: the domain computes the
  // routine the proposal makes true, the store writes it against the frozen base revision, and a
  // routine that moved since is superseded rather than merged over the top.
  std::vector<ProposalHead> proposals(const UserId& user, const ProposalQuery& query);
  std::optional<RoutineProposal> proposal(const UserId& user, const ProposalId& id);
  ProposalMintOutcome propose(const UserId& user, const ProposalWrite& incoming);
  ProposalMintOutcome proposeRemoval(const UserId& user, const ProposalId& id,
                                     const RoutineId& routine, const std::string& summary,
                                     const ProposalSource& source);
  ProposalSettleOutcome apply(const UserId& user, const ProposalId& id);
  ProposalSettleOutcome dismiss(const UserId& user, const ProposalId& id);
  ExerciseInsertOutcome createExercise(const UserId& user, const ExerciseWrite& incoming);
  // The rename, and the identity it exists to prove: the movement keeps its id, so every set and
  // every plan that names it is untouched and the history stays whole. The name is validated where
  // every other value in this product is — by constructing the entity — so a name the store cannot
  // hold never reaches it. Absent is the store's one fact: this account's catalog holds no such
  // movement.
  std::optional<Exercise> renameExercise(const UserId& user, const ExerciseId& id,
                                         const std::string& name);

  // The finish surface. review is a read with no refusal of its own — an absent review is an absent
  // session, exactly as detail's is — and discard is the one door that takes something away.
  std::optional<Review> review(const UserId& user, const SessionId& session);
  DiscardOutcome discard(const UserId& user, const SessionId& session);

  // The two long reads. `statistics` is one load and one pure rule, exactly as `review` is — the
  // shape this service uses wherever a surface is computed rather than stored. `exportedSets` has
  // no rule at all: it hands back what is stored, which is the point of an export.
  Statistics statistics(const UserId& user);
  std::vector<ExportedSet> exportedSets(const UserId& user);
  // Threads in the export with everything else (§O), and the second half of the trust argument for a
  // multi-year artifact: a lifter walks away with what they asked and what was answered, byte for
  // byte. It is the two-phase shape — the store renders the rows, the domain decides each thread's
  // outcome, and this stamps the second onto the first. UNBOUNDED on both halves — the outcomes come
  // from `allThreads` rather than the list read, because a ceiling that is honest on a screen is a
  // lie in an archive, and every thread that exists is in the file whether or not it holds a turn.
  std::vector<ExportedThreadTurn> exportedThreadTurns(const UserId& user);
  // A movement's record — the same one-load-one-rule shape, narrowed to one movement, and the read
  // that replaced the statistics room on every surface. Absent is the store's one fact: this
  // account's catalog holds no such movement.
  std::optional<MovementRecord> movementRecord(const UserId& user, const ExerciseId& exercise);

  // Settings (§I), and the one pair here that is not about the log at all — they live on this
  // service rather than behind a second one because a service of two pass-throughs is indirection
  // with one call site, and because the HTTP and MCP doors already hold exactly this object: one
  // core, two doors, and a rule that cannot be true on one surface and not the other.
  //
  // The read answers the DEFAULTS where nothing is stored rather than an absence, because every
  // client needs the rest target and the reading unit to draw its first frame — a 404 there would
  // put a copy of the defaults in each of them, and the fourth copy is the one that disagrees.
  //
  // The write is the WHOLE document, the shape a routine travels in and for the shape's own reason:
  // the settings screen renders every row from one value it already holds, so it always has the
  // whole document in hand, and a partial write would need "omitted" and "cleared" to be different
  // things on the one field whose absence already means something — an absent rest target IS the
  // timer off. It answers with the stored row, so a client draws what the store now holds.
  GymPreferences preferences(const UserId& user);
  GymPreferences savePreferences(const GymPreferences& incoming);

  // The coach share. The mint answers with the live share on a repeat, so nothing here has to ask
  // first — the store resolves it, the same write-then-resolve every other write in this file uses.
  // An absent answer is the one fact a session read gives: absent and another account's alike.
  std::optional<SessionShare> share(const UserId& user, const SessionId& session);
  bool revokeShare(const UserId& user, const SessionId& session);
  // The one read here with no caller, and it settles NOTHING: a stranger holding a link must never
  // be able to write to the owner's log, not even the four-hour close every authenticated read
  // takes. The token is the whole credential and the clock decides whether it is still one.
  std::optional<SharedSession> shared(const std::string& token);

  // ASK'S THREADS (§O) — and they live HERE rather than on AskService for a reason a lifter would
  // recognise: a conversation they had is their data, not a feature of the model. A deployment with
  // no vendor key wired registers no `POST /v1/gym/ask` at all, and the threads already had are
  // still theirs to read, to export and to delete. Ask writes them; the log keeps them.
  //
  // Each read hands back the domain value whole and the OUTCOME is derived at the edge that draws
  // it (`outcomeOf`, domain/Thread.h), never stored: the proposals are the outcome, and a column
  // beside them would be a second copy of a fact the ledger already holds.
  std::vector<AskThread> threads(const UserId& user);
  std::optional<AskThread> thread(const UserId& user, const ThreadId& id);
  // The three WRITES, and Ask is their only caller — they live here rather than on AskService
  // because this is the object that holds the store and the clock, and a conversation is dated by
  // the server's clock like every instant the server itself decides. `openThread` lands before the
  // model runs (a proposal minted mid-conversation points at the row); `appendTurns` lands only once
  // an answer has, so a question nobody answered is not a turn; `discardEmptyThread` is what takes
  // back a thread whose run never answered, and it can only ever take one that holds no turns.
  ThreadOpenOutcome openThread(const UserId& user, const ThreadId& id, const std::string& title);
  void appendTurns(const UserId& user, const ThreadId& id, std::vector<ThreadTurn> turns);
  void discardEmptyThread(const UserId& user, const ThreadId& id);
  // The lifter's delete, and the whole of it: the conversation goes, the consequence stays. An
  // applied change is still in the routine's history saying it came from Ask — it just no longer
  // opens a conversation that exists.
  bool deleteThread(const UserId& user, const ThreadId& id);

private:
  LogRepository& log_;
  CatalogRepository& catalog_;
  ProgramRepository& program_;
  AskThreadRepository& threads_;
  PreferencesRepository& preferences_;
  Clock& clock_;
  TokenGenerator& tokens_;
};

}
