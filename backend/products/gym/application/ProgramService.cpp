#include "products/gym/application/ProgramService.h"

#include <utility>

namespace wm::gym {

ProgramService::ProgramService(ProgramRepository& program, Clock& clock)
    : program_(program), clock_(clock) {}

std::vector<Routine> ProgramService::routines(const UserId& user) {
  return program_.routines(user);
}

std::optional<Routine> ProgramService::routine(const UserId& user, const RoutineId& id) {
  return program_.routine(user, id);
}

std::vector<RoutineEvent> ProgramService::routineHistory(const UserId& user, const RoutineId& id) {
  return program_.routineHistory(user, id);
}

// The entity's constructor is the entire validation (throwing InvalidTraining) and the store's
// outcome the entire refusal set. The create's idempotency is the id, not a lookup.
RoutineWriteOutcome ProgramService::createRoutine(const UserId& user, const RoutineWrite& incoming,
                                                  std::optional<ProposalDoor> byAgent) {
  return program_.insertRoutine(
      Routine{incoming.id, user, incoming.name, incoming.position, incoming.entries}, byAgent,
      clock_.nowMs());
}

RoutineWriteOutcome ProgramService::replaceRoutine(const UserId& user, const RoutineId& id,
                                                   const RoutineWrite& incoming) {
  return program_.replaceRoutine(Routine{id, user, incoming.name, incoming.position, incoming.entries},
                                 clock_.nowMs(), incoming.expectedRevision);
}

bool ProgramService::deleteRoutine(const UserId& user, const RoutineId& id) {
  return program_.deleteRoutine(user, id);
}

std::vector<ProposalHead> ProgramService::proposals(const UserId& user, const ProposalQuery& query) {
  return program_.proposalHeads(user, query);
}

std::optional<RoutineProposal> ProgramService::proposal(const UserId& user, const ProposalId& id) {
  return program_.proposal(user, id);
}

// The document goes through the Routine constructor and is thrown away: its only job is to refuse
// what a plan cannot hold, at the mint rather than at the tap. Nothing here writes to the program.
ProposalMintOutcome ProgramService::propose(const UserId& user, const ProposalWrite& incoming) {
  std::optional<Routine> base = program_.routine(user, incoming.routine);
  if (!base) return {std::nullopt, ProposalMintError::unknownRoutine};

  const std::string name = incoming.name.value_or(base->name);
  const Routine becomes{base->id, base->user, name, base->position, incoming.entries};
  std::vector<RoutineChange> changes = changesBetween(base->entries, becomes.entries);
  const int counted = countedChanges(base->entries, changes, base->name, becomes.name);
  // A document identical to what the routine already says proposes nothing; the same lines in a
  // different ORDER is a change.
  if (counted == 0) return {std::nullopt, ProposalMintError::noChange};
  const ProposalHead head{incoming.id,
                          base->id,
                          user,
                          ProposalIntent::revise,
                          ProposalState::pending,
                          incoming.source,
                          incoming.summary,
                          counted,
                          clock_.nowMs(),
                          std::nullopt};
  return program_.insertProposal(
      RoutineProposal{head, base->revision, base->name, becomes.name, std::move(changes)});
}

// No document to build: the whole plan leaves, so every line of it is a removed row.
ProposalMintOutcome ProgramService::proposeRemoval(const UserId& user, const ProposalId& id,
                                                   const RoutineId& routine,
                                                   const std::string& summary,
                                                   const ProposalSource& source) {
  std::optional<Routine> base = program_.routine(user, routine);
  if (!base) return {std::nullopt, ProposalMintError::unknownRoutine};

  std::vector<RoutineChange> changes = changesBetween(base->entries, {});
  const ProposalHead head{id,
                          base->id,
                          user,
                          ProposalIntent::remove,
                          ProposalState::pending,
                          source,
                          summary,
                          static_cast<int>(changes.size()),
                          clock_.nowMs(),
                          std::nullopt};
  return program_.insertProposal(
      RoutineProposal{head, base->revision, base->name, base->name, std::move(changes)});
}

// The store's own revision check refuses the whole apply if the routine moved between the load and
// the write. A removal has no document to compute and takes the store's other verb. The intent is
// read off the proposal, never off the caller.
ProposalSettleOutcome ProgramService::apply(const UserId& user, const ProposalId& id) {
  std::optional<RoutineProposal> held = program_.proposal(user, id);
  if (!held) return {std::nullopt, std::nullopt, ProposalSettleError::notFound};
  const std::uint64_t nowMs = clock_.nowMs();
  if (held->head.intent == ProposalIntent::remove) return program_.applyRemoval(user, id, nowMs);

  std::optional<Routine> base = program_.routine(user, held->head.routine);
  // The routine went between the two reads: nothing to apply to.
  if (!base) return {std::nullopt, std::nullopt, ProposalSettleError::notFound};
  // Every remaining decision is the STORE's, under its own lock: a proposal already settled (a
  // replayed tap reads back what it did; the other decision is refused), and a base that has moved
  // since the mint (superseded).
  return program_.applyRevision(user, id, appliedTo(*base, *held), nowMs);
}

ProposalSettleOutcome ProgramService::dismiss(const UserId& user, const ProposalId& id) {
  return program_.dismissProposal(user, id, clock_.nowMs());
}

}
