#include "products/gym/application/ProgramService.h"

namespace wm::gym {

ProgramService::ProgramService(ProgramRepository& program, GymWriteDoor& door)
    : program_(program), door_(door) {}

std::optional<Routine> ProgramService::routineCreation(const UserId& user, const RoutineId& id) {
  return program_.routineCreation(user, id);
}

std::vector<Routine> ProgramService::routines(const UserId& user) {
  return program_.routines(user);
}

std::optional<Routine> ProgramService::routine(const UserId& user, const RoutineId& id) {
  return program_.routine(user, id);
}

std::vector<RoutineEvent> ProgramService::routineHistory(const UserId& user, const RoutineId& id) {
  return program_.routineHistory(user, id);
}

// The entity's constructor is the entire validation (throwing InvalidTraining) and the door's outcome
// the entire refusal set. The create's idempotency is the id, not a lookup.
RoutineWriteOutcome ProgramService::createRoutine(const UserId& user, const RoutineWrite& incoming,
                                                  std::optional<ProposalDoor> byAgent) {
  return door_.createRoutine(Routine{incoming.id, user, incoming.name, incoming.position, incoming.entries}, byAgent);
}

std::vector<ProposalHead> ProgramService::proposals(const UserId& user, const ProposalQuery& query) {
  return program_.proposalHeads(user, query);
}

std::optional<RoutineProposal> ProgramService::proposal(const UserId& user, const ProposalId& id) {
  return program_.proposal(user, id);
}

ProposalMintOutcome ProgramService::propose(const UserId& user, const ProposalWrite& incoming) {
  return door_.propose(user, incoming);
}

// No document to build: the whole plan leaves, so every line of it is a removed row.
ProposalMintOutcome ProgramService::proposeRemoval(const UserId& user, const ProposalId& id,
                                                   const RoutineId& routine,
                                                   const std::string& summary,
                                                   const ProposalSource& source) {
  return door_.proposeRemoval(user, id, routine, summary, source);
}

}
