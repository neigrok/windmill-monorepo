#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/journal/ports/JournalRepository.h"

#include <memory>
#include <string>

namespace wm {

// Journal storage over Postgres: one guarded upsert per write, every query scoped to the owner.
// Stateless but for the connection string — each method opens a pqxx::work on the thread-local
// connection (platform/adapters/postgres/PgConnection.h). The LWW guard lives in the upsert's
// trailing WHERE (EXCLUDED.stamp > stored.stamp); a superseded non-empty body is copied into
// journal_page_revision in the same transaction, and that trail is BOUNDED in the same transaction
// too (kRevisionsPerDay / kRevisionsPerUser / kRevisionBytesPerUser / kRevisionRetentionDays in the
// .cpp) — an append-only table nothing prunes is a table any account can fill.
class PgJournalRepository : public JournalRepository {
public:
  explicit PgJournalRepository(std::shared_ptr<PgPool> pool);

  std::optional<Page> load(const UserId& user, const LocalDate& day) override;
  std::vector<Page> range(const UserId& user, const LocalDate& from, const LocalDate& to) override;
  std::vector<Page> since(const UserId& user, const Hlc& cursor, int limit) override;
  std::vector<Page> all(const UserId& user) override;
  PageWrite save(const Page& incoming) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
