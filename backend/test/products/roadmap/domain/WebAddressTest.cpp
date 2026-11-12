#include "products/roadmap/domain/WebAddress.h"
#include "test/testing.h"

#include <json/json.h>

#include <fstream>
#include <string>

using namespace wm;

namespace {

// packages/api-contract/roadmap-addresses.json: the web proves its router opens every case, and this builds each one.
Json::Value addressCases() {
  std::ifstream stream(WM_ROADMAP_ADDRESSES, std::ios::binary);
  Json::Value document;
  stream >> document;
  return document["cases"];
}

}  // namespace

TEST(every_address_the_shared_vector_holds_is_built_after_the_origin) {
  const Json::Value cases = addressCases();
  REQUIRE_EQ(cases.size(), 24u);
  for (const Json::Value& one : cases) {
    const WebTree web{"https://app.example", TreeId{one["treeId"].asString()},
                      one["yours"].asBool() ? Opener::owner : Opener::reader};
    const std::string built =
        one.isMember("nodeId") ? stepAddress(web, NodeId{one["nodeId"].asString()}) : treeAddress(web);
    CHECK_EQ(built, "https://app.example" + one["address"].asString());
  }
}

TEST(an_origin_configured_with_a_trailing_slash_does_not_double_it) {
  const TreeId tree{"t_9362d9bc883e0a1e"};
  CHECK_EQ(treeAddress(WebTree{"https://app.example/", tree, Opener::owner}),
           std::string("https://app.example/#/app/t_9362d9bc883e0a1e"));
  CHECK_EQ(stepAddress(WebTree{"https://app.example//", tree, Opener::reader}, NodeId{"two words"}),
           std::string("https://app.example/t/t_9362d9bc883e0a1e#?step=two%20words"));
}
