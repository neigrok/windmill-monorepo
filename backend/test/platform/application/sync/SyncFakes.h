#pragma once

#include "platform/application/sync/SyncLive.h"
#include "platform/domain/sync/Admit.h"
#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Record.h"
#include "platform/ports/ChangeFeed.h"
#include "platform/ports/FailureReporter.h"
#include "platform/ports/SyncStore.h"
#include "platform/ports/SyncType.h"
#include "products/probe/ports/ProbeReceipts.h"

#include <algorithm>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

// The sync engine's ports in memory, faithful to what admission relies on from Postgres: one transaction
// at a time (a store-wide mutex), copy on begin, swap on commit, rollback by destruction.

namespace wm::sync::fake {

// Everything the engine and the probe store: the engine's tables, every type's typed rows and revisions,
// and the probe's receipts.
struct FakeDb {
  std::string epoch = "ep-1";
  Json::Value gym = Json::Value(Json::objectValue);
  std::map<std::string, std::string> accountNames;
  std::map<ScopeKey, ScopeRow> scopes;
  std::map<std::string, ReplicaRow> replicas;
  std::map<std::pair<std::string, std::uint64_t>, StoredResult> results;
  std::map<RecordRef, Row> spent;
  std::map<std::pair<std::string, std::string>, RequestRow> requests;
  std::map<RecordRef, Row> rows;
  std::map<std::tuple<RecordRef, std::string, Seq>, std::string> revisions;
  std::map<std::pair<ScopeKey, std::string>, std::string> startReceipts;
  std::map<std::pair<ScopeKey, std::string>, std::string> copyReceipts;
};

// A fault the test injects, which the fake store classifies as transient.
struct InjectedTransient : std::runtime_error {
  using std::runtime_error::runtime_error;
};

class FakeSyncStore;

class FakeSyncTxn final : public SyncTxn {
public:
  FakeSyncTxn(std::mutex& mutex, FakeDb& committed) : lock_(mutex), committed_(committed), work(committed) {}
  void commit() override { committed_ = work; }

private:
  std::unique_lock<std::mutex> lock_;
  FakeDb& committed_;

public:
  FakeDb work;
};

inline FakeDb& dbOf(SyncTxn& txn) {
  return dynamic_cast<FakeSyncTxn&>(txn).work;
}

// Rows of one keyset (§2.3 FeedQuery), in (seq, id) order.
inline std::vector<Row> select(std::vector<Row> rows, const TypeDef& type, const FeedQuery& query) {
  std::erase_if(rows, [&](const Row& row) {
    const bool after = row.seq > query.afterSeq || (row.seq == query.afterSeq && row.id.key() > query.afterKey);
    return !after || (query.throughSeq && row.seq > *query.throughSeq) || (query.aliveOnly && !row.alive()) ||
           (query.visibleOnly && !visible(type, row));
  });
  std::sort(rows.begin(), rows.end(), [](const Row& a, const Row& b) { return std::tie(a.seq, a.id) < std::tie(b.seq, b.id); });
  if (query.limit > 0 && rows.size() > query.limit) rows.resize(query.limit);
  return rows;
}

class FakeSyncStore final : public SyncStore {
public:
  FakeDb db;

  std::unique_ptr<SyncTxn> begin(TxnMode) override { return std::make_unique<FakeSyncTxn>(mutex_, db); }

  FaultClass classify(const std::exception& error) const override {
    return dynamic_cast<const InjectedTransient*>(&error) ? FaultClass::transient : FaultClass::fault;
  }

  std::string epoch(SyncTxn& txn) override { return dbOf(txn).epoch; }

  std::string ownerName(SyncTxn& txn, const UserId& owner) override {
    const auto name = dbOf(txn).accountNames.find(owner.str());
    return name == dbOf(txn).accountNames.end() ? "" : name->second;
  }

  bool insertScope(SyncTxn& txn, const ScopeKey& key, const UserId& owner, const std::optional<std::string>& governedBy) override {
    return dbOf(txn).scopes.emplace(key, ScopeRow{.key = key, .owner = owner, .governedBy = governedBy}).second;
  }

  std::optional<ScopeRow> scope(SyncTxn& txn, const ScopeKey& key, RowLock) override {
    const auto row = dbOf(txn).scopes.find(key);
    return row == dbOf(txn).scopes.end() ? std::nullopt : std::optional(row->second);
  }

