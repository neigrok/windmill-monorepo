#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/journal/ports/JournalRepository.h"

#include <memory>
#include <string>

namespace wm {

// The pages as the engine stores them, read; every query is scoped to the owner.
class PgJournalRepository : public JournalRepository {
public:
  explicit PgJournalRepository(std::shared_ptr<PgPool> pool);

  std::optional<Page> load(const UserId& user, const LocalDate& day) override;
  std::vector<Page> range(const UserId& user, const LocalDate& from, const LocalDate& to) override;
  std::vector<Page> since(const UserId& user, const Hlc& cursor, int limit) override;
  std::vector<Page> all(const UserId& user) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
