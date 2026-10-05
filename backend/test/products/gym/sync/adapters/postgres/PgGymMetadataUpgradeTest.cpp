#include "products/gym/sync/adapters/postgres/PgGymMetadataUpgrade.h"
#include "products/gym/sync/adapters/postgres/PgGymBackfill.h"
#include "products/gym/adapters/postgres/PgNotesRepository.h"
#include "products/gym/adapters/postgres/PgProgramRepository.h"
#include "products/gym/adapters/json/TrainingJson.h"
#include "platform/application/WorkerPool.h"
#include "test/platform/adapters/postgres/PgSyncWorld.h"

#include <future>
#include <limits>

using namespace wm;
using namespace wm::sync;

namespace {

const std::string key = "acct:A/gym";

Json::Value metadataVector(std::size_t index = 0) {
  return corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/gym/metadata.json")[static_cast<Json::ArrayIndex>(index)];
}

Json::Value databaseRows(test::PgWorld& world) {
  auto txn = world.store().begin(TxnMode::snapshot);
  auto& sql = sqlOf(*txn);
  Json::Value result(Json::objectValue);
  for (const auto& table : sql.exec("select tablename from pg_tables where schemaname=current_schema() order by tablename")) {
    const std::string name = table[0].as<std::string>();
    result[name] = parseJson(sql.exec("select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) order by to_jsonb(t)::text),'[]'::jsonb)::text from " + sql.quote_name(name) + " t")[0][0].as<std::string>());
  }
  return result;
}

void seedSource(test::PgWorld& world, const Json::Value& state, const Json::Value& source) {
  const auto owner = world.account("A").str();
  auto txn = world.store().begin(TxnMode::write);
  auto& sql = sqlOf(*txn);
  for (const auto& raw : source["routines"]) {
    const auto count = raw["createdEntries"].isNull() ? std::optional<int>() : std::optional(raw["createdEntries"].asInt());
    const auto revision = raw["revision"].isNull() ? std::optional<int>() : std::optional(raw["revision"].asInt());
    sql.exec("update gym_routines set revision=$3,created_entries=$4 where user_id=$1::uuid and id=$2", pqxx::params{owner, raw["id"].asString(), revision, count});
  }
  for (const auto& raw : source["proposals"])
    sql.exec("update gym_proposals set base_revision=$3,base_name=$4,changes=$5 where user_id=$1::uuid and id=$2", pqxx::params{owner, raw["id"].asString(), raw["baseRevision"].asInt(), raw["baseName"].asString(), raw["changeCount"].asInt()});
  for (const auto& raw : source["notes"])
    sql.exec("update gym_notes set updated_at=to_timestamp($3::numeric/1000) where user_id=$1::uuid and id=$2", pqxx::params{owner, raw["id"].asString(), raw["updatedAt"].asInt64()});
  // SQL rejects a missing required source or duplicate snapshot before the tool can freeze it.
  for (const auto& raw : state["rows"][key]) {
    if (raw["t"] != "note") continue;
    const bool found = std::any_of(source["notes"].begin(), source["notes"].end(), [&](const auto& note) { return note["id"] == raw["id"]; });
    if (!found) sql.exec("update gym_notes set updated_at=null where user_id=$1::uuid and id=$2", pqxx::params{owner, raw["id"].asString()});
  }
  sql.exec("delete from gym_routine_creations where user_id=$1::uuid", pqxx::params{owner});
  for (const auto& raw : source["routineCreations"])
    sql.exec("insert into gym_routine_creations(routine_id,user_id,routine) values($1,$2::uuid,$3::jsonb)", pqxx::params{raw["id"].asString(), owner, jcs(raw["snapshot"])});
  txn->commit();
}

void seedMetadata(test::PgWorld& world, const Json::Value& input) {
  world.seed(input["state"]);
  seedSource(world, input["state"], input["source"]);
}

Json::Value normalized(test::PgWorld& world, const Json::Value& state, const Json::Value& source, Ms at) {
  test::PgWorld v5(true);
  Json::Value result = v5.dump();
  if (!state["product"]["seeds"].isNull()) result["product"]["seeds"] = state["product"]["seeds"];
  if (result["product"]["seeds"].isNull()) result["product"].removeMember("seeds");
  auto txn = world.store().begin(TxnMode::snapshot);
  const auto marker = sqlOf(*txn).exec("select result is not null from gym_sync_metadata_upgrades where user_id=$1::uuid and version=5", pqxx::params{world.account("A").str()});
  if (!marker.empty() && marker[0][0].as<bool>()) {
    auto& publicMarker = result["product"]["gymMetadataUpgrades"][key];
    publicMarker["version"] = 5; publicMarker["M"] = Json::UInt64(at); publicMarker["source"] = source;
    publicMarker["before"]["scope"] = state["scopes"][key];
    publicMarker["before"]["rows"] = state["rows"][key].isNull() ? Json::Value(Json::arrayValue) : state["rows"][key];
    publicMarker["before"]["spent"] = state["spent"][key].isNull() ? Json::Value(Json::arrayValue) : state["spent"][key];
  }
  for (const char* part : {"accounts", "scopes", "rows", "spent", "revisions", "replicas", "results", "requests", "product"})
    if (result.isMember(part) && result[part].empty()) result.removeMember(part);
  return result;
}

Json::Value upgradeVector(const Json::Value& input) {
  static test::PgWorld world(true, false, true);
  gym::engine::PgGymMetadataUpgrade upgrade(pgTestPool());
  Json::Value initial = input["state"], source = input["source"];
  Ms at = input["M"].asUInt64();
  const auto& existing = input["state"]["product"]["gymMetadataUpgrades"][key];
  if (!existing.isNull()) {
    initial["scopes"][key] = existing["before"]["scope"];
    initial["rows"][key] = existing["before"]["rows"];
    initial["spent"][key] = existing["before"]["spent"];
    initial["product"].removeMember("gymMetadataUpgrades");
    source = existing["source"]; at = existing["M"].asUInt64();
  }
  world.seed(initial);
  auto before = databaseRows(world);
  bool refused = false;
  try {
    seedSource(world, initial, source);
    before = databaseRows(world);
    if (!existing.isNull()) {
      upgrade.run(at, world.account("A").str());
      before = databaseRows(world);
      if (jcs(input["source"]) != jcs(source)) {
        auto txn = world.store().begin(TxnMode::write);
        sqlOf(*txn).exec("update gym_sync_metadata_upgrades set frozen_source=frozen_source||'{\"changed_source\":true}'::jsonb where user_id=$1::uuid", pqxx::params{world.account("A").str()});
      }
    }
    upgrade.run(input["M"].asUInt64(), world.account("A").str());
  } catch (const std::exception&) { refused = true; }
  Json::Value answer(Json::objectValue);
  if (refused) {
    CHECK_EQ(jcs(databaseRows(world)), jcs(before));
    answer["error"] = true;
    return answer;
  }
  answer["state"] = normalized(world, initial, source, at);
  return answer;
}

[[maybe_unused]] const bool registered = [] {
  corpus::registerFiles(WM_SYNC_CONTRACT_DIR "/corpus", {{"gym/metadata.json", corpus::Runner{upgradeVector}}},
      [] { return test::postgresEnabled() ? nullptr : test::kNeedsPostgres; });
  return true;
}();

}

