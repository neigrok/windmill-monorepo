#include "platform/adapters/postgres/PgSyncStore.h"

#include "platform/domain/sync/Admit.h"
#include "platform/domain/sync/Jcs.h"

#include <algorithm>
#include <stdexcept>
#include <utility>

namespace wm::sync {

namespace {

// pqxx names a result row row_ref on macOS and row on CI's Linux, so every row is read through these.
template <typename R>
std::string text(const R& row, const char* column) {
  return row[column].template as<std::string>();
}

template <typename R>
std::optional<std::string> maybeText(const R& row, const char* column) {
  if (row[column].is_null()) return std::nullopt;
  return row[column].template as<std::string>();
}

template <typename R>
std::uint64_t unsignedOf(const R& row, const char* column) {
  return row[column].template as<std::uint64_t>();
}

Digest256 digestOf(const std::string& hex) {
  const std::optional<Digest256> digest = Digest256::fromHex(hex);
  if (!digest) throw std::logic_error("a stored digest is not 32 bytes");
  return *digest;
}

std::string lockClause(RowLock lock) {
  switch (lock) {
    case RowLock::none: return "";
    case RowLock::keyShare: return " for key share";
    case RowLock::share: return " for share";
    case RowLock::noKeyUpdate: return " for no key update";
    case RowLock::update: return " for update";
  }
  return "";
}

std::string kindName(ScopeKind kind) {
  if (kind == ScopeKind::tree) return "tree";
  if (kind == ScopeKind::overlay) return "overlay";
  return "product";
}

template <typename R>
ScopeRow scopeRowOf(const R& row) {
  ScopeRow scope{.key = *ScopeKey::parse(text(row, "key")), .owner = UserId{text(row, "owner")}};
  scope.governedBy = maybeText(row, "governed_by");
  scope.dead = text(row, "state") == "dead";
  if (!row["dead_at"].is_null()) scope.deadAt = unsignedOf(row, "dead_at");
  scope.seq = unsignedOf(row, "seq");
  const Json::Value counters = parseJson(text(row, "counters"));
  for (const std::string& type : counters.getMemberNames()) scope.counters[type] = counters[type].asInt64();
  scope.digest = digestOf(text(row, "digest"));
  scope.open = row["open"].template as<bool>();
  return scope;
}

template <typename R>
Row spentOf(const R& row, const TypeDef& type) {
  const RecordId id = RecordId::fromColumn(text(row, "id"), !type.keyTuple.empty());
  std::optional<Stamp> born;
  if (const std::optional<std::string> stamp = maybeText(row, "born")) born = stampOf(Json::Value(*stamp));
  return spentRow(type.name, id, born, stampOf(Json::Value(text(row, "life_stamp"))), unsignedOf(row, "seq"));
}

template <typename R>
RequestRow requestOf(const R& row) {
  RequestRow request{.requestId = text(row, "request_id"), .digest = digestOf(text(row, "digest"))};
  request.running = text(row, "state") == "running";
  if (const std::optional<std::string> result = maybeText(row, "result")) request.result = parseJson(*result);
  request.startedAt = unsignedOf(row, "started_at");
  return request;
}

std::optional<std::string> jsonText(const std::optional<Json::Value>& value) {
  if (!value) return std::nullopt;
  return jcs(*value);
}

// A spent-id keyset (§2.3 FeedQuery) as SQL over sync_spent, from placeholder $4 on.
std::string spentKeyset(pqxx::params& params, const TypeDef& type, const FeedQuery& query) {
  const std::string order = idOrder("id", !type.keyTuple.empty());
  std::string where = " and (seq > $3 or (seq = $3 and " + order + " > $4))";
  params.append(static_cast<std::int64_t>(query.afterSeq));
  params.append(query.afterKey);
  if (query.throughSeq) {
    params.append(static_cast<std::int64_t>(*query.throughSeq));
    where += " and seq <= $5";
  }
  return where;
}

}

PgSyncTxn::PgSyncTxn(PgPool& pool, TxnMode mode, std::uint64_t lockTimeoutMs) : lease_(pool) {
  if (mode == TxnMode::snapshot) {
    txn_ = std::make_unique<pqxx::transaction<pqxx::isolation_level::repeatable_read, pqxx::write_policy::read_only>>(*lease_);
    return;
  }
  txn_ = std::make_unique<pqxx::work>(*lease_);
  txn_->exec("set local lock_timeout = '" + std::to_string(lockTimeoutMs) + "ms'");
}

void PgSyncTxn::commit() {
  txn_->commit();
}

pqxx::transaction_base& sqlOf(SyncTxn& txn) {
  auto* pg = dynamic_cast<PgSyncTxn*>(&txn);
  if (!pg) throw std::logic_error("a Postgres sync store was handed a transaction of another backend");
  return pg->sql();
}

const std::string& pgText(const std::string& text) {
  if (text.find('\0') != std::string::npos) throw std::invalid_argument("a text value holds U+0000, which Postgres text cannot store");
  return text;
}

std::string idPlaceholders(pqxx::params& params, const std::vector<RecordId>& ids, int first) {
  std::string list;
  for (std::size_t i = 0; i < ids.size(); ++i) {
    if (i > 0) list += ", ";
    list += "$" + std::to_string(first + static_cast<int>(i));
    params.append(pgText(ids[i].column()));
  }
  return list;
}

std::string idOrder(const std::string& column, bool tupleIds) {
  if (tupleIds) return column + " collate \"C\"";
  return "(to_json(" + column + ")::text) collate \"C\"";
}

PgSyncStore::PgSyncStore(std::shared_ptr<PgPool> pool, std::uint64_t lockTimeoutMs) : pool_(std::move(pool)), lockTimeoutMs_(lockTimeoutMs) {}

std::unique_ptr<SyncTxn> PgSyncStore::begin(TxnMode mode) {
  return std::make_unique<PgSyncTxn>(*pool_, mode, lockTimeoutMs_);
}

FaultClass PgSyncStore::classify(const std::exception& error) const {
  if (dynamic_cast<const pqxx::broken_connection*>(&error) || dynamic_cast<const PgPoolExhausted*>(&error)) return FaultClass::transient;
  if (const auto* sql = dynamic_cast<const pqxx::sql_error*>(&error)) {
    const std::string state{sql->sqlstate()};
    if (state == "40001" || state == "40P01" || state == "55P03" || state == "57P01") return FaultClass::transient;
  }
  return FaultClass::fault;
}

std::string PgSyncStore::epoch(SyncTxn& txn) {
  const pqxx::result rows = sqlOf(txn).exec("select epoch from sync_meta");
  return text(rows[0], "epoch");
}

std::string PgSyncStore::ownerName(SyncTxn& txn, const UserId& owner) {
  const pqxx::result rows = sqlOf(txn).exec("select name from users where id = $1::uuid", pqxx::params{owner.str()});
  return rows.empty() ? "" : text(rows[0], "name");
}

bool PgSyncStore::insertScope(SyncTxn& txn, const ScopeKey& key, const UserId& owner, const std::optional<std::string>& governedBy) {
  const pqxx::result inserted = sqlOf(txn).exec(
      "insert into sync_scopes (key, kind, owner, governed_by) values ($1, $2, $3::uuid, $4) on conflict (key) do nothing",
      pqxx::params{key.text(), kindName(key.kind()), owner.str(), governedBy});
  return inserted.affected_rows() == 1;
}

std::optional<ScopeRow> PgSyncStore::scope(SyncTxn& txn, const ScopeKey& key, RowLock lock) {
  const pqxx::result rows = sqlOf(txn).exec(
      "select key, owner::text as owner, governed_by, state, dead_at, seq, counters::text as counters, encode(digest, 'hex') as digest, open "
      "from sync_scopes where key = $1" + lockClause(lock),
      pqxx::params{key.text()});
  if (rows.empty()) return std::nullopt;
  return scopeRowOf(rows[0]);
}

void PgSyncStore::saveScope(SyncTxn& txn, const ScopeRow& row) {
  Json::Value counters(Json::objectValue);
  for (const auto& [type, count] : row.counters) counters[type] = Json::Int64(count);
  sqlOf(txn).exec("update sync_scopes set seq = $2, counters = $3::jsonb, digest = decode($4, 'hex'), open = $5 where key = $1",
                  pqxx::params{row.key.text(), static_cast<std::int64_t>(row.seq), jcs(counters), row.digest.hex(), row.open});
}

std::vector<ScopeKey> PgSyncStore::killTree(SyncTxn& txn, const ScopeKey& tree, Ms now) {
  pqxx::transaction_base& sql = sqlOf(txn);
  sql.exec("select key from sync_scopes where key = $1 for update", pqxx::params{tree.text()});
  const pqxx::result overlays =
      sql.exec("select key from sync_scopes where governed_by = $1 order by key collate \"C\" for update", pqxx::params{tree.text()});
  const pqxx::result killed = sql.exec(
      "update sync_scopes set state = 'dead', dead_at = $2 where (key = $1 or governed_by = $1) and state = 'alive' returning key",
      pqxx::params{tree.text(), static_cast<std::int64_t>(now)});
  std::vector<ScopeKey> keys;
  for (const auto& row : killed) keys.push_back(*ScopeKey::parse(text(row, "key")));
  std::sort(keys.begin(), keys.end());
  return keys;
}

ReplicaRow PgSyncStore::bindReplica(SyncTxn& txn, const std::string& replica, const UserId& account, Ms now) {
  const pqxx::result rows = sqlOf(txn).exec(
      "insert into sync_replicas (replica, account, last_n, last_seen) values ($1, $2::uuid, 0, $3) "
      "on conflict (replica) do update set last_seen = excluded.last_seen "
      "returning replica, account::text as account, last_n",
      pqxx::params{pgText(replica), account.str(), static_cast<std::int64_t>(now)});
  return ReplicaRow{text(rows[0], "replica"), UserId{text(rows[0], "account")}, unsignedOf(rows[0], "last_n")};
}

std::optional<ReplicaRow> PgSyncStore::replica(SyncTxn& txn, const std::string& replica, RowLock lock) {
  const pqxx::result rows = sqlOf(txn).exec("select replica, account::text as account, last_n from sync_replicas where replica = $1" + lockClause(lock),
                                            pqxx::params{pgText(replica)});
  if (rows.empty()) return std::nullopt;
  return ReplicaRow{text(rows[0], "replica"), UserId{text(rows[0], "account")}, unsignedOf(rows[0], "last_n")};
}

void PgSyncStore::unbindUnused(SyncTxn& txn, const std::string& replica) {
  sqlOf(txn).exec("delete from sync_replicas where replica = $1 and last_n = 0 and not exists (select 1 from sync_results where replica = $1)",
                  pqxx::params{pgText(replica)});
}

void PgSyncStore::setLastN(SyncTxn& txn, const std::string& replica, std::uint64_t n) {
  sqlOf(txn).exec("update sync_replicas set last_n = $2 where replica = $1", pqxx::params{pgText(replica), static_cast<std::int64_t>(n)});
}

std::optional<StoredResult> PgSyncStore::storedResult(SyncTxn& txn, const std::string& replica, std::uint64_t n) {
  const pqxx::result rows = sqlOf(txn).exec(
      "select n, encode(digest, 'hex') as digest, result::text as result, faults from sync_results where replica = $1 and n = $2",
      pqxx::params{pgText(replica), static_cast<std::int64_t>(n)});
  if (rows.empty()) return std::nullopt;
  StoredResult stored{.n = unsignedOf(rows[0], "n"), .digest = digestOf(text(rows[0], "digest"))};
  if (const std::optional<std::string> result = maybeText(rows[0], "result")) stored.result = parseJson(*result);
  stored.faults = rows[0]["faults"].as<int>();
  return stored;
}

void PgSyncStore::putResult(SyncTxn& txn, const std::string& replica, const StoredResult& result) {
  sqlOf(txn).exec(
      "insert into sync_results (replica, n, digest, result, faults) values ($1, $2, decode($3, 'hex'), $4::jsonb, $5) "
      "on conflict (replica, n) do update set digest = excluded.digest, result = excluded.result, faults = excluded.faults",
      pqxx::params{pgText(replica), static_cast<std::int64_t>(result.n), result.digest.hex(), jsonText(result.result), result.faults});
}

void PgSyncStore::pruneResults(SyncTxn& txn, const std::string& replica, std::uint64_t through) {
  sqlOf(txn).exec("delete from sync_results where replica = $1 and n <= $2", pqxx::params{pgText(replica), static_cast<std::int64_t>(through)});
}

std::map<std::string, Row> PgSyncStore::spentIn(SyncTxn& txn, const ScopeKey& scope, const TypeDef& type, const std::vector<RecordId>& ids) {
  std::map<std::string, Row> found;
  if (ids.empty()) return found;
  pqxx::params params{scope.text(), type.name};
  const std::string list = idPlaceholders(params, ids, 3);
  const pqxx::result rows = sqlOf(txn).exec(
      "select id, born, life_stamp, seq from sync_spent where scope_key = $1 and type = $2 and id in (" + list + ")", params);
  for (const auto& row : rows) {
    Row spent = spentOf(row, type);
    found.emplace(spent.id.key(), std::move(spent));
  }
  return found;
}

std::set<std::string> PgSyncStore::spentElsewhere(SyncTxn& txn, const ScopeKey& scope, const TypeDef& type, const std::vector<RecordId>& ids) {
  std::set<std::string> found;
  if (ids.empty()) return found;
  pqxx::params params{scope.text(), type.name};
  const std::string list = idPlaceholders(params, ids, 3);
  const pqxx::result rows =
      sqlOf(txn).exec("select id from sync_spent where scope_key <> $1 and type = $2 and id in (" + list + ")", params);
  for (const auto& row : rows) found.insert(RecordId::fromColumn(text(row, "id"), !type.keyTuple.empty()).key());
  return found;
}

void PgSyncStore::addSpent(SyncTxn& txn, const ScopeKey& scope, const Row& thin) {
  std::optional<std::string> born;
  if (thin.lattice.born) born = toString(*thin.lattice.born);
  sqlOf(txn).exec(
      "insert into sync_spent (scope_key, type, id, born, life_stamp, seq) values ($1, $2, $3, $4, $5, $6) "
      "on conflict (scope_key, type, id) do update set born = excluded.born, life_stamp = excluded.life_stamp, seq = excluded.seq",
      pqxx::params{scope.text(), thin.t, pgText(thin.id.column()), born, toString(thin.lattice.life->stamp), static_cast<std::int64_t>(thin.seq)});
}

void PgSyncStore::removeSpent(SyncTxn& txn, const ScopeKey& scope, const TypeDef& type, const RecordId& id) {
  sqlOf(txn).exec("delete from sync_spent where scope_key = $1 and type = $2 and id = $3", pqxx::params{scope.text(), type.name, pgText(id.column())});
}

std::vector<Row> PgSyncStore::feedSpent(SyncTxn& txn, const ScopeKey& scope, const TypeDef& type, const FeedQuery& query) {
  pqxx::params params{scope.text(), type.name};
  const std::string where = spentKeyset(params, type, query);
  std::string sql = "select id, born, life_stamp, seq from sync_spent where scope_key = $1 and type = $2" + where + " order by seq, " +
                    idOrder("id", !type.keyTuple.empty());
  if (query.limit > 0) sql += " limit " + std::to_string(query.limit);
  std::vector<Row> rows;
  for (const auto& row : sqlOf(txn).exec(sql, params)) rows.push_back(spentOf(row, type));
  return rows;
}

std::uint64_t PgSyncStore::countSpent(SyncTxn& txn, const ScopeKey& scope, const TypeDef& type, const FeedQuery& query) {
  pqxx::params params{scope.text(), type.name};
  const std::string where = spentKeyset(params, type, query);
  const pqxx::result rows = sqlOf(txn).exec("select count(*) as total from sync_spent where scope_key = $1 and type = $2" + where, params);
  return unsignedOf(rows[0], "total");
}

void PgSyncStore::lockIds(SyncTxn& txn, const std::vector<std::pair<std::string, std::string>>& typeIds) {
  for (const auto& [type, id] : typeIds) {
    sqlOf(txn).exec("select pg_advisory_xact_lock(hashtext('sync-id:' || $1), hashtext($2))", pqxx::params{type, pgText(id)});
  }
}

void PgSyncStore::lockRequest(SyncTxn& txn, const UserId& account, const std::string& requestId) {
  sqlOf(txn).exec("select pg_advisory_xact_lock(hashtext('sync-req:' || $1), hashtext($2))", pqxx::params{account.str(), pgText(requestId)});
}

std::optional<RequestRow> PgSyncStore::request(SyncTxn& txn, const UserId& account, const std::string& requestId) {
  const pqxx::result rows = sqlOf(txn).exec(
      "select request_id, encode(digest, 'hex') as digest, state, result::text as result, started_at "
      "from sync_requests where account = $1::uuid and request_id = $2",
      pqxx::params{account.str(), pgText(requestId)});
  if (rows.empty()) return std::nullopt;
  return requestOf(rows[0]);
}

void PgSyncStore::putRequest(SyncTxn& txn, const UserId& account, const RequestRow& row) {
  sqlOf(txn).exec(
      "insert into sync_requests (account, request_id, digest, state, result, started_at) "
      "values ($1::uuid, $2, decode($3, 'hex'), $4, $5::jsonb, $6) "
      "on conflict (account, request_id) do update set digest = excluded.digest, state = excluded.state, result = excluded.result, "
      "started_at = excluded.started_at",
      pqxx::params{account.str(), pgText(row.requestId), row.digest.hex(), std::string(row.running ? "running" : "done"), jsonText(row.result),
                   static_cast<std::int64_t>(row.startedAt)});
}

}