  void saveScope(SyncTxn& txn, const ScopeRow& row) override {
    ScopeRow& stored = dbOf(txn).scopes.at(row.key);
    stored.seq = row.seq;
    stored.counters = row.counters;
    stored.digest = row.digest;
    stored.open = row.open;
  }

  std::vector<ScopeKey> killTree(SyncTxn& txn, const ScopeKey& tree, Ms now) override {
    std::vector<ScopeKey> killed;
    for (auto& [key, row] : dbOf(txn).scopes) {
      if (key != tree && row.governedBy != tree.text()) continue;
      row.dead = true;
      row.deadAt = now;
      killed.push_back(key);
    }
    return killed;
  }

  ReplicaRow bindReplica(SyncTxn& txn, const std::string& replica, const UserId& account, Ms) override {
    return dbOf(txn).replicas.emplace(replica, ReplicaRow{replica, account, 0}).first->second;
  }

  std::optional<ReplicaRow> replica(SyncTxn& txn, const std::string& replica, RowLock) override {
    const auto row = dbOf(txn).replicas.find(replica);
    return row == dbOf(txn).replicas.end() ? std::nullopt : std::optional(row->second);
  }

  void unbindUnused(SyncTxn& txn, const std::string& replica) override {
    FakeDb& db = dbOf(txn);
    const bool answered = std::any_of(db.results.begin(), db.results.end(), [&replica](const auto& entry) { return entry.first.first == replica; });
    if (!answered && db.replicas.contains(replica) && db.replicas.at(replica).lastN == 0) db.replicas.erase(replica);
  }

  void setLastN(SyncTxn& txn, const std::string& replica, std::uint64_t n) override { dbOf(txn).replicas.at(replica).lastN = n; }

  std::optional<StoredResult> storedResult(SyncTxn& txn, const std::string& replica, std::uint64_t n) override {
    const auto row = dbOf(txn).results.find({replica, n});
    return row == dbOf(txn).results.end() ? std::nullopt : std::optional(row->second);
  }

  void putResult(SyncTxn& txn, const std::string& replica, const StoredResult& result) override {
    dbOf(txn).results.insert_or_assign({replica, result.n}, result);
  }

  void pruneResults(SyncTxn& txn, const std::string& replica, std::uint64_t through) override {
    std::erase_if(dbOf(txn).results, [&](const auto& entry) { return entry.first.first == replica && entry.first.second <= through; });
  }

  std::map<std::string, Row> spentIn(SyncTxn& txn, const ScopeKey& scope, const TypeDef& type, const std::vector<RecordId>& ids) override {
    std::map<std::string, Row> found;
    for (const RecordId& id : ids) {
      if (const auto row = dbOf(txn).spent.find(RecordRef{scope, type.name, id}); row != dbOf(txn).spent.end()) found.emplace(id.key(), row->second);
    }
    return found;
  }

  std::set<std::string> spentElsewhere(SyncTxn& txn, const ScopeKey& scope, const TypeDef& type, const std::vector<RecordId>& ids) override {
    std::set<std::string> found;
    for (const auto& [ref, row] : dbOf(txn).spent) {
      if (ref.scope == scope || ref.t != type.name) continue;
      if (std::find(ids.begin(), ids.end(), ref.id) != ids.end()) found.insert(ref.id.key());
    }
    return found;
  }

  void addSpent(SyncTxn& txn, const ScopeKey& scope, const Row& thin) override {
    dbOf(txn).spent.insert_or_assign(RecordRef{scope, thin.t, thin.id}, thin);
  }

  void removeSpent(SyncTxn& txn, const ScopeKey& scope, const TypeDef& type, const RecordId& id) override {
    dbOf(txn).spent.erase(RecordRef{scope, type.name, id});
  }

  std::vector<Row> feedSpent(SyncTxn& txn, const ScopeKey& scope, const TypeDef& type, const FeedQuery& query) override {
    std::vector<Row> rows;
    for (const auto& [ref, row] : dbOf(txn).spent) {
      if (ref.scope == scope && ref.t == type.name) rows.push_back(row);
    }
    FeedQuery spentQuery = query;
    spentQuery.aliveOnly = false;
    spentQuery.visibleOnly = false;
    return select(std::move(rows), type, spentQuery);
  }

  std::uint64_t countSpent(SyncTxn& txn, const ScopeKey& scope, const TypeDef& type, const FeedQuery& query) override {
    return feedSpent(txn, scope, type, query).size();
  }