TEST(gym_metadata_upgrade_preserves_rest_reads_and_audits_every_new_register) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto input = metadataVector()["input"];
  test::PgWorld world(true, false, true);
  seedMetadata(world, input);
  const auto owner = world.account("A");
  gym::PgNotesRepository notes(pgTestPool());
  gym::PgProgramRepository programs(pgTestPool());
  auto restReads = [&] {
    Json::Value reads(Json::objectValue);
    reads["notes"] = gym::toJson(notes.notes(owner));
    reads["routines"] = Json::Value(Json::arrayValue);
    for (const auto& routine : programs.routines(owner)) reads["routines"].append(gym::toJson(routine));
    reads["proposal"] = gym::toJson(*programs.proposal(owner, gym::ProposalId("proposal001")));
    for (const char* id : {"routine0001", "routine0002"}) reads["creations"][id] = gym::toJson(*programs.routineCreation(owner, gym::RoutineId(id)));
    return jcs(reads);
  };
  const std::string before = restReads();
  gym::engine::PgGymMetadataUpgrade upgrade(pgTestPool());
  const auto report = upgrade.run(input["M"].asUInt64(), owner.str());
  REQUIRE_EQ(report.size(), 1u);
  CHECK_EQ(report[0]["changed"].asUInt64(), 6u);
  CHECK_EQ(report[0]["seq"].asUInt64(), 24u);
  CHECK_EQ(restReads(), before);
  const auto migrated = databaseRows(world);
  const auto audits = upgrade.audit(owner.str(), true);
  REQUIRE_EQ(audits.size(), 1u);
  CHECK_EQ(audits[0]["corruptionsRejected"].asUInt64(), 20u);
  CHECK_EQ(jcs(databaseRows(world)), jcs(migrated));
  REQUIRE(upgrade.run(std::nullopt, owner.str())[0]["skipped"].asBool());
  CHECK_EQ(jcs(databaseRows(world)), jcs(migrated));
  gym::engine::PgGymBackfill backfill(pgTestPool());
  CHECK(backfill.auditCurrent(owner.str())[0]["audit"].asBool());
}

