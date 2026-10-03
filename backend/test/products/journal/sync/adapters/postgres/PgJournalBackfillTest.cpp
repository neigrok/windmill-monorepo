#include "products/journal/sync/adapters/postgres/PgJournalBackfill.h"

#include "products/journal/sync/domain/JournalRules.h"
#include "products/journal/sync/adapters/json/JournalIntent.h"
#include "products/journal/adapters/postgres/PgJournalRepository.h"
#include "products/journal/adapters/json/PageJson.h"
#include "platform/application/WorkerPool.h"
#include "test/SyncCorpus.h"
#include "test/platform/adapters/postgres/PgSyncWorld.h"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <future>
#include <thread>

using namespace wm;
using namespace wm::sync;

namespace {

const Json::Value& migrationVectors() {
  static const auto vectors = corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/journal/backfill.json");
  return vectors;
}

void seedLegacy(test::PgWorld& world, const Json::Value& input) {
  auto txn = world.store().begin(TxnMode::write);
  auto& sql = sqlOf(*txn);
  const auto owner = world.account(input["account"].asString()).str();
  const auto& legacy = input["legacy"];
  bool oldScores = false;
  for (const auto& page : legacy["pages"]) for (const char* field : {"mood", "energy"})
    oldScores |= !page[field].isNull() && (page[field].asInt() < 0 || page[field].asInt() > 10);
  if (oldScores) {
    sql.exec("alter table journal_page drop constraint journal_page_mood_check");
    sql.exec("alter table journal_page drop constraint journal_page_energy_check");
  }
  for (const auto& page : legacy["pages"]) {
    std::string day = page["day"].asString();
    if (day == "0000-01-01") day = "0001-01-01 BC";
    sql.exec("insert into journal_page(user_id,day,body,mood,energy,source,stamp_ms,stamp_counter,stamp_actor,updated_at) values($1::uuid,$2::date,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10::numeric/1000)) on conflict do nothing",
      pqxx::params{owner, day, page["body"].asString(), page["mood"].isNull() ? std::optional<int>() : std::optional(page["mood"].asInt()), page["energy"].isNull() ? std::optional<int>() : std::optional(page["energy"].asInt()), page["source"].asString(), page["stamp"]["ms"].asInt64(), page["stamp"]["counter"].asInt64(), page["stamp"]["actor"].asString(), page["updatedAt"].asInt64()});
  }
  std::vector<Json::Value> revisions(legacy["revisions"].begin(), legacy["revisions"].end());
  std::sort(revisions.begin(), revisions.end(), [](const auto& a, const auto& b) { return a["migrationId"].asUInt64() < b["migrationId"].asUInt64(); });
  const auto& product = input["state"]["product"];
  const std::string key = "acct:" + input["account"].asString() + "/journal";
  const bool adopted = product["journalAdoptions"].isMember(key);
  if (!adopted) {
    for (const auto& revision : revisions)
      sql.exec("insert into journal_page_revision(user_id,day,body,stamp_ms,stamp_counter,stamp_actor,superseded_at) values($1::uuid,$2::date,$3,$4,$5,$6,to_timestamp($7::numeric/1000))",
        pqxx::params{owner, revision["day"].asString(), revision["body"].asString(), revision["stamp"]["ms"].asInt64(), revision["stamp"]["counter"].asInt64(), revision["stamp"]["actor"].asString(), revision["supersededAt"].asInt64()});
  }
  txn->commit();
}

void restoreScoreChecks(test::PgWorld& world) {
  auto txn = world.store().begin(TxnMode::write);
  auto& sql = sqlOf(*txn);
  for (const char* name : {"mood", "energy"}) {
    const std::string constraint = std::string("journal_page_") + name + "_check";
    if (sql.exec("select 1 from pg_constraint where conrelid='journal_page'::regclass and conname=$1", pqxx::params{constraint}).empty())
      sql.exec("alter table journal_page add constraint " + constraint + " check(" + name + " between 0 and 10) not valid");
  }
  txn->commit();
}

Json::Value databaseRows(test::PgWorld& world) {
  auto txn = world.store().begin(TxnMode::snapshot);
  auto& sql = sqlOf(*txn);
  Json::Value dump(Json::objectValue);
  for (const auto& table : sql.exec("select tablename from pg_tables where schemaname=current_schema() order by tablename")) {
    const std::string name = table[0].as<std::string>();
    const auto rows = sql.exec("select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) order by to_jsonb(t)::text),'[]'::jsonb)::text from " + sql.quote_name(name) + " t");
    dump[name] = parseJson(rows[0][0].as<std::string>());
  }
  return dump;
}

Json::Value backfillVector(const Json::Value& input) {
  static test::PgWorld world(false, true);
  world.seed(input["state"]);
  seedLegacy(world, input);
  journal::engine::PgJournalBackfill backfill(pgTestPool());
  const auto owner = world.account(input["account"].asString()).str();
  const auto M = input["M"].asUInt64();
  const auto policy = input.get("firstRunPolicy", "retire-existing").asString();
  const auto before = databaseRows(world);
  PgJournalRepository rest(pgTestPool());
  Json::Value beforeReads;
  const bool representable = std::all_of(input["legacy"]["pages"].begin(), input["legacy"]["pages"].end(), [](const Json::Value& page) { return journal::engine::isCalendarDay(page["day"].asString()) && journal::engine::isDocumentStamp(page["stamp"]); });
  if (representable) beforeReads = wm::toJson(rest.all(UserId(owner)));
  try {
    backfill.run(M, true, owner, policy, input["legacy"]);
    CHECK_EQ(jcs(databaseRows(world)), jcs(before));
    backfill.run(M, false, owner, policy, input["legacy"]);
  } catch (const std::runtime_error& error) {
    CHECK_EQ(jcs(databaseRows(world)), jcs(before));
    Json::Value result(Json::objectValue);
    result["error"] = error.what();
    restoreScoreChecks(world);
    return result;
  }
  const auto migrated = databaseRows(world);
  backfill.audit(owner);
  backfill.run(M, false, owner, policy, input["legacy"]);
  CHECK_EQ(jcs(databaseRows(world)), jcs(migrated));
  Json::Value answer(Json::objectValue);
  answer["state"] = world.dump();
  answer["reads"] = wm::toJson(rest.all(UserId(owner)));
  CHECK_EQ(jcs(answer["reads"]), jcs(beforeReads));
  restoreScoreChecks(world);
  return answer;
}

[[maybe_unused]] const bool registered = [] {
  corpus::registerFiles(WM_SYNC_CONTRACT_DIR "/corpus", {{"journal/backfill.json", corpus::Runner{backfillVector}}},
    [] { return test::postgresEnabled() ? nullptr : test::kNeedsPostgres; });
  for (const std::string& corruption : {"mood_stamp='9000000000000:0:srv'", "body_rev=98765", "body_merged=true", "rc=rc+1", "ru=ru+1"})
    ::testing::Register{"journal_backfill_audit_rejects/" + corruption, [corruption] {
      if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
      const auto input = migrationVectors()[0]["input"];
      test::PgWorld world(false, true);
      world.seed(input["state"]);
      seedLegacy(world, input);
      journal::engine::PgJournalBackfill backfill(pgTestPool());
      const auto owner = world.account("A").str();
      backfill.run(input["M"].asUInt64(), false, owner, "retire-existing", input["legacy"]);
      {
        auto txn = world.store().begin(TxnMode::write);
        sqlOf(*txn).exec("update journal_page set " + corruption + " where user_id=$1::uuid", pqxx::params{owner});
        const auto key = ScopeKey::product(UserId(owner), "journal");
        auto scope = *world.store().scope(*txn, key, RowLock::noKeyUpdate);
        scope.digest = Digest256{};
        for (const auto* type : world.catalog().typesIn(key.registryScope()))
          for (const Row& row : world.catalog().store(type->name).feed(*txn, key, FeedQuery{})) scope.digest = scope.digest + rowHash(row.toJson());
        world.store().saveScope(*txn, scope);
        txn->commit();
      }
      bool refused = false;
      try { backfill.audit(owner); }
      catch (const std::runtime_error& error) { refused = std::string(error.what()).find("audit") != std::string::npos; }
      CHECK(refused);
      const auto corrupted = databaseRows(world);
      backfill.run(input["M"].asUInt64(), false, owner);
      CHECK_EQ(jcs(databaseRows(world)), jcs(corrupted));
    }};
  return true;
}();

}

