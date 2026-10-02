#pragma once

#include "platform/application/sync/Admission.h"
#include "platform/application/sync/SyncCatalog.h"
#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Scope.h"
#include "products/probe/ProbeRegistry.h"
#include "products/gym/sync/GymRegistry.h"
#include "products/gym/sync/application/GymProduct.h"
#include "products/journal/sync/JournalRegistry.h"
#include "products/journal/sync/application/JournalProduct.h"
#include "test/products/journal/sync/domain/JournalFakes.h"
#include "test/products/gym/sync/domain/GymFakes.h"
#include "products/probe/application/ProbeProduct.h"
#include "test/platform/application/sync/SyncFakes.h"

#include <json/json.h>

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

// One sync engine over one backend, seeded from and dumped to the golden corpus's canonical server state
// (packages/api-contract/sync/corpus/README.md, "Server state: the canonical JSON"). The corpus names
// accounts "A" and "B"; a world maps them to the ids its store keeps.

namespace wm::sync::test {

class SyncWorld {
public:
  virtual ~SyncWorld() = default;

  virtual void seed(const Json::Value& state) = 0;
  virtual Json::Value dump() = 0;
  virtual SyncStore& store() = 0;
  virtual const SyncCatalog& catalog() const = 0;
  virtual UserId account(const std::string& alias) const = 0;
  virtual std::string alias(const UserId& account) const = 0;

  ServerClock& clock() { return *clock_; }

  fake::RecordingChangeFeed feed;
  fake::RecordingFailures failures;

  // The corpus's key text ('acct:A/probe') as this store keys it, and back.
  ScopeKey storeKey(const std::string& text) const {
    const ScopeKey key = *ScopeKey::parse(text);
    if (key.kind() == ScopeKind::product) return ScopeKey::product(account(key.account().str()), key.product());
    if (key.kind() == ScopeKind::overlay) return ScopeKey::overlay(account(key.account().str()), key.treeId());
    return key;
  }
  std::string aliasKey(const ScopeKey& key) const {
    if (key.kind() == ScopeKind::product) return ScopeKey::product(UserId{alias(key.account())}, key.product()).text();
    if (key.kind() == ScopeKind::overlay) return ScopeKey::overlay(UserId{alias(key.account())}, key.treeId()).text();
    return key.text();
  }
  // A governed_by value: '<scope>#<type>#<id>' for a tree, 'tree:<T>' for an overlay.
  std::string storeGovernedBy(const std::string& text) const {
    const std::size_t hash = text.find('#');
    return hash == std::string::npos ? text : storeKey(text.substr(0, hash)).text() + text.substr(hash);
  }
  std::string aliasGovernedBy(const std::string& text) const {
    const std::size_t hash = text.find('#');
    return hash == std::string::npos ? text : aliasKey(*ScopeKey::parse(text.substr(0, hash))) + text.substr(hash);
  }

  Json::Value scopeJson(const ScopeRow& row) const {
    static const char* kinds[] = {"product", "tree", "overlay"};
    Json::Value scope(Json::objectValue);
    scope["kind"] = kinds[static_cast<int>(row.key.kind())];
    scope["owner"] = alias(row.owner);
    scope["state"] = row.dead ? "dead" : "alive";
    scope["seq"] = Json::UInt64(row.seq);
    scope["counters"] = Json::Value(Json::objectValue);
    for (const auto& [type, count] : row.counters) scope["counters"][type] = Json::Int64(count);
    scope["digest"] = row.digest.hex();
    if (row.governedBy) scope["governedBy"] = aliasGovernedBy(*row.governedBy);
    if (row.deadAt) scope["deadAt"] = Json::UInt64(*row.deadAt);
    return scope;
  }

