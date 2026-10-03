#include "products/gym/sync/adapters/postgres/PgGymBackfill.h"
#include "platform/application/WorkerPool.h"

#include "test/SyncCorpus.h"
#include "test/platform/adapters/postgres/PgSyncWorld.h"

#include <chrono>
#include <future>
#include <map>
#include <set>
#include <string>
#include <thread>

using namespace wm;
using namespace wm::sync;

namespace {

void seedRow(pqxx::transaction_base& sql, const std::string& table,
             const std::map<std::string, Json::Value>& columns,
             const std::set<std::string>& instants = {}) {
  pqxx::params params;
  std::string names;
  std::string values;
  for (const auto& [name, value] : columns) {
    if (!names.empty()) { names += ","; values += ","; }
    names += sql.quote_name(name);
    const std::string slot = "$" + std::to_string(params.size() + 1);
    if (instants.contains(name)) values += "to_timestamp(" + slot + "::double precision/1000)";
    else if (name == "user_id" || name == "created_by") values += slot + "::uuid";
    else if (name == "date_local") values += slot + "::date";
    else if (value.isObject() || value.isArray()) values += slot + "::jsonb";
    else values += slot;
    if (value.isNull()) params.append();
    else if (value.isString()) params.append(value.asString());
    else if (value.isBool()) params.append(value.asBool());
    else if (value.isIntegral()) params.append(value.asInt64());
    else if (value.isDouble()) params.append(value.asDouble());
    else params.append(jcs(value));
  }
  const std::string conflict = table == "gym_notes" ? "(id) " : "";
  sql.exec("insert into " + sql.quote_name(table) + "(" + names + ") values(" + values + ") on conflict " + conflict + "do nothing", params);
}

void seedLegacy(test::PgWorld& world, const Json::Value& input) {
  const Json::Value& legacy = input["legacy"];
  const std::string owner = world.account(input["account"].asString()).str();
  auto txn = world.store().begin(TxnMode::write);
  auto& sql = sqlOf(*txn);
  for (const auto& row : legacy["exercises"]) {
    seedRow(sql, "gym_exercises", {{"id", row["id"]}, {"created_by", owner}, {"name", row["name"]},
        {"pattern", row["pattern"]}, {"equipment", row["equipment"]}, {"step_kg", row["stepKg"]},
        {"created_at", row["createdAt"]}}, {"created_at"});
  }
  for (const auto& row : legacy["exerciseNames"]) {
    seedRow(sql, "gym_exercise_names", {{"user_id", owner}, {"exercise_id", row["exerciseId"]},
        {"name", row["name"]}, {"updated_at", row["updatedAt"]}}, {"updated_at"});
  }
  for (const auto& row : legacy["aliases"]) {
    seedRow(sql, "gym_exercise_aliases", {{"user_id", owner}, {"exercise_id", row["exerciseId"]},
        {"name", row["name"]}, {"created_at", row["createdAt"]}}, {"created_at"});
  }
  for (const auto& row : legacy["routines"]) {
    seedRow(sql, "gym_routines", {{"id", row["id"]}, {"user_id", owner}, {"name", row["name"]},
        {"position", row["position"]}, {"revision", row["revision"]}, {"created_entries", row["entries"].size()},
        {"created_door", row["createdDoor"]}, {"created_at", row["createdAt"]}}, {"created_at"});
    for (const auto& entry : row["entries"]) {
      seedRow(sql, "gym_routine_entries", {{"routine_id", row["id"]}, {"position", entry["position"]},
          {"exercise_id", entry["exerciseId"]}, {"rest_seconds", entry["restSeconds"]}});
      for (const auto& set : entry["sets"]) {
        seedRow(sql, "gym_routine_entry_sets", {{"routine_id", row["id"]}, {"position", entry["position"]},
            {"set_index", set["setIndex"]}, {"reps", set["reps"]}, {"weight_kg", set["weightKg"]}});
      }
    }
  }
  for (const auto& id : legacy["routineCreations"]) {
    seedRow(sql, "gym_routine_creations", {{"routine_id", id}, {"user_id", owner}, {"routine", Json::Value(Json::objectValue)}});
  }
  for (const auto& row : legacy["sessions"]) {
    seedRow(sql, "gym_sessions", {{"id", row["id"]}, {"user_id", owner}, {"routine_id", row["routineId"]},
        {"history_routine_id", row["historyRoutineId"]}, {"plan", row["plan"]}, {"started_at", row["startedAt"]},
        {"finished_at", row["finishedAt"]}, {"closed_by", row["closedBy"]}, {"display_name", row["displayName"]}},
        {"started_at", "finished_at"});
  }
  for (const auto& row : legacy["sets"]) {
    seedRow(sql, "gym_sets", {{"id", row["id"]}, {"session_id", row["sessionId"]}, {"user_id", owner},
        {"exercise_id", row["exerciseId"]}, {"set_number", row["setNumber"]}, {"weight_kg", row["weightKg"]},
        {"reps", row["reps"]}, {"kind", row["kind"]}, {"rpe", row["rpe"]}, {"note", row["note"]},
        {"completed_at", row["completedAt"]}}, {"completed_at"});
  }
  for (const auto& row : legacy["setRevisions"]) {
    const auto& session = legacy["sessions"][0];
    seedRow(sql, "gym_set_revisions", {{"set_id", row["setId"]}, {"session_id", session["id"]},
        {"user_id", owner}, {"exercise_id", "back-squat"}, {"set_number", 2}, {"weight_kg", 80},
        {"reps", 5}, {"kind", "working"}, {"completed_at", session["startedAt"]},
        {"deleted", row["deleted"]}}, {"completed_at"});
  }
  for (const auto& row : legacy["writeReceipts"]) {
    seedRow(sql, "gym_write_receipts", {{"kind", row["kind"]}, {"id", row["id"]}, {"user_id", owner},
        {"session_id", row["sessionId"]}, {"request_hash", "corpus-legacy-request"}});
  }
  for (const auto& row : legacy["notes"]) {
    seedRow(sql, "gym_notes", {{"id", row["id"]}, {"user_id", owner}, {"position", row["position"]},
        {"title", row["title"]}, {"body", row["body"]}, {"created_at", row["createdAt"]},
        {"updated_at", row["updatedAt"]}}, {"created_at", "updated_at"});
  }
  for (const auto& id : legacy["noteSaves"]) {
    seedRow(sql, "gym_note_saves", {{"id", id}, {"user_id", owner}, {"note", Json::Value(Json::objectValue)}});
  }
  for (const auto& row : legacy["bodyweight"]) {
    seedRow(sql, "gym_bodyweight", {{"user_id", owner}, {"date_local", row["dateLocal"]},
        {"weight_kg", row["weightKg"]}, {"recorded_at", row["recordedAt"]},
        {"updated_at", row["updatedAt"]}}, {"updated_at"});
  }
  if (!legacy["preferences"].isNull()) {
    const auto& row = legacy["preferences"];
    seedRow(sql, "gym_preferences", {{"user_id", owner}, {"units", row["units"]},
        {"rest_seconds", row["restSeconds"]}, {"rest_sound", row["restSound"]},
        {"confirm_haptic", row["confirmHaptic"]}, {"confirm_sound", row["confirmSound"]},
        {"updated_at", row["updatedAt"]}}, {"updated_at"});
  }
  for (const auto& row : legacy["proposals"]) {
    if (!row["threadId"].isNull()) {
      seedRow(sql, "gym_ask_threads", {{"id", row["threadId"]}, {"user_id", owner}, {"title", "Legacy Coach"},
          {"created_at", row["createdAt"]}, {"asked_at", row["createdAt"]}}, {"created_at", "asked_at"});
    }
    seedRow(sql, "gym_proposals", {{"id", row["id"]}, {"user_id", owner}, {"routine_id", row["routineId"]},
        {"intent", row["intent"]}, {"base_revision", row["baseRevision"]}, {"base_name", row["baseName"]},
        {"proposed_name", row["proposedName"]}, {"summary", row["summary"]}, {"state", row["state"]},
        {"door", row["door"]}, {"connection", row["connection"]}, {"agent", row["agent"]},
        {"thread_id", row["threadId"]}, {"superseded_by", row["supersededBy"]},
        {"created_at", row["createdAt"]}, {"settled_at", row["settledAt"]}}, {"created_at", "settled_at"});
    for (const auto& change : row["changes"]) {
      seedRow(sql, "gym_proposal_changes", {{"proposal_id", row["id"]}, {"user_id", owner},
          {"position", change["position"]}, {"kind", change["kind"]}, {"exercise_id", change["exerciseId"]},
          {"before_sets", change["beforeSets"]}, {"after_sets", change["afterSets"]},
          {"before_rest_seconds", change["beforeRestSeconds"]}, {"after_rest_seconds", change["afterRestSeconds"]}});
    }
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
  static test::PgWorld world(true);
  const bool previouslyAdopted = input["state"]["scopes"].isMember("acct:" + input["account"].asString() + "/gym");
  Json::Value initial = input["state"];
  if (previouslyAdopted) {
    initial.removeMember("scopes");
    initial.removeMember("rows");
    initial.removeMember("spent");
    initial["product"] = Json::Value(Json::objectValue);
    initial["product"]["seeds"] = input["state"]["product"]["seeds"];
  }
  world.seed(initial);
  seedLegacy(world, input);
  gym::engine::PgGymBackfill backfill(pgTestPool());
  const auto owner = world.account(input["account"].asString()).str();
  if (previouslyAdopted) backfill.run(input["M"].asUInt64(), false, owner);
  const auto before = databaseRows(world);
  const auto dryReport = backfill.run(input["M"].asUInt64(), true, owner);
  CHECK_EQ(jcs(databaseRows(world)), jcs(before));
  const auto report = backfill.run(input["M"].asUInt64(), false, owner);
  CHECK_EQ(dryReport.size(), report.size());
  for (std::size_t i = 0; i < std::min(dryReport.size(), report.size()); ++i) {
    Json::Value projected = dryReport[i];
    Json::Value actual = report[i];
    projected.removeMember("dryRun");
    actual.removeMember("dryRun");
    CHECK_EQ(jcs(projected), jcs(actual));
  }
  const auto migrated = databaseRows(world);
  backfill.audit(owner);
  const auto second = backfill.run(input["M"].asUInt64() + 1000, false, owner);
  for (const auto& account : second) CHECK_EQ(account["changed"].asUInt64(), 0u);
  CHECK_EQ(jcs(databaseRows(world)), jcs(migrated));
  if (input["state"]["scopes"].isMember("acct:" + input["account"].asString() + "/gym")) {
    CHECK_EQ(jcs(migrated), jcs(before));
    for (const auto& account : report) CHECK_EQ(account["changed"].asUInt64(), 0u);
  }
  Json::Value answer(Json::objectValue);
  answer["state"] = world.dump();
  return answer;
}

[[maybe_unused]] const bool registered = [] {
  corpus::registerFiles(WM_SYNC_CONTRACT_DIR "/corpus", {{"gym/backfill.json", corpus::Runner{backfillVector}}},
      [] { return test::postgresEnabled() ? nullptr : test::kNeedsPostgres; });
  return true;
}();

}

TEST(gym_backfill_initializes_a_missing_epoch_once_without_an_account_scope) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto vectors = corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/gym/backfill.json");
  const auto& input = vectors[2]["input"];
  test::PgWorld world(true);
  world.seed(input["state"]);
  {
    auto txn = world.store().begin(TxnMode::write);
    sqlOf(*txn).exec("delete from sync_meta");
    txn->commit();
  }
  gym::engine::PgGymBackfill backfill(pgTestPool());
  const auto owner = world.account(input["account"].asString()).str();
  const auto before = databaseRows(world);
  CHECK(backfill.run(input["M"].asUInt64(), true, owner).empty());
  CHECK_EQ(jcs(databaseRows(world)), jcs(before));
  CHECK(backfill.run(input["M"].asUInt64(), false, owner).empty());
  const auto initialized = databaseRows(world);
  REQUIRE_EQ(initialized["sync_meta"].size(), 1u);
  CHECK_FALSE(initialized["sync_meta"][0]["row"]["epoch"].asString().empty());
  CHECK(initialized["sync_scopes"].empty());
  for (const auto& table : before.getMemberNames()) {
    if (table == "sync_meta") continue;
    CHECK_EQ(jcs(initialized[table]), jcs(before[table]));
  }
  CHECK(backfill.run(input["M"].asUInt64() + 1000, false, owner).empty());
  CHECK_EQ(jcs(databaseRows(world)), jcs(initialized));
}