TEST(journal_backfill_rolls_back_the_entire_account_when_adoption_fails) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto input = migrationVectors()[0]["input"];
  test::PgWorld world(false, true);
  world.seed(input["state"]);
  seedLegacy(world, input);
  {
    auto txn = world.store().begin(TxnMode::write);
    sqlOf(*txn).exec("alter table journal_sync_state add constraint journal_adoption_test_abort check(seq is null)");
    txn->commit();
  }
  const auto before = databaseRows(world);
  bool failed = false;
  try { journal::engine::PgJournalBackfill(pgTestPool()).run(input["M"].asUInt64(), false, world.account("A").str(), "retire-existing", input["legacy"]); }
  catch (const pqxx::check_violation&) { failed = true; }
  const auto after = databaseRows(world);
  {
    auto txn = world.store().begin(TxnMode::write);
    sqlOf(*txn).exec("alter table journal_sync_state drop constraint journal_adoption_test_abort");
    txn->commit();
  }
  CHECK(failed);
  CHECK_EQ(jcs(after), jcs(before));
}

TEST(journal_backfill_preserves_receipt_timestamp_precision_and_refuses_changed_M) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto input = migrationVectors()[0]["input"];
  test::PgWorld world(false, true);
  world.seed(input["state"]);
  seedLegacy(world, input);
  {
    auto txn = world.store().begin(TxnMode::write);
    sqlOf(*txn).exec("update journal_page set updated_at=updated_at+interval '0.000789 seconds'");
    sqlOf(*txn).exec("update journal_page_revision set superseded_at=superseded_at+interval '0.000456 seconds'");
    txn->commit();
  }
  journal::engine::PgJournalBackfill backfill(pgTestPool());
  const auto owner = world.account("A").str();
  backfill.run(input["M"].asUInt64(), false, owner);
  CHECK(backfill.audit(owner)[0]["audit"].asBool());
  const auto before = databaseRows(world);
  bool failed = false;
  try { backfill.run(input["M"].asUInt64() + 1, false, owner); }
  catch (const std::runtime_error& error) { failed = std::string(error.what()) == "journal adoption manifest differs"; }
  CHECK(failed);
  CHECK_EQ(jcs(databaseRows(world)), jcs(before));
  for (const std::string& query : {"update journal_sync_adoptions set migration_ms=migration_ms+1", "update journal_page_revision set migration_id=migration_id+1"}) {
    bool immutable = false;
    try {
      auto txn = world.store().begin(TxnMode::write);
      sqlOf(*txn).exec(query);
      txn->commit();
    } catch (const pqxx::sql_error& error) { immutable = std::string(error.what()).find("immutable") != std::string::npos; }
    CHECK(immutable);
    CHECK_EQ(jcs(databaseRows(world)), jcs(before));
  }
  auto backend = std::filesystem::path(__FILE__).parent_path();
  for (int level = 0; level < 6; ++level) backend = backend.parent_path();
  std::ifstream schema(backend / "db/journal_sync.sql");
  const std::string adoptionSql{std::istreambuf_iterator<char>(schema), std::istreambuf_iterator<char>()};
  REQUIRE(!adoptionSql.empty());
  {
    auto txn = world.store().begin(TxnMode::write);
    sqlOf(*txn).exec(adoptionSql);
    txn->commit();
  }
  CHECK_EQ(jcs(databaseRows(world)), jcs(before));
  CHECK(backfill.audit(owner)[0]["audit"].asBool());
}