  void lockIds(SyncTxn&, const std::vector<std::pair<std::string, std::string>>&) override {}
  void lockRequest(SyncTxn&, const UserId&, const std::string&) override {}

  std::optional<RequestRow> request(SyncTxn& txn, const UserId& account, const std::string& requestId) override {
    const auto row = dbOf(txn).requests.find({account.str(), requestId});
    return row == dbOf(txn).requests.end() ? std::nullopt : std::optional(row->second);
  }

  void putRequest(SyncTxn& txn, const UserId& account, const RequestRow& row) override {
    dbOf(txn).requests.insert_or_assign({account.str(), row.requestId}, row);
  }

private:
  std::mutex mutex_;
};

// A store that hands every call to another: the base of a test decorator that changes one or two of them.
class ForwardingStore : public SyncStore {
public:
  explicit ForwardingStore(SyncStore& inner) : inner_(inner) {}

  std::unique_ptr<SyncTxn> begin(TxnMode mode) override { return inner_.begin(mode); }
  FaultClass classify(const std::exception& error) const override { return inner_.classify(error); }
  std::string epoch(SyncTxn& txn) override { return inner_.epoch(txn); }
  std::string ownerName(SyncTxn& txn, const UserId& owner) override { return inner_.ownerName(txn, owner); }
  bool insertScope(SyncTxn& txn, const ScopeKey& key, const UserId& owner, const std::optional<std::string>& governedBy) override {
    return inner_.insertScope(txn, key, owner, governedBy);
  }
  std::optional<ScopeRow> scope(SyncTxn& txn, const ScopeKey& key, RowLock lock) override { return inner_.scope(txn, key, lock); }
  void saveScope(SyncTxn& txn, const ScopeRow& row) override { inner_.saveScope(txn, row); }
  std::vector<ScopeKey> killTree(SyncTxn& txn, const ScopeKey& tree, Ms now) override { return inner_.killTree(txn, tree, now); }
  ReplicaRow bindReplica(SyncTxn& txn, const std::string& replica, const UserId& account, Ms now) override {
    return inner_.bindReplica(txn, replica, account, now);
  }
  std::optional<ReplicaRow> replica(SyncTxn& txn, const std::string& replica, RowLock lock) override { return inner_.replica(txn, replica, lock); }
  void unbindUnused(SyncTxn& txn, const std::string& replica) override { inner_.unbindUnused(txn, replica); }
  void setLastN(SyncTxn& txn, const std::string& replica, std::uint64_t n) override { inner_.setLastN(txn, replica, n); }
  std::optional<StoredResult> storedResult(SyncTxn& txn, const std::string& replica, std::uint64_t n) override {
    return inner_.storedResult(txn, replica, n);
  }
  void putResult(SyncTxn& txn, const std::string& replica, const StoredResult& result) override { inner_.putResult(txn, replica, result); }
  void pruneResults(SyncTxn& txn, const std::string& replica, std::uint64_t through) override { inner_.pruneResults(txn, replica, through); }
  std::map<std::string, Row> spentIn(SyncTxn& txn, const ScopeKey& scope, const TypeDef& type, const std::vector<RecordId>& ids) override {
    return inner_.spentIn(txn, scope, type, ids);
  }
  std::set<std::string> spentElsewhere(SyncTxn& txn, const ScopeKey& scope, const TypeDef& type, const std::vector<RecordId>& ids) override {
    return inner_.spentElsewhere(txn, scope, type, ids);
  }
  void addSpent(SyncTxn& txn, const ScopeKey& scope, const Row& thin) override { inner_.addSpent(txn, scope, thin); }
  void removeSpent(SyncTxn& txn, const ScopeKey& scope, const TypeDef& type, const RecordId& id) override { inner_.removeSpent(txn, scope, type, id); }
  std::vector<Row> feedSpent(SyncTxn& txn, const ScopeKey& scope, const TypeDef& type, const FeedQuery& query) override {
    return inner_.feedSpent(txn, scope, type, query);
  }
  std::uint64_t countSpent(SyncTxn& txn, const ScopeKey& scope, const TypeDef& type, const FeedQuery& query) override {
    return inner_.countSpent(txn, scope, type, query);
  }
  void lockIds(SyncTxn& txn, const std::vector<std::pair<std::string, std::string>>& typeIds) override { inner_.lockIds(txn, typeIds); }
  void lockRequest(SyncTxn& txn, const UserId& account, const std::string& requestId) override { inner_.lockRequest(txn, account, requestId); }
  std::optional<RequestRow> request(SyncTxn& txn, const UserId& account, const std::string& requestId) override {
    return inner_.request(txn, account, requestId);
  }
  void putRequest(SyncTxn& txn, const UserId& account, const RequestRow& row) override { inner_.putRequest(txn, account, row); }

private:
  SyncStore& inner_;
};

// The faults a corpus vector injects (corpus/README.md) over any store, each thrown inside the admission's own
// transaction so Admission's §6.6 path runs as it does over a real failure: push/serve.json's `faults` by intent
// n, at the putResult that would record its answer; admit/requests.json's `transientAt` and `faultAt` by admit
// k, at the putRequest that would store part k. What that path stores itself (a tally, refused internal) passes
// through.
class FaultingStore final : public ForwardingStore {
public:
  struct Faults {
    std::map<std::uint64_t, FaultClass> intents;
    std::map<int, FaultClass> parts;
  };

