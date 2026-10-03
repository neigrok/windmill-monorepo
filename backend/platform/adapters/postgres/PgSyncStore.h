#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/ports/SyncStore.h"

#include <pqxx/pqxx>

#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace wm::sync {

// One engine transaction on one pooled connection: the lease is declared before the transaction, so the
// transaction destructs first and can still roll back (backend/CLAUDE.md). A write transaction is READ
// COMMITTED with the engine's lock_timeout; a snapshot is REPEATABLE READ READ ONLY and takes no row locks.
class PgSyncTxn final : public SyncTxn {
public:
  PgSyncTxn(PgPool& pool, TxnMode mode, std::uint64_t lockTimeoutMs,
            const std::optional<std::string>& snapshot = std::nullopt);
  void commit() override;
  pqxx::transaction_base& sql() { return *txn_; }
  // Product receipts can snapshot materialized rows in this transaction. A failure rolls back
  // the receipt and admission together; a refused admission destroys its callbacks with its txn.
  void beforeCommit(std::function<void()> callback);

private:
  PgLease lease_;
  std::unique_ptr<pqxx::transaction_base> txn_;
  std::vector<std::function<void()>> beforeCommit_;
};

// The SQL behind an engine transaction, for a product's Postgres store. Throws std::logic_error when the
// transaction is not a PgSyncTxn: a process never mixes backends.
pqxx::transaction_base& sqlOf(SyncTxn& txn);

// A text value bound as a Postgres parameter. libpq passes text parameters as C strings, so a U+0000 would
// silently cut the value short; Postgres text cannot hold it either. Throws std::invalid_argument (a fault,
// §6.6) instead, so no value is ever stored truncated.
const std::string& pgText(const std::string& text);

// `$first, $first + 1, ...`: one placeholder per id, whose column forms (guarded by pgText) go into `params`.
std::string idPlaceholders(pqxx::params& params, const std::vector<RecordId>& ids, int first);

// §6.1 step 3's order and a column that holds ids: the JCS of a string id, which is how records of one type
// order (§9.1); a tuple id's column already holds its JCS.
std::string idOrder(const std::string& column, bool tupleIds);

// The engine's own tables (§2.1) in Postgres.
class PgSyncStore final : public SyncStore {
public:
  // An exported snapshot stays valid while its source transaction remains open.
  PgSyncStore(std::shared_ptr<PgPool> pool, std::uint64_t lockTimeoutMs,
              std::optional<std::string> snapshot = std::nullopt);

  std::unique_ptr<SyncTxn> begin(TxnMode mode) override;
  // Transient: a lost connection, an exhausted pool, serialization failure (40001), deadlock (40P01),
  // lock_not_available from lock_timeout (55P03), admin shutdown (57P01). Anything else is a fault,
  // statement_timeout (57014) included (§6.6).
  FaultClass classify(const std::exception& error) const override;
  std::string epoch(SyncTxn&) override;
  std::string ownerName(SyncTxn&, const UserId& owner) override;

  bool insertScope(SyncTxn&, const ScopeKey& key, const UserId& owner, const std::optional<std::string>& governedBy) override;
  std::optional<ScopeRow> scope(SyncTxn&, const ScopeKey& key, RowLock lock) override;
  void saveScope(SyncTxn&, const ScopeRow& row) override;
  std::vector<ScopeKey> killTree(SyncTxn&, const ScopeKey& tree, Ms now) override;

  ReplicaRow bindReplica(SyncTxn&, const std::string& replica, const UserId& account, Ms now) override;
  std::optional<ReplicaRow> replica(SyncTxn&, const std::string& replica, RowLock lock) override;
  void unbindUnused(SyncTxn&, const std::string& replica) override;
  void setLastN(SyncTxn&, const std::string& replica, std::uint64_t n) override;
  std::optional<StoredResult> storedResult(SyncTxn&, const std::string& replica, std::uint64_t n) override;
  void putResult(SyncTxn&, const std::string& replica, const StoredResult& result) override;
  void pruneResults(SyncTxn&, const std::string& replica, std::uint64_t through) override;

  std::map<std::string, Row> spentIn(SyncTxn&, const ScopeKey& scope, const TypeDef& type, const std::vector<RecordId>& ids) override;
  std::set<std::string> spentElsewhere(SyncTxn&, const ScopeKey& scope, const TypeDef& type, const std::vector<RecordId>& ids) override;
  void addSpent(SyncTxn&, const ScopeKey& scope, const Row& thin) override;
  void removeSpent(SyncTxn&, const ScopeKey& scope, const TypeDef& type, const RecordId& id) override;
  std::vector<Row> feedSpent(SyncTxn&, const ScopeKey& scope, const TypeDef& type, const FeedQuery& query) override;
  std::uint64_t countSpent(SyncTxn&, const ScopeKey& scope, const TypeDef& type, const FeedQuery& query) override;

  void lockIds(SyncTxn&, const std::vector<std::pair<std::string, std::string>>& typeIds) override;
  void lockRequest(SyncTxn&, const UserId& account, const std::string& requestId) override;
  std::optional<RequestRow> request(SyncTxn&, const UserId& account, const std::string& requestId) override;
  void putRequest(SyncTxn&, const UserId& account, const RequestRow& row) override;

private:
  std::shared_ptr<PgPool> pool_;
  std::uint64_t lockTimeoutMs_;
  std::optional<std::string> snapshot_;
};

}
