#include "products/gym/sync/adapters/postgres/PgGym.h"

#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/FractionalIndex.h"
#include "products/gym/sync/domain/GymRules.h"
#include "products/gym/sync/adapters/postgres/GymDoorHash.h"
#include "products/gym/sync/adapters/postgres/PgGymBackfill.h"
#include "products/gym/sync/adapters/postgres/PgGymMetadataUpgrade.h"
#include "products/gym/application/GymSwitches.h"

#include <algorithm>
#include <cctype>
#include <stdexcept>

namespace wm::gym::engine {

using namespace sync;

namespace {

std::string snake(const std::string& field) {
  std::string result;
  for (unsigned char c : field) {
    if (std::isupper(c)) result += '_';
    result += static_cast<char>(std::tolower(c));
  }
  return result;
}

bool same(const Json::Value& a, const Json::Value& b) { return jcs(a) == jcs(b); }

bool metadataSchema(SyncTxn& txn) {
  return sqlOf(txn).exec("select exists(select 1 from pg_attribute where attrelid='gym_routines'::regclass and attname='revision_stamp' and not attisdropped)")[0][0].as<bool>();
}

bool metadataField(const std::string& type, const std::string& name) {
  return (type == "routine" && (name == "revision" || name == "createdEntries")) ||
      (type == "proposal" && (name == "baseRevision" || name == "baseName" || name == "changeCount")) ||
      (type == "note" && name == "updatedAt");
}

bool complex(const std::string& field) { return field == "entries" || field == "changes" || field == "aliases"; }
bool instant(const std::string& type, const std::string& field) {
  return field == "startedAt" || field == "finishedAt" || field == "completedAt" || (type == "proposal" && field == "settledAt") || (type == "note" && field == "updatedAt");
}
std::string column(const std::string& type, const std::string& field) {
  if (type == "proposal" && field == "changeCount") return "changes";
  if (type == "routineCreation" && field == "snapshot") return "routine";
  if (type == "weighin" && field == "kg") return "weight_kg";
  return snake(field);
}

std::string physicalField(const std::string& table, const std::string& id, const std::string& type, const std::string& name) {
  if (name == "entries" || name == "changes" || name == "ord") return "true";
  if (name == "aliases") return "exists(select 1 from gym_exercise_aliases a where a.user_id=$1::uuid and a.exercise_id=" + table + "." + id + ")";
  if (type == "exerciseName" && name == "name") return "name is not null and name<>''";
  if (type == "proposal" && name == "state") return "state<>'pending'";
  return column(type, name) + " is not null";
}

Json::Value readEntries(SyncTxn& txn, const std::string& id, bool legacy = false) {
  auto& sql = sqlOf(txn);
  Json::Value entries(Json::arrayValue);
  for (const auto& row : sql.exec("select * from gym_routine_entries where routine_id=$1 order by position", pqxx::params{id})) {
    Json::Value entry(Json::objectValue);
    entry["exerciseId"] = row["exercise_id"].template as<std::string>();
    if (legacy ? !row["rest_seconds"].is_null() : row["rest_seconds_present"].template as<bool>()) entry["restSeconds"] = row["rest_seconds"].is_null() ? Json::Value() : Json::Value(row["rest_seconds"].template as<int>());
    const auto sets = sql.exec("select * from gym_routine_entry_sets where routine_id=$1 and position=$2 order by set_index", pqxx::params{id, row["position"].template as<int>()});
    if (legacy ? !sets.empty() : row["sets_present"].template as<bool>()) {
      entry["sets"] = Json::Value(Json::arrayValue);
      for (const auto& set : sets) {
        Json::Value target(Json::objectValue);
        if (legacy ? !set["reps"].is_null() : set["reps_present"].template as<bool>()) target["reps"] = set["reps"].is_null() ? Json::Value() : Json::Value(set["reps"].template as<int>());
        if (legacy ? !set["weight_kg"].is_null() : set["weight_kg_present"].template as<bool>()) target["weightKg"] = set["weight_kg"].is_null() ? Json::Value() : Json::Value(set["weight_kg"].template as<double>());
        entry["sets"].append(target);
      }
    }
    entries.append(entry);
  }
  return entries;
}

Json::Value readChanges(SyncTxn& txn, const std::string& id, bool legacy = false) {
  Json::Value changes(Json::arrayValue);
  for (const auto& row : sqlOf(txn).exec("select * from gym_proposal_changes where proposal_id=$1 order by position", pqxx::params{id})) {
    Json::Value change(Json::objectValue);
    change["kind"] = row["kind"].template as<std::string>();
    change["exerciseId"] = row["exercise_id"].template as<std::string>();
    for (const std::string side : {"before", "after"}) {
      const std::string kind = row["kind"].template as<std::string>();
      const bool present = side == "before" ? kind != "added" : kind != "removed";
      if (legacy ? !present : !row[(side + "_present").c_str()].template as<bool>()) continue;
      change[side] = Json::Value(Json::objectValue);
      if (legacy ? !row[(side + "_sets").c_str()].is_null() : row[(side + "_sets_present").c_str()].template as<bool>()) change[side]["sets"] = row[(side + "_sets").c_str()].is_null() ? Json::Value() : parseJson(row[(side + "_sets").c_str()].template as<std::string>());
      if (legacy ? !row[(side + "_rest_seconds").c_str()].is_null() : row[(side + "_rest_present").c_str()].template as<bool>()) change[side]["restSeconds"] = row[(side + "_rest_seconds").c_str()].is_null() ? Json::Value() : Json::Value(row[(side + "_rest_seconds").c_str()].template as<int>());
    }
    changes.append(change);
  }
  return changes;
}

Json::Value readAliases(SyncTxn& txn, const ScopeKey& scope, const std::string& id) {
  Json::Value aliases(Json::arrayValue);
  std::map<int, std::string> positioned;
  for (const auto& row : sqlOf(txn).exec("select name,sync_positions from gym_exercise_aliases where user_id=$1::uuid and exercise_id=$2 order by created_at desc, name collate \"C\"", pqxx::params{scope.account().str(), id})) {
    const std::string name = row[0].template as<std::string>();
    if (row[1].is_null()) { aliases.append(name); continue; }
    for (const auto& position : parseJson(row[1].template as<std::string>())) positioned.emplace(position.asInt(), name);
  }
  for (const auto& [position, name] : positioned) aliases.append(name);
  return aliases;
}

std::optional<int> integer(const Json::Value& value) { return value.isNull() ? std::nullopt : std::optional(value.asInt()); }
std::optional<double> number(const Json::Value& value) { return value.isNull() ? std::nullopt : std::optional(value.asDouble()); }
std::optional<std::string> json(const Json::Value& value) { return value.isNull() ? std::nullopt : std::optional(jcs(value)); }

void writeEntries(SyncTxn& txn, const std::string& id, const Json::Value& entries) {
  auto& sql = sqlOf(txn);
  sql.exec("delete from gym_routine_entries where routine_id=$1", pqxx::params{id});
  int position = 0;
  for (const Json::Value& entry : entries) {
    ++position;
    sql.exec("insert into gym_routine_entries(routine_id,position,exercise_id,rest_seconds,rest_seconds_present,sets_present) values($1,$2,$3,$4,$5,$6)",
             pqxx::params{id, position, entry["exerciseId"].asString(), integer(entry["restSeconds"]), entry.isMember("restSeconds"), entry.isMember("sets")});
    int index = 0;
    for (const Json::Value& set : entry["sets"]) {
      sql.exec("insert into gym_routine_entry_sets(routine_id,position,set_index,reps,weight_kg,reps_present,weight_kg_present) values($1,$2,$3,$4,$5,$6,$7)",
               pqxx::params{id, position, ++index, integer(set["reps"]), number(set["weightKg"]), set.isMember("reps"), set.isMember("weightKg")});
    }
  }
}

void writeChanges(SyncTxn& txn, const ScopeKey& scope, const std::string& id, const Json::Value& changes) {
  auto& sql = sqlOf(txn);
  sql.exec("delete from gym_proposal_changes where proposal_id=$1", pqxx::params{id});
  int position = 0;
  for (const Json::Value& change : changes) {
    const Json::Value& before = change["before"];
    const Json::Value& after = change["after"];
    sql.exec("insert into gym_proposal_changes(proposal_id,position,user_id,kind,exercise_id,before_sets,before_rest_seconds,after_sets,after_rest_seconds,"
             "before_present,after_present,before_sets_present,after_sets_present,before_rest_present,after_rest_present) "
             "values($1,$2,$3::uuid,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)",
             pqxx::params{id, ++position, scope.account().str(), change["kind"].asString(), change["exerciseId"].asString(), json(before["sets"]), integer(before["restSeconds"]), json(after["sets"]), integer(after["restSeconds"]),
                          change.isMember("before"), change.isMember("after"), before.isMember("sets"), after.isMember("sets"), before.isMember("restSeconds"), after.isMember("restSeconds")});
  }
}

void writeAliases(SyncTxn& txn, const ScopeKey& scope, const Row& row) {
  auto& sql = sqlOf(txn);
  sql.exec("delete from gym_exercise_aliases where user_id=$1::uuid and exercise_id=$2", pqxx::params{scope.account().str(), row.id.column()});
  std::map<std::string, Json::Value> positions;
  int index = 0;
  for (const Json::Value& alias : value(&row, "aliases")) positions[alias.asString()].append(index++);
  for (const auto& [name, places] : positions) {
    const auto at = static_cast<std::int64_t>(row.ru) - places[0].asInt();
    sql.exec("insert into gym_exercise_aliases(user_id,exercise_id,name,created_at,sync_positions) values($1::uuid,$2,$3,to_timestamp($4::numeric/1000),$5::jsonb)",
             pqxx::params{scope.account().str(), row.id.column(), pgText(name), at, jcs(places)});
  }
}

std::string selectColumns(const TypeDef& type, const std::string& id, bool metadata) {
  std::string select = id == "" ? "'prefs'::text as sync_id" : id + "::text as sync_id";
  select += ", seq, rc, ru";
  if (type.identity == Identity::minted) select += ", born";
  if (type.life) select += ", life_stamp";
  for (const auto& [name, field] : type.fields) {
    const std::string col = column(type.name, name);
    if (field.kind == FieldKind::serial) { select += ", " + col; continue; }
    select += std::string(", ") + (metadataField(type.name, name) && !metadata ? "null::text as " : "") + snake(name) + "_stamp";
    if (complex(name)) continue;
    select += instant(type.name, name) ? ", (extract(epoch from " + col + ") * 1000)::bigint as " + col : ", " + col;
  }
  return select;
}

template <typename R>
Row readRow(SyncTxn& txn, const ScopeKey& scope, const TypeDef& type, const R& result, bool adoption = false) {
  Row row{type.name, RecordId(result["sync_id"].template as<std::string>())};
  row.seq = result["seq"].template as<Seq>();
  row.rc = result["rc"].template as<Ms>();
  row.ru = result["ru"].template as<Ms>();
  if (type.identity == Identity::minted) row.lattice.born = stampOf(result["born"].template as<std::string>());
  if (type.life) row.lattice.life = Life(LifeState::alive, stampOf(result["life_stamp"].template as<std::string>()));
  for (const auto& [name, field] : type.fields) {
    const std::string col = column(type.name, name);
    if (field.kind == FieldKind::serial) {
      if (!result[col.c_str()].is_null()) row.v[name] = Json::Int64(result[col.c_str()].template as<std::int64_t>());
      continue;
    }
    if (result[(snake(name) + "_stamp").c_str()].is_null()) continue;
    Json::Value v;
    if (name == "entries") v = readEntries(txn, row.id.column(), adoption && result["entries_adopting"].template as<bool>());
    else if (name == "changes") v = readChanges(txn, row.id.column(), adoption && result["changes_adopting"].template as<bool>());
    else if (name == "aliases") v = readAliases(txn, scope, row.id.column());
    else if (!result[col.c_str()].is_null()) {
      if (instant(type.name, name) || name == "recordedAt") v = Json::Int64(result[col.c_str()].template as<std::int64_t>());
      else if (name == "plan" || name == "snapshot") v = parseJson(result[col.c_str()].template as<std::string>());
      else if (field.domain && field.domain->type == Domain::Type::number) v = field.domain->integer ? Json::Value(Json::Int64(result[col.c_str()].template as<std::int64_t>())) : Json::Value(result[col.c_str()].template as<double>());
      else if (field.domain && field.domain->type == Domain::Type::boolean) v = result[col.c_str()].template as<bool>();
      else v = result[col.c_str()].template as<std::string>();
    }
    row.lattice.f.emplace(name, Reg(v, stampOf(result[(snake(name) + "_stamp").c_str()].template as<std::string>())));
  }
  return row;
}

std::string fallback(const std::string& type, const std::string& name) {
  if (type == "exerciseName" && name == "name") return "null";
  if (name == "name" || name == "body" || name == "summary" || name == "connection" || name == "agent" || name == "proposedName" || name == "note") return "''";
  if (name == "revision" || name == "baseRevision") return "1";
  if (name == "baseName") return "''";
  if (name == "changeCount") return "0";
  if (name == "completedAt" || name == "startedAt" || name == "updatedAt") return "to_timestamp(0)";
  if (name == "title") return "'_'";
  if (name == "position" || name == "weightKg") return "0";
  if (name == "reps") return "1";
  if (name == "pattern") return "'isolation'";
  if (name == "equipment") return "'bodyweight'";
  if (name == "kind") return "'working'";
  if (name == "intent") return "'revise'";
  if (name == "door") return "'ask'";
  if (name == "state") return "'pending'";
  if (type == "prefs") {
    if (name == "units") return "'kg'";
    if (name == "confirmSound") return "false";
    if (name != "restSeconds") return "true";
  }
  return "null";
}

void bindValue(pqxx::params& params, const Json::Value& value) {
  if (value.isNull()) { params.append(); return; }
  if (value.isString()) { params.append(pgText(value.asString())); return; }
  if (value.isBool()) { params.append(value.asBool()); return; }
  if (value.isIntegral()) { params.append(value.asInt64()); return; }
  if (value.isDouble()) { params.append(value.asDouble()); return; }
  params.append(jcs(value));
}

void setRevision(SyncTxn& txn, const RowWrite& write) {
  const bool moved = write.before && (!same(value(&*write.before, "name"), value(&*write.after, "name")) || !same(value(&*write.before, "entries"), value(&*write.after, "entries")));
  if (moved) sqlOf(txn).exec("update gym_routines set revision=revision+1 where id=$1", pqxx::params{write.id.column()});
}

}

PgGymType::PgGymType(const TypeDef& type) : type_(type), owner_(type.name == "exercise" ? "created_by" : "user_id"), id_("id") {
  static const std::map<std::string, std::string> tables{{"routine","gym_routines"},{"routineCreation","gym_routine_creations"},{"exercise","gym_exercises"},{"exerciseName","gym_exercise_names"},{"session","gym_sessions"},{"set","gym_sets"},{"note","gym_notes"},{"weighin","gym_bodyweight"},{"prefs","gym_preferences"},{"proposal","gym_proposals"}};
  table_ = tables.at(type.name);
  if (type.name == "routineCreation") id_ = "routine_id";
  if (type.name == "exerciseName") id_ = "exercise_id";
  if (type.name == "weighin") id_ = "date_local";
  if (type.name == "prefs") id_ = "";
}

std::map<std::string, Row> PgGymType::lock(SyncTxn& txn, const ScopeKey& scope, const std::vector<RecordId>& ids) {
  std::map<std::string, Row> rows;
  if (ids.empty()) return rows;
  if (type_.name == "routineCreation" && !metadataSchema(txn)) return rows;
  pqxx::params params{scope.account().str()};
  std::string where = owner_ + "=$1::uuid and seq is not null";
  if (!id_.empty()) where += " and " + id_ + "::text in (" + idPlaceholders(params, ids, 2) + ")";
  const auto result = sqlOf(txn).exec("select " + selectColumns(type_, id_, metadataSchema(txn)) + " from " + table_ + " where " + where + " order by " + (id_.empty() ? "user_id::text" : id_ + "::text") + " collate \"C\" for update", params);
  for (const auto& row : result) {
    Row stored = readRow(txn, scope, type_, row);
    rows.emplace(stored.id.key(), std::move(stored));
  }
  return rows;
}

std::set<std::string> PgGymType::elsewhere(SyncTxn& txn, const ScopeKey& scope, const std::vector<RecordId>& ids) {
  std::set<std::string> found;
  if (ids.empty() || type_.idSpace != IdSpace::global) return found;
  pqxx::params params{scope.account().str()};
  const std::string list = idPlaceholders(params, ids, 2);
  for (const auto& row : sqlOf(txn).exec("select " + id_ + " from " + table_ + " where " + owner_ + " is distinct from $1::uuid and " + id_ + " in (" + list + ")", params)) found.insert(RecordId(row[0].template as<std::string>()).key());
  return found;
}

void PgGymType::apply(SyncTxn& txn, const ScopeKey& scope, const std::vector<RowWrite>& writes) {
  auto& sql = sqlOf(txn);
  const bool metadata = metadataSchema(txn) && (type_.name == "routineCreation" ||
      std::any_of(type_.fields.begin(), type_.fields.end(), [&](const auto& field) { return metadataField(type_.name, field.first); }));
  std::vector<const RowWrite*> ordered;
  for (const RowWrite& write : writes) if (write.before) ordered.push_back(&write);
  for (const RowWrite& write : writes) if (!write.before) ordered.push_back(&write);
  for (const RowWrite* pointer : ordered) {
    const RowWrite& write = *pointer;
    if (type_.name == "set" && write.before) {
      sql.exec("insert into gym_set_revisions(set_id,session_id,user_id,exercise_id,set_number,weight_kg,reps,kind,rpe,note,completed_at,deleted,replaced_at) "
               "select id,session_id,user_id,exercise_id,set_number,weight_kg,reps,kind,rpe,note,completed_at,$3,to_timestamp($4::numeric/1000) from gym_sets where user_id=$1::uuid and id=$2",
               pqxx::params{scope.account().str(), write.id.column(), !write.after, static_cast<std::int64_t>(write.appliedAt.value_or(write.after ? write.after->ru : write.before->ru))});
    }
    if (!write.after) {
      std::string where = owner_ + "=$1::uuid";
      pqxx::params params{scope.account().str()};
      if (!id_.empty()) { where += " and " + id_ + "::text=$2"; params.append(write.id.column()); }
      if (type_.name == "exercise" || type_.name == "exerciseName") sql.exec("delete from gym_exercise_aliases where user_id=$1::uuid and exercise_id=$2", pqxx::params{scope.account().str(), write.id.column()});
      sql.exec("delete from " + table_ + " where " + where, params);
      continue;
    }
    const Row& row = *write.after;
    pqxx::params params;
    std::string columns, placeholders, updates;
    int index = 0;
    auto add = [&](const std::string& col, const std::string& expr, bool key = false) {
      columns += (columns.empty() ? "" : ",") + col;
      placeholders += (placeholders.empty() ? "" : ",") + expr;
      if (!key) updates += (updates.empty() ? "" : ",") + col + "=excluded." + col;
    };
    auto parameter = [&](const std::string& col, const auto& v, const std::string& suffix = "", bool key = false) {
      params.append(v); add(col, "$" + std::to_string(++index) + suffix, key);
    };
    parameter(owner_, scope.account().str(), "::uuid", true);
    if (!id_.empty()) parameter(id_, pgText(row.id.column()), type_.name == "weighin" ? "::date" : "", true);
    parameter("seq", static_cast<std::int64_t>(row.seq));
    parameter("rc", static_cast<std::int64_t>(row.rc));
    parameter("ru", static_cast<std::int64_t>(row.ru));
    if (type_.identity == Identity::minted) parameter("born", toString(*row.lattice.born));
    if (type_.life) parameter("life_stamp", toString(row.lattice.life->stamp));
    for (const auto& [name, field] : type_.fields) {
      if (!metadata && metadataField(type_.name, name)) continue;
      const std::string col = column(type_.name, name);
      if (field.kind == FieldKind::serial) {
        const auto serial = row.v.find(name);
        parameter(col, serial == row.v.end() ? std::int64_t{1} : serial->second.asInt64());
        continue;
      }
      const auto reg = row.lattice.f.find(name);
      parameter(snake(name) + "_stamp", reg == row.lattice.f.end() ? std::optional<std::string>() : std::optional(toString(reg->second.stamp)));
      if (complex(name)) continue;
      if (reg == row.lattice.f.end()) { add(col, fallback(type_.name, name)); continue; }
      bindValue(params, reg->second.value);
      const std::string p = "$" + std::to_string(++index);
      add(col, instant(type_.name, name) ? "to_timestamp(" + p + "::numeric/1000)" : p + (name == "plan" || name == "snapshot" ? "::jsonb" : ""));
    }
    if (type_.name == "routine" || type_.name == "exercise" || type_.name == "proposal" || type_.name == "note") add("created_at", "to_timestamp(" + std::to_string(row.rc) + "::numeric/1000)");
    if (type_.name == "exerciseName" || type_.name == "weighin" || type_.name == "prefs") add("updated_at", "to_timestamp(" + std::to_string(row.ru) + "::numeric/1000)");
    if (type_.name == "note") add("position", "0");
    if (!metadata && type_.name == "note") {
      const bool moved = !write.before || !same(value(&*write.before, "title"), value(&row, "title")) || !same(value(&*write.before, "body"), value(&row, "body"));
      add("updated_at", moved ? "to_timestamp(" + std::to_string(row.ru) + "::numeric/1000)" : "(select updated_at from gym_notes where id=" + sql.quote(row.id.column()) + ")");
    }
    if (!metadata && type_.name == "routine") {
      const std::string count = std::to_string(value(&row, "entries").size());
      if (!write.before) add("created_entries", count);
    }
    if (!metadata && type_.name == "proposal") {
      const std::string routine = value(&row, "routineId").asString();
      if (!write.before) {
        add("base_revision", "coalesce((select revision from gym_routines where id=" + sql.quote(routine) + "),1)");
        add("base_name", "coalesce((select name from gym_routines where id=" + sql.quote(routine) + "),'')");
      } else {
        add("base_revision", "(select base_revision from gym_proposals where id=" + sql.quote(row.id.column()) + ")");
        add("base_name", "(select base_name from gym_proposals where id=" + sql.quote(row.id.column()) + ")");
      }
      if (write.before) {
        add("changes", "(select changes from gym_proposals where id=" + sql.quote(row.id.column()) + ")");
      } else {
        const auto base = sql.exec("select name from gym_routines where id=$1", pqxx::params{routine});
        const Json::Value baseName = base.empty() ? Json::Value() : Json::Value(base[0][0].as<std::string>());
        const int count = proposalChangeCount(readEntries(txn, routine), value(&row, "changes"), baseName, value(&row, "proposedName"));
        add("changes", std::to_string(count));
      }
    }
    std::string target = "(" + id_ + ")";
    if (type_.name == "exerciseName" || type_.name == "weighin") target = "(user_id," + id_ + ")";
    if (type_.name == "prefs") target = "(user_id)";
    sql.exec("insert into " + table_ + "(" + columns + ") values(" + placeholders + ") on conflict " + target + " do update set " + updates, params);
    if (type_.name == "set" && !write.before) {
      Json::Value request(Json::objectValue);
      request["id"] = row.id.json();
      for (const char* field : {"exerciseId", "weightKg", "reps", "kind", "rpe", "note", "completedAt"})
        if (!value(&row, field).isNull()) request[field] = value(&row, field);
      const std::string session = value(&row, "sessionId").asString();
      sql.exec("insert into gym_write_receipts(kind,id,user_id,session_id,request_hash) values('set',$1,$2::uuid,$3,$4) on conflict do nothing",
               pqxx::params{row.id.column(), scope.account().str(), session, gymSetRequestHash(request, session)});
    }
    if (type_.name == "routine") {
      if (!metadata) setRevision(txn, write);
      writeEntries(txn, row.id.column(), value(&row, "entries"));
      if (!metadata && !write.before && value(&row, "createdDoor") == "ask") {
        Json::Value snapshot(Json::objectValue);
        snapshot["id"] = row.id.json(); snapshot["name"] = value(&row, "name"); snapshot["position"] = value(&row, "position").isNull() ? Json::Value(0) : value(&row, "position");
        snapshot["entries"] = value(&row, "entries"); snapshot["revision"] = 1;
        int position = 0;
        for (auto& entry : snapshot["entries"]) entry["position"] = ++position;
        sql.exec("insert into gym_routine_creations(routine_id,user_id,routine) values($1,$2::uuid,$3::jsonb) on conflict do nothing", pqxx::params{row.id.column(), scope.account().str(), jcs(snapshot)});
      }
    }
    if (type_.name == "proposal") writeChanges(txn, scope, row.id.column(), value(&row, "changes"));
    if (type_.name == "exercise" || type_.name == "exerciseName") writeAliases(txn, scope, row);
  }
  if (type_.name == "note") sql.exec("update gym_notes n set position=ranked.position from (select id,(row_number() over(order by ord collate \"C\" nulls first,id collate \"C\")-1)::int as position from gym_notes where user_id=$1::uuid) ranked where n.id=ranked.id", pqxx::params{scope.account().str()});
}

std::vector<Row> PgGymType::feed(SyncTxn& txn, const ScopeKey& scope, const FeedQuery& query) {
  if (type_.name == "routineCreation" && !metadataSchema(txn)) return {};
  pqxx::params params{scope.account().str(), static_cast<std::int64_t>(query.afterSeq), query.afterKey};
  const std::string key = id_.empty() ? "'prefs'::text" : id_ + "::text";
  std::string where = " where " + owner_ + "=$1::uuid and seq is not null and (seq>$2 or (seq=$2 and " + idOrder(key, false) + ">$3))";
  if (query.throughSeq) { params.append(static_cast<std::int64_t>(*query.throughSeq)); where += " and seq<=$4"; }
  std::vector<Row> rows;
  const auto result = sqlOf(txn).exec("select " + selectColumns(type_, id_, metadataSchema(txn)) + " from " + table_ + where + " order by seq," + idOrder(key, false), params);
  for (const auto& resultRow : result) {
    Row row = readRow(txn, scope, type_, resultRow);
    if (query.visibleOnly && !visible(type_, row)) continue;
    rows.push_back(std::move(row));
    if (query.limit && rows.size() >= query.limit) break;
  }
  return rows;
}

std::uint64_t PgGymType::count(SyncTxn& txn, const ScopeKey& scope, const FeedQuery& query) {
  FeedQuery all = query;
  all.limit = 0;
  return feed(txn, scope, all).size();
}

std::optional<std::int64_t> PgGymType::maxSerial(SyncTxn& txn, const ScopeKey& scope, const std::string& field, const std::map<std::string, Json::Value>& match) {
  if (type_.name != "set" || field != "setNumber") return std::nullopt;
  const auto result = sqlOf(txn).exec("select max(set_number) from gym_sets where user_id=$1::uuid and session_id=$2 and exercise_id=$3 and seq is not null", pqxx::params{scope.account().str(), match.at("sessionId").asString(), match.at("exerciseId").asString()});
  return result[0][0].is_null() ? std::nullopt : std::optional(result[0][0].as<std::int64_t>());
}

void PgGymType::purge(SyncTxn& txn, const ScopeKey& scope) {
  if (type_.name == "exercise" || type_.name == "exerciseName") sqlOf(txn).exec("delete from gym_exercise_aliases where user_id=$1::uuid", pqxx::params{scope.account().str()});
  sqlOf(txn).exec("delete from " + table_ + " where " + owner_ + "=$1::uuid", pqxx::params{scope.account().str()});
}

std::string PgGymType::adoptionPredicate(bool permitUnsetDefaults) const {
  std::string missing = "seq is null or seq<=0 or rc is null or ru is null";
  if (type_.identity == Identity::minted) missing += " or born is null";
  if (type_.life) missing += " or life_stamp is null";
  for (const auto& [name, field] : type_.fields) {
    if (field.kind == FieldKind::serial) continue;
    std::string present = physicalField(table_, id_, type_.name, name);
    if (permitUnsetDefaults) {
      if (name == "entries") present = "exists(select 1 from gym_routine_entries e where e.routine_id=" + table_ + "." + id_ + ")";
      else if (name == "changes") present = "exists(select 1 from gym_proposal_changes c where c.proposal_id=" + table_ + "." + id_ + ")";
      else if (name != "aliases") present = column(type_.name, name) + " is distinct from " + fallback(type_.name, name);
    }
    missing += " or (" + present + " and " + snake(name) + "_stamp is null)";
  }
  if (type_.name == "note" && !permitUnsetDefaults) missing += " or ord is null";
  return "(" + missing + ")";
}

bool PgGymType::needsAdoption(SyncTxn& txn, const ScopeKey& scope, bool permitUnsetDefaults) {
  auto& sql = sqlOf(txn);
  const pqxx::params owner{scope.account().str()};
  if (sql.exec("select exists(select 1 from " + table_ + " where " + owner_ + "=$1::uuid and " + adoptionPredicate(permitUnsetDefaults) + ")", owner)[0][0].as<bool>()) return true;
  return type_.name == "exerciseName" && sql.exec("select exists(select 1 from gym_exercise_aliases a join gym_exercises e on e.id=a.exercise_id "
    "where a.user_id=$1::uuid and e.created_by is null and not exists(select 1 from gym_exercise_names n where n.user_id=a.user_id and n.exercise_id=a.exercise_id))", owner)[0][0].as<bool>();
}

Seq PgGymType::greatestSeq(SyncTxn& txn, const ScopeKey& scope) {
  return sqlOf(txn).exec("select coalesce(max(seq),0) from " + table_ + " where " + owner_ + "=$1::uuid", pqxx::params{scope.account().str()})[0][0].as<Seq>();
}

std::vector<Row> PgGymType::adoptedRows(SyncTxn& txn, const ScopeKey& scope) {
  std::vector<Row> rows;
  for (const auto& result : sqlOf(txn).exec("select " + selectColumns(type_, id_, metadataSchema(txn)) + " from " + table_ + " where " + owner_ + "=$1::uuid and not " + adoptionPredicate(), pqxx::params{scope.account().str()}))
    rows.push_back(readRow(txn, scope, type_, result));
  return rows;
}

std::vector<Row> PgGymType::adoptionRows(SyncTxn& txn, const ScopeKey& scope, Ms migrationTime) {
  auto& sql = sqlOf(txn);
  const std::string stamp = sql.quote(std::to_string(migrationTime) + ":0:srv");
  const std::string now = std::to_string(migrationTime) + "::bigint";
  const bool created = type_.name == "routine" || type_.name == "exercise" || type_.name == "proposal" || type_.name == "note";
  const bool updated = type_.name == "exerciseName" || type_.name == "weighin" || type_.name == "prefs" || type_.name == "note";
  const std::string at = updated ? "(extract(epoch from updated_at)*1000)::bigint" : now;
  std::string select = id_.empty() ? "'prefs'::text as sync_id" : id_ + "::text as sync_id";
  select += ", coalesce(seq,1)::bigint as seq, coalesce(rc," + (created ? "(extract(epoch from created_at)*1000)::bigint" : at) + ") as rc, coalesce(ru," + at + ") as ru";
  if (type_.identity == Identity::minted) select += ", coalesce(born," + stamp + ") as born";
  if (type_.life) select += ", coalesce(life_stamp," + stamp + ") as life_stamp";
  for (const auto& [name, field] : type_.fields) {
    const std::string col = column(type_.name, name);
    if (field.kind == FieldKind::serial) { select += ", " + col; continue; }
    select += ", coalesce(" + snake(name) + "_stamp, case when " + physicalField(table_, id_, type_.name, name) + " then " + stamp + " end) as " + snake(name) + "_stamp";
    if (name == "entries" || name == "changes") select += ", " + snake(name) + "_stamp is null as " + name + "_adopting";
    if (complex(name)) continue;
    select += instant(type_.name, name) ? ", (extract(epoch from " + col + ")*1000)::bigint as " + col : ", " + col;
  }
  std::string order = id_.empty() ? "" : " order by " + id_ + "::text collate \"C\"";
  if (type_.name == "note") order = " order by position, id collate \"C\"";
  std::vector<Row> rows;
  std::optional<std::string> ord;
  const auto results = sql.exec("select " + select + ", " + adoptionPredicate() + " as adopting from " + table_ + " where " + owner_ + "=$1::uuid" + order, pqxx::params{scope.account().str()});
  for (std::size_t index = 0; index < results.size(); ++index) {
    const auto result = results[index];
    if (type_.name == "note") {
      if (!result["ord"].is_null()) ord = result["ord"].as<std::string>();
      else {
        std::optional<std::string> next;
        for (std::size_t later = index + 1; later < results.size(); ++later) {
          if (!results[later]["ord"].is_null()) { next = results[later]["ord"].as<std::string>(); break; }
        }
        ord = between(ord, next);
      }
    }
    if (!result["adopting"].as<bool>()) continue;
    Row row = readRow(txn, scope, type_, result, true);
    if (type_.name == "note") row.lattice.f.insert_or_assign("ord", Reg(*ord, stampOf(result["ord_stamp"].as<std::string>())));
    rows.push_back(std::move(row));
  }
  if (type_.name == "exerciseName") {
    for (const auto& result : sql.exec("select distinct a.exercise_id from gym_exercise_aliases a join gym_exercises e on e.id=a.exercise_id "
                                      "where a.user_id=$1::uuid and e.created_by is null and not exists(select 1 from gym_exercise_names n where n.user_id=a.user_id and n.exercise_id=a.exercise_id)", pqxx::params{scope.account().str()})) {
      Row row(type_.name, RecordId(result[0].template as<std::string>()));
      row.rc = row.ru = migrationTime;
      row.lattice.f.emplace("aliases", Reg(readAliases(txn, scope, row.id.column()), stampOf(std::to_string(migrationTime) + ":0:srv")));
      rows.push_back(std::move(row));
    }
  }
  return rows;
}

void PgGymType::adopt(SyncTxn& txn, const ScopeKey& scope, const std::vector<Row>& rows) {
  auto& sql = sqlOf(txn);
  for (const Row& row : rows) {
    if (type_.name == "exerciseName") {
      sql.exec("insert into gym_exercise_names(user_id,exercise_id,name,updated_at) values($1::uuid,$2,null,to_timestamp($3::numeric/1000)) on conflict do nothing",
               pqxx::params{scope.account().str(), row.id.column(), static_cast<std::int64_t>(row.ru)});
    }
    pqxx::params params{scope.account().str()};
    std::string updates;
    auto add = [&](const std::string& col, const auto& value) {
      params.append(value);
      if (!updates.empty()) updates += ",";
      updates += col + "=$" + std::to_string(params.size());
    };
    add("seq", static_cast<std::int64_t>(row.seq));
    add("rc", static_cast<std::int64_t>(row.rc));
    add("ru", static_cast<std::int64_t>(row.ru));
    if (row.lattice.born) add("born", toString(*row.lattice.born));
    if (row.lattice.life) add("life_stamp", toString(row.lattice.life->stamp));
    for (const auto& [name, field] : type_.fields) {
      if (field.kind == FieldKind::serial) continue;
      const auto found = row.lattice.f.find(name);
      add(snake(name) + "_stamp", found == row.lattice.f.end() ? std::optional<std::string>() : std::optional(toString(found->second.stamp)));
    }
    if (type_.name == "note") add("ord", row.lattice.f.at("ord").value.asString());
    std::string where = owner_ + "=$1::uuid";
    if (!id_.empty()) {
      params.append(row.id.column());
      where += " and " + id_ + "::text=$" + std::to_string(params.size());
    }
    sql.exec("update " + table_ + " set " + updates + " where " + where, params);
    if (type_.name == "routine") {
      int position = 0;
      for (const auto& entry : value(&row, "entries")) {
        ++position;
        sql.exec("update gym_routine_entries set rest_seconds_present=$3,sets_present=$4 where routine_id=$1 and position=$2",
                 pqxx::params{row.id.column(), position, entry.isMember("restSeconds"), entry.isMember("sets")});
        int setIndex = 0;
        for (const auto& set : entry["sets"]) sql.exec("update gym_routine_entry_sets set reps_present=$4,weight_kg_present=$5 where routine_id=$1 and position=$2 and set_index=$3",
                 pqxx::params{row.id.column(), position, ++setIndex, set.isMember("reps"), set.isMember("weightKg")});
      }
    }
    if (type_.name == "proposal") {
      int position = 0;
      for (const auto& change : value(&row, "changes")) {
        const auto& before = change["before"];
        const auto& after = change["after"];
        sql.exec("update gym_proposal_changes set before_present=$3,after_present=$4,before_sets_present=$5,after_sets_present=$6,before_rest_present=$7,after_rest_present=$8 where proposal_id=$1 and position=$2",
                 pqxx::params{row.id.column(), ++position, change.isMember("before"), change.isMember("after"), before.isMember("sets"), after.isMember("sets"), before.isMember("restSeconds"), after.isMember("restSeconds")});
      }
    }
  }

}

Json::Value PgGymState::load(SyncTxn& txn, const ScopeKey& scope) {
  Json::Value books(Json::objectValue);
  auto& sql = sqlOf(txn);
  const pqxx::params owner{scope.account().str()};
  books["metadataVersion"] = metadataSchema(txn) ? 5 : 4;
  for (const auto& row : sql.exec("select id,name from gym_exercises where created_by is null")) books["seeds"][row[0].template as<std::string>()]["name"] = row[1].template as<std::string>();
  if (books["metadataVersion"] == 4) for (const auto& row : sql.exec("select id,revision from gym_routines where user_id=$1::uuid and seq is not null", owner)) {
    books["revisions"][row[0].template as<std::string>()] = row[1].template as<int>();
  }
  if (books["metadataVersion"] == 4) for (const auto& row : sql.exec("select id,base_revision,base_name from gym_proposals where user_id=$1::uuid and seq is not null", owner)) {
    const std::string id = row[0].template as<std::string>();
    books["bases"][id]["revision"] = row[1].template as<int>();
    books["bases"][id]["name"] = row[2].template as<std::string>();
  }
  for (const auto& row : sql.exec("select id,session_id,sync_kind,sync_args,request_hash from gym_write_receipts where user_id=$1::uuid and kind='session'", owner)) {
    const std::string id = row[0].template as<std::string>();
    if (row[2].is_null() || row[2].template as<std::string>() == "starts") books["starts"][id] = row[1].template as<std::string>();
    else {
      books["importHashes"][id] = row[3].is_null() ? row[4].template as<std::string>() : sha256(jcs(parseJson(row[3].template as<std::string>()))).hex();
      if (!row[3].is_null()) books["imports"][id] = parseJson(row[3].template as<std::string>());
    }
  }
  for (const auto& row : sql.exec("select id,session_id,sync_args,request_hash from gym_correction_receipts where user_id=$1::uuid", owner)) {
    const std::string id = row[0].template as<std::string>();
    books["correctionHashes"][id] = row[2].is_null() ? row[3].template as<std::string>() : sha256(jcs(parseJson(row[2].template as<std::string>()))).hex();
    books["corrections"][id]["sessionId"] = row[1].template as<std::string>();
    if (!row[2].is_null()) books["corrections"][id]["args"] = parseJson(row[2].template as<std::string>());
  }
  return books;
}

void PgGymState::receipt(SyncTxn& txn, const ScopeKey& scope, const std::string& kind, const std::string& id, const Json::Value& receipt) {
  auto& sql = sqlOf(txn);
  const Json::Value args = kind == "corrections" ? receipt["args"] : receipt;
  const std::string hash = kind == "imports" ? gymImportRequestHash(args) : kind == "corrections" ? gymCorrectionRequestHash(args) : sha256(jcs(args)).hex();
  if (kind == "corrections") {
    sql.exec("insert into gym_correction_receipts(id,user_id,session_id,request_hash,sync_args) values($1,$2::uuid,$3,$4,$5::jsonb) on conflict do nothing", pqxx::params{id, scope.account().str(), receipt["sessionId"].asString(), hash, jcs(args)});
    return;
  }
  const std::string session = kind == "starts" ? receipt.asString() : id;
  sql.exec("insert into gym_write_receipts(kind,id,user_id,session_id,request_hash,sync_kind,sync_args) values('session',$1,$2::uuid,$3,$4,$5,$6::jsonb) on conflict do nothing", pqxx::params{id, scope.account().str(), session, hash, kind, kind == "starts" ? std::optional<std::string>() : std::optional(jcs(args))});
}

PgGym::PgGym(const Registry& registry) : product_(state_) {
  for (const TypeDef& type : registry.types())
    if (type.scope == RegistryScope{ScopeKind::product, "gym"}) stores_.push_back(std::make_unique<PgGymType>(type));
}

void PgGym::bindTo(SyncCatalog& catalog, bool checkAdoption) {
  std::map<std::string, TypeStore*> stores;
  for (const auto& store : stores_) stores.emplace(store->def().name, store.get());
  product_.bindTo(catalog, stores);
  if (checkAdoption) catalog.bindReadiness("gym", *this);
}

void PgGym::requireReady(SyncTxn& txn, const ScopeKey& scope) {
  try {
    PgGymMetadataUpgrade::requireComplete(txn);
    const auto rows = sqlOf(txn).exec(
        "select exists(select 1 from gym_sync_adoptions where user_id=$1::uuid) as marker,"
        " exists(select 1 from sync_scopes where key=$2 and state='alive') as scope",
        pqxx::params{scope.account().str(), scope.text()});
    const auto& status = rows[0];
    if ((status["marker"].as<bool>() && !status["scope"].as<bool>()) || !PgGymBackfill::adopted(txn, scope, true))
      throw ProductScopeUnavailable("gym account has not completed adoption");
  } catch (const pqxx::undefined_column&) {
    throw ProductScopeUnavailable("gym adoption schema is unavailable");
  } catch (const pqxx::undefined_table&) {
    throw ProductScopeUnavailable("gym adoption schema is unavailable");
  } catch (const ProductScopeUnavailable&) {
    throw;
  } catch (const MetadataUpgradeError&) {
    throw ProductScopeUnavailable("gym metadata upgrade is incomplete");
  }
}

void PgGym::requireWritable(SyncTxn& txn, const ScopeKey& scope) {
  if (gymWriteFrozen()) throw ProductScopeUnavailable("gym writes are frozen");
  requireReady(txn, scope);
}

}