TEST(gym_backfill_rolls_back_every_account_row_when_adoption_fails) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto vectors = corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/gym/backfill.json");
  const auto& input = vectors[0]["input"];
  test::PgWorld world(true);
  world.seed(input["state"]);
  seedLegacy(world, input);
  {
    auto txn = world.store().begin(TxnMode::write);
    sqlOf(*txn).exec("alter table gym_notes add constraint gym_backfill_test_abort check(seq is null)");
    txn->commit();
  }
  auto cleanup = [&] {
    auto txn = world.store().begin(TxnMode::write);
    sqlOf(*txn).exec("alter table gym_notes drop constraint if exists gym_backfill_test_abort");
    txn->commit();
  };
  gym::engine::PgGymBackfill backfill(pgTestPool());
  const auto owner = world.account(input["account"].asString()).str();
  bool refused = false;
  Json::Value before;
  Json::Value after;
  try {
    before = databaseRows(world);
    try {
      backfill.run(input["M"].asUInt64(), false, owner);
    } catch (const pqxx::check_violation&) {
      refused = true;
    }
    after = databaseRows(world);
  } catch (...) {
    cleanup();
    throw;
  }
  cleanup();
  CHECK(refused);
  CHECK_EQ(jcs(after), jcs(before));
}


TEST(gym_backfill_audit_rejects_legacy_accounts_without_a_scope) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto vectors = corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/gym/backfill.json");
  const auto& input = vectors[0]["input"];
  test::PgWorld world(true);
  world.seed(input["state"]);
  seedLegacy(world, input);
  gym::engine::PgGymBackfill backfill(pgTestPool());
  bool refused = false;
  try { backfill.audit(world.account(input["account"].asString()).str()); }
  catch (const std::runtime_error& error) { refused = std::string(error.what()).find("adoption") != std::string::npos; }
  CHECK(refused);
}

