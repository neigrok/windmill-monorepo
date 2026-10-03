#include "products/journal/sync/adapters/postgres/PgJournalBackfill.h"

#include "products/journal/sync/adapters/postgres/PgJournal.h"
#include "products/journal/sync/JournalRegistry.h"
#include "products/journal/sync/domain/JournalRules.h"
#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/application/sync/SyncService.h"
#include "platform/domain/sync/Jcs.h"

#include <algorithm>
#include <map>
#include <set>
#include <stdexcept>

namespace wm::journal::engine {

using namespace sync;

namespace {

Json::Value normalizedScale(const Json::Value& value) {
  return value.isIntegral() && value.asInt64() >= 0 && value.asInt64() <= 10 ? value : Json::Value();
}

template <typename R>
Json::Value stamp(const R& row) {
  Json::Value value(Json::objectValue);
  value["ms"] = Json::Int64(row["stamp_ms"].template as<std::int64_t>());
  value["counter"] = Json::Int64(row["stamp_counter"].template as<std::int64_t>());
  value["actor"] = row["stamp_actor"].template as<std::string>();
  return value;
}

void requireSchema(SyncTxn& txn) {
  auto& sql = sqlOf(txn);
  const auto scales = sql.exec("select attname from pg_attribute where attrelid='journal_page'::regclass and attname in ('mood','energy') and not attnotnull and not attisdropped");
  if (scales.size() != 2) throw std::runtime_error("journal adoption requires the current nullable 0..10 scale schema before the freeze");
  const std::map<std::string, std::map<std::string, std::string>> required{
    {"journal_page", {{"seq", "bigint"}, {"rc", "bigint"}, {"ru", "bigint"}, {"mood_stamp", "text"}, {"energy_stamp", "text"}, {"source_stamp", "text"}, {"document_stamp_stamp", "text"}, {"body_rev", "bigint"}, {"body_merged", "boolean"}}},
    {"journal_page_revision", {{"migration_id", "bigint"}, {"engine_rev", "bigint"}}},
    {"journal_sync_state", {{"seq", "bigint"}, {"rc", "bigint"}, {"ru", "bigint"}, {"placeholder_stamp", "text"}, {"privacy_line_stamp", "text"}, {"first_page_stamp", "text"}, {"scales_stamp", "text"}}},
    {"journal_sync_adoptions", {{"migration_ms", "bigint"}, {"manifest_digest", "text"}, {"frozen_input", "jsonb"}, {"first_run_policy", "text"}, {"frozen_receipts", "jsonb"}}},
    {"journal_claim_receipts", {{"arguments_digest", "text"}, {"document_stamp", "jsonb"}}}};
  for (const auto& [table, columns] : required) for (const auto& [column, type] : columns) {
    const auto found = sql.exec("select a.atttypid::regtype::text from pg_attribute a where a.attrelid=to_regclass($1) and a.attname=$2 and not a.attisdropped", pqxx::params{table, column});
    if (found.size() != 1 || found[0][0].as<std::string>() != type) throw std::runtime_error("D.1 adoption schema missing or incompatible: " + table + "." + column);
  }
}

std::vector<std::string> accounts(SyncTxn& txn, const std::optional<std::string>& account) {
  std::string query = "select user_id::text from (select user_id from journal_page union select user_id from journal_page_revision union select user_id from journal_sync_state union select user_id from journal_sync_adoptions union select user_id from journal_claim_receipts union select user_id from journal_content_clock union select owner from sync_scopes where key='acct:'||owner::text||'/journal') owners";
  pqxx::params params;
  if (account) { query += " where user_id=$1::uuid"; params.append(*account); }
  query += " order by user_id";
  std::vector<std::string> result;
  for (const auto& row : sqlOf(txn).exec(query, params)) result.push_back(row[0].template as<std::string>());
  return result;
}

struct Frozen {
  Json::Value legacy{Json::objectValue};
  Json::Value receipts{Json::objectValue};
  std::vector<std::string> tuples;
};

Frozen freeze(SyncTxn& txn, const std::string& owner) {
  sqlOf(txn).exec("set local timezone='UTC'");
  Frozen frozen;
  const pqxx::params params{owner};
  auto& sql = sqlOf(txn);
  const auto pages = sql.exec("select *,day::text as calendar_day,(extract(epoch from updated_at)*1000)::bigint as updated_ms,updated_at::text as precision from journal_page where user_id=$1::uuid order by day", params);
  for (const auto& row : pages) {
    Json::Value page(Json::objectValue);
    page["day"] = row["calendar_day"].template as<std::string>();
    page["body"] = row["body"].template as<std::string>();
    page["mood"] = row["mood"].is_null() ? Json::Value() : Json::Value(row["mood"].template as<int>());
    page["energy"] = row["energy"].is_null() ? Json::Value() : Json::Value(row["energy"].template as<int>());
    page["source"] = row["source"].template as<std::string>();
    page["stamp"] = stamp(row);
    page["updatedAt"] = Json::Int64(row["updated_ms"].template as<std::int64_t>());
    frozen.legacy["pages"].append(page);
    frozen.receipts["pages"][page["day"].asString()] = row["precision"].template as<std::string>();
  }
  const auto revisions = sql.exec("select *,ctid::text as tuple,day::text as calendar_day,(extract(epoch from superseded_at)*1000)::bigint as archive_ms,superseded_at::text as precision from journal_page_revision where user_id=$1::uuid order by ctid", params);
  std::uint64_t ordinal = 0;
  for (const auto& row : revisions) {
    Json::Value revision(Json::objectValue);
    revision["migrationId"] = Json::UInt64(++ordinal);
    revision["day"] = row["calendar_day"].template as<std::string>();
    revision["body"] = row["body"].template as<std::string>();
    revision["stamp"] = stamp(row);
    revision["supersededAt"] = Json::Int64(row["archive_ms"].template as<std::int64_t>());
    frozen.legacy["revisions"].append(revision);
    frozen.tuples.push_back(row["tuple"].template as<std::string>());
    frozen.receipts["revisions"][std::to_string(ordinal)] = row["precision"].template as<std::string>();
  }
  return frozen;
}

Json::Value sortedLegacy(const Json::Value& legacy) {
  Json::Value result(Json::objectValue);
  if (!legacy["pages"].empty()) {
    std::vector<Json::Value> rows(legacy["pages"].begin(), legacy["pages"].end());
    std::sort(rows.begin(), rows.end(), [](const auto& a, const auto& b) { return a["day"].asString() < b["day"].asString(); });
    for (const auto& row : rows) result["pages"].append(row);
  }
  if (!legacy["revisions"].empty()) {
    std::vector<Json::Value> rows(legacy["revisions"].begin(), legacy["revisions"].end());
    std::sort(rows.begin(), rows.end(), [](const auto& a, const auto& b) { return a["migrationId"].asUInt64() < b["migrationId"].asUInt64(); });
    for (const auto& row : rows) result["revisions"].append(row);
  }
  return result;
}

Json::Value report(const ScopeRow& scope, std::uint64_t rows, std::uint64_t revisions, bool changed) {
  Json::Value result(Json::objectValue);
  result["account"] = scope.owner.str();
  result["scope"] = scope.key.text();
  result["rows"] = Json::UInt64(rows);
  result["revisions"] = Json::UInt64(revisions);
  result["changed"] = changed;
  result["seq"] = Json::UInt64(scope.seq);
  result["digest"] = scope.digest.hex();
  return result;
}

void check(const std::string& label, const Json::Value& actual, const Json::Value& expected) {
  if (jcs(actual) != jcs(expected)) throw std::runtime_error("journal adoption audit: " + label);
}

Json::Value auditAccount(SyncTxn& txn, PgSyncStore& store, const std::string& owner) {
  auto& sql = sqlOf(txn);
  sql.exec("set local timezone='UTC'");
  const pqxx::params params{owner};
  const ScopeKey key = ScopeKey::product(UserId(owner), "journal");
  const auto marker = sql.exec("select * from journal_sync_adoptions where user_id=$1::uuid", params);
  const auto scope = store.scope(txn, key, RowLock::none);
  if (marker.empty() || !scope) throw std::runtime_error("journal adoption audit: missing adoption marker or scope");
  const Ms M = marker[0]["migration_ms"].as<Ms>();
  const Json::Value frozen = parseJson(marker[0]["frozen_input"].as<std::string>());
  check("manifest", marker[0]["manifest_digest"].as<std::string>(), sha256(jcs(frozen)).hex());
  check("policy", marker[0]["first_run_policy"].as<std::string>(), "retire-existing");
  const Json::Value legacy = sortedLegacy(frozen);
  const std::string envelope = std::to_string(M) + ":0:srv";
  std::map<std::string, Json::Value> expected;
  Seq seq = legacy["revisions"].size();
  bool written = false;
  for (const auto& page : legacy["pages"]) {
    Json::Value row(Json::objectValue);
    row["t"] = "page";
    row["id"] = page["day"];
    row["seq"] = Json::UInt64(++seq);
    row["rc"] = row["ru"] = page["updatedAt"];
    for (const char* name : {"mood", "energy", "source", "documentStamp"}) {
      Json::Value value;
      if (std::string(name) == "documentStamp") value = page["stamp"];
      else if (std::string(name) == "source") value = page["source"] == "spoken" ? "spoken" : "typed";
      else value = normalizedScale(page[name]);
      row["f"][name].append(value);
      row["f"][name].append(envelope);
    }
    row["x"]["body"]["text"] = page["body"];
    row["x"]["body"]["rev"] = Json::UInt64(seq);
    row["x"]["body"]["merged"] = false;
    expected.emplace("page/" + page["day"].asString(), row);
    written |= page["body"] != "" || !normalizedScale(page["mood"]).isNull() || !normalizedScale(page["energy"]).isNull();
  }
  if (written) {
    Json::Value row(Json::objectValue);
    row["t"] = row["id"] = "journalState";
    row["seq"] = Json::UInt64(++seq);
    row["rc"] = row["ru"] = Json::UInt64(M);
    for (const char* name : {"placeholder", "privacyLine", "firstPage", "scales"}) {
      row["f"][name].append("retired");
      row["f"][name].append(envelope);
    }
    expected.emplace("journalState/journalState", row);
  }
  std::map<std::string, Json::Value> actual;
  Digest256 digest;
  for (const std::string& name : {"page", "journalState"}) {
    PgJournalType type(*registry().type(name));
    for (const Row& row : type.feed(txn, key, FeedQuery{})) {
      actual.emplace(row.t + "/" + row.id.column(), row.toJson());
      digest = digest + rowHash(row.toJson());
    }
  }
  if (actual.size() != expected.size()) throw std::runtime_error("journal adoption audit: frozen row identities");
  for (const auto& [id, row] : expected) {
    if (!actual.contains(id)) throw std::runtime_error("journal adoption audit: frozen row identity " + id);
    check(id + " envelope, head and receipt", actual.at(id), row);
  }
  const auto historical = sql.exec("select *,day::text as calendar_day,(extract(epoch from superseded_at)*1000)::bigint as archive_ms from journal_page_revision where user_id=$1::uuid order by engine_rev", params);
  if (historical.size() != legacy["revisions"].size()) throw std::runtime_error("journal adoption audit: historical roster");
  for (std::size_t i = 0; i < historical.size(); ++i) {
    const auto& expectedRevision = legacy["revisions"][static_cast<Json::ArrayIndex>(i)];
    const auto row = historical[i];
    check("historical identity", Json::UInt64(row["migration_id"].as<Seq>()), expectedRevision["migrationId"]);
    check("historical revision", Json::UInt64(row["engine_rev"].as<Seq>()), Json::UInt64(i + 1));
    check("historical day", row["calendar_day"].as<std::string>(), expectedRevision["day"]);
    check("historical body", row["body"].as<std::string>(), expectedRevision["body"]);
    check("historical content stamp", stamp(row), expectedRevision["stamp"]);
    check("historical receipt", Json::Int64(row["archive_ms"].as<std::int64_t>()), expectedRevision["supersededAt"]);
  }
  const Json::Value precision = parseJson(marker[0]["frozen_receipts"].as<std::string>());
  for (const auto& day : precision["pages"].getMemberNames())
    check("page precision", sql.exec("select updated_at::text from journal_page where user_id=$1::uuid and day=$2::date", pqxx::params{owner, day})[0][0].as<std::string>(), precision["pages"][day]);
  for (const auto& id : precision["revisions"].getMemberNames())
    check("revision precision", sql.exec("select superseded_at::text from journal_page_revision where user_id=$1::uuid and migration_id=$2", pqxx::params{owner, std::stoll(id)})[0][0].as<std::string>(), precision["revisions"][id]);
  if (scope->seq != seq || scope->digest != digest || !scope->counters.empty() || scope->dead || scope->open)
    throw std::runtime_error("journal adoption audit: scope seq, digest or lifecycle");
  if (!sql.exec("select 1 from sync_spent where scope_key=$1 union all select 1 from journal_claim_receipts where user_id=$2::uuid union all select 1 from journal_content_clock where user_id=$2::uuid", pqxx::params{key.text(), owner}).empty())
    throw std::runtime_error("journal adoption audit: spent ids or claim state");
  auto result = report(*scope, expected.size(), historical.size(), false);
  result["audit"] = true;
  result["envelopeAudit"] = true;
  result["computedDigest"] = digest.hex();
  result["greatestSeq"] = Json::UInt64(seq);
  return result;
}

Json::Value auditCurrentAccount(SyncTxn& txn, PgSyncStore& store, const std::string& owner) {
  const ScopeKey key = ScopeKey::product(UserId(owner), "journal");
  const auto scope = store.scope(txn, key, RowLock::none);
  if (!scope) throw std::runtime_error("journal adoption audit: missing scope");
  Digest256 digest;
  Seq greatest = sqlOf(txn).exec("select coalesce(max(engine_rev),0) from journal_page_revision where user_id=$1::uuid", pqxx::params{owner})[0][0].as<Seq>();
  std::uint64_t count = 0;
  for (const auto& type : registry().types()) {
    PgJournalType rows(type);
    for (const auto& row : rows.feed(txn, key, FeedQuery{})) {
      greatest = std::max(greatest, row.seq);
      digest = digest + rowHash(row.toJson());
      ++count;
    }
  }
  if (greatest != scope->seq || digest != scope->digest) throw std::runtime_error("journal adoption audit: current feed digest or greatest seq");
  auto result = report(*scope, count, sqlOf(txn).exec("select count(*) from journal_page_revision where user_id=$1::uuid", pqxx::params{owner})[0][0].as<Seq>(), false);
  result["audit"] = true;
  result["computedDigest"] = digest.hex();
  result["greatestSeq"] = Json::UInt64(greatest);
  return result;
}

std::uint64_t testFrozenAudit(SyncTxn& txn, PgSyncStore& store, const std::string& owner) {
  auto& sql = sqlOf(txn);
  const auto marker = sql.exec("select migration_ms from journal_sync_adoptions where user_id=$1::uuid", pqxx::params{owner});
  const std::string future = sql.quote(std::to_string(marker[0][0].as<Ms>() + Limits{}.maxSkewMs + 1) + ":0:srv");
  std::vector<std::string> mutations;
  for (const char* field : {"mood_stamp", "energy_stamp", "source_stamp", "document_stamp_stamp"})
    mutations.push_back("update journal_page set " + std::string(field) + "=" + future + " where user_id=$1::uuid returning 1");
  for (const char* field : {"placeholder_stamp", "privacy_line_stamp", "first_page_stamp", "scales_stamp"})
    mutations.push_back("update journal_sync_state set " + std::string(field) + "=" + future + " where user_id=$1::uuid returning 1");
  for (const char* table : {"journal_page", "journal_sync_state"}) for (const char* column : {"seq", "rc", "ru"})
    mutations.push_back("update " + std::string(table) + " set " + column + "=" + column + "+1 where user_id=$1::uuid returning 1");
  for (const std::string assignment : {"body_rev=body_rev+1", "body_merged=true", "updated_at=updated_at+interval '0.000001 seconds'"})
    mutations.push_back("update journal_page set " + assignment + " where user_id=$1::uuid returning 1");
  for (const std::string assignment : {"body=body||'corrupted'", "stamp_ms=stamp_ms+1", "superseded_at=superseded_at+interval '0.000001 seconds'"})
    mutations.push_back("update journal_page_revision set " + assignment + " where user_id=$1::uuid returning 1");
  std::uint64_t rejected = 0;
  for (const auto& mutation : mutations) {
    sql.exec("savepoint journal_audit_corruption");
    if (!sql.exec(mutation, pqxx::params{owner}).empty()) {
      const ScopeKey key = ScopeKey::product(UserId(owner), "journal");
      auto candidate = *store.scope(txn, key, RowLock::noKeyUpdate);
      candidate.digest = Digest256{};
      candidate.seq = sql.exec("select coalesce(max(engine_rev),0) from journal_page_revision where user_id=$1::uuid", pqxx::params{owner})[0][0].as<Seq>();
      for (const auto& type : registry().types()) {
        PgJournalType rows(type);
        for (const auto& row : rows.feed(txn, key, FeedQuery{})) {
          candidate.seq = std::max(candidate.seq, row.seq);
          candidate.digest = candidate.digest + rowHash(row.toJson());
        }
      }
      store.saveScope(txn, candidate);
      auditCurrentAccount(txn, store, owner);
      bool refused = false;
      try { auditAccount(txn, store, owner); }
      catch (const std::runtime_error&) { refused = true; }
      if (!refused) throw std::runtime_error("journal corruption audit did not reject " + mutation);
      ++rejected;
    }
    sql.exec("rollback to savepoint journal_audit_corruption");
    sql.exec("release savepoint journal_audit_corruption");
  }
  return rejected;
}

void auditBoot(PgSyncStore& store, std::vector<Json::Value>& reports) {
  struct AuditClock : Clock { std::uint64_t nowMs() override { return 0; } } clock;
  struct AuditFailures : FailureReporter {
    void report(const std::string&, const std::string&, const std::string&) override {
      throw std::runtime_error("journal boot audit: engine failure");
    }
  } failures;
  PgJournal product(registry());
  SyncCatalog catalog(registry());
  product.bindTo(catalog);
  catalog.seal();
  NullChangeFeed feed;
  ServerClock serverClock;
  Admission admission(catalog, store, feed, serverClock, failures);
  SyncService service(catalog, store, admission, clock);
  for (auto& report : reports) {
    Json::Value request(Json::objectValue);
    request["scopes"][0]["scope"] = "self/journal";
    request["scopes"][0]["cursor"] = Json::Value();
    Digest256 digest;
    std::uint64_t rows = 0;
    std::set<std::string> cursors;
    for (;;) {
      const auto reply = service.pull(Credential::sent(UserId(report["account"].asString())), jcs(request));
      if (reply.status != 200 || reply.body["pages"].size() != 1 || reply.body["pages"][0]["kind"] != "rows")
        throw std::runtime_error("journal boot audit: pull did not return rows");
      const auto& page = reply.body["pages"][0];
      for (const auto& row : page["rows"]) { digest = digest + rowHash(row); ++rows; }
      if (page["seq"] != report["seq"] || page["digest"] != report["digest"])
        throw std::runtime_error("journal boot audit: advertised head or digest");
      const auto cursor = Cursor::decode(page["cursor"].asString());
      if (!cursor) throw std::runtime_error("journal boot audit: invalid cursor");
      if (!page["more"].asBool()) {
        if (!cursor->live || cursor->key || cursor->seq != report["seq"].asUInt64() || rows != report["rows"].asUInt64() || digest.hex() != report["digest"].asString())
          throw std::runtime_error("journal boot audit: final head, roster or digest");
        break;
      }
      if (!cursors.insert(page["cursor"].asString()).second) throw std::runtime_error("journal boot audit: repeated cursor");
      request["scopes"][0]["cursor"] = page["cursor"];
    }
    report["bootAudit"] = true;
  }
}

}

std::vector<Json::Value> PgJournalBackfill::run(Ms migrationTime, bool dryRun, std::optional<std::string> account,
    const std::string& firstRunPolicy, std::optional<Json::Value> frozenInput, bool resumeRecorded,
    const std::function<void(const Json::Value&)>& onAccount) {
  if (firstRunPolicy != "retire-existing") throw std::runtime_error("journal first-run migration policy must be retire-existing");
  if (migrationTime >= (std::uint64_t(1) << 53)) throw std::runtime_error("invalid migration instant");
  PgSyncStore store(pool_, Limits{}.lockTimeoutMs);
  std::vector<std::string> owners;
  {
    auto txn = store.begin(dryRun ? TxnMode::snapshot : TxnMode::write);
    requireSchema(*txn);
    owners = accounts(*txn, account);
    if (!dryRun) {
      sqlOf(*txn).exec("insert into sync_meta(epoch) values(replace(gen_random_uuid()::text,'-','')) on conflict(one) do update set epoch=excluded.epoch where sync_meta.epoch=''");
      txn->commit();
    }
  }
  std::vector<Json::Value> reports;
  for (const std::string& owner : owners) {
    auto txn = store.begin(dryRun ? TxnMode::snapshot : TxnMode::write);
    auto& sql = sqlOf(*txn);
    if (!dryRun) sql.exec("select pg_advisory_xact_lock(hashtext('journal-backfill'),hashtext($1))", pqxx::params{owner});
    const ScopeKey key = ScopeKey::product(UserId(owner), "journal");
    const auto standing = store.scope(*txn, key, dryRun ? RowLock::none : RowLock::noKeyUpdate);
    const auto marker = sql.exec("select * from journal_sync_adoptions where user_id=$1::uuid", pqxx::params{owner});
    if (!marker.empty()) {
      if ((!resumeRecorded && marker[0]["migration_ms"].as<Ms>() != migrationTime) || marker[0]["first_run_policy"].as<std::string>() != firstRunPolicy ||
          (frozenInput && marker[0]["manifest_digest"].as<std::string>() != sha256(jcs(*frozenInput)).hex()))
        throw std::runtime_error("journal adoption manifest differs");
      if (!standing) throw std::runtime_error("journal adoption marker exists without its scope");
      const auto frozen = parseJson(marker[0]["frozen_input"].as<std::string>());
      if (marker[0]["manifest_digest"].as<std::string>() != sha256(jcs(frozen)).hex()) throw std::runtime_error("journal adoption manifest differs");
      const auto roster = sql.exec("select (select count(*) from journal_page where user_id=$1::uuid)+(select count(*) from journal_sync_state where user_id=$1::uuid), (select count(*) from journal_page_revision where user_id=$1::uuid)", pqxx::params{owner});
      reports.push_back(report(*standing, roster[0][0].as<std::uint64_t>(), roster[0][1].as<std::uint64_t>(), false));
      if (onAccount) onAccount(reports.back());
      continue;
    }
    if (standing) throw std::runtime_error("journal scope exists without an adoption marker");
    if (!sql.exec("select 1 from journal_sync_state where user_id=$1::uuid union all select 1 from journal_claim_receipts where user_id=$1::uuid union all select 1 from journal_content_clock where user_id=$1::uuid", pqxx::params{owner}).empty())
      throw std::runtime_error("journal engine state exists without an adoption marker");
    const Frozen frozen = freeze(*txn, owner);
    const Json::Value legacy = frozenInput ? *frozenInput : frozen.legacy;
    const Json::Value ordered = sortedLegacy(legacy);
    if (ordered["pages"].empty() && ordered["revisions"].empty()) continue;
    for (const auto& kind : {"pages", "revisions"}) for (const auto& row : ordered[kind]) {
      if (!isCalendarDay(row["day"].asString()) || !isDocumentStamp(row["stamp"]) || !row["body"].isString()) throw std::runtime_error("invalid legacy journal row");
    }
    if (jcs(ordered) != jcs(frozen.legacy)) throw std::runtime_error("journal frozen manifest does not match adopted tables");
    std::vector<Row> rows;
    const Stamp envelope = stampOf(std::to_string(migrationTime) + ":0:srv");
    Seq seq = ordered["revisions"].size();
    bool written = false;
    for (const auto& page : ordered["pages"]) {
      Row row("page", RecordId(page["day"]));
      row.seq = ++seq;
      row.rc = row.ru = page["updatedAt"].asUInt64();
      row.x.emplace("body", TextVal{page["body"].asString(), seq, false});
      row.lattice.f.emplace("mood", Reg(normalizedScale(page["mood"]), envelope));
      row.lattice.f.emplace("energy", Reg(normalizedScale(page["energy"]), envelope));
      row.lattice.f.emplace("source", Reg(page["source"] == "spoken" ? Json::Value("spoken") : Json::Value("typed"), envelope));
      row.lattice.f.emplace("documentStamp", Reg(page["stamp"], envelope));
      written |= !page["body"].asString().empty() || !normalizedScale(page["mood"]).isNull() || !normalizedScale(page["energy"]).isNull();
      rows.push_back(std::move(row));
    }
    if (written) {
      Row row("journalState", RecordId(std::string("journalState")));
      row.seq = ++seq;
      row.rc = row.ru = migrationTime;
      for (const char* field : {"placeholder", "privacyLine", "firstPage", "scales"}) row.lattice.f.emplace(field, Reg("retired", envelope));
      rows.push_back(std::move(row));
    }
    Digest256 digest;
    for (const Row& row : rows) digest = digest + rowHash(row.toJson());
    ScopeRow scope{key, UserId(owner)};
    scope.seq = seq;
    scope.digest = digest;
    if (!dryRun) {
      for (std::size_t i = 0; i < frozen.tuples.size(); ++i)
        sql.exec("update journal_page_revision set migration_id=$3,engine_rev=$3 where user_id=$1::uuid and ctid=$2::tid", pqxx::params{owner, frozen.tuples[i], static_cast<std::int64_t>(i + 1)});
      for (const Row& row : rows) {
        if (row.t == "journalState") {
          PgJournalType state(*registry().type("journalState"));
          state.apply(*txn, key, {RowWrite{registry().type("journalState"), row.id, std::nullopt, row, {}}});
          continue;
        }
        sql.exec("update journal_page set seq=$3,rc=$4,ru=$4,mood_stamp=$5,energy_stamp=$5,source_stamp=$5,document_stamp_stamp=$5,body_rev=$3,body_merged=false where user_id=$1::uuid and day=$2::date",
          pqxx::params{owner, row.id.column(), static_cast<std::int64_t>(row.seq), static_cast<std::int64_t>(row.rc), toString(envelope)});
      }
      store.insertScope(*txn, key, UserId(owner), std::nullopt);
      store.saveScope(*txn, scope);
      sql.exec("insert into journal_sync_adoptions(user_id,migration_ms,first_run_policy,manifest_digest,frozen_input,frozen_receipts) values($1::uuid,$2,$3,$4,$5::jsonb,$6::jsonb)",
        pqxx::params{owner, static_cast<std::int64_t>(migrationTime), firstRunPolicy, sha256(jcs(legacy)).hex(), jcs(legacy), jcs(frozen.receipts)});
      auditAccount(*txn, store, owner);
      txn->commit();
    }
    auto result = report(scope, rows.size(), frozen.tuples.size(), true);
    result["dryRun"] = dryRun;
    reports.push_back(std::move(result));
    if (onAccount) onAccount(reports.back());
  }
  return reports;
}

std::vector<Json::Value> PgJournalBackfill::audit(std::optional<std::string> account, bool testCorruptions) {
  PgSyncStore store(pool_, Limits{}.lockTimeoutMs);
  auto txn = store.begin(testCorruptions ? TxnMode::write : TxnMode::snapshot);
  requireSchema(*txn);
  std::vector<Json::Value> result;
  for (const std::string& owner : accounts(*txn, account)) {
    result.push_back(auditAccount(*txn, store, owner));
    if (testCorruptions) result.back()["corruptionsRejected"] = Json::UInt64(testFrozenAudit(*txn, store, owner));
  }
  txn.reset();
  auditBoot(store, result);
  return result;
}

std::vector<Json::Value> PgJournalBackfill::auditCurrent(std::optional<std::string> account) {
  PgSyncStore store(pool_, Limits{}.lockTimeoutMs);
  auto txn = store.begin(TxnMode::snapshot);
  requireSchema(*txn);
  std::vector<Json::Value> result;
  for (const auto& owner : accounts(*txn, account)) result.push_back(auditCurrentAccount(*txn, store, owner));
  const auto snapshot = sqlOf(*txn).exec("select pg_export_snapshot()")[0][0].as<std::string>();
  PgSyncStore bootStore(pool_, Limits{}.lockTimeoutMs, snapshot);
  auditBoot(bootStore, result);
  return result;
}

}
