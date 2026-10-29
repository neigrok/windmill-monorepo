#include "platform/adapters/postgres/PgPool.h"
#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/adapters/sentry/ObservedTool.h"
#include "platform/application/sync/DigestResum.h"
#include "platform/domain/sync/Wire.h"
#include "platform/infra/SyncProducts.h"

#include <cstdio>
#include <cstdlib>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

// Rewrites every alive scope's digest from its feed (§6.12), one transaction per scope. Run once after a
// deploy whose registry dropped or renamed a lattice field; a second run moves nothing.
int main() {
  using namespace wm;
  using namespace wm::sync;
  installToolObservability(true);
  ObservabilityLifetime lifetime;
  WriteObservation observation("sync.digest.resum", "platform", "tool");
  try {
    const char* url = std::getenv("DATABASE_URL");
    if (!url || !*url) {
      observation.finish("configuration-unavailable");
      return 2;
    }
    setenv("PGCONNECT_TIMEOUT", "10", 0);
    const std::shared_ptr<PgPool> pool = std::make_shared<PgPool>(url, 1);
    std::vector<ScopeKey> keys;
    {
      PgLease conn{*pool};
      pqxx::read_transaction txn{*conn};
      for (const auto& row : txn.exec("select key from sync_scopes where state = 'alive' order by key collate \"C\"")) {
        const std::optional<ScopeKey> key = ScopeKey::parse(row[0].as<std::string>());
        if (!key) throw std::runtime_error("sync_scopes holds a key no scope kind parses");
        keys.push_back(*key);
      }
    }
    const std::shared_ptr<SyncCatalog> catalog = productCatalog();
    PgSyncStore store(pool, Limits{}.lockTimeoutMs);
    DigestResum resum(*catalog, store);
    std::size_t seen = 0;
    std::size_t moved = 0;
    for (const ScopeKey& key : keys) {
      const std::optional<Resum> outcome = resum.resum(key);
      if (!outcome) continue;
      ++seen;
      if (outcome->moved()) ++moved;
    }
    std::printf("scopes seen %zu, digests moved %zu\n", seen, moved);
    observation.finish();
    return 0;
  } catch (const std::exception& error) {
    observation.fail(error);
    return 1;
  } catch (...) {
    observation.failUnknown();
    return 1;
  }
}
