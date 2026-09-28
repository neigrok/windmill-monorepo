#include "platform/domain/sync/Shape.h"

#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Wire.h"
#include "products/probe/ProbeRegistry.h"
#include "test/testing.h"

#include <string>

// What the golden corpus does not pin about §6.1 step 2's shape, both of a server origin's writes: a number of an
// integer domain past the safe integers (§9.1), and a whole put whose stamps are not all null or all one stamp.

using namespace wm;
using namespace wm::sync;

namespace {

// The code shapeIntent refuses a server origin's write of run.endedAt with, or "shaped".
std::string shapeOfEndedAt(const std::string& endedAt) {
  Json::Value intent = parseJson(R"({"scope": "self/probe", "d": [{"t": "run", "id": "run00001", "born": "2000:0:r_aaaaaaaaaaaa",
      "f": {"endedAt": [0, null]}}]})");
  intent["d"][0]["f"]["endedAt"][0] = parseJson(endedAt);
  try {
    shapeIntent(probe::registry(), intent, Sender{UserId{"A"}, true}, 1'000'000, 300'000);
  } catch (const Refusal& refusal) {
    return refusal.refused.code;
  }
  return "shaped";
}

// The code shapeIntent refuses a server origin's put of the wholePut type fact with, or "shaped".
std::string shapeOfServerFact(const std::string& lifeStamp, const std::string& valueStamp) {
  const Json::Value intent = parseJson(R"({"scope": "self/probe", "d": [{"t": "fact", "id": "2027-01-15", "life": ["alive", )" + lifeStamp +
                                       R"(], "f": {"value": [80, )" + valueStamp + R"(], "at": [5000, )" + lifeStamp + "]}}]}");
  try {
    shapeIntent(probe::registry(), intent, Sender{UserId{"A"}, true}, 1'000'000, 300'000);
  } catch (const Refusal& refusal) {
    return refusal.refused.code;
  }
  return "shaped";
}

}

TEST(shape_admits_an_integer_domain_up_to_the_largest_safe_integer_and_refuses_one_past_it_invalid) {
  CHECK_EQ(shapeOfEndedAt("9007199254740991"), std::string("shaped"));
  CHECK_EQ(shapeOfEndedAt("9007199254740992"), std::string("invalid"));
  CHECK_EQ(shapeOfEndedAt("18446744073709551615"), std::string("invalid"));
  CHECK_EQ(shapeOfEndedAt("1e300"), std::string("invalid"));
  CHECK_EQ(shapeOfEndedAt("2.5"), std::string("invalid"));
}

TEST(shape_admits_a_server_origin_s_whole_put_only_at_one_stamp_or_all_null) {
  CHECK_EQ(shapeOfServerFact("null", "null"), std::string("shaped"));
  CHECK_EQ(shapeOfServerFact(R"("5000:0:srv")", R"("5000:0:srv")"), std::string("shaped"));
  CHECK_EQ(shapeOfServerFact("null", R"("5000:0:srv")"), std::string("invalid"));
  CHECK_EQ(shapeOfServerFact(R"("5000:0:srv")", "null"), std::string("invalid"));
}
