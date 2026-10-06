#pragma once

#include "products/gym/ports/GymWriteDoor.h"
#include "products/gym/ports/ProgramRepository.h"

#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// A routine travels as its WHOLE document; there is no per-entry write and no reorder verb. Entry
// positions are the order the entries arrive in; the Routine constructor refuses anything else.
struct RoutineWrite {
  RoutineId id;
  std::string name;
  int position;
  std::vector<RoutineEntry> entries;
};

// The routines, and the proposal ledger an agent writes into and only a lifter settles, on a phone.
// Every refusal is the engine's own fact, handed straight back; the door validates a routine's
// movements itself, so no catalog port is held here.
class ProgramService {
public:
  ProgramService(ProgramRepository& program, GymWriteDoor& door);

  std::optional<Routine> routineCreation(const UserId& user, const RoutineId& id);
  std::vector<Routine> routines(const UserId& user);
  std::optional<Routine> routine(const UserId& user, const RoutineId& id);
  // The routine's creation and every proposal ever minted against it, in one list.
  std::vector<RoutineEvent> routineHistory(const UserId& user, const RoutineId& id);
  // `byAgent` is the door a create came through, absent for the lifter's own hand; every caller
  // states it rather than defaulting it.
  RoutineWriteOutcome createRoutine(const UserId& user, const RoutineWrite& incoming,
                                    std::optional<ProposalDoor> byAgent);

  // `propose` loads the routine under the caller's own scope, builds the document it would become
  // through the Routine constructor, diffs it, and stores that against the routine's current revision.
  // Nothing is written to the program.
  std::vector<ProposalHead> proposals(const UserId& user, const ProposalQuery& query);
  std::optional<RoutineProposal> proposal(const UserId& user, const ProposalId& id);
  ProposalMintOutcome propose(const UserId& user, const ProposalWrite& incoming);
  ProposalMintOutcome proposeRemoval(const UserId& user, const ProposalId& id,
                                     const RoutineId& routine, const std::string& summary,
                                     const ProposalSource& source);

private:
  ProgramRepository& program_;
  GymWriteDoor& door_;
};

}
