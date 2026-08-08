#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/ports/McpKeyRepository.h"

#include <memory>
#include <string>

namespace wm {

// Postgres-backed personal MCP API keys. Times the domain owns are stored as epoch-millisecond
// bigints and passed through untouched; the token digest is the row's primary key. A per-thread
// connection (PgConnection) backs every call, like the other repositories.
class PgMcpKeyRepository : public McpKeyRepository {
public:
  explicit PgMcpKeyRepository(std::shared_ptr<PgPool> pool);

  std::string insert(const std::string& tokenDigest, const UserId& user, const std::string& name,
                     long long createdMs) override;
  std::vector<McpKeyRow> list(const UserId& user) override;
  bool revoke(const UserId& user, const std::string& id) override;
  std::optional<ActiveKey> findActiveKey(const std::string& tokenDigest, long long nowMs) override;
  void touchUsed(const std::string& tokenDigest, long long nowMs, long long throttleMs) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
