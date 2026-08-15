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

// Both routine writes are one construction and one call, and that is the whole point of the shape:
// the entity's constructor is the entire validation (it throws InvalidTraining, which the wire
// turns into a 400), and the store's outcome is the entire refusal set. Neither write reads before
// it writes — a load-then-decide here would be a race the SQL already settles, and the create's
// idempotency is the id, not a lookup: a create that lost its reply and was sent again reads back
// the STORED routine untouched, exactly as a replayed start does.
RoutineWriteOutcome ProgramService::createRoutine(const UserId& user, const RoutineWrite& incoming,
                                                  std::optional<ProposalDoor> byAgent) {
  return program_.insertRoutine(
      Routine{incoming.id, user, incoming.name, incoming.position, incoming.entries}, byAgent,
      clock_.nowMs());
}

RoutineWriteOutcome ProgramService::replaceRoutine(const UserId& user, const RoutineId& id,
                                                   const RoutineWrite& incoming) {
  return program_.replaceRoutine(
      Routine{id, user, incoming.name, incoming.position, incoming.entries}, clock_.nowMs());
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

// The mint, as an ordered pipeline that reads top to bottom: load the routine this is about, build
// the document it would become, diff it against what stands, store the diff against that revision.
//
// The document is built through the Routine CONSTRUCTOR and thrown away — its only job is to refuse
// what a plan cannot hold, here, at the mint, rather than at the tap. A proposal a lifter reads and
// cannot apply is worse than no proposal, because the refusal arrives at the one moment they have
// already decided to trust it.
//
// Nothing here writes to the program, and there is no branch in this method that could: it hands
// the store a proposal and the store has no verb that touches gym_routines.
ProposalMintOutcome ProgramService::propose(const UserId& user, const ProposalWrite& incoming) {
  std::optional<Routine> base = program_.routine(user, incoming.routine);
  if (!base) return {std::nullopt, ProposalMintError::unknownRoutine};

  const std::string name = incoming.name.value_or(base->name);
  const Routine becomes{base->id, base->user, name, base->position, incoming.entries};
  std::vector<RoutineChange> changes = changesBetween(base->entries, becomes.entries);
  const int counted = countedChanges(base->entries, changes, base->name, becomes.name);
  // A document identical to what the routine already says proposes nothing, and a card reading
  // `Apply all 0` is a notification about nothing in an app that has no notifications on purpose.
  // Identical means identical top to bottom: the same lines in a different ORDER is a change, and
  // the count above is what knows it — a day is trained down the page.
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

// The other intent, and the same pipeline with no document to build: the whole plan is what leaves,
// so every line of it is a removed row and the diff screen draws exactly what goes.
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

// The tap. Load the proposal, load the routine it is about, let the domain say what the routine
// becomes, and write that — three phases, and the store's own revision check is the fourth party
// nobody has to remember: a routine that moved between the load and the write refuses the whole
// apply rather than landing half of it.
//
// A removal has no document to compute, so it takes the store's other verb. The intent is read off
// the proposal and never off the caller, because the caller is a lifter tapping one button.
ProposalSettleOutcome ProgramService::apply(const UserId& user, const ProposalId& id) {
  std::optional<RoutineProposal> held = program_.proposal(user, id);
  if (!held) return {std::nullopt, std::nullopt, ProposalSettleError::notFound};
  const std::uint64_t nowMs = clock_.nowMs();
  if (held->head.intent == ProposalIntent::remove) return program_.applyRemoval(user, id, nowMs);

  std::optional<Routine> base = program_.routine(user, held->head.routine);
  // The routine went between the two reads — a delete of the plan. Nothing to apply to, and the
  // same fact as a proposal that names nothing.
  if (!base) return {std::nullopt, std::nullopt, ProposalSettleError::notFound};
  // Every remaining decision is the STORE's, taken under its own lock, because only a lock decides
  // a race: a proposal already settled (a replayed tap reads back what it did; the other decision
  // is refused), and a base that has moved since the mint (superseded — merging a diff over a
  // document it no longer describes is the one thing this ledger exists to refuse). Deciding any of
  // them here as well would be one fact decided in two layers, which is how they come to be decided
  // in two orders. The document is computed from the base for the one case that writes it, and is
  // simply not read in any other.
  return program_.applyRevision(user, id, appliedTo(*base, *held), nowMs);
}

ProposalSettleOutcome ProgramService::dismiss(const UserId& user, const ProposalId& id) {
  return program_.dismissProposal(user, id, clock_.nowMs());
}

}