TEST(gym_backfill_repairs_an_empty_scope_created_before_adoption) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto vectors = corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/gym/backfill.json");
  const auto& input = vectors[0]["input"];
  test::PgWorld world(true);
  world.seed(input["state"]);
  seedLegacy(world, input);
  const auto owner = world.account(input["account"].asString());
  {
    auto txn = world.store().begin(TxnMode::write);
    REQUIRE(world.store().insertScope(*txn, ScopeKey::product(owner, "gym"), owner, std::nullopt));
    txn->commit();
  }
  gym::engine::PgGymBackfill backfill(pgTestPool());
  bool refused = false;
  try { backfill.audit(owner.str()); }
  catch (const std::runtime_error& error) { refused = std::string(error.what()).find("adoption") != std::string::npos; }
  CHECK(refused);
  const auto before = databaseRows(world);
  const auto preview = backfill.run(input["M"].asUInt64(), true, owner.str());
  CHECK_EQ(jcs(databaseRows(world)), jcs(before));
  REQUIRE_EQ(preview.size(), 1u);
  CHECK_EQ(preview[0]["changed"].asUInt64(), 18u);
  const auto actual = backfill.run(input["M"].asUInt64(), false, owner.str());
  REQUIRE_EQ(actual.size(), 1u);
  CHECK_FALSE(actual[0]["skipped"].asBool());
  CHECK_EQ(actual[0]["changed"].asUInt64(), 18u);
  const auto audited = backfill.audit(owner.str());
  REQUIRE_EQ(audited.size(), 1u);
  CHECK_EQ(audited[0]["rows"].asUInt64(), 13u);
  CHECK_EQ(audited[0]["spent"].asUInt64(), 5u);
  const auto repaired = databaseRows(world);
  CHECK_EQ(backfill.run(input["M"].asUInt64() + 1000, false, owner.str())[0]["changed"].asUInt64(), 0u);
  CHECK_EQ(jcs(databaseRows(world)), jcs(repaired));
}

