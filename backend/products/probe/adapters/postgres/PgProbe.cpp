#include "products/probe/adapters/postgres/PgProbe.h"

#include "platform/adapters/postgres/PgSyncStore.h"

#include <map>
#include <stdexcept>

namespace wm::probe {

using sync::SqlType;
using sync::TableMap;

namespace {

TableMap tableOf(const std::string& type) {
  static const std::map<std::string, TableMap> tables{
      {"board", {"probe_boards", {}}},
      {"card",
       {"probe_cards",
        {{"title", SqlType::text},
         {"body", SqlType::text},
         {"ord", SqlType::text},
         {"size", SqlType::float8},
         {"claim", SqlType::text},
         {"tier", SqlType::text},
         {"attachment", SqlType::jsonb}}}},
      {"run", {"probe_runs", {{"startedAt", SqlType::bigint}, {"label", SqlType::text}, {"endedAt", SqlType::bigint}}}},
      {"lap", {"probe_laps", {{"runId", SqlType::text}, {"no", SqlType::bigint}, {"at", SqlType::bigint}, {"weight", SqlType::float8}}}},
      {"day", {"probe_days", {{"score", SqlType::bigint}}}},
      {"meta", {"probe_metas", {{"title", SqlType::text}, {"visibility", SqlType::text}}}},
      {"tag", {"probe_tags", {{"label", SqlType::text}}}},
      {"link", {"probe_links", {{"strength", SqlType::bigint}}}},
      {"mark", {"probe_marks", {{"done", SqlType::boolean}, {"memo", SqlType::text}}, 1}},
  };
  const auto table = tables.find(type);
  if (table == tables.end()) throw std::logic_error("the probe stores no table for the type " + type);
  return table->second;
}

std::optional<std::string> lookUp(sync::SyncTxn& txn, const std::string& sql, const sync::ScopeKey& scope, const std::string& key) {
  const pqxx::result rows = sync::sqlOf(txn).exec(sql, pqxx::params{scope.text(), key});
  if (rows.empty()) return std::nullopt;
  return rows[0][0].as<std::string>();
}

}

std::optional<std::string> PgProbeReceipts::startedRun(sync::SyncTxn& txn, const sync::ScopeKey& scope, const std::string& called) {
  return lookUp(txn, "select resolved from probe_start_receipts where scope_key = $1 and called = $2", scope, called);
}

void PgProbeReceipts::recordStart(sync::SyncTxn& txn, const sync::ScopeKey& scope, const std::string& called, const std::string& resolved) {
  sync::sqlOf(txn).exec("insert into probe_start_receipts (scope_key, called, resolved) values ($1, $2, $3) on conflict do nothing",
                        pqxx::params{scope.text(), called, resolved});
}

std::optional<std::string> PgProbeReceipts::copiedFrom(sync::SyncTxn& txn, const sync::ScopeKey& scope, const std::string& destination) {
  return lookUp(txn, "select source from probe_copy_receipts where scope_key = $1 and destination = $2", scope, destination);
}

void PgProbeReceipts::recordCopy(sync::SyncTxn& txn, const sync::ScopeKey& scope, const std::string& destination, const std::string& source) {
  sync::sqlOf(txn).exec("insert into probe_copy_receipts (scope_key, destination, source) values ($1, $2, $3) on conflict do nothing",
                        pqxx::params{scope.text(), destination, source});
}

PgProbe::PgProbe(const sync::Registry& registry) : product_(receipts_) {
  for (const sync::TypeDef& type : registry.types()) tables_.push_back(std::make_unique<sync::PgTableType>(type, tableOf(type.name)));
}

void PgProbe::bindTo(sync::SyncCatalog& catalog) {
  std::map<std::string, sync::TypeStore*> stores;
  for (const auto& table : tables_) stores.emplace(table->def().name, table.get());
  product_.bindTo(catalog, stores);
}

}
