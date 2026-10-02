#include "products/gym/sync/adapters/postgres/PgGymBackfill.h"

#include "products/gym/sync/adapters/postgres/PgGym.h"
#include "products/gym/sync/GymRegistry.h"
#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/domain/sync/Admit.h"
#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/FractionalIndex.h"

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
  requireColumn("gym_sync_adoptions", "migration_ms", "bigint");
  requireColumn("gym_sync_adoptions", "frozen_source", "jsonb");
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
  query += " union select user_id from gym_sync_adoptions";
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
    "select type,id from (select 'set' as type, id from (select set_id as id from gym_set_revisions where user_id=$1::uuid and deleted union select id from gym_write_receipts where user_id=$1::uuid and kind='set') ids "
    "where not exists(select 1 from gym_sets s where s.id=ids.id) union "
    "select 'session', id from gym_write_receipts r where user_id=$1::uuid and kind='session' and not exists(select 1 from gym_sessions s where s.id=r.id) union "
    "select 'routine', routine_id from gym_routine_creations c where user_id=$1::uuid and not exists(select 1 from gym_routines r where r.id=c.routine_id) union "
    "select 'note', id from gym_note_saves n where user_id=$1::uuid and not exists(select 1 from gym_notes r where r.id=n.id)) required "
    "where not exists(select 1 from sync_spent s where s.scope_key=$2 and s.type=required.type and s.id=required.id and s.seq>0 and s.born is not null and s.life_stamp is not null)", pqxx::params{scope.account().str(), scope.text()});
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

Json::Value frozenSource(SyncTxn& txn, const ScopeKey& scope) {
  auto& sql = sqlOf(txn);
  sql.exec("set local timezone='UTC'");
  Json::Value source(Json::objectValue);
  auto capture = [&](const std::string& table, const std::string& predicate, bool created = false, bool updated = false) {
    std::string select = "to_jsonb(t)";
    if (created) select += "||jsonb_build_object('created_at_ms',(extract(epoch from created_at)*1000)::bigint)";
    if (updated) select += "||jsonb_build_object('updated_at_ms',(extract(epoch from updated_at)*1000)::bigint)";
    source[table] = Json::Value(Json::arrayValue);
    for (const auto& row : sql.exec("select (" + select + ")::text from " + table + " t where " + predicate + " order by to_jsonb(t)::text collate \"C\"", pqxx::params{scope.account().str()})) {
      Json::Value raw = parseJson(row[0].template as<std::string>());
      for (const auto& name : raw.getMemberNames()) {
        if (name == "seq" || name == "rc" || name == "ru" || name == "born" || name == "life_stamp" || name == "ord" ||
            name.ends_with("_stamp") || name.ends_with("_present")) raw.removeMember(name);
      }
      source[table].append(std::move(raw));
    }
  };
  for (const auto& table : tables) {
    const bool created = table.type == "routine" || table.type == "exercise" || table.type == "proposal" || table.type == "note";
    const bool updated = table.type == "exerciseName" || table.type == "weighin" || table.type == "prefs" || table.type == "note";
    capture(table.name, table.owner + "=$1::uuid", created, updated);
  }
  capture("gym_exercise_aliases", "user_id=$1::uuid", true);
  for (const char* table : {"gym_proposal_changes", "gym_write_receipts", "gym_correction_receipts",
                           "gym_set_revisions", "gym_routine_creations", "gym_note_saves"}) capture(table, "user_id=$1::uuid");
  for (const char* table : {"gym_routine_entries", "gym_routine_entry_sets"})
    capture(table, "routine_id in(select id from gym_routines where user_id=$1::uuid)");
  source["seeds"] = Json::Value(Json::arrayValue);
  for (const auto& row : sql.exec("select id from gym_exercises where created_by is null order by id collate \"C\"")) source["seeds"].append(row[0].template as<std::string>());
  return source;
}