TEST(journal_backfill_recorded_resume_and_corruption_gate_leave_every_table_unchanged) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto input = migrationVectors()[0]["input"];
  test::PgWorld world(false, true);
  world.seed(input["state"]);
  seedLegacy(world, input);
  journal::engine::PgJournalBackfill backfill(pgTestPool());
  const auto owner = world.account("A").str();
  backfill.run(input["M"].asUInt64(), false, owner);
  const auto adopted = databaseRows(world);
  std::vector<Json::Value> emitted;
  const auto resumed = backfill.run(input["M"].asUInt64() + 1, false, owner, "retire-existing", std::nullopt, true,
      [&](const Json::Value& report) { emitted.push_back(report); });
  CHECK_EQ(resumed.size(), std::size_t(1));
  CHECK_EQ(jcs(emitted[0]), jcs(resumed[0]));
  CHECK(!resumed[0]["changed"].asBool());
  CHECK_EQ(jcs(databaseRows(world)), jcs(adopted));
  const auto audit = backfill.audit(owner, true);
  CHECK(audit[0]["envelopeAudit"].asBool());
  CHECK(audit[0]["bootAudit"].asBool());
  CHECK(audit[0]["corruptionsRejected"].asUInt64() > 0);
  CHECK_EQ(jcs(databaseRows(world)), jcs(adopted));
  CHECK(backfill.auditCurrent(owner)[0]["bootAudit"].asBool());
}

