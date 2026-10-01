#include "products/gym/sync/adapters/postgres/PgGymBackfill.h"

#include "products/gym/sync/adapters/postgres/PgGym.h"
#include "products/gym/sync/GymRegistry.h"
#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/domain/sync/Admit.h"
#include "platform/domain/sync/Jcs.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <stdexcept>

namespace wm::gym::engine {

using namespace sync;

namespace {

struct Table {
  std::string type;
  std::string name;
  std::string owner = "user_id";
};

const std::array<Table, 9> tables{{{"routine", "gym_routines"}, {"exercise", "gym_exercises", "created_by"},
  {"exerciseName", "gym_exercise_names"}, {"session", "gym_sessions"}, {"set", "gym_sets"},
  {"note", "gym_notes"}, {"weighin", "gym_bodyweight"}, {"prefs", "gym_preferences"}, {"proposal", "gym_proposals"}}};

std::string snake(const std::string& field) {
  std::string result;
  for (unsigned char c : field) {
    if (std::isupper(c)) result += '_';
    result += static_cast<char>(std::tolower(c));
  }
  return result;
}

void requireSchema(SyncTxn& txn) {
  auto& sql = sqlOf(txn);
  auto requireColumn = [&](const std::string& table, const std::string& column, const std::string& type) {
    const auto found = sql.exec("select a.atttypid::regtype::text from pg_attribute a where a.attrelid=to_regclass($1) and a.attname=$2 and not a.attisdropped", pqxx::params{table, column});
    if (found.size() != 1 || found[0][0].as<std::string>() != type)
      throw std::runtime_error("C.1 adoption schema missing or incompatible: " + table + "." + column + " (apply db/gym_sync.sql under the freeze)");
  };
  requireColumn("sync_meta", "epoch", "text");
  requireColumn("sync_scopes", "digest", "bytea");
  requireColumn("sync_spent", "life_stamp", "text");
  for (const Table& table : tables) {
    const TypeDef& type = *registry().type(table.type);
    for (const std::string col : {"seq", "rc", "ru"}) requireColumn(table.name, col, "bigint");
    if (type.identity == Identity::minted) requireColumn(table.name, "born", "text");
    if (type.life) requireColumn(table.name, "life_stamp", "text");
    for (const auto& [name, field] : type.fields) if (field.kind != FieldKind::serial) requireColumn(table.name, snake(name) + "_stamp", "text");
    const auto indexed = sql.exec("select 1 from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=i.indkey[0] "
                                  "join pg_attribute b on b.attrelid=i.indrelid and b.attnum=i.indkey[1] "
                                  "where i.indrelid=to_regclass($1) and i.indisvalid and i.indpred is null and a.attname=$2 and b.attname='seq'", pqxx::params{table.name, table.owner});
    if (indexed.empty()) throw std::runtime_error("C.1 adoption feed index missing: " + table.name);
  }
  requireColumn("gym_notes", "ord", "text");
  requireColumn("gym_exercise_aliases", "sync_positions", "jsonb");
  for (const char* col : {"rest_seconds_present", "sets_present"}) requireColumn("gym_routine_entries", col, "boolean");
  for (const char* col : {"reps_present", "weight_kg_present"}) requireColumn("gym_routine_entry_sets", col, "boolean");
  for (const char* col : {"before_present", "after_present", "before_rest_present", "after_rest_present", "before_sets_present", "after_sets_present"}) requireColumn("gym_proposal_changes", col, "boolean");
  requireColumn("gym_write_receipts", "sync_kind", "text");
  requireColumn("gym_write_receipts", "sync_args", "jsonb");
  requireColumn("gym_correction_receipts", "sync_args", "jsonb");
  if (!sql.exec("select 1 from pg_attribute where attrelid='gym_exercise_names'::regclass and attname='name' and attnotnull").empty())
    throw std::runtime_error("C.1 exerciseName.name must be nullable for alias-only seeds");
  if (!sql.exec("select 1 from pg_trigger where tgrelid='gym_sessions'::regclass and tgname='gym_session_routine_identity' and not tgisinternal").empty())
    throw std::runtime_error("C.1 gym_session_routine_identity trigger must be dropped");
  const auto fks = sql.exec("select conname,condeferrable,condeferred,confdeltype::text from pg_constraint where connamespace=current_schema()::regnamespace and conname in "
    "('gym_sets_session_id_fkey','gym_sets_exercise_id_fkey','gym_routine_entries_exercise_id_fkey','gym_proposal_changes_exercise_id_fkey','gym_sessions_routine_id_fkey',"
    "'gym_proposals_routine_id_fkey','gym_proposals_thread_id_fkey','gym_exercise_names_exercise_id_fkey','gym_exercise_aliases_exercise_id_fkey')");
  if (fks.size() != 9) throw std::runtime_error("C.1 adoption foreign keys missing");
  for (const auto& fk : fks) if (!fk["condeferrable"].as<bool>() || !fk["condeferred"].as<bool>() || fk["confdeltype"].as<std::string>() != "a")
    throw std::runtime_error("C.1 foreign key must defer without ON DELETE writes: " + fk["conname"].as<std::string>());
}

std::vector<std::string> accounts(SyncTxn& txn, const std::optional<std::string>& account) {
  std::string query;
  for (const Table& table : tables) {
    if (!query.empty()) query += " union ";
    query += "select " + table.owner + " as account from " + table.name + " where " + table.owner + " is not null";
  }
  for (const char* table : {"gym_exercise_aliases", "gym_set_revisions", "gym_write_receipts", "gym_routine_creations", "gym_note_saves"}) {
    query += " union select user_id from " + std::string(table);
    if (std::string(table) == "gym_set_revisions") query += " where deleted";
  }
  query += " union select owner from sync_scopes where kind='product' and key='acct:'||owner::text||'/gym'";
  query = "select account::text from (" + query + ") owners";
  pqxx::params params;
  if (account) { query += " where account=$1::uuid"; params.append(*account); }
  query += " order by account";
  std::vector<std::string> out;
  for (const auto& row : sqlOf(txn).exec(query, params)) out.push_back(row[0].template as<std::string>());
  return out;
}

std::vector<Row> spentRows(SyncTxn& txn, const ScopeKey& scope, const Stamp& stamp) {
  const auto result = sqlOf(txn).exec(
    "select 'set' as type, id from (select set_id as id from gym_set_revisions where user_id=$1::uuid and deleted union select id from gym_write_receipts where user_id=$1::uuid and kind='set') ids "
    "where not exists(select 1 from gym_sets s where s.id=ids.id) union "
    "select 'session', id from gym_write_receipts r where user_id=$1::uuid and kind='session' and not exists(select 1 from gym_sessions s where s.id=r.id) union "
    "select 'routine', routine_id from gym_routine_creations c where user_id=$1::uuid and not exists(select 1 from gym_routines r where r.id=c.routine_id) union "
    "select 'note', id from gym_note_saves n where user_id=$1::uuid and not exists(select 1 from gym_notes r where r.id=n.id)", pqxx::params{scope.account().str()});
  std::vector<Row> out;
  for (const auto& resultRow : result) out.push_back(spentRow(resultRow[0].template as<std::string>(), RecordId(resultRow[1].template as<std::string>()), stamp, stamp, 0));
  return out;
}

Json::Value report(const ScopeRow& scope, std::uint64_t rows, std::uint64_t spent, std::uint64_t changed) {
  Json::Value out(Json::objectValue);
  out["account"] = scope.owner.str();
  out["scope"] = scope.key.text();
  out["rows"] = Json::UInt64(rows);
  out["spent"] = Json::UInt64(spent);
  out["changed"] = Json::UInt64(changed);
  out["seq"] = Json::UInt64(scope.seq);
  out["digest"] = scope.digest.hex();
  return out;
}

Json::Value checkScope(SyncTxn& txn, PgSyncStore& store, const ScopeRow& scope) {
  Digest256 digest;
  Seq greatest = 0;
  std::uint64_t rows = 0, spent = 0;
  for (const TypeDef& type : registry().types()) {
    PgGymType typeStore(type);
    for (const Row& row : typeStore.feed(txn, scope.key, FeedQuery{})) {
      digest = digest + rowHash(row.toJson());
      greatest = std::max(greatest, row.seq);
      ++rows;
    }
    for (const Row& row : store.feedSpent(txn, scope.key, type, FeedQuery{})) {
      greatest = std::max(greatest, row.seq);
      ++spent;
    }
  }
  Json::Value out = report(scope, rows, spent, 0);
  out["computedDigest"] = digest.hex();
  out["greatestSeq"] = Json::UInt64(greatest);
  out["audit"] = digest == scope.digest && greatest == scope.seq;
  if (!out["audit"].asBool()) throw std::runtime_error("C.8 digest/seq audit failed: " + jcs(out));
  return out;
}

}

std::vector<Json::Value> PgGymBackfill::run(Ms migrationTime, bool dryRun, std::optional<std::string> account,
                                         const std::function<void(const Json::Value&)>& onAccount) {
  PgSyncStore store(pool_, Limits{}.lockTimeoutMs);
  std::vector<std::string> owners;
  {
    auto txn = store.begin(dryRun ? TxnMode::snapshot : TxnMode::write);
    requireSchema(*txn);
    owners = accounts(*txn, account);
    if (!dryRun) {
      sqlOf(*txn).exec("insert into sync_meta(epoch) values(replace(gen_random_uuid()::text,'-','')) "
                       "on conflict(one) do update set epoch=excluded.epoch where sync_meta.epoch=''");
      txn->commit();
    }
  }
  std::vector<Json::Value> reports;
  const Stamp stamp = stampOf(std::to_string(migrationTime) + ":0:srv");
  for (const std::string& owner : owners) {
    auto txn = store.begin(dryRun ? TxnMode::snapshot : TxnMode::write);
    auto& sql = sqlOf(*txn);
    const ScopeKey key = ScopeKey::product(UserId(owner), "gym");
    if (!dryRun) sql.exec("select pg_advisory_xact_lock(hashtext('gym-backfill'),hashtext($1))", pqxx::params{owner});
    if (const auto existing = store.scope(*txn, key, RowLock::none)) {
      Json::Value out = checkScope(*txn, store, *existing);
      out["skipped"] = true;
      out["dryRun"] = dryRun;
      reports.push_back(std::move(out));
      if (onAccount) onAccount(reports.back());
      continue;
    }
    ScopeRow scope{.key = key, .owner = UserId(owner)};
    std::map<std::string, std::vector<Row>> records;
    std::vector<Row> spent = spentRows(*txn, key, stamp);
    std::uint64_t count = 0;
    for (const TypeDef& type : registry().types()) {
      PgGymType typeStore(type);
      records[type.name] = typeStore.adoptionRows(*txn, key, migrationTime);
      count += records[type.name].size();
    }
    if (count + spent.size() == 0) continue;
    for (const TypeDef& type : registry().types()) {
      std::vector<Row*> ordered;
      for (Row& row : records[type.name]) ordered.push_back(&row);
      for (Row& row : spent) if (row.t == type.name) ordered.push_back(&row);
      std::sort(ordered.begin(), ordered.end(), [](const Row* a, const Row* b) { return a->id < b->id; });
      for (Row* row : ordered) row->seq = ++scope.seq;
      for (const Row& row : records[type.name]) scope.digest = scope.digest + rowHash(row.toJson());
    }
    if (!records["note"].empty()) scope.counters["note"] = records["note"].size();
    if (!dryRun) {
      if (!store.insertScope(*txn, key, UserId(owner), std::nullopt)) throw std::runtime_error("scope appeared during backfill: " + key.text());
      for (const TypeDef& type : registry().types()) {
        PgGymType typeStore(type);
        typeStore.adopt(*txn, key, records[type.name]);
      }
      for (const Row& row : spent) store.addSpent(*txn, key, row);
      // Hash what pull will actually serve, rather than relying on the derivation's round trip.
      scope.digest = Digest256();
      for (const TypeDef& type : registry().types()) {
        PgGymType typeStore(type);
        for (const Row& row : typeStore.feed(*txn, key, FeedQuery{})) scope.digest = scope.digest + rowHash(row.toJson());
      }
      store.saveScope(*txn, scope);
      checkScope(*txn, store, scope);
      txn->commit();
    }
    Json::Value out = report(scope, count, spent.size(), count + spent.size());
    out["migrationMs"] = Json::UInt64(migrationTime);
    out["skipped"] = false;
    out["dryRun"] = dryRun;
    reports.push_back(std::move(out));
    if (onAccount) onAccount(reports.back());
  }
  return reports;
}

std::vector<Json::Value> PgGymBackfill::audit(std::optional<std::string> account) {
  PgSyncStore store(pool_, Limits{}.lockTimeoutMs);
  auto txn = store.begin(TxnMode::snapshot);
  requireSchema(*txn);
  std::vector<Json::Value> reports;
  for (const auto& owner : accounts(*txn, account)) {
    const auto scope = store.scope(*txn, ScopeKey::product(UserId(owner), "gym"), RowLock::none);
    if (scope) reports.push_back(checkScope(*txn, store, *scope));
  }
  return reports;
}

}
