#pragma once

#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/domain/sync/Jcs.h"
#include "products/probe/ProbeRegistry.h"
#include "products/probe/adapters/postgres/PgProbe.h"
#include "products/gym/sync/adapters/postgres/PgGym.h"
#include "test/PgTestPool.h"
#include "test/platform/application/sync/SyncWorld.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <cstdio>
#include <map>
#include <set>
#include <string>
#include <vector>

// The sync engine over the isolated WM_SYNC_DATABASE_URL database (RUNNING.md §7).
// Seeding wipes sync, probe and gym rows; schema.sql, probe.sql and gym_sync.sql must be applied.

namespace wm::sync::test {

inline const char* kNeedsPostgres = "WM_PG_TEST unset — needs WM_SYNC_DATABASE_URL with schema.sql, probe.sql and gym_sync.sql, see RUNNING.md §7";

inline bool postgresEnabled() {
  return std::getenv("WM_PG_TEST") != nullptr;
}

class PgWorld final : public SyncWorld {
public:
  PgWorld(bool gym = false) : store_(pgTestPool(), Limits{}.lockTimeoutMs), probe_(probe::registry()), gymProduct_(wm::gym::engine::registry()), catalog_(gym ? wm::gym::engine::registry() : probe::registry()), gym_(gym) {
    if (gym_) gymProduct_.bindTo(catalog_);
    else probe_.bindTo(catalog_);
    catalog_.seal();
    resetClock(Json::Value(Json::objectValue));
  }

  SyncStore& store() override { return store_; }
  const SyncCatalog& catalog() const override { return catalog_; }

  // "A" is 00000000-0000-4000-8000-000000000041: the alias's bytes as the uuid's last twelve hex digits. An alias
  // over six bytes stays itself: only a credential outside §9.1's account id form carries one, answered 401 before
  // the store is read.
  UserId account(const std::string& alias) const override {
    if (alias.size() > 6) return UserId{alias};
    std::string hex;
    for (const char c : alias) {
      char byte[3];
      std::snprintf(byte, sizeof byte, "%02x", static_cast<unsigned char>(c));
      hex += byte;
    }
    return UserId{"00000000-0000-4000-8000-" + std::string(12 - hex.size(), '0') + hex};
  }
  std::string alias(const UserId& account) const override {
    if (!account.str().starts_with("00000000-0000-4000-8000-")) return account.str();
    const std::string hex = account.str().substr(24);
    std::string alias;
    for (std::size_t i = 0; i < hex.size(); i += 2) {
      const char c = static_cast<char>(std::stoi(hex.substr(i, 2), nullptr, 16));
      if (c != 0) alias.push_back(c);
    }
    return alias;
  }

