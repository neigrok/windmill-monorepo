#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/ports/ProgramRepository.h"

#include <memory>

namespace wm::gym {

// Routines as one document over two tables, plus the proposal ledger against them, read. Every query is
// scoped to the owner, and each method borrows a connection for exactly one transaction.
class PgProgramRepository : public ProgramRepository {
public:
  explicit PgProgramRepository(std::shared_ptr<PgPool> pool);

  std::optional<Routine> routineCreation(const UserId& user, const RoutineId& id) override;
  std::vector<Routine> routines(const UserId& user) override;
  std::optional<Routine> routine(const UserId& user, const RoutineId& id) override;
  std::vector<RoutineEvent> routineHistory(const UserId& user, const RoutineId& id) override;
  std::vector<ProposalHead> proposalHeads(const UserId& user, const ProposalQuery& query) override;
  std::optional<RoutineProposal> proposal(const UserId& user, const ProposalId& id) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
