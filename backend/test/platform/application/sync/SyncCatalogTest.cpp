#include "platform/application/sync/SyncCatalog.h"

#include "platform/domain/sync/Jcs.h"
#include "products/probe/ProbeRegistry.h"
#include "test/platform/application/sync/SyncFakes.h"
#include "test/platform/application/sync/SyncWorld.h"
#include "test/testing.h"

#include <memory>
#include <string>
#include <vector>

using namespace wm::sync;

namespace {

// Every probe type bound to a fake store, except those named in `skip`.
struct ProbeStores {
  std::vector<std::unique_ptr<fake::FakeTypeStore>> stores;

  explicit ProbeStores(const Registry& registry) {
    for (const TypeDef& type : registry.types()) stores.push_back(std::make_unique<fake::FakeTypeStore>(type, 0));
  }

  void bindAll(SyncCatalog& catalog, const std::string& skip = "") {
    for (const auto& store : stores) {
      if (store->def().name != skip) catalog.bindType(*store);
    }
  }
};

struct NoCommand final : SyncCommand {
  bool isReplay(CommandCtx&) override { return false; }
  CommandOutcome run(CommandCtx&) override { return {}; }
};

std::string sealError(SyncCatalog& catalog) {
  try {
    catalog.seal();
  } catch (const CatalogError& error) {
    return error.what();
  }
  return "";
}

}

TEST(a_catalog_seals_only_when_every_registry_type_and_command_is_bound) {
  const Registry& registry = wm::probe::registry();
  ProbeStores stores(registry);
  NoCommand command;

  SyncCatalog missingType(registry);
  stores.bindAll(missingType, "lap");
  for (const CommandDef& def : registry.commands()) missingType.bindCommand(def.name, command);
  CHECK_EQ(sealError(missingType), std::string("the registry type lap has no binding"));

  SyncCatalog missingCommand(registry);
  stores.bindAll(missingCommand);
  for (const CommandDef& def : registry.commands()) {
    if (def.name != "probe.tick") missingCommand.bindCommand(def.name, command);
  }
  CHECK_EQ(sealError(missingCommand), std::string("the registry command probe.tick has no binding"));

  SyncCatalog complete(registry);
  stores.bindAll(complete);
  for (const CommandDef& def : registry.commands()) complete.bindCommand(def.name, command);
  CHECK_EQ(sealError(complete), std::string());
}

TEST(a_catalog_refuses_a_binding_the_registry_does_not_declare_or_one_bound_twice) {
  const Registry& registry = wm::probe::registry();
  ProbeStores stores(registry);
  NoCommand command;
  SyncCatalog catalog(registry);
  stores.bindAll(catalog);

  std::string twice;
  try {
    catalog.bindType(*stores.stores.front());
  } catch (const CatalogError& error) {
    twice = error.what();
  }
  CHECK_EQ(twice, std::string("the type board is bound twice"));

  std::string unknown;
  try {
    catalog.bindCommand("probe.fly", command);
  } catch (const CatalogError& error) {
    unknown = error.what();
  }
  CHECK_EQ(unknown, std::string("the registry declares no command probe.fly"));
}

TEST(step_13_writes_a_type_after_every_type_its_fields_and_key_reference) {
  const Registry registry{parseJson(R"({
    "registry": "order", "version": 1, "minVersion": 1,
    "products": {"order": {}},
    "types": [
      {"type": "mark", "scope": "product:order", "identity": "keyed", "key": {"ref": "tag"}, "life": false,
       "origins": ["replica"], "fields": {}},
      {"type": "lap", "scope": "product:order", "identity": "keyed", "idPattern": "^[a-z]{1,8}$", "life": false,
       "origins": ["replica"], "fields": {"runId": {"kind": "lww", "writer": "client", "ref": "run"}}},
      {"type": "tag", "scope": "product:order", "identity": "keyed", "idPattern": "^[a-z]{1,8}$", "life": false,
       "origins": ["replica"], "fields": {}},
      {"type": "run", "scope": "product:order", "identity": "keyed", "idPattern": "^[a-z]{1,8}$", "life": false,
       "origins": ["replica"], "fields": {"parentId": {"kind": "lww", "writer": "client", "ref": "run"}}}
    ],
    "commands": []
  })")};
  ProbeStores stores(registry);
  SyncCatalog catalog(registry);
  stores.bindAll(catalog);
  catalog.seal();

  std::vector<std::string> order;
  for (const TypeDef* type : catalog.applyOrder()) order.push_back(type->name);
  CHECK_EQ(order, (std::vector<std::string>{"tag", "mark", "run", "lap"}));
}