TEST(gym_backfill_audit_rejects_partial_repairs_with_mixed_migration_stamps) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto vectors = corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/gym/backfill.json");
  const auto& input = vectors[0]["input"];
  test::PgWorld world(true);
  world.seed(input["state"]);
  seedLegacy(world, input);
  const auto owner = world.account(input["account"].asString()).str();
  gym::engine::PgGymBackfill backfill(pgTestPool());
  backfill.run(input["M"].asUInt64(), false, owner);
  const auto before = world.dump();
  {
    auto txn = world.store().begin(TxnMode::write);
    sqlOf(*txn).exec("update gym_notes set title_stamp=null where id='note0000001'");
    sqlOf(*txn).exec("update gym_sessions set rc=null where id='session0001'");
    sqlOf(*txn).exec("delete from sync_spent where type='set' and id='set00000002'");
    txn->commit();
  }
  bool refused = false;
  try { backfill.audit(owner); }
  catch (const std::runtime_error& error) { refused = std::string(error.what()).find("adoption") != std::string::npos; }
  CHECK(refused);
  const auto actual = backfill.run(input["M"].asUInt64() + 1000, false, owner);
  REQUIRE_EQ(actual.size(), 1u);
  CHECK_EQ(actual[0]["changed"].asUInt64(), 3u);
  CHECK_FALSE(actual[0]["skipped"].asBool());
  refused = false;
  try { backfill.audit(owner); }
  catch (const std::runtime_error& error) { refused = std::string(error.what()).find("frozen adoption") != std::string::npos; }
  CHECK(refused);
  const auto after = world.dump();
  for (const auto& prior : before["rows"]["acct:A/gym"]) {
    for (const auto& current : after["rows"]["acct:A/gym"]) {
      if (prior["t"] != current["t"] || prior["id"] != current["id"]) continue;
      if (prior["id"] != "note0000001" && prior["id"] != "session0001") {
        CHECK_EQ(jcs(prior), jcs(current));
        continue;
      }
      CHECK_EQ(prior["born"], current["born"]);
      CHECK_EQ(prior["life"], current["life"]);
      CHECK_EQ(prior["ru"], current["ru"]);
      for (const auto& name : prior["f"].getMemberNames()) {
        if (prior["id"] == "note0000001" && name == "title") {
          CHECK_EQ(current["f"][name][0], prior["f"][name][0]);
          CHECK_EQ(current["f"][name][1].asString(), std::to_string(input["M"].asUInt64() + 1000) + ":0:srv");
          continue;
        }
        CHECK_EQ(jcs(prior["f"][name]), jcs(current["f"][name]));
      }
    }
  }
  const auto repaired = databaseRows(world);
  CHECK_EQ(backfill.run(input["M"].asUInt64() + 2000, false, owner)[0]["changed"].asUInt64(), 0u);
  CHECK_EQ(jcs(databaseRows(world)), jcs(repaired));
}