TEST(gym_metadata_upgrade_rolls_back_an_interrupted_account_and_resumes_same_clock) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto input = metadataVector()["input"];
  test::PgWorld world(true, false, true);
  seedMetadata(world, input);
  const auto owner = world.account("A").str();
  gym::engine::PgGymMetadataUpgrade upgrade(pgTestPool());
  {
    auto txn = world.store().begin(TxnMode::write);
    sqlOf(*txn).exec("alter table gym_notes add constraint gym_metadata_test_abort check(updated_at_stamp is null)");
    txn->commit();
  }
  bool refused = false;
  try { upgrade.run(input["M"].asUInt64(), owner); }
  catch (const pqxx::check_violation&) { refused = true; }
  {
    auto txn = world.store().begin(TxnMode::write);
    auto& sql = sqlOf(*txn);
    sql.exec("alter table gym_notes drop constraint gym_metadata_test_abort");
    CHECK_EQ(sql.exec("select count(*) from gym_routines where revision_stamp is not null")[0][0].as<int>(), 0);
    CHECK_EQ(sql.exec("select count(*) from gym_sync_metadata_upgrades where result is null")[0][0].as<int>(), 1);
    CHECK_EQ(sql.exec("select seq from sync_scopes where key=$1", pqxx::params{ScopeKey::product(UserId(owner), "gym").text()})[0][0].as<int>(), 18);
    bool unavailable = false;
    try { gym::engine::PgGymMetadataUpgrade::requireComplete(*txn); }
    catch (const gym::engine::MetadataUpgradeError&) { unavailable = true; }
    CHECK(unavailable);
    txn->commit();
  }
  CHECK(refused);
  const auto resumed = upgrade.run(std::nullopt, owner);
  REQUIRE_EQ(resumed.size(), 1u);
  CHECK_EQ(resumed[0]["migrationMs"].asUInt64(), input["M"].asUInt64());
  CHECK(upgrade.audit(owner)[0]["audit"].asBool());
}

