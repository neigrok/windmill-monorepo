#include "products/journal/sync/adapters/postgres/PgJournal.h"

#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/domain/sync/Jcs.h"
#include "products/journal/application/JournalSwitches.h"

#include <algorithm>
#include <stdexcept>

namespace wm::journal::engine {

using namespace sync;

namespace {

std::string column(const std::string& field) {
  if (field == "documentStamp") return "document_stamp";
  if (field == "privacyLine") return "privacy_line";
  if (field == "firstPage") return "first_page";
  return field;
}

Json::Value scale(const Json::Value& value) {
  return value.isIntegral() && value.asInt64() >= 0 && value.asInt64() <= 10 ? value : Json::Value();
}

template <typename R>
Json::Value documentStamp(const R& row) {
  Json::Value stamp(Json::objectValue);
  stamp["ms"] = Json::UInt64(row["stamp_ms"].template as<Ms>());
  stamp["counter"] = Json::UInt64(row["stamp_counter"].template as<std::uint64_t>());
  stamp["actor"] = row["stamp_actor"].template as<std::string>();
  return stamp;
}

template <typename R>
Row readRow(const TypeDef& type, const R& result) {
  Row row(type.name, RecordId(type.name == "page" ? result["sync_id"].template as<std::string>() : std::string("journalState")));
  row.seq = result["seq"].template as<Seq>();
  row.rc = result["rc"].template as<Ms>();
  row.ru = result["ru"].template as<Ms>();
  for (const auto& [name, field] : type.fields) {
    if (name == "body") {
      if (!result["body_rev"].is_null()) row.x.emplace(name, TextVal{result["body"].template as<std::string>(), result["body_rev"].template as<Seq>(), result["body_merged"].template as<bool>()});
      continue;
    }
    const auto stamp = result[column(name) + "_stamp"];
    if (stamp.is_null()) continue;
    Json::Value value;
    if (name == "documentStamp") value = documentStamp(result);
    else if (name == "mood" || name == "energy") {
      if (!result[name].is_null()) value = scale(Json::Value(result[name].template as<int>()));
    } else {
      value = result[column(name)].template as<std::string>();
      if (name == "source" && value != "spoken") value = "typed";
    }
    row.lattice.f.emplace(name, Reg(value, stampOf(stamp.template as<std::string>())));
  }
  return row;
}

std::string select(const std::string& type) {
  return type == "page" ? "*,to_char(day,'YYYY-MM-DD') as sync_id" : "*";
}

}

PgJournalType::PgJournalType(const TypeDef& type) : type_(type), table_(type.name == "page" ? "journal_page" : "journal_sync_state") {
  if (type.name != "page" && type.name != "journalState") throw std::logic_error("unsupported journal type " + type.name);
}

std::map<std::string, Row> PgJournalType::lock(SyncTxn& txn, const ScopeKey& scope, const std::vector<RecordId>& ids) {
  std::map<std::string, Row> rows;
  if (ids.empty()) return rows;
  auto& sql = sqlOf(txn);
  pqxx::params params{scope.account().str()};
  std::string where = "user_id=$1::uuid and seq is not null";
  if (type_.name == "page") where += " and day::text in (" + idPlaceholders(params, ids, 2) + ")";
  else if (std::none_of(ids.begin(), ids.end(), [](const RecordId& id) { return id.column() == "journalState"; })) return rows;
  const auto result = sql.exec("select " + select(type_.name) + " from " + table_ + " where " + where + (type_.name == "page" ? " order by day" : "") + " for update", params);
  for (const auto& value : result) {
    Row row = readRow(type_, value);
    rows.emplace(row.id.key(), std::move(row));
  }
  return rows;
}

void PgJournalType::apply(SyncTxn& txn, const ScopeKey& scope, const std::vector<RowWrite>& writes) {
  auto& sql = sqlOf(txn);
  const std::string owner = scope.account().str();
  std::set<std::string> archivedDays;
  Ms archiveNow = 0;
  for (const RowWrite& write : writes) {
    if (!write.after) throw std::logic_error("journal records have no delete");
    const Row& row = *write.after;
    if (type_.name == "page") {
      for (const TextRevision& revision : write.revisions) {
        if (revision.field != "body") throw std::logic_error("unknown journal revision field");
        Json::Value stamp = write.before->lattice.f.at("documentStamp").value;
        const Ms at = write.appliedAt.value_or(row.ru);
        sql.exec("insert into journal_page_revision(user_id,day,body,stamp_ms,stamp_counter,stamp_actor,superseded_at,engine_rev) values($1::uuid,$2::date,$3,$4,$5,$6,to_timestamp($7::numeric/1000),$8)",
          pqxx::params{owner, row.id.column(), pgText(revision.text), stamp["ms"].asInt64(), stamp["counter"].asInt64(), pgText(stamp["actor"].asString()), static_cast<std::int64_t>(at), static_cast<std::int64_t>(revision.rev)});
        archivedDays.insert(row.id.column());
        archiveNow = at;
      }
    }
    pqxx::params params{owner};
    std::string columns = "user_id", slots = "$1::uuid", updates;
    auto add = [&](const std::string& col, const auto& value, const std::string& cast = "") {
      params.append(value);
      columns += "," + col;
      slots += ",$" + std::to_string(params.size()) + cast;
      if (!updates.empty()) updates += ",";
      updates += col + "=excluded." + col;
    };
    if (type_.name == "page") add("day", row.id.column(), "::date");
    add("seq", static_cast<std::int64_t>(row.seq));
    add("rc", static_cast<std::int64_t>(row.rc));
    add("ru", static_cast<std::int64_t>(row.ru));
    for (const auto& [name, field] : type_.fields) {
      if (name == "body") {
        const auto body = row.x.find(name);
        add("body", body == row.x.end() ? std::string() : pgText(body->second.text));
        add("body_rev", body == row.x.end() ? std::optional<std::int64_t>() : std::optional(static_cast<std::int64_t>(body->second.rev)));
        add("body_merged", body == row.x.end() ? std::optional<bool>() : std::optional(body->second.merged));
        continue;
      }
      const auto found = row.lattice.f.find(name);
      add(column(name) + "_stamp", found == row.lattice.f.end() ? std::optional<std::string>() : std::optional(toString(found->second.stamp)));
      const Json::Value value = found == row.lattice.f.end() ? Json::Value() : found->second.value;
      if (name == "documentStamp") {
        add("stamp_ms", value.isNull() ? std::int64_t(0) : value["ms"].asInt64());
        add("stamp_counter", value.isNull() ? std::int64_t(0) : value["counter"].asInt64());
        add("stamp_actor", value.isNull() ? std::string() : pgText(value["actor"].asString()));
      } else if (name == "mood" || name == "energy") add(column(name), value.isNull() ? std::optional<int>() : std::optional(value.asInt()));
      else add(column(name), value.isNull() ? (name == "source" ? std::string("typed") : std::string("pending")) : pgText(value.asString()));
    }
    if (type_.name == "page") {
      columns += ",updated_at";
      slots += ",to_timestamp(" + std::to_string(row.ru) + "::numeric/1000)";
      updates += ",updated_at=excluded.updated_at";
    }
    sql.exec("insert into " + table_ + "(" + columns + ") values(" + slots + ") on conflict(user_id" + (type_.name == "page" ? std::string(",day") : std::string()) + ") do update set " + updates, params);
  }
  pruneRevisions(txn, scope, archivedDays, archiveNow);
}

void PgJournalType::pruneRevisions(SyncTxn& txn, const ScopeKey& scope, const std::set<std::string>& days, Ms now) {
  if (days.empty()) return;
  auto& sql = sqlOf(txn);
  const auto owner = scope.account().str();
  for (const std::string& day : days)
    sql.exec("delete from journal_page_revision where user_id=$1::uuid and day=$2::date and engine_rev in (select engine_rev from journal_page_revision where user_id=$1::uuid and day=$2::date order by superseded_at desc,engine_rev desc offset 10)", pqxx::params{owner, day});
  sql.exec("with ranked as (select engine_rev,superseded_at,row_number() over(order by superseded_at desc,engine_rev desc) as n,sum(octet_length(body)) over(order by superseded_at desc,engine_rev desc) as bytes from journal_page_revision where user_id=$1::uuid) delete from journal_page_revision where user_id=$1::uuid and engine_rev in (select engine_rev from ranked where n>500 or bytes>8388608 or superseded_at<to_timestamp($2::numeric/1000)-interval '90 days')",
      pqxx::params{owner, static_cast<std::int64_t>(now)});
}

std::vector<Row> PgJournalType::feed(SyncTxn& txn, const ScopeKey& scope, const FeedQuery& query) {
  pqxx::params params{scope.account().str(), static_cast<std::int64_t>(query.afterSeq), query.afterKey};
  const std::string id = type_.name == "page" ? "day::text" : "'journalState'::text";
  std::string where = "user_id=$1::uuid and seq is not null and (seq>$2 or (seq=$2 and " + idOrder(id, false) + ">$3))";
  if (query.throughSeq) { params.append(static_cast<std::int64_t>(*query.throughSeq)); where += " and seq<=$4"; }
  const auto result = sqlOf(txn).exec("select " + select(type_.name) + " from " + table_ + " where " + where + " order by seq," + idOrder(id, false), params);
  std::vector<Row> rows;
  for (const auto& value : result) {
    Row row = readRow(type_, value);
    if (query.visibleOnly && !visible(type_, row)) continue;
    rows.push_back(std::move(row));
    if (query.limit && rows.size() >= query.limit) break;
  }
  return rows;
}

std::uint64_t PgJournalType::count(SyncTxn& txn, const ScopeKey& scope, const FeedQuery& query) {
  FeedQuery all = query;
  all.limit = 0;
  return feed(txn, scope, all).size();
}

std::optional<std::string> PgJournalType::revisionText(SyncTxn& txn, const ScopeKey& scope, const RecordId& id, const std::string& field, Seq rev) {
  if (type_.name != "page" || field != "body") return std::nullopt;
  const auto result = sqlOf(txn).exec("select body from journal_page_revision where user_id=$1::uuid and day=$2::date and engine_rev=$3", pqxx::params{scope.account().str(), id.column(), static_cast<std::int64_t>(rev)});
  return result.empty() ? std::nullopt : std::optional(result[0][0].as<std::string>());
}

void PgJournalType::purge(SyncTxn& txn, const ScopeKey& scope) {
  auto& sql = sqlOf(txn);
  for (const std::string& table : {table_, std::string("journal_page_revision"), std::string("journal_claim_receipts"), std::string("journal_content_clock"), std::string("journal_sync_adoptions")})
    sql.exec("delete from " + table + " where user_id=$1::uuid", pqxx::params{scope.account().str()});
}

Json::Value PgJournalState::load(SyncTxn& txn, const ScopeKey& scope) {
  Json::Value book(Json::objectValue);
  auto& sql = sqlOf(txn);
  const pqxx::params owner{scope.account().str()};
  for (const auto& row : sql.exec("select claim_id,arguments_digest,to_char(day,'YYYY-MM-DD') as day,document_stamp from journal_claim_receipts where user_id=$1::uuid", owner)) {
    auto& receipt = book["claims"][row["claim_id"].template as<std::string>()];
    receipt["digest"] = row["arguments_digest"].template as<std::string>();
    receipt["day"] = row["day"].template as<std::string>();
    receipt["documentStamp"] = parseJson(row["document_stamp"].template as<std::string>());
  }
  for (const auto& row : sql.exec("select ms,counter from journal_content_clock where user_id=$1::uuid", owner)) {
    book["contentClock"]["ms"] = Json::UInt64(row[0].template as<Ms>());
    book["contentClock"]["counter"] = Json::UInt64(row[1].template as<std::uint64_t>());
  }
  return book;
}

void PgJournalState::receipt(SyncTxn& txn, const ScopeKey& scope, const std::string& id, const Json::Value& value) {
  sqlOf(txn).exec("insert into journal_claim_receipts(user_id,claim_id,arguments_digest,day,document_stamp) values($1::uuid,$2,$3,$4::date,$5::jsonb)",
    pqxx::params{scope.account().str(), pgText(id), value["digest"].asString(), value["day"].asString(), jcs(value["documentStamp"])});
}

void PgJournalState::saveClock(SyncTxn& txn, const ScopeKey& scope, const Json::Value& pair) {
  sqlOf(txn).exec("insert into journal_content_clock(user_id,ms,counter) values($1::uuid,$2,$3) on conflict(user_id) do update set ms=excluded.ms,counter=excluded.counter",
    pqxx::params{scope.account().str(), pair["ms"].asInt64(), pair["counter"].asInt64()});
}

PgJournal::PgJournal(const Registry& registry) : product_(state_) {
  for (const TypeDef& type : registry.types()) if (type.scope == RegistryScope{ScopeKind::product, "journal"}) stores_.push_back(std::make_unique<PgJournalType>(type));
}

void PgJournal::bindTo(SyncCatalog& catalog, bool checkAdoption) {
  std::map<std::string, TypeStore*> stores;
  for (const auto& store : stores_) stores.emplace(store->def().name, store.get());
  product_.bindTo(catalog, stores);
  if (checkAdoption) catalog.bindReadiness("journal", *this);
}

void PgJournal::requireReady(SyncTxn& txn, const ScopeKey& scope) {
  try {
    const auto rows = sqlOf(txn).exec(
        "select exists(select 1 from journal_sync_adoptions where user_id=$1::uuid) as marker,"
        " exists(select 1 from sync_scopes where key=$2 and state='alive') as scope,"
        " exists(select 1 from journal_page where user_id=$1::uuid and (seq is null or rc is null or ru is null"
        " or mood_stamp is null or energy_stamp is null or source_stamp is null or document_stamp_stamp is null"
        " or body_rev is null or body_merged is null)) as legacy_page,"
        " exists(select 1 from journal_page_revision where user_id=$1::uuid and engine_rev is null) as legacy_revision,"
        " exists(select 1 from journal_sync_state where user_id=$1::uuid and (seq is null or rc is null or ru is null)) as legacy_state,"
        " exists(select 1 from journal_page where user_id=$1::uuid)"
        " or exists(select 1 from journal_page_revision where user_id=$1::uuid)"
        " or exists(select 1 from journal_sync_state where user_id=$1::uuid) as history,"
        " exists(select 1 from journal_page_revision where user_id=$1::uuid and migration_id is not null) as frozen_revision",
        pqxx::params{scope.account().str(), scope.text()});
    const auto& status = rows[0];
    if (status["legacy_page"].as<bool>() || status["legacy_revision"].as<bool>() || status["legacy_state"].as<bool>() ||
        (!status["scope"].as<bool>() && (status["marker"].as<bool>() || status["history"].as<bool>())) ||
        (!status["marker"].as<bool>() && status["frozen_revision"].as<bool>()))
      throw ProductScopeUnavailable("journal account has not completed adoption");
  } catch (const pqxx::undefined_column&) {
    throw ProductScopeUnavailable("journal adoption schema is unavailable");
  } catch (const pqxx::undefined_table&) {
    throw ProductScopeUnavailable("journal adoption schema is unavailable");
  }
}

void PgJournal::requireWritable(SyncTxn& txn, const ScopeKey& scope) {
  if (journalWriteFrozen()) throw ProductScopeUnavailable("journal writes are frozen");
  requireReady(txn, scope);
}

}