TEST(gym_backfill_frozen_audit_rejects_corrupt_output_with_a_recomputed_digest) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto vectors = corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/gym/backfill.json");
  const auto& input = vectors[0]["input"];
  test::PgWorld world(true);
  gym::engine::PgGymBackfill backfill(pgTestPool());
  const auto owner = world.account(input["account"].asString()).str();
  const ScopeKey scopeKey = ScopeKey::product(UserId(owner), "gym");
  const std::string future = std::to_string(input["M"].asUInt64() + 1000000) + ":0:srv";
  const std::vector<std::string> corruptions{
    "update gym_routines set name_stamp='" + future + "'",
    "update gym_sessions set born='" + future + "'",
    "update gym_sets set life_stamp='" + future + "'",
    "update sync_spent set born='" + future + "' where scope_key='" + scopeKey.text() + "'",
    "update sync_spent set life_stamp='" + future + "' where scope_key='" + scopeKey.text() + "'",
    "update gym_notes set rc=rc+1",
    "update gym_bodyweight set ru=ru+1",
    "update gym_routines set revision=revision+1",
    "update gym_sets set set_number=set_number+1",
    "update gym_write_receipts set request_hash='corrupted'"
  };
  for (const auto& corruption : corruptions) {
    world.seed(input["state"]);
    seedLegacy(world, input);
    backfill.run(input["M"].asUInt64(), false, owner);
    REQUIRE(backfill.audit(owner)[0]["envelopeAudit"].asBool());
    {
      auto txn = world.store().begin(TxnMode::write);
      sqlOf(*txn).exec(corruption);
      ScopeRow scope = *world.store().scope(*txn, scopeKey, RowLock::noKeyUpdate);
      scope.digest = Digest256();
      for (const TypeDef& type : gym::engine::registry().types()) {
        gym::engine::PgGymType typeStore(type);
        for (const Row& row : typeStore.feed(*txn, scopeKey, FeedQuery{})) scope.digest = scope.digest + rowHash(row.toJson());
      }
      world.store().saveScope(*txn, scope);
      txn->commit();
    }
    bool refused = false;
    try { backfill.audit(owner); }
    catch (const std::runtime_error& error) { refused = std::string(error.what()).find("frozen adoption") != std::string::npos; }
    CHECK(refused);
  }
}