  void seed(const Json::Value& state) override {
    accounts_ = state["accounts"];
    resetClock(state["clock"]);
    std::unique_ptr<SyncTxn> txn = store_.begin(TxnMode::write);
    pqxx::transaction_base& sql = sqlOf(*txn);
    for (const char* table : {"probe_marks_revisions", "probe_start_receipts", "probe_copy_receipts", "probe_marks", "probe_links", "probe_tags",
                              "probe_metas", "probe_facts", "probe_days", "probe_laps", "probe_runs", "probe_cards", "probe_boards", "sync_spent",
                              "sync_requests", "sync_replicas", "sync_scopes"}) {
      sql.exec(std::string("delete from ") + table);
    }
    if (gym_) {
      sql.exec("truncate gym_exercises,gym_routines,gym_sessions,gym_notes,gym_bodyweight,gym_preferences,gym_write_receipts,gym_correction_receipts,gym_routine_creations,gym_note_saves,gym_ask_threads cascade");
      for (const auto& id : state["product"]["seeds"].getMemberNames()) {
        sql.exec("insert into gym_exercises(id,name,pattern,equipment) values($1,$2,'isolation','bodyweight')", pqxx::params{id, state["product"]["seeds"][id]["name"].asString()});
      }
      productSeed_ = state["product"];
      implicitRevisions_.clear();
      for (const auto& key : state["rows"].getMemberNames()) {
        for (const auto& row : state["rows"][key]) {
          if (row["t"] == "routine" && !state["product"]["revisions"][key].isMember(row["id"].asString())) {
            implicitRevisions_[key].insert(row["id"].asString());
          }
        }
      }
    }
    for (const std::string& alias : aliasesIn(state)) {
      const std::string name = state["accounts"][alias]["name"].asString();
      sql.exec("insert into users (id, email, name) values ($1::uuid, $2, $3) on conflict (id) do update set name = excluded.name",
               pqxx::params{account(alias).str(), account(alias).str() + "@sync.test", name});
    }
    sql.exec("update sync_meta set epoch = $1", pqxx::params{state.isMember("epoch") ? state["epoch"].asString() : std::string("ep-1")});

    for (const std::string& key : state["scopes"].getMemberNames()) {
      const ScopeRow row = scopeRowOf(key, state["scopes"][key], state["rows"][key]);
      Json::Value counters(Json::objectValue);
      for (const auto& [type, count] : row.counters) counters[type] = Json::Int64(count);
      std::optional<std::int64_t> deadAt;
      if (row.deadAt) deadAt = static_cast<std::int64_t>(*row.deadAt);
      sql.exec("insert into sync_scopes (key, kind, owner, governed_by, state, seq, counters, digest, open, dead_at) "
               "values ($1, $2, $3::uuid, $4, $5, $6, $7::jsonb, decode($8, 'hex'), $9, $10)",
               pqxx::params{row.key.text(), state["scopes"][key]["kind"].asString(), row.owner.str(), row.governedBy,
                            std::string(row.dead ? "dead" : "alive"), static_cast<std::int64_t>(row.seq), jcs(counters), row.digest.hex(), row.open,
                            deadAt});
    }
    for (const std::string& key : state["rows"].getMemberNames()) {
      const ScopeKey scope = storeKey(key);
      if (gym_) {
        for (const auto& row : state["rows"][key]) {
          if (row["t"] != "proposal" || row["f"]["threadId"][0].isNull()) continue;
          sql.exec("insert into gym_ask_threads(id,user_id,title,created_at,asked_at) values($1,$2::uuid,'Corpus Coach',to_timestamp(0),to_timestamp(0)) on conflict do nothing",
                   pqxx::params{row["f"]["threadId"][0].asString(), scope.account().str()});
        }
      }
      for (const TypeDef* type : catalog_.applyOrder()) {
        for (const Json::Value& wire : state["rows"][key]) {
          const Row row(wire);
          if (row.t != type->name) continue;
          catalog_.store(row.t).apply(*txn, scope, {RowWrite{type, row.id, std::nullopt, row, {}}});
        }
      }
    }
    if (gym_) {
      // Some corpus fixtures retain an old set after omitting its session. A non-sync parent
      // satisfies the relational FK without adding a row to the engine's state or open session.
      for (const auto& key : state["rows"].getMemberNames()) {
        for (const auto& row : state["rows"][key]) {
          if (row["t"] != "set") continue;
          sql.exec("insert into gym_sessions(id,user_id,started_at,finished_at) values($1,$2::uuid,to_timestamp(0),to_timestamp(0)) on conflict (id) do nothing",
                   pqxx::params{row["f"]["sessionId"][0].asString(), storeKey(key).account().str()});
        }
      }
    }
    for (const std::string& key : state["spent"].getMemberNames()) {
      for (const Json::Value& spent : state["spent"][key]) {
        const std::optional<Stamp> born = spent.isMember("born") ? std::optional(stampOf(spent["born"])) : std::nullopt;
        store_.addSpent(*txn, storeKey(key), spentRow(spent["t"].asString(), RecordId(spent["id"]), born, stampOf(spent["lifeStamp"]), spent["seq"].asUInt64()));
      }
    }
    for (const std::string& key : state["revisions"].getMemberNames()) {
      for (const Json::Value& revision : state["revisions"][key]) {
        sql.exec("insert into probe_marks_revisions (scope_key, id, field, rev, text) values ($1, $2, $3, $4, $5)",
                 pqxx::params{storeKey(key).text(), RecordId(revision["id"]).column(), revision["field"].asString(), revision["rev"].asInt64(),
                              revision["text"].asString()});
      }
    }
    for (const std::string& replica : state["replicas"].getMemberNames()) {
      const Json::Value& binding = state["replicas"][replica];
      sql.exec("insert into sync_replicas (replica, account, last_n, last_seen) values ($1, $2::uuid, $3, 0)",
               pqxx::params{replica, account(binding["account"].asString()).str(), binding["lastN"].asInt64()});
    }
    for (const std::string& replica : state["results"].getMemberNames()) {
      for (const Json::Value& result : state["results"][replica]) {
        const std::optional<Json::Value> stored = result["result"].isNull() ? std::nullopt : std::optional(result["result"]);
        store_.putResult(*txn, replica, StoredResult{result["n"].asUInt64(), *Digest256::fromHex(result["digest"].asString()), stored, result["faults"].asInt()});
      }
    }
    for (const std::string& alias : state["requests"].getMemberNames()) {
      for (const Json::Value& call : state["requests"][alias]) {
        const Digest256 digest = *Digest256::fromHex(call["digest"].asString());
        const std::string requestId = call["requestId"].asString();
        const std::optional<Json::Value> result = call.isMember("result") ? std::optional(call["result"]) : std::nullopt;
        store_.putRequest(*txn, account(alias), RequestRow{requestId, digest, call["state"].asString() == "running", result, call["startedAt"].asUInt64()});
        for (const Json::Value& part : call["parts"]) {
          store_.putRequest(*txn, account(alias),
                            RequestRow{requestId + "#" + std::to_string(part["k"].asInt()), digest, false, part["result"], call["startedAt"].asUInt64()});
        }
      }
    }
    const Json::Value& product = state["product"];
    for (const std::string& key : product["receipts"].getMemberNames()) {
      for (const std::string& called : product["receipts"][key].getMemberNames()) {
        sql.exec("insert into probe_start_receipts (scope_key, called, resolved) values ($1, $2, $3)",
                 pqxx::params{storeKey(key).text(), called, product["receipts"][key][called].asString()});
      }
    }
    for (const std::string& key : product["copies"].getMemberNames()) {
      for (const std::string& destination : product["copies"][key].getMemberNames()) {
        sql.exec("insert into probe_copy_receipts (scope_key, destination, source) values ($1, $2, $3)",
                 pqxx::params{storeKey(key).text(), destination, product["copies"][key][destination].asString()});
      }
    }
    if (gym_) {
      wm::gym::engine::PgGymState gymState;
      const Json::Value& product = state["product"];
      for (const char* kind : {"starts", "imports", "corrections"}) {
        for (const std::string& key : product[kind].getMemberNames()) {
          for (const std::string& id : product[kind][key].getMemberNames()) gymState.receipt(*txn, storeKey(key), kind, id, product[kind][key][id]);
        }
      }
      for (const std::string& key : product["revisions"].getMemberNames()) for (const std::string& id : product["revisions"][key].getMemberNames()) {
        sql.exec("update gym_routines set revision=$3 where user_id=$1::uuid and id=$2", pqxx::params{storeKey(key).account().str(), id, product["revisions"][key][id].asInt()});
      }
      for (const std::string& key : product["bases"].getMemberNames()) for (const std::string& id : product["bases"][key].getMemberNames()) {
        sql.exec("update gym_proposals set base_revision=$3,base_name=$4 where user_id=$1::uuid and id=$2", pqxx::params{storeKey(key).account().str(), id, product["bases"][key][id]["revision"].asInt(), product["bases"][key][id]["name"].asString()});
      }
    }
    txn->commit();
  }

