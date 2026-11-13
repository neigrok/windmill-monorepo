#include "products/roadmap/application/ActivityFeed.h"

#include "platform/adapters/json/JsonText.h"
#include "products/roadmap/adapters/json/CommandJson.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include <optional>
#include <tuple>

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
      op(1, CreateNode{nid("renderer"), "WebGL2 renderer", "zap", NodeColor::sky}, "u5", 1000),
      op(2, RenameNode{nid("renderer"), "Renderer"}, "dev", 2000),
      op(3, RepositionNode{}, "u5", 3000),  // a stored move — omitted from the feed
      op(4, AddEdge{nid("product"), nid("renderer")}, "u5", 4000),
      op(5, DeleteNode{nid("ghost")}, "genesis", 5000),               // gone from the tree → id stands in
      op(6, TransitiveReduction{}, "dev", 6000),
  };
}

}

TEST(activity_projects_ops_to_human_events_skipping_a_stored_move) {
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

TEST(activity_sums_a_batch_by_verb_under_its_first_members_subject) {
  std::vector<AppliedOp> ops = {
      op(7, Batch{{DeleteNode{nid("renderer")}, DeleteNode{nid("ghost")},
                   RemoveEdge{nid("product"), nid("renderer")}, RepositionNode{}}},
         "dev", 7000),
      op(8, Batch{{RemoveEdge{nid("product"), nid("renderer")}}}, "u5", 8000),
      op(9, Batch{{RepositionNode{}}}, "u5", 9000),  // stored moves only: no event
  };
  std::vector<ActivityEvent> events = activityFeed(currentTree(), ops, 100);

  REQUIRE_EQ(events.size(), 2u);
  CHECK_EQ(events[0].seq, 7u);
  CHECK_EQ(events[0].verb, std::string("removed"));
  CHECK_EQ(events[0].node, nid("renderer"));
  CHECK_EQ(events[0].label, std::string("WebGL2 renderer"));
  CHECK_EQ(events[0].kind, std::string("sky"));
  CHECK_EQ(events[0].summary, std::string("removed 2 nodes and unlinked 1 link"));
  CHECK_EQ(events[0].actor, std::string("You"));
  CHECK_EQ(events[0].at, 7000u);

  CHECK_EQ(events[1].verb, std::string("unlinked"));
  CHECK_EQ(events[1].summary, std::string("unlinked 1 link"));
  CHECK_EQ(events[1].node, nid("renderer"));
}

// A batch of kind commands, as update_kind lands one, says each member's own sentence, joined as a batch joins its
// parts, under the first member's verb; a batch of node commands beside it still counts by verb.
TEST(activity_tells_a_batch_of_kind_commands_in_each_members_own_sentence) {
  std::vector<AppliedOp> ops = {
      op(10, Batch{{RenameKind{KindId{"k"}, "Builder"}, DescribeKind{KindId{"k"}, std::string("Brief.")}}},
         "dev", 10000),
      op(11, Batch{{RenameKind{KindId{"k"}, "Maker"}, DescribeKind{KindId{"k"}, std::string("Another.")},
                    RecolorKind{KindId{"k"}, NodeColor::plum}}},
         "u5", 11000),
      op(12, Batch{{DescribeKind{KindId{"k"}, std::string("Third.")}, RecolorKind{KindId{"k"}, NodeColor::sky}}},
         "dev", 12000),
      op(13, Batch{{DeleteNode{nid("renderer")}, RemoveEdge{nid("product"), nid("renderer")}}}, "dev", 13000),
  };
  std::vector<std::string> rows;
  for (const ActivityEvent& event : activityFeed(currentTree(), ops, 100))
    rows.push_back(std::to_string(event.seq) + " " + std::to_string(event.at) + " " + event.actor + " | " + event.verb +
                   " | " + event.node.str() + " | " + event.label + " | " + event.kind + " | " + event.summary);

  CHECK_EQ(rows, (std::vector<std::string>{
                     "10 10000 You | renamed-kind |  | Builder |  | renamed a kind to Builder and described a kind",
                     "11 11000 Guest 5 | renamed-kind |  | Maker |  | renamed a kind to Maker and described a kind and "
                     "recolored a kind plum",
                     "12 12000 You | described-kind |  |  |  | described a kind and recolored a kind sky",
                     "13 13000 You | removed | renderer | WebGL2 renderer | sky | removed 1 node and unlinked 1 link",
                 }));
}

// No tool reorders a legend any more, but the log holds the rows that did and a client's frame can still land one:
// the feed still tells one, alone and as a part of a Batch.
TEST(activity_still_tells_a_past_reorder_of_the_legend) {
  std::vector<AppliedOp> ops = {
      op(20, ReorderKinds{{KindId{"learn"}, KindId{"build"}}}, "dev", 20000),
      op(21, Batch{{ReorderKinds{{KindId{"build"}, KindId{"learn"}}}, RenameKind{KindId{"build"}, "Make"}}}, "u5", 21000),
  };
  std::vector<std::string> rows;
  for (const ActivityEvent& event : activityFeed(currentTree(), ops, 100))
    rows.push_back(std::to_string(event.seq) + " " + event.actor + " | " + event.verb + " | " + event.summary);
  CHECK_EQ(rows, (std::vector<std::string>{"20 You | reordered-kinds | reordered the legend",
                                           "21 Guest 5 | reordered-kinds | reordered the legend and renamed a kind to Make"}));
}

// The log keeps rows no tool writes any more, and the feed reads them as it always did: a past tidy is told and a past
// prune is not. A kind row that set only the cross-branch flag decodes to a command that sets nothing, so the feed skips
// it, alone and inside a Batch whose other members it still tells.
TEST(activity_reads_past_tidy_prune_and_cross_branch_rows) {
  const std::tuple<const char*, const char*, const char*> stored[] = {
      {"TransitiveReduction", "{}", "dev"},
      {"PruneDangling", "{}", "dev"},
      {"DescribeKind", R"({"id":"build","crossBranchExempt":true})", "dev"},
      {"Batch", R"({"commands":[{"kind":"DescribeKind","payload":{"id":"build","crossBranchExempt":false}},
        {"kind":"RenameKind","payload":{"id":"build","label":"Make"}}]})", "u5"},
      {"DescribeKind", R"({"id":"build","description":"Things made","crossBranchExempt":true})", "dev"},
      {"AddKind", R"({"id":"drill","hue":"plum","crossBranchExempt":true})", "dev"},
  };
  std::vector<AppliedOp> ops;
  for (const auto& [kind, payload, actor] : stored) {
    const std::optional<Command> row = commandFromJson(kind, parse(payload));
    REQUIRE(row.has_value());
    const Seq seq = 30 + ops.size();
    ops.push_back(op(seq, *row, actor, seq * 1000));
  }
  std::vector<std::string> rows;
  for (const ActivityEvent& event : activityFeed(currentTree(), ops, 100))
    rows.push_back(std::to_string(event.seq) + " " + event.actor + " | " + event.verb + " | " + event.summary);
  CHECK_EQ(rows, (std::vector<std::string>{"30 You | tidied | tidied redundant links",
                                           "33 Guest 5 | renamed-kind | renamed a kind to Make",
                                           "34 You | described-kind | described a kind",
                                           "35 You | added-kind | added a plum kind"}));
}