  ScopeRow scopeRowOf(const std::string& text, const Json::Value& scope, const Json::Value& rows) const {
    ScopeRow row{.key = storeKey(text), .owner = account(scope["owner"].asString())};
    if (scope.isMember("governedBy")) row.governedBy = storeGovernedBy(scope["governedBy"].asString());
    row.dead = scope["state"].asString() == "dead";
    if (scope.isMember("deadAt")) row.deadAt = scope["deadAt"].asUInt64();
    row.seq = scope["seq"].asUInt64();
    for (const std::string& type : scope["counters"].getMemberNames()) row.counters[type] = scope["counters"][type].asInt64();
    row.digest = *Digest256::fromHex(scope["digest"].asString());
    const std::optional<Opening>& opening = catalog().opening();
    for (const Json::Value& stored : rows) {
      if (opening && stored["t"].asString() == opening->type) row.open = opening->opens(Row(stored));
    }
    return row;
  }

protected:
  void resetClock(const Json::Value& clock) {
    clock_.emplace(HlcClock::State{clock["ms"].asUInt64(), static_cast<std::uint32_t>(clock["counter"].asUInt())});
  }
  Json::Value clockJson() const {
    Json::Value clock(Json::objectValue);
    clock["ms"] = Json::UInt64(clock_->state().ms);
    clock["counter"] = Json::UInt(clock_->state().counter);
    return clock;
  }

  // Drops the parts of a canonical state that hold nothing.
  static void dropEmpty(Json::Value& state) {
    for (const char* part : {"accounts", "scopes", "rows", "spent", "revisions", "replicas", "results", "requests", "product"}) {
      if (state.isMember(part) && state[part].empty()) state.removeMember(part);
    }
  }

  static Json::Value resultJson(const StoredResult& stored) {
    Json::Value result(Json::objectValue);
    result["n"] = Json::UInt64(stored.n);
    result["digest"] = stored.digest.hex();
    result["result"] = stored.result ? *stored.result : Json::Value(Json::nullValue);
    result["faults"] = stored.faults;
    return result;
  }

  // sync_requests grouped as the corpus shows them: each call with its parts `<requestId>#k`.
  Json::Value requestsJson(const std::map<std::pair<std::string, std::string>, RequestRow>& rows) const {
    Json::Value requests(Json::objectValue);
    for (const auto& [key, row] : rows) {
      if (row.requestId.find('#') != std::string::npos) continue;
      Json::Value call(Json::objectValue);
      call["requestId"] = row.requestId;
      call["digest"] = row.digest.hex();
      call["state"] = row.running ? "running" : "done";
      call["startedAt"] = Json::UInt64(row.startedAt);
      call["parts"] = Json::Value(Json::arrayValue);
      std::map<int, Json::Value> parts;
      for (const auto& [partKey, part] : rows) {
        const std::string prefix = row.requestId + "#";
        if (partKey.first == key.first && part.requestId.starts_with(prefix)) parts[std::stoi(part.requestId.substr(prefix.size()))] = *part.result;
      }
      for (const auto& [k, result] : parts) {
        Json::Value entry(Json::objectValue);
        entry["k"] = k;
        entry["result"] = result;
        call["parts"].append(entry);
      }
      if (row.result) call["result"] = *row.result;
      requests[alias(UserId{key.first})].append(call);
    }
    return requests;
  }

private:
  std::optional<ServerClock> clock_;
};

// The engine over the in-memory probe, gym or journal binding.
class FakeWorld final : public SyncWorld {
public:
  FakeWorld(bool gym = false, bool journal = false) : catalog_(journal ? wm::journal::engine::registry() : gym ? wm::gym::engine::registry() : probe::registry()), product_(receipts_), gymProduct_(gymState_), journalProduct_(journalState_), gym_(gym), journal_(journal) {
    std::map<std::string, TypeStore*> stores;
    for (const TypeDef& type : catalog_.registry().types()) {
      if (journal_) types_.push_back(std::make_unique<wm::journal::engine::test::FakeJournalType>(type));
      else if (gym_) types_.push_back(std::make_unique<wm::gym::engine::test::FakeGymType>(type));
      else types_.push_back(std::make_unique<fake::FakeTypeStore>(type, 1));
      stores.emplace(type.name, types_.back().get());
    }
    if (journal_) journalProduct_.bindTo(catalog_, stores);
    else if (gym_) gymProduct_.bindTo(catalog_, stores);
    else product_.bindTo(catalog_, stores);
    catalog_.seal();
    seed(Json::Value(Json::objectValue));
  }

