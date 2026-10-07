#pragma once

#include "products/gym/domain/Proposal.h"
#include "products/gym/domain/Routine.h"
#include "products/gym/domain/Training.h"

#include <cstdint>
#include <optional>
#include <vector>

namespace wm::gym {

// What a surface is asking the proposal ledger for.
struct ProposalQuery {
  std::optional<RoutineId> routine;
  bool pendingOnly = false;

  bool operator==(const ProposalQuery&) const = default;
};

// `proposal` is present exactly when kind is `proposal`, and carries the actor in `source.door`.
// `door` and `movements` belong to the created row alone — an absent door is the lifter's own hand,
// and an absent `movements` means the count was never recorded.
enum class RoutineEventKind { created, proposal };

struct RoutineEvent {
  RoutineEventKind kind;
  std::uint64_t atMs;
  std::optional<ProposalDoor> door;       // created only; absent = the lifter's own hand
  std::optional<int> movements;           // created only; absent = never recorded
  std::optional<ProposalHead> proposal;   // present exactly when kind == proposal

  bool operator==(const RoutineEvent&) const = default;
};

// The creation row is always last and never counts against this, so it bounds the proposals above it.
constexpr int kRoutineHistoryProposals = 20;

// The routines and the proposal ledger, as the engine stores them, read. Every read is owner-scoped by
// the UserId it carries; absent is byte-identical to forbidden.
struct ProgramRepository {
  virtual ~ProgramRepository() = default;
  virtual std::optional<Routine> routineCreation(const UserId& user, const RoutineId& id) = 0;

  // Both reads carry lastTrainedAtMs, an aggregate over the log rather than a column; its absence is
  // the whole of `untested`.
  virtual std::vector<Routine> routines(const UserId& user) = 0;   // most recently trained first
  virtual std::optional<Routine> routine(const UserId& user, const RoutineId& id) = 0;
  // The routine's dated history, newest first, with its creation row last.
  virtual std::vector<RoutineEvent> routineHistory(const UserId& user, const RoutineId& id) = 0;

  // `proposalHeads` carries no diff rows; `proposal` is the one that fills `loggedSets` on a removed
  // line, counted at read rather than at mint.
  virtual std::vector<ProposalHead> proposalHeads(const UserId& user, const ProposalQuery& query) = 0;
  virtual std::optional<RoutineProposal> proposal(const UserId& user, const ProposalId& id) = 0;
};

}