void auditFrozen(SyncTxn& txn, PgSyncStore& store, const ScopeRow& scope) {
  const auto marker = sqlOf(txn).exec("select migration_ms,frozen_source::text from gym_sync_adoptions where user_id=$1::uuid", pqxx::params{scope.owner.str()});
  if (marker.size() != 1) throw std::runtime_error("C.8 adoption audit failed: missing frozen source and recorded M for " + scope.key.text());
  const Ms migrationTime = marker[0][0].as<Ms>();
  const Stamp stamp = stampOf(std::to_string(migrationTime) + ":0:srv");
  const Json::Value source = parseJson(marker[0][1].as<std::string>());
  auto require = [&](bool condition, const std::string& label) {
    if (!condition) throw std::runtime_error("C.8 frozen adoption audit failed: " + scope.key.text() + " " + label);
  };
  struct Expected {
    Ms rc, ru;
    std::set<std::string> fields;
    std::map<std::string, Json::Value> values;
  };
  std::map<std::pair<std::string, std::string>, Expected> expected;
  auto aliases = [&](const std::string& id) {
    return std::any_of(source["gym_exercise_aliases"].begin(), source["gym_exercise_aliases"].end(), [&](const auto& row) { return row["exercise_id"] == id; });
  };
  auto add = [&](const Table& table, const Json::Value& raw, const std::string& id, Ms rc, Ms ru) {
    const TypeDef& type = *registry().type(table.type);
    Expected row{rc, ru, {}, {}};
    for (const auto& [name, field] : type.fields) {
      if (field.kind == FieldKind::serial) continue;
      bool present = !raw[name == "kg" && type.name == "weighin" ? "weight_kg" : snake(name)].isNull();
      if (name == "entries" || name == "changes" || name == "ord") present = true;
      if (name == "aliases") present = aliases(id);
      if (type.name == "exerciseName" && name == "name") present = !raw["name"].isNull() && raw["name"] != "";
      if (type.name == "proposal" && name == "state") present = raw["state"] != "pending";
      if (present) row.fields.insert(name);
    }
    auto ordered = [&](const std::string& tableName, const std::string& foreign, const std::string& order) {
      std::vector<Json::Value> rows;
      for (const auto& rawRow : source[tableName]) if (rawRow[foreign] == id) rows.push_back(rawRow);
      std::sort(rows.begin(), rows.end(), [&](const auto& a, const auto& b) { return a[order].asInt() < b[order].asInt(); });
      return rows;
    };
    if (row.fields.contains("aliases")) {
      row.values["aliases"] = Json::Value(Json::arrayValue);
      for (const auto& alias : sqlOf(txn).exec(
          "select name from jsonb_to_recordset($1::jsonb) as aliases(exercise_id text,name text,created_at timestamptz) "
          "where exercise_id=$2 order by created_at desc,name collate \"C\"",
          pqxx::params{jcs(source["gym_exercise_aliases"]), id})) row.values["aliases"].append(alias[0].template as<std::string>());
    }
    if (type.name == "routine") {
      row.values["entries"] = Json::Value(Json::arrayValue);
      for (const auto& rawEntry : ordered("gym_routine_entries", "routine_id", "position")) {
        Json::Value entry(Json::objectValue);
        entry["exerciseId"] = rawEntry["exercise_id"];
        if (!rawEntry["rest_seconds"].isNull()) entry["restSeconds"] = rawEntry["rest_seconds"];
        std::vector<Json::Value> sets;
        for (const auto& rawSet : source["gym_routine_entry_sets"])
          if (rawSet["routine_id"] == id && rawSet["position"] == rawEntry["position"]) sets.push_back(rawSet);
        std::sort(sets.begin(), sets.end(), [](const auto& a, const auto& b) { return a["set_index"].asInt() < b["set_index"].asInt(); });
        if (!sets.empty()) {
          entry["sets"] = Json::Value(Json::arrayValue);
          for (const auto& rawSet : sets) {
            Json::Value set(Json::objectValue);
            if (!rawSet["reps"].isNull()) set["reps"] = rawSet["reps"];
            if (!rawSet["weight_kg"].isNull()) set["weightKg"] = rawSet["weight_kg"];
            entry["sets"].append(std::move(set));
          }
        }
        row.values["entries"].append(std::move(entry));
      }
    }
    if (type.name == "proposal") {
      row.values["changes"] = Json::Value(Json::arrayValue);
      for (const auto& rawChange : ordered("gym_proposal_changes", "proposal_id", "position")) {
        Json::Value change(Json::objectValue);
        change["kind"] = rawChange["kind"];
        change["exerciseId"] = rawChange["exercise_id"];
        for (const std::string side : {"before", "after"}) {
          if (rawChange["kind"] == (side == "before" ? "added" : "removed")) continue;
          change[side] = Json::Value(Json::objectValue);
          if (!rawChange[side + "_sets"].isNull()) change[side]["sets"] = rawChange[side + "_sets"];
          if (!rawChange[side + "_rest_seconds"].isNull()) change[side]["restSeconds"] = rawChange[side + "_rest_seconds"];
        }
        row.values["changes"].append(std::move(change));
      }
    }
    expected.emplace(std::pair(type.name, id), std::move(row));
  };
  for (const auto& table : tables) for (const auto& raw : source[table.name]) {
    const std::string id = table.type == "prefs" ? "prefs" : raw[table.type == "exerciseName" ? "exercise_id" : table.type == "weighin" ? "date_local" : "id"].asString();
    const Ms ru = raw["updated_at_ms"].isNull() ? migrationTime : raw["updated_at_ms"].asUInt64();
    const Ms rc = raw["created_at_ms"].isNull() ? ru : raw["created_at_ms"].asUInt64();
    add(table, raw, id, rc, ru);
  }
  std::set<std::string> seeds;
  for (const auto& id : source["seeds"]) seeds.insert(id.asString());
  const auto names = std::find_if(tables.begin(), tables.end(), [](const auto& table) { return table.type == "exerciseName"; });
  for (const auto& alias : source["gym_exercise_aliases"]) {
    const std::string id = alias["exercise_id"].asString();
    if (seeds.contains(id) && !expected.contains({"exerciseName", id})) add(*names, Json::Value(Json::objectValue), id, migrationTime, migrationTime);
  }
  std::set<std::pair<std::string, std::string>> spent;
  auto spentCandidate = [&](const std::string& type, const Json::Value& id) {
    if (!expected.contains({type, id.asString()})) spent.emplace(type, id.asString());
  };
  for (const auto& row : source["gym_set_revisions"]) if (row["deleted"].asBool()) spentCandidate("set", row["set_id"]);
  for (const auto& row : source["gym_write_receipts"]) if (row["kind"] == "set" || row["kind"] == "session") spentCandidate(row["kind"].asString(), row["id"]);
  for (const auto& row : source["gym_routine_creations"]) spentCandidate("routine", row["routine_id"]);
  for (const auto& row : source["gym_note_saves"]) spentCandidate("note", row["id"]);
  Seq seq = 0;
  std::uint64_t noteCount = 0;
  for (const TypeDef& type : registry().types()) {
    PgGymType typeStore(type);
    std::map<std::string, Row> rows, thin;
    for (const auto& row : typeStore.feed(txn, scope.key, FeedQuery{})) rows.emplace(row.id.column(), row);
    for (const auto& row : store.feedSpent(txn, scope.key, type, FeedQuery{})) thin.emplace(row.id.column(), row);
    auto byId = [](const std::string& a, const std::string& b) { return RecordId(a) < RecordId(b); };
    std::set<std::string, decltype(byId)> ids(byId);
    for (const auto& [key, row] : expected) if (key.first == type.name) ids.insert(key.second);
    const auto rowCount = ids.size();
    for (const auto& key : spent) if (key.first == type.name) ids.insert(key.second);
    require(rows.size() == rowCount && rows.size() + thin.size() == ids.size(), type.name + " frozen row/spent identities");
    for (const auto& id : ids) {
      ++seq;
      const std::string label = type.name + "/" + id;
      const auto frozen = expected.find({type.name, id});
      if (frozen == expected.end()) {
        require(thin.contains(id), label + " required spent id");
        const Row& row = thin.at(id);
        require(row.seq == seq && row.lattice.born == stamp && row.lattice.life && row.lattice.life->stamp == stamp, label + " spent seq/born/life");
        continue;
      }
      require(rows.contains(id), label + " frozen row identity");
      const Row& row = rows.at(id);
      require(row.seq == seq && row.rc == frozen->second.rc && row.ru == frozen->second.ru, label + " frozen seq/rc/ru");
      require(type.identity == Identity::minted ? row.lattice.born == stamp : !row.lattice.born, label + " born");
      require(type.life ? row.lattice.life && row.lattice.life->state == LifeState::alive && row.lattice.life->stamp == stamp : !row.lattice.life, label + " life");
      std::set<std::string> fields;
      for (const auto& [name, field] : row.lattice.f) {
        fields.insert(name);
        require(field.stamp == stamp, label + "/" + name + " envelope");
      }
      require(fields == frozen->second.fields, label + " frozen field identities");
      for (const auto& [name, value] : frozen->second.values)
        require(jcs(row.lattice.f.at(name).value) == jcs(value), label + "/" + name + " frozen value");
      if (type.name == "note") ++noteCount;
    }
  }
  require(scope.seq == seq, "frozen scope seq");
  require(noteCount == (scope.counters.contains("note") ? scope.counters.at("note") : 0), "frozen note counter");
  Json::Value candidate = frozenSource(txn, scope.key);
  for (const auto& table : source.getMemberNames()) {
    if (table == "seeds") continue;
    std::set<std::string> originalNames;
    if (table == "gym_exercise_names") for (const auto& raw : source[table]) originalNames.insert(raw["exercise_id"].asString());
    std::vector<std::string> actualRows, frozenRows;
    for (const auto& raw : candidate[table]) {
      if (table == "gym_exercise_names" && !originalNames.contains(raw["exercise_id"].asString())) continue;
      actualRows.push_back(jcs(raw));
    }
    for (const auto& raw : source[table]) frozenRows.push_back(jcs(raw));
    std::sort(actualRows.begin(), actualRows.end());
    std::sort(frozenRows.begin(), frozenRows.end());
    require(actualRows == frozenRows, table + " frozen values/receipts/projections");
  }
  std::vector<Json::Value> notes;
  for (const auto& row : source["gym_notes"]) notes.push_back(row);
  std::sort(notes.begin(), notes.end(), [](const auto& a, const auto& b) {
    return a["position"] == b["position"] ? a["id"].asString() < b["id"].asString() : a["position"].asInt() < b["position"].asInt();
  });
  std::optional<std::string> ord;
  for (const auto& raw : notes) {
    ord = between(ord, std::nullopt);
    const auto stored = sqlOf(txn).exec("select ord from gym_notes where user_id=$1::uuid and id=$2", pqxx::params{scope.owner.str(), raw["id"].asString()});
    require(stored.size() == 1 && stored[0][0].as<std::string>() == *ord, "note/" + raw["id"].asString() + " frozen order");
  }
}

