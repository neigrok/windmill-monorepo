#include "platform/application/sync/SyncCatalog.h"

#include "platform/domain/sync/Restore.h"

#include <algorithm>
#include <functional>
#include <set>

namespace wm::sync {

namespace {
class Capture final : public SyncCommand {
public:
  bool isReplay(CommandCtx&) override { return false; }
  CommandOutcome run(CommandCtx&) override { return {}; }
};

// §6.4 restore: each operation holds or skips on its own condition, and those that hold write back their
// earlier values as the command's own deltas, under the stamp step 9 mints.
class Restore final : public SyncCommand {
public:
  bool isReplay(CommandCtx&) override { return false; }

  CommandOutcome run(CommandCtx& ctx) override {
    const RestoreReader read{
        .stored = [&](const std::string& type, const RecordId& id) { return ctx.read.lock(type, id).stored; },
        .absent = [&](const std::string& type, const RecordId& id) { return ctx.read.lock(type, id).state.kind == IdState::Kind::none; },
    };
    RestoreOutcome restored = evaluateRestore(ctx.registry, read, ctx.args, ctx.epoch);
    Json::Value detail(Json::objectValue);
    detail["inverse"]["outcomes"] = std::move(restored.outcomes);
    return CommandOutcome{.deltas = std::move(restored.deltas), .detail = std::move(detail)};
  }
};
}

SyncCatalog::SyncCatalog(const Registry& registry)
    : registry_(registry), opening_(openingOf(registry)), capture_(std::make_unique<Capture>()), restore_(std::make_unique<Restore>()) {
  for (const CommandDef& command : registry.commands()) {
    if (command.engine == EngineCommand::capture) commands_.emplace(command.name, capture_.get());
    if (command.engine == EngineCommand::restore) commands_.emplace(command.name, restore_.get());
  }
}

void SyncCatalog::bindType(TypeStore& store, TypeRules* rules) {
  if (sealed_) throw CatalogError("a sync type was bound after the catalog was sealed");
  const std::string& name = store.def().name;
  if (!registry_.type(name)) throw CatalogError("the registry declares no type " + name);
  if (!types_.emplace(name, TypeBinding{&store, rules}).second) throw CatalogError("the type " + name + " is bound twice");
}

void SyncCatalog::bindCommand(const std::string& name, SyncCommand& command) {
  if (sealed_) throw CatalogError("a sync command was bound after the catalog was sealed");
  if (!registry_.command(name)) throw CatalogError("the registry declares no command " + name);
  if (!commands_.emplace(name, &command).second) throw CatalogError("the command " + name + " is bound twice");
}

void SyncCatalog::seal() {
  for (const TypeDef& type : registry_.types()) {
    if (!types_.contains(type.name)) throw CatalogError("the registry type " + type.name + " has no binding");
  }
  for (const CommandDef& command : registry_.commands()) {
    if (!commands_.contains(command.name)) throw CatalogError("the registry command " + command.name + " has no binding");
  }

  std::set<std::string> placed;
  std::set<std::string> visiting;
  std::function<void(const TypeDef&)> place = [&](const TypeDef& type) {
    if (placed.contains(type.name) || !visiting.insert(type.name).second) return;
    std::vector<std::string> referenced;
    for (const auto& [fieldName, field] : type.fields) {
      if (field.ref) referenced.push_back(*field.ref);
    }
    if (type.keyRef) referenced.push_back(*type.keyRef);
    for (const KeyPart& part : type.keyTuple) referenced.push_back(part.ref);
    for (const std::string& name : referenced) {
      if (name != type.name) place(*registry_.type(name));
    }
    placed.insert(type.name);
    applyOrder_.push_back(&type);
  };
  for (const TypeDef& type : registry_.types()) place(type);
  sealed_ = true;
}

void SyncCatalog::requireSealed() const {
  if (!sealed_) throw CatalogError("the sync catalog is used before it is sealed");
}

TypeStore& SyncCatalog::store(const std::string& type) const {
  requireSealed();
  return *types_.at(type).store;
}

TypeRules* SyncCatalog::rules(const std::string& type) const {
  requireSealed();
  return types_.at(type).rules;
}

SyncCommand& SyncCatalog::command(const std::string& name) const {
  requireSealed();
  return *commands_.at(name);
}

std::string SyncCatalog::commandOperation(const std::string& name) const {
  requireSealed();
  const auto bound = commands_.find(name);
  return bound == commands_.end() ? "sync.command.unknown" : "sync.command." + bound->first;
}

std::string SyncCatalog::observationProduct(const RegistryScope& scope) const {
  if (scope.kind == ScopeKind::product) return registry_.products().contains(scope.product) ? scope.product : "platform";
  const TypeDef* governing = registry_.governingType();
  return governing ? governing->scope.product : "platform";
}

std::string SyncCatalog::observationProduct(const Json::Value& intent, const UserId& caller) const {
  if (!intent.isObject() || !intent["scope"].isString()) return "platform";
  const std::optional<ScopeKey> scope = resolve(registry_, intent["scope"].asString(), caller);
  return scope ? observationProduct(scope->registryScope()) : "platform";
}

std::string SyncCatalog::observationOutcome(const Json::Value& result) const {
  if (!result.isObject() || !result["s"].isString()) return "failed";
  if (result["s"].asString() == "ok") return "ok";
  if (!result["code"].isString()) return "failed";
  const std::string refusal = result["code"].asString();
  if (code::isEngine(refusal)) return refusal == code::internal ? "failed" : refusal;
  for (const auto& [name, product] : registry_.products()) {
    if (std::find(product.codes.begin(), product.codes.end(), refusal) != product.codes.end()) return refusal;
  }
  return "failed";
}

std::timed_mutex& SyncCatalog::scopeMutex(const ScopeKey& scope) const {
  return scopeMutexes_[std::hash<std::string>{}(scope.text()) % scopeMutexes_.size()];
}

std::timed_mutex& SyncCatalog::ownerMutex(const UserId& owner) const {
  std::lock_guard lock(ownerMutexesLock_);
  auto& gate = ownerMutexes_[owner.str()];
  if (!gate) gate = std::make_unique<std::timed_mutex>();
  return *gate;
}

std::vector<const TypeDef*> SyncCatalog::typesIn(const RegistryScope& scope) const {
  std::vector<const TypeDef*> types;
  for (const TypeDef& type : registry_.types()) {
    if (type.scope == scope) types.push_back(&type);
  }
  return types;
}

}