  FaultingStore(SyncStore& inner, Faults faults) : ForwardingStore(inner), faults_(std::move(faults)) {}

  void putResult(SyncTxn& txn, const std::string& replica, const StoredResult& result) override {
    if (result.faults == 0) inject(faults_.intents, result.n);
    ForwardingStore::putResult(txn, replica, result);
  }

  void putRequest(SyncTxn& txn, const UserId& account, const RequestRow& row) override {
    const std::size_t hash = row.requestId.rfind('#');
    const bool internal = row.result && (*row.result)["code"].asString() == "internal";
    if (hash != std::string::npos && !internal) inject(faults_.parts, std::stoi(row.requestId.substr(hash + 1)));
    ForwardingStore::putRequest(txn, account, row);
  }

  FaultClass classify(const std::exception& error) const override {
    return dynamic_cast<const InjectedTransient*>(&error) ? FaultClass::transient : ForwardingStore::classify(error);
  }

private:
  template <typename Key>
  static void inject(const std::map<Key, FaultClass>& faults, Key key) {
    const auto fault = faults.find(key);
    if (fault == faults.end()) return;
    if (fault->second == FaultClass::transient) throw InjectedTransient("an injected transient failure");
    throw std::runtime_error("an injected fault");
  }

  Faults faults_;
};

// Any registry type's typed rows, kept whole. `revisionsKept` is the product's text revision policy.
class FakeTypeStore : public TypeStore {
public:
  FakeTypeStore(const TypeDef& type, std::size_t revisionsKept) : type_(type), revisionsKept_(revisionsKept) {}

  const TypeDef& def() const override { return type_; }

  std::map<std::string, Row> lock(SyncTxn& txn, const ScopeKey& scope, const std::vector<RecordId>& ids) override {
    std::map<std::string, Row> found;
    for (const RecordId& id : ids) {
      if (const auto row = dbOf(txn).rows.find(RecordRef{scope, type_.name, id}); row != dbOf(txn).rows.end()) found.emplace(id.key(), row->second);
    }
    return found;
  }

  std::set<std::string> elsewhere(SyncTxn& txn, const ScopeKey& scope, const std::vector<RecordId>& ids) override {
    std::set<std::string> found;
    for (const auto& [ref, row] : dbOf(txn).rows) {
      if (ref.scope == scope || ref.t != type_.name) continue;
      if (std::find(ids.begin(), ids.end(), ref.id) != ids.end()) found.insert(ref.id.key());
    }
    return found;
  }

  void apply(SyncTxn& txn, const ScopeKey& scope, const std::vector<RowWrite>& writes) override {
    FakeDb& db = dbOf(txn);
    for (const RowWrite& write : writes) {
      const RecordRef ref{scope, type_.name, write.id};
      if (write.after) db.rows.insert_or_assign(ref, *write.after);
      else db.rows.erase(ref);
      for (const TextRevision& revision : write.revisions) {
        db.revisions.insert_or_assign({ref, revision.field, revision.rev}, revision.text);
        std::vector<Seq> kept;
        for (const auto& [key, text] : db.revisions) {
          if (std::get<0>(key) == ref && std::get<1>(key) == revision.field) kept.push_back(std::get<2>(key));
        }
        std::sort(kept.begin(), kept.end());
        for (std::size_t i = 0; i + revisionsKept_ < kept.size(); ++i) db.revisions.erase({ref, revision.field, kept[i]});
      }
    }
  }

