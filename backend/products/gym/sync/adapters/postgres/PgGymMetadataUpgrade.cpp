#include "products/gym/sync/adapters/postgres/PgGymMetadataUpgrade.h"

#include "products/gym/sync/GymRegistry.h"
#include "products/gym/sync/adapters/postgres/PgGymBackfill.h"
#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Wire.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <map>
#include <limits>
#include <set>
#include <stdexcept>

namespace wm::gym::engine {
using namespace sync;

namespace {

struct Table {
  const char* type;
  const char* name;
  const char* id;
};
const std::array<Table, 10> tables{{
  {"routine", "gym_routines", "id"}, {"routineCreation", "gym_routine_creations", "routine_id"},
  {"exercise", "gym_exercises", "id"}, {"exerciseName", "gym_exercise_names", "exercise_id"},
  {"session", "gym_sessions", "id"}, {"set", "gym_sets", "id"},
  {"note", "gym_notes", "id"}, {"weighin", "gym_bodyweight", "date_local"},
  {"prefs", "gym_preferences", ""}, {"proposal", "gym_proposals", "id"}}};

void require(bool condition, const std::string& label) {
  if (!condition) throw MetadataUpgradeError("C.10 metadata upgrade failed: " + label);
}

std::string snake(const std::string& name) {
  std::string result;
  for (unsigned char c : name) {
    if (std::isupper(c)) result += '_';
    result += static_cast<char>(std::tolower(c));
  }
  return result;
}

const Table& tableOf(const std::string& type) {
  const auto found = std::find_if(tables.begin(), tables.end(), [&](const auto& table) { return type == table.type; });
  if (found == tables.end()) throw std::logic_error("C.10 unknown gym registry type");
  return *found;
}

std::string column(const std::string& type, const std::string& field) {
  if (type == "weighin" && field == "kg") return "weight_kg";
  if (field == "changeCount") return "changes";
  if (field == "snapshot") return "routine";
  return snake(field);
}

std::string rowId(const Table& table, const Json::Value& raw) {
  return std::string(table.type) == "prefs" ? "prefs" : raw[table.id].asString();
}

std::map<std::string, std::string> gymPredicates(SyncTxn& txn) {
  std::map<std::string, std::string> predicates;
  for (const auto& table : sqlOf(txn).exec(
      "select c.relname,bool_or(a.attname='user_id') as user_id,bool_or(a.attname='created_by') as created_by "
      "from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid "
      "where n.nspname=current_schema() and c.relkind='r' and c.relname like 'gym_%' "
      "and c.relname not in('gym_sync_metadata_upgrades','gym_sync_metadata_upgrade_runs') and a.attnum>0 and not a.attisdropped group by c.relname")) {
    const std::string name = table[0].template as<std::string>();
    if (table[1].template as<bool>()) predicates[name] = "user_id=$1::uuid";
    else if (table[2].template as<bool>()) predicates[name] = "created_by=$1::uuid";
    else if (name == "gym_routine_entries" || name == "gym_routine_entry_sets")
      predicates[name] = "routine_id in(select id from gym_routines where user_id=$1::uuid)";
    else if (name == "gym_ask_turns") predicates[name] = "thread_id in(select id from gym_ask_threads where user_id=$1::uuid)";
    else if (name == "gym_log_share_sessions") predicates[name] = "share_id in(select id from gym_log_shares where user_id=$1::uuid)";
    else require(false, "unowned gym table in frozen manifest");
  }
  return predicates;
}

std::vector<std::string> accounts(SyncTxn& txn) {
  std::string owners = "select owner as account from sync_scopes where key='acct:'||owner::text||'/gym'";
  for (const auto& table : tables)
    owners += " union select " + std::string(std::string(table.type) == "exercise" ? "created_by" : "user_id") + " from " + table.name +
              (std::string(table.type) == "exercise" ? " where created_by is not null" : "");
  for (const char* table : {"gym_exercise_aliases", "gym_write_receipts", "gym_note_saves", "gym_sync_adoptions"})
    owners += " union select user_id from " + std::string(table);
  owners += " union select user_id from gym_set_revisions where deleted";
  std::vector<std::string> result;
  for (const auto& row : sqlOf(txn).exec("select account::text from (" + owners + ") owners order by account"))
    result.push_back(row[0].template as<std::string>());
  return result;
}

void requireSchema(SyncTxn& txn) {
  auto& sql = sqlOf(txn);
  for (const auto& [table, names] : std::map<std::string, std::vector<std::string>>{
      {"gym_routines", {"revision_stamp", "created_entries_stamp"}},
      {"gym_proposals", {"base_revision_stamp", "base_name_stamp", "change_count_stamp"}},
      {"gym_notes", {"updated_at_stamp"}},
      {"gym_routine_creations", {"seq", "rc", "ru", "snapshot_stamp"}},
      {"gym_sync_metadata_upgrade_runs", {"version", "migration_ms", "registry_hash", "epoch", "roster"}},
      {"gym_sync_metadata_upgrades", {"user_id", "version", "migration_ms", "frozen_source", "result"}}}) {
    for (const auto& name : names) {
      const auto rows = sql.exec("select atttypid::regtype::text from pg_attribute where attrelid=to_regclass($1) and attname=$2 and not attisdropped", pqxx::params{table, name});
      const std::string expected = name.ends_with("_stamp") || name == "registry_hash" || name == "epoch" ? "text" :
        name == "version" ? "integer" : name == "user_id" ? "uuid" : name == "roster" || name == "frozen_source" || name == "result" ? "jsonb" : "bigint";
      require(rows.size() == 1 && rows[0][0].as<std::string>() == expected, "apply compatible db/gym_sync_v5.sql under the freeze");
    }
  }
  require(!sql.exec("select 1 from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=i.indkey[0] "
                   "join pg_attribute b on b.attrelid=i.indrelid and b.attnum=i.indkey[1] where i.indrelid='gym_routine_creations'::regclass "
                   "and i.indisvalid and i.indpred is null and a.attname='user_id' and b.attname='seq'").empty(), "snapshot feed index missing");
}

Json::Value capture(SyncTxn& txn, const std::string& owner) {
  auto& sql = sqlOf(txn);
  sql.exec("set local timezone='UTC'");
  Json::Value source(Json::objectValue);
  auto predicates = gymPredicates(txn);
  predicates["sync_scopes"] = "key='acct:'||$1||'/gym'";
  predicates["sync_spent"] = "scope_key='acct:'||$1||'/gym'";
  predicates["sync_requests"] = "account=$1::uuid";
  predicates["sync_replicas"] = "account=$1::uuid";
  predicates["sync_results"] = "replica in(select replica from sync_replicas where account=$1::uuid)";
  for (const auto& [table, predicate] : predicates) {
    std::string expression = "to_jsonb(t)";
    for (const auto& attribute : sql.exec("select attname from pg_attribute where attrelid=to_regclass($1) and atttypid='timestamptz'::regtype and attnum>0 and not attisdropped", pqxx::params{table})) {
      const std::string name = attribute[0].template as<std::string>();
      expression += "||jsonb_build_object(" + sql.quote(name + "_ms") + ",(extract(epoch from " + sql.quote_name(name) + ")*1000)::bigint)";
    }
    auto& rows = source["tables"][table];
    rows = Json::Value(Json::arrayValue);
    for (const auto& row : sql.exec("select (" + expression + ")::text from " + sql.quote_name(table) + " t where " + predicate + " order by to_jsonb(t)::text collate \"C\"", pqxx::params{owner}))
      rows.append(parseJson(row[0].template as<std::string>()));
  }
  source["epoch"] = sql.exec("select epoch from sync_meta where one")[0][0].as<std::string>();
  return source;
}

std::vector<Json::Value> ordered(const Json::Value& rows, const std::string& key, const std::string& id, const std::string& order) {
  std::vector<Json::Value> result;
  for (const auto& row : rows) if (row[key] == id) result.push_back(row);
  std::sort(result.begin(), result.end(), [&](const auto& a, const auto& b) { return a[order].asInt() < b[order].asInt(); });
  return result;
}

Json::Value fieldValue(const Json::Value& source, const Table& table, const Json::Value& raw, const std::string& name) {
  const auto& data = source["tables"];
  const std::string id = rowId(table, raw);
  if (name == "entries") {
    Json::Value result(Json::arrayValue);
    for (const auto& entry : ordered(data["gym_routine_entries"], "routine_id", id, "position")) {
      Json::Value value(Json::objectValue);
      value["exerciseId"] = entry["exercise_id"];
      if (entry["rest_seconds_present"].asBool()) value["restSeconds"] = entry["rest_seconds"];
      if (entry["sets_present"].asBool()) {
        value["sets"] = Json::Value(Json::arrayValue);
        for (const auto& set : ordered(data["gym_routine_entry_sets"], "routine_id", id, "set_index")) {
          if (set["position"] != entry["position"]) continue;
          Json::Value target(Json::objectValue);
          if (set["reps_present"].asBool()) target["reps"] = set["reps"];
          if (set["weight_kg_present"].asBool()) target["weightKg"] = set["weight_kg"];
          value["sets"].append(std::move(target));
        }
      }
      result.append(std::move(value));
    }
    return result;
  }
  if (name == "changes") {
    Json::Value result(Json::arrayValue);
    for (const auto& change : ordered(data["gym_proposal_changes"], "proposal_id", id, "position")) {
      Json::Value value(Json::objectValue);
      value["kind"] = change["kind"]; value["exerciseId"] = change["exercise_id"];
      for (const std::string side : {"before", "after"}) {
        if (!change[side + "_present"].asBool()) continue;
        value[side] = Json::Value(Json::objectValue);
        if (change[side + "_sets_present"].asBool()) value[side]["sets"] = change[side + "_sets"];
        if (change[side + "_rest_present"].asBool()) value[side]["restSeconds"] = change[side + "_rest_seconds"];
      }
      result.append(std::move(value));
    }
    return result;
  }
  if (name == "aliases") {
    std::vector<Json::Value> aliases;
    for (const auto& alias : data["gym_exercise_aliases"]) if (alias["exercise_id"] == id) aliases.push_back(alias);
    std::sort(aliases.begin(), aliases.end(), [](const auto& a, const auto& b) {
      return a["created_at"] == b["created_at"] ? a["name"].asString() < b["name"].asString() : a["created_at"].asString() > b["created_at"].asString();
    });
    Json::Value result(Json::arrayValue);
    std::map<int, std::string> positioned;
    for (const auto& alias : aliases) {
      if (alias["sync_positions"].isNull()) result.append(alias["name"]);
      else for (const auto& position : alias["sync_positions"]) positioned.emplace(position.asInt(), alias["name"].asString());
    }
    for (const auto& [position, value] : positioned) result.append(value);
    return result;
  }
  const std::string col = column(table.type, name);
  if (name == "updatedAt" || name == "startedAt" || name == "finishedAt" || name == "completedAt" || name == "settledAt") return raw[col + "_ms"];
  return raw[col];
}

std::vector<Row> feed(const Json::Value& source, const Registry& schema) {
  std::vector<Row> rows;
  for (const auto& type : schema.types()) {
    const auto& table = tableOf(type.name);
    for (const auto& raw : source["tables"][table.name]) {
      if (raw["seq"].isNull()) continue;
      Row row(type.name, RecordId(rowId(table, raw)));
      row.seq = raw["seq"].asUInt64(); row.rc = raw["rc"].asUInt64(); row.ru = raw["ru"].asUInt64();
      if (type.identity == Identity::minted) row.lattice.born = stampOf(raw["born"]);
      if (type.life) row.lattice.life = Life(LifeState::alive, stampOf(raw["life_stamp"]));
      for (const auto& [name, field] : type.fields) {
        if (field.kind == FieldKind::serial) {
          const auto& value = raw[column(type.name, name)];
          if (!value.isNull()) row.v[name] = value;
          continue;
        }
        const auto& stamp = raw[snake(name) + "_stamp"];
        if (!stamp.isNull()) row.lattice.f.emplace(name, Reg(fieldValue(source, table, raw, name), stampOf(stamp)));
      }
      rows.push_back(std::move(row));
    }
  }
  return rows;
}

Json::Value digestResult(const Json::Value& source, const Registry& schema) {
  Digest256 digest;
  Seq greatest = 0;
  const auto rows = feed(source, schema);
  for (const auto& row : rows) { digest = digest + rowHash(row.toJson()); greatest = std::max(greatest, row.seq); }
  for (const auto& raw : source["tables"]["sync_spent"]) greatest = std::max(greatest, raw["seq"].asUInt64());
  Json::Value result(Json::objectValue);
  result["digest"] = digest.hex(); result["seq"] = Json::UInt64(greatest);
  result["rows"] = Json::UInt64(rows.size()); result["spent"] = source["tables"]["sync_spent"].size();
  return result;
}

void validateBase(SyncTxn& txn, const std::string& owner, const Json::Value& source) {
  const auto& scopes = source["tables"]["sync_scopes"];
  require(scopes.size() == 1 && scopes[0]["state"] == "alive", "scope must already be adopted");
  require(PgGymBackfill::adopted(txn, ScopeKey::product(UserId(owner), "gym"), true), "account contains unadopted gym rows or missing spent ids");
  const auto computed = digestResult(source, baseRegistry());
  require(scopes[0]["seq"].asUInt64() == computed["seq"].asUInt64() && scopes[0]["digest"] == "\\x" + computed["digest"].asString(), "v4 scope digest or greatest seq mismatch");
  for (const auto& [table, stamps] : std::map<std::string, std::vector<std::string>>{
      {"gym_routines", {"revision_stamp", "created_entries_stamp"}},
      {"gym_proposals", {"base_revision_stamp", "base_name_stamp", "change_count_stamp"}},
      {"gym_notes", {"updated_at_stamp"}}, {"gym_routine_creations", {"snapshot_stamp"}}})
    for (const auto& raw : source["tables"][table]) for (const auto& stamp : stamps)
      require(raw[stamp].isNull(), "unexpected pre-existing metadata without committed marker");
  for (const auto& raw : source["tables"]["gym_routines"]) require(!raw["revision"].isNull(), "missing routine revision source");
  for (const auto& raw : source["tables"]["gym_proposals"]) for (const char* name : {"base_revision", "base_name", "changes"}) require(!raw[name].isNull(), "missing frozen proposal source");
  for (const auto& raw : source["tables"]["gym_notes"]) require(!raw["updated_at_ms"].isNull(), "missing note content time source");
  for (const auto& raw : source["tables"]["gym_routine_creations"]) {
    require(!raw["routine"].isNull(), "missing routine creation source");
    require(raw["seq"].isNull() && raw["rc"].isNull() && raw["ru"].isNull(), "unexpected snapshot envelope without committed marker");
  }
}

Json::Value supplemented(const Json::Value& frozen, Ms at, std::uint64_t& changed) {
  Json::Value expected = frozen;
  Seq seq = frozen["tables"]["sync_scopes"][0]["seq"].asUInt64();
  const std::string stamp = std::to_string(at) + ":0:srv";
  changed = 0;
  for (const auto& type : registry().types()) {
    if (type.name != "routine" && type.name != "routineCreation" && type.name != "note" && type.name != "proposal") continue;
    const auto& table = tableOf(type.name);
    auto& rawRows = expected["tables"][table.name];
    std::vector<Json::Value*> orderedRows;
    for (auto& row : rawRows) orderedRows.push_back(&row);
    std::sort(orderedRows.begin(), orderedRows.end(), [&](auto a, auto b) { return RecordId(rowId(table, *a)) < RecordId(rowId(table, *b)); });
    for (auto* row : orderedRows) {
      require(seq < static_cast<Seq>(std::numeric_limits<std::int64_t>::max()), "scope sequence exhausted");
      (*row)["seq"] = Json::UInt64(++seq);
      ++changed;
      if (type.name == "routine") {
        (*row)["revision_stamp"] = stamp;
        if (!(*row)["created_entries"].isNull()) (*row)["created_entries_stamp"] = stamp;
      } else if (type.name == "proposal") {
        for (const char* name : {"base_revision_stamp", "base_name_stamp", "change_count_stamp"}) (*row)[name] = stamp;
      } else if (type.name == "note") (*row)["updated_at_stamp"] = stamp;
      else {
        (*row)["rc"] = Json::UInt64(at); (*row)["ru"] = Json::UInt64(at); (*row)["snapshot_stamp"] = stamp;
      }
    }
  }
  const auto result = digestResult(expected, registry());
  auto& scope = expected["tables"]["sync_scopes"][0];
  scope["seq"] = Json::UInt64(seq); scope["digest"] = "\\x" + result["digest"].asString();
  require(result["seq"].asUInt64() == seq, "supplement greatest seq differs from scope");
  return expected;
}

void compare(const Json::Value& actual, const Json::Value& expected) {
  require(actual["epoch"] == expected["epoch"], "epoch changed");
  require(actual["tables"].getMemberNames() == expected["tables"].getMemberNames(), "table roster differs from retained input");
  for (const auto& table : expected["tables"].getMemberNames()) {
    std::vector<std::string> found, wanted;
    for (const auto& row : actual["tables"][table]) found.push_back(jcs(row));
    for (const auto& row : expected["tables"][table]) wanted.push_back(jcs(row));
    std::sort(found.begin(), found.end()); std::sort(wanted.begin(), wanted.end());
    require(found == wanted, "independent frozen values, envelopes or receipts mismatch in " + table);
  }
}

Json::Value accepted(SyncTxn& txn, const std::string& owner, Ms at, const Json::Value& frozen) {
  std::uint64_t changed;
  const auto expected = supplemented(frozen, at, changed);
  const auto actual = capture(txn, owner);
  compare(actual, expected);
  Json::Value result = digestResult(actual, registry());
  result["account"] = owner; result["scope"] = "acct:" + owner + "/gym";
  result["version"] = 5; result["migrationMs"] = Json::UInt64(at);
  result["frozenSeq"] = frozen["tables"]["sync_scopes"][0]["seq"];
  result["changed"] = Json::UInt64(changed); result["audit"] = true;
  return result;
}

std::vector<std::string> roster(const Json::Value& rows, const std::optional<std::string>& account) {
  std::vector<std::string> result;
  for (const auto& row : rows) if (!account || row == *account) result.push_back(row.asString());
  return result;
}

Json::Value survivingRoster(SyncTxn& txn, const Json::Value& frozen) {
  Json::Value result(Json::arrayValue);
  for (const auto& row : sqlOf(txn).exec("select value from jsonb_array_elements_text($1::jsonb) with ordinality roster(value,position) "
                                        "join users u on u.id=roster.value::uuid order by position", pqxx::params{jcs(frozen)}))
    result.append(row[0].template as<std::string>());
  return result;
}

}

std::vector<Json::Value> PgGymMetadataUpgrade::run(std::optional<Ms> migrationTime, std::optional<std::string> account,
                                                const std::function<void(const Json::Value&)>& onAccount) {
  PgSyncStore store(pool_, Limits{}.lockTimeoutMs);
  Json::Value owners;
  Ms at = migrationTime.value_or(static_cast<Ms>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count()));
  require(at <= static_cast<Ms>(std::numeric_limits<std::int64_t>::max()), "migration clock is outside database range");
  const auto registryHash = sha256(jcs(parseJson(registryText()))).hex();
  {
    auto txn = store.begin(TxnMode::write);
    auto& sql = sqlOf(*txn);
    requireSchema(*txn);
    sql.exec("select pg_advisory_xact_lock(hashtext('gym-metadata-v5'))");
    const auto run = sql.exec("select migration_ms,registry_hash,epoch,roster::text from gym_sync_metadata_upgrade_runs where version=5");
    if (!run.empty()) {
      at = run[0][0].as<Ms>(); owners = survivingRoster(*txn, parseJson(run[0][3].as<std::string>()));
      require(!migrationTime || *migrationTime == at, "explicit migration clock differs from retained run");
      require(run[0][1].as<std::string>() == registryHash && run[0][2].as<std::string>() == store.epoch(*txn), "retained run registry or epoch differs");
      if (sql.exec("select exists(select 1 from gym_sync_metadata_upgrades where version=5 and result is null)")[0][0].as<bool>()) {
        Json::Value current(Json::arrayValue);
        for (const auto& owner : accounts(*txn)) current.append(owner);
        require(jcs(current) == jcs(owners), "source account roster changed during incomplete upgrade");
      }
    } else {
      owners = Json::Value(Json::arrayValue);
      std::map<std::string, Json::Value> sources;
      for (const auto& owner : accounts(*txn)) {
        const auto scope = store.scope(*txn, ScopeKey::product(UserId(owner), "gym"), RowLock::noKeyUpdate);
        require(scope.has_value(), "gym-owning account lacks adopted scope");
        auto source = capture(*txn, owner);
        validateBase(*txn, owner, source);
        owners.append(owner); sources.emplace(owner, std::move(source));
      }
      sql.exec("insert into gym_sync_metadata_upgrade_runs(version,run_id,migration_ms,registry_hash,epoch,roster) values(5,gen_random_uuid(),$1,$2,$3,$4::jsonb)",
               pqxx::params{static_cast<std::int64_t>(at), registryHash, store.epoch(*txn), jcs(owners)});
      for (const auto& [owner, source] : sources)
        sql.exec("insert into gym_sync_metadata_upgrades(user_id,version,migration_ms,frozen_source) values($1::uuid,5,$2,$3::jsonb)", pqxx::params{owner, static_cast<std::int64_t>(at), jcs(source)});
    }
    txn->commit();
  }
  std::vector<Json::Value> reports;
  for (const auto& owner : roster(owners, account)) {
    auto txn = store.begin(TxnMode::write);
    auto& sql = sqlOf(*txn);
    sql.exec("select pg_advisory_xact_lock(hashtext('gym-metadata-v5'),hashtext($1))", pqxx::params{owner});
    const auto marker = sql.exec("select migration_ms,frozen_source::text,result::text from gym_sync_metadata_upgrades where user_id=$1::uuid and version=5 for update", pqxx::params{owner});
    if (marker.empty() && sql.exec("select 1 from users where id=$1::uuid", pqxx::params{owner}).empty()) continue;
    require(marker.size() == 1 && marker[0][0].as<Ms>() == at, "missing or mismatched retained account manifest");
    if (!marker[0][2].is_null()) {
      auto result = parseJson(marker[0][2].as<std::string>());
      result["skipped"] = true;
      result["changed"] = Json::UInt64(0);
      reports.push_back(std::move(result));
      if (onAccount) onAccount(reports.back());
      continue;
    }
    const auto scope = store.scope(*txn, ScopeKey::product(UserId(owner), "gym"), RowLock::noKeyUpdate);
    require(scope.has_value(), "scope disappeared before account migration");
    const auto source = parseJson(marker[0][1].as<std::string>());
    compare(capture(*txn, owner), source);
    std::uint64_t changed;
    const auto expected = supplemented(source, at, changed);
    const auto stamp = std::to_string(at) + ":0:srv";
    for (const auto& table : tables) {
      const std::string type = table.type;
      if (type != "routine" && type != "routineCreation" && type != "note" && type != "proposal") continue;
      for (const auto& raw : expected["tables"][table.name]) {
        std::string updates = "seq=$3";
        pqxx::params params{owner, rowId(table, raw), raw["seq"].asInt64(), stamp};
        if (type == "routine") updates += ",revision_stamp=$4,created_entries_stamp=case when created_entries is null then null else $4 end";
        else if (type == "proposal") updates += ",base_revision_stamp=$4,base_name_stamp=$4,change_count_stamp=$4";
        else if (type == "note") updates += ",updated_at_stamp=$4";
        else { updates += ",snapshot_stamp=$4,rc=$5,ru=$5"; params.append(static_cast<std::int64_t>(at)); }
        require(sql.exec("update " + std::string(table.name) + " set " + updates + " where user_id=$1::uuid and " + table.id + "=$2 returning 1", params).size() == 1, "account source row disappeared");
      }
    }
    if (changed) sql.exec("update sync_scopes set seq=$2,digest=decode($3,'hex') where key=$1", pqxx::params{scope->key.text(), expected["tables"]["sync_scopes"][0]["seq"].asInt64(), digestResult(expected, registry())["digest"].asString()});
    auto result = accepted(*txn, owner, at, source);
    sql.exec("update gym_sync_metadata_upgrades set result=$2::jsonb where user_id=$1::uuid and version=5", pqxx::params{owner, jcs(result)});
    txn->commit();
    result["skipped"] = false; reports.push_back(std::move(result));
    if (onAccount) onAccount(reports.back());
  }
  return reports;
}

