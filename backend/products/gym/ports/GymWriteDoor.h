#pragma once

#include "products/gym/domain/Note.h"
#include "products/gym/domain/Proposal.h"
#include "products/gym/domain/Routine.h"
#include "products/gym/domain/Training.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace wm::gym {

// Everything the client says, nothing the server decides: the set number and the owner are the
// engine's to assign. joinOpenSession true puts the caller into whatever session is open; false
// creates exactly the session named, which is what logging a past workout needs. A named routine is
// frozen onto a session the start CREATES, from the engine's own row; the client never composes the
// copy.
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
  std::optional<double> rpe;
  std::string note;
  std::uint64_t completedAtMs;
};

// Where an import's loads come from: `recorded` history replays every load as it was logged; a workout an agent
// `entered` now holds each new set to its movement's load floor, as a phone's set entry does.
enum class ImportOrigin { recorded, entered };

// A workout that already happened, written whole: the import route replays recorded history, and an agent's
// import_session enters one.
struct SessionImport {
  SessionId id;
  std::uint64_t startedAtMs;
  std::uint64_t finishedAtMs;
  std::optional<RoutineId> routine;
  std::vector<SetWrite> sets;
  ImportOrigin origin = ImportOrigin::recorded;
};

// A routine travels whole; its entry positions are the order they arrive in.
struct RoutineWrite {
  RoutineId id;
  std::string name;
  int position;
  std::vector<RoutineEntry> entries;
};

// An omitted step takes the equipment's domain default.
struct ExerciseWrite {
  ExerciseId id;
  std::string name;
  Pattern pattern;
  Equipment equipment;
  std::optional<double> stepKg;
};

struct ExerciseUpdate {
  ExerciseId id;
  std::optional<std::string> name;
  std::optional<Equipment> equipment;
  std::optional<int> loadCount;
  std::optional<std::string> requestId;
};

// The proposal's id is the caller's to mint, so a lost reply is replayed rather than turned into a
// second proposal. `name` absent keeps the routine's name; `source` is provenance, carried on the write.
struct ProposalWrite {
  ProposalId id;
  RoutineId routine;
  std::optional<std::string> name;
  std::string summary;
  std::vector<RoutineEntry> entries;
  ProposalSource source;
};

// Refusals cross as values; InvalidTraining stays reserved for malformed input. idTaken: a
// client-minted id is already spent, never by whom. alreadyOpen is reachable only by a caller that
// said it would not join. unknownRoutine is a creating start naming a plan this account cannot read.
// `deleted` names a set the lifter took out of the log — never answer it as idTaken, whose repair
// (mint a fresh id and resend) would bring the deleted set back. `belowFloor` is a new set's load under its movement's
// load floor, the movement named by `belowFloorOf`; a set that already landed replays whatever it holds. An append's
// `clockAhead` is a new set completed more than kMaxClockAheadMs past the log's now, as a start's is.
enum class StartError { none, idTaken, alreadyOpen, unknownRoutine, clockAhead };
enum class AppendError { none, notFound, finished, idTaken, unknownExercise, deleted, belowFloor, clockAhead };
enum class FinishError { none, notFound, badInstant };
// `open` refuses to delete a workout still being logged into, whose queued sets are in flight.
enum class DiscardOutcome { done, notFound, open };

struct StartOutcome {
  std::optional<Session> session;
  StartError error;
  std::uint64_t clockAheadMs = 0;  // clockAhead only: how far the named start sits past the log's now
};

struct AppendOutcome {
  std::optional<Set> set;
  AppendError error;
  std::optional<Exercise> belowFloorOf = std::nullopt;
  std::uint64_t clockAheadMs = 0;  // clockAhead only: how far the set's completedAt sits past the log's now
};

struct FinishOutcome {
  std::optional<Session> session;
  FinishError error;
};

// `overlap` is an import's alone: its span crosses a finished session, which `overlapping` names. `belowFloor` is an
// append's or an entered import's, for the set at `errorIndex`.
enum class BatchLogError { none, notFound, idTaken, unknownExercise, unknownRoutine, finished, deleted, payloadConflict, overlap, belowFloor };

struct RecordedSet {
  SetId id;
  std::optional<Set> current;
  bool replayed = false;
};

struct BatchLogOutcome {
  std::optional<Session> session;
  std::vector<RecordedSet> sets;
  BatchLogError error = BatchLogError::none;
  std::optional<std::size_t> errorIndex;
  bool replayed = false;
  bool sessionDeleted = false;
  std::optional<Session> overlapping;
  std::optional<Exercise> belowFloorOf;
};

// idTaken: the id is spent on a row this account does not own, never whose. belowFloor: a target under its movement's
// load floor, which `belowFloor` names.
enum class RoutineWriteError { none, idTaken, unknownExercise, belowFloor };

