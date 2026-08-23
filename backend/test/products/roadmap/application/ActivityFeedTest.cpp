#include "products/roadmap/application/ActivityFeed.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::fake;

namespace {

TreeData currentTree() {
  TreeData data;
  data.id = tid();
  data.title = "Roadmap";
  NodeSpec product;
  product.id = nid("product"); product.label = "Windmill"; product.icon = "sprout"; product.color = NodeColor::gold;
  NodeSpec renderer;
  renderer.id = nid("renderer"); renderer.label = "WebGL2 renderer"; renderer.icon = "zap";
  renderer.color = NodeColor::sky; renderer.prerequisites = {nid("product")};
  data.nodes = {product, renderer};
  return data;
}

AppliedOp op(Seq seq, Command command, const char* actor, std::uint64_t at) {
  AppliedOp applied;
  applied.seq = seq;
  applied.command = std::move(command);
  applied.actor = UserId{std::string(actor)};
  applied.createdAtMs = at;
  return applied;
}

std::vector<AppliedOp> log() {
  return {
      op(1, CreateNode{nid("renderer"), "WebGL2 renderer", "zap", NodeColor::sky, {}, std::nullopt}, "u5", 1000),
      op(2, RenameNode{nid("renderer"), "Renderer"}, "dev", 2000),
      op(3, RepositionNode{nid("renderer"), Vec2{9, 9}}, "u5", 3000),  // a nudge — omitted from the feed
      op(4, AddEdge{nid("product"), nid("renderer")}, "u5", 4000),
      op(5, DeleteNode{nid("ghost")}, "genesis", 5000),               // gone from the tree → id stands in
      op(6, TransitiveReduction{}, "dev", 6000),
  };
}

}

TEST(activity_projects_ops_to_human_events_skipping_nudges) {
  std::vector<ActivityEvent> events = activityFeed(currentTree(), log(), 100);

  REQUIRE_EQ(events.size(), 5u);  // the RepositionNode is dropped

  CHECK_EQ(events[0].seq, 1u);
  CHECK_EQ(events[0].verb, std::string("added"));
  CHECK_EQ(events[0].summary, std::string("added WebGL2 renderer"));
  CHECK_EQ(events[0].actor, std::string("Guest 5"));
  CHECK_EQ(events[0].kind, std::string("sky"));
  CHECK_EQ(events[0].at, 1000u);

  CHECK_EQ(events[1].verb, std::string("renamed"));
  CHECK_EQ(events[1].summary, std::string("renamed to Renderer"));
  CHECK_EQ(events[1].actor, std::string("You"));  // the fixed dev user

  CHECK_EQ(events[2].seq, 4u);
  CHECK_EQ(events[2].verb, std::string("linked"));
  CHECK_EQ(events[2].summary, std::string("linked Windmill → WebGL2 renderer"));
  CHECK_EQ(events[2].node, nid("renderer"));

  CHECK_EQ(events[3].verb, std::string("removed"));
  CHECK_EQ(events[3].summary, std::string("removed ghost"));  // gone → id stands in for the label
  CHECK_EQ(events[3].actor, std::string(""));                 // genesis → the tree itself

  CHECK_EQ(events[4].verb, std::string("tidied"));
  CHECK_EQ(events[4].summary, std::string("tidied redundant links"));
  CHECK(events[4].node.empty());
}

TEST(activity_keeps_the_most_recent_when_over_limit) {
  std::vector<ActivityEvent> events = activityFeed(currentTree(), log(), 2);
  REQUIRE_EQ(events.size(), 2u);
  CHECK_EQ(events[0].seq, 5u);  // removed
  CHECK_EQ(events[1].seq, 6u);  // tidied
}