  SyncStore& store() override { return store_; }
  const SyncCatalog& catalog() const override { return catalog_; }
  UserId account(const std::string& alias) const override { return UserId{alias}; }
  std::string alias(const UserId& account) const override { return account.str(); }
  fake::FakeDb& db() { return store_.db; }

  void seed(const Json::Value& state) override {
    fake::FakeDb db;
    db.epoch = state.isMember("epoch") ? state["epoch"].asString() : "ep-1";
    resetClock(state["clock"]);
    for (const std::string& name : state["accounts"].getMemberNames()) db.accountNames[name] = state["accounts"][name]["name"].asString();
    for (const std::string& key : state["scopes"].getMemberNames()) {
      ScopeRow row = scopeRowOf(key, state["scopes"][key], state["rows"][key]);
      db.scopes.emplace(row.key, row);
    }
    for (const std::string& key : state["rows"].getMemberNames()) {
      for (const Json::Value& wire : state["rows"][key]) {
        Row row(wire);
        db.rows.insert_or_assign(RecordRef{storeKey(key), row.t, row.id}, row);
      }
    }
    for (const std::string& key : state["spent"].getMemberNames()) {
      for (const Json::Value& spent : state["spent"][key]) {
        const std::optional<Stamp> born = spent.isMember("born") ? std::optional(stampOf(spent["born"])) : std::nullopt;
        const Row thin = spentRow(spent["t"].asString(), RecordId(spent["id"]), born, stampOf(spent["lifeStamp"]), spent["seq"].asUInt64());
        db.spent.insert_or_assign(RecordRef{storeKey(key), thin.t, thin.id}, thin);
      }
    }
    for (const std::string& key : state["revisions"].getMemberNames()) {
      for (const Json::Value& revision : state["revisions"][key]) {
        const RecordRef ref{storeKey(key), revision["t"].asString(), RecordId(revision["id"])};
        db.revisions[{ref, revision["field"].asString(), revision["rev"].asUInt64()}] = revision["text"].asString();
        Json::Value metadata = revision;
        for (const char* field : {"t", "id", "field", "rev", "text"}) metadata.removeMember(field);
        if (!metadata.empty()) db.revisionMetadata[{ref, revision["field"].asString(), revision["rev"].asUInt64()}] = metadata;
      }
    }
    for (const std::string& replica : state["replicas"].getMemberNames()) {
      const Json::Value& binding = state["replicas"][replica];
      db.replicas[replica] = ReplicaRow{replica, account(binding["account"].asString()), binding["lastN"].asUInt64()};
    }
    for (const std::string& replica : state["results"].getMemberNames()) {
      for (const Json::Value& result : state["results"][replica]) {
        const std::optional<Json::Value> stored = result["result"].isNull() ? std::nullopt : std::optional(result["result"]);
        db.results[{replica, result["n"].asUInt64()}] =
            StoredResult{result["n"].asUInt64(), *Digest256::fromHex(result["digest"].asString()), stored, result["faults"].asInt()};
      }
    }
    for (const std::string& alias : state["requests"].getMemberNames()) {
      for (const Json::Value& call : state["requests"][alias]) {
        const Digest256 digest = *Digest256::fromHex(call["digest"].asString());
        const Ms startedAt = call["startedAt"].asUInt64();
        const std::string requestId = call["requestId"].asString();
        const bool running = call["state"].asString() == "running";
        const std::optional<Json::Value> result = call.isMember("result") ? std::optional(call["result"]) : std::nullopt;
        db.requests[{account(alias).str(), requestId}] = RequestRow{requestId, digest, running, result, startedAt};
        for (const Json::Value& part : call["parts"]) {
          const std::string partId = requestId + "#" + std::to_string(part["k"].asInt());
          db.requests[{account(alias).str(), partId}] = RequestRow{partId, digest, false, part["result"], startedAt};
        }
      }
    }
    const Json::Value& product = state["product"];
    if (gym_) db.gym = product;
    if (journal_) db.journal = product;
    for (const std::string& key : product["receipts"].getMemberNames()) {
      for (const std::string& called : product["receipts"][key].getMemberNames())
        db.startReceipts[{storeKey(key), called}] = product["receipts"][key][called].asString();
    }
    for (const std::string& key : product["copies"].getMemberNames()) {
      for (const std::string& destination : product["copies"][key].getMemberNames())
        db.copyReceipts[{storeKey(key), destination}] = product["copies"][key][destination].asString();
    }
    store_.db = std::move(db);
  }

