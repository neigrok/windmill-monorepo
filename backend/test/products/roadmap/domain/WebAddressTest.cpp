#include "platform/infra/AppOrigin.h"
#include "products/roadmap/domain/WebAddress.h"
#include "test/testing.h"

#include <json/json.h>

#include <cstdlib>
#include <fstream>
#include <string>

using namespace wm;

namespace {

// packages/api-contract/roadmap-addresses.json: the web proves its router opens every case, and this builds each one.
Json::Value addressVector() {
  std::ifstream stream(WM_ROADMAP_ADDRESSES, std::ios::binary);
  Json::Value document;
  stream >> document;
  return document;
}

}  // namespace

TEST(every_address_the_shared_vector_holds_is_built_after_the_origin) {
  const Json::Value cases = addressVector()["cases"];
  REQUIRE_EQ(cases.size(), 24u);
  for (const Json::Value& one : cases) {
    const WebTree web{"https://app.example", TreeId{one["treeId"].asString()},
                      one["yours"].asBool() ? Opener::owner : Opener::reader};
    const std::string built =
        one.isMember("nodeId") ? stepAddress(web, NodeId{one["nodeId"].asString()}) : treeAddress(web);
    CHECK_EQ(built, "https://app.example" + one["address"].asString());
  }
}

// With WINDMILL_APP_URL unset, a server hands out addresses on the origin the shared vector names for a local stack,
// the one the web's dev server is pinned to (the web's addresses test holds vite's port to it), so a tree's `url`, a
// magic link and a reminder link open the local app. Set, the origin is that value without the '/' it ends with.
TEST(the_app_origin_is_the_configured_one_or_the_local_one_the_shared_vector_names) {
  const char* held = std::getenv("WINDMILL_APP_URL");
  const std::string configured = held ? held : "";
  unsetenv("WINDMILL_APP_URL");
  CHECK_EQ(appOriginFromEnvironment(), addressVector()["localOrigin"].asString());
  CHECK_EQ(appOriginFromEnvironment(), std::string("http://localhost:5173"));
  setenv("WINDMILL_APP_URL", "https://app.example//", 1);
  CHECK_EQ(appOriginFromEnvironment(), std::string("https://app.example"));
  if (held) setenv("WINDMILL_APP_URL", configured.c_str(), 1);
  else unsetenv("WINDMILL_APP_URL");
}

TEST(an_origin_configured_with_a_trailing_slash_does_not_double_it) {
  const TreeId tree{"t_9362d9bc883e0a1e"};
  CHECK_EQ(treeAddress(WebTree{"https://app.example/", tree, Opener::owner}),
           std::string("https://app.example/#/app/t_9362d9bc883e0a1e"));
  CHECK_EQ(stepAddress(WebTree{"https://app.example//", tree, Opener::reader}, NodeId{"two words"}),
           std::string("https://app.example/t/t_9362d9bc883e0a1e#?step=two%20words"));
}