struct RoutineWriteOutcome {
  std::optional<Routine> routine;
  RoutineWriteError error;
  std::optional<BelowFloor> belowFloor = std::nullopt;
};

// A spent id splits three ways: `idTaken` is an id spent on a proposal this account cannot see; the
// caller's own id carrying the SAME document is the replay and reads back the stored proposal
// untouched; the caller's own id carrying a DIFFERENT document is `idReused`. `unknownRoutine` is
// absent and another account's alike. `noChange` — a document identical to what the routine already
// says — is decided before a row is built. `belowFloor` is a changed target under its movement's load floor.
enum class ProposalMintError { none, idTaken, idReused, unknownRoutine, unknownExercise, noChange, belowFloor };

struct ProposalMintOutcome {
  std::optional<RoutineProposal> proposal;
  ProposalMintError error;
  std::optional<BelowFloor> belowFloor = std::nullopt;
};

// The whole plan the open workout would take on, in order; the caller mints the id as for a routine proposal.
struct WorkoutProposalWrite {
  ProposalId id;
  SessionId session;
  std::string summary;
  std::vector<RoutineEntry> entries;
  ProposalSource source;
};

// The spent-id split of ProposalMintError, and the workout's own refusals: `unknownSession` is absent and another
// account's alike, `noPlan` a workout started with no routine, `finished` a closed one, `planLogged` a change to a
// movement with a logged set (`exercise` names it), `invalidPlan` a plan the rules refuse otherwise, as a second entry
// of a movement the workout plans once, `belowFloor` a changed target under its movement's load floor.
enum class WorkoutProposalError { none, idTaken, idReused, unknownSession, noPlan, finished, unknownExercise, planLogged, invalidPlan, noChange, belowFloor };

struct WorkoutProposalOutcome {
  std::optional<WorkoutProposal> proposal;
  WorkoutProposalError error;
  std::optional<ExerciseId> exercise;
  std::optional<BelowFloor> belowFloor = std::nullopt;
};

// A seed's slug and another lifter's custom id are both simply taken.
enum class ExerciseInsertError { none, idTaken };

struct ExerciseInsertOutcome {
  std::optional<Exercise> exercise;
  ExerciseInsertError error;
};

// `full` is the tenth note already standing; `idTaken` is an id spent on a note this account cannot see.
enum class NoteWriteError { none, full, idTaken };

struct NoteWriteOutcome {
  std::optional<Note> note;
  NoteWriteError error;
};

// The engine could not take the write now: `gym-engine-busy` (its queue is full) or
// `gym-engine-unavailable` (it refused for a reason no door maps). Retryable; never the client's fault.
struct GymUnavailable : std::runtime_error {
  std::string code;
  GymUnavailable(std::string code, std::string message)
      : std::runtime_error(std::move(message)), code(std::move(code)) {}
};

// Every gym write the server makes on a lifter's behalf, admitted by the sync engine as a
// server-origin intent: MCP, Coach, the import route, and the lazy close of a workout walked away from.
class GymWriteDoor {
public:
  virtual ~GymWriteDoor() = default;
  // Admits the close only when the open workout isStale; with nothing stale it writes nothing.
  virtual void closeStale(const UserId&) = 0;
  virtual void unlinkThread(const UserId&, const ThreadId&) = 0;
  virtual StartOutcome start(const UserId&, const SessionStart&) = 0;
  virtual AppendOutcome append(const UserId&, const SessionId&, const SetWrite&) = 0;
  virtual BatchLogOutcome appendSets(const UserId&, const SessionId&, const std::vector<SetWrite>&) = 0;
  virtual BatchLogOutcome importSession(const UserId&, const SessionImport&) = 0;
  virtual FinishOutcome finish(const UserId&, const SessionId&, std::uint64_t) = 0;
  virtual DiscardOutcome discard(const UserId&, const SessionId&) = 0;
  virtual RoutineWriteOutcome createRoutine(const UserId&, const RoutineWrite&, std::optional<ProposalDoor>) = 0;
  virtual ProposalMintOutcome propose(const UserId&, const ProposalWrite&) = 0;
  virtual ProposalMintOutcome proposeRemoval(const UserId&, const ProposalId&, const RoutineId&,
                                             const std::string&, const ProposalSource&) = 0;
  virtual WorkoutProposalOutcome proposeWorkout(const UserId&, const WorkoutProposalWrite&) = 0;
  virtual ExerciseInsertOutcome createExercise(const UserId&, const ExerciseWrite&) = 0;
  virtual std::optional<Exercise> updateExercise(const UserId&, const ExerciseUpdate&) = 0;
  virtual NoteWriteOutcome saveInsight(const Note&) = 0;
};

}
