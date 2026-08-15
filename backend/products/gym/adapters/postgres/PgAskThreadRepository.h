#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/ports/AskThreadRepository.h"

#include <memory>
#include <string>

namespace wm::gym {

// Ask's threads over Postgres (§O): the conversation row and its turns. Owner-scoped like every gym
// read, and openThread is the one write here that must tell absent from another account's — it
// says why at ThreadOpenError. Stateless but for the pool — each method borrows a connection for
// exactly one transaction (platform/adapters/postgres/PgPool.h).
//
// The port seam is not table ownership: a thread's `minted` is read off gym_proposals joined to
// gym_routines as they stand today, and a deleted thread leaves its proposals standing with
// thread_id set null by the schema. The tables this file WRITES are Ask's alone.
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