void PgGymMetadataUpgrade::requireComplete(SyncTxn& txn) {
  auto& sql = sqlOf(txn);
  if (sql.exec("select to_regclass('gym_sync_metadata_upgrades') is null and to_regclass('gym_sync_metadata_upgrade_runs') is null "
               "and not exists(select 1 from (values ('gym_routines','revision_stamp'),('gym_routines','created_entries_stamp'),"
               "('gym_proposals','base_revision_stamp'),('gym_proposals','base_name_stamp'),('gym_proposals','change_count_stamp'),"
               "('gym_notes','updated_at_stamp'),('gym_routine_creations','snapshot_stamp'),('gym_routine_creations','seq'),"
               "('gym_routine_creations','rc'),('gym_routine_creations','ru')) columns(table_name,column_name) "
               "join pg_attribute a on a.attrelid=to_regclass(columns.table_name) and a.attname=columns.column_name and not a.attisdropped)")[0][0].as<bool>()) return;
  requireSchema(txn);
  const auto run = sql.exec("select registry_hash,epoch from gym_sync_metadata_upgrade_runs where version=5");
  require(run.size() == 1, "metadata schema has no initialized upgrade run");
  require(run[0][0].as<std::string>() == sha256(jcs(parseJson(registryText()))).hex() &&
          run[0][1].as<std::string>() == sql.exec("select epoch from sync_meta where one")[0][0].as<std::string>(), "retained registry or epoch differs");
  require(sql.exec("select not exists(select 1 from gym_sync_metadata_upgrades where version=5 and "
                   "(result is null or coalesce(result->>'audit','')<>'true' or coalesce(result->>'version','')<>'5' "
                   "or coalesce(result->>'account','')<>user_id::text or coalesce(result->>'migrationMs','')<>migration_ms::text))")[0][0].as<bool>(), "metadata preparation or committed audit is incomplete");
  require(sql.exec("select not exists(select 1 from gym_sync_metadata_upgrade_runs r cross join lateral jsonb_array_elements_text(r.roster) owner "
                   "join users u on u.id=owner.value::uuid left join gym_sync_metadata_upgrades m on m.user_id=u.id and m.version=r.version "
                   "where m.result is null or m.migration_ms<>r.migration_ms)")[0][0].as<bool>(), "frozen roster lacks complete matching metadata markers");
  require(sql.exec("select not exists(select 1 from gym_routines where seq is not null and "
                   "(revision_stamp is null or (created_entries is not null and created_entries_stamp is null))) "
                   "and not exists(select 1 from gym_proposals where seq is not null and (base_revision_stamp is null or base_name_stamp is null or change_count_stamp is null)) "
                   "and not exists(select 1 from gym_notes where seq is not null and updated_at_stamp is null) "
                   "and not exists(select 1 from gym_routine_creations where seq is null or seq<=0 or rc is null or ru is null or snapshot_stamp is null)")[0][0].as<bool>(), "adopted metadata rows are incomplete");
}