Json::Value checkScope(SyncTxn& txn, PgSyncStore& store, const ScopeRow& scope) {
  if (!PgGymBackfill::adopted(txn, scope.key)) throw std::runtime_error("C.8 adoption audit failed: " + scope.key.text() + " has unadopted rows or required spent ids");
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

std::uint64_t testFrozenAudit(SyncTxn& txn, PgSyncStore& store, const ScopeRow& original) {
  auto& sql = sqlOf(txn);
  const auto marker = sql.exec("select migration_ms from gym_sync_adoptions where user_id=$1::uuid", pqxx::params{original.owner.str()});
  const std::string future = sql.quote(std::to_string(marker[0][0].as<Ms>() + Limits{}.maxSkewMs + 1) + ":0:srv");
  std::vector<std::string> mutations;
  for (const auto& table : tables) {
    const TypeDef& type = *registry().type(table.type);
    const std::string eligible = " where " + table.owner + "=$1::uuid and seq>0";
    auto mutate = [&](const std::string& column, const std::string& value) {
      mutations.push_back("update " + table.name + " set " + column + "=" + value + eligible + " and " + column + " is not null returning 1");
    };
    if (type.identity == Identity::minted) mutate("born", future);
    if (type.life) mutate("life_stamp", future);
    for (const auto& [name, field] : type.fields) if (field.kind != FieldKind::serial) mutate(snake(name) + "_stamp", future);
    for (const char* column : {"seq", "rc", "ru"}) mutate(column, std::string(column) + "+1");
    if (type.name == "routine") mutate("revision", "revision+1");
    if (type.name == "set") mutate("set_number", "set_number+1");
  }
  for (const char* column : {"born", "life_stamp", "seq"})
    mutations.push_back("update sync_spent set " + std::string(column) + "=" + (std::string(column) == "seq" ? "seq+1" : future) + " where scope_key=$1 returning 1");
  for (const char* table : {"gym_write_receipts", "gym_correction_receipts"})
    mutations.push_back("update " + std::string(table) + " set request_hash='corrupted' where user_id=$1::uuid returning 1");
  mutations.push_back("update gym_exercise_aliases set sync_positions=case when sync_positions is null then '[0]'::jsonb else null end "
    "where user_id=$1::uuid and exercise_id in(select exercise_id from gym_exercise_aliases where user_id=$1::uuid group by exercise_id having count(*)=1) returning 1");
  std::uint64_t rejected = 0;
  for (const auto& mutation : mutations) {
    sql.exec("savepoint gym_audit_corruption");
    const bool changed = !sql.exec(mutation, pqxx::params{mutation.starts_with("update sync_spent ") ? original.key.text() : original.owner.str()}).empty();
    if (changed) {
      ScopeRow candidate = original;
      candidate.digest = Digest256();
      candidate.seq = 0;
      for (const TypeDef& type : registry().types()) {
        PgGymType typeStore(type);
        for (const Row& row : typeStore.feed(txn, original.key, FeedQuery{})) {
          candidate.digest = candidate.digest + rowHash(row.toJson());
          candidate.seq = std::max(candidate.seq, row.seq);
        }
        for (const Row& row : store.feedSpent(txn, original.key, type, FeedQuery{})) candidate.seq = std::max(candidate.seq, row.seq);
      }
      store.saveScope(txn, candidate);
      checkScope(txn, store, candidate);
      bool refused = false;
      try { auditFrozen(txn, store, candidate); }
      catch (const std::runtime_error&) { refused = true; }
      if (!refused) throw std::runtime_error("C.8 corruption audit failed to reject " + mutation);
      ++rejected;
    }
    sql.exec("rollback to savepoint gym_audit_corruption");
    sql.exec("release savepoint gym_audit_corruption");
  }
  return rejected;
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
    const auto existing = store.scope(*txn, key, dryRun ? RowLock::none : RowLock::noKeyUpdate);
    if (existing && adopted(*txn, key)) {
      Json::Value out = checkScope(*txn, store, *existing);
      out["skipped"] = true;
      out["dryRun"] = dryRun;
      reports.push_back(std::move(out));
      if (onAccount) onAccount(reports.back());
      continue;
    }
    ScopeRow scope = existing.value_or(ScopeRow{.key = key, .owner = UserId(owner)});
    const Json::Value source = frozenSource(*txn, key);
    std::map<std::string, std::vector<Row>> records;
    std::vector<Row> spent = spentRows(*txn, key, stamp);
    std::uint64_t changed = spent.size();
    for (const TypeDef& type : registry().types()) {
      PgGymType typeStore(type);
      records[type.name] = typeStore.adoptionRows(*txn, key, migrationTime);
      changed += records[type.name].size();
      scope.seq = std::max(scope.seq, typeStore.greatestSeq(*txn, key));
    }
    for (const auto& row : sql.exec("select coalesce(max(seq),0) from sync_spent where scope_key=$1", pqxx::params{key.text()}))
      scope.seq = std::max(scope.seq, row[0].template as<Seq>());
    if (!existing && changed == 0 && scope.seq == 0) continue;
    for (const TypeDef& type : registry().types()) {
      std::vector<Row*> ordered;
      for (Row& row : records[type.name]) ordered.push_back(&row);
      for (Row& row : spent) if (row.t == type.name) ordered.push_back(&row);
      std::sort(ordered.begin(), ordered.end(), [](const Row* a, const Row* b) { return a->id < b->id; });
      for (Row* row : ordered) row->seq = ++scope.seq;
    }
    if (!dryRun) {
      sql.exec("insert into gym_sync_adoptions(user_id,migration_ms,frozen_source) values($1::uuid,$2,$3::jsonb) on conflict do nothing",
               pqxx::params{owner, static_cast<std::int64_t>(migrationTime), jcs(source)});
      if (!existing && !store.insertScope(*txn, key, UserId(owner), std::nullopt)) throw std::runtime_error("scope appeared during backfill: " + key.text());
      for (const TypeDef& type : registry().types()) {
        PgGymType typeStore(type);
        typeStore.adopt(*txn, key, records[type.name]);
      }
      for (const Row& row : spent) store.addSpent(*txn, key, row);
    }
    scope.digest = Digest256();
    std::uint64_t count = 0, spentCount = 0;
    for (const TypeDef& type : registry().types()) {
      PgGymType typeStore(type);
      std::map<std::string, Row> complete;
      if (dryRun) {
        for (const Row& row : typeStore.adoptedRows(*txn, key)) complete.emplace(row.id.key(), row);
        for (const Row& row : records[type.name]) complete.insert_or_assign(row.id.key(), row);
      } else for (const Row& row : typeStore.feed(*txn, key, FeedQuery{})) complete.emplace(row.id.key(), row);
      for (const auto& [id, row] : complete) scope.digest = scope.digest + rowHash(row.toJson());
      count += complete.size();
      if (type.name == "note" && (!complete.empty() || scope.counters.contains("note"))) scope.counters["note"] = complete.size();
      std::set<std::string> allSpent;
      for (const Row& row : store.feedSpent(*txn, key, type, FeedQuery{})) allSpent.insert(row.id.key());
      for (const Row& row : spent) if (row.t == type.name) allSpent.insert(row.id.key());
      spentCount += allSpent.size();
    }
    if (!dryRun) {
      store.saveScope(*txn, scope);
      checkScope(*txn, store, scope);
      txn->commit();
    }
    Json::Value out = report(scope, count, spentCount, changed);
    out["migrationMs"] = Json::UInt64(migrationTime);
    out["skipped"] = false;
    out["dryRun"] = dryRun;
    reports.push_back(std::move(out));
    if (onAccount) onAccount(reports.back());
  }
  return reports;
}