TEST(gym_metadata_upgrade_resumes_after_committed_output_and_refuses_incomplete_epoch_rotation) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto input = metadataVector()["input"];
  test::PgWorld world(true, false, true);
  seedMetadata(world, input);
  const auto other = world.account("B");
  {
    auto txn = world.store().begin(TxnMode::write);
    REQUIRE(world.store().insertScope(*txn, ScopeKey::product(other, "gym"), other, std::nullopt));
    txn->commit();
  }
  gym::engine::PgGymMetadataUpgrade upgrade(pgTestPool());
  bool exited = false;
  try { upgrade.run(input["M"].asUInt64(), std::nullopt, [](const auto&) { throw std::runtime_error("test output exit"); }); }
  catch (const std::runtime_error&) { exited = true; }
  CHECK(exited);
  {
    auto txn = world.store().begin(TxnMode::write);
    CHECK_EQ(sqlOf(*txn).exec("select count(*) from gym_sync_metadata_upgrades where result is not null")[0][0].as<int>(), 1);
    CHECK_EQ(sqlOf(*txn).exec("select count(*) from gym_sync_metadata_upgrades where result is null")[0][0].as<int>(), 1);
    sqlOf(*txn).exec("update sync_meta set epoch='rotated-incomplete'");
    txn->commit();
  }
  const auto rotated = databaseRows(world);
  bool refused = false;
  try { upgrade.run(); }
  catch (const gym::engine::MetadataUpgradeError& error) {
    refused = std::string(error.what()).ends_with("retained run epoch differs during incomplete upgrade");
  }
  CHECK(refused);
  refused = false;
  try { gym::engine::PgGymBackfill(pgTestPool()).auditCurrent(); }
  catch (const gym::engine::MetadataUpgradeError&) { refused = true; }
  CHECK(refused);
  CHECK_EQ(jcs(databaseRows(world)), jcs(rotated));
  {
    auto txn = world.store().begin(TxnMode::write);
    sqlOf(*txn).exec("update sync_meta set epoch=(select epoch from gym_sync_metadata_upgrade_runs where version=5)");
    txn->commit();
  }
  const auto resumed = upgrade.run();
  REQUIRE_EQ(resumed.size(), 2u);
  CHECK(resumed[0]["skipped"].asBool());
  CHECK_FALSE(resumed[1]["skipped"].asBool());
  CHECK_EQ(upgrade.audit().size(), 2u);
  const auto before = databaseRows(world);
  for (const auto& report : upgrade.run()) CHECK(report["skipped"].asBool());
  CHECK_EQ(jcs(databaseRows(world)), jcs(before));
}

TEST(gym_metadata_upgrade_rejects_unexpected_metadata_and_changed_explicit_clock) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto input = metadataVector()["input"];
  test::PgWorld world(true, false, true);
  seedMetadata(world, input);
  const auto owner = world.account("A").str();
  gym::engine::PgGymMetadataUpgrade upgrade(pgTestPool());
  {
    auto txn = world.store().begin(TxnMode::write);
    sqlOf(*txn).exec("update gym_routines set revision_stamp='1:0:srv'"); txn->commit();
  }
  const auto before = databaseRows(world);
  bool refused = false;
  try { upgrade.run(input["M"].asUInt64(), owner); }
  catch (const gym::engine::MetadataUpgradeError&) { refused = true; }
  CHECK(refused); CHECK_EQ(jcs(databaseRows(world)), jcs(before));
  seedMetadata(world, input);
  upgrade.run(input["M"].asUInt64(), owner);
  const auto complete = databaseRows(world);
  refused = false;
  try { upgrade.run(input["M"].asUInt64() + 1, owner); }
  catch (const gym::engine::MetadataUpgradeError&) { refused = true; }
  CHECK(refused); CHECK_EQ(jcs(databaseRows(world)), jcs(complete));
}

TEST(gym_metadata_upgrade_refuses_signed_database_sequence_exhaustion) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  auto input = metadataVector(4)["input"];
  input["state"]["scopes"][key]["seq"] = Json::UInt64(std::numeric_limits<std::int64_t>::max());
  input["state"]["spent"][key][0]["seq"] = Json::UInt64(std::numeric_limits<std::int64_t>::max());
  test::PgWorld world(true, false, true);
  seedMetadata(world, input);
  gym::engine::PgGymMetadataUpgrade upgrade(pgTestPool());
  bool refused = false;
  try { upgrade.run(input["M"].asUInt64(), world.account("A").str()); }
  catch (const gym::engine::MetadataUpgradeError& error) { refused = std::string(error.what()).ends_with("scope sequence exhausted"); }
  CHECK(refused);
  {
    auto txn = world.store().begin(TxnMode::snapshot);
    CHECK_EQ(sqlOf(*txn).exec("select count(*) from gym_routine_creations where seq is not null")[0][0].as<int>(), 0);
    CHECK_EQ(sqlOf(*txn).exec("select count(*) from gym_sync_metadata_upgrades where result is null")[0][0].as<int>(), 1);
  }
}

