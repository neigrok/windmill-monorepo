#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/application/sync/Admission.h"
#include "platform/ports/Clock.h"
#include "platform/ports/FailureReporter.h"
#include "products/gym/ports/CatalogRepository.h"
#include "products/gym/ports/GymWriteDoor.h"
#include "products/gym/ports/LogRepository.h"
#include "products/gym/ports/ProgramRepository.h"

#include <functional>
#include <memory>

namespace wm::gym {

// The engine's server-origin door for gym: each write builds the intent a phone would push, under the
// scope lock, and admits it; each answer is read back through the repositories. Committed changes
// reach live sockets through `feed`.
class GymDoor final : public GymWriteDoor {
public:
  GymDoor(std::shared_ptr<PgPool>, Clock&, FailureReporter&, LogRepository&, ProgramRepository&,
          CatalogRepository&, std::shared_ptr<sync::SyncCatalog>, sync::ChangeFeed& feed);
  ~GymDoor() override;

  // The intent a phone would push into the account's gym scope, with no delta yet; and that intent
  // carrying one command.
  static Json::Value intent();
  static Json::Value intent(const std::string& command, const Json::Value& args);
  static Json::Value delta(const std::string& type, const std::string& id, const Json::Value& fields,
                           bool create = false, bool dead = false);
  static std::string refusal(const Json::Value&);
  static void requireOk(const Json::Value&);

  // One server-origin call on the door's worker: the builder runs under the scope lock and answers the
  // intent to admit, or nothing to admit nothing; the answer is the engine's result.
  using Builder = std::function<std::optional<Json::Value>(sync::SyncTxn&)>;
  Json::Value execute(const UserId&, const Builder&);
  Json::Value command(const UserId&, const std::string& name, const Json::Value& args);

  void closeStale(const UserId&) override;
  void unlinkThread(const UserId&, const ThreadId&) override;

  StartOutcome start(const UserId&, const SessionStart&) override;
  AppendOutcome append(const UserId&, const SessionId&, const SetWrite&) override;
  BatchLogOutcome appendSets(const UserId&, const SessionId&, const std::vector<SetWrite>&) override;
  BatchLogOutcome importSession(const UserId&, const SessionImport&) override;
  FinishOutcome finish(const UserId&, const SessionId&, std::uint64_t) override;
  DiscardOutcome discard(const UserId&, const SessionId&) override;

  RoutineWriteOutcome createRoutine(const Routine&, std::optional<ProposalDoor>) override;
  ProposalMintOutcome propose(const UserId&, const ProposalWrite&) override;
  ProposalMintOutcome proposeRemoval(const UserId&, const ProposalId&, const RoutineId&,
                                     const std::string&, const ProposalSource&) override;
  ExerciseInsertOutcome createExercise(const UserId&, const Exercise&) override;
  NoteWriteOutcome saveInsight(const Note&) override;

private:
  // The proposal a mint would store against the routine as it stands, or nothing when it moves nothing.
  using ProposalOf = std::function<std::optional<RoutineProposal>(const Routine& base)>;
  // Both proposal mints: resolve the routine and the id, check the lines the proposal names, write it.
  ProposalMintOutcome mintProposal(const UserId&, const ProposalId&, const RoutineId&,
                                   const std::vector<RoutineEntry>& lines, const ProposalOf&);
  // Whether the id is held or spent anywhere, by this account or another.
  bool recordTaken(sync::SyncTxn&, const UserId&, const std::string& type, const std::string& id);

  struct Impl;
  std::unique_ptr<Impl> impl_;
  Clock& clock_;
  LogRepository& log_;
  ProgramRepository& program_;
  CatalogRepository& catalog_;
};

}
