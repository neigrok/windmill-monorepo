#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/ports/BodyweightRepository.h"

#include <memory>

namespace wm::gym {

// One row per (account, local day) — the primary key is the identity, so the write is one upsert
// whose UPDATE arm is guarded by the instant: `ON CONFLICT … DO UPDATE … WHERE stored.recorded_at
// <= incoming.recorded_at`. The row lock the conflict takes is the whole concurrency story; two
// writes to one day serialize and the later instant stands whichever lands second. Each method
// borrows a connection for exactly one transaction. The day crosses as text on both sides
// (`::date` in, `::text` out): the pqxx date readers differ between the macOS and CI Linux builds.
class PgBodyweightRepository : public BodyweightRepository {
public:
  explicit PgBodyweightRepository(std::shared_ptr<PgPool> pool);

  std::vector<Bodyweight> entries(const UserId& user, const BodyweightRange& range) override;
  std::optional<Bodyweight> latest(const UserId& user) override;
  Bodyweight save(const Bodyweight& incoming) override;
  void remove(const UserId& user, const std::string& dateLocal) override;
  std::vector<ExportedBodyweight> exported(const UserId& user) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
