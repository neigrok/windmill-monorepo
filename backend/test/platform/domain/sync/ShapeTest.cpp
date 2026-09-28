#include "platform/domain/sync/Shape.h"

#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Wire.h"
#include "products/probe/ProbeRegistry.h"
#include "test/testing.h"

#include <string>

// What the golden corpus does not pin about §6.1 step 2's shape: a number of an integer domain past the safe
// integers (§9.1), which only a server origin can write in the probe.

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

}

TEST(shape_admits_an_integer_domain_up_to_the_largest_safe_integer_and_refuses_one_past_it_invalid) {
  CHECK_EQ(shapeOfEndedAt("9007199254740991"), std::string("shaped"));
  CHECK_EQ(shapeOfEndedAt("9007199254740992"), std::string("invalid"));
  CHECK_EQ(shapeOfEndedAt("18446744073709551615"), std::string("invalid"));
  CHECK_EQ(shapeOfEndedAt("1e300"), std::string("invalid"));
  CHECK_EQ(shapeOfEndedAt("2.5"), std::string("invalid"));
}