TEST(journal_backfill_online_audit_keeps_its_snapshot_across_a_concurrent_save) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  BlockingThread::Mark blocking;
  const auto input = migrationVectors()[0]["input"];
  test::PgWorld world(false, true);
  world.seed(input["state"]);
  seedLegacy(world, input);
  const auto user = world.account("A");
  journal::engine::PgJournalBackfill backfill(pgTestPool());
  backfill.run(input["M"].asUInt64(), false, user.str());
  const auto before = backfill.auditCurrent(user.str());

  std::future<std::vector<Json::Value>> running;
  auto hold = world.store().begin(TxnMode::write);
  auto& sql = sqlOf(*hold);
  sql.exec("lock journal_sync_adoptions in access exclusive mode");
  running = std::async(std::launch::async, [&] { return backfill.auditCurrent(user.str()); });
  bool blocked = false;
  for (int attempt = 0; attempt < 200 && !blocked; ++attempt) {
    blocked = sql.exec("select exists(select 1 from pg_stat_activity where pg_backend_pid()=any(pg_blocking_pids(pid)))")[0][0].as<bool>();
    if (!blocked) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  REQUIRE(blocked);
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  const auto raw = parseJson(R"({"body":"Concurrent save","stamp":"9000000000000:0:writer:phone"})");
  const auto outcome = admission.admit(ServerOrigin{user, std::nullopt},
      journal::engine::savePageIntent(raw, user, LocalDate("2026-10-01")), input["M"].asUInt64() + 1);
  const auto* admitted = std::get_if<Admitted>(&outcome);
  REQUIRE(admitted != nullptr);
  REQUIRE_EQ(admitted->result["s"].asString(), "ok");
  REQUIRE(!admitted->result["write"].empty());
  hold->commit();
  hold.reset();
  const auto audited = running.get();
  REQUIRE_EQ(audited.size(), 1u);
  CHECK(audited[0]["audit"].asBool());
  CHECK(audited[0]["bootAudit"].asBool());
  CHECK_EQ(jcs(audited[0]), jcs(before[0]));
  const auto after = backfill.auditCurrent(user.str());
  CHECK(after[0]["seq"].asUInt64() > before[0]["seq"].asUInt64());
  CHECK(after[0]["digest"] != before[0]["digest"]);
}

TEST(journal_backfill_online_audit_rejects_a_corrupted_digest) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto input = migrationVectors()[0]["input"];
  test::PgWorld world(false, true);
  world.seed(input["state"]);
  seedLegacy(world, input);
  const auto owner = world.account("A").str();
  journal::engine::PgJournalBackfill backfill(pgTestPool());
  backfill.run(input["M"].asUInt64(), false, owner);
  REQUIRE(backfill.auditCurrent(owner)[0]["audit"].asBool());
  {
    auto txn = world.store().begin(TxnMode::write);
    sqlOf(*txn).exec("update sync_scopes set digest=decode(repeat('00',32),'hex') where key=$1",
        pqxx::params{ScopeKey::product(UserId(owner), "journal").text()});
    txn->commit();
  }
  bool refused = false;
  try { backfill.auditCurrent(owner); }
  catch (const std::runtime_error& error) { refused = std::string(error.what()) == "journal adoption audit: current feed digest or greatest seq"; }
  CHECK(refused);
}
