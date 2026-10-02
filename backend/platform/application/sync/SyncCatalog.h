#pragma once

#include "platform/domain/sync/Registry.h"
#include "platform/domain/sync/Scope.h"
#include "platform/ports/SyncType.h"

#include <array>
#include <map>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace wm::sync {

// A binding that does not match the registry: a type or command it does not declare, one bound twice, or
// one left unbound at seal().
struct CatalogError : std::logic_error {
  using std::logic_error::logic_error;
};

// The registry bound to its products (§1.3): a store and optional rules per type, a handler per command.
// Products bind before seal(), which fails boot unless every registry type and command has exactly one
// binding, so a process never admits a type it cannot store.
class SyncCatalog {
public:
  explicit SyncCatalog(const Registry& registry);

  void bindType(TypeStore& store, TypeRules* rules = nullptr);
  void bindCommand(const std::string& name, SyncCommand& command);
  void bindReadiness(const std::string& product, ScopeReadiness& readiness);
  void seal();

  const Registry& registry() const { return registry_; }
  const std::optional<Opening>& opening() const { return opening_; }
  TypeStore& store(const std::string& type) const;
  TypeRules* rules(const std::string& type) const;
  SyncCommand& command(const std::string& name) const;
  void requireReady(SyncTxn& txn, const ScopeKey& scope) const;
  void requireWritable(SyncTxn& txn, const ScopeKey& scope) const;
  std::timed_mutex& scopeMutex(const ScopeKey& scope) const;

  // The registry's types of one scope kind, in registry order.
  std::vector<const TypeDef*> typesIn(const RegistryScope& scope) const;
  // Step 13's order: every type after each type its ref fields and key name. Rows that remain are written
  // in this order, deletions in its reverse (§2.2).
  const std::vector<const TypeDef*>& applyOrder() const { return applyOrder_; }

private:
  struct TypeBinding {
    TypeStore* store = nullptr;
    TypeRules* rules = nullptr;
  };

  void requireSealed() const;

  const Registry& registry_;
  std::optional<Opening> opening_;
  std::map<std::string, TypeBinding> types_;
  std::map<std::string, SyncCommand*> commands_;
  std::map<std::string, ScopeReadiness*> readiness_;
  mutable std::array<std::timed_mutex, 256> scopeMutexes_;
  std::vector<const TypeDef*> applyOrder_;
  bool sealed_ = false;
};

}
