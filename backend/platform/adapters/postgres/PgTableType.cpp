#include "platform/adapters/postgres/PgTableType.h"

#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/domain/sync/Jcs.h"

#include <algorithm>
#include <cctype>
#include <stdexcept>
#include <utility>

namespace wm::sync {

namespace {

std::string snakeCase(const std::string& field) {
  std::string column;
  for (const char c : field) {
    if (std::isupper(static_cast<unsigned char>(c))) {
      column.push_back('_');
      column.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
      continue;
    }
    column.push_back(c);
  }
  return column;
}

void appendValue(pqxx::params& params, SqlType type, const Json::Value& value) {
  if (value.isNull()) {
    params.append(std::optional<std::string>());
    return;
  }
  switch (type) {
    case SqlType::text: params.append(pgText(value.asString())); return;
    case SqlType::bigint: params.append(value.asInt64()); return;
    case SqlType::float8: params.append(value.asDouble()); return;
    case SqlType::boolean: params.append(value.asBool()); return;
    case SqlType::jsonb: params.append(jcs(value)); return;
  }
}

template <typename F>
Json::Value valueOf(const F& field, SqlType type) {
  if (field.is_null()) return Json::Value(Json::nullValue);
  switch (type) {
    case SqlType::text: return Json::Value(field.template as<std::string>());
    case SqlType::bigint: return Json::Value(Json::Int64(field.template as<std::int64_t>()));
    case SqlType::float8: return Json::Value(field.template as<double>());
    case SqlType::boolean: return Json::Value(field.template as<bool>());
    case SqlType::jsonb: return parseJson(field.template as<std::string>());
  }
  return Json::Value(Json::nullValue);
}

template <typename F>
std::optional<std::string> maybeText(const F& field) {
  if (field.is_null()) return std::nullopt;
  return field.template as<std::string>();
}

SqlType requiredType(const FieldDef& field, SqlType declared) {
  if (field.kind == FieldKind::text && declared != SqlType::text) throw std::logic_error("the text field " + field.name + " is stored as text");
  if ((field.kind == FieldKind::serial || field.kind == FieldKind::time) && declared != SqlType::bigint)
    throw std::logic_error("the field " + field.name + " holds epoch ms or a serial, stored as bigint");
  return declared;
}

}

PgTableType::PgTableType(const TypeDef& type, TableMap map) : type_(type), map_(std::move(map)) {
  for (const auto& [name, field] : type_.fields) {
    if (!map_.fields.contains(name)) throw std::logic_error(map_.table + " stores no column for the field " + type_.name + "." + name);
  }
  for (const auto& [name, sqlType] : map_.fields) {
    if (!type_.field(name)) throw std::logic_error(map_.table + " stores " + name + ", which the type " + type_.name + " does not declare");
  }

  using Part = Column::Part;
  columns_ = {{"scope_key", "", Part::scope}, {"id", "", Part::id}, {"seq", "", Part::seq}, {"rc", "", Part::rc}, {"ru", "", Part::ru}};
  const bool hasBorn = type_.identity == Identity::minted || type_.identity == Identity::derived;
  const bool keepsDead = type_.life && type_.deadRows == DeadRows::keep;
  if (hasBorn) columns_.push_back({"born", "", Part::born});
  if (keepsDead) columns_.push_back({"life", "", Part::life});
  if (type_.life) columns_.push_back({"life_stamp", "", Part::lifeStamp});
  std::vector<std::string> anyField;
  std::vector<std::string> visibleWhen;
  for (const auto& [name, field] : type_.fields) {
    const std::string column = snakeCase(name);
    const SqlType sqlType = requiredType(field, map_.fields.at(name));
    const bool visibility = std::find(type_.visibleWhen.begin(), type_.visibleWhen.end(), name) != type_.visibleWhen.end();
    if (field.kind == FieldKind::text) {
      columns_.push_back({column, name, Part::text, SqlType::text});
      columns_.push_back({column + "_rev", name, Part::rev, SqlType::bigint});
      columns_.push_back({column + "_merged", name, Part::merged, SqlType::boolean});
      anyField.push_back(column + "_rev is not null");
      if (visibility) visibleWhen.push_back("(" + column + "_rev is not null and " + column + " <> '')");
      continue;
    }
    if (field.kind == FieldKind::serial) {
      columns_.push_back({column, name, Part::serial, SqlType::bigint});
      continue;
    }
    columns_.push_back({column, name, Part::value, sqlType});
    columns_.push_back({column + "_stamp", name, Part::stamp});
    anyField.push_back(column + "_stamp is not null");
    if (!visibility) continue;
    if (sqlType == SqlType::text) visibleWhen.push_back("(" + column + " is not null and " + column + " <> '')");
    else if (sqlType == SqlType::jsonb) visibleWhen.push_back("(" + column + " is not null and " + column + " <> '\"\"'::jsonb)");
    else visibleWhen.push_back(column + " is not null");
  }

  for (std::size_t i = 0; i < columns_.size(); ++i) columnList_ += (i ? ", " : "") + columns_[i].name;
  conflictTarget_ = type_.idSpace == IdSpace::global ? "(id)" : "(scope_key, id)";
  idOrder_ = idOrder("id", !type_.keyTuple.empty());
  aliveWhere_ = keepsDead ? " and life = 'alive'" : "";
  auto disjunction = [](const std::vector<std::string>& terms) {
    std::string any;
    for (const std::string& term : terms) any += (any.empty() ? "" : " or ") + term;
    return any.empty() ? std::string(" and false") : " and (" + any + ")";
  };
  if (type_.identity == Identity::singleton) visibleWhere_ = "";
  else if (type_.life) visibleWhere_ = aliveWhere_;
  else visibleWhere_ = disjunction(type_.visibleWhen.empty() ? anyField : visibleWhen);
}

template <typename R>
Row PgTableType::rowOf(const R& result) const {
  using Part = Column::Part;
  Row row{type_.name, RecordId::fromColumn(result["id"].template as<std::string>(), !type_.keyTuple.empty())};
  std::optional<std::string> life;
  for (const Column& column : columns_) {
    const auto field = result[column.name.c_str()];
    switch (column.part) {
      case Part::seq: row.seq = field.template as<std::uint64_t>(); break;
      case Part::rc: row.rc = field.template as<std::uint64_t>(); break;
      case Part::ru: row.ru = field.template as<std::uint64_t>(); break;
      case Part::born: row.lattice.born = stampOf(Json::Value(field.template as<std::string>())); break;
      case Part::life: life = field.template as<std::string>(); break;
      case Part::lifeStamp: {
        const Stamp stamp = stampOf(Json::Value(field.template as<std::string>()));
        row.lattice.life = Life(life && *life == "dead" ? LifeState::dead : LifeState::alive, stamp);
        break;
      }
      case Part::stamp:
        if (const std::optional<std::string> stamp = maybeText(field))
          row.lattice.f.insert_or_assign(column.field, Reg(valueOf(result[snakeCase(column.field).c_str()], valueColumn(column.field).type), stampOf(Json::Value(*stamp))));
        break;
      case Part::rev:
        if (!field.is_null()) {
          row.x[column.field] = TextVal{maybeText(result[snakeCase(column.field).c_str()]).value_or(""), field.template as<std::uint64_t>(),
                                        result[(snakeCase(column.field) + "_merged").c_str()].template as<bool>()};
        }
        break;
      case Part::serial:
        if (!field.is_null()) row.v[column.field] = Json::Int64(field.template as<std::int64_t>());
        break;
      default: break;
    }
  }
  return row;
}

const PgTableType::Column& PgTableType::valueColumn(const std::string& field) const {
  for (const Column& column : columns_) {
    if (column.field == field && (column.part == Column::Part::value || column.part == Column::Part::serial || column.part == Column::Part::text)) return column;
  }
  throw std::logic_error("the type " + type_.name + " has no field " + field);
}

std::string PgTableType::keysetWhere(pqxx::params& params, const ScopeKey& scope, const FeedQuery& query) const {
  params.append(scope.text());
  params.append(static_cast<std::int64_t>(query.afterSeq));
  params.append(query.afterKey);
  std::string where = " where scope_key = $1 and (seq > $2 or (seq = $2 and " + idOrder_ + " > $3))";
  if (query.throughSeq) {
    params.append(static_cast<std::int64_t>(*query.throughSeq));
    where += " and seq <= $4";
  }
  if (query.aliveOnly) where += aliveWhere_;
  if (query.visibleOnly) where += visibleWhere_;
  return where;
}

std::map<std::string, Row> PgTableType::lock(SyncTxn& txn, const ScopeKey& scope, const std::vector<RecordId>& ids) {
  std::map<std::string, Row> rows;
  if (ids.empty()) return rows;
  pqxx::params params{scope.text()};
  const std::string list = idPlaceholders(params, ids, 2);
  const pqxx::result result = sqlOf(txn).exec(
      "select " + columnList_ + " from " + map_.table + " where scope_key = $1 and id in (" + list + ") order by id collate \"C\" for update", params);
  for (const auto& row : result) {
    Row read = rowOf(row);
    rows.emplace(read.id.key(), std::move(read));
  }
  return rows;
}

std::set<std::string> PgTableType::elsewhere(SyncTxn& txn, const ScopeKey& scope, const std::vector<RecordId>& ids) {
  std::set<std::string> found;
  if (ids.empty()) return found;
  pqxx::params params{scope.text()};
  const std::string list = idPlaceholders(params, ids, 2);
  const pqxx::result result = sqlOf(txn).exec("select id from " + map_.table + " where scope_key <> $1 and id in (" + list + ")", params);
  for (const auto& row : result) found.insert(RecordId::fromColumn(row["id"].template as<std::string>(), !type_.keyTuple.empty()).key());
  return found;
}

void PgTableType::apply(SyncTxn& txn, const ScopeKey& scope, const std::vector<RowWrite>& writes) {
  using Part = Column::Part;
  pqxx::transaction_base& sql = sqlOf(txn);
  std::string placeholders;
  std::string updates;
  for (std::size_t i = 0; i < columns_.size(); ++i) {
    placeholders += (i ? ", $" : "$") + std::to_string(i + 1);
    if (columns_[i].part == Part::id || (columns_[i].part == Part::scope && type_.idSpace != IdSpace::global)) continue;
    updates += (updates.empty() ? "" : ", ") + columns_[i].name + " = excluded." + columns_[i].name;
  }
  const std::string upsert = "insert into " + map_.table + " (" + columnList_ + ") values (" + placeholders + ") on conflict " + conflictTarget_ +
                             " do update set " + updates;

  for (const RowWrite& write : writes) {
    if (!write.after) {
      sql.exec("delete from " + map_.table + " where scope_key = $1 and id = $2", pqxx::params{scope.text(), pgText(write.id.column())});
    } else {
      const Row& row = *write.after;
      pqxx::params params;
      for (const Column& column : columns_) {
        const auto reg = row.lattice.f.find(column.field);
        const auto text = row.x.find(column.field);
        switch (column.part) {
          case Part::scope: params.append(scope.text()); break;
          case Part::id: params.append(pgText(row.id.column())); break;
          case Part::seq: params.append(static_cast<std::int64_t>(row.seq)); break;
          case Part::rc: params.append(static_cast<std::int64_t>(row.rc)); break;
          case Part::ru: params.append(static_cast<std::int64_t>(row.ru)); break;
          case Part::born: params.append(toString(*row.lattice.born)); break;
          case Part::life: params.append(std::string(row.lattice.life->alive() ? "alive" : "dead")); break;
          case Part::lifeStamp: params.append(toString(row.lattice.life->stamp)); break;
          case Part::value: appendValue(params, column.type, reg == row.lattice.f.end() ? Json::Value() : reg->second.value); break;
          case Part::stamp: params.append(reg == row.lattice.f.end() ? std::optional<std::string>() : toString(reg->second.stamp)); break;
          case Part::text: params.append(text == row.x.end() ? std::optional<std::string>() : pgText(text->second.text)); break;
          case Part::rev:
            params.append(text == row.x.end() ? std::optional<std::int64_t>() : static_cast<std::int64_t>(text->second.rev));
            break;
          case Part::merged: params.append(text != row.x.end() && text->second.merged); break;
          case Part::serial: {
            const auto serial = row.v.find(column.field);
            params.append(serial == row.v.end() ? std::optional<std::int64_t>() : serial->second.asInt64());
            break;
          }
        }
      }
      sql.exec(upsert, params);
    }
    for (const TextRevision& revision : write.revisions) {
      const std::string revisions = map_.table + "_revisions";
      sql.exec("insert into " + revisions + " (scope_key, id, field, rev, text) values ($1, $2, $3, $4, $5) on conflict do nothing",
               pqxx::params{scope.text(), pgText(write.id.column()), revision.field, static_cast<std::int64_t>(revision.rev), pgText(revision.text)});
      sql.exec("delete from " + revisions + " where scope_key = $1 and id = $2 and field = $3 and rev not in (select rev from " + revisions +
                   " where scope_key = $1 and id = $2 and field = $3 order by rev desc limit $4)",
               pqxx::params{scope.text(), pgText(write.id.column()), revision.field, static_cast<std::int64_t>(map_.revisionsKept)});
    }
  }
}

std::vector<Row> PgTableType::feed(SyncTxn& txn, const ScopeKey& scope, const FeedQuery& query) {
  pqxx::params params;
  std::string sql = "select " + columnList_ + " from " + map_.table + keysetWhere(params, scope, query) + " order by seq, " + idOrder_;
  if (query.limit > 0) sql += " limit " + std::to_string(query.limit);
  std::vector<Row> rows;
  for (const auto& row : sqlOf(txn).exec(sql, params)) rows.push_back(rowOf(row));
  return rows;
}

std::uint64_t PgTableType::count(SyncTxn& txn, const ScopeKey& scope, const FeedQuery& query) {
  pqxx::params params;
  const std::string where = keysetWhere(params, scope, query);
  const pqxx::result result = sqlOf(txn).exec("select count(*) as total from " + map_.table + where, params);
  return result[0]["total"].as<std::uint64_t>();
}

std::optional<std::int64_t> PgTableType::maxSerial(SyncTxn& txn, const ScopeKey& scope, const std::string& field,
                                                   const std::map<std::string, Json::Value>& match) {
  pqxx::params params{scope.text()};
  std::string where = " where scope_key = $1" + aliveWhere_;
  int placeholder = 2;
  for (const auto& [name, value] : match) {
    const Column& column = valueColumn(name);
    appendValue(params, column.type, value);
    where += " and " + column.name + " is not distinct from $" + std::to_string(placeholder++);
  }
  const pqxx::result result = sqlOf(txn).exec("select max(" + valueColumn(field).name + ") as highest from " + map_.table + where, params);
  if (result[0]["highest"].is_null()) return std::nullopt;
  return result[0]["highest"].as<std::int64_t>();
}

std::optional<std::string> PgTableType::revisionText(SyncTxn& txn, const ScopeKey& scope, const RecordId& id, const std::string& field, Seq rev) {
  const pqxx::result result = sqlOf(txn).exec(
      "select text from " + map_.table + "_revisions where scope_key = $1 and id = $2 and field = $3 and rev = $4",
      pqxx::params{scope.text(), pgText(id.column()), field, static_cast<std::int64_t>(rev)});
  if (result.empty()) return std::nullopt;
  return result[0]["text"].as<std::string>();
}

void PgTableType::purge(SyncTxn& txn, const ScopeKey& scope) {
  const bool keepsRevisions = std::any_of(type_.fields.begin(), type_.fields.end(), [](const auto& entry) { return entry.second.kind == FieldKind::text; });
  if (keepsRevisions) sqlOf(txn).exec("delete from " + map_.table + "_revisions where scope_key = $1", pqxx::params{scope.text()});
  sqlOf(txn).exec("delete from " + map_.table + " where scope_key = $1", pqxx::params{scope.text()});
}

}
