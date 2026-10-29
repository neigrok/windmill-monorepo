#include "test/products/gym/sync/GymDoorFixture.h"
#include "test/testing.h"

#include "platform/domain/sync/Jcs.h"
#include "products/gym/adapters/json/GymJson.h"

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <set>
#include <string>

// packages/api-contract/gym/domain/training-reads.json over the server: every case of a read that makes an estimate —
// the progress projection, the finish review and the statistics — seeded into the engine's stores as the case gives
// its records, read through TrainingService at the case's moment, and compared by JCS. The phones and the web keep a
// review's and the statistics' estimates at full precision; the server's wire states them to a tenth
// (Estimate::stated), so those expectations are stated the same way before the bytes are compared. The progress
// projection keeps full precision on every side. The GymEstimate cases run in the domain suite (domain/ProgressTest.cpp).
using namespace wm;
using namespace wm::gym;

namespace {
namespace fs = std::filesystem;

const fs::path kTrainingReads{WM_GYM_DOMAIN_DIR "/training-reads.json"};

Json::Value trainingReads() {
  std::ifstream stream(kTrainingReads, std::ios::binary);
  return sync::parseJson(std::string{std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()});
}

// The cases the server answers otherwise, each for a rule outside the one e1RM rule. Each is run and must still
// differ, so a case that comes to agree leaves this list.
const std::set<std::string> kOtherRules{};

// The cases whose records the server's store cannot hold, and so never runs.
const std::map<std::string, std::string> kUnheld{
    {"progress drops children whose session is not visible", "a set row requires its session row"},
};

bool claimed(const Json::Value& vector) {
  if (kUnheld.contains(vector["name"].asString())) return false;
  const std::string read = vector["input"]["read"].asString();
  if (read == "StatsProgress") return true;
  if (read != "TrainingHistory") return false;
  const std::string method = vector["input"]["input"]["method"].asString();
  return method == "review" || method == "stats";
}

// An estimate as the wire states it: every `e1rm` and `topE1rm`, and the two numbers of an e1RM record.
Json::Value stated(const Json::Value& document) {
  if (document.isArray()) {
    Json::Value out(Json::arrayValue);
    for (const Json::Value& item : document) out.append(stated(item));
    return out;
  }
  if (!document.isObject()) return document;
  const bool estimate = document["kind"] == "e1rm";
  Json::Value out(Json::objectValue);
  for (const std::string& key : document.getMemberNames()) {
    const Json::Value& value = document[key];
    const bool states = key == "e1rm" || key == "topE1rm" || (estimate && (key == "value" || key == "previous"));
    out[key] = states && value.isNumeric() ? Json::Value(Estimate::stated(value.asDouble())) : stated(value);
  }
  return out;
}

// The case's records, and a blank routine standing in for each one a session names that the case does not draw: a
// replica may hold such a session, and the server's store holds no session without its routine. No read here takes
// anything from a routine row.
Json::Value seeded(const Json::Value& drawn) {
  std::set<std::string> routines;
  std::set<std::string> named;
  for (const Json::Value& record : drawn) {
    if (record["t"] == "routine") routines.insert(record["id"].asString());
    if (record["t"] == "session" && record["f"].isMember("routineId") && record["f"]["routineId"][0].isString())
      named.insert(record["f"]["routineId"][0].asString());
  }
  Json::Value records = drawn;
  for (const std::string& id : named) {
    if (routines.contains(id)) continue;
    records.append(sync::parseJson(R"({"t":"routine","id":")" + id + R"(","seq":1,"born":"1000:0:r_aaaaaaaaaaaa",)"
                                   R"("life":["alive","1000:0:r_aaaaaaaaaaaa"],"f":{"name":["","1000:0:r_aaaaaaaaaaaa"],)"
                                   R"("entries":[[],"1000:0:r_aaaaaaaaaaaa"],"position":[0,"1000:0:r_aaaaaaaaaaaa"],)"
                                   R"("revision":[1,"1000:0:r_aaaaaaaaaaaa"]}})"));
  }
  return records;
}

Json::Value answer(const Json::Value& vector) {
  doortest::Harness h;
  h.clock.now = vector["input"]["now"].asUInt64();
  doortest::seed(h.user, seeded(vector["input"]["records"]["drawn"]));
  if (vector["input"]["read"] == "StatsProgress") return toJson(h.training.progress(h.user));
  const Json::Value& call = vector["input"]["input"];
  if (call["method"] == "stats") return toJson(h.training.statistics(h.user));
  const std::optional<Review> review = h.training.review(h.user, SessionId{call["args"][0].asString()});
  return review ? toJson(*review) : Json::Value(Json::nullValue);
}

void runCase(Json::ArrayIndex index) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  const Json::Value vector = trainingReads()[index];
  const Json::Value& result = vector["expect"]["result"];
  const std::string answered = sync::jcs(answer(vector));
  const std::string expected = sync::jcs(vector["input"]["read"] == "StatsProgress" ? result : stated(result));
  if (kOtherRules.contains(vector["name"].asString())) {
    CHECK(answered != expected);
    return;
  }
  if (answered != expected)
    ::testing::fail(("answer " + answered + "\n       expect " + expected).c_str(), __FILE__, __LINE__);
}

[[maybe_unused]] const bool registered = [] {
  if (!fs::is_regular_file(kTrainingReads)) {
    ::testing::Register{"gym_training_reads_server", [] {
      ::testing::fail(("no training reads at " + kTrainingReads.string()).c_str(), __FILE__, __LINE__);
    }};
    return true;
  }
  const Json::Value vectors = trainingReads();
  for (Json::ArrayIndex i = 0; i < vectors.size(); ++i)
    if (claimed(vectors[i]))
      ::testing::Register{"gym_training_reads_server/" + vectors[i]["name"].asString(), [i] { runCase(i); }};
  return true;
}();
}