  std::vector<Row> feed(SyncTxn& txn, const ScopeKey& scope, const FeedQuery& query) override {
    std::vector<Row> rows;
    for (const auto& [ref, row] : dbOf(txn).rows) {
      if (ref.scope == scope && ref.t == type_.name) rows.push_back(row);
    }
    return select(std::move(rows), type_, query);
  }

  std::uint64_t count(SyncTxn& txn, const ScopeKey& scope, const FeedQuery& query) override { return feed(txn, scope, query).size(); }

  std::optional<std::int64_t> maxSerial(SyncTxn& txn, const ScopeKey& scope, const std::string& field,
                                        const std::map<std::string, Json::Value>& match) override {
    std::optional<std::int64_t> highest;
    for (const Row& row : feed(txn, scope, FeedQuery{.aliveOnly = true})) {
      const bool matches = std::all_of(match.begin(), match.end(), [&row](const auto& entry) {
        const auto reg = row.lattice.f.find(entry.first);
        return jcs(reg == row.lattice.f.end() ? Json::Value() : reg->second.value) == jcs(entry.second);
      });
      const auto value = row.v.find(field);
      if (matches && value != row.v.end()) highest = std::max(highest.value_or(value->second.asInt64()), value->second.asInt64());
    }
    return highest;
  }

  std::optional<std::string> revisionText(SyncTxn& txn, const ScopeKey& scope, const RecordId& id, const std::string& field, Seq rev) override {
    const auto text = dbOf(txn).revisions.find({RecordRef{scope, type_.name, id}, field, rev});
    return text == dbOf(txn).revisions.end() ? std::nullopt : std::optional(text->second);
  }

  void purge(SyncTxn& txn, const ScopeKey& scope) override {
    std::erase_if(dbOf(txn).rows, [&](const auto& entry) { return entry.first.scope == scope && entry.first.t == type_.name; });
    std::erase_if(dbOf(txn).revisions, [&](const auto& entry) {
      return std::get<0>(entry.first).scope == scope && std::get<0>(entry.first).t == type_.name;
    });
  }

private:
  const TypeDef& type_;
  std::size_t revisionsKept_;
};

class FakeProbeReceipts final : public probe::ProbeReceipts {
public:
  std::optional<std::string> startedRun(SyncTxn& txn, const ScopeKey& scope, const std::string& called) override {
    return find(dbOf(txn).startReceipts, scope, called);
  }
  void recordStart(SyncTxn& txn, const ScopeKey& scope, const std::string& called, const std::string& resolved) override {
    dbOf(txn).startReceipts.insert_or_assign({scope, called}, resolved);
  }
  std::optional<std::string> copiedFrom(SyncTxn& txn, const ScopeKey& scope, const std::string& destination) override {
    return find(dbOf(txn).copyReceipts, scope, destination);
  }
  void recordCopy(SyncTxn& txn, const ScopeKey& scope, const std::string& destination, const std::string& source) override {
    dbOf(txn).copyReceipts.insert_or_assign({scope, destination}, source);
  }

private:
  static std::optional<std::string> find(const std::map<std::pair<ScopeKey, std::string>, std::string>& book, const ScopeKey& scope,
                                         const std::string& key) {
    const auto found = book.find({scope, key});
    return found == book.end() ? std::nullopt : std::optional(found->second);
  }
};

// Every frame the engine queued on one live socket, in order.
class RecordingSocket final : public LiveSocket {
public:
  void send(const Json::Value& frame) override { frames.append(frame); }

  Json::Value frames = Json::Value(Json::arrayValue);
};

// Every change a committed admission published, in order.
class RecordingChangeFeed final : public ChangeFeed {
public:
  void publish(const CommittedChange& change) override {
    std::lock_guard lock(mutex_);
    published.push_back(change);
  }
  std::vector<CommittedChange> published;

private:
  std::mutex mutex_;
};

class RecordingFailures final : public FailureReporter {
public:
  void report(const std::string& kind, const std::string& where, const std::string& detail) override {
    std::lock_guard lock(mutex_);
    reports.push_back(kind + " " + where + " " + detail);
  }
  std::vector<std::string> reports;

private:
  std::mutex mutex_;
};

}
