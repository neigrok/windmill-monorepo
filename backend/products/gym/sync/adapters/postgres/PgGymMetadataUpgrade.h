#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/domain/sync/Record.h"
#include "platform/ports/SyncStore.h"

#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <vector>

namespace wm::gym::engine {

struct MetadataUpgradeError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

class PgGymMetadataUpgrade {
public:
  explicit PgGymMetadataUpgrade(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}
  std::vector<Json::Value> run(std::optional<sync::Ms> migrationTime = std::nullopt,
                             std::optional<std::string> account = std::nullopt,
                             const std::function<void(const Json::Value&)>& onAccount = {});
  std::vector<Json::Value> audit(std::optional<std::string> account = std::nullopt,
                               bool testCorruptions = false);
  static void requireComplete(sync::SyncTxn&);

private:
  std::shared_ptr<PgPool> pool_;
};

}