// The log keeps rows that set a position, which nothing writes any more: a move alone is no deed of the feed's, a Batch
// that held one is told by its other members, and a create that carried a position reads as any create.
TEST(activity_reads_past_rows_that_set_a_position) {
  const std::tuple<const char*, const char*, const char*> stored[] = {
      {"CreateNode", R"({"id":"sail","label":"Sail","color":"sky","x":3,"y":4})", "dev"},
      {"RepositionNode", R"({"id":"sail","x":5,"y":6})", "dev"},
      {"Batch", R"({"commands":[{"kind":"RepositionNode","payload":{"id":"renderer","x":7,"y":8}},
        {"kind":"RenameNode","payload":{"id":"renderer","label":"Renderer"}}]})", "u5"},
  };
  std::vector<AppliedOp> ops;
  for (const auto& [kind, payload, actor] : stored) {
    const std::optional<Command> row = commandFromJson(kind, parse(payload));
    REQUIRE(row.has_value());
    const Seq seq = 40 + ops.size();
    ops.push_back(op(seq, *row, actor, seq * 1000));
  }
  std::vector<std::string> rows;
  for (const ActivityEvent& event : activityFeed(currentTree(), ops, 100))
    rows.push_back(std::to_string(event.seq) + " " + event.actor + " | " + event.verb + " | " + event.summary);
  CHECK_EQ(rows, (std::vector<std::string>{"40 You | added | added Sail",
                                           "42 Guest 5 | renamed | renamed 1 node"}));
}

// The feed goes to every reader of a tree, so it never says which tree a node opens.
TEST(activity_names_no_tree_a_node_opens) {
  CreateNode created{nid("renderer"), "WebGL2 renderer", "zap", NodeColor::sky};
  created.opens = TreeId{"t_private_sub"};
  AnnotateNode pointed{nid("product")};
  pointed.opens = TreeId{"t_private_sub"};
  std::vector<AppliedOp> ops = {
      op(1, created, "dev", 1000),
      op(2, pointed, "dev", 2000),
      op(3, Batch{{Command{pointed}, Command{created}}}, "dev", 3000),
  };

  std::vector<ActivityEvent> events = activityFeed(currentTree(), ops, 100);

  REQUIRE_EQ(events.size(), 2u);
  CHECK_EQ(events[0].seq, 1u);
  CHECK_EQ(events[0].verb, std::string("added"));
  CHECK_EQ(events[0].node, nid("renderer"));
  CHECK_EQ(events[0].label, std::string("WebGL2 renderer"));
  CHECK_EQ(events[0].kind, std::string("sky"));
  CHECK_EQ(events[0].summary, std::string("added WebGL2 renderer"));
  CHECK_EQ(events[0].actor, std::string("You"));
  CHECK_EQ(events[0].at, 1000u);
  CHECK_EQ(events[1].seq, 3u);
  CHECK_EQ(events[1].actor, std::string("You"));
  CHECK_EQ(events[1].at, 3000u);
  CHECK_EQ(events[1].verb, std::string("added"));
  CHECK_EQ(events[1].node, nid("renderer"));
  CHECK_EQ(events[1].label, std::string("WebGL2 renderer"));
  CHECK_EQ(events[1].kind, std::string("sky"));
  CHECK_EQ(events[1].summary, std::string("added 1 node"));
}
