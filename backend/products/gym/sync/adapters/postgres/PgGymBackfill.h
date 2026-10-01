#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/domain/sync/Record.h"

#include <memory>
#include <functional>
#include <optional>
#include <vector>

namespace wm::gym::engine {

class PgGymBackfill {
public:
  explicit PgGymBackfill(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}
  std::vector<Json::Value> run(sync::Ms migrationTime, bool dryRun = false,
                             std::optional<std::string> account = std::nullopt,
                             const std::function<void(const Json::Value&)>& onAccount = {});
  std::vector<Json::Value> audit(std::optional<std::string> account = std::nullopt);

private:
  std::shared_ptr<PgPool> pool_;
};

}
