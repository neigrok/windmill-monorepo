#include "platform/infra/SyncProducts.h"

#include "platform/domain/sync/Jcs.h"
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
    Json::Value joined(Json::objectValue);
    joined["registry"] = composition["composition"];
    joined["products"] = Json::Value(Json::objectValue);
    joined["types"] = Json::Value(Json::arrayValue);
    joined["commands"] = Json::Value(Json::arrayValue);
    for (const auto& file : composition["registries"]) {
      const auto& document = documents.at(file.asString());
      if (joined.isMember("version") && (joined["version"] != document["version"] || joined["minVersion"] != document["minVersion"]))
        throw RegistryError("composition registries disagree on version");
      joined["version"] = document["version"];
      joined["minVersion"] = document["minVersion"];
      for (const auto& name : document["products"].getMemberNames()) {
        if (joined["products"].isMember(name)) throw RegistryError("composition repeats product " + name);
        joined["products"][name] = document["products"][name];
      }
      for (const char* kind : {"types", "commands"})
        for (const auto& definition : document[kind]) joined[kind].append(definition);
    }
    return joined;
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