TEST(gym_backfill_frozen_audit_orders_aliases_at_full_timestamp_precision) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto vectors = corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/gym/backfill.json");
  const auto& input = vectors[0]["input"];
  test::PgWorld world(true);
  world.seed(input["state"]);
  seedLegacy(world, input);
  const auto owner = world.account(input["account"].asString()).str();
  {
    auto txn = world.store().begin(TxnMode::write);
    auto& sql = sqlOf(*txn);
    sql.exec("update gym_exercise_aliases set created_at=created_at+case name when 'Prowler' then interval '0.000100 seconds' else interval '0.000400 seconds' end where user_id=$1::uuid and exercise_id='sledpush01'", pqxx::params{owner});
    const auto times = sql.exec("select count(distinct created_at),count(distinct (extract(epoch from created_at)*1000)::bigint) from gym_exercise_aliases where user_id=$1::uuid and exercise_id='sledpush01'", pqxx::params{owner});
    CHECK_EQ(times[0][0].as<int>(), 2);
    CHECK_EQ(times[0][1].as<int>(), 1);
    txn->commit();
  }
  gym::engine::PgGymBackfill backfill(pgTestPool());
  backfill.run(input["M"].asUInt64(), false, owner);
  {
    auto txn = world.store().begin(TxnMode::snapshot);
    const auto rows = world.catalog().store("exercise").feed(*txn, ScopeKey::product(UserId(owner), "gym"), FeedQuery{});
    REQUIRE_EQ(rows.size(), 1U);
    CHECK_EQ(jcs(rows[0].lattice.f.at("aliases").value), R"(["Sled","Prowler"])");
  }
  CHECK(backfill.audit(owner)[0]["envelopeAudit"].asBool());
}

TEST(gym_backfill_frozen_audit_rejects_alias_positions_even_when_the_exposed_row_is_unchanged) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto vectors = corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/gym/backfill.json");
  const auto& input = vectors[0]["input"];
  test::PgWorld world(true);
  world.seed(input["state"]);
  seedLegacy(world, input);
  const auto owner = world.account(input["account"].asString()).str();
  gym::engine::PgGymBackfill backfill(pgTestPool());
  backfill.run(input["M"].asUInt64(), false, owner);
  REQUIRE(backfill.audit(owner)[0]["envelopeAudit"].asBool());
  const auto before = world.dump();
  {
    auto txn = world.store().begin(TxnMode::write);
    sqlOf(*txn).exec("update gym_exercise_aliases set sync_positions='[99]'::jsonb where user_id=$1::uuid and exercise_id='back-squat'", pqxx::params{owner});
    txn->commit();
  }
  CHECK_EQ(jcs(world.dump()), jcs(before));
  CHECK(backfill.auditCurrent(owner)[0]["audit"].asBool());
  bool refused = false;
  try { backfill.audit(owner); }
  catch (const std::runtime_error& error) { refused = std::string(error.what()).find("gym_exercise_aliases frozen values") != std::string::npos; }
  CHECK(refused);
}

TEST(gym_backfill_frozen_source_cannot_be_overwritten) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto vectors = corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/gym/backfill.json");
  const auto& input = vectors[0]["input"];
  test::PgWorld world(true);
  world.seed(input["state"]);
  seedLegacy(world, input);
  gym::engine::PgGymBackfill backfill(pgTestPool());
  const auto owner = world.account(input["account"].asString()).str();
  backfill.run(input["M"].asUInt64(), false, owner);
  bool refused = false;
  try {
    auto txn = world.store().begin(TxnMode::write);
    sqlOf(*txn).exec("update gym_sync_adoptions set migration_ms=migration_ms+1 where user_id=$1::uuid", pqxx::params{owner});
    txn->commit();
  } catch (const pqxx::sql_error&) { refused = true; }
  CHECK(refused);
  CHECK(backfill.audit(owner)[0]["envelopeAudit"].asBool());
  const auto before = databaseRows(world);
  REQUIRE(backfill.audit(owner, true)[0]["corruptionsRejected"].asUInt64() > 0);
  CHECK_EQ(jcs(databaseRows(world)), jcs(before));
}

