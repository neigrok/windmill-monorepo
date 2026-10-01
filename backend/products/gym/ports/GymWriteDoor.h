#pragma once

#include "products/gym/ports/LogRepository.h"
#include "products/gym/ports/ProgramRepository.h"
#include "products/gym/ports/CatalogRepository.h"
#include "products/gym/ports/NotesRepository.h"
#include "products/gym/ports/BodyweightRepository.h"
#include "products/gym/ports/PreferencesRepository.h"
#include "products/gym/domain/Thread.h"

namespace wm::gym {

struct SessionStart;
struct SetWrite;
struct SessionImport;
struct StartOutcome;
struct AppendOutcome;
struct FinishOutcome;
struct ProposalWrite;
enum class DiscardOutcome;

class GymWriteDoor {
public:
  virtual ~GymWriteDoor() = default;
  virtual void closeStale(const UserId&) = 0;
  virtual void unlinkThread(const UserId&, const ThreadId&) = 0;
  virtual StartOutcome start(const UserId&, const SessionStart&) = 0;
  virtual AppendOutcome append(const UserId&, const SessionId&, const SetWrite&) = 0;
  virtual BatchLogOutcome appendSets(const UserId&, const SessionId&, const std::vector<SetWrite>&) = 0;
  virtual BatchLogOutcome importSession(const UserId&, const SessionImport&) = 0;
  virtual FinishOutcome finish(const UserId&, const SessionId&, std::uint64_t) = 0;
  virtual std::optional<Set> fixSet(const UserId&, const SessionId&, const SetId&, const SetFix&) = 0;
  virtual void deleteSet(const UserId&, const SessionId&, const SetId&) = 0;
  virtual DiscardOutcome discard(const UserId&, const SessionId&) = 0;
  virtual CorrectionOutcome correctSession(const UserId&, const SessionId&, const SessionCorrectionIn&) = 0;

  virtual RoutineWriteOutcome createRoutine(const Routine&, std::optional<ProposalDoor>) = 0;
  virtual RoutineWriteOutcome replaceRoutine(const Routine&, std::optional<int>) = 0;
  virtual bool deleteRoutine(const UserId&, const RoutineId&) = 0;
  virtual ProposalMintOutcome propose(const UserId&, const ProposalWrite&) = 0;
  virtual ProposalMintOutcome proposeRemoval(const UserId&, const ProposalId&, const RoutineId&,
                                     const std::string&, const ProposalSource&) = 0;
  virtual ProposalSettleOutcome apply(const UserId&, const ProposalId&) = 0;
  virtual ProposalSettleOutcome dismiss(const UserId&, const ProposalId&) = 0;
  virtual ExerciseInsertOutcome createExercise(const UserId&, const Exercise&) = 0;
  virtual std::optional<Exercise> renameExercise(const UserId&, const ExerciseId&, const std::string&) = 0;
  virtual NoteWriteOutcome saveNote(const Note&) = 0;
  virtual NoteWriteOutcome saveInsight(const Note&) = 0;
  virtual void deleteNote(const UserId&, const NoteId&) = 0;
  virtual NotesOrderOutcome reorderNotes(const UserId&, const std::vector<NoteId>&) = 0;
  virtual Bodyweight saveBodyweight(const Bodyweight&) = 0;
  virtual void deleteBodyweight(const UserId&, const std::string&) = 0;
  virtual GymPreferences savePreferences(const GymPreferences&) = 0;

};

}