TEST(gym_metadata_upgrade_scope_lock_timeout_leaves_no_preparation_or_partial_account) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  BlockingThread::Mark blocking;
  const auto input = metadataVector()["input"];
  test::PgWorld world(true, false, true);
  seedMetadata(world, input);
  const auto owner = world.account("A").str();
  const auto before = databaseRows(world);
  auto hold = world.store().begin(TxnMode::write);
  REQUIRE(world.store().scope(*hold, ScopeKey::product(UserId(owner), "gym"), RowLock::noKeyUpdate).has_value());
  auto attempt = std::async(std::launch::async, [&] {
    gym::engine::PgGymMetadataUpgrade upgrade(pgTestPool());
    try { upgrade.run(input["M"].asUInt64(), owner); }
    catch (const pqxx::sql_error& error) { return error.sqlstate() == "55P03"; }
    return false;
  });
  CHECK(attempt.get());
  hold.reset();
  CHECK_EQ(jcs(databaseRows(world)), jcs(before));
  gym::engine::PgGymMetadataUpgrade upgrade(pgTestPool());
  CHECK(upgrade.run(input["M"].asUInt64(), owner)[0]["audit"].asBool());
}

TEST(gym_metadata_upgrade_readiness_rejects_partial_ddl_without_marker_tables) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  test::PgWorld world(true, false, true);
  seedMetadata(world, metadataVector()["input"]);
  const auto before = databaseRows(world);
  {
    auto txn = world.store().begin(TxnMode::write);
    auto& sql = sqlOf(*txn);
    sql.exec("drop table gym_sync_metadata_upgrades");
    sql.exec("drop table gym_sync_metadata_upgrade_runs");
    bool refused = false;
    try { gym::engine::PgGymMetadataUpgrade::requireComplete(*txn); }
    catch (const gym::engine::MetadataUpgradeError&) { refused = true; }
    CHECK(refused);
  }
  CHECK_EQ(jcs(databaseRows(world)), jcs(before));
  bool refused = false;
  try { gym::engine::PgGymBackfill(pgTestPool()).auditCurrent(); }
  catch (const gym::engine::MetadataUpgradeError&) { refused = true; }
  CHECK(refused);
}

TEST(gym_metadata_upgrade_rerun_and_audit_skip_accounts_whose_lifetime_ended) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto input = metadataVector(4)["input"];
  test::PgWorld world(true, false, true);
  seedMetadata(world, input);
  const auto owner = world.account("A").str();
  gym::engine::PgGymMetadataUpgrade upgrade(pgTestPool());
  REQUIRE_EQ(upgrade.run(input["M"].asUInt64(), owner).size(), 1u);
  {
    auto txn = world.store().begin(TxnMode::write);
    auto& sql = sqlOf(*txn);
    sql.exec("delete from sync_spent where scope_key='acct:'||$1||'/gym'", pqxx::params{owner});
    sql.exec("delete from sync_scopes where owner=$1::uuid", pqxx::params{owner});
    sql.exec("delete from sync_requests where account=$1::uuid", pqxx::params{owner});
    sql.exec("delete from sync_replicas where account=$1::uuid", pqxx::params{owner});
    sql.exec("delete from users where id=$1::uuid", pqxx::params{owner});
    gym::engine::PgGymMetadataUpgrade::requireComplete(*txn);
    txn->commit();
  }
  const auto purged = databaseRows(world);
  CHECK(purged["gym_sync_metadata_upgrades"].empty());
  CHECK(purged["gym_routine_creations"].empty());
  CHECK(upgrade.run().empty());
  CHECK(upgrade.audit().empty());
  CHECK_EQ(jcs(databaseRows(world)), jcs(purged));
}
