#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/ports/AskThreadRepository.h"

#include <memory>
#include <string>

namespace wm::gym {

// Owner-scoped; openThread is the one write here that must tell absent from another account's. Each
// method borrows a connection for exactly one transaction. A thread's `minted` is read off
// gym_proposals joined to gym_routines, and deleting a thread leaves its proposals standing with
// thread_id set null by the schema.
class PgAskThreadRepository : public AskThreadRepository {
public:
  explicit PgAskThreadRepository(std::shared_ptr<PgPool> pool);

  std::vector<AskThread> threads(const UserId& user) override;
  std::vector<AskThread> allThreads(const UserId& user) override;
  std::optional<AskThread> thread(const UserId& user, const ThreadId& id) override;
  ThreadOpenOutcome openThread(const UserId& user, const ThreadId& id, const std::string& title,
                               std::uint64_t nowMs) override;
  void appendTurns(const UserId& user, const ThreadId& id,
                   const std::vector<ThreadTurn>& turns) override;
  void discardEmptyThread(const UserId& user, const ThreadId& id) override;
  bool deleteThread(const UserId& user, const ThreadId& id) override;
  std::vector<ExportedThreadTurn> exportedThreadTurns(const UserId& user) override;


private:
  std::shared_ptr<PgPool> pool_;
};

}
