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
// the progress projection, the finish review and the statistics — and of a read that lists a movement's sets — last
// time, the last sets and the movement record — seeded into the engine's stores as the case gives its records, read
// through TrainingService at the case's moment, and compared by JCS. The phones and the web keep a review's and the
// statistics' estimates at full precision; the server's wire states them to a tenth (Estimate::stated), so those
// expectations are stated the same way before the bytes are compared. The progress projection and the movement record
// keep full precision on every side. The server numbers every set it holds; a set the case leaves unnumbered is
// compared without the number the server gave it. The GymEstimate cases run in the domain suite
// (domain/ProgressTest.cpp).
using namespace wm;
using namespace wm::gym;

namespace {
namespace fs = std::filesystem;

const fs::path kTrainingReads{WM_GYM_DOMAIN_DIR "/training-reads.json"};

Json::Value trainingReads() {
  std::ifstream stream(kTrainingReads, std::ios::binary);
  return sync::parseJson(std::string{std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()});
}

// The cases the server answers otherwise, each by the one field of the document it reads by another rule. That field
// must still differ and every other field must agree, so a case that comes to agree leaves this list.
struct OtherRule {
  std::string field;
  std::string rule;
};
const std::map<std::string, OtherRule> kOtherRules{
    {"last time preserves a corrected empty name and omits an unconfirmed set serial",
     {"routine", "the server's last time names no routine for an empty name"}},
    {"shared mirror 24 record [\"back-squat\"]", {"records", "the server's record steps leave out the first baseline"}},
    {"shared mirror 26 record [\"ex_fixture_custom\"]",
     {"records", "the server's record steps leave out the first baseline"}},
    {"record days list their sets in logged order, not the order the server numbered them",
     {"records", "the server's record steps leave out the first baseline"}},
};

// The cases whose records the server's store cannot hold, and so never runs.
const std::map<std::string, std::string> kUnheld{
    {"progress drops children whose session is not visible", "a set row requires its session row"},
};

const std::set<std::string> kListingMethods{"lastTime", "lastSets", "record"};

bool claimed(const Json::Value& vector) {
  if (kUnheld.contains(vector["name"].asString())) return false;
  const std::string read = vector["input"]["read"].asString();
  if (read == "StatsProgress") return true;
  if (read != "TrainingHistory") return false;
  const std::string method = vector["input"]["input"]["method"].asString();
  return method == "review" || method == "stats" || kListingMethods.contains(method);
}

bool estimatesStated(const Json::Value& vector) {
  const std::string read = vector["input"]["read"].asString();
  const std::string method = vector["input"]["input"]["method"].asString();
  return read == "TrainingHistory" && (method == "review" || method == "stats" || method == "record");
}

// The answer without the set number the server gave each set the case's records leave unnumbered.
Json::Value withoutServerNumbers(const Json::Value& document, const std::set<std::string>& unnumbered) {
  if (document.isArray()) {
    Json::Value out(Json::arrayValue);
    for (const Json::Value& item : document) out.append(withoutServerNumbers(item, unnumbered));
    return out;
  }
  if (!document.isObject()) return document;
  Json::Value out(Json::objectValue);
  for (const std::string& key : document.getMemberNames()) out[key] = withoutServerNumbers(document[key], unnumbered);
  if (document["id"].isString() && unnumbered.contains(document["id"].asString())) out.removeMember("setNumber");
  return out;
}

std::set<std::string> unnumberedSets(const Json::Value& drawn) {
  std::set<std::string> ids;
  for (const Json::Value& record : drawn)
    if (record["t"] == "set" && !record["v"].isMember("setNumber")) ids.insert(record["id"].asString());
  return ids;
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
  if (call["method"] == "lastSets") return toJson(h.training.lastSets(h.user));
  if (call["method"] == "lastTime") {
    const ExerciseId exercise{call["args"][0].asString()};
    return toJson(exercise, h.training.lastTime(h.user, exercise).lastTime);
  }
  if (call["method"] == "record") {
    const std::optional<MovementRecord> record = h.training.movementRecord(h.user, ExerciseId{call["args"][0].asString()});
    return record ? toJson(*record) : Json::Value(Json::nullValue);
  }
  const std::optional<Review> review = h.training.review(h.user, SessionId{call["args"][0].asString()});
  return review ? toJson(*review) : Json::Value(Json::nullValue);
}

void runCase(Json::ArrayIndex index) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  const Json::Value vector = trainingReads()[index];
  const Json::Value& result = vector["expect"]["result"];
  Json::Value answered = withoutServerNumbers(answer(vector), unnumberedSets(vector["input"]["records"]["drawn"]));
  Json::Value expected = estimatesStated(vector) ? stated(result) : result;
  if (const auto other = kOtherRules.find(vector["name"].asString()); other != kOtherRules.end()) {
    const std::string& field = other->second.field;
    CHECK(sync::jcs(answered[field]) != sync::jcs(expected[field]));
    answered.removeMember(field);
    expected.removeMember(field);
  }
  if (sync::jcs(answered) != sync::jcs(expected))
    ::testing::fail(("answer " + sync::jcs(answered) + "\n       expect " + sync::jcs(expected)).c_str(), __FILE__,
                    __LINE__);
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