  Json::Value dump() override {
    std::unique_ptr<SyncTxn> txn = store_.begin(TxnMode::snapshot);
    pqxx::transaction_base& sql = sqlOf(*txn);
    Json::Value state(Json::objectValue);
    state["epoch"] = store_.epoch(*txn);
    state["clock"] = clockJson();
    state["accounts"] = accounts_.isNull() ? Json::Value(Json::objectValue) : accounts_;

    state["scopes"] = Json::Value(Json::objectValue);
    state["rows"] = Json::Value(Json::objectValue);
    state["spent"] = Json::Value(Json::objectValue);
    for (const auto& scopeRow : sql.exec("select key from sync_scopes order by key collate \"C\"")) {
      const ScopeKey key = *ScopeKey::parse(scopeRow["key"].template as<std::string>());
      const ScopeRow row = *store_.scope(*txn, key, RowLock::none);
      state["scopes"][aliasKey(key)] = scopeJson(row);
      std::vector<Row> rows;
      std::vector<Row> spent;
      for (const TypeDef* type : catalog_.typesIn(key.registryScope())) {
        for (Row& stored : catalog_.store(type->name).feed(*txn, key, FeedQuery{})) rows.push_back(std::move(stored));
        for (Row& thin : store_.feedSpent(*txn, key, *type, FeedQuery{})) spent.push_back(std::move(thin));
      }
      auto byRecord = [](const Row& a, const Row& b) { return std::tie(a.t, a.id) < std::tie(b.t, b.id); };
      std::sort(rows.begin(), rows.end(), byRecord);
      std::sort(spent.begin(), spent.end(), byRecord);
      for (const Row& stored : rows) state["rows"][aliasKey(key)].append(stored.toJson());
      for (const Row& thin : spent) {
        Json::Value entry(Json::objectValue);
        entry["t"] = thin.t;
        entry["id"] = thin.id.json();
        if (thin.lattice.born) entry["born"] = toString(*thin.lattice.born);
        entry["lifeStamp"] = toString(thin.lattice.life->stamp);
        entry["seq"] = Json::UInt64(thin.seq);
        state["spent"][aliasKey(key)].append(entry);
      }
    }

    state["revisions"] = Json::Value(Json::objectValue);
    for (const auto& row : sql.exec("select scope_key, id, field, rev, text from probe_marks_revisions order by scope_key, id collate \"C\", field, rev")) {
      Json::Value revision(Json::objectValue);
      revision["t"] = "mark";
      revision["id"] = row["id"].template as<std::string>();
      revision["field"] = row["field"].template as<std::string>();
      revision["rev"] = Json::UInt64(row["rev"].template as<std::uint64_t>());
      revision["text"] = row["text"].template as<std::string>();
      state["revisions"][aliasKey(*ScopeKey::parse(row["scope_key"].template as<std::string>()))].append(revision);
    }

    state["replicas"] = Json::Value(Json::objectValue);
    state["results"] = Json::Value(Json::objectValue);
    for (const auto& row : sql.exec("select replica, account::text as account, last_n from sync_replicas order by replica")) {
      const std::string replica = row["replica"].template as<std::string>();
      state["replicas"][replica]["account"] = alias(UserId{row["account"].template as<std::string>()});
      state["replicas"][replica]["lastN"] = Json::UInt64(row["last_n"].template as<std::uint64_t>());
      for (const auto& n : sql.exec("select n from sync_results where replica = $1 order by n", pqxx::params{replica})) {
        state["results"][replica].append(resultJson(*store_.storedResult(*txn, replica, n["n"].template as<std::uint64_t>())));
      }
    }

    std::map<std::pair<std::string, std::string>, RequestRow> requests;
    for (const auto& row : sql.exec("select account::text as account, request_id from sync_requests")) {
      const UserId owner{row["account"].template as<std::string>()};
      const std::string requestId = row["request_id"].template as<std::string>();
      requests.emplace(std::pair(owner.str(), requestId), *store_.request(*txn, owner, requestId));
    }
    state["requests"] = requestsJson(requests);

    state["product"] = Json::Value(Json::objectValue);
    for (const auto& row : sql.exec("select scope_key, called, resolved from probe_start_receipts")) {
      state["product"]["receipts"][aliasKey(*ScopeKey::parse(row["scope_key"].template as<std::string>()))][row["called"].template as<std::string>()] =
          row["resolved"].template as<std::string>();
    }
    for (const auto& row : sql.exec("select scope_key, destination, source from probe_copy_receipts")) {
      state["product"]["copies"][aliasKey(*ScopeKey::parse(row["scope_key"].template as<std::string>()))][row["destination"].template as<std::string>()] =
          row["source"].template as<std::string>();
    }
    if (gym_) {
      state["product"] = Json::Value(Json::objectValue);
      state["product"]["seeds"] = productSeed_["seeds"];
      state["product"]["bases"] = productSeed_["bases"];
      wm::gym::engine::PgGymState gymState;
      for (const auto& key : state["scopes"].getMemberNames()) {
        Json::Value books = gymState.load(*txn, storeKey(key));
        // SQL supplies revision 1 for legacy routines; the corpus only represents explicit
        // revision books, so leave an unchanged implicit default out of its dumped state.
        for (const auto& id : implicitRevisions_[key]) {
          if (books["revisions"].isMember(id) && books["revisions"][id] == 1) books["revisions"].removeMember(id);
        }
        for (const char* kind : {"starts", "imports", "corrections", "revisions", "bases"}) {
          if (books[kind].isNull() || books[kind].empty()) continue;
          if (std::string(kind) == "bases") {
            for (const auto& id : books[kind].getMemberNames()) state["product"][kind][key][id] = books[kind][id];
          } else state["product"][kind][key] = books[kind];
        }
      }
      for (const auto& key : state["product"].getMemberNames()) if (state["product"][key].isNull() || state["product"][key].empty()) state["product"].removeMember(key);
    }
    dropEmpty(state);
    return state;
  }

private:
  // Every account the state names: its accounts, its scopes' owners, its replicas' and requests' accounts.
  std::vector<std::string> aliasesIn(const Json::Value& state) const {
    std::set<std::string> aliases;
    for (const std::string& alias : state["accounts"].getMemberNames()) aliases.insert(alias);
    for (const std::string& key : state["scopes"].getMemberNames()) aliases.insert(state["scopes"][key]["owner"].asString());
    for (const std::string& replica : state["replicas"].getMemberNames()) aliases.insert(state["replicas"][replica]["account"].asString());
    for (const std::string& alias : state["requests"].getMemberNames()) aliases.insert(alias);
    for (const std::string& alias : {"A", "B"}) aliases.insert(alias);
    return {aliases.begin(), aliases.end()};
  }

  PgSyncStore store_;
  probe::PgProbe probe_;
  wm::gym::engine::PgGym gymProduct_;
  SyncCatalog catalog_;
  Json::Value accounts_;
  Json::Value productSeed_;
  std::map<std::string, std::set<std::string>> implicitRevisions_;
  bool gym_;
};

}
