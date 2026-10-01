#pragma once

#include "platform/application/sync/SyncCatalog.h"
#include "products/gym/sync/ports/GymState.h"

#include <memory>

namespace wm::gym::engine {

class GymProduct {
public:
  explicit GymProduct(GymState& state);
  ~GymProduct();
  void bindTo(sync::SyncCatalog&, const std::map<std::string, sync::TypeStore*>& stores);

private:
  class Rules;
  class Command;
  std::unique_ptr<Rules> rules_;
  std::vector<std::unique_ptr<Command>> commands_;
};

}
