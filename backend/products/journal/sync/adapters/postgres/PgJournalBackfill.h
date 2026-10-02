#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/domain/sync/Record.h"
#include "platform/ports/SyncStore.h"

#include <memory>
#include <optional>
#include <vector>

namespace wm::journal::engine {

class PgJournalBackfill {
public:
  explicit PgJournalBackfill(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}
  std::vector<Json::Value> run(sync::Ms migrationTime, bool dryRun = false,
      std::optional<std::string> account = std::nullopt,
      const std::string& firstRunPolicy = "retire-existing",
      std::optional<Json::Value> frozenInput = std::nullopt);
  std::vector<Json::Value> audit(std::optional<std::string> account = std::nullopt);

private:
  std::shared_ptr<PgPool> pool_;
};

}
