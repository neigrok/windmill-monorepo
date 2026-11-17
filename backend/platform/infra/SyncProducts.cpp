#include "platform/infra/SyncProducts.h"

#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/RegistryComposition.h"
#include "products/gym/sync/GymProduct.h"
#include "products/gym/sync/PgGym.h"
#include "products/journal/sync/JournalProduct.h"
#include "products/journal/sync/PgJournal.h"

namespace wm::sync {

const Registry& productRegistry() {
  static const Registry registry([] {
    const auto composition = parseJson(compositionText());
    const std::map<std::string, Json::Value> documents{
        {"gym.registry.json", parseJson(gym::engine::registryText())},
        {"journal.registry.json", parseJson(journal::engine::registryText())}};
    return composeRegistry(composition, documents);
  }());
  return registry;
}

std::shared_ptr<SyncCatalog> productCatalog() {
  struct Products {
    SyncCatalog catalog{productRegistry()};
    gym::engine::PgGym gym{productRegistry()};
    journal::engine::PgJournal journal{productRegistry()};
    Products() {
      gym.bindTo(catalog);
      journal.bindTo(catalog);
      catalog.seal();
    }
  };
  auto products = std::make_shared<Products>();
  return std::shared_ptr<SyncCatalog>(products, &products->catalog);
}

}
