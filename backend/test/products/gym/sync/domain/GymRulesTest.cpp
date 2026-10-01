#include "products/gym/sync/domain/GymRules.h"

#include "products/gym/sync/GymRegistry.h"
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
