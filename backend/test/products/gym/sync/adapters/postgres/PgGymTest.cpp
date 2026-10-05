#include "products/gym/sync/adapters/postgres/PgGym.h"

#include "test/SyncCorpus.h"
#include "test/platform/adapters/postgres/PgSyncWorld.h"
#include "test/platform/application/sync/SyncCorpusRunners.h"

using namespace wm;
using namespace wm::sync;

namespace {

[[maybe_unused]] const bool registered = [] {
  Json::Value vectors = corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/gym/admit.json");
  for (const TypeDef& type : gym::engine::registry().types()) {
    const std::string name = type.name;
    ::testing::Register{"gym_store_round_trip/" + name, [name, vectors] {
      if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
      static test::PgWorld world(true);
      bool exercised = false;
      Json::Value samples = vectors;
      if (name == "prefs") {
        Json::Value sample = vectors[0];
        sample["input"]["state"]["rows"]["acct:A/gym"].append(parseJson(R"({"t":"prefs","id":"prefs","f":{"units":["lb","1760000000000:0:r_a"],"restSeconds":[null,"1760000000000:1:r_a"],"restSound":[false,"1760000000000:2:r_a"],"confirmHaptic":[true,"1760000000000:3:r_a"],"confirmSound":[true,"1760000000000:4:r_a"]},"seq":6,"rc":1760000000000,"ru":1760000000005})"));
        samples.append(sample);
      }
      for (const Json::Value& vector : samples) {
        Json::Value state = vector["input"]["state"];
        if (name == "routine") {
          for (auto& row : state["rows"]["acct:A/gym"]) {
            if (row["t"] != name) continue;
            row["f"]["entries"][0] = parseJson(R"([{"exerciseId":"dip"},{"exerciseId":"back-squat","sets":[{}, {"reps":5}, {"weightKg":0.01}]}])");
          }
        }
        if (name == "proposal") {
          for (auto& row : state["rows"]["acct:A/gym"]) {
            if (row["t"] != name) continue;
            row["f"]["changes"][0] = parseJson(R"([{"kind":"kept","exerciseId":"dip","before":{},"after":{"sets":[{}]}},{"kind":"removed","exerciseId":"back-squat","before":{"restSeconds":180}}])");
          }
        }
        if (name == "exercise") {
          for (auto& row : state["rows"]["acct:A/gym"]) if (row["t"] == name) row["f"]["aliases"] = parseJson(R"([["Old A","Old B","Old A"],"1760000000000:1:srv"])");
        }
        bool present = false;
        for (const auto& key : state["rows"].getMemberNames()) for (const auto& row : state["rows"][key]) if (row["t"] == name) present = true;
        if (!present) continue;
        world.seed(state);
        auto txn = world.store().begin(TxnMode::write);
        TypeStore& store = world.catalog().store(name);
        for (const auto& key : state["rows"].getMemberNames()) {
          const ScopeKey scope = world.storeKey(key);
          std::map<std::string, Row> expected;
          for (const auto& wire : state["rows"][key]) {
            if (wire["t"] != name) continue;
            Row row(wire);
            expected.emplace(row.id.key(), row);
            store.apply(*txn, scope, {RowWrite{world.catalog().registry().type(name), row.id, row, row, {}}});
            const auto locked = store.lock(*txn, scope, {row.id});
            CHECK_EQ(jcs(locked.at(row.id.key()).toJson()), jcs(row.toJson()));
          }
          CHECK_EQ(store.count(*txn, scope, FeedQuery{}), expected.size());
          for (const Row& fed : store.feed(*txn, scope, FeedQuery{})) {
            CHECK_EQ(rowHash(fed.toJson()).hex(), rowHash(expected.at(fed.id.key()).toJson()).hex());
            CHECK_EQ(jcs(fed.toJson()), jcs(expected.at(fed.id.key()).toJson()));
          }
        }
        exercised = true;
        break;
      }
      CHECK(exercised);
    }};
  }
  return true;
}();

}

TEST(gym_binding_foreign_keys_defer_to_commit_and_accept_a_set_before_its_session) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto vectors = corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/gym/admit.json");
  test::PgWorld world(true);
  world.seed(vectors[0]["input"]["state"]);
  {
    auto txn = world.store().begin(TxnMode::write);
    auto& sql = sqlOf(*txn);
    const auto constraints = sql.exec("select conname,condeferrable,condeferred,confdeltype::text from pg_constraint where connamespace=current_schema()::regnamespace and conname in "
                                      "('gym_sets_session_id_fkey','gym_sets_exercise_id_fkey','gym_routine_entries_exercise_id_fkey','gym_proposal_changes_exercise_id_fkey','gym_sessions_routine_id_fkey','gym_proposals_routine_id_fkey','gym_proposals_thread_id_fkey','gym_exercise_names_exercise_id_fkey','gym_exercise_aliases_exercise_id_fkey')");
    REQUIRE_EQ(constraints.size(), 9u);
    for (const auto& constraint : constraints) {
      CHECK(constraint["condeferrable"].as<bool>());
      CHECK(constraint["condeferred"].as<bool>());
      CHECK_EQ(constraint["confdeltype"].as<std::string>(), "a");
    }
    const auto owner = world.account("A").str();
    sql.exec("insert into gym_sets(id,session_id,user_id,exercise_id,set_number,weight_kg,reps,completed_at) values('setdefer001','sessiondf01',$1::uuid,'dip',1,0,5,to_timestamp(0))", pqxx::params{owner});
    CHECK_EQ(sql.exec("select count(*) from gym_sessions where id='sessiondf01'")[0][0].as<int>(), 0);
    sql.exec("insert into gym_sessions(id,user_id,started_at,finished_at) values('sessiondf01',$1::uuid,to_timestamp(0),to_timestamp(0))", pqxx::params{owner});
    txn->commit();
  }
  auto txn = world.store().begin(TxnMode::snapshot);
  const auto stored = sqlOf(*txn).exec("select s.id from gym_sets s join gym_sessions w on w.id=s.session_id where s.id='setdefer001' and w.id='sessiondf01'");
  REQUIRE_EQ(stored.size(), 1u);
  CHECK_EQ(stored[0][0].as<std::string>(), "setdefer001");
}

