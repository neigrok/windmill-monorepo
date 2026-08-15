#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/ports/ProgramRepository.h"

#include <memory>

namespace wm::gym {

// The program over Postgres: routines as one document over two tables, and the proposal ledger
// against them, in one adapter because they are written in one transaction — replaceRoutine
// supersedes every pending proposal on the routine it rewrites, applyRevision rewrites the routine
// a proposal was frozen against. Idempotent writes by client-minted id (insertRoutine over two tables
// in one transaction, insertProposal over two more), every query scoped to the owner, and ONE lock
// order for every write here: the routine row first, its lines and its proposals after. Stateless
// but for the pool — each method borrows a connection for exactly one transaction
// (platform/adapters/postgres/PgPool.h). Every pqxx error the store has an answer for is translated
// here into the port's typed facts; the rest ride to the house 500.
//
// The port seam is not table ownership: a routine line and a proposal line are checked against the
// catalog's visibility predicate (PgGymRows.h) before they land, `loadProposal` LEFT JOINs gym_sets
// to count the sets a removed line keeps, and kRoutineColumns reads lastTrainedAtMs off
// gym_sessions. The tables this file WRITES are the program's alone — what the schema cascades from
// them when a routine goes (its sessions' routine_id set null) is the schema's doing, not a
// statement here.
class PgProgramRepository : public ProgramRepository {
public:
  explicit PgProgramRepository(std::shared_ptr<PgPool> pool);

  std::vector<Routine> routines(const UserId& user) override;
  std::optional<Routine> routine(const UserId& user, const RoutineId& id) override;
  std::vector<RoutineEvent> routineHistory(const UserId& user, const RoutineId& id) override;
  RoutineWriteOutcome insertRoutine(const Routine& incoming, std::optional<ProposalDoor> byAgent,
                                    std::uint64_t nowMs) override;
  RoutineWriteOutcome replaceRoutine(const Routine& incoming, std::uint64_t nowMs,
                                     std::optional<int> expectedRevision) override;
  bool deleteRoutine(const UserId& user, const RoutineId& id) override;
  std::vector<ProposalHead> proposalHeads(const UserId& user, const ProposalQuery& query) override;
  std::optional<RoutineProposal> proposal(const UserId& user, const ProposalId& id) override;
  ProposalMintOutcome insertProposal(const RoutineProposal& incoming) override;
  ProposalSettleOutcome applyRevision(const UserId& user, const ProposalId& id,
                                      const Routine& becomes, std::uint64_t nowMs) override;
  ProposalSettleOutcome applyRemoval(const UserId& user, const ProposalId& id,
                                     std::uint64_t nowMs) override;
  ProposalSettleOutcome dismissProposal(const UserId& user, const ProposalId& id,
                                        std::uint64_t nowMs) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