std::vector<Json::Value> PgGymMetadataUpgrade::audit(std::optional<std::string> account, bool testCorruptions) {
  PgSyncStore store(pool_, Limits{}.lockTimeoutMs);
  auto txn = store.begin(testCorruptions ? TxnMode::write : TxnMode::snapshot);
  auto& sql = sqlOf(*txn);
  requireSchema(*txn);
  const auto run = sql.exec("select migration_ms,registry_hash,epoch,roster::text from gym_sync_metadata_upgrade_runs where version=5");
  require(run.size() == 1, "missing retained upgrade run");
  require(run[0][1].as<std::string>() == sha256(jcs(parseJson(registryText()))).hex() && run[0][2].as<std::string>() == store.epoch(*txn), "retained registry or epoch differs");
  const auto owners = survivingRoster(*txn, parseJson(run[0][3].as<std::string>()));
  Json::Value current(Json::arrayValue);
  for (const auto& owner : accounts(*txn)) current.append(owner);
  require(jcs(current) == jcs(owners), "source account roster differs from retained run");
  std::vector<Json::Value> reports;
  for (const auto& owner : roster(owners, account)) {
    const auto marker = sql.exec("select migration_ms,frozen_source::text,result::text from gym_sync_metadata_upgrades where user_id=$1::uuid and version=5", pqxx::params{owner});
    require(marker.size() == 1 && !marker[0][2].is_null() && marker[0][0].as<Ms>() == run[0][0].as<Ms>(), "account migration incomplete or mismatched");
    const auto frozen = parseJson(marker[0][1].as<std::string>());
    auto result = accepted(*txn, owner, marker[0][0].as<Ms>(), frozen);
    require(jcs(result) == jcs(parseJson(marker[0][2].as<std::string>())), "committed result differs from independent audit");
    if (testCorruptions) {
      const std::vector<std::string> mutations{
        "update gym_routines set revision=revision+1 where user_id=$1::uuid returning 1",
        "update gym_routines set created_entries=coalesce(created_entries,0)+1 where user_id=$1::uuid returning 1",
        "update gym_routines set revision_stamp='1:0:srv' where user_id=$1::uuid returning 1",
        "update gym_routines set created_entries_stamp='1:0:srv' where user_id=$1::uuid returning 1",
        "update gym_routines set name_stamp='1:0:srv' where user_id=$1::uuid returning 1",
        "update gym_routines set rc=rc+1 where user_id=$1::uuid returning 1",
        "update gym_routines set ru=ru+1 where user_id=$1::uuid returning 1",
        "update gym_routines set seq=seq+1 where user_id=$1::uuid returning 1",
        "update gym_proposals set base_revision=base_revision+1 where user_id=$1::uuid returning 1",
        "update gym_proposals set base_name=base_name||'x' where user_id=$1::uuid returning 1",
        "update gym_proposals set changes=changes+1 where user_id=$1::uuid returning 1",
        "update gym_proposals set base_revision_stamp='1:0:srv' where user_id=$1::uuid returning 1",
        "update gym_proposals set base_name_stamp='1:0:srv' where user_id=$1::uuid returning 1",
        "update gym_proposals set change_count_stamp='1:0:srv' where user_id=$1::uuid returning 1",
        "update gym_notes set updated_at=updated_at+interval '1 millisecond' where user_id=$1::uuid returning 1",
        "update gym_notes set updated_at_stamp='1:0:srv' where user_id=$1::uuid returning 1",
        "update gym_routine_creations set routine=routine||'{\"corrupt\":true}'::jsonb where user_id=$1::uuid returning 1",
        "update gym_routine_creations set snapshot_stamp='1:0:srv' where user_id=$1::uuid returning 1",
        "update gym_routine_creations set rc=rc+1,ru=ru+1 where user_id=$1::uuid returning 1",
        "update gym_write_receipts set request_hash='corrupted' where user_id=$1::uuid returning 1",
        "update gym_correction_receipts set request_hash='corrupted' where user_id=$1::uuid returning 1"};
      std::uint64_t rejected = 0;
      for (const auto& mutation : mutations) {
        sql.exec("savepoint gym_v5_corruption");
        if (!sql.exec(mutation, pqxx::params{owner}).empty()) {
          const auto computed = digestResult(capture(*txn, owner), registry());
          sql.exec("update sync_scopes set seq=$2,digest=decode($3,'hex') where key='acct:'||$1||'/gym'", pqxx::params{owner, computed["seq"].asInt64(), computed["digest"].asString()});
          bool refused = false;
          try { accepted(*txn, owner, marker[0][0].as<Ms>(), frozen); }
          catch (const std::runtime_error&) { refused = true; }
          require(refused, "independent audit accepted corrupt source with recomputed digest");
          ++rejected;
        }
        sql.exec("rollback to savepoint gym_v5_corruption"); sql.exec("release savepoint gym_v5_corruption");
      }
      result["corruptionsRejected"] = Json::UInt64(rejected);
    }
    reports.push_back(std::move(result));
  }
  return reports;
}

}