  Json::Value dump() override {
    const fake::FakeDb& db = store_.db;
    Json::Value state(Json::objectValue);
    state["epoch"] = db.epoch;
    state["clock"] = clockJson();
    state["accounts"] = Json::Value(Json::objectValue);
    for (const auto& [id, name] : db.accountNames) state["accounts"][alias(UserId{id})]["name"] = name;
    state["scopes"] = Json::Value(Json::objectValue);
    for (const auto& [key, row] : db.scopes) state["scopes"][aliasKey(key)] = scopeJson(row);
    state["rows"] = Json::Value(Json::objectValue);
    for (const auto& [ref, row] : db.rows) state["rows"][aliasKey(ref.scope)].append(row.toJson());
    state["spent"] = Json::Value(Json::objectValue);
    for (const auto& [ref, thin] : db.spent) {
      Json::Value spent(Json::objectValue);
      spent["t"] = thin.t;
      spent["id"] = thin.id.json();
      if (thin.lattice.born) spent["born"] = toString(*thin.lattice.born);
      spent["lifeStamp"] = toString(thin.lattice.life->stamp);
      spent["seq"] = Json::UInt64(thin.seq);
      state["spent"][aliasKey(ref.scope)].append(spent);
    }
    state["revisions"] = Json::Value(Json::objectValue);
    for (const auto& [key, text] : db.revisions) {
      const auto& [ref, field, rev] = key;
      Json::Value revision(Json::objectValue);
      revision["t"] = ref.t;
      revision["id"] = ref.id.json();
      revision["field"] = field;
      revision["rev"] = Json::UInt64(rev);
      revision["text"] = text;
      if (const auto metadata = db.revisionMetadata.find(key); metadata != db.revisionMetadata.end())
        for (const auto& field : metadata->second.getMemberNames()) revision[field] = metadata->second[field];
      state["revisions"][aliasKey(ref.scope)].append(revision);
    }
    state["replicas"] = Json::Value(Json::objectValue);
    for (const auto& [replica, row] : db.replicas) {
      state["replicas"][replica]["account"] = alias(row.account);
      state["replicas"][replica]["lastN"] = Json::UInt64(row.lastN);
    }
    state["results"] = Json::Value(Json::objectValue);
    for (const auto& [key, stored] : db.results) state["results"][key.first].append(resultJson(stored));
    state["requests"] = requestsJson(db.requests);
    state["product"] = Json::Value(Json::objectValue);
    for (const auto& [key, resolved] : db.startReceipts) state["product"]["receipts"][aliasKey(key.first)][key.second] = resolved;
    for (const auto& [key, source] : db.copyReceipts) state["product"]["copies"][aliasKey(key.first)][key.second] = source;
    if (gym_) {
      state["product"] = db.gym;
      for (const auto& key : state["product"].getMemberNames()) if (state["product"][key].empty()) state["product"].removeMember(key);
    }
    if (journal_) {
      state["product"] = db.journal;
      for (const auto& key : state["product"].getMemberNames()) if (state["product"][key].empty()) state["product"].removeMember(key);
    }
    dropEmpty(state);
    return state;
  }

private:
  fake::FakeSyncStore store_;
  fake::FakeProbeReceipts receipts_;
  std::vector<std::unique_ptr<TypeStore>> types_;
  SyncCatalog catalog_;
  probe::ProbeProduct product_;
  wm::gym::engine::test::FakeGymState gymState_;
  wm::gym::engine::GymProduct gymProduct_;
  wm::journal::engine::test::FakeJournalState journalState_;
  wm::journal::engine::JournalProduct journalProduct_;
  bool gym_;
  bool journal_;
};

}
