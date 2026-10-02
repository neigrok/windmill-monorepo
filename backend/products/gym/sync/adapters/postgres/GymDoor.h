#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/ports/GymWriteDoor.h"
#include "platform/application/sync/Admission.h"
#include "products/gym/application/TrainingService.h"
#include "products/gym/application/ProgramService.h"
#include "products/gym/application/CatalogService.h"
#include "products/gym/ports/NotesRepository.h"
#include "products/gym/ports/BodyweightRepository.h"
#include "products/gym/ports/PreferencesRepository.h"

#include <functional>
#include <memory>

namespace wm::gym {

class GymDoor final : public GymWriteDoor {
public:
  GymDoor(std::shared_ptr<PgPool>, Clock&, FailureReporter&, LogRepository&, ProgramRepository&,
          CatalogRepository&, NotesRepository&, BodyweightRepository&, PreferencesRepository&,
          std::shared_ptr<sync::SyncCatalog>, sync::ChangeFeed* = nullptr);
  ~GymDoor() override;
  using Builder = std::function<std::optional<Json::Value>(sync::SyncTxn&)>;
  Json::Value execute(const UserId&, const std::string& tool, const Json::Value& args, const Builder&,
                      std::optional<std::string> requestId = std::nullopt);
  Json::Value command(const UserId&, const std::string&, const Json::Value&);
  void closeStale(const UserId&) override;
  void unlinkThread(const UserId&, const ThreadId&) override;
  static Json::Value intent();
  static Json::Value delta(const std::string& type, const std::string& id, const Json::Value& fields,
                           bool create = false, bool dead = false);
  static std::string refusal(const Json::Value&);
  static void requireOk(const Json::Value&);
  bool recordTaken(sync::SyncTxn&, const UserId&, const std::string& type, const std::string& id);

  StartOutcome start(const UserId&, const SessionStart&) override;
  AppendOutcome append(const UserId&, const SessionId&, const SetWrite&) override;
  BatchLogOutcome appendSets(const UserId&, const SessionId&, const std::vector<SetWrite>&) override;
  BatchLogOutcome importSession(const UserId&, const SessionImport&) override;
  FinishOutcome finish(const UserId&, const SessionId&, std::uint64_t) override;
  std::optional<Set> fixSet(const UserId&, const SessionId&, const SetId&, const SetFix&) override;
  void deleteSet(const UserId&, const SessionId&, const SetId&) override;
  DiscardOutcome discard(const UserId&, const SessionId&) override;
  CorrectionOutcome correctSession(const UserId&, const SessionId&, const SessionCorrectionIn&) override;

  RoutineWriteOutcome createRoutine(const Routine&, std::optional<ProposalDoor>) override;
  RoutineWriteOutcome replaceRoutine(const Routine&, std::optional<int>) override;
  bool deleteRoutine(const UserId&, const RoutineId&) override;
  ProposalMintOutcome propose(const UserId&, const ProposalWrite&) override;
  ProposalMintOutcome proposeRemoval(const UserId&, const ProposalId&, const RoutineId&,
                                     const std::string&, const ProposalSource&) override;
  ProposalSettleOutcome apply(const UserId&, const ProposalId&) override;
  ProposalSettleOutcome dismiss(const UserId&, const ProposalId&) override;
  ExerciseInsertOutcome createExercise(const UserId&, const Exercise&) override;
  std::optional<Exercise> renameExercise(const UserId&, const ExerciseId&, const std::string&) override;
  NoteWriteOutcome saveNote(const Note&) override;
  NoteWriteOutcome saveInsight(const Note&) override;
  void deleteNote(const UserId&, const NoteId&) override;
  NotesOrderOutcome reorderNotes(const UserId&, const std::vector<NoteId>&) override;
  Bodyweight saveBodyweight(const Bodyweight&) override;
  void deleteBodyweight(const UserId&, const std::string&) override;
  GymPreferences savePreferences(const GymPreferences&) override;

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  Clock& clock_;
  LogRepository& log_;
  ProgramRepository& program_;
  CatalogRepository& catalog_;
  NotesRepository& notes_;
  BodyweightRepository& bodyweight_;
  PreferencesRepository& preferences_;
};

}
