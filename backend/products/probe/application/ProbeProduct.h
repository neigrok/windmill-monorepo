#pragma once

#include "platform/application/sync/SyncCatalog.h"
#include "platform/ports/SyncType.h"
#include "products/probe/ports/ProbeReceipts.h"

#include <map>
#include <memory>
#include <string>

namespace wm::probe {

// The probe product on the engine: its run rule and product commands, written once over the engine's
// reader and the receipts port, so the same rules run over Postgres and over the test fakes.
class ProbeProduct {
public:
  explicit ProbeProduct(ProbeReceipts& receipts);
  ~ProbeProduct();

  // Binds every probe type to its store (by type name) and every probe command to its handler.
  void bindTo(sync::SyncCatalog& catalog, const std::map<std::string, sync::TypeStore*>& stores);

private:
  class RunRules;
  class Start;
  class End;
  class Copy;
  class Tick;
  class Branch;
  class Sprout;
  class Adopt;

  std::unique_ptr<RunRules> runRules_;
  std::unique_ptr<Start> start_;
  std::unique_ptr<End> end_;
  std::unique_ptr<Copy> copy_;
  std::unique_ptr<Tick> tick_;
  std::unique_ptr<Branch> branch_;
  std::unique_ptr<Sprout> sprout_;
  std::unique_ptr<Adopt> adopt_;
};

}
