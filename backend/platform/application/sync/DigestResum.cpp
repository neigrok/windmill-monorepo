#include "platform/application/sync/DigestResum.h"

#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace wm::sync {

DigestResum::DigestResum(const SyncCatalog& catalog, SyncStore& store) : catalog_(catalog), store_(store) {}

std::optional<Resum> DigestResum::resum(const ScopeKey& key) {
  const std::unique_ptr<SyncTxn> txn = store_.begin(TxnMode::write);
  std::optional<ScopeRow> scope = store_.scope(*txn, key, RowLock::update);
  if (!scope || scope->dead) return std::nullopt;
  const std::vector<const TypeDef*> types = catalog_.typesIn(key.registryScope());
  if (types.empty()) throw std::runtime_error("the catalog declares no type of scope " + key.text() + ": nothing to sum");
  std::vector<Json::Value> rows;
  for (const TypeDef* type : types) {
    for (const Row& row : catalog_.store(type->name).feed(*txn, key, FeedQuery{})) rows.push_back(row.toJson());
  }
  const Resum resum{scope->digest, scopeDigest(rows)};
  if (!resum.moved()) return resum;
  scope->digest = resum.summed;
  store_.saveScope(*txn, *scope);
  txn->commit();
  return resum;
}

}