TEST(gym_backfill_recreates_a_missing_scope_for_fully_enveloped_rows_without_restamping) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto vectors = corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/gym/backfill.json");
  const auto& input = vectors[3]["input"];
  test::PgWorld world(true);
  world.seed(input["state"]);
  seedLegacy(world, input);
  const auto owner = world.account(input["account"].asString()).str();
  gym::engine::PgGymBackfill backfill(pgTestPool());
  backfill.run(input["M"].asUInt64(), false, owner);
  const auto before = world.dump()["rows"];
  {
    auto txn = world.store().begin(TxnMode::write);
    sqlOf(*txn).exec("delete from sync_scopes");
    txn->commit();
  }
  const auto actual = backfill.run(input["M"].asUInt64() + 1000, false, owner);
  REQUIRE_EQ(actual.size(), 1u);
  CHECK_EQ(actual[0]["changed"].asUInt64(), 0u);
  CHECK_FALSE(actual[0]["skipped"].asBool());
  CHECK_EQ(jcs(world.dump()["rows"]), jcs(before));
  CHECK(backfill.audit(owner)[0]["audit"].asBool());
}

TEST(gym_backfill_online_audit_keeps_its_snapshot_across_a_concurrent_set) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  BlockingThread::Mark blocking;
  const auto vectors = corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/gym/backfill.json");
  const auto& input = vectors[0]["input"];
  test::PgWorld world(true);
  world.seed(input["state"]);
  seedLegacy(world, input);
  const auto user = world.account("A");
  gym::engine::PgGymBackfill backfill(pgTestPool());
  backfill.run(input["M"].asUInt64(), false, user.str());
  const auto before = backfill.auditCurrent(user.str());

  std::future<std::vector<Json::Value>> running;
  auto hold = world.store().begin(TxnMode::write);
  auto& sql = sqlOf(*hold);
  sql.exec("lock gym_sync_adoptions in access exclusive mode");
  running = std::async(std::launch::async, [&] { return backfill.auditCurrent(user.str()); });
  bool blocked = false;
  for (int attempt = 0; attempt < 200 && !blocked; ++attempt) {
    blocked = sql.exec("select exists(select 1 from pg_stat_activity where pg_backend_pid()=any(pg_blocking_pids(pid)))")[0][0].as<bool>();
    if (!blocked) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  REQUIRE(blocked);
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  auto intent = parseJson(R"({"scope":"self/gym","d":[{"t":"set","id":"set00000001","f":{"reps":[7,null]}}]})");
  intent["d"][0]["born"] = std::to_string(input["M"].asUInt64()) + ":0:srv";
  const auto outcome = admission.admit(ServerOrigin{user, std::nullopt}, intent, input["M"].asUInt64() + 1);
  const auto* admitted = std::get_if<Admitted>(&outcome);
  REQUIRE(admitted != nullptr);
  REQUIRE_EQ(admitted->result["s"].asString(), "ok");
  REQUIRE(admitted->result["seq"].asUInt64() > before[0]["seq"].asUInt64());
  REQUIRE_EQ(sql.exec("select reps from gym_sets where user_id=$1::uuid and id='set00000001'", pqxx::params{user.str()})[0][0].as<int>(), 7);
  hold->commit();
  hold.reset();
  const auto audited = running.get();
  REQUIRE_EQ(audited.size(), 1u);
  CHECK(audited[0]["audit"].asBool());
  CHECK_EQ(jcs(audited[0]), jcs(before[0]));
  const auto after = backfill.auditCurrent(user.str());
  CHECK(after[0]["seq"].asUInt64() > before[0]["seq"].asUInt64());
  CHECK(after[0]["digest"] != before[0]["digest"]);
}

TEST(gym_backfill_online_audit_rejects_a_corrupted_digest) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto vectors = corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/gym/backfill.json");
  const auto& input = vectors[0]["input"];
  test::PgWorld world(true);
  world.seed(input["state"]);
  seedLegacy(world, input);
  const auto owner = world.account("A").str();
  gym::engine::PgGymBackfill backfill(pgTestPool());
  backfill.run(input["M"].asUInt64(), false, owner);
  REQUIRE(backfill.auditCurrent(owner)[0]["audit"].asBool());
  {
    auto txn = world.store().begin(TxnMode::write);
    sqlOf(*txn).exec("update sync_scopes set digest=decode(repeat('00',32),'hex') where key=$1",
        pqxx::params{ScopeKey::product(UserId(owner), "gym").text()});
    txn->commit();
  }
  bool refused = false;
  try { backfill.auditCurrent(owner); }
  catch (const std::runtime_error& error) { refused = std::string(error.what()).starts_with("C.8 digest/seq audit failed: "); }
  CHECK(refused);
}
