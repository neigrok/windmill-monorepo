#include "products/gym/sync/GymRules.h"

#include "products/gym/sync/GymProduct.h"
#include "test/platform/application/sync/SyncWorld.h"
#include "test/platform/application/sync/SyncCorpusRunners.h"
#include "test/testing.h"
#include "test/SyncCorpus.h"

using namespace wm;
using namespace wm::sync;
using namespace wm::gym::engine;

TEST(gym_change_count_includes_rename_retarget_and_reorder) {
  const Json::Value base = parseJson(R"([{"exerciseId":"dip"},{"exerciseId":"back-squat"},{"exerciseId":"dip"}])");
  const Json::Value changes = parseJson(R"([{"kind":"kept","exerciseId":"back-squat"},{"kind":"retargeted","exerciseId":"dip"},{"kind":"kept","exerciseId":"dip"}])");
  CHECK_EQ(proposalChangeCount(base, changes, "Lower A", "Lower B"), 3);
  CHECK_EQ(proposalChangeCount(base, parseJson(R"([{"kind":"kept","exerciseId":"dip"},{"kind":"removed","exerciseId":"back-squat"}])"), "Lower A", "Lower A"), 1);
}

TEST(gym_import_receipts_compare_raw_arguments) {
  const auto vectors = corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/gym/admit.json");
  Json::Value input = vectors[0]["input"];
  input["intent"] = parseJson(R"({"scope":"self/gym","cmd":{"name":"gym.importSession","args":{"id":"session0099","startedAt":1760007200000,"finishedAt":1760010800000,"sets":[]}}})");
  wm::sync::test::FakeWorld world(true);
  const auto first = wm::sync::test::gymAdmitVector(world, input);
  CHECK_EQ(first["result"]["s"].asString(), std::string("ok"));
  input["state"] = first["state"];
  const auto replay = wm::sync::test::gymAdmitVector(world, input);
  CHECK_EQ(jcs(replay["state"]), jcs(first["state"]));
  input["intent"]["cmd"]["args"]["routineId"] = "routine0001";
  CHECK_EQ(wm::sync::test::gymAdmitVector(world, input)["result"]["code"].asString(), std::string("payload-conflict"));
}

TEST(gym_prefs_keep_unwritten_defaults_off_the_wire) {
  wm::sync::test::FakeWorld world(true);
  const Json::Value input = parseJson(R"({"state":{"epoch":"ep-1","clock":{"ms":0,"counter":0}},"origin":{"kind":"replica","account":"A","replica":"r_aaaaaaaaaaaa","n":1},"intent":{"scope":"self/gym","d":[{"t":"prefs","id":"prefs","f":{"units":["lb","1000:0:r_aaaaaaaaaaaa"]}}]},"serverNow":1000})");
  const auto after = wm::sync::test::gymAdmitVector(world, input);
  CHECK_EQ(after["result"]["s"].asString(), std::string("ok"));
  CHECK_EQ(jcs(after["state"]["rows"]["acct:A/gym"][0]["f"]), std::string(R"({"units":["lb","1000:0:r_aaaaaaaaaaaa"]})"));
}

TEST(gym_additive_correction_keeps_more_than_two_hundred_standing_sets) {
  Json::Value input;
  for (const auto& vector : corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/gym/admit.json")) {
    if (vector["name"] == "an additive correction keeps unnamed sets and creates the missing set with its kind") input = vector["input"];
  }
  REQUIRE(input.isObject());
  auto& rows = input["state"]["rows"]["acct:A/gym"];
  Json::Value source;
  for (const auto& row : rows) if (row["t"] == "set" && row["id"] == "set00000001") source = row;
  REQUIRE(source.isObject());
  for (int number = 3; number <= 201; ++number) {
    auto row = source;
    row["id"] = "standing_" + std::to_string(number);
    row["seq"] = number + 10;
    row["v"]["setNumber"] = number;
    rows.append(row);
  }
  std::vector<Json::Value> standing(rows.begin(), rows.end());
  input["state"]["scopes"]["acct:A/gym"]["seq"] = 211;
  input["state"]["scopes"]["acct:A/gym"]["digest"] = scopeDigest(standing).hex();
  input["intent"]["cmd"]["args"]["sets"][0]["setNumber"] = 202;
  wm::sync::test::FakeWorld world(true);
  const auto after = wm::sync::test::gymAdmitVector(world, input);
  REQUIRE_EQ(after["result"]["s"].asString(), std::string("ok"));
  std::map<std::string, Json::Value> actual;
  for (const auto& row : after["state"]["rows"]["acct:A/gym"]) if (row["t"] == "set") actual.emplace(row["id"].asString(), row);
  CHECK_EQ(actual.size(), 202U);
  for (const auto& row : standing) if (row["t"] == "set") CHECK_EQ(jcs(actual.at(row["id"].asString())), jcs(row));
  CHECK_EQ(actual.at("set00000009")["f"]["kind"][0].asString(), std::string("warmup"));
  CHECK_EQ(actual.at("set00000009")["v"]["setNumber"].asInt(), 202);
  input["state"] = after["state"];
  CHECK_EQ(jcs(wm::sync::test::gymAdmitVector(world, input)["state"]), jcs(after["state"]));
}
