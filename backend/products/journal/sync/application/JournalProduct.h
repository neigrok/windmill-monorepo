#pragma once

#include "platform/application/sync/SyncCatalog.h"
#include "products/journal/sync/ports/JournalState.h"

#include <memory>

namespace wm::journal::engine {

class JournalProduct {
public:
  explicit JournalProduct(JournalState&);
  ~JournalProduct();
  void bindTo(sync::SyncCatalog&, const std::map<std::string, sync::TypeStore*>& stores);

private:
  class Rules;
  class Command;
  std::unique_ptr<Rules> rules_;
  std::vector<std::unique_ptr<Command>> commands_;
};

}
