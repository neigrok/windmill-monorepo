#include "products/gym/sync/adapters/postgres/PgGymBackfill.h"

#include "test/SyncCorpus.h"
#include "test/platform/adapters/postgres/PgSyncWorld.h"

#include <map>
#include <set>
#include <string>

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
  world.seed(input["state"]);
  seedLegacy(world, input);
  gym::engine::PgGymBackfill backfill(pgTestPool());
  const auto owner = world.account(input["account"].asString()).str();
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