TEST(gym_set_deletion_keeps_the_prior_version_at_the_admission_time) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto vectors = corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/gym/admit.json");
  for (const auto& vector : vectors) {
    if (vector["name"] != "a set in a finished workout is deleted") continue;
    test::PgWorld world(true);
    const auto input = vector["input"];
    const auto after = test::gymAdmitVector(world, input);
    CHECK_EQ(jcs(after), jcs(vector["expect"]));
    auto txn = world.store().begin(TxnMode::snapshot);
    const auto rows = sqlOf(*txn).exec("select deleted,(extract(epoch from replaced_at)*1000)::bigint as replaced_at from gym_set_revisions where set_id=$1", pqxx::params{input["intent"]["d"][0]["id"].asString()});
    REQUIRE_EQ(rows.size(), 1u);
    CHECK(rows[0][0].as<bool>());
    CHECK_EQ(rows[0][1].as<Ms>(), input["serverNow"].asUInt64());
    return;
  }
  CHECK(false);
}

TEST(gym_routine_deletion_clears_a_session_created_by_the_same_intent) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto vectors = corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/gym/admit.json");
  for (const auto& vector : vectors) {
    if (vector["name"] != "a routine delete clears the same-intent start session routineId, retaining its frozen plan and history") continue;
    test::PgWorld world(true);
    const auto input = vector["input"];
    const auto after = test::gymAdmitVector(world, input);
    REQUIRE_EQ(jcs(after), jcs(vector["expect"]));
    REQUIRE_EQ(after["result"]["s"].asString(), "ok");
    auto txn = world.store().begin(TxnMode::snapshot);
    const auto routine = sqlOf(*txn).exec("select id from gym_routines where id='routine0001'");
    CHECK(routine.empty());
    const auto sessions = sqlOf(*txn).exec("select routine_id,history_routine_id,plan from gym_sessions where id=$1", pqxx::params{input["intent"]["cmd"]["args"]["id"].asString()});
    REQUIRE_EQ(sessions.size(), 1u);
    CHECK(sessions[0]["routine_id"].is_null());
    CHECK_EQ(sessions[0]["history_routine_id"].as<std::string>(), "routine0001");
    Json::Value plan;
    for (const auto& row : input["state"]["rows"]["acct:A/gym"]) {
      if (row["t"] == "routine" && row["id"] == "routine0001") plan = test::object({{"routine", row["f"]["name"][0]}, {"entries", row["f"]["entries"][0]}});
    }
    CHECK_EQ(jcs(parseJson(sessions[0]["plan"].as<std::string>())), jcs(plan));
    return;
  }
  CHECK(false);
}

TEST(gym_proposal_creates_supersede_once_in_the_same_intent_order) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const auto vectors = corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/gym/admit.json");
  for (const auto& vector : vectors) {
    if (vector["name"] != "two same-key proposal creates supersede in intent order: only the second stays pending") continue;
    test::PgWorld world(true);
    const auto input = vector["input"];
    const auto after = test::gymAdmitVector(world, input);
    REQUIRE_EQ(jcs(after), jcs(vector["expect"]));
    REQUIRE_EQ(after["result"]["s"].asString(), "ok");
    const std::string first = input["intent"]["d"][0]["id"].asString();
    const std::string second = input["intent"]["d"][1]["id"].asString();
    auto txn = world.store().begin(TxnMode::snapshot);
    const auto proposals = sqlOf(*txn).exec("select id,state,superseded_by,(extract(epoch from settled_at)*1000)::bigint as settled_at from gym_proposals where id in ($1,$2) order by id", pqxx::params{first, second});
    REQUIRE_EQ(proposals.size(), 2u);
    for (const auto& proposal : proposals) {
      if (proposal["id"].as<std::string>() == first) {
        CHECK_EQ(proposal["state"].as<std::string>(), "superseded");
        CHECK_EQ(proposal["superseded_by"].as<std::string>(), second);
        CHECK_EQ(proposal["settled_at"].as<Ms>(), input["serverNow"].asUInt64());
        continue;
      }
      CHECK_EQ(proposal["state"].as<std::string>(), "pending");
      CHECK(proposal["superseded_by"].is_null());
      CHECK(proposal["settled_at"].is_null());
    }
    return;
  }
  CHECK(false);
}
