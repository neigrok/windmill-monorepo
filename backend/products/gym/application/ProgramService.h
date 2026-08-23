#pragma once

#include "platform/ports/Clock.h"
#include "products/gym/ports/ProgramRepository.h"

#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// A routine travels as its WHOLE document; there is no per-entry route and no reorder verb. Entry
// positions are the order the entries arrive in; the Routine constructor refuses anything else.
struct RoutineWrite {
  RoutineId id;
  std::string name;
  int position;
  std::vector<RoutineEntry> entries;
  std::optional<int> expectedRevision;  // the revision the editor read; named → a moved day is refused stale
};

// The proposal's own id is the caller's to mint, so a lost reply is replayed rather than turned into
// a second proposal. There is no `position`: a proposal cannot reshuffle the routines screen.
// `source` is provenance, carried on the write rather than inferred.
struct ProposalWrite {
  ProposalId id;
  RoutineId routine;
  std::optional<std::string> name;   // absent = the routine keeps the name it has
  std::string summary;
  std::vector<RoutineEntry> entries;
  ProposalSource source;
};

// The routines, and the proposal ledger an agent writes into and only a hand settles. Every refusal
// is the store's own fact, handed straight back. The store validates a routine's movements itself,
// so no catalog port is held here.
class ProgramService {
public:
  ProgramService(ProgramRepository& program, Clock& clock);

  std::vector<Routine> routines(const UserId& user);
  std::optional<Routine> routine(const UserId& user, const RoutineId& id);
  // The routine's creation and every proposal ever minted against it, in one list.
  std::vector<RoutineEvent> routineHistory(const UserId& user, const RoutineId& id);
  // `byAgent` is the door a create came through, absent for the lifter's own hand; every caller
  // states it rather than defaulting it.
  RoutineWriteOutcome createRoutine(const UserId& user, const RoutineWrite& incoming,
                                    std::optional<ProposalDoor> byAgent);
  // Reachable from `PUT /v1/gym/routines/{id}` alone: no MCP tool may call it at any grant level.
  RoutineWriteOutcome replaceRoutine(const UserId& user, const RoutineId& id,
                                     const RoutineWrite& incoming);
  bool deleteRoutine(const UserId& user, const RoutineId& id);

  // `propose` is the only one of the four an agent may call. It loads the routine under the caller's
  // own scope, builds the document it would become through the Routine constructor, diffs it, and
  // stores that against the routine's current revision. Nothing is written to the program.
  // `apply` and `dismiss` are the LIFTER's, reached from two owner-scoped routes and from no tool at
  // any level. `apply` is atomic: the store writes against the frozen base revision, and a routine
  // that moved since is superseded rather than merged over the top.
  std::vector<ProposalHead> proposals(const UserId& user, const ProposalQuery& query);
  std::optional<RoutineProposal> proposal(const UserId& user, const ProposalId& id);
  ProposalMintOutcome propose(const UserId& user, const ProposalWrite& incoming);
  ProposalMintOutcome proposeRemoval(const UserId& user, const ProposalId& id,
                                     const RoutineId& routine, const std::string& summary,
                                     const ProposalSource& source);
  ProposalSettleOutcome apply(const UserId& user, const ProposalId& id);
  ProposalSettleOutcome dismiss(const UserId& user, const ProposalId& id);

private:
  ProgramRepository& program_;
  Clock& clock_;
};

}