bool PgGymBackfill::adopted(SyncTxn& txn, const ScopeKey& scope) {
  const auto current = sqlOf(txn).exec("select seq from sync_scopes where key=$1", pqxx::params{scope.text()});
  const Seq scopeSeq = current.empty() ? 0 : current[0][0].as<Seq>();
  for (const TypeDef& type : registry().types()) {
    PgGymType typeStore(type);
    if (typeStore.needsAdoption(txn, scope)) return false;
    if (typeStore.greatestSeq(txn, scope) > scopeSeq) return false;
  }
  if (sqlOf(txn).exec("select exists(select 1 from sync_spent where scope_key=$1 and seq>$2)", pqxx::params{scope.text(), static_cast<std::int64_t>(scopeSeq)})[0][0].as<bool>()) return false;
  return spentRows(txn, scope, stampOf("0:0:srv")).empty();
}

std::vector<Json::Value> PgGymBackfill::audit(std::optional<std::string> account, bool testCorruptions) {
  PgSyncStore store(pool_, Limits{}.lockTimeoutMs);
  auto txn = store.begin(testCorruptions ? TxnMode::write : TxnMode::snapshot);
  requireSchema(*txn);
  std::vector<Json::Value> reports;
  for (const auto& owner : accounts(*txn, account)) {
    const auto scope = store.scope(*txn, ScopeKey::product(UserId(owner), "gym"), RowLock::none);
    if (!scope) throw std::runtime_error("C.8 adoption audit failed: acct:" + owner + "/gym has eligible rows or spent ids but no scope");
    reports.push_back(checkScope(*txn, store, *scope));
    auditFrozen(*txn, store, *scope);
    reports.back()["envelopeAudit"] = true;
    if (testCorruptions) reports.back()["corruptionsRejected"] = Json::UInt64(testFrozenAudit(*txn, store, *scope));
  }
  return reports;
}

std::vector<Json::Value> PgGymBackfill::auditCurrent(std::optional<std::string> account) {
  PgSyncStore store(pool_, Limits{}.lockTimeoutMs);
  auto txn = store.begin(TxnMode::snapshot);
  requireSchema(*txn);
  std::vector<Json::Value> reports;
  for (const auto& owner : accounts(*txn, account)) {
    const auto scope = store.scope(*txn, ScopeKey::product(UserId(owner), "gym"), RowLock::none);
    if (!scope) throw std::runtime_error("C.8 adoption audit failed: acct:" + owner + "/gym has eligible rows or spent ids but no scope");
    reports.push_back(checkScope(*txn, store, *scope));
  }
  return reports;
}

}
