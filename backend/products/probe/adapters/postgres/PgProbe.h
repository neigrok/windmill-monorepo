#pragma once

#include "platform/adapters/postgres/PgTableType.h"
#include "platform/application/sync/SyncCatalog.h"
#include "platform/domain/sync/Registry.h"
#include "products/probe/application/ProbeProduct.h"
#include "products/probe/ports/ProbeReceipts.h"

#include <memory>
#include <vector>

namespace wm::probe {

// The probe's receipts in probe_start_receipts and probe_copy_receipts (db/probe.sql).
class PgProbeReceipts final : public ProbeReceipts {
public:
  std::optional<std::string> startedRun(sync::SyncTxn&, const sync::ScopeKey& scope, const std::string& called) override;
  void recordStart(sync::SyncTxn&, const sync::ScopeKey& scope, const std::string& called, const std::string& resolved) override;
  std::optional<std::string> copiedFrom(sync::SyncTxn&, const sync::ScopeKey& scope, const std::string& destination) override;
  void recordCopy(sync::SyncTxn&, const sync::ScopeKey& scope, const std::string& destination, const std::string& source) override;
};

// The probe on Postgres: a PgTableType per registry type over db/probe.sql, its receipts, and the product
// that binds them to a catalog. Only the test binaries and windmill_server_probe build it.
class PgProbe {
public:
  explicit PgProbe(const sync::Registry& registry);
  void bindTo(sync::SyncCatalog& catalog);

private:
  PgProbeReceipts receipts_;
  std::vector<std::unique_ptr<sync::PgTableType>> tables_;
  ProbeProduct product_;
};

}
