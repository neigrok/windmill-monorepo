#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/ports/ProgramRepository.h"

#include <memory>

namespace wm::gym {

// Routines as one document over two tables, plus the proposal ledger against them; they are written
// in one transaction. Idempotent writes by client-minted id, every query scoped to the owner, and one
// lock order for every write here: the routine row first, its lines and its proposals after. Each
// method borrows a connection for exactly one transaction. Every pqxx error the store has an answer
// for is translated into the port's typed facts; the rest ride to the house 500.
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
