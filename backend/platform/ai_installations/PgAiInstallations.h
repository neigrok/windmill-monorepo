#pragma once

#include "platform/ai_installations/AiInstallations.h"
#include "platform/adapters/postgres/PgPool.h"

namespace wm {

class PgAiInstallations final : public AiInstallationRepository {
public:
  explicit PgAiInstallations(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}
  std::optional<AiInstallationRow> find(const std::string& tokenDigest) override;
  AiInstallationCode issue(const AiInstallationRow& row, const AiInstallationNetwork& network) override;
  AiInstallationCode admit(const std::string& installationId, const std::string& requestId,
                          const AiInstallationNetwork& network, long long atMs) override;
  void prune(long long atMs) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
